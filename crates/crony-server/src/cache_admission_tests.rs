//! Real handler/decoder/store admission regressions in SQLx-owned migrated databases.
//! Metadata fixtures exercise pre-dispatch rejection, not provider execution or object transfer.
use super::*;
use serde_json::Value;
use sqlx::{ConnectOptions, PgPool};

const CORP: Uuid = Uuid::from_u128(1);
const OWNER: Uuid = Uuid::from_u128(2);
const ROOM: Uuid = Uuid::from_u128(3);
const AGENT: Uuid = Uuid::from_u128(4);
const MISSION: Uuid = Uuid::from_u128(5);
const TASK: Uuid = Uuid::from_u128(6);
const SOURCE: Uuid = Uuid::from_u128(7);
const RUN: Uuid = Uuid::from_u128(8);
const ITEM: Uuid = Uuid::from_u128(9);
const RECOVERY: Uuid = Uuid::from_u128(10);
const COMMAND: Uuid = Uuid::from_u128(11);
const TOKEN: Uuid = Uuid::from_u128(12);
const EPOCH: Uuid = Uuid::from_u128(13);
const RUNNER: &str = "issue140-cache-admission-runner";

async fn fixture(pool: PgPool, mode: &str) -> Fixture {
    sqlx::raw_sql(
        r#"
        INSERT INTO corps(id,slug,name) VALUES
          ('00000000-0000-0000-0000-000000000001','issue140-cache-admission','Recovery loss fixture');
        INSERT INTO actors(id,corp_id,name,kind,role) VALUES
          ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Owner','human','owner'),
          ('00000000-0000-0000-0000-000000000014','00000000-0000-0000-0000-000000000001','Worker','agent','worker');
        INSERT INTO rooms(id,corp_id,name,purpose) VALUES
          ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','QA','SQLx-only recovery loss');
        INSERT INTO room_memberships(room_id,actor_id) VALUES
          ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
        INSERT INTO agents(id,corp_id,actor_id,name,role,adapter,status,current_run_id,accent) VALUES
          ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001',
           '00000000-0000-0000-0000-000000000014','Worker','worker','codex','working',
           '00000000-0000-0000-0000-000000000008','#123456');
        INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,budget_tokens,
                             original_budget_tokens,original_budget_cost_microusd) VALUES
          ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001',
           '00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002',
           'Recovery loss','running',1000000,1000000,5000000);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let contract = json!({
        "objective":"preserve result.md", "expected_output":"result.md",
        "source_repository":"fixture/source", "source_base_ref":"main",
        "source_base_commit":"a".repeat(40), "acceptance_tests":["result.md exists"],
        "allowed_tools":["filesystem"], "prohibited_actions":["outside worktree"],
        "references":[], "secret_refs": [{"secret_id":Uuid::from_u128(99),"env_name":"FIXTURE_MISSING_SECRET","tool":"fixture","resource":"fixture/source"}], "write_scope":["result.md"], "budget_tokens":100000,
        "budget_cost_microusd":1000000, "deadline_at":null, "escalation":"ask owner"
    });
    let policy = json!({
        "checks":[{"type":"command","program":"node","args":[],"timeout_ms":1000,"cache_suppression":"node_compile_cache"}],
        "manual_gate":null
    });
    sqlx::query(
        "INSERT INTO tasks(id,corp_id,mission_id,title,objective,status,assigned_agent_id,
                           plan_key,contract,verification_policy,attempt_count,max_attempts)
         VALUES($1,$2,$3,'Recovery','preserve result.md','running',$4,'delivery',$5,$6,2,4)",
    )
    .bind(TASK)
    .bind(CORP)
    .bind(MISSION)
    .bind(AGENT)
    .bind(contract)
    .bind(&policy)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,
                          workspace_run_id,provider_session_id,workspace_path,workspace_branch,
                          workspace_base_ref,workspace_base_commit,workspace_disposition,
                          workspace_fingerprint,verification_status,source_repository,
                          source_base_ref,source_base_commit,input_tokens,output_tokens,cost_microusd,
                          created_at)
         VALUES($1,$2,$3,$4,$5,$6,'failed',$1,'fixture-session','owned-worktree','crony/fixture',
                'main',$7,'preserved',$8,'failed','fixture/source','main',$7,11,13,17,
                now()-interval '2 minutes')",
    )
    .bind(SOURCE).bind(CORP).bind(TASK).bind(AGENT).bind(RUNNER).bind(Uuid::new_v4())
    .bind("a".repeat(40)).bind("b".repeat(64))
    .execute(&pool).await.unwrap();
    if mode != "resume" {
        sqlx::query(
            "INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,
                          workspace_run_id,resumed_from_run_id,provider_session_id,execution_mode,
                          source_repository,source_base_ref,source_base_commit,created_at)
         VALUES($1,$2,$3,$4,$5,$6,'starting',$7,$7,$8,$9,
                'fixture/source','main',$10,now()-interval '1 minute')",
        )
        .bind(RUN)
        .bind(CORP)
        .bind(TASK)
        .bind(AGENT)
        .bind(RUNNER)
        .bind(TOKEN)
        .bind(SOURCE)
        .bind((mode == "source_correction").then_some("fixture-session"))
        .bind(if mode == "verifier_only" {
            "verification_only"
        } else {
            "provider"
        })
        .bind("a".repeat(40))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO factory_work_items(id,corp_id,source_kind,source_project_owner,
              source_project_number,source_project_item_id,source_repository_owner,
              source_repository_name,source_issue_number,source_issue_node_id,source_issue_url,
              source_title,source_revision,state,version,claim_owner_id,claim_token,
              lease_expires_at,mission_id,policy)
         VALUES($1,$2,'github_project_issue','fixture',183,'item-183','fixture','source',183,
                'issue-183','https://github.com/fixture/source/issues/183','Loss fixture',
                'revision-1','running',3,$3,$4,now()+interval '1 hour',$5,'{\"fixture\":true}')",
        )
        .bind(ITEM)
        .bind(CORP)
        .bind(OWNER)
        .bind(Uuid::from_u128(15))
        .bind(MISSION)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO factory_verification_recoveries(id,corp_id,factory_work_item_id,
              mission_id,task_id,source_run_id,replacement_run_id,mode,status,authorized_by,
              reason,idempotency_key,observed_source_revision,reviewed_source_snapshot,
              previous_verification_policy,replacement_verification_policy,request)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,'Owned fixture',$10,'revision-1',
                '{\"source_revision\":\"revision-1\",\"issue_number\":183}',$11,$11,$12)",
        )
        .bind(RECOVERY)
        .bind(CORP)
        .bind(ITEM)
        .bind(MISSION)
        .bind(TASK)
        .bind(SOURCE)
        .bind(RUN)
        .bind(mode)
        .bind(OWNER)
        .bind(Uuid::new_v4())
        .bind(&policy)
        .bind(json!({"expected_workspace_fingerprint":"b".repeat(64),"expected_head_commit":null}))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
        "INSERT INTO runner_commands(id,corp_id,runner_id,run_id,command_kind,payload,idempotency_key)
         VALUES($1,$2,$3,$4,'factory_verification_recovery','{}','issue140-cache-admission-command')",
    )
    .bind(COMMAND).bind(CORP).bind(RUNNER).bind(RUN)
    .execute(&pool).await.unwrap();
    } else {
        sqlx::raw_sql(
            "UPDATE agents SET current_run_id=NULL,status='idle'; UPDATE tasks SET status='failed'",
        )
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE tasks SET required_adapter='codex' WHERE id=$1")
        .bind(TASK)
        .execute(&pool)
        .await
        .unwrap();
    let store = PgStore::connect(pool.connect_options().to_url_lossy().as_str())
        .await
        .unwrap();
    store
        .runner_connected(RunnerConnectInput {
            id: RUNNER.to_owned(),
            corp_id: CORP,
            hostname: "fixture".to_owned(),
            os: "windows".to_owned(),
            capabilities: json!({}),
            connection_epoch: EPOCH,
        })
        .await
        .unwrap();
    Fixture::new(store).await
}

