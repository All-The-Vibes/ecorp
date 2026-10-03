//! Real isolated Git/runner regressions; ACKs here are synthetic protocol inputs.
use super::*;
use crony_domain::{ActiveCheckpointPolicy, DeliverableForm, DeliverableSpec, VerifierCheck};
use std::path::Path;

struct Fixture {
    root: PathBuf,
    manager: Arc<WorkspaceManager>,
    workspace: WorkspaceLease,
    assignment: Assignment,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // prepared_verification_fixture owns this UUID directory under the test-only root.
        assert_eq!(
            self.root.parent().unwrap(),
            std::env::temp_dir().join("crony-runner-teardown-tests")
        );
        if let Err(error) = std::fs::remove_dir_all(&self.root) {
            eprintln!("preserved owned checkpoint fixture after cleanup failure: {error}");
        }
    }
}

async fn fixture() -> Fixture {
    let (root, manager, workspace, mut assignment) =
        crate::tests::prepared_verification_fixture().await;
    std::fs::write(workspace.path.join("result.md"), b"active source\n").unwrap();
    assignment.write_scope = vec!["result.md".into()];
    assignment.deliverable = Some(DeliverableSpec {
        form: DeliverableForm::CommitBranch,
        commit_after_verification: true,
        paths: vec!["result.md".into()],
    });
    assignment.verification_policy = VerificationPolicy {
        checks: vec![
            VerifierCheck::File {
                path: "result.md".into(),
                min_bytes: 1,
            },
            VerifierCheck::File {
                path: "final-only.md".into(),
                min_bytes: 1,
            },
        ],
        manual_gate: None,
    };
    assignment.active_checkpoint = Some(ActiveCheckpointPolicy {
        check_indices: vec![0],
    });
    assignment.expected_workspace_fingerprint =
        Some(manager.fingerprint(&workspace).await.unwrap());
    Fixture {
        root,
        manager,
        workspace,
        assignment,
    }
}

type Execution = tokio::task::JoinHandle<(Result<bool, CheckpointFailure>, Option<String>)>;

fn start(
    fixture: &Fixture,
) -> (
    Execution,
    mpsc::UnboundedReceiver<RunnerToServer>,
    mpsc::UnboundedSender<ArtifactAck>,
    watch::Sender<bool>,
) {
    let outbound = OutboundBus::default();
    let (event_tx, events) = mpsc::unbounded_channel();
    outbound.attach(event_tx, fixture.assignment.connection_epoch);
    let (acks, mut ack_rx) = mpsc::unbounded_channel();
    let (cancel, mut cancellation) = watch::channel(false);
    let assignment = fixture.assignment.clone();
    let workspace = fixture.workspace.clone();
    let manager = fixture.manager.clone();
    let execution = tokio::spawn(async move {
        let mut head = assignment.expected_head_commit.clone();
        let result = publish(
            &outbound,
            "checkpoint-fixture",
            &assignment,
            &workspace,
            &manager,
            &[],
            &[],
            &mut ack_rx,
            assignment.expected_workspace_fingerprint.as_deref(),
            &mut head,
            &mut cancellation,
        )
        .await;
        (result, head)
    });
    (execution, events, acks, cancel)
}

async fn event(events: &mut mpsc::UnboundedReceiver<RunnerToServer>, expected: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            match events
                .recv()
                .await
                .expect("runner event channel stays open")
            {
                RunnerToServer::RunEvent {
                    event_type,
                    payload,
                    ..
                } if event_type == expected => return payload,
                RunnerToServer::RunEvent { event_type, .. } => {
                    assert!(
                        !matches!(
                            event_type.as_str(),
                            "run.verification_passed" | "run.completed"
                        ),
                        "checkpoint cannot grant final completion: {event_type}"
                    );
                }
                _ => {}
            }
        }
    })
    .await
    .expect("bounded native checkpoint event")
}

fn ack(fixture: &Fixture, upload: &Value, artifact_id: Uuid, role: &str) -> ArtifactAck {
    ArtifactAck {
        run_id: fixture.assignment.run_id,
        artifact_id,
        artifact_role: role.into(),
        sha256: upload["sha256"].as_str().unwrap().into(),
    }
}

async fn settled(execution: Execution) -> (Result<bool, CheckpointFailure>, Option<String>) {
    tokio::time::timeout(Duration::from_secs(45), execution)
        .await
        .expect("bounded runner completion")
        .unwrap()
}

