use crony_audit::*;
use serde_json::json;

fn bundle() -> (DecisionBundle, SigningKey) {
    let mission = "00000000-0000-4000-8000-000000000010";
    let resource = format!("mission/{mission}/governance");
    let content = Object::new(
        "content",
        json!({
            "schema_version":1,
            "ledger_id":"ledger",
            "corp_id":"00000000-0000-4000-8000-000000000001",
            "mission_id":mission,
            "room_id":"00000000-0000-4000-8000-000000000002",
            "requested_by":"00000000-0000-4000-8000-000000000003",
            "resource_key":resource,
            "description_digest":"11".repeat(32),
            "specification_version":1,
            "budget_tokens":100,
            "budget_cost_microusd":1000,
            "tasks":[],
            "pending_budget_proposals":[]
        }),
    )
    .unwrap();
    let version = Object::new("version", json!({"schema_version":1,"ledger_id":"ledger","resource_key":resource,"content_hash":content.hash,"parents":[],"actor":"actor","recorded_at":0,"provenance_assertions":[],"observed_execution_context":null,"evidence_references":[]})).unwrap();
    let policy = Object::new("policy", json!({"schema_version":1,"evaluator_version":"native-mission-governance-v1","authority":"native-mission-contract-and-budget-rules","coverage":"mission-governance-v1"})).unwrap();
    let decision = Decision {
        schema_version: 1,
        ledger_id: "ledger".into(),
        sequence: 1,
        previous_row_hash: None,
        actor: "actor".into(),
        operation: "baseline".into(),
        recorded_at: 0,
        request_id: "request".into(),
        request_digest: "33".repeat(32),
        decision: "baseline".into(),
        reason_code: "coverage_started".into(),
        policy_hash: policy.hash.clone(),
        evaluator_version: "native-mission-governance-v1".into(),
        changes: vec![Change {
            resource_key: resource,
            before: None,
            after: version.hash.clone(),
            before_revision: 0,
            after_revision: 1,
        }],
        correlation_id: "mission".into(),
        causation_id: None,
    };
    (
        DecisionBundle::new(decision, vec![content, version, policy]).unwrap(),
        SigningKey::from_bytes(&[7; 32]),
    )
}

#[test]
fn history_replays_and_rejects_tampering_missing_objects_and_false_baselines() {
    let (bundle, _) = bundle();
    let mut v = HistoryVerifier::new("ledger");
    v.push(&bundle).unwrap();
    assert_eq!(v.sequence(), 1);
    assert!(v.push(&bundle).is_err());
    let mut tampered = bundle.clone();
    tampered.decision.actor = "other".into();
    assert!(HistoryVerifier::new("ledger").push(&tampered).is_err());
    let mut missing = bundle.clone();
    missing.objects.remove(0);
    assert!(HistoryVerifier::new("ledger").push(&missing).is_err());
    assert!(HistoryVerifier::new("foreign").push(&bundle).is_err());
    let mut not_baseline = bundle;
    not_baseline.decision.decision = "accepted".into();
    let rehashed = DecisionBundle::new(not_baseline.decision, not_baseline.objects).unwrap();
    assert!(HistoryVerifier::new("ledger").push(&rehashed).is_err());
}

#[test]
fn verifier_rejects_broken_parent_and_revision_even_when_rehashed() {
    let (first, _) = bundle();
    let mut second = first.clone();
    second.decision.sequence = 2;
    second.decision.previous_row_hash = Some(first.row_hash.clone());
    second.decision.decision = "accepted".into();
    second.decision.operation = "contract_revision".into();
    second.decision.request_id = "second".into();
    second.decision.changes[0].before = Some(first.decision.changes[0].after.clone());
    second.decision.changes[0].before_revision = 1;
    second.decision.changes[0].after_revision = 2;
    let second = DecisionBundle::new(second.decision, second.objects).unwrap();
    let mut verifier = HistoryVerifier::new("ledger");
    verifier.push(&first).unwrap();
    assert!(verifier.push(&second).is_err()); // version still claims no parent
}

#[test]
fn verifier_accepts_source_commit_upgrade_as_a_covered_operation() {
    let (first, _) = bundle();
    let policy = first
        .objects
        .iter()
        .find(|object| object.kind == "policy")
        .unwrap()
        .clone();
    let second = DecisionBundle::new(
        Decision {
            schema_version: 1,
            ledger_id: "ledger".into(),
            sequence: 2,
            previous_row_hash: Some(first.row_hash.clone()),
            actor: "actor".into(),
            operation: "source_commit_upgrade".into(),
            recorded_at: 1,
            request_id: "source-upgrade".into(),
            request_digest: "44".repeat(32),
            decision: "refused".into(),
            reason_code: "native_policy_refused".into(),
            policy_hash: policy.hash.clone(),
            evaluator_version: "native-mission-governance-v1".into(),
            changes: vec![],
            correlation_id: "mission".into(),
            causation_id: None,
        },
        vec![policy],
    )
    .unwrap();
    let mut verifier = HistoryVerifier::new("ledger");
    verifier.push(&first).unwrap();
    verifier.push(&second).unwrap();
}
