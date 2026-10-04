use std::{fs, io::Write, process::Stdio};

use super::{
    tests::{fixture, git},
    *,
};

fn policy() -> crony_domain::VerificationPolicy {
    crony_domain::VerificationPolicy {
        checks: vec![crony_domain::VerifierCheck::File {
            path: "tracked.txt".into(),
            min_bytes: 1,
        }],
        manual_gate: None,
    }
}

fn spec(paths: &[&str]) -> DeliverableSpec {
    DeliverableSpec {
        form: DeliverableForm::CommitBranch,
        commit_after_verification: true,
        paths: paths.iter().map(|path| (*path).to_owned()).collect(),
    }
}

async fn rejects_preserving_source(
    root: &Path,
    lease: &WorkspaceLease,
    spec: &DeliverableSpec,
    artifacts: &[AdapterArtifact],
    scope: &[String],
    expected: &str,
) {
    let head = git(root, &["rev-parse", "HEAD"]);
    let status = git(root, &["status", "--porcelain=v1"]);
    let index = fs::read(root.join(".git/index")).unwrap();
    let source = fs::read(root.join("tracked.txt")).unwrap();
    let prepared = prepare_checkpoint(
        Uuid::new_v4(),
        spec,
        lease,
        artifacts,
        scope,
        &ActiveCheckpointPolicy {
            check_indices: vec![0],
        },
        &policy(),
    )
    .await;
    let error = match prepared {
        Ok(_) => panic!(
            "unsafe checkpoint was accepted; fixture: {}",
            root.display()
        ),
        Err(error) => format!("{error:#}"),
    };
    assert!(
        error.contains("history") && error.contains(expected),
        "{error}; fixture: {}",
        root.display()
    );
    assert_eq!(git(root, &["rev-parse", "HEAD"]), head);
    // Compare the index before status can refresh any native index metadata.
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(root.join("tracked.txt")).unwrap(), source);
    assert_eq!(git(root, &["status", "--porcelain=v1"]), status);
    println!("preserved native history fixture: {}", root.display());
}

#[tokio::test]
async fn active_checkpoint_history_rejects_reverted_scope_and_selection_changes() {
    for (selected, scope, expected) in [
        (vec!["tracked.txt"], vec!["**".into()], "unselected"),
        (
            vec![],
            vec!["tracked.txt".into()],
            "outside the task write scope",
        ),
    ] {
        let (root, lease, _) = fixture();
        fs::write(root.join("other.txt"), b"unpublishable intermediate edit\n").unwrap();
        git(&root, &["add", "--", "other.txt"]);
        git(
            &root,
            &["commit", "-m", "intermediate out-of-selection source"],
        );
        git(&root, &["revert", "--no-edit", "HEAD"]);
        fs::write(root.join("tracked.txt"), b"valid final source\n").unwrap();
        rejects_preserving_source(&root, &lease, &spec(&selected), &[], &scope, expected).await;
    }
}

#[tokio::test]
async fn active_checkpoint_history_rejects_deleted_provider_evidence_and_directory() {
    let (root, lease, _) = fixture();
    let path = root.join("provider-evidence/response.md");
    fs::create_dir(path.parent().unwrap()).unwrap();
    fs::write(&path, b"synthetic provider evidence\n").unwrap();
    git(&root, &["add", "--", "provider-evidence/response.md"]);
    git(&root, &["commit", "-m", "intermediate provider evidence"]);
    git(&root, &["rm", "--", "provider-evidence/response.md"]);
    git(
        &root,
        &["commit", "-m", "delete evidence directory from tip"],
    );
    assert!(!path.parent().unwrap().exists());
    fs::write(root.join("tracked.txt"), b"valid final source\n").unwrap();
    let artifact = AdapterArtifact {
        path,
        sha256: hex::encode(Sha256::digest(b"synthetic provider evidence\n")),
        bytes: 28,
        media_type: "text/markdown".into(),
    };
    rejects_preserving_source(
        &root,
        &lease,
        &spec(&[]),
        &[artifact],
        &["**".into()],
        "excluded path",
    )
    .await;
}

#[tokio::test]
async fn active_checkpoint_history_rejects_reverted_link_and_gitlink_modes() {
    for mode in ["120000", "160000"] {
        let (root, lease, _) = fixture();
        // Native index plumbing exercises Git link modes even on Windows without symlink rights.
        let object = if mode == "120000" {
            git(&root, &["hash-object", "-w", "--", "tracked.txt"])
        } else {
            lease.base_commit.clone()
        };
        git(
            &root,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("{mode},{object},historical-link"),
            ],
        );
        git(&root, &["commit", "-m", "intermediate native link mode"]);
        git(&root, &["rm", "--cached", "--", "historical-link"]);
        git(&root, &["commit", "-m", "remove link from the tip"]);
        fs::write(root.join("tracked.txt"), b"valid final source\n").unwrap();
        rejects_preserving_source(
            &root,
            &lease,
            &spec(&[]),
            &[],
            &["**".into()],
            "unsafe file mode",
        )
        .await;
    }
}

