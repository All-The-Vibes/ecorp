//! Retrospective native Git tests, with synthetic stored authority and no provider.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::decode_verification_artifact;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crony_domain::{DeliverableForm, DeliverableSpec, VerificationPolicy, VerifierCheck};
use crony_protocol::VerificationArtifactReference;
use tokio::sync::watch;
use uuid::Uuid;

use super::*;

struct Fixture {
    root: PathBuf,
    manager: WorkspaceManager,
    assignment: Assignment,
    source: BaseRefreshSource,
    new_base: String,
}

fn native(cwd: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    // Refresh worktrees include immutable run/task IDs. Read their refs with the
    // same Windows long-path support as the production native Git adapter.
    #[cfg(windows)]
    command.args(["-c", "core.longpaths=true"]);
    let output = command.current_dir(cwd).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn reference(bytes: &[u8]) -> VerificationArtifactReference {
    VerificationArtifactReference {
        path: "ecorp-commit-branch.json".into(),
        sha256: hex::encode(Sha256::digest(bytes)),
        bytes: bytes.len(),
        media_type: "application/vnd.ecorp.deliverable+json".into(),
        data_base64: Some(BASE64.encode(bytes)),
    }
}

impl Fixture {
    async fn new(conflict: bool) -> Self {
        let root = std::env::temp_dir().join(format!("ecorp-base-refresh-test-{}", Uuid::new_v4()));
        let repository = root.join("source");
        fs::create_dir_all(&repository).unwrap();
        println!("base refresh fixture: {}", root.display());
        native(&repository, &["init", "--template=", "-b", "main"]);
        native(&repository, &["config", "user.name", "ECorp test fixture"]);
        native(
            &repository,
            &["config", "user.email", "fixture@ecorp.invalid"],
        );
        native(&repository, &["config", "core.autocrlf", "false"]);
        native(
            &repository,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/All-The-Vibes/ecorp.git",
            ],
        );
        fs::write(repository.join("tracked.txt"), b"original\n").unwrap();
        fs::write(repository.join("upstream.txt"), b"original upstream\n").unwrap();
        native(&repository, &["add", "."]);
        native(&repository, &["commit", "-m", "original base"]);
        let old_base = native(&repository, &["rev-parse", "HEAD"]);
        native(&repository, &["switch", "-c", "verified-source"]);
        fs::write(repository.join("tracked.txt"), b"verified change\n").unwrap();
        fs::write(repository.join("executable.sh"), b"#!/bin/sh\nexit 0\n").unwrap();
        native(&repository, &["add", "."]);
        native(
            &repository,
            &["update-index", "--chmod=+x", "executable.sh"],
        );
        native(&repository, &["commit", "-m", "source result"]);
        let head = native(&repository, &["rev-parse", "HEAD"]);
        let source_tree = native(&repository, &["rev-parse", "HEAD^{tree}"]);
        let bundle_path = root.join("source.bundle");
        native(
            &repository,
            &[
                "bundle",
                "create",
                bundle_path.to_str().unwrap(),
                "verified-source",
                &format!("^{old_base}"),
            ],
        );
        let bundle = fs::read(bundle_path).unwrap();
        let bundle_sha256 = hex::encode(Sha256::digest(&bundle));
        // This digest represents synthetic stored authority, not an executed source check.
        let verification_sha256 = "a".repeat(64);
        let document = json!({
            "schema_version":1,"form":"commit_branch","base_commit":old_base,
            "head_commit":head,"branch":"verified-source","verified_tree":source_tree,
            "verification_sha256":verification_sha256,"git_bundle_sha256":bundle_sha256,
            "git_bundle_base64":BASE64.encode(bundle),
        });
        let source = BaseRefreshSource {
            refresh_id: Uuid::new_v4(),
            source_deliverable_id: Uuid::new_v4(),
            old_base_commit: old_base,
            source_head_commit: head,
            source_branch: "verified-source".into(),
            verification_sha256,
            git_bundle_sha256: bundle_sha256,
            artifact: reference(&serde_json::to_vec(&document).unwrap()),
        };
        native(&repository, &["switch", "main"]);
        fs::write(
            repository.join(if conflict {
                "tracked.txt"
            } else {
                "upstream.txt"
            }),
            b"advanced upstream\n",
        )
        .unwrap();
        native(&repository, &["add", "."]);
        native(&repository, &["commit", "-m", "new base"]);
        let new_base = native(&repository, &["rev-parse", "HEAD"]);
        fs::write(
            repository.join("untracked-sentinel.txt"),
            b"preserve source dirty bytes\n",
        )
        .unwrap();
        let manager = WorkspaceManager::initialize(root.join("managed"), repository, "main".into())
            .await
            .unwrap();
        let lease = WorkspaceLease {
            path: root.clone(),
            branch: "unused".into(),
            base_ref: "main".into(),
            base_commit: new_base.clone(),
        };
        let mut assignment = crate::tests::verification_assignment(&lease, Uuid::new_v4());
        assignment.workspace_run_id = assignment.run_id;
        assignment.source_repository = Some("All-The-Vibes/ecorp".into());
        assignment.source_base_ref = Some("main".into());
        assignment.source_base_commit = Some(new_base.clone());
        assignment.write_scope = vec!["tracked.txt".into(), "executable.sh".into()];
        assignment.deliverable = Some(DeliverableSpec {
            form: DeliverableForm::CommitBranch,
            paths: vec![],
            commit_after_verification: true,
        });
        assignment.verification_policy = VerificationPolicy {
            checks: vec![
                VerifierCheck::File {
                    path: "tracked.txt".into(),
                    min_bytes: 1,
                },
                VerifierCheck::Test {
                    program: "git".into(),
                    args: vec!["cat-file".into(), "-e".into(), "HEAD:executable.sh".into()],
                    timeout_ms: 10_000,
                    cache_suppression: None,
                },
            ],
            manual_gate: None,
        };
        Self {
            root,
            manager,
            assignment,
            source,
            new_base,
        }
    }

    fn source_state(&self) -> (String, String, Vec<u8>) {
        (
            native(self.manager.repository(), &["show-ref"]),
            native(self.manager.repository(), &["status", "--porcelain=v1"]),
            fs::read(self.manager.repository().join("untracked-sentinel.txt")).unwrap(),
        )
    }

    async fn reconstruct(&self) -> Result<Reconstructed> {
        reconstruct(&self.manager, &self.assignment, &self.source).await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
            assert!(
                self.root
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("ecorp-base-refresh-test-")
            );
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
}

#[tokio::test]
async fn refresh_accepts_a_fully_qualified_source_ref_without_rewriting_it() {
    let mut fixture = Fixture::new(false).await;
    fixture.manager = WorkspaceManager::initialize(
        fixture.root.join("qualified-managed"),
        fixture.manager.repository().to_owned(),
        "refs/heads/main".into(),
    )
    .await
    .unwrap();
    fixture.assignment.source_base_ref = Some("refs/heads/main".into());
    let before = fixture.source_state();
    let refreshed = fixture.reconstruct().await.unwrap();
    assert_eq!(refreshed.workspace.base_commit, fixture.new_base);
    assert_eq!(refreshed.workspace.base_ref, "refs/heads/main");
    assert_eq!(fixture.source_state(), before);
    assert!(!native(refreshed.manager.repository(), &["show-ref"]).contains("refs/heads/refs/"));
}

#[tokio::test]
async fn refresh_preserves_source_and_verifies_the_exact_native_tree_before_export() {
    let fixture = Fixture::new(false).await;
    let before = fixture.source_state();
    let refreshed = fixture.reconstruct().await.unwrap();
    assert_ne!(refreshed.workspace.path, fixture.manager.repository());
    assert_eq!(
        fs::read(refreshed.workspace.path.join("tracked.txt")).unwrap(),
        b"verified change\n"
    );
    assert_eq!(
        fs::read(refreshed.workspace.path.join("upstream.txt")).unwrap(),
        b"advanced upstream\n"
    );
    assert_eq!(refreshed.workspace.base_commit, fixture.new_base);
    assert!(
        native(
            refreshed.manager.repository(),
            &["ls-tree", &refreshed.tree, "executable.sh"]
        )
        .starts_with("100755")
    );
    let mut prepared = crate::deliverable::prepare_tree(
        fixture.assignment.run_id,
        fixture.assignment.deliverable.as_ref().unwrap(),
        &refreshed.workspace,
        &fixture.assignment.write_scope,
        &refreshed.tree,
    )
    .await
    .unwrap();
    let (_cancel, mut cancellation) = watch::channel(false);
    let report = prepared
        .verify(
            &fixture.assignment.verification_policy,
            &[],
            &mut cancellation,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(report.passed, "{report:?}");
    assert_eq!(report.checks.len(), 2);
    let exported = prepared.export(&report).await.unwrap();
    assert!(exported.publication_ready);
    assert_eq!(exported.verified_tree, refreshed.tree);
    assert_eq!(exported.base_commit, fixture.new_base);
    assert_ne!(
        exported.head_commit.as_deref(),
        Some(fixture.source.source_head_commit.as_str())
    );
    assert_eq!(fixture.source_state(), before);
}

#[tokio::test]
async fn refresh_conflicts_preserve_source_and_failed_owned_work() {
    let fixture = Fixture::new(true).await;
    let before = fixture.source_state();
    let error = fixture.reconstruct().await.err().unwrap();
    assert!(format!("{error:#}").contains("conflict-free tree"));
    assert!(
        fixture
            .manager
            .root()
            .join(format!("base-refresh-{}", fixture.assignment.run_id))
            .is_dir()
    );
    assert_eq!(fixture.source_state(), before);
}

#[tokio::test]
async fn refresh_rejects_changed_repository_base_ref_and_reused_workspace_authority() {
    let fixture = Fixture::new(false).await;
    let before = fixture.source_state();
    for field in 0..5 {
        let mut assignment = fixture.assignment.clone();
        match field {
            0 => assignment.source_repository = Some("another/repository".into()),
            1 => assignment.source_base_ref = Some("another-ref".into()),
            2 => assignment.workspace_run_id = Uuid::new_v4(),
            3 => assignment.checkpoint_verification = true,
            _ => assignment.source_base_commit = Some(fixture.source.old_base_commit.clone()),
        }
        assert!(
            reconstruct(&fixture.manager, &assignment, &fixture.source)
                .await
                .is_err()
        );
    }
    assert_eq!(fixture.source_state(), before);
}

#[tokio::test]
async fn refresh_rejects_non_descendant_base() {
    let mut fixture = Fixture::new(false).await;
    let tree = native(fixture.manager.repository(), &["rev-parse", "HEAD^{tree}"]);
    let unrelated = native(
        fixture.manager.repository(),
        &["commit-tree", &tree, "-m", "unrelated root"],
    );
    fixture.assignment.source_base_commit = Some(unrelated);
    let error = fixture.reconstruct().await.err().unwrap();
    assert!(format!("{error:#}").contains("must descend"));
}

#[tokio::test]
async fn refresh_rejects_tampered_artifact_metadata_bundle_and_tree() {
    let fixture = Fixture::new(false).await;
    for field in [
        "base_commit",
        "head_commit",
        "branch",
        "verification_sha256",
        "git_bundle_sha256",
        "verified_tree",
    ] {
        let mut source = fixture.source.clone();
        let mut document: Value =
            serde_json::from_slice(&decode_verification_artifact(&source.artifact).unwrap())
                .unwrap();
        document[field] = json!("b".repeat(64));
        source.artifact = reference(&serde_json::to_vec(&document).unwrap());
        // Native reconstruction checks the source tree after bundle import.
        if field == "verified_tree" {
            source.refresh_id = Uuid::new_v4();
            let mut assignment = fixture.assignment.clone();
            assignment.run_id = Uuid::new_v4();
            assignment.workspace_run_id = assignment.run_id;
            assert!(
                reconstruct(&fixture.manager, &assignment, &source)
                    .await
                    .is_err()
            );
        } else {
            assert!(source_bundle(&source).is_err(), "{field}");
        }
    }
    let mut source = fixture.source.clone();
    source.artifact.sha256 = "0".repeat(64);
    assert!(source_bundle(&source).is_err());
    let mut source = fixture.source.clone();
    let mut document: Value =
        serde_json::from_slice(&decode_verification_artifact(&source.artifact).unwrap()).unwrap();
    document["git_bundle_base64"] = json!(BASE64.encode(b"tampered native bundle"));
    source.artifact = reference(&serde_json::to_vec(&document).unwrap());
    assert!(source_bundle(&source).is_err());
}

#[tokio::test]
async fn refresh_never_reuses_or_removes_a_prior_owned_directory() {
    let fixture = Fixture::new(false).await;
    let owned = fixture
        .manager
        .root()
        .join(format!("base-refresh-{}", fixture.assignment.run_id));
    fs::create_dir(&owned).unwrap();
    fs::write(owned.join("sentinel"), b"preserve").unwrap();
    assert!(fixture.reconstruct().await.is_err());
    assert_eq!(fs::read(owned.join("sentinel")).unwrap(), b"preserve");
}

#[tokio::test]
async fn refresh_rejects_out_of_scope_delta_and_saved_path_expansion() {
    let fixture = Fixture::new(false).await;
    let refreshed = fixture.reconstruct().await.unwrap();
    let spec = fixture.assignment.deliverable.as_ref().unwrap();
    assert!(
        crate::deliverable::prepare_tree(
            fixture.assignment.run_id,
            spec,
            &refreshed.workspace,
            &["tracked.txt".into()],
            &refreshed.tree
        )
        .await
        .is_err()
    );
    let restricted = DeliverableSpec {
        paths: vec!["tracked.txt".into()],
        ..spec.clone()
    };
    assert!(
        crate::deliverable::prepare_tree(
            fixture.assignment.run_id,
            &restricted,
            &refreshed.workspace,
            &["**".into()],
            &refreshed.tree
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn refresh_failed_policy_cannot_export_a_publishable_commit() {
    let fixture = Fixture::new(false).await;
    let refreshed = fixture.reconstruct().await.unwrap();
    let mut prepared = crate::deliverable::prepare_tree(
        fixture.assignment.run_id,
        fixture.assignment.deliverable.as_ref().unwrap(),
        &refreshed.workspace,
        &fixture.assignment.write_scope,
        &refreshed.tree,
    )
    .await
    .unwrap();
    let mut policy = fixture.assignment.verification_policy.clone();
    policy.checks.push(VerifierCheck::File {
        path: "required-but-missing.txt".into(),
        min_bytes: 1,
    });
    let (_cancel, mut cancellation) = watch::channel(false);
    let report = prepared
        .verify(&policy, &[], &mut cancellation)
        .await
        .unwrap()
        .unwrap();
    assert!(!report.passed);
    assert_eq!(report.checks.len(), 3);
    assert!(prepared.export(&report).await.is_err());
    assert_eq!(
        native(&refreshed.workspace.path, &["rev-parse", "HEAD"]),
        fixture.new_base
    );
}
