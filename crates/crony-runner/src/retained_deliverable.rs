//! Source recovery evidence and admission around the existing native exporter.
//! This does not grant execution authority or reuse old evidence as a new check.

use std::collections::BTreeMap;

use super::*;
use crony_domain::{PreservedDeliverableCheckpoint, PreservedProviderArtifact};

pub(super) const RECOVERY: &str = "Keep the preserved worktree and retain write authority for its complete selected source delta. Resume with the full source scope or create an explicitly authorized full-scope mission; do not retry this correction in a fresh worktree.";

#[derive(Debug)]
enum CaptureStage {
    InitialWorkspace,
    SourceDelta,
    ArtifactExclusions,
    FinalWorkspace,
    FinalIndex,
}

impl CaptureStage {
    fn code(&self) -> &'static str {
        match self {
            Self::InitialWorkspace => "initial_workspace",
            Self::SourceDelta => "source_delta",
            Self::ArtifactExclusions => "artifact_exclusions",
            Self::FinalWorkspace => "final_workspace",
            Self::FinalIndex => "final_index",
        }
    }
}

impl std::fmt::Display for CaptureStage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for CaptureStage {}

// Export only fixed diagnostic codes. Git/filesystem error chains may contain
// untrusted file names or command output and must not enter the event journal.
fn failure_codes(error: &anyhow::Error) -> (&'static str, &'static str) {
    let stage = error
        .downcast_ref::<CaptureStage>()
        .map_or("capture", CaptureStage::code);
    let kind = if error.is::<workspace::CheckpointReadDeadline>() {
        "workspace_read_deadline"
    } else if error.is::<tokio::time::error::Elapsed>() {
        "operation_deadline"
    } else {
        "unavailable"
    };
    (stage, kind)
}

fn reference(artifact: &PreservedProviderArtifact) -> VerificationArtifactReference {
    VerificationArtifactReference {
        path: artifact.path.clone(),
        sha256: artifact.sha256.clone(),
        bytes: artifact.bytes as usize,
        media_type: artifact.media_type.clone(),
        data_base64: None,
    }
}

/// Recheck authenticated metadata against the exact contained bytes and native
/// index. A provider may have legitimately changed an old artifact during the
/// new run; such a path no longer qualifies for an export exclusion.
pub(super) async fn matching_artifacts(
    workspace: &WorkspaceLease,
    references: &[PreservedProviderArtifact],
) -> Result<Vec<AdapterArtifact>> {
    let root = tokio::fs::canonicalize(&workspace.path).await?;
    let mut matched = Vec::new();
    for metadata in references {
        let Ok((path, _)) =
            read_contained_verifier_artifact(workspace, &reference(metadata), false).await
        else {
            continue;
        };
        let relative = path
            .strip_prefix(&root)?
            .to_str()
            .context("artifact path is not UTF-8")?
            .replace('\\', "/");
        if relative != metadata.path {
            continue;
        }
        let artifact = AdapterArtifact {
            path,
            sha256: metadata.sha256.clone(),
            bytes: metadata.bytes as usize,
            media_type: metadata.media_type.clone(),
        };
        if deliverable::staged_artifact_matches(workspace, &relative, &artifact).await? {
            matched.push(artifact);
        }
    }
    Ok(matched)
}

pub(super) async fn historical_artifacts(
    assignment: &Assignment,
    workspace: &WorkspaceLease,
) -> Result<Vec<AdapterArtifact>> {
    let mut references = assignment
        .preserved_deliverable
        .as_ref()
        .map(|proof| proof.provider_artifacts.clone())
        .unwrap_or_default();
    references.extend(assignment.preserved_provider_artifacts.iter().cloned());
    matching_artifacts(workspace, &references).await
}

pub(super) async fn capture(
    assignment: &Assignment,
    workspace: &WorkspaceLease,
    workspaces: &WorkspaceManager,
    current_artifacts: &[AdapterArtifact],
) -> Result<PreservedDeliverableCheckpoint> {
    tokio::time::timeout(
        workspace::CHECKPOINT_CAPTURE_TIMEOUT,
        capture_source(assignment, workspace, workspaces, current_artifacts),
    )
    .await
    .context("complete deliverable checkpoint capture exceeded its deadline")?
}