struct Fixture {
    state: AppState,
    commands: mpsc::UnboundedReceiver<ServerToRunner>,
    artifact_root: PathBuf,
}

fn capability(name: &str) -> RunnerCapability {
    RunnerCapability {
        name: name.into(),
        available: true,
        detail: None,
        models: vec![],
        source_repository: None,
        source_base_ref: None,
        source_base_commit: None,
        workspace_connection_id: None,
    }
}

impl Fixture {
    async fn new(store: PgStore) -> Self {
        let artifact_root =
            std::env::temp_dir().join(format!("ecorp-cache-admission-{}", Uuid::new_v4()));
        let artifacts = ArtifactStore::initialize(
            "local",
            artifact_root.clone(),
            None,
            None,
            None,
            None,
            None,
            false,
            None,
            1024,
            false,
        )
        .unwrap();
        let (event_tx, _) = broadcast::channel(64);
        let state = AppState {
            audit: None,
            base_audit: base_audit::Runtime::Unconfigured,
            delegated: None,
            store,
            event_tx,
            runners: Arc::new(DashMap::new()),
            strategies: StrategyRegistry::new(),
            runner_grace_secs: 10,
            runner_credential_ttl_secs: 300,
            publication_publisher_credential_ttl_secs: 300,
            auth: AuthService::initialize(ServerMode::Development, None, false)
                .await
                .unwrap(),
            secret_cipher: SecretCipher::initialize(ServerMode::Development, None).unwrap(),
            artifacts,
            artifact_retention_days: 1,
            workspace_sign_in: Arc::new(DashMap::new()),
        };
        let (tx, commands) = mpsc::unbounded_channel();
        let mut source = capability("workspace-isolation");
        source.source_repository = Some("fixture/source".into());
        source.source_base_ref = Some("main".into());
        source.source_base_commit = Some("a".repeat(40));
        state.runners.insert(
            RUNNER.into(),
            RunnerConnection {
                corp_id: CORP,
                connection_epoch: EPOCH,
                dispatch_ready: true,
                tx,
                capabilities: vec![
                    capability("codex"),
                    source,
                    capability("verification-artifact-transfer-v1"),
                ],
            },
        );
        Self {
            state,
            commands,
            artifact_root,
        }
    }

