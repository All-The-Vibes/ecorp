use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
    process::{Output, Stdio},
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use crony_domain::{
    ActiveCheckpointPolicy, DeliverableForm, DeliverableSpec, repository_relative_path_is_valid,
    write_scope_allows_path, write_scope_is_valid,
};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::process::Command;
use uuid::Uuid;

#[cfg(test)]
use crate::verifier::SourceVerification;
use crate::{adapter::AdapterArtifact, verifier::VerificationReport, workspace::WorkspaceLease};

#[path = "deliverable_verification.rs"]
mod verification;
pub(crate) use verification::isolate_git_environment;

#[path = "deliverable_history.rs"]
mod history;

#[cfg(test)]
#[path = "deliverable_history_tests.rs"]
mod history_tests;

#[cfg(test)]
#[path = "deliverable_verification_tests.rs"]
mod canonical_tests;

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_DELIVERABLE_BYTES: usize = 16_777_216;

#[derive(Debug)]
pub struct ExportedDeliverable {
    pub bytes: Vec<u8>,
    pub file_name: String,
    pub media_type: String,
    pub form: DeliverableForm,
    pub verification_sha256: String,
    pub base_commit: String,
    pub head_commit: Option<String>,
    pub branch: String,
    pub git_bundle_sha256: Option<String>,
    pub publication_ready: bool,
    pub verified_tree: String,
}

/// A single native Git index is selected before checks and never staged again at export.
pub struct PreparedDeliverable {
    run_id: Uuid,
    spec: DeliverableSpec,
    workspace: WorkspaceLease,
    workspace_root: PathBuf,
    workspace_directory: cap_std::fs::Dir,
    index: PathBuf,
    bundle: PathBuf,
    bundle_ref: String,
    tree: String,
    original_head: String,
    preserve_head_commit: Option<String>,
    changes: Vec<(String, String)>,
    provider_artifacts: Vec<AdapterArtifact>,
    verified_report_sha256: Option<String>,
    checkpoint_policy: Option<ActiveCheckpointPolicy>,
    checkpoint_verification_policy: Option<crony_domain::VerificationPolicy>,
}

impl Drop for PreparedDeliverable {
    fn drop(&mut self) {
        // Both names contain an unpredictable owner nonce. Never reuse/remove a prior run's files.
        for path in [&self.index, &self.bundle] {
            if let Err(error) = std::fs::remove_file(path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(path = %path.display(), %error, "deliverable scratch cleanup failed");
            }
        }
    }
}