async fn capture_source(
    assignment: &Assignment,
    workspace: &WorkspaceLease,
    workspaces: &WorkspaceManager,
    current_artifacts: &[AdapterArtifact],
) -> Result<PreservedDeliverableCheckpoint> {
    let (head_commit, workspace_fingerprint) = workspaces
        .checkpoint(workspace)
        .await
        .context(CaptureStage::InitialWorkspace)?;
    let delta = deliverable::capture_delta(assignment.run_id, workspace)
        .await
        .context(CaptureStage::SourceDelta)?;
    let root = tokio::fs::canonicalize(&workspace.path)
        .await
        .context(CaptureStage::ArtifactExclusions)?;
    let mut artifacts = assignment
        .preserved_deliverable
        .as_ref()
        .map(|proof| {
            proof
                .provider_artifacts
                .iter()
                .map(reference)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    artifacts.extend(
        assignment
            .preserved_provider_artifacts
            .iter()
            .map(reference),
    );
    artifacts.extend(assignment.provider_artifact.clone());
    artifacts.extend(
        current_artifacts
            .iter()
            .map(|artifact| VerificationArtifactReference {
                path: artifact.path.to_string_lossy().into_owned(),
                sha256: artifact.sha256.clone(),
                bytes: artifact.bytes,
                media_type: artifact.media_type.clone(),
                data_base64: None,
            }),
    );
    let mut exclusions = BTreeMap::new();
    for reference in artifacts {
        // A late, unreadable native transcript is retained but is not evidence
        // for excluding any source. Do not upload it or emit a run failure here.
        let Ok((path, _)) = read_contained_verifier_artifact(workspace, &reference, false).await
        else {
            continue;
        };
        let relative = path
            .strip_prefix(&root)
            .context(CaptureStage::ArtifactExclusions)?
            .to_str()
            .context(CaptureStage::ArtifactExclusions)?
            .replace('\\', "/");
        let artifact = AdapterArtifact {
            path,
            sha256: reference.sha256.clone(),
            bytes: reference.bytes,
            media_type: reference.media_type.clone(),
        };
        if deliverable::staged_artifact_matches(workspace, &relative, &artifact)
            .await
            .context(CaptureStage::ArtifactExclusions)?
        {
            exclusions.insert(
                relative.clone(),
                PreservedProviderArtifact {
                    path: relative,
                    sha256: reference.sha256,
                    bytes: reference.bytes as u64,
                    media_type: reference.media_type,
                },
            );
        }
    }
    let proof = PreservedDeliverableCheckpoint {
        schema_version: 1,
        run_id: assignment.run_id,
        workspace_run_id: assignment.workspace_run_id,
        workspace_base_commit: workspace.base_commit.clone(),
        head_commit,
        workspace_fingerprint,
        index_sha256: delta.index_sha256,
        deliverable: assignment.deliverable.clone(),
        changed_paths: delta.changed_paths,
        provider_artifacts: exclusions.into_values().collect(),
    };
    if !proof.is_valid()
        || workspaces
            .checkpoint(workspace)
            .await
            .context(CaptureStage::FinalWorkspace)?
            != (
                proof.head_commit.clone(),
                proof.workspace_fingerprint.clone(),
            )
        || deliverable::index_sha256(&workspace.path)
            .await
            .context(CaptureStage::FinalIndex)?
            != proof.index_sha256
    {
        return Err(anyhow!(
            "preserved deliverable changed during checkpoint capture"
        ));
    }
    Ok(proof)
}

pub(super) async fn verify_checkpoint(
    assignment: &Assignment,
    workspace: &WorkspaceLease,
) -> Result<()> {
    if let Some(proof) = &assignment.preserved_deliverable
        && (!proof.is_valid()
            || proof.workspace_run_id != assignment.workspace_run_id
            || proof.workspace_base_commit != workspace.base_commit
            || proof.deliverable != assignment.deliverable
            || assignment.expected_workspace_fingerprint.as_deref()
                != Some(proof.workspace_fingerprint.as_str())
            || assignment.expected_head_commit.as_deref() != Some(proof.head_commit.as_str())
            || deliverable::index_sha256(&workspace.path).await? != proof.index_sha256
            || matching_artifacts(workspace, &proof.provider_artifacts)
                .await?
                .len()
                != proof.provider_artifacts.len())
    {
        return Err(anyhow!(
            "preserved deliverable checkpoint or native index mismatch; source remains quarantined"
        ));
    }
    Ok(())
}

/// Use the current physical AND staged delta after authorized dependency
/// materialization. Missing legacy proof never invents artifact exclusions.
pub(super) async fn preflight(
    assignment: &Assignment,
    workspace: &WorkspaceLease,
    workspaces: &WorkspaceManager,
) -> Result<()> {
    tokio::time::timeout(
        workspace::CHECKPOINT_CAPTURE_TIMEOUT,
        preflight_source(assignment, workspace, workspaces),
    )
    .await
    .with_context(|| format!("preserved deliverable preflight exceeded its deadline. {RECOVERY}"))?
}

async fn preflight_source(
    assignment: &Assignment,
    workspace: &WorkspaceLease,
    workspaces: &WorkspaceManager,
) -> Result<()> {
    let Some(spec) = &assignment.deliverable else {
        return Ok(());
    };
    let proof = capture(assignment, workspace, workspaces, &[]).await?;
    if let Some(path) = proof.excluded_deliverable_path(&assignment.write_scope) {
        return Err(anyhow!(
            "write scope excludes preserved deliverable path {path}. {RECOVERY}"
        ));
    }
    let exclusions = matching_artifacts(workspace, &proof.provider_artifacts).await?;
    let candidate = deliverable::prepare_resume(
        assignment.run_id,
        spec,
        workspace,
        &exclusions,
        &assignment.write_scope,
    )
    .await
    .with_context(|| {
        format!("preserved source cannot be exported under the resumed contract. {RECOVERY}")
    })?;
    drop(candidate);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn report(
    outbound: &OutboundBus,
    runner_id: &str,
    assignment: &Assignment,
    workspace: &WorkspaceLease,
    workspaces: &WorkspaceManager,
    current_artifacts: &[AdapterArtifact],
    cleanup: &WorkspaceCleanup,
) {
    let proof = capture(assignment, workspace, workspaces, current_artifacts).await;
    let mut payload = json!({
        "workspace": workspace.path, "workspace_branch": workspace.branch,
        "workspace_base_ref": workspace.base_ref, "workspace_base_commit": workspace.base_commit,
        "detail": cleanup.detail, "dirty": cleanup.dirty, "commits_ahead": cleanup.commits_ahead,
        "branch_deleted": cleanup.branch_deleted, "workspace_fingerprint": Value::Null,
        "workspace_quarantined": false,
    });
    match proof {
        Ok(proof) => {
            payload["workspace_fingerprint"] = json!(proof.workspace_fingerprint);
            payload["head_commit"] = json!(proof.head_commit);
            payload["deliverable_checkpoint"] = json!(proof);
        }
        Err(error) => {
            let (stage, kind) = failure_codes(&error);
            payload["checkpoint_failure"] = json!({ "stage": stage, "kind": kind });
            payload["detail"] = json!(format!(
                "{}; complete deliverable checkpoint unavailable ({stage}: {kind}); narrowing is not admitted. {RECOVERY}",
                cleanup.detail
            ));
        }
    }
    send_run_event(
        outbound,
        runner_id,
        assignment,
        "run.workspace_preserved",
        payload,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_failure_codes_never_include_nested_error_contents() {
        let error = anyhow!("untrusted file name and command output")
            .context(CaptureStage::ArtifactExclusions);
        assert_eq!(
            failure_codes(&error),
            ("artifact_exclusions", "unavailable")
        );
        let error = anyhow!("untrusted file name and command output");
        assert_eq!(failure_codes(&error), ("capture", "unavailable"));
    }

    #[test]
    fn checkpoint_read_deadline_is_retained_through_stage_context() {
        let error =
            anyhow!(workspace::CheckpointReadDeadline).context(CaptureStage::InitialWorkspace);
        assert_eq!(
            failure_codes(&error),
            ("initial_workspace", "workspace_read_deadline")
        );
    }
}
