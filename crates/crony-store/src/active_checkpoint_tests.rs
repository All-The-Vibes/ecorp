//! Source and transition regressions. Synthetic metadata is not remote publication evidence.
use super::*;
use crony_domain::{ManualVerificationGate, SourceVerification, VerifierCheck};

#[path = "active_checkpoint_native_tests.rs"]
mod native;

const CORP: Uuid = Uuid::from_u128(72);
const OWNER: Uuid = Uuid::from_u128(73);
const ITEM: Uuid = Uuid::from_u128(74);
const MISSION: Uuid = Uuid::from_u128(75);
const TASK: Uuid = Uuid::from_u128(76);
const RUN: Uuid = Uuid::from_u128(77);
const ARTIFACT: Uuid = Uuid::from_u128(78);

fn full_policy() -> VerificationPolicy {
    VerificationPolicy {
        checks: vec![
            VerifierCheck::File {
                path: "result.md".into(),
                min_bytes: 1,
            },
            VerifierCheck::Test {
                program: "cargo".into(),
                args: vec!["test".into()],
                timeout_ms: 600_000,
                cache_suppression: None,
            },
        ],
        manual_gate: Some(ManualVerificationGate::IndependentReview {
            roles: vec!["manager".into()],
            exclude_requester: true,
        }),
    }
}