impl PreparedDeliverable {
    pub async fn verify(
        &mut self,
        policy: &crony_domain::VerificationPolicy,
        artifacts: &[AdapterArtifact],
        cancellation: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<Option<VerificationReport>> {
        self.verified_report_sha256 = None;
        if let Some(checkpoint) = &self.checkpoint_policy {
            let full = self
                .checkpoint_verification_policy
                .as_ref()
                .context("checkpoint omitted its complete verification policy")?;
            if checkpoint
                .focused_policy(full)
                .map_err(anyhow::Error::msg)?
                != *policy
            {
                return Err(anyhow!(
                    "checkpoint verification must use its exact selected focused checks"
                ));
            }
        }
        let report = verification::verify(self, policy, artifacts, cancellation).await?;
        self.verified_report_sha256 = report
            .as_ref()
            .filter(|report| report.passed)
            .map(|report| report_digest(report, self.checkpoint_policy.is_some()))
            .transpose()?;
        Ok(report)
    }

    pub async fn export(&self, report: &VerificationReport) -> Result<ExportedDeliverable> {
        if self.checkpoint_policy.is_some() {
            return Err(anyhow!(
                "a focused checkpoint cannot be exported as a final deliverable"
            ));
        }
        self.export_verified(report).await
    }

    pub async fn export_checkpoint(
        &self,
        report: &VerificationReport,
    ) -> Result<ExportedDeliverable> {
        let checkpoint = self
            .checkpoint_policy
            .as_ref()
            .context("checkpoint export requires its separately selected focused policy")?;
        let full = self
            .checkpoint_verification_policy
            .as_ref()
            .context("checkpoint export omitted its complete verification policy")?;
        checkpoint
            .validate_report(full, &serde_json::to_value(report)?)
            .map_err(anyhow::Error::msg)?;
        self.export_verified(report).await
    }

    async fn export_verified(&self, report: &VerificationReport) -> Result<ExportedDeliverable> {
        if !report.passed
            || report.source.is_none()
            || self.verified_report_sha256.as_ref()
                != Some(&report_digest(report, self.checkpoint_policy.is_some())?)
            || report
                .source
                .as_ref()
                .is_none_or(|source| !source.is_valid() || source.tree != self.tree)
        {
            return Err(anyhow!(
                "deliverable requires a passing report for its exact Git candidate"
            ));
        }
        let tree = git_text(&self.workspace_root, &self.index, &["write-tree".into()]).await?;
        let head = git_text(
            &self.workspace_root,
            &self.index,
            &["rev-parse".into(), "HEAD^{commit}".into()],
        )
        .await?;
        if tree != self.tree || head != self.original_head {
            return Err(anyhow!(
                "deliverable candidate or original HEAD changed during verification"
            ));
        }
        export_prepared(self, report).await
    }
}

#[derive(Debug, Serialize)]
struct ArchivedChange {
    path: String,
    status: String,
    mode: Option<String>,
    sha256: Option<String>,
    bytes: Option<usize>,
    media_type: Option<String>,
    content_base64: Option<String>,
}

struct TemporaryExportPaths<'a> {
    index: &'a Path,
    bundle: &'a Path,
    bundle_ref: &'a str,
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub async fn export(
    run_id: Uuid,
    spec: &DeliverableSpec,
    workspace: &WorkspaceLease,
    report: &VerificationReport,
    provider_artifacts: &[AdapterArtifact],
    write_scope: &[String],
    preserve_head_commit: Option<&str>,
) -> Result<ExportedDeliverable> {
    // Low-level export tests supply fixture reports. Production must call prepare -> verify -> export.
    let mut prepared = prepare(
        run_id,
        spec,
        workspace,
        provider_artifacts,
        write_scope,
        preserve_head_commit,
    )
    .await?;
    let mut report = report.clone();
    report.source = Some(SourceVerification {
        tree: prepared.tree.clone(),
        base_commit: workspace.base_commit.clone(),
        candidate_commit: prepared.original_head.clone(),
        ignored_input_sha256: hex::encode(Sha256::digest([])),
        ignored_input_count: 0,
        ignored_input_bytes: 0,
    });
    prepared.verified_report_sha256 =
        Some(hex::encode(Sha256::digest(serde_json::to_vec(&report)?)));
    prepared.export(&report).await
}

pub async fn prepare(
    run_id: Uuid,
    spec: &DeliverableSpec,
    workspace: &WorkspaceLease,
    provider_artifacts: &[AdapterArtifact],
    write_scope: &[String],
    preserve_head_commit: Option<&str>,
) -> Result<PreparedDeliverable> {
    let workspace_root = tokio::fs::canonicalize(&workspace.path)
        .await
        .context("resolve deliverable worktree")?;
    let owner = Uuid::new_v4().simple().to_string();
    let temporary_index = workspace
        .path
        .parent()
        .context("deliverable worktree has no managed parent")?
        .join(format!(
            ".ecorp-deliverable-{}-{owner}.index",
            run_id.simple()
        ));
    let temporary_bundle = workspace
        .path
        .parent()
        .context("deliverable worktree has no managed parent")?
        .join(format!(
            ".ecorp-deliverable-{}-{owner}.bundle",
            run_id.simple()
        ));
    let mut prepared = PreparedDeliverable {
        run_id,
        spec: spec.clone(),
        workspace: workspace.clone(),
        workspace_directory: cap_std::fs::Dir::open_ambient_dir(
            &workspace_root,
            cap_std::ambient_authority(),
        )?,
        workspace_root,
        index: temporary_index,
        bundle: temporary_bundle,
        bundle_ref: format!("refs/ecorp/deliverables/{}-{owner}", run_id.simple()),
        tree: String::new(),
        original_head: String::new(),
        preserve_head_commit: preserve_head_commit.map(str::to_owned),
        changes: Vec::new(),
        provider_artifacts: provider_artifacts.to_vec(),
        verified_report_sha256: None,
        checkpoint_policy: None,
        checkpoint_verification_policy: None,
    };
    prepared.original_head = git_text(
        &prepared.workspace_root,
        &prepared.index,
        &["rev-parse".into(), "HEAD^{commit}".into()],
    )
    .await?;
    prepared.changes = select_index(
        spec,
        workspace,
        &prepared.workspace_root,
        provider_artifacts,
        write_scope,
        preserve_head_commit,
        &prepared.index,
    )
    .await?;
    prepared.tree = git_text(
        &prepared.workspace_root,
        &prepared.index,
        &["write-tree".into()],
    )
    .await?;
    Ok(prepared)
}

fn report_digest(report: &VerificationReport, checkpoint: bool) -> serde_json::Result<String> {
    // A checkpoint embeds its report as JSON and the server verifies that parsed value.
    // Canonical map ordering keeps the digest stable across struct -> Value round trips.
    let bytes = if checkpoint {
        serde_json::to_vec(&serde_json::to_value(report)?)?
    } else {
        serde_json::to_vec(report)?
    };
    Ok(hex::encode(Sha256::digest(bytes)))
}

/// The same private Git index and isolated native verifier are used for checkpoints.
/// This purpose never grants final publication or accepted completion authority.
pub async fn prepare_checkpoint(
    run_id: Uuid,
    spec: &DeliverableSpec,
    workspace: &WorkspaceLease,
    provider_artifacts: &[AdapterArtifact],
    write_scope: &[String],
    policy: &ActiveCheckpointPolicy,
    verification_policy: &crony_domain::VerificationPolicy,
) -> Result<PreparedDeliverable> {
    policy
        .focused_policy(verification_policy)
        .map_err(anyhow::Error::msg)?;
    if spec.form != DeliverableForm::CommitBranch {
        return Err(anyhow!(
            "active checkpoints require a commit/branch task deliverable"
        ));
    }
    let mut prepared = prepare(
        run_id,
        spec,
        workspace,
        provider_artifacts,
        write_scope,
        None,
    )
    .await?;
    #[cfg(windows)]
    {
        // Seed the private index from the existing native HEAD to retain executable bits;
        // selection still restores excluded paths to the immutable workspace base.
        prepared.changes = select_index(
            spec,
            workspace,
            &prepared.workspace_root,
            provider_artifacts,
            write_scope,
            Some(&prepared.original_head),
            &prepared.index,
        )
        .await?;
        prepared.tree = git_text(
            &prepared.workspace_root,
            &prepared.index,
            &["write-tree".into()],
        )
        .await?;
    }
    let base_tree = git_text(
        &prepared.workspace_root,
        &prepared.index,
        &[
            "rev-parse".into(),
            format!("{}^{{tree}}", workspace.base_commit).into(),
        ],
    )
    .await?;
    if prepared.tree == base_tree {
        return Err(anyhow!(
            "active checkpoint has no source change beyond its base; preserve the worktree without inventing an empty commit"
        ));
    }
    history::validate(&prepared, write_scope).await.context(
        "active checkpoint retained history is not safe to publish; preserve the worktree",
    )?;
    prepared.checkpoint_policy = Some(policy.clone());
    prepared.checkpoint_verification_policy = Some(verification_policy.clone());
    Ok(prepared)
}

#[allow(clippy::too_many_arguments)]
async fn select_index(
    spec: &DeliverableSpec,
    workspace: &WorkspaceLease,
    workspace_root: &Path,
    provider_artifacts: &[AdapterArtifact],
    write_scope: &[String],
    preserve_head_commit: Option<&str>,
    index: &Path,
) -> Result<Vec<(String, String)>> {
    for path in &spec.paths {
        validate_relative(path)?;
    }
    let index_base = if cfg!(windows) {
        preserve_head_commit.unwrap_or(&workspace.base_commit)
    } else {
        &workspace.base_commit
    };
    git_success(
        workspace_root,
        index,
        &[OsString::from("read-tree"), OsString::from(index_base)],
    )
    .await?;

    #[cfg(windows)]
    if preserve_head_commit.is_some() && !spec.paths.is_empty() {
        // Windows cannot reconstruct executable bits from physical permissions. Seed them from
        // the verification-linked head, but restore every unselected path to the immutable base.
        let mut reset_args = vec![
            OsString::from("reset"),
            OsString::from("-q"),
            OsString::from(&workspace.base_commit),
            OsString::from("--"),
        ];
        for (_, path) in changed_paths(workspace_root, index, &workspace.base_commit).await? {
            if !path_is_selected(spec, &path) {
                reset_args.push(OsString::from(path));
            }
        }
        if reset_args.len() > 4 {
            git_success(workspace_root, index, &reset_args).await?;
        }
    }

    let mut add_args = Vec::new();
    // Native executable-mode changes must not disappear behind repository core.filemode=false.
    // This override applies only to the temporary export index, never to repository configuration.
    #[cfg(unix)]
    add_args.extend([OsString::from("-c"), OsString::from("core.filemode=true")]);
    #[cfg(windows)]
    add_args.extend([OsString::from("-c"), OsString::from("core.filemode=false")]);
    add_args.extend([
        OsString::from("add"),
        OsString::from("-A"),
        OsString::from("--"),
    ]);
    if spec.paths.is_empty() {
        add_args.push(OsString::from("."));
    } else {
        for path in &spec.paths {
            add_args.push(OsString::from(path));
        }
    }
    git_success(workspace_root, index, &add_args).await?;

    for artifact in provider_artifacts {
        let Ok(artifact_path) = tokio::fs::canonicalize(&artifact.path).await else {
            continue;
        };
        let Ok(path) = artifact_path.strip_prefix(workspace_root) else {
            continue;
        };
        let relative = portable_path(path)?;
        git_success(
            workspace_root,
            index,
            &[
                OsString::from("reset"),
                OsString::from("-q"),
                OsString::from(&workspace.base_commit),
                OsString::from("--"),
                OsString::from(relative),
            ],
        )
        .await?;
    }

    let changes = changed_paths(workspace_root, index, &workspace.base_commit).await?;
    reject_out_of_scope_changes(&changes, write_scope)?;
    reject_unsafe_changes(workspace_root, index, &changes).await?;
    Ok(changes)
}

async fn export_prepared(
    prepared: &PreparedDeliverable,
    report: &VerificationReport,
) -> Result<ExportedDeliverable> {
    let spec = &prepared.spec;
    let workspace = &prepared.workspace;
    let workspace_root = &prepared.workspace_root;
    let changes = &prepared.changes;
    let temporary_paths = TemporaryExportPaths {
        index: &prepared.index,
        bundle: &prepared.bundle,
        bundle_ref: &prepared.bundle_ref,
    };
    let verification_sha256 = report_digest(report, prepared.checkpoint_policy.is_some())
        .context("serialize verification report for linkage")?;

    let should_commit =
        spec.commit_after_verification || spec.form == DeliverableForm::CommitBranch;
    let head_commit = if should_commit {
        commit_prepared(prepared, &verification_sha256).await?
    } else {
        None
    };

    let patch = git_output(
        workspace_root,
        temporary_paths.index,
        &[
            OsString::from("diff"),
            OsString::from("--binary"),
            OsString::from("--full-index"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--no-color"),
            OsString::from(&workspace.base_commit),
            OsString::from(&prepared.tree),
            OsString::from("--"),
        ],
    )
    .await?
    .stdout;
    let git_bundle = if spec.form == DeliverableForm::CommitBranch {
        let head_commit = head_commit
            .as_deref()
            .context("commit/branch deliverable omitted its committed head")?;
        Some(
            create_git_bundle(
                workspace_root,
                temporary_paths.index,
                temporary_paths.bundle,
                temporary_paths.bundle_ref,
                &workspace.branch,
                &workspace.base_commit,
                head_commit,
            )
            .await?,
        )
    } else {
        None
    };
    let git_bundle_sha256 = git_bundle
        .as_ref()
        .map(|bundle| hex::encode(Sha256::digest(bundle)));

    let (bytes, file_name, media_type) =
        match spec.form {
            DeliverableForm::Patch => (
                patch,
                "ecorp-deliverable.patch".to_owned(),
                "text/x-diff".to_owned(),
            ),
            form => {
                let include_content = matches!(
                    form,
                    DeliverableForm::Archive
                        | DeliverableForm::TypedArtifactSet
                        | DeliverableForm::CommitBranch
                );
                let archived = archive_changes(
                    workspace_root,
                    temporary_paths.index,
                    &prepared.tree,
                    changes,
                    include_content,
                )
                .await?;
                let mut document = json!({
                    "schema_version": 1,
                    "form": form.as_str(),
                    "base_commit": workspace.base_commit,
                    "head_commit": head_commit,
                    "branch": workspace.branch,
                    "verification_sha256": verification_sha256,
                    "verified_tree": prepared.tree,
                    "source_verification": report.source,
                    "patch_sha256": hex::encode(Sha256::digest(&patch)),
                    "patch_base64": include_content.then(|| BASE64.encode(&patch)),
                    "git_bundle_sha256": git_bundle_sha256,
                    "git_bundle_base64": git_bundle.as_ref().map(|bundle| BASE64.encode(bundle)),
                    "changes": archived,
                });
                if let Some(policy) = &prepared.checkpoint_policy {
                    document["purpose"] = json!("active_checkpoint");
                    document["checkpoint_policy"] = json!(policy);
                    document["verification_policy"] =
                        json!(prepared.checkpoint_verification_policy.as_ref().context(
                            "checkpoint envelope omitted its complete verification policy"
                        )?);
                    document["checkpoint_report"] = json!(report);
                    document["parent_commit"] = json!(prepared.original_head);
                    document["publication_ready"] = json!(false);
                }
                let name = match form {
                    DeliverableForm::Archive => "ecorp-source-archive.json",
                    DeliverableForm::TypedArtifactSet => "ecorp-artifact-set.json",
                    DeliverableForm::CommitBranch => "ecorp-commit-branch.json",
                    DeliverableForm::ReviewOnlyReport => "ecorp-review-report.json",
                    DeliverableForm::Patch => unreachable!(),
                };
                (
                    serde_json::to_vec_pretty(&document)
                        .context("serialize deterministic deliverable")?,
                    if prepared.checkpoint_policy.is_some() {
                        "ecorp-active-checkpoint.json"
                    } else {
                        name
                    }
                    .to_owned(),
                    if prepared.checkpoint_policy.is_some() {
                        "application/vnd.ecorp.checkpoint+json"
                    } else {
                        "application/vnd.ecorp.deliverable+json"
                    }
                    .to_owned(),
                )
            }
        };
    if bytes.is_empty() {
        return Err(anyhow!("deliverable export produced no bytes"));
    }
    if bytes.len() > MAX_DELIVERABLE_BYTES {
        return Err(anyhow!(
            "deliverable size {} exceeds the runner limit {}",
            bytes.len(),
            MAX_DELIVERABLE_BYTES
        ));
    }

    Ok(ExportedDeliverable {
        bytes,
        file_name,
        media_type,
        form: spec.form,
        verification_sha256,
        base_commit: workspace.base_commit.clone(),
        head_commit,
        branch: workspace.branch.clone(),
        git_bundle_sha256,
        publication_ready: spec.form == DeliverableForm::CommitBranch
            && prepared.checkpoint_policy.is_none(),
        verified_tree: prepared.tree.clone(),
    })
}

async fn create_git_bundle(
    workspace: &Path,
    index: &Path,
    bundle_path: &Path,
    bundle_ref: &str,
    branch: &str,
    base_commit: &str,
    head_commit: &str,
) -> Result<Vec<u8>> {
    let branch_ref = format!("refs/heads/{branch}");
    let resolved_head = git_text(
        workspace,
        index,
        &[
            OsString::from("rev-parse"),
            OsString::from(format!("{branch_ref}^{{commit}}")),
        ],
    )
    .await?;
    if resolved_head != head_commit {
        return Err(anyhow!(
            "commit/branch deliverable head no longer matches its isolated branch"
        ));
    }
    git_success(
        workspace,
        index,
        &[
            OsString::from("merge-base"),
            OsString::from("--is-ancestor"),
            OsString::from(base_commit),
            OsString::from(head_commit),
        ],
    )
    .await?;
    git_success(
        workspace,
        index,
        &[
            OsString::from("update-ref"),
            OsString::from(bundle_ref),
            OsString::from(head_commit),
        ],
    )
    .await?;
    let bundle_result = async {
        git_success(
            workspace,
            index,
            &[
                OsString::from("bundle"),
                OsString::from("create"),
                bundle_path.as_os_str().to_owned(),
                OsString::from(bundle_ref),
                OsString::from(format!("^{base_commit}")),
            ],
        )
        .await?;
        tokio::fs::read(bundle_path)
            .await
            .context("read portable Git bundle")
    }
    .await;
    let cleanup_result = git_success(
        workspace,
        index,
        &[
            OsString::from("update-ref"),
            OsString::from("-d"),
            OsString::from(bundle_ref),
        ],
    )
    .await;
    let bundle = match (bundle_result, cleanup_result) {
        (Ok(bundle), Ok(())) => bundle,
        (Err(error), _) => return Err(error),
        (Ok(_), Err(error)) => {
            return Err(error).context("remove temporary deliverable bundle ref");
        }
    };
    if bundle.is_empty() {
        return Err(anyhow!("portable Git bundle is empty"));
    }
    Ok(bundle)
}

async fn changed_paths(
    workspace: &Path,
    index: &Path,
    base_commit: &str,
) -> Result<Vec<(String, String)>> {
    let output = git_output(
        workspace,
        index,
        &[
            OsString::from("diff"),
            OsString::from("--cached"),
            OsString::from("--name-status"),
            OsString::from("-z"),
            OsString::from("--no-renames"),
            OsString::from(base_commit),
            OsString::from("--"),
        ],
    )
    .await?
    .stdout;
    let fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut fields =
        fields.map(|field| String::from_utf8(field.to_vec()).context("Git path is not UTF-8"));
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        let status = status?;
        let path = fields
            .next()
            .context("Git name-status output omitted a path")??;
        validate_relative(&path)?;
        changes.push((status, path));
    }
    changes.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
    Ok(changes)
}

async fn reject_unsafe_changes(
    workspace: &Path,
    index: &Path,
    changes: &[(String, String)],
) -> Result<()> {
    for (status, path) in changes {
        if sensitive_path(path) {
            return Err(anyhow!(
                "deliverable contains a secret-like or runner-internal path: {path}"
            ));
        }
        if status.starts_with('D') {
            continue;
        }
        let mode = index_mode(workspace, index, path).await?;
        if mode == "120000" {
            return Err(anyhow!("deliverable cannot contain symbolic link {path}"));
        }
        if mode == "160000" {
            return Err(anyhow!("deliverable cannot contain Git link {path}"));
        }
        if !matches!(mode.as_str(), "100644" | "100755") {
            return Err(anyhow!(
                "deliverable contains unsupported file mode {mode}: {path}"
            ));
        }
        // Git modes alone cannot identify every Windows reparse point or a linked ancestor.
        let mut physical = workspace.to_owned();
        for component in Path::new(path).components() {
            physical.push(component.as_os_str());
            let metadata = tokio::fs::symlink_metadata(&physical)
                .await
                .with_context(|| format!("inspect deliverable path {path}"))?;
            if crate::workspace::snapshot_entry_is_link(&metadata) {
                return Err(anyhow!(
                    "deliverable cannot contain a symbolic link or reparse point: {path}"
                ));
            }
        }
        let candidate = workspace.join(path);
        let canonical = tokio::fs::canonicalize(&candidate)
            .await
            .with_context(|| format!("resolve deliverable path {path}"))?;
        if !canonical.starts_with(workspace) {
            return Err(anyhow!("deliverable path escapes the worktree: {path}"));
        }
    }
    Ok(())
}

async fn archive_changes(
    workspace: &Path,
    index: &Path,
    tree: &str,
    changes: &[(String, String)],
    include_content: bool,
) -> Result<Vec<ArchivedChange>> {
    let mut archived = Vec::with_capacity(changes.len());
    for (status, path) in changes {
        if status.starts_with('D') {
            archived.push(ArchivedChange {
                path: path.clone(),
                status: status.clone(),
                mode: None,
                sha256: None,
                bytes: None,
                media_type: None,
                content_base64: None,
            });
            continue;
        }
        let content = git_output(
            workspace,
            index,
            &[
                OsString::from("cat-file"),
                OsString::from("blob"),
                OsString::from(format!("{tree}:{path}")),
            ],
        )
        .await?
        .stdout;
        let mode = git_text(
            workspace,
            index,
            &["ls-tree".into(), tree.into(), "--".into(), path.into()],
        )
        .await?
        .split_whitespace()
        .next()
        .context("canonical tree omitted file mode")?
        .to_owned();
        archived.push(ArchivedChange {
            path: path.clone(),
            status: status.clone(),
            mode: Some(mode),
            sha256: Some(hex::encode(Sha256::digest(&content))),
            bytes: Some(content.len()),
            media_type: Some(infer_media_type(path).to_owned()),
            content_base64: include_content.then(|| BASE64.encode(content)),
        });
    }
    Ok(archived)
}

async fn index_mode(workspace: &Path, index: &Path, path: &str) -> Result<String> {
    let output = git_output(
        workspace,
        index,
        &[
            OsString::from("ls-files"),
            OsString::from("--stage"),
            OsString::from("--"),
            OsString::from(path),
        ],
    )
    .await?;
    let text = String::from_utf8(output.stdout).context("Git index mode is not UTF-8")?;
    text.split_whitespace()
        .next()
        .map(str::to_owned)
        .context("Git index omitted file mode")
}

async fn commit_prepared(
    prepared: &PreparedDeliverable,
    verification_sha256: &str,
) -> Result<Option<String>> {
    let workspace = &prepared.workspace_root;
    let index = &prepared.index;
    let lease = &prepared.workspace;
    let tree = &prepared.tree;
    let changes = &prepared.changes;
    let parent = if prepared.checkpoint_policy.is_some() {
        &prepared.original_head
    } else {
        &lease.base_commit
    };
    let base_tree = git_text(
        workspace,
        index,
        &[
            OsString::from("rev-parse"),
            OsString::from(format!("{parent}^{{tree}}")),
        ],
    )
    .await?;
    let old_head = &prepared.original_head;
    if let Some(expected_head) = prepared.preserve_head_commit.as_deref() {
        if old_head != expected_head {
            return Err(anyhow!(
                "verifier-only deliverable expected head {expected_head}, found {old_head}"
            ));
        }
        let expected_tree = git_text(
            workspace,
            index,
            &[
                OsString::from("rev-parse"),
                OsString::from(format!("{expected_head}^{{tree}}")),
            ],
        )
        .await?;
        if tree != &expected_tree {
            return Err(anyhow!(
                "verifier-only deliverable tree changed from preserved head {expected_head}"
            ));
        }
        return Ok(Some(expected_head.to_owned()));
    }
    let commit = if tree == &base_tree {
        parent.clone()
    } else {
        let purpose = if prepared.checkpoint_policy.is_some() {
            "ECorp focused source checkpoint (final verification pending)"
        } else {
            "ECorp verified deliverable"
        };
        let message = format!("{purpose}\n\nVerification-SHA256: {verification_sha256}\n");
        git_text_with_env(
            workspace,
            index,
            &[
                OsString::from("commit-tree"),
                OsString::from(tree),
                OsString::from("-p"),
                OsString::from(parent),
                OsString::from("-m"),
                OsString::from(message),
            ],
            &[
                ("GIT_AUTHOR_NAME", "ECorp Runner"),
                ("GIT_AUTHOR_EMAIL", "runner@ecorp.invalid"),
                ("GIT_COMMITTER_NAME", "ECorp Runner"),
                ("GIT_COMMITTER_EMAIL", "runner@ecorp.invalid"),
            ],
        )
        .await?
    };
    git_success(
        workspace,
        index,
        &[
            OsString::from("update-ref"),
            OsString::from(format!("refs/heads/{}", lease.branch)),
            OsString::from(&commit),
            OsString::from(old_head),
        ],
    )
    .await?;
    if !changes.is_empty() {
        let mut command = Command::new("git");
        verification::clear_git_environment(&mut command);
        #[cfg(windows)]
        command.args(["-c", "core.longpaths=true"]);
        command
            .args(["reset", "--mixed", "HEAD", "--"])
            .args(changes.iter().map(|(_, path)| path))
            .current_dir(workspace)
            .env("GIT_LITERAL_PATHSPECS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output = command
            .output()
            .await
            .context("refresh committed paths in the worktree index")?;
        if !output.status.success() {
            return Err(git_error(&output));
        }
    }
    Ok(Some(commit))
}

fn validate_relative(value: &str) -> Result<()> {
    if !repository_relative_path_is_valid(value) {
        return Err(anyhow!("deliverable path must stay inside the worktree"));
    }
    Ok(())
}

fn path_is_selected(spec: &DeliverableSpec, path: &str) -> bool {
    spec.paths.is_empty()
        || spec
            .paths
            .iter()
            .any(|selected| path == selected || path.starts_with(&format!("{selected}/")))
}

fn reject_out_of_scope_changes(changes: &[(String, String)], write_scope: &[String]) -> Result<()> {
    if write_scope.is_empty() {
        return Err(anyhow!(
            "deliverable export requires an explicit task write scope"
        ));
    }
    for scope in write_scope {
        if !write_scope_is_valid(scope) {
            return Err(anyhow!(
                "task write scope must be an exact relative path or end in /**"
            ));
        }
    }
    for (_, path) in changes {
        if !write_scope
            .iter()
            .any(|scope| write_scope_allows_path(scope, path))
        {
            return Err(anyhow!(
                "deliverable contains path outside the task write scope: {path}"
            ));
        }
    }
    Ok(())
}

fn portable_path(path: &Path) -> Result<String> {
    let value = path
        .components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value.to_string_lossy().into_owned()),
            _ => Err(anyhow!(
                "deliverable path contains a non-portable component"
            )),
        })
        .collect::<Result<Vec<_>>>()?
        .join("/");
    validate_relative(&value)?;
    Ok(value)
}