fn native_git(root: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native fixture Git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[tokio::test]
async fn active_checkpoint_storage_and_unrelated_remote_acks_do_not_release_final_verification() {
    let fixture = fixture().await;
    let (execution, mut events, acks, _cancel) = start(&fixture);
    let upload = event(&mut events, "run.checkpoint_upload").await;
    let artifact = Uuid::new_v4();
    assert_eq!(upload["publication_ready"], false);
    assert_eq!(upload["purpose"], "active_checkpoint");
    assert_eq!(
        upload["verification_policy"],
        serde_json::to_value(&fixture.assignment.verification_policy).unwrap()
    );
    let bytes = BASE64
        .decode(upload["content_base64"].as_str().unwrap())
        .unwrap();
    assert_eq!(hex::encode(sha2::Sha256::digest(&bytes)), upload["sha256"]);
    let document: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        document["parent_commit"],
        fixture.assignment.expected_head_commit.as_deref().unwrap()
    );
    assert_ne!(
        document["source_verification"]["candidate_commit"],
        document["parent_commit"]
    );
    acks.send(ack(&fixture, &upload, artifact, "remote_source_checkpoint"))
        .unwrap();
    acks.send(ack(&fixture, &upload, artifact, "source_checkpoint"))
        .unwrap();
    event(&mut events, "run.checkpoint_poll").await;
    assert!(
        !execution.is_finished(),
        "storage alone is not a remote durability receipt"
    );
    for mismatch in ["run", "artifact", "digest", "role"] {
        let mut wrong = ack(&fixture, &upload, artifact, "remote_source_checkpoint");
        match mismatch {
            "run" => wrong.run_id = Uuid::new_v4(),
            "artifact" => wrong.artifact_id = Uuid::new_v4(),
            "digest" => wrong.sha256 = "0".repeat(64),
            "role" => wrong.artifact_role = "source_deliverable".into(),
            _ => unreachable!(),
        }
        acks.send(wrong).unwrap();
    }
    // This storage replay is an ordering barrier after all rejected ACKs.
    acks.send(ack(&fixture, &upload, artifact, "source_checkpoint"))
        .unwrap();
    event(&mut events, "run.checkpoint_poll").await;
    assert!(!execution.is_finished());
    acks.send(ack(&fixture, &upload, artifact, "remote_source_checkpoint"))
        .unwrap();
    let (result, head) = settled(execution).await;
    assert!(result.unwrap_or_else(|failure| panic!("{:#}", failure.error)));
    assert_eq!(head.as_deref(), upload["head_commit"].as_str());
    assert_eq!(
        fixture
            .manager
            .head_commit(&fixture.workspace)
            .await
            .unwrap(),
        head.unwrap()
    );
    assert_eq!(
        fixture
            .manager
            .fingerprint(&fixture.workspace)
            .await
            .unwrap(),
        fixture
            .assignment
            .expected_workspace_fingerprint
            .as_deref()
            .unwrap()
    );
    assert_eq!(
        std::fs::read(fixture.root.join("source/sentinel.txt")).unwrap(),
        b"preserve exact bytes\n"
    );
    assert!(!fixture.root.join("source/result.md").exists());
    crate::tests::assert_no_verification_snapshots(fixture.assignment.run_id);
}

#[tokio::test]
async fn active_checkpoint_cancellation_preserves_exported_source_without_releasing_verification() {
    let fixture = fixture().await;
    let (execution, mut events, acks, cancel) = start(&fixture);
    let upload = event(&mut events, "run.checkpoint_upload").await;
    acks.send(ack(&fixture, &upload, Uuid::new_v4(), "source_checkpoint"))
        .unwrap();
    event(&mut events, "run.checkpoint_poll").await;
    cancel.send(true).unwrap();
    let (result, head) = settled(execution).await;
    assert!(!result.unwrap_or_else(|failure| panic!("{:#}", failure.error)));
    assert_eq!(head.as_deref(), upload["head_commit"].as_str());
    assert_eq!(
        fixture
            .manager
            .head_commit(&fixture.workspace)
            .await
            .unwrap(),
        head.unwrap()
    );
    assert_eq!(
        std::fs::read(fixture.workspace.path.join("result.md")).unwrap(),
        b"active source\n"
    );
    crate::tests::assert_no_verification_snapshots(fixture.assignment.run_id);
}

