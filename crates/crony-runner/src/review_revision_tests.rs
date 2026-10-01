//! Native Git regression fixtures use synthetic publication authority, never
//! evidence of a historical provider run or a human review.
use std::{fs, process::Command};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use crony_domain::{DeliverableForm, DeliverableSpec, VerificationPolicy, VerifierCheck};
use crony_protocol::VerificationArtifactReference;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::*;

async fn verified_export(
    fixture: &Fixture,
    seeded: &Seeded,
    script: &str,
) -> crate::deliverable::ExportedDeliverable {
    let mut prepared = crate::deliverable::prepare_revision(
        fixture.assignment.run_id,
        fixture.assignment.deliverable.as_ref().unwrap(),
        &seeded.workspace,
        &[],
        &fixture.assignment.write_scope,
        &fixture.source.source_head_commit,
    )
    .await
    .unwrap();
    let (_cancel, mut cancelled) = tokio::sync::watch::channel(false);
    let report = prepared
        .verify(
            &VerificationPolicy {
                checks: vec![VerifierCheck::Command {
                    program: "node".into(),
                    args: vec!["-e".into(), script.into()],
                    timeout_ms: 20_000,
                    cache_suppression: None,
                }],
                manual_gate: None,
            },
            &[],
            &mut cancelled,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(report.passed, "{report:?}");
    assert!(report.source.as_ref().unwrap().is_valid());
    prepared.export(&report).await.unwrap()
}

fn native(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "-c",
            "core.longpaths=true",
            "-c",
            "user.name=ECorp fixture",
            "-c",
            "user.email=fixture@ecorp.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
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

struct Fixture {
    root: PathBuf,
    manager: WorkspaceManager,
    assignment: Assignment,
    source: ReviewRevisionSource,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ecorp-review-revision-{}", Uuid::new_v4()));
        let repository = root.join("source");
        fs::create_dir_all(&repository).unwrap();
        println!("review revision fixture: {}", root.display());
        native(&repository, &["init", "--template=", "-b", "main"]);
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
        native(&repository, &["add", "."]);
        native(&repository, &["commit", "-m", "base"]);
        let base = native(&repository, &["rev-parse", "HEAD"]);
        native(&repository, &["switch", "-c", "published"]);
        fs::write(repository.join("tracked.txt"), b"published defect\n").unwrap();
        fs::write(repository.join("executable.sh"), b"#!/bin/sh\nexit 0\n").unwrap();
        native(&repository, &["add", "."]);
        native(
            &repository,
            &["update-index", "--chmod=+x", "executable.sh"],
        );
        native(&repository, &["commit", "-m", "published source"]);
        let head = native(&repository, &["rev-parse", "HEAD"]);
        let tree = native(&repository, &["rev-parse", "HEAD^{tree}"]);
        let bundle_path = root.join("published.bundle");
        native(
            &repository,
            &[
                "bundle",
                "create",
                bundle_path.to_str().unwrap(),
                "published",
                &format!("^{base}"),
            ],
        );
        let bundle = fs::read(bundle_path).unwrap();
        let bundle_sha256 = hex::encode(Sha256::digest(&bundle));
        let verification_sha256 = "a".repeat(64);
        let document = json!({"schema_version":1,"form":"commit_branch","base_commit":base,
            "head_commit":head,"branch":"published","verified_tree":tree,
            "verification_sha256":verification_sha256,"git_bundle_sha256":bundle_sha256,
            "git_bundle_base64":BASE64.encode(bundle)});
        let source = ReviewRevisionSource {
            revision_id: Uuid::new_v4(),
            publication_id: Uuid::new_v4(),
            source_run_id: Uuid::new_v4(),
            source_deliverable_id: Uuid::new_v4(),
            original_base_commit: base.clone(),
            source_head_commit: head,
            source_branch: "published".into(),
            verification_sha256,
            git_bundle_sha256: bundle_sha256,
            artifact: reference(&serde_json::to_vec(&document).unwrap()),
        };
        native(&repository, &["switch", "main"]);
        fs::write(repository.join("sentinel.txt"), b"preserve source bytes\n").unwrap();
        let manager = WorkspaceManager::initialize(root.join("managed"), repository, "main".into())
            .await
            .unwrap();
        let lease = WorkspaceLease {
            path: root.clone(),
            branch: "unused".into(),
            base_ref: "main".into(),
            base_commit: base.clone(),
        };
        let mut assignment = crate::tests::verification_assignment(&lease, Uuid::new_v4());
        assignment.workspace_run_id = assignment.run_id;
        assignment.source_repository = Some("All-The-Vibes/ecorp".into());
        assignment.source_base_ref = Some("main".into());
        assignment.source_base_commit = Some(base);
        assignment.resume_workspace_base_commit = None;
        assignment.expected_workspace_fingerprint = None;
        assignment.expected_head_commit = None;
        assignment.verification_command_id = None;
        assignment.retained_provider_receipt = None;
        assignment.provider_artifact = None;
        assignment.checkpoint_verification = false;
        assignment.review_revision = Some(source.clone());
        assignment.write_scope = vec!["tracked.txt".into(), "executable.sh".into()];
        assignment.deliverable = Some(DeliverableSpec {
            form: DeliverableForm::CommitBranch,
            paths: vec![],
            commit_after_verification: true,
        });
        Self {
            root,
            manager,
            assignment,
            source,
        }
    }

    async fn seed(&self, resume: bool) -> Result<Seeded> {
        reconstruct(&self.manager, &self.assignment, &self.source, resume).await
    }

    async fn retain(&mut self, seeded: &Seeded) {
        let (head, fingerprint) = seeded.manager.checkpoint(&seeded.workspace).await.unwrap();
        self.assignment.run_id = Uuid::new_v4();
        self.assignment.resume_workspace_base_commit =
            Some(self.source.original_base_commit.clone());
        self.assignment.expected_head_commit = Some(head);
        self.assignment.expected_workspace_fingerprint = Some(fingerprint);
    }

    fn source_state(&self) -> (String, String, Vec<u8>) {
        (
            native(self.manager.repository(), &["show-ref"]),
            native(self.manager.repository(), &["status", "--porcelain=v1"]),
            fs::read(self.manager.repository().join("sentinel.txt")).unwrap(),
        )
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
                    .starts_with("ecorp-review-revision-")
            );
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
}

#[tokio::test]
async fn fresh_correction_restores_exact_publication_and_preserves_source() {
    let fixture = Fixture::new().await;
    let before = fixture.source_state();
    let seeded = fixture.seed(false).await.unwrap();
    assert_eq!(
        native(&seeded.workspace.path, &["rev-parse", "HEAD"]),
        fixture.source.source_head_commit
    );
    assert_eq!(
        fs::read(seeded.workspace.path.join("tracked.txt")).unwrap(),
        b"published defect\n"
    );
    assert!(
        native(
            &seeded.workspace.path,
            &["ls-files", "--stage", "executable.sh"]
        )
        .starts_with("100755 ")
    );
    assert_eq!(fixture.source_state(), before);
    assert!(
        fixture
            .seed(false)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("preserve existing work")
    );
    assert_eq!(fixture.source_state(), before);
}

#[tokio::test]
async fn correction_resume_requires_both_native_head_and_file_checkpoint() {
    let mut fixture = Fixture::new().await;
    let seeded = fixture.seed(false).await.unwrap();
    fs::write(
        seeded.workspace.path.join("tracked.txt"),
        b"correction in progress\n",
    )
    .unwrap();
    fixture.retain(&seeded).await;
    assert_eq!(
        fixture.seed(true).await.unwrap().workspace.path,
        seeded.workspace.path
    );
    fs::write(
        seeded.workspace.path.join("tracked.txt"),
        b"unreviewed external edit\n",
    )
    .unwrap();
    assert!(fixture.seed(true).await.is_err());
    fs::write(
        seeded.workspace.path.join("tracked.txt"),
        b"correction in progress\n",
    )
    .unwrap();
    let tree = native(&seeded.workspace.path, &["rev-parse", "HEAD^{tree}"]);
    let head = native(
        &seeded.workspace.path,
        &[
            "commit-tree",
            &tree,
            "-p",
            "HEAD",
            "-m",
            "same tree different history",
        ],
    );
    native(
        &seeded.workspace.path,
        &[
            "update-ref",
            "HEAD",
            &head,
            &fixture.source.source_head_commit,
        ],
    );
    assert_eq!(
        Some(seeded.manager.fingerprint(&seeded.workspace).await.unwrap()),
        fixture.assignment.expected_workspace_fingerprint
    );
    assert!(fixture.seed(true).await.is_err());
}

#[tokio::test]
async fn correction_resume_rejects_redirected_native_metadata() {
    let mut fixture = Fixture::new().await;
    let seeded = fixture.seed(false).await.unwrap();
    fixture.retain(&seeded).await;
    let before = fixture.source_state();
    fs::write(
        seeded.workspace.path.join(".git"),
        format!(
            "gitdir: {}\n",
            fixture.manager.repository().join(".git").display()
        ),
    )
    .unwrap();
    assert!(fixture.seed(true).await.is_err());
    assert_eq!(fixture.source_state(), before);
}

#[tokio::test]
async fn correction_resume_rejects_lineage_and_config_mutation() {
    let mut fixture = Fixture::new().await;
    let seeded = fixture.seed(false).await.unwrap();
    fixture.retain(&seeded).await;
    let marker = seeded.manager.root().join("lineage.json");
    let original = fs::read(&marker).unwrap();
    fs::write(&marker, b"{}").unwrap();
    assert!(fixture.seed(true).await.is_err());
    fs::write(&marker, original).unwrap();
    native(
        seeded.manager.repository(),
        &[
            "config",
            "core.worktree",
            fixture.manager.repository().to_str().unwrap(),
        ],
    );
    assert!(fixture.seed(true).await.is_err());
}

#[tokio::test]
async fn correction_rejects_tampered_signed_source_before_creating_work() {
    let mut fixture = Fixture::new().await;
    fixture.source.artifact.sha256 = "b".repeat(64);
    assert!(fixture.seed(false).await.is_err());
    assert!(
        !fixture
            .manager
            .root()
            .join(format!(
                "review-revision-{}",
                fixture.assignment.workspace_run_id
            ))
            .exists()
    );
}

#[tokio::test]
async fn correction_export_binds_verified_bytes_parent_mode_and_portable_ancestry() {
    let fixture = Fixture::new().await;
    let before = fixture.source_state();
    let seeded = fixture.seed(false).await.unwrap();
    fs::write(seeded.workspace.path.join("tracked.txt"), b"corrected\n").unwrap();
    let exported = verified_export(
        &fixture,
        &seeded,
        "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('tracked.txt','utf8'),'corrected\\n');a.equal(fs.readFileSync('executable.sh','utf8'),'#!/bin/sh\\nexit 0\\n')",
    )
    .await;
    let head = exported.head_commit.as_deref().unwrap();
    assert_eq!(exported.base_commit, fixture.source.original_base_commit);
    assert_eq!(
        native(&seeded.workspace.path, &["rev-parse", &format!("{head}^")]),
        fixture.source.source_head_commit
    );
    assert!(
        native(&seeded.workspace.path, &["ls-tree", head, "executable.sh"]).starts_with("100755 ")
    );
    assert_eq!(
        native(&seeded.workspace.path, &["status", "--porcelain=v1"]),
        ""
    );
    let document: Value = serde_json::from_slice(&exported.bytes).unwrap();
    let bundle = fixture.root.join("replacement.bundle");
    fs::write(
        &bundle,
        BASE64
            .decode(document["git_bundle_base64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let recipient = fixture.root.join("recipient");
    fs::create_dir(&recipient).unwrap();
    native(&recipient, &["init", "--template="]);
    native(
        &recipient,
        &[
            "fetch",
            "--no-tags",
            fixture.manager.repository().to_str().unwrap(),
            &fixture.source.original_base_commit,
        ],
    );
    native(&recipient, &["bundle", "verify", bundle.to_str().unwrap()]);
    native(
        &recipient,
        &["bundle", "unbundle", bundle.to_str().unwrap()],
    );
    native(
        &recipient,
        &[
            "merge-base",
            "--is-ancestor",
            &fixture.source.original_base_commit,
            &fixture.source.source_head_commit,
        ],
    );
    native(
        &recipient,
        &[
            "merge-base",
            "--is-ancestor",
            &fixture.source.source_head_commit,
            head,
        ],
    );
    assert_eq!(
        native(&recipient, &["show", &format!("{head}:tracked.txt")]),
        "corrected"
    );
    assert_eq!(
        native(&recipient, &["rev-parse", &format!("{head}^{{tree}}")]),
        exported.verified_tree
    );
    assert_eq!(fixture.source_state(), before);
}

#[tokio::test]
async fn correction_partial_and_complete_reverts_preserve_new_parent_and_clean_index() {
    for complete in [false, true] {
        let fixture = Fixture::new().await;
        let before = fixture.source_state();
        let seeded = fixture.seed(false).await.unwrap();
        fs::write(seeded.workspace.path.join("tracked.txt"), b"original\n").unwrap();
        if complete {
            fs::remove_file(seeded.workspace.path.join("executable.sh")).unwrap();
        }
        let exported = verified_export(
            &fixture,
            &seeded,
            &format!("const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('tracked.txt','utf8'),'original\\n');a.equal(fs.existsSync('executable.sh'),{})", !complete),
        ).await;
        let head = exported.head_commit.unwrap();
        assert_ne!(head, fixture.source.original_base_commit);
        assert_ne!(head, fixture.source.source_head_commit);
        assert_eq!(
            native(&seeded.workspace.path, &["rev-parse", &format!("{head}^")]),
            fixture.source.source_head_commit
        );
        assert_eq!(
            native(
                &seeded.workspace.path,
                &["show", &format!("{head}:tracked.txt")]
            ),
            "original"
        );
        if complete {
            assert_eq!(
                exported.verified_tree,
                native(
                    fixture.manager.repository(),
                    &[
                        "rev-parse",
                        &format!("{}^{{tree}}", fixture.source.original_base_commit)
                    ]
                )
            );
        }
        assert_eq!(
            native(&seeded.workspace.path, &["status", "--porcelain=v1"]),
            "",
            "accepted correction must not retain a stale published index"
        );
        assert_eq!(fixture.source_state(), before);
    }
}

#[tokio::test]
async fn correction_export_rejects_lost_ancestry_and_out_of_scope_bytes() {
    let fixture = Fixture::new().await;
    let before = fixture.source_state();
    let seeded = fixture.seed(false).await.unwrap();
    fs::write(
        seeded.workspace.path.join("foreign.txt"),
        b"outside authority\n",
    )
    .unwrap();
    let error = crate::deliverable::prepare_revision(
        fixture.assignment.run_id,
        fixture.assignment.deliverable.as_ref().unwrap(),
        &seeded.workspace,
        &[],
        &fixture.assignment.write_scope,
        &fixture.source.source_head_commit,
    )
    .await
    .err()
    .unwrap();
    assert!(format!("{error:#}").contains("scope"), "{error:#}");
    fs::remove_file(seeded.workspace.path.join("foreign.txt")).unwrap();
    native(
        &seeded.workspace.path,
        &[
            "update-ref",
            "HEAD",
            &fixture.source.original_base_commit,
            &fixture.source.source_head_commit,
        ],
    );
    let error = crate::deliverable::prepare_revision(
        fixture.assignment.run_id,
        fixture.assignment.deliverable.as_ref().unwrap(),
        &seeded.workspace,
        &[],
        &fixture.assignment.write_scope,
        &fixture.source.source_head_commit,
    )
    .await
    .err()
    .unwrap();
    assert!(
        format!("{error:#}").contains("published ancestry"),
        "{error:#}"
    );
    assert_eq!(fixture.source_state(), before);
}

#[tokio::test]
async fn correction_resume_bounds_routing_metadata_and_rejects_includes() {
    let mut fixture = Fixture::new().await;
    let seeded = fixture.seed(false).await.unwrap();
    fixture.retain(&seeded).await;
    let before = fixture.source_state();
    let admin = PathBuf::from(native(
        &seeded.workspace.path,
        &["rev-parse", "--absolute-git-dir"],
    ));
    for (path, length) in [
        (seeded.workspace.path.join(".git"), 8193),
        (seeded.manager.root().join("lineage.json"), 8193),
        (seeded.manager.repository().join(".git/config"), 65537),
        (admin.join("commondir"), 8193),
        (admin.join("gitdir"), 8193),
        (admin.join("HEAD"), 8193),
    ] {
        let original = fs::read(&path).unwrap();
        fs::write(&path, vec![b'x'; length]).unwrap();
        let error = fixture.seed(true).await.err().unwrap();
        assert!(format!("{error:#}").contains("size bound"), "{error:#}");
        fs::write(path, original).unwrap();
    }
    let common = admin.join("commondir");
    let original = fs::read(&common).unwrap();
    fs::write(
        &common,
        fixture.manager.repository().join(".git").to_str().unwrap(),
    )
    .unwrap();
    assert!(fixture.seed(true).await.is_err());
    fs::write(&common, original).unwrap();
    assert!(fixture.seed(true).await.is_ok());
    native(
        seeded.manager.repository(),
        &[
            "config",
            "include.path",
            fixture
                .manager
                .repository()
                .join(".git/config")
                .to_str()
                .unwrap(),
        ],
    );
    assert!(fixture.seed(true).await.is_err());
    assert_eq!(fixture.source_state(), before);
}