fn sensitive_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let file_name = normalized.rsplit('/').next().unwrap_or(&normalized);
    let components = normalized.split('/').collect::<Vec<_>>();
    components.iter().any(|component| {
        matches!(
            *component,
            ".git"
                | ".codex"
                | ".claude"
                | ".ssh"
                | ".aws"
                | ".azure"
                | ".kube"
                | ".docker"
                | ".gnupg"
                | ".password-store"
                | ".terraform.d"
                | ".pulumi"
                | ".oci"
                | ".gem"
                | ".nuget"
                | ".m2"
                | ".gradle"
                | ".composer"
                | ".vercel"
                | ".netlify"
                | ".wrangler"
                | ".fly"
                | ".yarn"
        )
    }) || components.windows(2).any(|pair| {
        pair[0] == ".config"
            && matches!(
                pair[1],
                "gcloud"
                    | "gh"
                    | "hub"
                    | "glab"
                    | "doctl"
                    | "heroku"
                    | "op"
                    | "rclone"
                    | "containers"
                    | "github-copilot"
                    | "openai"
                    | "anthropic"
                    | "huggingface"
                    | "kaggle"
                    | "wandb"
                    | "pypoetry"
                    | "composer"
                    | "pip"
                    | "uv"
                    | "npm"
                    | "yarn"
                    | "pnpm"
                    | "bun"
                    | "deno"
                    | "vercel"
                    | "netlify"
                    | "cloudflare"
                    | "fly"
                    | "azure-devops"
            )
    }) || file_name.starts_with(".env")
        || matches!(
            file_name,
            ".npmrc"
                | ".pypirc"
                | ".netrc"
                | "_netrc"
                | ".git-credentials"
                | ".vault-token"
                | ".sentryclirc"
                | ".terraformrc"
                | ".yarnrc"
                | ".yarnrc.yml"
                | ".yarnrc.yaml"
                | "terraform.rc"
                | "npmrc"
                | "id_rsa"
                | "id_ed25519"
                | "application_default_credentials.json"
                | "accesstokens.json"
                | "kubeconfig"
                | "credentials"
                | "credentials.json"
                | "credentials.toml"
                | "secrets.json"
        )
        || file_name.ends_with(".pem")
        || file_name.ends_with(".key")
        || file_name.ends_with(".p12")
        || file_name.ends_with(".pfx")
}