#[tokio::test]
async fn active_checkpoint_ack_channel_loss_is_a_preserved_source_failure() {
    let fixture = fixture().await;
    let (execution, mut events, acks, _cancel) = start(&fixture);
    let upload = event(&mut events, "run.checkpoint_upload").await;
    drop(acks);
    let (result, head) = settled(execution).await;
    let failure = match result {
        Err(failure) => failure,
        Ok(_) => panic!("closed channel cannot authorize full verification"),
    };
    assert!(!failure.integrity);
    assert!(
        failure
            .error
            .to_string()
            .contains("acknowledgment channel closed")
    );
    assert_eq!(head.as_deref(), upload["head_commit"].as_str());
    assert_eq!(
        fixture
            .manager
            .head_commit(&fixture.workspace)
            .await
            .unwrap(),
        head.unwrap()
    );
    crate::tests::assert_no_verification_snapshots(fixture.assignment.run_id);
}

#[tokio::test]
async fn active_checkpoint_rejects_source_or_head_drift_without_resealing_it() {
    for drift in ["source", "head"] {
        let fixture = fixture().await;
        let (execution, mut events, acks, _cancel) = start(&fixture);
        let upload = event(&mut events, "run.checkpoint_upload").await;
        if drift == "source" {
            std::fs::write(
                fixture.workspace.path.join("result.md"),
                b"unverified later source\n",
            )
            .unwrap();
        } else {
            native_git(
                &fixture.workspace.path,
                &[
                    "-c",
                    "user.name=ECorp Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "commit",
                    "--no-gpg-sign",
                    "--allow-empty",
                    "-m",
                    "unverified later HEAD",
                ],
            );
        }
        acks.send(ack(&fixture, &upload, Uuid::new_v4(), "source_checkpoint"))
            .unwrap();
        let (result, head) = settled(execution).await;
        let failure = match result {
            Err(failure) => failure,
            Ok(_) => panic!("drift must prevent verifier release"),
        };
        assert!(failure.integrity, "{drift}: {:#}", failure.error);
        assert_eq!(
            head.as_deref(),
            upload["head_commit"].as_str(),
            "never adopt unverified HEAD during cleanup"
        );
        assert!(fixture.workspace.path.exists());
        crate::tests::assert_no_verification_snapshots(fixture.assignment.run_id);
    }
}

#[tokio::test]
async fn active_checkpoint_focus_failure_never_commits_or_uploads() {
    let mut fixture = fixture().await;
    fixture.assignment.active_checkpoint = Some(ActiveCheckpointPolicy {
        check_indices: vec![1],
    });
    let (execution, mut events, _acks, _cancel) = start(&fixture);
    let (result, head) = settled(execution).await;
    assert!(result.is_err());
    assert_eq!(head, fixture.assignment.expected_head_commit);
    assert_eq!(
        fixture
            .manager
            .head_commit(&fixture.workspace)
            .await
            .unwrap(),
        head.unwrap()
    );
    assert!(
        events.try_recv().is_err(),
        "a failed focused check cannot upload checkpoint source"
    );
    assert_eq!(
        std::fs::read(fixture.workspace.path.join("result.md")).unwrap(),
        b"active source\n"
    );
    crate::tests::assert_no_verification_snapshots(fixture.assignment.run_id);
}

#[tokio::test]
async fn active_checkpoint_reuses_the_actual_nonempty_committed_head() {
    let mut fixture = fixture().await;
    native_git(&fixture.workspace.path, &["add", "--", "result.md"]);
    native_git(
        &fixture.workspace.path,
        &[
            "-c",
            "user.name=ECorp Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--no-gpg-sign",
            "-m",
            "provider's existing source commit",
        ],
    );
    let original = fixture
        .manager
        .head_commit(&fixture.workspace)
        .await
        .unwrap();
    fixture.assignment.expected_head_commit = Some(original.clone());
    let (execution, mut events, acks, _cancel) = start(&fixture);
    let upload = event(&mut events, "run.checkpoint_upload").await;
    assert_eq!(upload["head_commit"], original);
    assert_eq!(upload["parent_commit"], original);
    let artifact = Uuid::new_v4();
    acks.send(ack(&fixture, &upload, artifact, "source_checkpoint"))
        .unwrap();
    acks.send(ack(&fixture, &upload, artifact, "remote_source_checkpoint"))
        .unwrap();
    let (result, head) = settled(execution).await;
    assert!(result.unwrap_or_else(|failure| panic!("{:#}", failure.error)));
    assert_eq!(head, Some(original));
}