    async fn source(&self) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM runs r WHERE id=$1")
            .bind(SOURCE)
            .fetch_one(self.state.store.pool())
            .await
            .unwrap()
    }

    async fn grant_count(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM secret_access_grants")
            .fetch_one(self.state.store.pool())
            .await
            .unwrap()
    }

    async fn recovery_command(&self, mode: &str) -> PendingRunnerCommand {
        let (contract, policy): (Value, Value) =
            sqlx::query_as("SELECT contract,verification_policy FROM tasks WHERE id=$1")
                .bind(TASK)
                .fetch_one(self.state.store.pool())
                .await
                .unwrap();
        let payload = json!({
            "mode":mode,"corp_id":CORP,"room_id":ROOM,"mission_id":MISSION,"task_id":TASK,
            "run_id":RUN,"source_run_id":SOURCE,"workspace_run_id":SOURCE,"agent_id":AGENT,
            "assignment_token":TOKEN,"adapter":"codex","provider_session_id":if mode=="source_correction" {Some("fixture-session")} else {None},
            "prompt":"Owned cache admission fixture", "model":null,"reasoning_effort":null,
            "source_repository":"fixture/source","source_base_ref":"main","source_base_commit":"a".repeat(40),
            "workspace_base_commit":"a".repeat(40),"expected_workspace_fingerprint":"b".repeat(64),"expected_head_commit":null,
            "verification_policy":policy,"write_scope":["result.md"],"deliverable":null,
            "secret_refs":if mode=="source_correction" {contract["secret_refs"].clone()} else {json!([])},
            // Deliberately invalid metadata: hydration must reject it if reached.
            "provider_artifact":if mode=="verifier_only" {json!({"path":"missing-fixture.json","sha256":"a".repeat(64),"bytes":1,"media_type":"application/json","data_base64":"eA=="})} else {Value::Null},
        });
        sqlx::query("UPDATE runner_commands SET payload=$1 WHERE id=$2")
            .bind(&payload)
            .bind(COMMAND)
            .execute(self.state.store.pool())
            .await
            .unwrap();
        PendingRunnerCommand {
            id: COMMAND,
            corp_id: CORP,
            runner_id: RUNNER.into(),
            run_id: RUN,
            command_kind: "factory_verification_recovery".into(),
            payload,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Only our empty artifact directory can be removed. Unexpected data survives.
        let _ = std::fs::remove_dir(&self.artifact_root);
    }
}