fn item() -> FactoryWorkItem {
    FactoryWorkItem {
        id: ITEM,
        corp_id: CORP,
        source_kind: "github_project_issue".into(),
        source_project_owner: "fixture".into(),
        source_project_number: 72,
        source_project_item_id: "PVTI_fixture72".into(),
        source_repository_owner: "fixture".into(),
        source_repository_name: "source".into(),
        source_issue_number: 72,
        source_issue_node_id: "I_fixture72".into(),
        source_issue_url: "https://github.com/fixture/source/issues/72".into(),
        source_title: "Preserve active work".into(),
        source_revision: "revision-1".into(),
        state: FactoryWorkItemState::Running,
        version: 3,
        claim_owner_id: OWNER,
        lease_expires_at: Utc::now() + Duration::hours(1),
        policy: json!({
            "strategy_allowlist":["single"], "deliverable_form":"commit_branch",
            "auto_merge":false, "source_base_commit":"a".repeat(40),
            "verification_policy":full_policy(), "active_checkpoint":{"check_indices":[0]},
            "publication":{
                "allowed":true, "auto_merge":false, "merge":false, "deploy":false,
                "base_ref":"main", "branch_prefix":"codex/", "repository_allowlist":["fixture/source"],
                "status_before":"In Progress", "review_status":"In Review"
            }
        }),
        mission_id: Some(MISSION),
        failure_detail: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

fn metadata() -> Value {
    let source = SourceVerification {
        base_commit: "a".repeat(40),
        tree: "b".repeat(40),
        candidate_commit: "c".repeat(40),
        ignored_input_sha256: "d".repeat(64),
        ignored_input_count: 1,
        ignored_input_bytes: 10,
    };
    json!({
        "purpose":"active_checkpoint", "publication_ready":false, "integration_state":"checkpoint_pending",
        "form":"commit_branch", "head_commit":"e".repeat(40), "parent_commit":"a".repeat(40),
        "base_commit":source.base_commit, "branch":"crony/fixture72", "verified_tree":source.tree,
        "source_verification":source, "checkpoint_policy":{"check_indices":[0]},
        "verification_policy":full_policy(),
        "checkpoint_report":{
            "passed":true, "manual_gate":null, "source":source,
            "checks":[{"check_index":0,"kind":"file","passed":true}]
        }
    })
}

fn publication() -> ActiveCheckpointPublication {
    let item = item();
    let metadata = metadata();
    ActiveCheckpointPublication {
        id: Uuid::new_v4(),
        corp_id: CORP,
        work_item_id: ITEM,
        mission_id: MISSION,
        task_id: TASK,
        run_id: RUN,
        artifact_id: ARTIFACT,
        artifact_sha256: "f".repeat(64),
        metadata: metadata.clone(),
        target_repository: "fixture/source".into(),
        base_ref: "main".into(),
        pull_request_base_ref: None,
        branch: branch_for(&item).unwrap(),
        commit_sha: "e".repeat(40),
        previous_commit_sha: None,
        previous_pull_request: None,
        title: "Draft checkpoint for issue #72".into(),
        body: render_draft_body(
            &item,
            RUN,
            &metadata,
            &"f".repeat(64),
            "running",
            None,
            &[],
            None,
        )
        .unwrap(),
        phase: "pending".into(),
        version: 1,
        actor_id: OWNER,
        publisher_id: "fixture-publisher".into(),
        lease_expires_at: Utc::now() + Duration::seconds(120),
        failure_detail: None,
        pull_request: None,
        created_at: Utc::now(),
    }
}

fn final_metadata() -> Value {
    let mut metadata = metadata();
    metadata["source_verification"]["candidate_commit"] = json!("1".repeat(40));
    metadata["source_verification"]["ignored_input_sha256"] = json!("2".repeat(64));
    metadata["source_verification"]["ignored_input_count"] = json!(2);
    metadata["source_verification"]["ignored_input_bytes"] = json!(20);
    metadata
}

fn evidence(metadata: &Value) -> Vec<CheckpointGateEvidence> {
    full_policy()
        .checks
        .iter()
        .enumerate()
        .map(|(index, check)| CheckpointGateEvidence {
            index: index as i32,
            kind: check.kind().into(),
            status: "passed".into(),
            payload: json!({"source":metadata["source_verification"]}),
        })
        .collect()
}

#[test]
fn active_checkpoint_reports_focused_success_without_final_or_review_authority() {
    let p = publication();
    assert!(
        p.body
            .contains("| 0 (file) | passed (focused checkpoint only) |")
    );
    assert!(p.body.contains("| 1 (test) | pending |"));
    assert!(
        p.body
            .contains("| Complete immutable verification policy | pending |")
    );
    assert!(
        p.body
            .contains("| Persisted manual verification gate | pending |")
    );
    assert!(p.body.contains("| Merge authorization | not granted |"));
    assert!(
        p.body
            .contains("| Deployment authorization | not granted |")
    );
    assert!(p.receipt().is_none());
}

#[test]
fn active_checkpoint_gates_keep_distinct_focused_and_final_invocation_identities() {
    let final_source = final_metadata();
    let event = ("run.verification_passed".into(), final_source.clone());
    let rows = evidence(&final_source);
    for review in [None, Some("approved"), Some("rejected")] {
        let body = render_draft_body(
            &item(),
            RUN,
            &metadata(),
            &"f".repeat(64),
            "verifying",
            Some(&event),
            &rows,
            review,
        )
        .unwrap();
        assert!(body.contains("| 1 (test) | passed |"));
        assert!(body.contains("| Complete immutable verification policy | passed |"));
        assert!(body.contains(&format!(
            "| Persisted manual verification gate | {} |",
            review.unwrap_or("pending")
        )));
        assert!(body.contains(&format!("Focused verifier candidate: {}", "c".repeat(40))));
        assert!(body.contains(&format!("Final verifier candidate: {}", "1".repeat(40))));
        assert!(body.contains(&format!("Final ignored-input SHA-256: {}", "2".repeat(64))));
        assert!(body.contains("separate final publication required"));
    }
}

#[test]
fn active_checkpoint_never_promotes_incomplete_duplicate_or_mixed_final_evidence() {
    let final_source = final_metadata();
    let event = ("run.verification_passed".into(), final_source.clone());
    for corruption in [
        "missing",
        "duplicate",
        "extra",
        "kind",
        "status",
        "candidate",
        "ignored",
        "tree",
    ] {
        let mut rows = evidence(&final_source);
        match corruption {
            "missing" => {
                rows.pop();
            }
            "duplicate" => rows.push(evidence(&final_source).remove(1)),
            "extra" => {
                let mut extra = evidence(&final_source).remove(1);
                extra.index = 9;
                rows.push(extra);
            }
            "kind" => rows[1].kind = "file".into(),
            "status" => rows[1].status = "pending".into(),
            "candidate" => rows[1].payload["source"]["candidate_commit"] = json!("c".repeat(40)),
            "ignored" => rows[1].payload["source"]["ignored_input_sha256"] = json!("d".repeat(64)),
            "tree" => rows[1].payload["source"]["tree"] = json!("3".repeat(40)),
            _ => unreachable!(),
        }
        let body = render_draft_body(
            &item(),
            RUN,
            &metadata(),
            &"f".repeat(64),
            "verifying",
            Some(&event),
            &rows,
            Some("approved"),
        )
        .unwrap();
        assert!(
            body.contains("| Complete immutable verification policy | pending |"),
            "{corruption}: {body}"
        );
        assert!(
            body.contains("| Persisted manual verification gate | pending |"),
            "{corruption}"
        );
    }
}

#[test]
fn active_checkpoint_failed_final_gate_is_bound_to_the_observed_source() {
    let mut final_source = final_metadata();
    let mut rows = evidence(&final_source);
    rows[1].status = "failed".into();
    let event = ("run.verification_failed".into(), final_source.clone());
    let body = render_draft_body(
        &item(),
        RUN,
        &metadata(),
        &"f".repeat(64),
        "failed",
        Some(&event),
        &rows,
        Some("approved"),
    )
    .unwrap();
    assert!(body.contains("| 1 (test) | failed |"));
    assert!(body.contains("| Complete immutable verification policy | failed |"));
    final_source["source_verification"]["base_commit"] = json!("4".repeat(40));
    final_source["base_commit"] = json!("4".repeat(40));
    let event = ("run.verification_failed".into(), final_source);
    let body = render_draft_body(
        &item(),
        RUN,
        &metadata(),
        &"f".repeat(64),
        "failed",
        Some(&event),
        &rows,
        None,
    )
    .unwrap();
    assert!(body.contains("pending; final attempt failed without matching source evidence"));
    assert!(body.contains("| 1 (test) | pending |"));
}

fn draft_action(p: &ActiveCheckpointPublication) -> ActiveCheckpointAction {
    ActiveCheckpointAction::DraftPublished {
        number: 72,
        node_id: "PR_fixture72".into(),
        url: "https://github.com/fixture/source/pull/72".into(),
        head_sha: p.commit_sha.clone(),
        head_ref: p.branch.clone(),
        base_ref: "main".into(),
        head_repository_owner: "fixture".into(),
        is_cross_repository: false,
        draft: true,
        state: "OPEN".into(),
        auto_merge_enabled: false,
        title: p.title.clone(),
        body: p.body.clone(),
    }
}

fn project_action() -> ActiveCheckpointAction {
    ActiveCheckpointAction::ProjectSynchronized {
        status: "In Progress".into(),
        field_id: "PVTSSF_fixture".into(),
        option_id: "in-progress".into(),
    }
}

#[test]
fn active_checkpoint_requires_remote_draft_before_project_sync_and_receipt() {
    let item = item();
    let mut p = publication();
    for phase in ["pending", "branch_pushed"] {
        p.phase = phase.into();
        let before = serde_json::to_value(&p).unwrap();
        assert!(apply_action(&mut p, &project_action(), &item).is_err());
        assert_eq!(serde_json::to_value(&p).unwrap(), before);
        assert!(p.receipt().is_none());
    }
    p.pull_request_base_ref = Some("main".into());
    let action = draft_action(&p);
    apply_action(&mut p, &action, &item).unwrap();
    let receipt = p
        .receipt()
        .expect("only remote draft proof makes source durable");
    assert_eq!(receipt.artifact_id, ARTIFACT);
    assert_eq!(receipt.run_id, RUN);
    assert_eq!(receipt.commit_sha, p.commit_sha);
    assert!(!p.gates_synchronized());
    apply_action(&mut p, &project_action(), &item).unwrap();
    assert!(p.gates_synchronized());
    assert_eq!(p.receipt(), Some(receipt));
}

#[test]
fn active_checkpoint_draft_proof_rejects_wrong_identity_authority_or_human_edits() {
    let item = item();
    let mut p = publication();
    p.phase = "branch_pushed".into();
    p.pull_request_base_ref = Some("main".into());
    let action = serde_json::to_value(draft_action(&p)).unwrap();
    for (field, value) in [
        ("draft", json!(false)),
        ("auto_merge_enabled", json!(true)),
        ("state", json!("CLOSED")),
        ("head_sha", json!("0".repeat(40))),
        ("head_ref", json!("someone-else")),
        ("base_ref", json!("release")),
        ("head_repository_owner", json!("other")),
        ("is_cross_repository", json!(true)),
        ("url", json!("https://github.com/other/source/pull/72")),
        ("title", json!("Human title")),
        ("body", json!("Human review notes")),
    ] {
        let mut bad = action.clone();
        bad[field] = value;
        let bad = serde_json::from_value(bad).unwrap();
        let before = serde_json::to_value(&p).unwrap();
        assert!(apply_action(&mut p, &bad, &item).is_err(), "{field}");
        assert_eq!(serde_json::to_value(&p).unwrap(), before, "{field}");
    }
    p.previous_pull_request = Some(json!({"number":71,"node_id":"PR_other"}));
    assert!(apply_action(&mut p, &serde_json::from_value(action).unwrap(), &item).is_err());
}

#[test]
fn active_checkpoint_remote_branch_and_resolved_base_are_stable() {
    let item = item();
    let mut p = publication();
    assert_eq!(p.branch, branch_for(&item).unwrap());
    let branch = p.branch.clone();
    let commit = p.commit_sha.clone();
    for base in ["HEAD", "refs/heads/main", "release", branch.as_str()] {
        assert!(
            apply_action(
                &mut p,
                &ActiveCheckpointAction::BranchPushed {
                    commit_sha: commit.clone(),
                    base_ref: base.into(),
                },
                &item
            )
            .is_err()
        );
        assert_eq!(p.phase, "pending");
    }
    apply_action(
        &mut p,
        &ActiveCheckpointAction::BranchPushed {
            commit_sha: commit,
            base_ref: "main".into(),
        },
        &item,
    )
    .unwrap();
    assert_eq!(p.pull_request_base_ref.as_deref(), Some("main"));
    let mut changed = item.clone();
    changed.policy["publication"]["merge"] = json!(true);
    assert!(branch_for(&changed).is_err());
}

#[test]
fn active_checkpoint_final_adoption_retains_scope_commit_tree_and_complete_policy() {
    let p = publication();
    let item = item();
    let metadata = final_metadata();
    let policy = full_policy();
    let source = FinalCheckpointSource {
        task_id: TASK,
        run_id: RUN,
        commit: &p.commit_sha,
        branch: "crony/fixture72",
        metadata: &metadata,
        verification_policy: &policy,
    };
    validate_final_source(&p, &item, &source)
        .expect("independent verifier candidates retain one canonical source");
    for field in [
        "corp_id",
        "work_item_id",
        "mission_id",
        "task_id",
        "run_id",
        "commit_sha",
    ] {
        let mut altered = serde_json::to_value(&p).unwrap();
        altered[field] = if field == "commit_sha" {
            json!("0".repeat(40))
        } else {
            json!(Uuid::new_v4())
        };
        let altered = serde_json::from_value(altered).unwrap();
        assert!(
            validate_final_source(&altered, &item, &source).is_err(),
            "{field}"
        );
    }
    for field in ["tree", "base_commit"] {
        let mut changed = metadata.clone();
        changed["source_verification"][field] = json!("0".repeat(40));
        changed[if field == "tree" {
            "verified_tree"
        } else {
            "base_commit"
        }] = json!("0".repeat(40));
        assert!(
            validate_final_source(
                &p,
                &item,
                &FinalCheckpointSource {
                    metadata: &changed,
                    ..source
                }
            )
            .is_err(),
            "{field}"
        );
    }
    let mut weaker = policy.clone();
    weaker.checks.pop();
    assert!(
        validate_final_source(
            &p,
            &item,
            &FinalCheckpointSource {
                verification_policy: &weaker,
                ..source
            }
        )
        .is_err()
    );
    assert!(
        validate_final_source(
            &p,
            &item,
            &FinalCheckpointSource {
                branch: "other-source",
                ..source
            }
        )
        .is_err()
    );
}

#[test]
fn active_checkpoint_frozen_provenance_cannot_be_added_removed_or_reinterpreted() {
    let p = publication();
    let original = json!({"active_checkpoint":p});
    validate_frozen_provenance(&original, Some(&p)).unwrap();
    validate_frozen_provenance(&json!({}), None).unwrap();
    assert!(validate_frozen_provenance(&json!({}), Some(&p)).is_err());
    assert!(validate_frozen_provenance(&original, None).is_err());
    let mut changed = original.clone();
    changed["active_checkpoint"]["version"] = json!(p.version + 1);
    assert!(validate_frozen_provenance(&changed, Some(&p)).is_err());
}

#[test]
fn active_checkpoint_idempotency_snapshot_never_persists_lease_credentials() {
    let token = Uuid::new_v4();
    let request = ActiveCheckpointRequest {
        actor_id: OWNER,
        artifact_id: ARTIFACT,
        publisher_id: "fixture-publisher".into(),
        idempotency_key: Uuid::new_v4(),
        expected_version: Some(1),
        publisher_token: Some(token),
        action: ActiveCheckpointAction::Renew,
    };
    let snapshot = operation_snapshot(&request).unwrap();
    assert!(snapshot.get("publisher_token").is_none());
    assert!(!snapshot.to_string().contains(&token.to_string()));
    assert_eq!(
        snapshot["publisher_token_sha256"],
        hex::encode(Sha256::digest(token.as_bytes()))
    );
}
