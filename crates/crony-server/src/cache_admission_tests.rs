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