#[tokio::test]
async fn active_checkpoint_history_rejects_deleted_exclusion_on_merged_side_branch() {
    let (root, lease, _) = fixture();
    git(&root, &["checkout", "-b", "provider-side"]);
    fs::write(
        root.join(".env"),
        b"ECORP_FIXTURE_ONLY=not-a-real-credential\n",
    )
    .unwrap();
    git(&root, &["add", "-f", "--", ".env"]);
    git(&root, &["commit", "-m", "synthetic excluded side history"]);
    git(&root, &["rm", "--", ".env"]);
    git(&root, &["commit", "-m", "revert side exclusion"]);
    git(&root, &["checkout", "main"]);
    fs::write(root.join("tracked.txt"), b"valid primary source\n").unwrap();
    git(&root, &["add", "--", "tracked.txt"]);
    git(&root, &["commit", "-m", "valid primary source"]);
    git(&root, &["merge", "--no-ff", "--no-edit", "provider-side"]);
    assert!(!root.join(".env").exists());
    assert_eq!(
        git(&root, &["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
    rejects_preserving_source(
        &root,
        &lease,
        &spec(&[]),
        &[],
        &["**".into()],
        "excluded path",
    )
    .await;
}

#[tokio::test]
async fn active_checkpoint_history_preserves_safe_merge_and_appends_only_new_source() {
    for append in [false, true] {
        let (root, lease, _) = fixture();
        git(&root, &["checkout", "-b", "safe-side"]);
        fs::write(root.join("other.txt"), b"safe side source\n").unwrap();
        git(&root, &["add", "--", "other.txt"]);
        git(&root, &["commit", "-m", "safe side source"]);
        let side = git(&root, &["rev-parse", "HEAD"]);
        git(&root, &["checkout", "main"]);
        fs::write(root.join("tracked.txt"), b"safe primary source\n").unwrap();
        git(&root, &["add", "--", "tracked.txt"]);
        git(&root, &["commit", "-m", "safe primary source"]);
        git(&root, &["merge", "--no-ff", "--no-edit", "safe-side"]);
        let original = git(&root, &["rev-parse", "HEAD"]);
        if append {
            fs::write(root.join("tracked.txt"), b"new verified source\n").unwrap();
        }
        let mut prepared = prepare_checkpoint(
            Uuid::new_v4(),
            &spec(&[]),
            &lease,
            &[],
            &["**".into()],
            &ActiveCheckpointPolicy {
                check_indices: vec![0],
            },
            &policy(),
        )
        .await
        .unwrap();
        let (_sender, mut cancellation) = tokio::sync::watch::channel(false);
        let report = prepared
            .verify(&policy(), &[], &mut cancellation)
            .await
            .unwrap()
            .unwrap();
        let exported = prepared.export_checkpoint(&report).await.unwrap();
        let head = exported.head_commit.as_deref().unwrap();
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
        if append {
            assert_eq!(git(&root, &["rev-parse", "HEAD^"]), original);
        } else {
            assert_eq!(head, original);
        }
        // Import the actual checkpoint into an independent bare repository with base prerequisites.
        let document: serde_json::Value = serde_json::from_slice(&exported.bytes).unwrap();
        let bundle = root.join("safe-history.bundle");
        fs::write(
            &bundle,
            BASE64
                .decode(document["git_bundle_base64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let imported = root.join("safe-history-import.git");
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
        let heads = git(
            &imported,
            &["bundle", "list-heads", bundle.to_str().unwrap()],
        );
        let reference = heads.split_whitespace().nth(1).unwrap();
        git(
            &imported,
            &[
                "fetch",
                "--no-tags",
                bundle.to_str().unwrap(),
                &format!("{reference}:refs/heads/checkpoint"),
            ],
        );
        git(
            &imported,
            &["merge-base", "--is-ancestor", &original, "checkpoint"],
        );
        git(
            &imported,
            &["merge-base", "--is-ancestor", &side, "checkpoint"],
        );
        assert_eq!(
            git(&imported, &["show", "checkpoint:other.txt"]),
            "safe side source"
        );
        println!(
            "preserved native safe history bundle fixture: {}",
            root.display()
        );
    }
}

#[tokio::test]
async fn active_checkpoint_history_rejects_excessive_ancestry_without_truncation() {
    let (root, lease, _) = fixture();
    let mut input = String::new();
    for count in 1..=257 {
        let parent = if count == 1 {
            lease.base_commit.clone()
        } else {
            format!(":{}", count - 1)
        };
        input.push_str(&format!("commit refs/heads/main\nmark :{count}\ncommitter ECorp Fixture <fixture@example.invalid> {count} +0000\ndata 13\nhistory bound\nfrom {parent}\n\n"));
    }
    input.push_str("done\n");
    let mut process = std::process::Command::new("git")
        .args(["fast-import", "--quiet", "--done"])
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let result = process.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        git(
            &root,
            &[
                "rev-list",
                "--count",
                &format!("{}..HEAD", lease.base_commit)
            ]
        ),
        "257"
    );
    fs::write(root.join("tracked.txt"), b"valid new source\n").unwrap();
    rejects_preserving_source(
        &root,
        &lease,
        &spec(&[]),
        &[],
        &["**".into()],
        "more than 256",
    )
    .await;
}

#[tokio::test]
async fn active_checkpoint_history_rejects_missing_shallow_ancestry() {
    let (root, lease, _) = fixture();
    let clone = root.join("owned-shallow-clone");
    git(
        &root,
        &[
            "clone",
            "--depth=1",
            "--no-local",
            root.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    let shallow = WorkspaceLease {
        path: clone.clone(),
        ..lease
    };
    fs::write(clone.join("tracked.txt"), b"valid new source\n").unwrap();
    rejects_preserving_source(
        &clone,
        &shallow,
        &spec(&[]),
        &[],
        &["**".into()],
        "non-shallow",
    )
    .await;
}
