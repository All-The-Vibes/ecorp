//! Source durability before the immutable final verifier starts. No repository credentials.
use super::*;

#[cfg(test)]
#[path = "active_checkpoint_tests.rs"]
mod tests;

pub(super) struct CheckpointFailure {
    pub error: anyhow::Error,
    pub integrity: bool,
}

impl From<anyhow::Error> for CheckpointFailure {
    fn from(error: anyhow::Error) -> Self {
        Self {
            error,
            integrity: false,
        }
    }
}

impl CheckpointFailure {
    fn integrity(error: anyhow::Error) -> Self {
        Self {
            error,
            integrity: true,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn publish(
    outbound: &OutboundBus,
    runner_id: &str,
    assignment: &Assignment,
    workspace: &WorkspaceLease,
    workspaces: &WorkspaceManager,
    artifacts: &[AdapterArtifact],
    source_artifacts: &[AdapterArtifact],
    artifact_acks: &mut mpsc::UnboundedReceiver<ArtifactAck>,
    fingerprint: Option<&str>,
    head: &mut Option<String>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<bool, CheckpointFailure> {
    let policy = assignment
        .active_checkpoint
        .as_ref()
        .context("checkpoint policy missing")?;
    let focused = policy
        .focused_policy(&assignment.verification_policy)
        .map_err(anyhow::Error::msg)?;
    let spec = assignment
        .deliverable
        .as_ref()
        .context("checkpoint deliverable missing")?;
    if *cancellation.borrow() {
        return Ok(false);
    }
    let sealed_fingerprint = match fingerprint {
        Some(fingerprint) => fingerprint.to_owned(),
        None => workspaces
            .fingerprint(workspace)
            .await
            .map_err(CheckpointFailure::integrity)?,
    };
    let fingerprint = Some(sealed_fingerprint.as_str());
    if head.is_none() {
        *head = Some(
            workspaces
                .head_commit(workspace)
                .await
                .map_err(CheckpointFailure::integrity)?,
        );
    }
    verify_preserved_workspace_checkpoint(workspaces, workspace, fingerprint, head.as_deref())
        .await
        .map_err(CheckpointFailure::integrity)?;
    let mut prepared = deliverable::prepare_checkpoint(
        assignment.run_id,
        spec,
        workspace,
        source_artifacts,
        &assignment.write_scope,
        policy,
        &assignment.verification_policy,
    )
    .await?;
    let Some(report) = prepared.verify(&focused, artifacts, cancellation).await? else {
        return Ok(false);
    };
    policy
        .validate_report(
            &assignment.verification_policy,
            &serde_json::to_value(&report).map_err(anyhow::Error::from)?,
        )
        .map_err(anyhow::Error::msg)?;
    verify_preserved_workspace_checkpoint(workspaces, workspace, fingerprint, head.as_deref())
        .await
        .map_err(CheckpointFailure::integrity)?;
    if *cancellation.borrow() {
        return Ok(false);
    }
    let exported = prepared.export_checkpoint(&report).await?;
    // Only this exact export may advance the cleanup seal. Never adopt a later HEAD.
    *head = Some(
        exported
            .head_commit
            .clone()
            .context("checkpoint omitted its commit")?,
    );
    verify_preserved_workspace_checkpoint(workspaces, workspace, fingerprint, head.as_deref())
        .await
        .map_err(CheckpointFailure::integrity)?;
    let document: Value = serde_json::from_slice(&exported.bytes).map_err(anyhow::Error::from)?;
    let digest = hex::encode(sha2::Sha256::digest(&exported.bytes));
    let payload = json!({
        "sha256": digest, "bytes": exported.bytes.len(), "media_type": exported.media_type,
        "content_base64": BASE64.encode(&exported.bytes), "file_name": exported.file_name,
        "artifact_role": "source_checkpoint", "form": exported.form.as_str(),
        "verification_sha256": exported.verification_sha256,
        "verified_tree": exported.verified_tree, "source_verification": report.source,
        "base_commit": exported.base_commit, "head_commit": exported.head_commit,
        "branch": exported.branch, "git_bundle_sha256": exported.git_bundle_sha256,
        "publication_ready": false, "integration_state": "checkpoint_pending",
        "purpose": "active_checkpoint", "checkpoint_policy": policy,
        "verification_policy": assignment.verification_policy,
        "checkpoint_report": report, "parent_commit": document["parent_commit"],
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let mut stored = None;
    loop {
        if *cancellation.borrow() {
            return Ok(false);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!("remote draft checkpoint timed out; resume the trusted factory-checkpoint publisher and recover this preserved source").into());
        }
        if stored.is_none() {
            send_run_event(
                outbound,
                runner_id,
                assignment,
                "run.checkpoint_upload",
                payload.clone(),
            );
        } else {
            send_run_event(
                outbound,
                runner_id,
                assignment,
                "run.checkpoint_poll",
                json!({"sha256":digest}),
            );
        }
        let poll_deadline = std::cmp::min(
            deadline,
            tokio::time::Instant::now() + Duration::from_secs(3),
        );
        loop {
            let ack = tokio::select! {
                biased;
                () = verifier::wait_for_verifier_cancellation(cancellation) => return Ok(false),
                ack = tokio::time::timeout_at(poll_deadline, artifact_acks.recv()) => ack,
            };
            verify_preserved_workspace_checkpoint(
                workspaces,
                workspace,
                fingerprint,
                head.as_deref(),
            )
            .await
            .map_err(CheckpointFailure::integrity)?;
            match ack {
                Ok(Some(ack)) if ack.run_id == assignment.run_id && ack.sha256 == digest => {
                    if ack.artifact_role == "source_checkpoint" {
                        stored = Some(ack.artifact_id);
                        break;
                    }
                    if ack.artifact_role == "remote_source_checkpoint"
                        && stored == Some(ack.artifact_id)
                    {
                        return Ok(!*cancellation.borrow());
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) => {
                    return Err(anyhow!("remote checkpoint acknowledgment channel closed").into());
                }
                Err(_) => break,
            }
        }
    }
}
