use super::*;
use crony_domain::PlannedTask;

const RUNNER: &str = "issue89-owned-runner";

struct Fixture {
    store: PgStore,
    ids: DemoIds,
    launch: LaunchRecord,
    epoch: Uuid,
}

async fn fixture(pool: PgPool) -> Result<Fixture> {
    let store = PgStore { pool };
    let (ids, _) = store.bootstrap_demo().await?;
    let token = hex::encode(Sha256::digest(Uuid::new_v4().as_bytes()));
    let credential = hex::encode(Sha256::digest(Uuid::new_v4().as_bytes()));
    let expires = Utc::now() + Duration::minutes(5);
    store
        .create_runner_enrollment(ids.corp_id, ids.alice_actor_id, RUNNER, &token, expires)
        .await?;
    store
        .authenticate_and_rotate_runner(ids.corp_id, RUNNER, &token, &credential, expires)
        .await?;
    let epoch = Uuid::new_v4();
    store
        .runner_connected(RunnerConnectInput {
            id: RUNNER.to_owned(),
            corp_id: ids.corp_id,
            hostname: "owned-fixture".to_owned(),
            os: "windows".to_owned(),
            capabilities: json!([]),
            connection_epoch: epoch,
        })
        .await?;
    let plan = TaskGraphPlan {
        strategy: "single".to_owned(),
        max_nodes: 1,
        max_depth: 0,
        budget_tokens: 1_000,
        budget_cost_microusd: 1_000_000,
        staffing: Vec::new(),
        tasks: vec![PlannedTask {
            key: "scenario".to_owned(),
            title: "Preserved scenario".to_owned(),
            assigned_agent_id: ids.worker_agent_id,
            required_adapter: "fake-process".to_owned(),
            depends_on: Vec::new(),
            depth: 0,
            max_attempts: 2,
            contract: TaskContract {
                workspace_connection_id: None,
                objective: "Correct scenario evidence".to_owned(),
                expected_output: "scenarios/scope-89/EVIDENCE.md".to_owned(),
                source_repository: None,
                source_base_ref: None,
                source_base_commit: None,
                acceptance_tests: vec!["Evidence exists".to_owned()],
                allowed_tools: vec!["filesystem".to_owned()],
                prohibited_actions: vec!["Do not discard retained source".to_owned()],
                references: Vec::new(),
                write_scope: vec!["scenarios/scope-89/EVIDENCE.md".to_owned()],
                budget_tokens: 1_000,
                budget_cost_microusd: 1_000_000,
                deadline_at: None,
                escalation: "Ask the operator".to_owned(),
                secret_refs: Vec::new(),
                model: None,
                reasoning_effort: None,
                deliverable: Some(DeliverableSpec {
                    form: DeliverableForm::CommitBranch,
                    commit_after_verification: true,
                    paths: Vec::new(),
                }),
            },
            verification_policy: VerificationPolicy {
                checks: vec![VerifierCheck::File {
                    path: "scenarios/scope-89/EVIDENCE.md".to_owned(),
                    min_bytes: 1,
                }],
                manual_gate: None,
            },
        }],
    };
    let (mission, _) = store
        .create_mission(
            ids.corp_id,
            ids.alice_actor_id,
            "Issue 89",
            "Retry regression",
            &plan,
        )
        .await?;
    let (launch, _) = store
        .create_task_run(
            ids.corp_id,
            mission.mission_id,
            mission.task_ids[0],
            Some(ids.alice_actor_id),
            RUNNER,
        )
        .await?;
    let fixture = Fixture {
        store,
        ids,
        launch,
        epoch,
    };
    for (kind, payload) in [
        (
            "run.started",
            json!({
                "workspace":"owned-native-workspace", "workspace_branch":"crony/issue89",
                "workspace_base_ref":"main", "workspace_base_commit":"a".repeat(40)
            }),
        ),
        ("run.verification_started", json!({"check_count":1})),
        (
            "run.verification_evidence",
            json!({
                "evidence_id":Uuid::new_v4(),"check_index":0,"kind":"file",
                "status":"passed","summary":"Evidence exists","payload":{}
            }),
        ),
    ] {
        fixture
            .store
            .apply_runner_event(fixture.event(kind, payload))
            .await?;
    }
    Ok(fixture)
}