#[tokio::test]
async fn active_checkpoint_rejects_empty_history_before_upload() {
    let mut fixture = fixture().await;
    std::fs::remove_file(fixture.workspace.path.join("result.md")).unwrap();
    fixture.assignment.write_scope = vec!["sentinel.txt".into()];
    fixture.assignment.deliverable.as_mut().unwrap().paths = vec!["sentinel.txt".into()];
    native_git(
        &fixture.workspace.path,
        &[
            "-c",
            "user.name=ECorp Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--no-gpg-sign",
            "--allow-empty",
            "-m",
            "empty provider checkpoint",
        ],
    );
    fixture.assignment.verification_policy.checks[0] = VerifierCheck::File {
        path: "sentinel.txt".into(),
        min_bytes: 1,
    };
    fixture.assignment.expected_head_commit = Some(
        fixture
            .manager
            .head_commit(&fixture.workspace)
            .await
            .unwrap(),
    );
    fixture.assignment.expected_workspace_fingerprint = Some(
        fixture
            .manager
            .fingerprint(&fixture.workspace)
            .await
            .unwrap(),
    );
    let result = deliverable::prepare_checkpoint(
        fixture.assignment.run_id,
        fixture.assignment.deliverable.as_ref().unwrap(),
        &fixture.workspace,
        &[],
        &fixture.assignment.write_scope,
        fixture.assignment.active_checkpoint.as_ref().unwrap(),
        &fixture.assignment.verification_policy,
    )
    .await;
    assert!(
        result.is_err(),
        "empty history must fail locally before the publisher rejects the unchanged source tree"
    );
    assert_eq!(
        fixture
            .manager
            .head_commit(&fixture.workspace)
            .await
            .unwrap(),
        fixture.assignment.expected_head_commit.as_deref().unwrap()
    );
    crate::tests::assert_no_verification_snapshots(fixture.assignment.run_id);
}

#[tokio::test]
async fn active_checkpoint_rejects_reverted_source_without_rewriting_history() {
    let mut fixture = fixture().await;
    native_git(&fixture.workspace.path, &["add", "--", "result.md"]);
    native_git(
        &fixture.workspace.path,
        &[
            "-c",
            "user.name=ECorp Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--no-gpg-sign",
            "-m",
            "provider source before its revert",
        ],
    );
    native_git(
        &fixture.workspace.path,
        &[
            "-c",
            "user.name=ECorp Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "revert",
            "--no-edit",
            "HEAD",
        ],
    );
    let original = fixture
        .manager
        .head_commit(&fixture.workspace)
        .await
        .unwrap();
    assert_ne!(original, fixture.workspace.base_commit);
    assert_eq!(
        native_git(&fixture.workspace.path, &["rev-parse", "HEAD^{tree}"]),
        native_git(
            &fixture.workspace.path,
            &[
                "rev-parse",
                &format!("{}^{{tree}}", fixture.workspace.base_commit)
            ],
        )
    );
    fixture.assignment.write_scope = vec!["sentinel.txt".into()];
    fixture.assignment.deliverable.as_mut().unwrap().paths = vec!["sentinel.txt".into()];
    let result = deliverable::prepare_checkpoint(
        fixture.assignment.run_id,
        fixture.assignment.deliverable.as_ref().unwrap(),
        &fixture.workspace,
        &[],
        &fixture.assignment.write_scope,
        fixture.assignment.active_checkpoint.as_ref().unwrap(),
        &fixture.assignment.verification_policy,
    )
    .await;
    assert!(
        result.is_err(),
        "reverted history has no publishable source change"
    );
    assert_eq!(
        fixture
            .manager
            .head_commit(&fixture.workspace)
            .await
            .unwrap(),
        original
    );
    assert!(!fixture.workspace.path.join("result.md").exists());
    assert!(native_git(&fixture.workspace.path, &["status", "--porcelain"]).is_empty());
    crate::tests::assert_no_verification_snapshots(fixture.assignment.run_id);
}