fn infer_media_type(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "json" => "application/json",
        "md" | "txt" | "rs" | "ts" | "tsx" | "js" | "mjs" | "css" | "html" | "toml" | "yaml"
        | "yml" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

async fn git_success(workspace: &Path, index: &Path, args: &[OsString]) -> Result<()> {
    let output = git_output(workspace, index, args).await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_error(&output))
    }
}

async fn git_text(workspace: &Path, index: &Path, args: &[OsString]) -> Result<String> {
    git_text_with_env(workspace, index, args, &[]).await
}

async fn git_text_with_env(
    workspace: &Path,
    index: &Path,
    args: &[OsString],
    env: &[(&str, &str)],
) -> Result<String> {
    let mut command = Command::new("git");
    verification::clear_git_environment(&mut command);
    #[cfg(windows)]
    command.args(["-c", "core.longpaths=true"]);
    command
        .args(args)
        .current_dir(workspace)
        .env(
            "GIT_INDEX_FILE",
            crate::workspace::normalize_path(index.to_path_buf()),
        )
        .env("GIT_LITERAL_PATHSPECS", "1")
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(GIT_TIMEOUT, command.output())
        .await
        .context("Git deliverable command timed out")?
        .context("start Git deliverable command")?;
    if !output.status.success() {
        return Err(git_error(&output));
    }
    Ok(String::from_utf8(output.stdout)
        .context("Git deliverable output is not UTF-8")?
        .trim()
        .to_owned())
}

async fn git_output(workspace: &Path, index: &Path, args: &[OsString]) -> Result<Output> {
    let mut command = Command::new("git");
    verification::clear_git_environment(&mut command);
    #[cfg(windows)]
    command.args(["-c", "core.longpaths=true"]);
    command
        .args(args)
        .current_dir(workspace)
        .env(
            "GIT_INDEX_FILE",
            crate::workspace::normalize_path(index.to_path_buf()),
        )
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(GIT_TIMEOUT, command.output())
        .await
        .context("Git deliverable command timed out")?
        .context("start Git deliverable command")?;
    if !output.status.success() {
        return Err(git_error(&output));
    }
    Ok(output)
}