impl Fixture {
    fn event(&self, kind: &str, payload: Value) -> RunnerEventInput {
        RunnerEventInput {
            event_id: Uuid::new_v4(),
            runner_id: RUNNER.to_owned(),
            corp_id: self.ids.corp_id,
            connection_epoch: self.epoch,
            run_id: self.launch.run_id,
            agent_id: self.launch.agent_id,
            assignment_token: self.launch.assignment_token,
            event_type: kind.to_owned(),
            payload,
        }
    }

    async fn ledger(&self) -> Result<Value> {
        sqlx::query_scalar(
            "SELECT jsonb_build_object(
              'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM runs r),
              'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
              'missions',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM missions m),
              'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY seq) FROM events e),
              'evidence',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM verification_evidence v))",
        )
        .fetch_one(&self.store.pool)
        .await
        .map_err(Into::into)
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue89_export_failure_retains_history_and_cannot_schedule_fresh_retry(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let before = f.ledger().await?;
    let event = f.event("run.failed", json!({
        "failure_kind": RunFailureKind::DeliverableExport,
        "error":"Verified deliverable export failed: outside scope: scenarios/scope-89/.gitignore. Use preserved-session Resume only with complete source scope.",
    }));
    f.store.apply_runner_event(event.clone()).await?;
    let after = f.ledger().await?;
    assert_eq!(after["runs"][0]["status"], "failed");
    assert_eq!(after["tasks"][0]["status"], "failed");
    assert_eq!(after["missions"][0]["status"], "failed");
    assert_eq!(after["evidence"], before["evidence"]);
    for key in [
        "contract",
        "contract_version",
        "verification_policy",
        "attempt_count",
        "max_attempts",
    ] {
        assert_eq!(after["tasks"][0][key], before["tasks"][0][key], "{key}");
    }
    for key in [
        "workspace_run_id",
        "workspace_path",
        "workspace_branch",
        "workspace_base_commit",
        "input_tokens",
        "output_tokens",
        "cost_microusd",
        "budget_tokens_limit",
        "verification_status",
    ] {
        assert_eq!(after["runs"][0][key], before["runs"][0][key], "{key}");
    }
    assert!(
        f.store
            .schedulable_mission_ids(f.ids.corp_id)
            .await?
            .is_empty()
    );
    assert!(
        f.store
            .create_task_run(
                f.ids.corp_id,
                f.launch.mission_id,
                f.launch.task_id,
                None,
                RUNNER,
            )
            .await
            .is_err()
    );
    assert!(f.store.apply_runner_event(event).await.is_err());
    assert_eq!(
        f.ledger().await?,
        after,
        "duplicate failure must be idempotent"
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue89_untyped_execution_failure_keeps_existing_retry_policy(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    f.store
        .apply_runner_event(f.event("run.failed", json!({"error":"ordinary provider failure"})))
        .await?;
    let after = f.ledger().await?;
    assert_eq!(after["tasks"][0]["status"], "ready");
    assert_eq!(after["missions"][0]["status"], "running");
    let (retry, _) = f
        .store
        .create_task_run(
            f.ids.corp_id,
            f.launch.mission_id,
            f.launch.task_id,
            None,
            RUNNER,
        )
        .await?;
    assert_ne!(retry.run_id, f.launch.run_id);
    assert_eq!(retry.attempt, 2);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue89_unknown_failure_kind_and_wrong_assignment_leave_state_unchanged(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let before = f.ledger().await?;
    for value in [json!("unknown"), json!(null), json!(true)] {
        assert!(
            f.store
                .apply_runner_event(f.event(
                    "run.failed",
                    json!({"error":"bad type","failure_kind":value}),
                ))
                .await
                .is_err()
        );
        assert_eq!(f.ledger().await?, before);
    }
    let mut event = f.event(
        "run.failed",
        json!({"failure_kind":RunFailureKind::DeliverableExport}),
    );
    event.assignment_token = Uuid::new_v4();
    assert!(f.store.apply_runner_event(event).await.is_err());
    assert_eq!(f.ledger().await?, before);
    Ok(())
}
