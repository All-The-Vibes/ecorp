//! Reconstruct an authorized publication delta using native Git only.
//! The server chooses immutable source IDs; this path starts no provider session.

use std::{path::Path, sync::Arc};

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use crony_protocol::BaseRefreshSource;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    Assignment, decode_verification_artifact,
    deliverable::verification::{materialize_tree, private_git, transfer_objects},
    workspace::{WorkspaceLease, WorkspaceManager},
};

pub(crate) struct Reconstructed {
    pub manager: Arc<WorkspaceManager>,
    pub workspace: WorkspaceLease,
    pub tree: String,
}

fn object_id(value: &str) -> Result<()> {
    if !matches!(value.len(), 40 | 64)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        bail!("refresh requires a full lowercase immutable Git object ID");
    }
    Ok(())
}

fn source_bundle(source: &BaseRefreshSource) -> Result<(Vec<u8>, String)> {
    object_id(&source.old_base_commit)?;
    object_id(&source.source_head_commit)?;
    let bytes = decode_verification_artifact(&source.artifact)?;
    let document: Value = serde_json::from_slice(&bytes).context("decode source deliverable")?;
    if document["schema_version"] != 1 || document["form"] != "commit_branch" {
        bail!("refresh requires a portable commit/branch source deliverable");
    }
    for (field, expected) in [
        ("base_commit", &source.old_base_commit),
        ("head_commit", &source.source_head_commit),
        ("branch", &source.source_branch),
        ("verification_sha256", &source.verification_sha256),
        ("git_bundle_sha256", &source.git_bundle_sha256),
    ] {
        if document[field].as_str() != Some(expected.as_str()) {
            bail!("source deliverable {field} does not match stored refresh authority");
        }
    }
    let tree = document["verified_tree"]
        .as_str()
        .context("source omitted verified tree")?;
    object_id(tree)?;
    let bundle = BASE64
        .decode(
            document["git_bundle_base64"]
                .as_str()
                .context("source deliverable omitted portable bundle")?,
        )
        .context("decode source Git bundle")?;
    if bundle.is_empty() || hex::encode(Sha256::digest(&bundle)) != source.git_bundle_sha256 {
        bail!("source Git bundle digest mismatch");
    }
    Ok((bundle, tree.to_owned()))
}

async fn git(root: &Path, args: &[&str]) -> Result<String> {
    String::from_utf8(
        private_git(
            root,
            &args.iter().map(|arg| (*arg).into()).collect::<Vec<_>>(),
            &[],
        )
        .await?,
    )
    .context("native Git returned non-UTF-8 output")
    .map(|output| output.trim().to_owned())
}

pub(crate) async fn reconstruct(
    source_manager: &WorkspaceManager,
    assignment: &Assignment,
    source: &BaseRefreshSource,
) -> Result<Reconstructed> {
    let repository = assignment
        .source_repository
        .as_deref()
        .context("refresh omitted repository")?;
    let base_ref = assignment
        .source_base_ref
        .as_deref()
        .context("refresh omitted base ref")?;
    let new_base = assignment
        .source_base_commit
        .as_deref()
        .context("refresh omitted new base")?;
    object_id(new_base)?;
    if source_manager
        .repository_identity()
        .is_none_or(|identity| !identity.eq_ignore_ascii_case(repository))
        || source_manager.base_ref() != base_ref
        || source.old_base_commit == new_base
        || source.old_base_commit.len() != new_base.len()
        || source.source_head_commit.len() != new_base.len()
        || assignment.workspace_run_id != assignment.run_id
        || assignment.checkpoint_verification
        || assignment.retained_provider_receipt.is_some()
        || !assignment.secrets.is_empty()
    {
        bail!("refresh source identity or fresh-workspace authority does not match");
    }
    let (bundle, source_tree) = source_bundle(source)?;
    // Source repository is read only: no ref updates, checkout, fetch or reset.
    git(
        source_manager.repository(),
        &[
            "merge-base",
            "--is-ancestor",
            &source.old_base_commit,
            new_base,
        ],
    )
    .await
    .context("new publication base must descend from the original verified base")?;
    let pinned = source_manager.pinned(base_ref, new_base).await?;
    let owned = source_manager
        .root()
        .join(format!("base-refresh-{}", assignment.run_id));
    tokio::fs::create_dir(&owned)
        .await
        .context("create fresh owned refresh directory; existing work must be preserved")?;
    let repo = owned.join("objects");
    tokio::fs::create_dir(&repo).await?;
    git(
        &repo,
        &[
            "init",
            "--quiet",
            "--template=",
            if new_base.len() == 64 {
                "--object-format=sha256"
            } else {
                "--object-format=sha1"
            },
        ],
    )
    .await?;
    transfer_objects(
        pinned.repository(),
        &repo,
        &source.old_base_commit,
        new_base,
    )
    .await?;
    tokio::fs::write(
        repo.join(".git/shallow"),
        format!("{}\n", source.old_base_commit),
    )
    .await?;
    let bundle_path = owned.join("source.bundle");
    tokio::fs::write(&bundle_path, bundle).await?;
    let bundle_name = bundle_path
        .to_str()
        .context("refresh bundle path is not UTF-8")?;
    git(&repo, &["bundle", "verify", bundle_name]).await?;
    let heads = git(&repo, &["bundle", "list-heads", bundle_name]).await?;
    if heads.lines().count() != 1
        || heads.split_whitespace().next() != Some(source.source_head_commit.as_str())
    {
        bail!("portable bundle does not contain the exact single authorized source head");
    }
    git(&repo, &["bundle", "unbundle", bundle_name]).await?;
    git(
        &repo,
        &[
            "merge-base",
            "--is-ancestor",
            &source.old_base_commit,
            &source.source_head_commit,
        ],
    )
    .await?;
    let actual_tree = git(
        &repo,
        &[
            "rev-parse",
            &format!("{}^{{tree}}", source.source_head_commit),
        ],
    )
    .await?;
    if actual_tree != source_tree {
        bail!("source bundle tree does not match its persisted verification");
    }
    // Nonzero (including merge conflicts) fails closed; no conflict auto-resolution.
    let tree = git(
        &repo,
        &[
            "merge-tree",
            "--write-tree",
            &format!("--merge-base={}", source.old_base_commit),
            new_base,
            &source.source_head_commit,
        ],
    )
    .await
    .context("native publication-base merge did not produce a conflict-free tree")?;
    object_id(&tree)?;
    let manager = Arc::new(
        source_manager
            .private_copy(owned.clone(), repo.clone(), new_base.to_owned())
            .await?,
    );
    let workspace = manager
        .prepare_empty(assignment.task_id, assignment.run_id)
        .await?;
    materialize_tree(&repo, &workspace.path, &tree).await?;
    git(&workspace.path, &["read-tree", &tree]).await?;
    tokio::fs::write(
        owned.join("lineage.json"),
        serde_json::to_vec_pretty(&json!({
            "refresh_id": source.refresh_id,
            "source_deliverable_id": source.source_deliverable_id,
            "run_id": assignment.run_id,
            "old_base_commit": source.old_base_commit,
            "new_base_commit": new_base,
            "source_head_commit": source.source_head_commit,
            "candidate_tree": tree,
            "provider_started": false,
        }))?,
    )
    .await?;
    Ok(Reconstructed {
        manager,
        workspace,
        tree,
    })
}

#[cfg(test)]
#[path = "base_refresh_tests.rs"]
mod tests;
