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

    async fn stage_oversized_index(root: &Path) {
        let object = git(root, &["rev-parse", "HEAD:tracked.txt"]);
        let prefix = std::iter::repeat_n("x".repeat(190), 10)
            .collect::<Vec<_>>()
            .join("/");
        let mut input = Vec::new();
        let mut path_bytes = 0;
        let mut path_count = 0;
        // Fewer than the checkpoint path limit, and no additional physical files:
        // both the index listing and cached diff still exceed the byte bound.
        // Native names must be bounded before ECorp validates their path length.
        for number in 0..9_000 {
            let path = format!("retained/{prefix}/{number:04}.txt");
            path_bytes += path.len() + 1;
            path_count += 1;
            input.extend_from_slice(format!("100644 {object}\t{path}\0").as_bytes());
        }
        assert!(path_count < MAX_PRESERVED_DELIVERABLE_PATHS);
        assert!(path_bytes > MAX_DELIVERABLE_BYTES);
        let mut command = Command::new("git");
        command
            .current_dir(root)
            .args(["update-index", "-z", "--index-info"]);
        let output = verification::run_private_git(&mut command, &input, GIT_TIMEOUT)
            .await
            .unwrap();
        assert!(output.status.success(), "{}", git_error(&output));
        assert!(!root.join("retained").exists());
    }

    fn native_index_digest(root: &Path) -> String {
        hex::encode(Sha256::digest(
            std::fs::read(root.join(".git/index")).unwrap(),
        ))
    }

    fn assert_oversized_capture_preserves_source(root: &Path, index: &str, head: &str) {
        assert_eq!(native_index_digest(root), index);
        assert_eq!(git(root, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            std::fs::read(root.join("tracked.txt")).unwrap(),
            b"before\n"
        );
        assert_eq!(
            std::fs::read(root.join("other.txt")).unwrap(),
            b"other before\n"
        );
        assert!(!root.join("retained").exists());
        assert!(!root.join(".git/index.lock").exists());
    }

    #[tokio::test]
    async fn oversized_staged_only_index_is_rejected_without_mutation() {
        let (root, _, _) = fixture();
        stage_oversized_index(&root).await;
        let index = native_index_digest(&root);
        let head = git(&root, &["rev-parse", "HEAD"]);
        let result = index_sha256(&root).await;
        assert_oversized_capture_preserves_source(&root, &index, &head);
        std::fs::remove_dir_all(root).unwrap();
        let error = result.expect_err("oversized native index output must be bounded");
        assert!(
            format!("{error:#}").contains("output exceeds its bound"),
            "{error:#}"
        );
    }

    #[tokio::test]
    async fn oversized_cached_deletions_are_rejected_without_mutation() {
        let (root, mut workspace, _) = fixture();
        stage_oversized_index(&root).await;
        git(&root, &["commit", "-m", "staged-only base"]);
        // A small current index does not bound deletion paths from a large base.
        git(&root, &["read-tree", &workspace.base_commit]);
        workspace.base_commit = git(&root, &["rev-parse", "HEAD"]);
        let index = native_index_digest(&root);
        index_sha256(&root).await.unwrap();
        let native_output = git_output_with_index(
            &root,
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
        .await;
        let result = capture_delta(Uuid::new_v4(), &workspace).await;
        assert_oversized_capture_preserves_source(&root, &index, &workspace.base_commit);
        std::fs::remove_dir_all(root).unwrap();
        let error = native_output
            .expect_err("oversized cached deletion output must be bounded before path validation");
        assert!(
            format!("{error:#}").contains("output exceeds its bound"),
            "{error:#}"
        );
        let error = result
            .err()
            .expect("oversized cached deletion output must be bounded");
        assert!(
            format!("{error:#}").contains("output exceeds its bound"),
            "{error:#}"
        );
    }

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
