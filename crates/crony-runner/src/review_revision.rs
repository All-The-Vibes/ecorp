//! Restore immutable publication bytes, then use ordinary native execution/resume.
//! This adapter grants no additional tools, permissions, sessions or write scope.
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result, bail, ensure};
use crony_protocol::ReviewRevisionSource;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::{
    Assignment,
    deliverable::verification::{materialize_tree, transfer_objects},
    publication_source::{PublishedSource, git, object_id, source_bundle},
    workspace::{WorkspaceLease, WorkspaceManager, normalize_path, snapshot_entry_is_link},
};

pub(crate) struct Seeded {
    pub manager: Arc<WorkspaceManager>,
    pub workspace: WorkspaceLease,
}

fn lineage(assignment: &Assignment, source: &ReviewRevisionSource) -> Value {
    json!({
        "schema_version": 1,
        "corp_id": assignment.corp_id, "task_id": assignment.task_id,
        "workspace_run_id": assignment.workspace_run_id,
        "revision_id": source.revision_id, "publication_id": source.publication_id,
        "source_run_id": source.source_run_id, "source_deliverable_id": source.source_deliverable_id,
        "repository": assignment.source_repository, "base_ref": assignment.source_base_ref,
        "base_commit": source.original_base_commit, "published_head": source.source_head_commit,
        "source_branch": source.source_branch, "artifact_sha256": source.artifact.sha256,
        "verification_sha256": source.verification_sha256, "git_bundle_sha256": source.git_bundle_sha256,
    })
}

/// Require existing, ordinary components before any Git or WorkspaceManager
/// initialization can canonicalize or create paths in a resumed workspace.
async fn existing_path(root: &Path, path: &Path, directory: bool) -> Result<PathBuf> {
    let relative = path
        .strip_prefix(root)
        .context("correction path escaped owned root")?;
    let mut cursor = root.to_owned();
    for component in relative.components() {
        ensure!(
            matches!(component, std::path::Component::Normal(_)),
            "invalid correction path"
        );
        cursor.push(component);
        let metadata = tokio::fs::symlink_metadata(&cursor)
            .await
            .context("preserved correction path is missing")?;
        ensure!(
            !snapshot_entry_is_link(&metadata),
            "correction path contains a link or reparse point"
        );
    }
    let metadata = tokio::fs::symlink_metadata(path).await?;
    ensure!(
        if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        },
        "correction path changed type"
    );
    let canonical = normalize_path(tokio::fs::canonicalize(path).await?);
    ensure!(
        canonical.starts_with(root),
        "correction path escaped owned root"
    );
    Ok(canonical)
}