async fn assert_legacy_recovery_rejected(pool: PgPool, mode: &str) {
    let mut f = fixture(pool, mode).await;
    let source = f.source().await;
    let command = f.recovery_command(mode).await;
    // A capable control reaches the deliberately poisoned later preparation;
    // the legacy case must stop before that same canary.
    sqlx::query(
        "UPDATE runs SET budget_tokens_limit=100000,budget_cost_microusd_limit=1000000 WHERE id=$1",
    )
    .bind(RUN)
    .execute(f.state.store.pool())
    .await
    .unwrap();
    f.state
        .runners
        .get_mut(RUNNER)
        .unwrap()
        .capabilities
        .push(capability("verifier-cache-suppression-v1"));
    let canary = decode_recovery_runner_command(&f.state, &command, None, false)
        .await
        .unwrap_err()
        .to_string();
    if mode == "source_correction" {
        assert!(
            canary.contains("forbidden: secret"),
            "unexpected preparation barrier: {canary}"
        );
    } else {
        assert_eq!(
            canary,
            "durable verifier artifact reference is not a bounded metadata-only record"
        );
    }
    f.state.runners.get_mut(RUNNER).unwrap().capabilities.pop();

    assert_eq!(
        f.state
            .store
            .runner_command_dispatch_state(&command)
            .await
            .unwrap(),
        RunnerCommandDispatchState::Pending
    );
    let error = decode_recovery_runner_command(&f.state, &command, None, false)
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        RunnerDispatchError::UnsupportedVerifierPolicy.detail()
    );
    assert!(!factory_recovery_failure_is_retryable(&error));
    assert_eq!(f.grant_count().await, 0);
    // The first sweep must terminalize for the admission reason itself. A
    // later sweep must leave the exact durable rows and failure evidence unchanged.
    let failure_reason = format!(
        "factory recovery failed before runner dispatch: {}",
        RunnerDispatchError::UnsupportedVerifierPolicy.detail()
    );
    let mut settled = None;
    for _ in 0..2 {
        dispatch_pending_runner_commands_for_epoch(&f.state, RUNNER, EPOCH)
            .await
            .unwrap();
        assert!(matches!(
            f.commands.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        assert_eq!(
            f.source().await,
            source,
            "retained source history must not change"
        );
        assert_eq!(f.grant_count().await, 0);
        let terminal: Value = sqlx::query_scalar("SELECT jsonb_build_object(
            'run',(SELECT to_jsonb(r) FROM runs r WHERE id=$1),
            'task',(SELECT to_jsonb(t) FROM tasks t WHERE id=$2),
            'recovery',(SELECT to_jsonb(v) FROM factory_verification_recoveries v WHERE replacement_run_id=$1),
            'command',(SELECT to_jsonb(c) FROM runner_commands c WHERE run_id=$1),
            'failures',(SELECT jsonb_agg(to_jsonb(e) ORDER BY seq) FROM events e WHERE type='run.failed' AND aggregate_id=$1))")
            .bind(RUN).bind(TASK).fetch_one(f.state.store.pool()).await.unwrap();
        assert_eq!(terminal["run"]["status"], "failed");
        assert_eq!(terminal["run"]["workspace_detail"], "dispatch_not_started");
        assert_eq!(terminal["run"]["summary"], failure_reason);
        assert_eq!(terminal["task"]["status"], "verification_failed");
        assert_eq!(terminal["recovery"]["status"], "failed");
        assert_eq!(terminal["command"]["status"], "dispatched");
        assert_eq!(terminal["failures"].as_array().unwrap().len(), 1);
        assert_eq!(terminal["failures"][0]["payload"]["error"], failure_reason);
        assert_eq!(
            terminal["failures"][0]["payload"]["dispatch_not_started"],
            true
        );
        if let Some(before) = &settled {
            assert_eq!(&terminal, before);
        }
        settled = Some(terminal);
    }
    assert!(f.artifact_root.read_dir().unwrap().next().is_none());
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue140_legacy_source_recovery_fails_before_secret_preparation(pool: PgPool) {
    assert_legacy_recovery_rejected(pool, "source_correction").await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue140_legacy_verifier_recovery_fails_before_artifact_hydration(pool: PgPool) {
    assert_legacy_recovery_rejected(pool, "verifier_only").await;
}

async fn assert_resume_admission(pool: PgPool, capable: bool, dependency_canary: bool) {
    let mut f = fixture(pool, "resume").await;
    if dependency_canary {
        sqlx::query("INSERT INTO tasks(id,corp_id,mission_id,title,objective,status,assigned_agent_id,plan_key,contract,verification_policy,verification_status)
            SELECT $1,corp_id,mission_id,'Missing dependency artifact','fixture','completed',assigned_agent_id,'parent',contract,verification_policy,'passed' FROM tasks WHERE id=$2")
            .bind(Uuid::from_u128(98)).bind(TASK).execute(f.state.store.pool()).await.unwrap();
        sqlx::query("INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)")
            .bind(TASK)
            .bind(Uuid::from_u128(98))
            .execute(f.state.store.pool())
            .await
            .unwrap();
    }

    if capable {
        f.state
            .runners
            .get_mut(RUNNER)
            .unwrap()
            .capabilities
            .push(capability("verifier-cache-suppression-v1"));
    }
    let source = f.source().await;
    let error = resume_run(
        State(f.state.clone()),
        Extension(Principal::Development),
        Path((CORP, SOURCE)),
        Json(ResumeRunRequest {
            requested_by: OWNER,
            prompt: "Resume owned fixture".into(),
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);
    assert_eq!(
        error.message,
        if capable && dependency_canary {
            "verified dependency handoff denied resumed assignment"
        } else if capable {
            "secret broker denied resumed assignment"
        } else {
            RunnerDispatchError::UnsupportedVerifierPolicy.detail()
        }
    );
    assert_eq!(f.source().await, source);
    assert_eq!(f.grant_count().await, 0);
    assert!(matches!(
        f.commands.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    let replacements: Vec<(Uuid, String, String)> =
        sqlx::query_as("SELECT id,status,workspace_detail FROM runs WHERE resumed_from_run_id=$1")
            .bind(SOURCE)
            .fetch_all(f.state.store.pool())
            .await
            .unwrap();
    assert_eq!(replacements.len(), 1);
    assert_eq!(replacements[0].1, "failed");
    assert_eq!(replacements[0].2, "dispatch_not_started");
    let attempts: i32 = sqlx::query_scalar("SELECT attempt_count FROM tasks WHERE id=$1")
        .bind(TASK)
        .fetch_one(f.state.store.pool())
        .await
        .unwrap();
    assert_eq!(
        attempts, 2,
        "resume admission does not consume a provider attempt"
    );
    assert!(f.artifact_root.read_dir().unwrap().next().is_none());
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue140_legacy_resume_handler_fails_before_preparation(pool: PgPool) {
    assert_resume_admission(pool, false, true).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue140_capable_resume_reaches_secret_canary(pool: PgPool) {
    assert_resume_admission(pool, true, false).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue140_capable_resume_reaches_dependency_canary(pool: PgPool) {
    assert_resume_admission(pool, true, true).await;
}

async fn assert_bad_policy_does_not_starve_sibling(pool: PgPool, bad_policy: Value) {
    let mut f = fixture(pool, "resume").await;
    let source_before = f.source().await;
    let healthy = Uuid::from_u128(101);
    sqlx::query("UPDATE tasks SET status='ready',verification_policy=$1 WHERE id=$2")
        .bind(bad_policy)
        .bind(TASK)
        .execute(f.state.store.pool())
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO tasks(id,corp_id,mission_id,title,objective,status,assigned_agent_id,
          plan_key,contract,verification_policy,attempt_count,max_attempts,required_adapter,created_at)
         SELECT $1,corp_id,mission_id,'Healthy sibling',objective,'ready',assigned_agent_id,
          'healthy',jsonb_set(contract,'{secret_refs}','[]'::jsonb),
          '{"checks":[{"type":"artifact","min_bytes":1}],"manual_gate":null}'::jsonb,
          0,2,required_adapter,now()+interval '1 second' FROM tasks WHERE id=$2"#,
    ).bind(healthy).bind(TASK).execute(f.state.store.pool()).await.unwrap();
    let outcome = schedule_ready_tasks(&f.state, CORP, MISSION, Some(OWNER))
        .await
        .unwrap();
    assert_eq!(outcome.candidate_count, 2);
    assert_eq!(
        outcome.failures,
        vec![format!(
            "task {TASK} has an invalid or unsupported verifier policy"
        )]
    );
    assert_eq!(outcome.records.len(), 1);
    assert_eq!(outcome.records[0].0.task_id, healthy);
    assert!(
        matches!(f.commands.try_recv().unwrap(), ServerToRunner::StartRun { task_id, .. } if task_id == healthy)
    );
    assert!(f.commands.try_recv().is_err());
    let attempts: i32 = sqlx::query_scalar("SELECT attempt_count FROM tasks WHERE id=$1")
        .bind(TASK)
        .fetch_one(f.state.store.pool())
        .await
        .unwrap();
    assert_eq!(attempts, 2);
    let bad_runs: i64 = sqlx::query_scalar("SELECT count(*) FROM runs WHERE task_id=$1")
        .bind(TASK)
        .fetch_one(f.state.store.pool())
        .await
        .unwrap();
    assert_eq!(bad_runs, 1);
    assert_eq!(f.source().await, source_before);
    assert_eq!(f.grant_count().await, 0);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an owned PostgreSQL fixture"]
async fn issue140_malformed_policy_does_not_starve_healthy_sibling(pool: PgPool) {
    assert_bad_policy_does_not_starve_sibling(pool, json!({"checks":"invalid","manual_gate":null}))
        .await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an owned PostgreSQL fixture"]
async fn issue140_future_policy_does_not_starve_healthy_sibling(pool: PgPool) {
    assert_bad_policy_does_not_starve_sibling(
        pool,
        json!({"checks":[{"type":"future_verifier"}],"manual_gate":null}),
    )
    .await;
}

// The broker really persists the target grant; control rows deliberately include
// another run, an expired grant and a cross-Corp row to exercise cleanup scoping.
async fn seed_cleanup_grants(f: &Fixture, run_id: Uuid) -> Value {
    let store = &f.state.store;
    store
        .create_secret(
            CORP,
            OWNER,
            Uuid::from_u128(99),
            "metadata-only-fixture",
            &[1],
            &[2],
            &[OWNER],
            &["fixture".into()],
            "fixture/",
            300,
        )
        .await
        .unwrap();
    let refs: Vec<crony_domain::TaskSecretReference> = serde_json::from_value(json!([{
        "secret_id":Uuid::from_u128(99),"env_name":"FIXTURE_SECRET",
        "tool":"fixture","resource":"fixture/source"
    }]))
    .unwrap();
    store
        .grant_run_secrets(CORP, TASK, run_id, RUNNER, &refs)
        .await
        .unwrap();
    sqlx::query("INSERT INTO corps(id,slug,name) VALUES($1,'other-cleanup-corp','Other')")
        .bind(Uuid::from_u128(200))
        .execute(store.pool())
        .await
        .unwrap();
    for (id, corp, run, expired) in [
        (201, CORP, SOURCE, false),
        (202, CORP, run_id, true),
        (203, Uuid::from_u128(200), run_id, false),
    ] {
        sqlx::query(
            "INSERT INTO secret_access_grants
            (id,corp_id,secret_id,task_id,run_id,actor_id,runner_id,tool,resource,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,'fixture','fixture/source',
            now() + CASE WHEN $8 THEN interval '-1 hour' ELSE interval '1 hour' END)",
        )
        .bind(Uuid::from_u128(id))
        .bind(corp)
        .bind(Uuid::from_u128(99))
        .bind(TASK)
        .bind(run)
        .bind(OWNER)
        .bind(RUNNER)
        .bind(expired)
        .execute(store.pool())
        .await
        .unwrap();
    }
    cleanup_snapshot(f).await
}

async fn cleanup_snapshot(f: &Fixture) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object(
        'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM secret_access_grants g),
        'audit',(SELECT jsonb_agg(to_jsonb(e) ORDER BY seq) FROM events e WHERE type='secret.access_granted'),
        'attempts',(SELECT attempt_count FROM tasks WHERE id=$1))")
        .bind(TASK).fetch_one(f.state.store.pool()).await.unwrap()
}

async fn assert_cleanup(f: &Fixture, run_id: Uuid, before: &Value) -> Value {
    let after = cleanup_snapshot(f).await;
    assert_eq!(after["attempts"], before["attempts"]);
    assert_eq!(after["audit"], before["audit"]);
    let old = before["grants"].as_array().unwrap();
    let new = after["grants"].as_array().unwrap();
    assert_eq!(old.len(), new.len());
    let mut changed = 0;
    for (a, b) in old.iter().zip(new) {
        if a != b {
            changed += 1;
            assert_eq!(b["corp_id"], json!(CORP));
            assert_eq!(b["run_id"], json!(run_id));
            let mut expected = a.clone();
            expected["expires_at"] = b["expires_at"].clone();
            assert_eq!(&expected, b);
        }
    }
    assert_eq!(changed, 1);
    let live: i64 = sqlx::query_scalar("SELECT count(*) FROM secret_access_grants WHERE corp_id=$1 AND run_id=$2 AND expires_at > now()")
        .bind(CORP).bind(run_id).fetch_one(f.state.store.pool()).await.unwrap();
    assert_eq!(live, 0);
    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM events WHERE corp_id=$1 AND aggregate_id=$2 AND type='run.failed'",
    )
    .bind(CORP)
    .bind(run_id)
    .fetch_one(f.state.store.pool())
    .await
    .unwrap();
    assert_eq!(payload["expired_secret_access_grant_count"], 1);
    after
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue140_late_loss_keeps_shared_attempt_and_expires_grants(pool: PgPool) {
    let mut f = fixture(pool, "resume").await;
    // One historical execution, one remaining allocation slot. No pending run.
    sqlx::query(
        "UPDATE tasks SET status='ready',attempt_count=1,max_attempts=2,
        contract=jsonb_set(contract,'{secret_refs}','[]'::jsonb) WHERE id=$1",
    )
    .bind(TASK)
    .execute(f.state.store.pool())
    .await
    .unwrap();
    let source = f.source().await;
    for _ in 0..2 {
        let outcome = schedule_ready_tasks(&f.state, CORP, MISSION, Some(OWNER))
            .await
            .unwrap();
        assert!(outcome.records.is_empty());
        assert_eq!(outcome.failures.len(), 1);
        assert!(outcome.failures[0].contains("verifier-cache-suppression-v1"));
        let counts: (i32,i64) = sqlx::query_as("SELECT attempt_count,(SELECT count(*) FROM runs WHERE task_id=$1) FROM tasks WHERE id=$1")
            .bind(TASK).fetch_one(f.state.store.pool()).await.unwrap();
        assert_eq!(counts, (1, 1));
        assert!(f.commands.try_recv().is_err());
    }
    f.state
        .runners
        .get_mut(RUNNER)
        .unwrap()
        .capabilities
        .push(capability("verifier-cache-suppression-v1"));
    // Cross the real allocation and broker boundaries, then deterministically
    // remove support at the separable final-send boundary (no timed race).
    let (record, _) = f
        .state
        .store
        .create_task_run(CORP, MISSION, TASK, Some(OWNER), RUNNER)
        .await
        .unwrap();
    let before = seed_cleanup_grants(&f, record.run_id).await;
    assert_eq!(before["attempts"], 2);
    f.state.runners.get_mut(RUNNER).unwrap().capabilities.pop();
    assert_eq!(f.state.runners.get(RUNNER).unwrap().connection_epoch, EPOCH);
    let command = serde_json::from_value(json!({
        "type":"start_run", "corp_id":CORP,"room_id":ROOM,"mission_id":MISSION,
        "task_id":TASK,"run_id":record.run_id,"agent_id":AGENT,
        "assignment_token":record.assignment_token,"adapter":"codex",
        "mission_title":"allocation accounting", "verification_policy":record.verification_policy,
        "secrets":[]
    }))
    .unwrap();
    assert_eq!(
        send_command_to_current_runner(&f.state.runners, RUNNER, EPOCH, command),
        Err(RunnerDispatchError::UnsupportedVerifierPolicy)
    );
    assert!(matches!(
        f.commands.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    f.state
        .store
        .fail_run_before_dispatch(
            CORP,
            record.run_id,
            RunnerDispatchError::UnsupportedVerifierPolicy.detail(),
        )
        .await
        .unwrap();
    let settled = assert_cleanup(&f, record.run_id, &before).await;
    assert!(
        f.state
            .store
            .fail_run_before_dispatch(CORP, record.run_id, "replayed reason")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(cleanup_snapshot(&f).await, settled);
    assert_eq!(f.source().await, source);
    assert!(
        f.state
            .store
            .schedulable_mission_ids(CORP)
            .await
            .unwrap()
            .is_empty()
    );
    // Make only lifecycle eligibility permissive to isolate the cap guard.
    // This is fixture setup, not an API that reopens failed tasks.
    sqlx::raw_sql("UPDATE tasks SET status='ready'; UPDATE missions SET status='running'")
        .execute(f.state.store.pool())
        .await
        .unwrap();
    let error = f
        .state
        .store
        .create_task_run(CORP, MISSION, TASK, Some(OWNER), RUNNER)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("exhausted its retry limit"));
    assert_eq!(cleanup_snapshot(&f).await, settled);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM runs WHERE task_id=$1")
        .bind(TASK)
        .fetch_one(f.state.store.pool())
        .await
        .unwrap();
    assert_eq!(count, 2);
}

async fn assert_recovery_grant_cleanup(pool: PgPool, mode: &str) {
    let f = fixture(pool, mode).await;
    let source = f.source().await;
    let before = seed_cleanup_grants(&f, RUN).await;
    // Preallocated recovery metadata fixture: this tests cleanup, not allocation.
    f.state
        .store
        .fail_factory_recovery_before_dispatch(CORP, RUN, "unsupported cache policy")
        .await
        .unwrap();
    let settled = assert_cleanup(&f, RUN, &before).await;
    assert!(
        f.state
            .store
            .fail_factory_recovery_before_dispatch(CORP, RUN, "replay")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(cleanup_snapshot(&f).await, settled);
    assert_eq!(f.source().await, source);
    assert!(
        f.state
            .store
            .schedulable_mission_ids(CORP)
            .await
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue140_source_recovery_expires_only_its_grants(pool: PgPool) {
    assert_recovery_grant_cleanup(pool, "source_correction").await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue140_verifier_recovery_expires_only_its_grants(pool: PgPool) {
    assert_recovery_grant_cleanup(pool, "verifier_only").await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue140_rejected_failure_guard_preserves_grants(pool: PgPool) {
    let f = fixture(pool, "source_correction").await;
    let before = seed_cleanup_grants(&f, RUN).await;
    sqlx::query("UPDATE runs SET status='running' WHERE id=$1")
        .bind(RUN)
        .execute(f.state.store.pool())
        .await
        .unwrap();
    assert!(
        f.state
            .store
            .fail_run_before_dispatch(CORP, RUN, "stale failure")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        f.state
            .store
            .fail_factory_recovery_before_dispatch(CORP, RUN, "stale recovery")
            .await
            .is_err()
    );
    assert_eq!(cleanup_snapshot(&f).await, before);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue140_grant_expiry_rolls_back_with_failed_transition(pool: PgPool) {
    let f = fixture(pool, "source_correction").await;
    let before = seed_cleanup_grants(&f, RUN).await;
    sqlx::raw_sql(
        "CREATE FUNCTION reject_cleanup_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.type='run.failed' THEN RAISE EXCEPTION 'owned cleanup rollback fault'; END IF;
        RETURN NEW; END $$;
        CREATE TRIGGER reject_cleanup_event BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION reject_cleanup_event();",
    )
    .execute(f.state.store.pool())
    .await
    .unwrap();
    let error = f
        .state
        .store
        .fail_run_before_dispatch(CORP, RUN, "cleanup rollback")
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("owned cleanup rollback fault"));
    assert_eq!(cleanup_snapshot(&f).await, before);
    let error = f
        .state
        .store
        .fail_factory_recovery_before_dispatch(CORP, RUN, "recovery rollback")
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("owned cleanup rollback fault"));
    assert_eq!(cleanup_snapshot(&f).await, before);
    let statuses: (String,String,String) = sqlx::query_as("SELECT r.status,t.status,m.status FROM runs r JOIN tasks t ON t.id=r.task_id JOIN missions m ON m.id=t.mission_id WHERE r.id=$1")
        .bind(RUN).fetch_one(f.state.store.pool()).await.unwrap();
    assert_eq!(
        statuses,
        ("starting".into(), "running".into(), "running".into())
    );
}
