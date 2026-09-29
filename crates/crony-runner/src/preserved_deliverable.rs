//! Read retained native source through the existing exporter. Never change the
//! real index, branch, worktree bytes or source selection to obtain this proof.

use std::collections::BTreeSet;

use super::*;
use crony_domain::MAX_PRESERVED_DELIVERABLE_PATHS;

pub(crate) struct PreservedDelta {
    pub changed_paths: Vec<String>,
    pub index_sha256: String,
}

pub(crate) async fn index_sha256(workspace: &Path) -> Result<String> {
    let entries = git_output_with_index(
        workspace,
        None,
        &[
            "ls-files".into(),
            "--stage".into(),
            "-z".into(),
            "--".into(),
        ],
    )
    .await?;
    Ok(hex::encode(Sha256::digest(entries.stdout)))
}

pub(crate) async fn staged_artifact_matches(
    workspace: &WorkspaceLease,
    relative: &str,
    artifact: &AdapterArtifact,
) -> Result<bool> {
    let changed = git_output_with_index(
        &workspace.path,
        None,
        &[
            "diff".into(),
            "--cached".into(),
            "--name-only".into(),
            "-z".into(),
            "--no-renames".into(),
            workspace.base_commit.clone().into(),
            "--".into(),
            relative.into(),
        ],
    )
    .await?;
    if changed.stdout.is_empty() {
        return Ok(true);
    }
    let entries = git_output_with_index(
        &workspace.path,
        None,
        &[
            "ls-files".into(),
            "--stage".into(),
            "-z".into(),
            "--".into(),
            relative.into(),
        ],
    )
    .await?;
    let entries = std::str::from_utf8(&entries.stdout)?;
    let entries = entries
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    if entries.len() != 1 {
        return Ok(false);
    }
    let Some((metadata, path)) = entries[0].split_once('\t') else {
        return Ok(false);
    };
    let metadata = metadata.split_whitespace().collect::<Vec<_>>();
    if path != relative
        || metadata.len() != 3
        || metadata[2] != "0"
        || !matches!(metadata[0], "100644" | "100755")
    {
        return Ok(false);
    }
    let size = git_output_with_index(
        &workspace.path,
        None,
        &["cat-file".into(), "-s".into(), metadata[1].into()],
    )
    .await?;
    if std::str::from_utf8(&size.stdout)?.trim().parse::<usize>()? != artifact.bytes
        || artifact.bytes > MAX_DELIVERABLE_BYTES
    {
        return Ok(false);
    }
    let blob = git_output_with_index(
        &workspace.path,
        None,
        &["cat-file".into(), "blob".into(), metadata[1].into()],
    )
    .await?;
    Ok(blob.stdout.len() == artifact.bytes
        && hex::encode(Sha256::digest(&blob.stdout)) == artifact.sha256)
}

pub(crate) async fn capture_delta(
    run_id: Uuid,
    workspace: &WorkspaceLease,
) -> Result<PreservedDelta> {
    let index_before = index_sha256(&workspace.path).await?;
    let native_index = git_output_with_index(
        &workspace.path,
        None,
        &[
            "diff".into(),
            "--cached".into(),
            "--name-status".into(),
            "-z".into(),
            "--no-renames".into(),
            workspace.base_commit.clone().into(),
            "--".into(),
        ],
    )
    .await?;
    // A new temporary index reads physical bytes even when the real index marks
    // them assume-unchanged or skip-worktree. The real index separately preserves
    // staged-only paths that Git add from the filesystem would otherwise omit.
    let candidate = prepare_for(
        run_id,
        &DeliverableSpec::default(),
        workspace,
        &[],
        &[],
        None,
        Preparation::Inventory,
    )
    .await?;
    let changed_paths: BTreeSet<String> = candidate
        .changes
        .iter()
        .chain(parse_changed_paths(&native_index.stdout)?.iter())
        .map(|(_, path)| path.clone())
        .collect();
    if changed_paths.len() > MAX_PRESERVED_DELIVERABLE_PATHS {
        return Err(anyhow!(
            "preserved deliverable delta exceeds the complete checkpoint path limit; source remains retained"
        ));
    }
    if index_sha256(&workspace.path).await? != index_before {
        return Err(anyhow!(
            "native index changed during preserved deliverable capture"
        ));
    }
    Ok(PreservedDelta {
        changed_paths: changed_paths.into_iter().collect(),
        index_sha256: index_before,
    })
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fixture, git};
    use super::*;

    #[tokio::test]
    async fn inventory_covers_committed_physical_staged_only_and_untracked_without_mutation() {
        let (root, workspace, _) = fixture();
        std::fs::write(root.join("tracked.txt"), "committed parent\n").unwrap();
        git(&root, &["add", "tracked.txt"]);
        git(&root, &["commit", "-m", "parent source"]);
        std::fs::write(root.join("other.txt"), "hidden physical change\n").unwrap();
        git(&root, &["update-index", "--assume-unchanged", "other.txt"]);
        std::fs::write(root.join("staged-only.txt"), "index-only source\n").unwrap();
        git(&root, &["add", "staged-only.txt"]);
        std::fs::remove_file(root.join("staged-only.txt")).unwrap();
        std::fs::write(root.join("untracked.txt"), "new source\n").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.log\n").unwrap();
        std::fs::write(root.join("ignored.log"), "ignored\n").unwrap();
        let index_before = index_sha256(&root).await.unwrap();
        let head_before = git(&root, &["rev-parse", "HEAD"]);
        let delta = capture_delta(Uuid::new_v4(), &workspace).await.unwrap();
        assert_eq!(
            delta.changed_paths,
            [
                ".gitignore",
                "other.txt",
                "staged-only.txt",
                "tracked.txt",
                "untracked.txt"
            ]
        );
        assert_eq!(delta.index_sha256, index_before);
        assert_eq!(index_sha256(&root).await.unwrap(), index_before);
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            git(&root, &["show", ":staged-only.txt"]),
            "index-only source"
        );
        assert!(!root.join("staged-only.txt").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn preflight_keeps_selection_semantics_and_permits_future_output_paths() {
        let (root, workspace, _) = fixture();
        std::fs::write(root.join("tracked.txt"), "selected source\n").unwrap();
        std::fs::write(root.join(".env"), "unselected=private\n").unwrap();
        let spec = DeliverableSpec {
            paths: vec!["tracked.txt".to_owned(), "future/evidence.md".to_owned()],
            ..Default::default()
        };
        let prepared = prepare_resume(
            Uuid::new_v4(),
            &spec,
            &workspace,
            &[],
            &["tracked.txt".to_owned(), "future/**".to_owned()],
        )
        .await
        .unwrap();
        assert_eq!(
            prepared.changes,
            vec![("M".to_owned(), "tracked.txt".to_owned())]
        );
        drop(prepared);
        assert!(
            prepare_resume(
                Uuid::new_v4(),
                &spec,
                &workspace,
                &[],
                &["future/**".to_owned()]
            )
            .await
            .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