async fn existing_private_git(root: &Path, repo: &Path, workspace: &Path) -> Result<()> {
    let git_dir = existing_path(root, &repo.join(".git"), true).await?;
    let pointer = bounded_metadata(root, &workspace.join(".git"), 8192).await?;
    let target = pointer
        .trim()
        .strip_prefix("gitdir: ")
        .context("correction worktree has no native Git registration")?;
    ensure!(
        !target.chars().any(char::is_control),
        "invalid correction Git registration"
    );
    let target = workspace.join(target);
    let admin = existing_path(&git_dir, &target, true).await?;
    ensure!(
        admin.parent() == Some(git_dir.join("worktrees").as_path()),
        "correction worktree registration escaped native worktrees"
    );
    // Object stores, hooks, config and native worktree registration must not route
    // a later write into another checkout. Walk metadata only; never source links.
    let mut pending = vec![git_dir.clone()];
    let mut count = 0_u32;
    while let Some(directory) = pending.pop() {
        let mut entries = tokio::fs::read_dir(directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            count += 1;
            ensure!(
                count <= 100_000,
                "correction Git metadata exceeds inspection bounds"
            );
            let metadata = tokio::fs::symlink_metadata(entry.path()).await?;
            ensure!(
                !snapshot_entry_is_link(&metadata) && (metadata.is_dir() || metadata.is_file()),
                "correction Git metadata must contain only ordinary files and directories"
            );
            if metadata.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    ensure!(
        !tokio::fs::try_exists(git_dir.join("objects/info/alternates")).await?
            && !tokio::fs::try_exists(git_dir.join("objects/info/http-alternates")).await?,
        "correction object store must remain independent"
    );
    if tokio::fs::try_exists(git_dir.join("hooks")).await? {
        ensure!(
            tokio::fs::read_dir(git_dir.join("hooks"))
                .await?
                .next_entry()
                .await?
                .is_none(),
            "correction Git hooks changed"
        );
    }
    // Inspect all routing/configuration files before Git interprets them. Use a
    // bounded reader as well as metadata lengths, so a growing file cannot turn
    // a resumed correction into an unbounded read.
    let config_path = git_dir.join("config");
    bounded_metadata(root, &config_path, 65_536).await?;
    bounded_metadata(root, &git_dir.join("HEAD"), 8192).await?;
    bounded_metadata(root, &admin.join("HEAD"), 8192).await?;
    ensure!(
        bounded_metadata(root, &admin.join("commondir"), 8192)
            .await?
            .trim()
            == "../..",
        "correction worktree changed its native common directory"
    );
    let registered = bounded_metadata(root, &admin.join("gitdir"), 8192).await?;
    ensure!(
        tokio::fs::canonicalize(registered.trim()).await?
            == tokio::fs::canonicalize(workspace.join(".git")).await?,
        "correction worktree registration changed"
    );
    let config = git(
        repo,
        &[
            "config",
            "--file",
            config_path
                .to_str()
                .context("private Git path is not UTF-8")?,
            "--no-includes",
            "--list",
            "--null",
        ],
    )
    .await?;
    for entry in config.split('\0').filter(|entry| !entry.is_empty()) {
        let (key, value) = entry
            .split_once('\n')
            .context("invalid private Git configuration")?;
        ensure!(
            matches!(
                (key, value),
                ("core.repositoryformatversion", "0" | "1")
                    | ("core.filemode", "true" | "false")
                    | ("core.bare", "false")
                    | ("core.logallrefupdates", "true")
                    | ("core.ignorecase", "true" | "false")
                    | ("core.symlinks", "true" | "false")
                    | ("extensions.objectformat", "sha256")
            ),
            "correction Git configuration changed"
        );
    }
    let common = git(
        workspace,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await?;
    ensure!(
        normalize_path(tokio::fs::canonicalize(common).await?) == git_dir,
        "correction worktree changed object store"
    );
    let native_admin = normalize_path(PathBuf::from(
        git(workspace, &["rev-parse", "--absolute-git-dir"]).await?,
    ));
    ensure!(
        existing_path(&git_dir, &native_admin, true).await? == admin,
        "Git resolved a different correction registration"
    );
    Ok(())
}

async fn bounded_metadata(root: &Path, path: &Path, limit: u64) -> Result<String> {
    existing_path(root, path, false).await?;
    let file = tokio::fs::File::open(path).await?;
    ensure!(
        file.metadata().await?.len() <= limit,
        "correction Git metadata exceeds size bound"
    );
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).await?;
    ensure!(
        bytes.len() as u64 <= limit,
        "correction Git metadata exceeds size bound"
    );
    String::from_utf8(bytes).context("correction Git metadata is not UTF-8")
}

pub(crate) async fn reconstruct(
    source_manager: &WorkspaceManager,
    assignment: &Assignment,
    source: &ReviewRevisionSource,
    resume: bool,
) -> Result<Seeded> {
    source_manager.verify_source_identity(
        assignment.source_repository.as_deref(),
        assignment.source_base_ref.as_deref(),
        assignment.source_base_commit.as_deref(),
    )?;
    object_id(&source.original_base_commit)?;
    object_id(&source.source_head_commit)?;
    ensure!(
        assignment.source_repository.is_some()
            && assignment.source_base_commit.as_deref()
                == Some(source.original_base_commit.as_str())
            && source.source_head_commit.len() == source.original_base_commit.len()
            && assignment.base_refresh.is_none()
            && !assignment.checkpoint_verification
            && assignment.retained_provider_receipt.is_none()
            && assignment.provider_artifact.is_none()
            && assignment.verification_command_id.is_none(),
        "correction seed does not match native assignment"
    );
    ensure!(
        if resume {
            assignment.workspace_run_id != assignment.run_id
                && assignment.resume_workspace_base_commit.as_deref()
                    == Some(source.original_base_commit.as_str())
                && assignment.expected_workspace_fingerprint.is_some()
                && assignment.expected_head_commit.is_some()
        } else {
            assignment.workspace_run_id == assignment.run_id
                && assignment.resume_workspace_base_commit.is_none()
                && assignment.expected_workspace_fingerprint.is_none()
                && assignment.expected_head_commit.is_none()
        },
        "correction fresh/resume authority is incomplete"
    );
    let (bundle, tree) = source_bundle(PublishedSource {
        artifact: &source.artifact,
        base_commit: &source.original_base_commit,
        head_commit: &source.source_head_commit,
        branch: &source.source_branch,
        verification_sha256: &source.verification_sha256,
        git_bundle_sha256: &source.git_bundle_sha256,
    })?;
    let owned = source_manager
        .root()
        .join(format!("review-revision-{}", assignment.workspace_run_id));
    let repo = owned.join("objects");
    let marker = owned.join("lineage.json");
    let expected_lineage = lineage(assignment, source);
    if resume {
        existing_path(source_manager.root(), &owned, true).await?;
        existing_path(source_manager.root(), &repo, true).await?;
        ensure!(
            serde_json::from_str::<Value>(
                &bounded_metadata(source_manager.root(), &marker, 8192).await?
            )? == expected_lineage,
            "correction seed lineage changed"
        );
        let path = owned
            .join("worktrees")
            .join(assignment.task_id.simple().to_string())
            .join(assignment.workspace_run_id.simple().to_string());
        existing_path(source_manager.root(), &path, true).await?;
        existing_private_git(source_manager.root(), &repo, &path).await?;
    } else {
        tokio::fs::create_dir(&owned)
            .await
            .context("create fresh correction root; preserve existing work")?;
        tokio::fs::create_dir(&repo).await?;
        git(
            &repo,
            &[
                "init",
                "--quiet",
                "--template=",
                if source.original_base_commit.len() == 64 {
                    "--object-format=sha256"
                } else {
                    "--object-format=sha1"
                },
            ],
        )
        .await?;
        transfer_objects(
            source_manager.repository(),
            &repo,
            &source.original_base_commit,
            &source.original_base_commit,
        )
        .await?;
        tokio::fs::write(
            repo.join(".git/shallow"),
            format!("{}\n", source.original_base_commit),
        )
        .await?;
        let bundle_path = owned.join("source.bundle");
        tokio::fs::write(&bundle_path, bundle).await?;
        let bundle_path = bundle_path
            .to_str()
            .context("correction bundle path is not UTF-8")?;
        git(&repo, &["bundle", "verify", bundle_path]).await?;
        let heads = git(&repo, &["bundle", "list-heads", bundle_path]).await?;
        ensure!(
            heads.lines().count() == 1
                && heads.split_whitespace().next() == Some(source.source_head_commit.as_str()),
            "correction bundle must advertise the exact single published head"
        );
        git(&repo, &["bundle", "unbundle", bundle_path]).await?;
    }
    git(
        &repo,
        &[
            "merge-base",
            "--is-ancestor",
            &source.original_base_commit,
            &source.source_head_commit,
        ],
    )
    .await?;
    ensure!(
        git(
            &repo,
            &[
                "rev-parse",
                &format!("{}^{{tree}}", source.source_head_commit)
            ]
        )
        .await?
            == tree,
        "published seed tree does not match persisted verification"
    );
    let manager = Arc::new(
        source_manager
            .private_copy(
                owned.clone(),
                repo.clone(),
                source.original_base_commit.clone(),
            )
            .await?,
    );
    let workspace = if resume {
        manager
            .prepare(
                assignment.task_id,
                assignment.workspace_run_id,
                Some(&source.original_base_commit),
                Some(&source.original_base_commit),
            )
            .await?
    } else {
        let workspace = manager
            .prepare_empty(assignment.task_id, assignment.workspace_run_id)
            .await?;
        git(
            &workspace.path,
            &[
                "update-ref",
                &format!("refs/heads/{}", workspace.branch),
                &source.source_head_commit,
                &source.original_base_commit,
            ],
        )
        .await?;
        materialize_tree(&repo, &workspace.path, &tree).await?;
        git(&workspace.path, &["read-tree", &tree]).await?;
        tokio::fs::write(&marker, serde_json::to_vec_pretty(&expected_lineage)?).await?;
        workspace
    };
    let (head, fingerprint) = manager.checkpoint(&workspace).await?;
    if resume
        && (assignment.expected_head_commit.as_deref() != Some(head.as_str())
            || assignment.expected_workspace_fingerprint.as_deref() != Some(fingerprint.as_str()))
    {
        bail!("correction resume checkpoint changed; preserve work for inspection");
    }
    git(
        &workspace.path,
        &[
            "merge-base",
            "--is-ancestor",
            &source.source_head_commit,
            &head,
        ],
    )
    .await
    .context("correction no longer descends from published head")?;
    Ok(Seeded { manager, workspace })
}

#[cfg(test)]
#[path = "review_revision_tests.rs"]
mod tests;