fn git_error(output: &Output) -> anyhow::Error {
    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow!("Git deliverable command failed: {}", stderr.trim())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, process::Command};

    use crony_domain::{DeliverableForm, DeliverableSpec};
    use serde_json::Value;

    use super::*;
    use crate::verifier::{VerificationCheckResult, VerificationReport};

    pub(super) fn git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    pub(super) fn fixture() -> (PathBuf, WorkspaceLease, VerificationReport) {
        let root = std::env::temp_dir().join(format!("ecorp-deliverable-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create fixture");
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "user.email", "test@example.invalid"]);
        fs::write(root.join("tracked.txt"), b"before\n").expect("write tracked");
        fs::write(root.join("other.txt"), b"other before\n").expect("write other");
        git(&root, &["add", "tracked.txt", "other.txt"]);
        git(&root, &["commit", "-m", "base"]);
        let base_commit = git(&root, &["rev-parse", "HEAD"]);
        let lease = WorkspaceLease {
            path: root.clone(),
            branch: "main".to_owned(),
            base_ref: "main".to_owned(),
            base_commit,
        };
        let report = VerificationReport {
            passed: true,
            summary: "all checks passed".to_owned(),
            checks: vec![VerificationCheckResult {
                check_index: 0,
                kind: "file".to_owned(),
                passed: true,
                summary: "tracked.txt passed".to_owned(),
                payload: json!({"sha256": "fixed"}),
            }],
            manual_gate: None,
            source: None,
        };
        (root, lease, report)
    }

    #[tokio::test]
    async fn native_export_matches_checker_under_inherited_tracing() {
        const CHILD_SOURCE: &str = "ECORP_EXPORT_PARITY_SOURCE";
        const CHILD_BASE: &str = "ECORP_EXPORT_PARITY_BASE";
        const CHILD_EVIDENCE: &str = "ECORP_EXPORT_PARITY_EVIDENCE";
        if let Some(source) = std::env::var_os(CHILD_SOURCE) {
            let root = PathBuf::from(source);
            let evidence = PathBuf::from(std::env::var_os(CHILD_EVIDENCE).expect("owned evidence"));
            assert!(
                root.file_name()
                    .expect("fixture name")
                    .to_string_lossy()
                    .starts_with("ecorp-deliverable-test-")
            );
            let lease = WorkspaceLease {
                path: root,
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                base_commit: std::env::var(CHILD_BASE).expect("fixture base"),
            };
            let report = VerificationReport {
                passed: true,
                summary: "checker/exporter parity fixture".to_owned(),
                checks: Vec::new(),
                manual_gate: None,
                source: None,
            };
            let exported = export(
                Uuid::new_v4(),
                &DeliverableSpec {
                    form: DeliverableForm::CommitBranch,
                    commit_after_verification: true,
                    paths: Vec::new(),
                },
                &lease,
                &report,
                &[],
                &["**".to_owned()],
                None,
            )
            .await
            .expect("actual native exporter");
            fs::write(evidence.join("export.json"), exported.bytes).expect("retain native export");
            return;
        }

        let checker =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/check_deliverable_diff.mjs");
        for name in [
            "GIT_TRACE",
            "GIT_TRACE_PERFORMANCE",
            "GIT_TRACE_SETUP",
            "GIT_TRACE2",
            "GIT_TRACE2_EVENT",
            "GIT_TRACE2_PERF",
            "git_trace",
            "GiT_tRaCe2_EvEnT",
            "GIT_CONFIG_COUNT",
        ] {
            let (root, lease, _) = fixture();
            let evidence = root.with_extension("evidence");
            let scratch = evidence.join("checker-scratch");
            fs::create_dir_all(&scratch).expect("create owned evidence");
            git(&root, &["config", "core.autocrlf", "false"]);
            git(&root, &["config", "core.whitespace", "cr-at-eol"]);
            let source_bytes: &[u8] = if name == "GIT_CONFIG_COUNT" {
                b"intentional change\r\n"
            } else {
                b"intentional change\n"
            };
            fs::write(root.join("tracked.txt"), source_bytes).expect("modify fixture source");
            let trace = root.join("inherited-trace.txt");
            let inherited_value = if name == "GIT_CONFIG_COUNT" {
                OsString::from("1")
            } else {
                trace.as_os_str().to_owned()
            };
            // Git expands Windows short-name aliases when reporting its root.
            // Use that same spelling for the checker's strict root validation.
            let checker_root = git(&root, &["rev-parse", "--show-toplevel"]);
            let mut check = tokio::process::Command::new("node");
            check
                .arg(&checker)
                .arg("--repo")
                .arg(&checker_root)
                .arg("--base")
                .arg(&lease.base_commit)
                .arg("--scratch-root")
                .arg(&scratch)
                .env(name, &inherited_value)
                .env("GIT_CONFIG_KEY_0", "core.autocrlf")
                .env("GIT_CONFIG_VALUE_0", "true")
                .env("GIT_CURL_VERBOSE", "1")
                .kill_on_drop(true);
            let checked = tokio::time::timeout(Duration::from_secs(60), check.output())
                .await
                .expect("checker watchdog")
                .expect("run actual checker");
            fs::write(evidence.join("checker.stdout"), &checked.stdout).expect("retain checker");
            fs::write(evidence.join("checker.stderr"), &checked.stderr)
                .expect("retain diagnostics");
            assert!(
                checked.status.success(),
                "checker failed; evidence {evidence:?}"
            );
            let checked: Value = serde_json::from_slice(&checked.stdout).expect("checker JSON");
            assert_eq!(checked["passed"], true);
            assert!(!trace.exists(), "checker must preserve source bytes");
            let mut native =
                tokio::process::Command::new(std::env::current_exe().expect("test executable"));
            native
                .args([
                    "--exact",
                    "deliverable::tests::native_export_matches_checker_under_inherited_tracing",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD_SOURCE, &root)
                .env(CHILD_BASE, &lease.base_commit)
                .env(CHILD_EVIDENCE, &evidence)
                .env(name, &inherited_value)
                .env("GIT_CONFIG_KEY_0", "core.autocrlf")
                .env("GIT_CONFIG_VALUE_0", "true")
                .env("GIT_CURL_VERBOSE", "1")
                .kill_on_drop(true);
            let exported = tokio::time::timeout(Duration::from_secs(90), native.output())
                .await
                .expect("native exporter watchdog")
                .expect("native exporter subprocess");
            fs::write(evidence.join("native.stdout"), &exported.stdout)
                .expect("retain native result");
            fs::write(evidence.join("native.stderr"), &exported.stderr)
                .expect("retain diagnostics");
            let tree = git(&root, &["rev-parse", "HEAD^{tree}"]);
            let changes = git(
                &root,
                &["diff", "--name-status", &lease.base_commit, "HEAD", "--"],
            );
            fs::write(
                evidence.join("parity.json"),
                serde_json::to_vec_pretty(&json!({
                    "inherited_git_environment": name,
                    "base": lease.base_commit,
                    "checker_tree": checked["candidateTree"],
                    "exporter_tree": tree,
                    "exporter_exit": exported.status.code(),
                    "exported_changes": changes,
                    "trace_created": trace.exists(),
                }))
                .expect("parity JSON"),
            )
            .expect("retain parity evidence");
            println!("{name}: source={root:?}; evidence={evidence:?}");
            assert!(
                exported.status.success(),
                "native exporter failed; evidence {evidence:?}"
            );
            assert_eq!(
                checked["candidateTree"].as_str(),
                Some(tree.as_str()),
                "checker/exporter tree mismatch; evidence {evidence:?}"
            );
            assert_eq!(changes, "M\ttracked.txt");
            assert!(
                !trace.exists(),
                "exporter Git children must not create source inputs"
            );
            assert_eq!(git(&root, &["status", "--porcelain=v1"]), "");
            assert_eq!(
                fs::read(root.join("tracked.txt")).expect("source bytes"),
                source_bytes
            );
            // Preserve actual native export, diagnostics, and source fixtures,
            // including failures and any trace file produced by old code.
        }
    }

    #[tokio::test]
    async fn active_checkpoint_rejects_deleted_secret_in_retained_history() {
        let (root, lease, _) = fixture();
        let synthetic = b"ECORP_FIXTURE_ONLY=not-a-real-credential\n";
        fs::write(root.join(".env"), synthetic).expect("synthetic excluded file");
        git(&root, &["add", "--", ".env"]);
        git(&root, &["commit", "-m", "synthetic excluded history"]);
        let unsafe_commit = git(&root, &["rev-parse", "HEAD"]);
        git(&root, &["rm", "--", ".env"]);
        git(
            &root,
            &["commit", "-m", "delete excluded file from the tip"],
        );
        let original = git(&root, &["rev-parse", "HEAD"]);
        fs::write(root.join("tracked.txt"), b"safe final source\n").unwrap();
        let before_status = git(&root, &["status", "--porcelain=v1"]);
        let policy = crony_domain::VerificationPolicy {
            checks: vec![crony_domain::VerifierCheck::File {
                path: "tracked.txt".into(),
                min_bytes: 1,
            }],
            manual_gate: None,
        };
        let checkpoint = ActiveCheckpointPolicy {
            check_indices: vec![0],
        };
        let prepared = prepare_checkpoint(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::CommitBranch,
                commit_after_verification: true,
                paths: vec!["tracked.txt".into()],
            },
            &lease,
            &[],
            &["tracked.txt".into()],
            &checkpoint,
            &policy,
        )
        .await;
        match prepared {
            Err(error) => {
                assert!(format!("{error:#}").contains("history"), "{error:#}");
                assert_eq!(git(&root, &["rev-parse", "HEAD"]), original);
                assert_eq!(git(&root, &["status", "--porcelain=v1"]), before_status);
                assert_eq!(
                    fs::read(root.join("tracked.txt")).unwrap(),
                    b"safe final source\n"
                );
            }
            Ok(mut prepared) => {
                // On an unsafe implementation, retain a native bundle/import proof instead of
                // inferring a disclosure solely from prepare accepting a clean tip tree.
                let (_sender, mut cancellation) = tokio::sync::watch::channel(false);
                let report = prepared
                    .verify(&policy, &[], &mut cancellation)
                    .await
                    .unwrap()
                    .unwrap();
                let exported = prepared.export_checkpoint(&report).await.unwrap();
                let document: Value = serde_json::from_slice(&exported.bytes).unwrap();
                let bundle = root.join("retained-history.bundle");
                fs::write(
                    &bundle,
                    BASE64
                        .decode(document["git_bundle_base64"].as_str().unwrap())
                        .unwrap(),
                )
                .unwrap();
                let imported = root.join("retained-history-import.git");
                fs::create_dir(&imported).unwrap();
                git(&imported, &["init", "--bare"]);
                git(
                    &imported,
                    &[
                        "fetch",
                        "--no-tags",
                        root.to_str().unwrap(),
                        &lease.base_commit,
                    ],
                );
                let advertised = git(
                    &imported,
                    &["bundle", "list-heads", bundle.to_str().unwrap()],
                );
                let bundle_ref = advertised.split_whitespace().nth(1).unwrap();
                git(
                    &imported,
                    &[
                        "fetch",
                        "--no-tags",
                        bundle.to_str().unwrap(),
                        &format!("{bundle_ref}:refs/heads/checkpoint"),
                    ],
                );
                assert_eq!(
                    git(&imported, &["show", &format!("{unsafe_commit}:.env")]),
                    String::from_utf8_lossy(synthetic).trim()
                );
                fs::write(
                    root.join("retained-history-reproduction.json"),
                    serde_json::to_vec_pretty(&json!({
                        "synthetic_only": true,
                        "original_head": original,
                        "excluded_commit": unsafe_commit,
                        "exported_head": exported.head_commit,
                        "excluded_blob_reachable_from_exported_bundle": true,
                    }))
                    .unwrap(),
                )
                .unwrap();
                panic!(
                    "checkpoint exported a deleted excluded file through retained history; native fixture preserved at {}",
                    root.display()
                );
            }
        }
        // Preserve the native source/history, including the failing implementation's bundle.
        println!("retained-history regression fixture: {}", root.display());
    }

    #[tokio::test]
    async fn archive_is_deterministic_and_includes_tracked_and_untracked_source() {
        let (root, lease, report) = fixture();
        fs::write(root.join("tracked.txt"), b"after\n").expect("modify tracked");
        fs::write(root.join("new.txt"), b"new\n").expect("write untracked");
        fs::write(root.join("provider.md"), b"provider\n").expect("write provider");
        fs::write(root.join(".git/info/exclude"), b"ignored.log\n")
            .expect("exclude ignored source");
        fs::write(root.join("ignored.log"), b"ignored source\n").expect("write ignored source");
        let provider = AdapterArtifact {
            path: root.join("provider.md"),
            sha256: hex::encode(Sha256::digest(b"provider\n")),
            bytes: 9,
            media_type: "text/markdown".to_owned(),
        };
        let spec = DeliverableSpec {
            form: DeliverableForm::Archive,
            commit_after_verification: false,
            paths: Vec::new(),
        };
        let first = export(
            Uuid::new_v4(),
            &spec,
            &lease,
            &report,
            std::slice::from_ref(&provider),
            &["**".to_owned()],
            None,
        )
        .await
        .expect("first export");
        let second = export(
            Uuid::new_v4(),
            &spec,
            &lease,
            &report,
            &[provider],
            &["**".to_owned()],
            None,
        )
        .await
        .expect("second export");
        assert_eq!(first.bytes, second.bytes);
        let document: Value = serde_json::from_slice(&first.bytes).expect("parse archive");
        let paths = document["changes"]
            .as_array()
            .expect("changes")
            .iter()
            .filter_map(|change| change["path"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["new.txt", "tracked.txt"]);
        assert_eq!(
            fs::read(root.join("ignored.log")).unwrap(),
            b"ignored source\n"
        );
        assert_eq!(
            document["verification_sha256"].as_str(),
            Some(first.verification_sha256.as_str())
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn scoped_archive_preserves_staged_and_unselected_source_exactly() {
        let (root, lease, report) = fixture();
        fs::write(root.join("tracked.txt"), b"selected staged\n").unwrap();
        fs::write(root.join("other.txt"), b"unselected staged\n").unwrap();
        git(&root, &["add", "tracked.txt", "other.txt"]);
        fs::write(root.join("tracked.txt"), b"selected physical bytes\n").unwrap();
        fs::write(root.join("other.txt"), b"unselected physical bytes\n").unwrap();
        fs::write(root.join("unselected.txt"), b"untracked source\n").unwrap();
        fs::write(root.join(".gitignore"), b"*.log\n").unwrap();
        fs::write(root.join("ignored.log"), b"ignored source\n").unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        let fingerprint = crate::workspace::fingerprint_path(&root).await.unwrap();
        let paths = ["tracked.txt", "other.txt", "unselected.txt", "ignored.log"];
        let modified = paths.map(|path| fs::metadata(root.join(path)).unwrap().modified().unwrap());
        let spec = DeliverableSpec {
            form: DeliverableForm::Archive,
            commit_after_verification: false,
            paths: vec!["tracked.txt".to_owned()],
        };
        let first = export(
            Uuid::new_v4(),
            &spec,
            &lease,
            &report,
            &[],
            &["tracked.txt".to_owned()],
            None,
        )
        .await
        .expect("scoped archive");
        let second = export(
            Uuid::new_v4(),
            &spec,
            &lease,
            &report,
            &[],
            &["tracked.txt".to_owned()],
            None,
        )
        .await
        .expect("repeat scoped archive");
        assert_eq!(first.bytes, second.bytes);
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert_eq!(
            crate::workspace::fingerprint_path(&root).await.unwrap(),
            fingerprint
        );
        assert_eq!(
            paths.map(|path| fs::metadata(root.join(path)).unwrap().modified().unwrap()),
            modified
        );
        assert_eq!(git(&root, &["show", ":tracked.txt"]), "selected staged");
        assert_eq!(git(&root, &["show", ":other.txt"]), "unselected staged");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), lease.base_commit);
        assert_eq!(first.base_commit, lease.base_commit);
        assert!(first.head_commit.is_none());
        let document: Value = serde_json::from_slice(&first.bytes).unwrap();
        let changes = document["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["path"], "tracked.txt");
        assert_eq!(
            BASE64
                .decode(changes[0]["content_base64"].as_str().unwrap())
                .unwrap(),
            b"selected physical bytes\n"
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn secret_like_paths_are_rejected_before_export() {
        let (root, lease, report) = fixture();
        fs::write(root.join(".env"), b"TOKEN=secret\n").expect("write secret");
        let error = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::Patch,
                commit_after_verification: false,
                paths: Vec::new(),
            },
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            None,
        )
        .await
        .expect_err("secret-like path must fail");
        assert!(error.to_string().contains("secret-like"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn nested_secret_directories_are_rejected_before_export() {
        let (root, lease, report) = fixture();
        let credential_dir = root.join("services").join("api").join(".azure");
        fs::create_dir_all(&credential_dir).expect("create nested credential directory");
        fs::write(
            credential_dir.join("accessTokens.json"),
            b"{\"token\":\"secret\"}\n",
        )
        .expect("write nested credential");
        let error = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::Patch,
                commit_after_verification: false,
                paths: Vec::new(),
            },
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            None,
        )
        .await
        .expect_err("nested secret-like path must fail");
        assert!(error.to_string().contains("secret-like"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn sensitive_directories_match_at_every_depth() {
        assert!(sensitive_path(
            "services/api/.config/gcloud/application_default_credentials.json"
        ));
        assert!(sensitive_path("packages/web/.azure/accessTokens.json"));
        assert!(sensitive_path("nested/.ssh/id_ed25519"));
        assert!(sensitive_path("services/api/.kube/config"));
        assert!(sensitive_path("nested/.docker/config.json"));
        assert!(sensitive_path("services/api/.config/gh/hosts.yml"));
        assert!(sensitive_path(
            "services/api/.config/github-copilot/hosts.json"
        ));
        assert!(sensitive_path("services/api/.config/huggingface/token"));
        assert!(sensitive_path("services/api/.cargo/credentials.toml"));
        assert!(!sensitive_path("services/api/.cargo/config.toml"));
        assert!(sensitive_path("services/api/.config/composer/auth.json"));
        assert!(sensitive_path("services/api/.config/npm/npmrc"));
        assert!(sensitive_path("services/api/.vercel/auth.json"));
        assert!(sensitive_path("nested/.config/rclone/rclone.conf"));
        assert!(sensitive_path("nested/.git-credentials"));
        assert!(!sensitive_path("docs/azure/guide.json"));
    }

    #[tokio::test]
    async fn git_pathspec_magic_is_rejected_before_staging() {
        let (root, lease, report) = fixture();
        fs::write(root.join("tracked.txt"), b"selected\n").expect("modify selected path");
        fs::write(root.join("other.txt"), b"must remain unselected\n")
            .expect("modify unselected path");
        let error = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::Archive,
                commit_after_verification: false,
                paths: vec![":(exclude)tracked.txt".to_owned()],
            },
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            None,
        )
        .await
        .expect_err("Git pathspec magic must fail");
        assert!(error.to_string().contains("stay inside the worktree"));
        assert_eq!(git(&root, &["diff", "--cached", "--name-only"]), "");
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn default_export_rejects_changes_outside_task_write_scope() {
        let (root, lease, report) = fixture();
        fs::create_dir_all(root.join("src")).expect("create scoped directory");
        fs::write(root.join("src").join("allowed.txt"), b"allowed\n").expect("write scoped source");
        fs::write(root.join("outside.txt"), b"outside\n").expect("write outside source");
        let error = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::Archive,
                commit_after_verification: false,
                paths: Vec::new(),
            },
            &lease,
            &report,
            &[],
            &["src/**".to_owned()],
            None,
        )
        .await
        .expect_err("out-of-scope source must fail");
        assert!(
            error
                .to_string()
                .contains("outside the task write scope: outside.txt")
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn commit_form_updates_only_the_isolated_branch_after_verification() {
        let (root, lease, report) = fixture();
        fs::write(root.join("tracked.txt"), b"committed\n").expect("modify tracked");
        fs::write(root.join("new.txt"), b"committed new\n").expect("write untracked");
        fs::write(root.join("provider.md"), b"provider\n").expect("write provider");
        let provider = AdapterArtifact {
            path: root.join("provider.md"),
            sha256: hex::encode(Sha256::digest(b"provider\n")),
            bytes: 9,
            media_type: "text/markdown".to_owned(),
        };
        let exported = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::CommitBranch,
                commit_after_verification: true,
                paths: Vec::new(),
            },
            &lease,
            &report,
            &[provider],
            &["**".to_owned()],
            None,
        )
        .await
        .expect("commit export");
        let head = git(&root, &["rev-parse", "HEAD"]);
        assert_eq!(exported.head_commit.as_deref(), Some(head.as_str()));
        assert!(
            git(&root, &["show", "--format=%B", "--no-patch", "HEAD"])
                .contains(&exported.verification_sha256)
        );
        assert!(git(&root, &["show", "--format=", "--name-only", "HEAD"]).contains("new.txt"));
        assert!(exported.publication_ready);
        let document: Value =
            serde_json::from_slice(&exported.bytes).expect("parse commit/branch deliverable");
        let bundle = BASE64
            .decode(
                document["git_bundle_base64"]
                    .as_str()
                    .expect("bundle base64"),
            )
            .expect("decode bundle");
        let bundle_sha256 = hex::encode(Sha256::digest(&bundle));
        assert_eq!(
            document["git_bundle_sha256"].as_str(),
            Some(bundle_sha256.as_str())
        );
        let bundle_path = root.join("published.bundle");
        fs::write(&bundle_path, bundle).expect("write bundle");
        let listed = git(&root, &["bundle", "list-heads", "published.bundle"]);
        assert!(listed.starts_with(&head));
        assert!(listed.contains("refs/ecorp/deliverables/"));
        fs::remove_file(bundle_path).expect("remove bundle");
        assert_eq!(git(&root, &["status", "--porcelain=v1"]), "?? provider.md");
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn verifier_only_export_preserves_the_existing_head_commit() {
        let (root, lease, report) = fixture();
        fs::write(root.join("tracked.txt"), b"verified once\n").expect("modify tracked");
        let spec = DeliverableSpec {
            form: DeliverableForm::CommitBranch,
            commit_after_verification: true,
            paths: vec!["tracked.txt".to_owned()],
        };
        let first = export(
            Uuid::new_v4(),
            &spec,
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            None,
        )
        .await
        .expect("initial committed export");
        let head = first.head_commit.expect("initial head commit");
        fs::write(root.join("tracked.txt"), b"selected staged only\n").unwrap();
        fs::write(root.join("other.txt"), b"unselected staged only\n").unwrap();
        git(&root, &["add", "tracked.txt", "other.txt"]);
        fs::write(root.join("tracked.txt"), b"verified once\n").unwrap();
        fs::write(root.join("other.txt"), b"unselected physical bytes\n").unwrap();
        fs::write(root.join("unselected.txt"), b"untracked source\n").unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        let fingerprint = crate::workspace::fingerprint_path(&root).await.unwrap();
        let second = export(
            Uuid::new_v4(),
            &spec,
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            Some(&head),
        )
        .await
        .expect("verifier-only committed export");
        assert_eq!(second.head_commit.as_deref(), Some(head.as_str()));
        assert_eq!(second.base_commit, lease.base_commit);
        assert_eq!(git(&root, &["rev-parse", "HEAD^"]), lease.base_commit);
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert_eq!(
            crate::workspace::fingerprint_path(&root).await.unwrap(),
            fingerprint
        );
        let wrong_head = export(
            Uuid::new_v4(),
            &spec,
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            Some(&lease.base_commit),
        )
        .await
        .expect_err("a different verification-linked head must fail");
        assert!(wrong_head.to_string().contains("expected head"));
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert_eq!(
            crate::workspace::fingerprint_path(&root).await.unwrap(),
            fingerprint
        );
        fs::write(root.join("tracked.txt"), b"changed after checkpoint\n")
            .expect("mutate checkpoint");
        let changed_fingerprint = crate::workspace::fingerprint_path(&root).await.unwrap();
        let mismatch = export(
            Uuid::new_v4(),
            &spec,
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            Some(&head),
        )
        .await
        .expect_err("changed verifier-only tree must fail");
        assert!(mismatch.to_string().contains("tree changed"));
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert_eq!(
            crate::workspace::fingerprint_path(&root).await.unwrap(),
            changed_fingerprint
        );
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn export_binds_executable_mode_even_when_git_filemode_is_disabled() {
        use std::os::unix::fs::PermissionsExt;

        let (root, lease, report) = fixture();
        git(&root, &["config", "core.filemode", "false"]);
        fs::set_permissions(root.join("tracked.txt"), fs::Permissions::from_mode(0o755)).unwrap();
        let spec = DeliverableSpec {
            form: DeliverableForm::CommitBranch,
            commit_after_verification: true,
            paths: vec!["tracked.txt".to_owned()],
        };
        let first = export(
            Uuid::new_v4(),
            &spec,
            &lease,
            &report,
            &[],
            &["tracked.txt".to_owned()],
            None,
        )
        .await
        .expect("commit physical executable mode");
        let head = first.head_commit.unwrap();
        assert_eq!(first.base_commit, lease.base_commit);
        assert!(git(&root, &["ls-tree", &head, "--", "tracked.txt"]).starts_with("100755 "));
        assert_eq!(git(&root, &["config", "core.filemode"]), "false");
        let fingerprint = crate::workspace::fingerprint_path(&root).await.unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        let bytes = fs::read(root.join("tracked.txt")).unwrap();
        fs::set_permissions(root.join("tracked.txt"), fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(fs::read(root.join("tracked.txt")).unwrap(), bytes);
        let changed_fingerprint = crate::workspace::fingerprint_path(&root).await.unwrap();
        assert_ne!(changed_fingerprint, fingerprint);
        let error = export(
            Uuid::new_v4(),
            &spec,
            &lease,
            &report,
            &[],
            &["tracked.txt".to_owned()],
            Some(&head),
        )
        .await
        .expect_err("physical executable-mode drift must reject a preserved head");
        assert!(error.to_string().contains("tree changed"));
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert_eq!(git(&root, &["config", "core.filemode"]), "false");
        assert_eq!(
            crate::workspace::fingerprint_path(&root).await.unwrap(),
            changed_fingerprint
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn verifier_only_export_preserves_post_base_git_modes_and_readonly_source() {
        let (root, lease, report) = fixture();
        git(&root, &["config", "core.filemode", "false"]);
        git(&root, &["update-index", "--chmod=+x", "--", "tracked.txt"]);
        git(&root, &["commit", "-m", "verified executable mode"]);
        let head = git(&root, &["rev-parse", "HEAD"]);
        assert!(git(&root, &["ls-tree", &head, "--", "tracked.txt"]).starts_with("100755 "));
        assert!(
            git(&root, &["ls-tree", &lease.base_commit, "--", "tracked.txt"])
                .starts_with("100644 ")
        );
        git(&root, &["config", "core.filemode", "true"]);
        let original_permissions = fs::metadata(root.join("tracked.txt"))
            .unwrap()
            .permissions();
        let mut readonly = original_permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(root.join("tracked.txt"), readonly).unwrap();
        fs::write(root.join("other.txt"), b"unselected staged\n").unwrap();
        git(&root, &["add", "other.txt"]);
        fs::write(root.join("other.txt"), b"unselected physical\n").unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        let fingerprint = crate::workspace::fingerprint_path(&root).await.unwrap();
        let exported = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::CommitBranch,
                commit_after_verification: true,
                paths: vec!["tracked.txt".to_owned()],
            },
            &lease,
            &report,
            &[],
            &["tracked.txt".to_owned()],
            Some(&head),
        )
        .await
        .expect("preserve committed executable bit without inferring it from Windows permissions");
        assert_eq!(exported.base_commit, lease.base_commit);
        assert_eq!(exported.head_commit.as_deref(), Some(head.as_str()));
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&root, &["config", "core.filemode"]), "true");
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert_eq!(
            crate::workspace::fingerprint_path(&root).await.unwrap(),
            fingerprint
        );
        assert!(
            fs::metadata(root.join("tracked.txt"))
                .unwrap()
                .permissions()
                .readonly()
        );
        let document: Value = serde_json::from_slice(&exported.bytes).unwrap();
        let changes = document["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["path"], "tracked.txt");
        assert_eq!(changes[0]["mode"], "100755");
        fs::set_permissions(root.join("tracked.txt"), original_permissions).unwrap();
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn verifier_only_export_rejects_unselected_preserved_head_changes() {
        let (root, lease, report) = fixture();
        fs::write(root.join("tracked.txt"), b"selected committed\n").unwrap();
        fs::write(root.join("other.txt"), b"unselected committed\n").unwrap();
        git(&root, &["add", "tracked.txt", "other.txt"]);
        git(
            &root,
            &["commit", "-m", "head contains an unselected change"],
        );
        let head = git(&root, &["rev-parse", "HEAD"]);
        let index = fs::read(root.join(".git/index")).unwrap();
        let fingerprint = crate::workspace::fingerprint_path(&root).await.unwrap();
        let error = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::CommitBranch,
                commit_after_verification: true,
                paths: vec!["tracked.txt".to_owned()],
            },
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            Some(&head),
        )
        .await
        .expect_err("preserving a head must not widen the selected export");
        assert!(error.to_string().contains("tree changed"));
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert_eq!(
            crate::workspace::fingerprint_path(&root).await.unwrap(),
            fingerprint
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn commit_form_bundles_validated_branch_when_head_is_detached() {
        let (root, lease, report) = fixture();
        git(&root, &["checkout", "--detach", &lease.base_commit]);
        fs::write(root.join("tracked.txt"), b"detached commit\n").expect("modify tracked");

        let exported = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::CommitBranch,
                commit_after_verification: true,
                paths: Vec::new(),
            },
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            None,
        )
        .await
        .expect("detached commit export");

        assert_eq!(git(&root, &["rev-parse", "HEAD"]), lease.base_commit);
        let head_commit = exported.head_commit.expect("committed branch head");
        assert_ne!(head_commit, lease.base_commit);
        let document: Value =
            serde_json::from_slice(&exported.bytes).expect("parse commit/branch deliverable");
        let bundle = BASE64
            .decode(
                document["git_bundle_base64"]
                    .as_str()
                    .expect("bundle base64"),
            )
            .expect("decode bundle");
        let bundle_path = root.join("detached.bundle");
        fs::write(&bundle_path, bundle).expect("write bundle");
        let listed = git(&root, &["bundle", "list-heads", "detached.bundle"]);
        assert!(listed.starts_with(&head_commit));
        assert!(listed.contains("refs/ecorp/deliverables/"));
        assert_eq!(
            git(
                &root,
                &[
                    "for-each-ref",
                    "--format=%(refname)",
                    "refs/ecorp/deliverables"
                ]
            ),
            ""
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn scoped_commit_preserves_unselected_staged_work() {
        let (root, lease, report) = fixture();
        fs::write(root.join("tracked.txt"), b"selected\n").expect("modify selected");
        fs::write(root.join("other.txt"), b"other staged\n").expect("modify other");
        git(&root, &["add", "other.txt"]);
        fs::write(root.join("other.txt"), b"other unstaged\n").expect("modify unselected source");
        let staged_other = git(&root, &["ls-files", "--stage", "--", "other.txt"]);
        let fingerprint = crate::workspace::fingerprint_path(&root).await.unwrap();
        let exported = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::CommitBranch,
                commit_after_verification: true,
                paths: vec!["tracked.txt".to_owned()],
            },
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            None,
        )
        .await
        .expect("scoped commit export");
        assert!(exported.head_commit.is_some());
        assert_eq!(
            git(&root, &["diff", "--cached", "--name-only"]),
            "other.txt"
        );
        assert_eq!(
            git(&root, &["show", "--format=", "--name-only", "HEAD"]),
            "tracked.txt"
        );
        assert_eq!(
            git(&root, &["ls-files", "--stage", "--", "other.txt"]),
            staged_other
        );
        assert_eq!(
            crate::workspace::fingerprint_path(&root).await.unwrap(),
            fingerprint
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn scoped_commit_reset_treats_selected_paths_literally() {
        let (root, lease, report) = fixture();
        fs::write(root.join("foo[bar]"), b"before selected\n").expect("write selected base");
        fs::write(root.join("foob"), b"before staged\n").expect("write staged base");
        git(&root, &["add", "foo[bar]", "foob"]);
        git(&root, &["commit", "-m", "add wildcard-shaped paths"]);

        fs::write(root.join("foo[bar]"), b"after selected\n").expect("modify selected path");
        fs::write(root.join("foob"), b"after staged\n").expect("modify staged path");
        git(&root, &["add", "foob"]);

        export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::CommitBranch,
                commit_after_verification: true,
                paths: vec!["foo[bar]".to_owned()],
            },
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            None,
        )
        .await
        .expect("literal scoped commit export");

        assert_eq!(git(&root, &["diff", "--cached", "--name-only"]), "foob");
        assert_eq!(
            git(&root, &["show", "--format=", "--name-only", "HEAD"]),
            "foo[bar]"
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[tokio::test]
    async fn scoped_commit_excludes_unselected_committed_changes() {
        let (root, lease, report) = fixture();
        fs::write(
            root.join("other.txt"),
            b"agent committed outside selection\n",
        )
        .expect("modify unselected path");
        git(&root, &["add", "other.txt"]);
        git(&root, &["commit", "-m", "agent commit outside selection"]);
        let agent_head = git(&root, &["rev-parse", "HEAD"]);
        fs::write(root.join("tracked.txt"), b"selected\n").expect("modify selected path");

        let exported = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::CommitBranch,
                commit_after_verification: true,
                paths: vec!["tracked.txt".to_owned()],
            },
            &lease,
            &report,
            &[],
            &["tracked.txt".to_owned()],
            None,
        )
        .await
        .expect("scoped commit export");

        let head = git(&root, &["rev-parse", "HEAD"]);
        assert_eq!(exported.head_commit.as_deref(), Some(head.as_str()));
        assert_ne!(head, agent_head);
        assert_eq!(
            git(&root, &["rev-list", "--parents", "-n", "1", "HEAD"]),
            format!("{head} {}", lease.base_commit)
        );
        assert_eq!(
            git(
                &root,
                &[
                    "diff",
                    "--name-only",
                    &format!("{}..HEAD", lease.base_commit)
                ]
            ),
            "tracked.txt"
        );
        assert_eq!(
            git(&root, &["diff", "--cached", "--name-only"]),
            "other.txt"
        );
        assert_eq!(
            fs::read_to_string(root.join("other.txt")).expect("read preserved path"),
            "agent committed outside selection\n"
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symbolic_links_are_rejected_before_content_export() {
        use std::os::unix::fs::symlink;

        let (root, lease, report) = fixture();
        let outside = root
            .parent()
            .expect("fixture parent")
            .join(format!("outside-{}", Uuid::new_v4()));
        fs::write(&outside, b"outside\n").expect("write outside target");
        symlink(&outside, root.join("escape-link")).expect("create symlink");
        let error = export(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::Archive,
                commit_after_verification: false,
                paths: Vec::new(),
            },
            &lease,
            &report,
            &[],
            &["**".to_owned()],
            None,
        )
        .await
        .expect_err("symlink must fail");
        assert!(error.to_string().contains("symbolic link"));
        fs::remove_dir_all(root).expect("remove fixture");
        fs::remove_file(outside).expect("remove outside target");
    }
}
