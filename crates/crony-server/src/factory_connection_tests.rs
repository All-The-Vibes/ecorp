//! Actual handlers + real migrations; the only runner is an in-memory capability
//! fixture. No native account, provider process or application database is used.
use super::*;
use anyhow::Result;
use crony_domain::{
    CodingAgent, GitHubAccountSource, RunnerModel, WorkspaceConnectionConfiguration,
    WorkspaceConnectionStatus, WorkspaceRepositorySetup, WorkspaceSetupAction,
    WorkspaceSetupReport, WorkspaceSetupStatus, WorkspaceSourceIdentity,
};
use crony_store::{CreateWorkspaceConnectionInput, DemoIds, WorkspaceSetupInput};
use serde_json::Value;
use sqlx::{ConnectOptions, PgPool};

#[path = "issue161_authority_tests.rs"]
mod claim_authority;
#[path = "factory_readiness_tests.rs"]
mod readiness;

struct Fixture {
    state: AppState,
    ids: DemoIds,
    connection_id: Uuid,
    runner_id: String,
    epoch: Uuid,
    artifact_root: PathBuf,
    _commands: mpsc::UnboundedReceiver<ServerToRunner>,
}

fn source() -> WorkspaceSourceIdentity {
    WorkspaceSourceIdentity {
        repository: "fixture/project".to_owned(),
        repository_id: Some("issue204-repository".to_owned()),
        base_ref: "main".to_owned(),
        base_commit: "a".repeat(40),
    }
}

fn configuration() -> WorkspaceConnectionConfiguration {
    WorkspaceConnectionConfiguration {
        repository: WorkspaceRepositorySetup::GitHub {
            repository: source().repository,
            repository_id: source().repository_id,
            base_ref: source().base_ref,
            account: GitHubAccountSource::Personal,
        },
        agent: CodingAgent::Codex,
        use_system_installation: false,
        use_machine_account: Some(false),
    }
}

fn model() -> RunnerModel {
    RunnerModel {
        id: "issue204-handler-model".to_owned(),
        name: "Synthetic handler model".to_owned(),
        policy_state: Some("enabled".to_owned()),
        policy_terms: None,
        supports_vision: false,
        supports_reasoning_effort: false,
        max_prompt_tokens: None,
        max_context_window_tokens: Some(4096),
        supported_reasoning_efforts: vec![],
        default_reasoning_effort: None,
        billing_multiplier: None,
    }
}

fn report() -> WorkspaceSetupReport {
    WorkspaceSetupReport {
        status: WorkspaceSetupStatus::Succeeded,
        detail: "Synthetic checked connection; no provider was invoked".to_owned(),
        connection_status: Some(WorkspaceConnectionStatus::Ready),
        source: Some(source()),
        models: vec![model()],
        account_login: None,
        sign_in: None,
        repositories: vec![],
    }
}

fn capability(name: &str, connection_id: Option<Uuid>) -> RunnerCapability {
    RunnerCapability {
        name: name.to_owned(),
        available: true,
        detail: None,
        models: if name == "codex" {
            vec![model()]
        } else {
            vec![]
        },
        source_repository: connection_id.map(|_| source().repository),
        source_base_ref: connection_id.map(|_| source().base_ref),
        source_base_commit: connection_id.map(|_| source().base_commit),
        workspace_connection_id: connection_id,
    }
}

impl Fixture {
    async fn new(pool: PgPool) -> Result<Self> {
        // This URL comes only from the SQLx-provided disposable pool, never the
        // ambient environment. It is not logged, serialized or passed to a child.
        let database = pool.connect_options().to_url_lossy();
        let store = PgStore::connect(database.as_str()).await?;
        let (ids, _) = store.bootstrap_demo().await?;
        let runner_id = format!("issue204-handler-{}", Uuid::new_v4());
        let epoch = Uuid::new_v4();
        store
            .runner_connected(RunnerConnectInput {
                id: runner_id.clone(),
                corp_id: ids.corp_id,
                hostname: "synthetic-only".to_owned(),
                os: "windows".to_owned(),
                capabilities: json!([capability("workspace-setup-v1", None)]),
                connection_epoch: epoch,
            })
            .await?;
        let created = store
            .create_workspace_connection(CreateWorkspaceConnectionInput {
                corp_id: ids.corp_id,
                room_id: ids.room_id,
                actor_id: ids.alice_actor_id,
                runner_id: runner_id.clone(),
                label: "Handler connection fixture".to_owned(),
                configuration: configuration(),
                idempotency_key: "issue204-handler-connect".to_owned(),
            })
            .await?;
        let ready = store
            .apply_workspace_setup_report(
                ids.corp_id,
                &runner_id,
                epoch,
                created.operation.id,
                report(),
            )
            .await?;
        let connection_id = ready.connection.context("saved fixture connection")?.id;
        let artifact_root =
            std::env::temp_dir().join(format!("ecorp-issue204-handlers-{}", Uuid::new_v4()));
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
        )?;
        let (event_tx, _) = broadcast::channel(64);
        let state = AppState {
            audit: None,
            base_audit: base_audit::Runtime::Unconfigured,
            store,
            event_tx,
            runners: Arc::new(DashMap::new()),
            strategies: StrategyRegistry::new(),
            runner_grace_secs: 10,
            runner_credential_ttl_secs: 300,
            publication_publisher_credential_ttl_secs: 300,
            auth: AuthService::initialize(ServerMode::Development, None, false).await?,
            secret_cipher: SecretCipher::initialize(ServerMode::Development, None)?,
            artifacts,
            artifact_retention_days: 1,
            workspace_sign_in: Arc::new(DashMap::new()),
            delegated: None,
        };
        let (tx, commands) = mpsc::unbounded_channel();
        // There is deliberately no unbound coding capability. Forgetting the
        // policy connection in either handler reproduces the actual API defect.
        state.runners.insert(
            runner_id.clone(),
            RunnerConnection {
                corp_id: ids.corp_id,
                connection_epoch: epoch,
                dispatch_ready: true,
                tx,
                capabilities: vec![
                    capability("workspace-isolation", Some(connection_id)),
                    capability("codex", Some(connection_id)),
                ],
            },
        );
        Ok(Self {
            state,
            ids,
            connection_id,
            runner_id,
            epoch,
            artifact_root,
            _commands: commands,
        })
    }

    fn preflight(&self) -> PreflightFactoryMissionRequest {
        serde_json::from_value(json!({
            "actor_id": self.ids.alice_actor_id,
            "source_repository_owner": "fixture",
            "source_repository_name": "project",
            "title": "Issue 204 handler connection",
            "description": "Synthetic handler acceptance, no provider execution",
            "preferred_adapter": "codex",
            "preferred_model": model().id,
            "strategy": "single",
            "budget_tokens": 1000,
            "budget_cost_microusd": 1000000,
            "contract": {
                "objective": "Verify the exact Factory connection",
                "expected_output": "result.md",
                "allowed_tools": ["filesystem"],
                "prohibited_actions": ["No external effects"],
                "write_scope": ["result.md"],
            },
            "policy": {
                "schema_version": 1,
                "source_of_truth": "github_project",
                "auto_merge": false,
                "workspace_connection_id": self.connection_id,
                "repository_allowlist": [source().repository],
                "source_base_ref": source().base_ref,
                "source_base_commit": source().base_commit,
                "adapter_allowlist": ["codex"],
                "strategy_allowlist": ["single"],
                "model": model().id,
                "reasoning_effort": null,
                "write_scope": ["result.md"],
                "allowed_tools": ["filesystem"],
                "prohibited_actions": ["No external effects"],
                "secret_ids": [],
                "verification_required": true,
                "budget_tokens": 1000,
                "budget_cost_microusd": 1000000,
            },
        }))
        .unwrap()
    }

    async fn claimed_request(&self) -> Result<MaterializeFactoryMissionRequest> {
        let request = self.preflight();
        let outcome = self
            .state
            .store
            .claim_factory_work_item(ClaimFactoryWorkItemInput {
                corp_id: self.ids.corp_id,
                actor_id: self.ids.alice_actor_id,
                source: FactorySourceInput {
                    project_owner: "fixture".to_owned(),
                    project_number: 3,
                    project_item_id: "issue204-handler-item".to_owned(),
                    repository_owner: "fixture".to_owned(),
                    repository_name: "project".to_owned(),
                    issue_number: 204,
                    issue_node_id: "issue204-handler-issue".to_owned(),
                    issue_url: "https://github.com/fixture/project/issues/204".to_owned(),
                    title: request.title.clone(),
                    revision: "2026-09-09T00:00:00Z".to_owned(),
                },
                idempotency_key: "issue204-handler-claim".to_owned(),
                lease_seconds: 300,
                policy: request.policy.clone(),
            })
            .await?;
        let mut value = serde_json::to_value(request)?;
        value["claim_token"] = json!(outcome.claim_token.context("claim token")?);
        value["expected_version"] = json!(outcome.work_item.version);
        value["idempotency_key"] = json!("issue204-handler-materialize");
        Ok(serde_json::from_value(value)?)
    }

    async fn item(&self) -> Result<crony_domain::FactoryWorkItem> {
        self.state
            .store
            .snapshot(self.ids.corp_id, self.ids.alice_actor_id)
            .await?
            .factory_work_items
            .into_iter()
            .next()
            .context("fixture work item")
    }

    async fn snapshot(&self) -> Result<Value> {
        Ok(serde_json::to_value(
            self.state
                .store
                .snapshot(self.ids.corp_id, self.ids.alice_actor_id)
                .await?,
        )?)
    }

    async fn change_connection(&self, source_changed: bool) -> Result<()> {
        let operation = self
            .state
            .store
            .begin_workspace_setup(WorkspaceSetupInput {
                corp_id: self.ids.corp_id,
                room_id: self.ids.room_id,
                actor_id: self.ids.alice_actor_id,
                runner_id: self.runner_id.clone(),
                action: WorkspaceSetupAction::Test {
                    connection_id: self.connection_id,
                    configuration: configuration(),
                },
                idempotency_key: "issue204-handler-change".to_owned(),
            })
            .await?;
        let mut changed = report();
        if source_changed {
            changed.source.as_mut().unwrap().base_commit = "b".repeat(40);
        } else {
            changed.status = WorkspaceSetupStatus::Failed;
            changed.connection_status = Some(WorkspaceConnectionStatus::Failed);
            changed.source = None;
            changed.models.clear();
        }
        self.state
            .store
            .apply_workspace_setup_report(
                self.ids.corp_id,
                &self.runner_id,
                self.epoch,
                operation.operation.id,
                changed,
            )
            .await?;
        Ok(())
    }

    async fn finish(self) {
        self.state.store.pool().close().await;
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // The handlers under test never write artifact bytes. Remove only our
        // empty random directory; unexpected contents are preserved, not recursed.
        let _ = std::fs::remove_dir(&self.artifact_root);
    }
}

fn progress_event(f: &Fixture, run: Uuid, kind: &str, payload: Value) -> RunnerEventInput {
    RunnerEventInput {
        event_id: Uuid::new_v4(),
        runner_id: f.runner_id.clone(),
        corp_id: f.ids.corp_id,
        connection_epoch: f.epoch,
        run_id: run,
        agent_id: f.ids.worker_agent_id,
        assignment_token: run,
        event_type: kind.to_owned(),
        payload,
    }
}

async fn queue_budget_progress(f: &Fixture) -> Result<Uuid> {
    let store = &f.state.store;
    let mission = Uuid::new_v4();
    let task = Uuid::new_v4();
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,
           budget_tokens,original_budget_tokens,budget_cost_microusd,original_budget_cost_microusd)
         VALUES($1,$2,$3,$4,'Progress dispatch','running',100,100,1000000,1000000)",
    )
    .bind(mission)
    .bind(f.ids.corp_id)
    .bind(f.ids.room_id)
    .bind(f.ids.alice_actor_id)
    .execute(store.pool())
    .await?;
    let contract = json!({
        "objective": "Stop at hard budget", "expected_output": "result.md",
        "acceptance_tests": [], "allowed_tools": ["filesystem"],
        "prohibited_actions": ["No external effects"], "references": [],
        "write_scope": ["result.md"], "budget_tokens": 10000,
        "budget_cost_microusd": 1000000, "deadline_at": null,
        "escalation": "ask owner"
    });
    let _: crony_domain::TaskContract = serde_json::from_value(contract.clone())?;
    sqlx::query(
        "INSERT INTO tasks(id,corp_id,mission_id,title,objective,status,assigned_agent_id,
           required_adapter,plan_key,contract,verification_policy,attempt_count,max_attempts)
         VALUES($1,$2,$3,'Dispatch','Stop at hard budget','running',$4,'fake-process','progress',
           $5,'{\"checks\":[],\"manual_gate\":null}',1,2)",
    )
    .bind(task)
    .bind(f.ids.corp_id)
    .bind(mission)
    .bind(f.ids.worker_agent_id)
    .bind(contract)
    .execute(store.pool())
    .await?;
    sqlx::query(
        "INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,
           workspace_run_id,budget_tokens_limit,budget_cost_microusd_limit)
         VALUES($1,$2,$3,$4,$5,$1,'running',$1,10000,1000000)",
    )
    .bind(run)
    .bind(f.ids.corp_id)
    .bind(task)
    .bind(f.ids.worker_agent_id)
    .bind(&f.runner_id)
    .execute(store.pool())
    .await?;
    let approval = Uuid::new_v4();
    store
        .apply_runner_event(progress_event(
            f,
            run,
            "run.approval_requested",
            json!({
                "approval_id":approval, "action_key":"progress", "action":"write",
                "risk":"high", "rationale":"synthetic dispatch test", "required_roles":["owner"],
                "expires_in_seconds":300,
            }),
        ))
        .await?;
    store
        .decide_action_approval(
            f.ids.corp_id,
            approval,
            f.ids.alice_actor_id,
            true,
            "",
            Uuid::new_v4(),
        )
        .await?;
    let lease = store
        .acquire_lease(f.ids.corp_id, f.ids.worker_agent_id, f.ids.alice_actor_id)
        .await?;
    assert!(lease.acquired);
    assert!(
        store
            .queue_message(
                f.ids.corp_id,
                f.ids.worker_agent_id,
                f.ids.alice_actor_id,
                Some(lease.lease.token),
                "Continue",
                Uuid::new_v4()
            )
            .await?
            .command_queued
    );
    f.state
        .runners
        .get_mut(&f.runner_id)
        .unwrap()
        .capabilities
        .push(capability("durable-control-v1", None));
    assert_eq!(store.pending_runner_commands(&f.runner_id).await?.len(), 2);
    Ok(run)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_dispatcher_sends_healthy_progress_only_to_current_epoch(
    pool: PgPool,
) -> Result<()> {
    let mut f = Fixture::new(pool).await?;
    let run = queue_budget_progress(&f).await?;
    dispatch_pending_runner_commands_for_epoch(&f.state, &f.runner_id, Uuid::new_v4()).await?;
    assert!(f._commands.try_recv().is_err());
    dispatch_pending_runner_commands_for_epoch(&f.state, &f.runner_id, f.epoch).await?;
    let mut kinds = Vec::new();
    while let Ok(command) = f._commands.try_recv() {
        let (id, target, kind) = match command {
            ServerToRunner::ApprovalDecision {
                command_id, run_id, ..
            } => (command_id, run_id, "approval"),
            ServerToRunner::ControlMessage {
                command_id: Some(command_id),
                run_id,
                ..
            } => (command_id, run_id, "control"),
            other => panic!("unexpected healthy command: {other:?}"),
        };
        assert_eq!(target, run);
        kinds.push(kind);
        f.state
            .store
            .acknowledge_runner_command(id, &f.runner_id)
            .await?;
    }
    kinds.sort_unstable();
    assert_eq!(kinds, ["approval", "control"]);
    dispatch_pending_runner_commands_for_epoch(&f.state, &f.runner_id, f.epoch).await?;
    assert!(f._commands.try_recv().is_err());
    f.finish().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_dispatcher_retires_fenced_approval_and_control_once(pool: PgPool) -> Result<()> {
    let mut f = Fixture::new(pool).await?;
    let run = queue_budget_progress(&f).await?;
    f.state
        .store
        .apply_runner_event(progress_event(
            &f,
            run,
            "run.usage",
            json!({"input_tokens":100}),
        ))
        .await?;
    dispatch_pending_runner_commands_for_epoch(&f.state, &f.runner_id, f.epoch).await?;
    let mut fences = 0;
    while let Ok(command) = f._commands.try_recv() {
        match command {
            ServerToRunner::CircuitBreaker {
                command_id, run_id, ..
            } => {
                assert_eq!(run_id, run);
                fences += 1;
                f.state
                    .store
                    .acknowledge_runner_command(command_id, &f.runner_id)
                    .await?;
            }
            other => panic!("hard fence must block native human progress: {other:?}"),
        }
    }
    assert_eq!(fences, 1);
    for _ in 0..2 {
        dispatch_pending_runner_commands_for_epoch(&f.state, &f.runner_id, f.epoch).await?;
        assert!(f._commands.try_recv().is_err());
        let failed: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM runner_commands WHERE run_id=$1 AND status='failed'
             AND command_kind IN ('approval_decision','control_message')
             AND failure_detail LIKE '%hard budget fenced%'",
        )
        .bind(run)
        .fetch_one(f.state.store.pool())
        .await?;
        assert_eq!(failed, 2);
        let events: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM events
             WHERE aggregate_id=$1 AND corp_id=$2 AND type='runner.command_failed'",
        )
        .bind(run)
        .bind(f.ids.corp_id)
        .fetch_one(f.state.store.pool())
        .await?;
        assert_eq!(events, 2);
    }
    let message: String = sqlx::query_scalar("SELECT status FROM queued_messages WHERE run_id=$1")
        .bind(run)
        .fetch_one(f.state.store.pool())
        .await?;
    assert_eq!(message, "cancelled");
    f.finish().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue48_planner_reuses_pins_in_the_saved_connection_room(pool: PgPool) -> Result<()> {
    let f = Fixture::new(pool.clone()).await?;
    let second_room = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO rooms(id,corp_id,name,purpose,created_at) \
         SELECT $1,$2,'Pin destination','Two-room planner regression',created_at+interval '1 second' \
         FROM rooms WHERE id=$3",
    )
    .bind(second_room)
    .bind(f.ids.corp_id)
    .bind(f.ids.room_id)
    .execute(&pool)
    .await?;
    sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
        .bind(second_room)
        .bind(f.ids.alice_actor_id)
        .execute(&pool)
        .await?;
    let created = f
        .state
        .store
        .create_workspace_connection(CreateWorkspaceConnectionInput {
            corp_id: f.ids.corp_id,
            room_id: second_room,
            actor_id: f.ids.alice_actor_id,
            runner_id: f.runner_id.clone(),
            label: "Pin destination connection".to_owned(),
            configuration: configuration(),
            idempotency_key: "issue48-second-room".to_owned(),
        })
        .await?;
    let ready = f
        .state
        .store
        .apply_workspace_setup_report(
            f.ids.corp_id,
            &f.runner_id,
            f.epoch,
            created.operation.id,
            report(),
        )
        .await?;
    let second_connection = ready.connection.context("second connection")?.id;
    f.state
        .runners
        .get_mut(&f.runner_id)
        .unwrap()
        .capabilities
        .extend([
            capability("workspace-isolation", Some(second_connection)),
            capability("codex", Some(second_connection)),
        ]);
    let request = |connection_id| -> CreateMissionRequest {
        serde_json::from_value(json!({
            "title": "Pin destination regression",
            "requested_by": f.ids.alice_actor_id,
            "preferred_adapter": "codex",
            "preferred_model": model().id,
            "strategy": "single",
            "source": source(),
            "workspace_connection_id": connection_id,
            "budget_tokens": 1000,
            "budget_cost_microusd": 1000000,
            "contract": {
                "objective": "Verify same-room pinned identity reuse",
                "expected_output": "result.md",
                "allowed_tools": ["filesystem"],
                "prohibited_actions": ["No external effects"],
                "write_scope": ["result.md"],
            },
        }))
        .unwrap()
    };
    let mut pins = Vec::new();
    // Seed both rooms before pinning either identity, so the baseline defect
    // cannot prevent this fixture from creating the second room's worker.
    for (connection_id, room_id) in [
        (f.connection_id, f.ids.room_id),
        (second_connection, second_room),
    ] {
        let input = request(connection_id);
        let plan = plan_mission(
            &f.state,
            f.ids.corp_id,
            MissionPlanInput::from_create_request(&input, f.ids.alice_actor_id),
        )
        .await
        .unwrap();
        assert_eq!(plan.staffing.len(), 1);
        let agent = plan.tasks[0].assigned_agent_id;
        let (mission, _) = f
            .state
            .store
            .create_mission(
                f.ids.corp_id,
                f.ids.alice_actor_id,
                &input.title,
                &input.description,
                &plan,
            )
            .await?;
        let actual_room: Uuid = sqlx::query_scalar("SELECT room_id FROM missions WHERE id=$1")
            .bind(mission.mission_id)
            .fetch_one(&pool)
            .await?;
        assert_eq!(actual_room, room_id);
        sqlx::query("UPDATE tasks SET status='completed' WHERE mission_id=$1")
            .bind(mission.mission_id)
            .execute(&pool)
            .await?;
        sqlx::query("UPDATE missions SET status='completed' WHERE id=$1")
            .bind(mission.mission_id)
            .execute(&pool)
            .await?;
        pins.push(agent);
    }
    for &agent_id in &pins {
        f.state
            .store
            .set_agent_pin(crony_store::SetAgentPinInput {
                corp_id: f.ids.corp_id,
                agent_id,
                actor_id: f.ids.alice_actor_id,
                pinned: true,
                expected_version: 0,
                idempotency_key: Uuid::new_v4(),
            })
            .await?;
    }
    let defaults = f
        .state
        .store
        .agents_for_planning(f.ids.corp_id, f.ids.alice_actor_id, None)
        .await?;
    assert!(defaults.iter().any(|agent| agent.id == pins[0]));
    assert!(!defaults.iter().any(|agent| agent.id == pins[1]));
    let input = request(second_connection);
    let plan = plan_mission(
        &f.state,
        f.ids.corp_id,
        MissionPlanInput::from_create_request(&input, f.ids.alice_actor_id),
    )
    .await
    .unwrap();
    assert!(
        plan.staffing.is_empty(),
        "reuse the destination's pinned worker"
    );
    assert_eq!(plan.tasks[0].assigned_agent_id, pins[1]);
    let (mission, _) = f
        .state
        .store
        .create_mission(
            f.ids.corp_id,
            f.ids.alice_actor_id,
            &input.title,
            &input.description,
            &plan,
        )
        .await?;
    let actual_room: Uuid = sqlx::query_scalar("SELECT room_id FROM missions WHERE id=$1")
        .bind(mission.mission_id)
        .fetch_one(&pool)
        .await?;
    assert_eq!(actual_room, second_room);
    assert!(
        f.state
            .store
            .agents_for_planning(f.ids.corp_id, f.ids.bob_actor_id, Some(second_room),)
            .await
            .is_err(),
        "membership in the oldest room does not authorize another room"
    );
    assert!(
        f.state
            .store
            .agents_for_planning(Uuid::new_v4(), f.ids.alice_actor_id, Some(second_room),)
            .await
            .is_err(),
        "room membership does not authorize another Corp"
    );
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(second_room)
        .bind(f.ids.alice_actor_id)
        .execute(&pool)
        .await?;
    let error = plan_mission(
        &f.state,
        f.ids.corp_id,
        MissionPlanInput::from_create_request(&input, f.ids.alice_actor_id),
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::FORBIDDEN);
    f.finish().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue79_claim_handler_and_preflight_reject_cost_without_durable_effects(
    pool: PgPool,
) -> Result<()> {
    let f = Fixture::new(pool).await?;
    let before = f.snapshot().await?;
    let initial_events = f
        .state
        .store
        .events_after(f.ids.corp_id, f.ids.alice_actor_id, 0, 1000)
        .await?;
    for cost in [10_000_001, 20_000_000, i64::MAX] {
        let mut request = f.preflight();
        request.budget_cost_microusd = Some(cost);
        request.policy["budget_cost_microusd"] = json!(cost);
        let claim = serde_json::from_value(json!({
            "actor_id": f.ids.alice_actor_id,
            "source_project_owner": "fixture", "source_project_number": 3,
            "source_project_item_id": "issue79-item",
            "source_repository_owner": "fixture", "source_repository_name": "project",
            "source_issue_number": 79, "source_issue_node_id": "issue79-node",
            "source_issue_url": "https://github.com/fixture/project/issues/79",
            "source_title": "Invalid cost claim", "source_revision": "2026-09-16T00:00:00Z",
            "idempotency_key": format!("issue79-handler-{cost}"),
            "lease_seconds": 300, "policy": request.policy,
        }))?;
        let error = claim_factory_work_item(
            State(f.state.clone()),
            Extension(Principal::Development),
            Path(f.ids.corp_id),
            Json(claim),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(error.message.contains("cost budget"), "{}", error.message);
        assert!(
            preflight_factory_mission(
                State(f.state.clone()),
                Extension(Principal::Development),
                Path(f.ids.corp_id),
                Json(request),
            )
            .await
            .is_err()
        );
        assert_eq!(f.snapshot().await?, before);
        let operations: i64 =
            sqlx::query_scalar("SELECT count(*) FROM factory_operations WHERE corp_id=$1")
                .bind(f.ids.corp_id)
                .fetch_one(f.state.store.pool())
                .await?;
        assert_eq!(operations, 0);
        assert_eq!(
            json!(
                f.state
                    .store
                    .events_after(f.ids.corp_id, f.ids.alice_actor_id, 0, 1000)
                    .await?
            ),
            json!(initial_events)
        );
    }
    f.finish().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue204_handler_bound_only_preflight_and_materialization(pool: PgPool) -> Result<()> {
    let f = Fixture::new(pool).await?;
    let before = f.snapshot().await?;
    let checked = preflight_factory_mission(
        State(f.state.clone()),
        Extension(Principal::Development),
        Path(f.ids.corp_id),
        Json(f.preflight()),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    assert!(checked.valid);
    assert_eq!(checked.task_count, 1);
    assert_eq!(f.snapshot().await?, before);
    let request = f.claimed_request().await?;
    let item = f.item().await?;
    let result = materialize_factory_mission(
        State(f.state.clone()),
        Extension(Principal::Development),
        Path((f.ids.corp_id, item.id)),
        Json(request),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    let snapshot = f
        .state
        .store
        .snapshot(f.ids.corp_id, f.ids.alice_actor_id)
        .await?;
    let tasks: Vec<_> = snapshot
        .tasks
        .iter()
        .filter(|task| task.mission_id == result.mission_id)
        .collect();
    assert_eq!(tasks.len(), 1);
    assert_eq!(
        tasks[0].contract.workspace_connection_id,
        Some(f.connection_id)
    );
    assert!(
        snapshot.runs.is_empty(),
        "materialization must not launch work"
    );
    f.finish().await;
    Ok(())
}

async fn assert_admission_conflict_releases_claim(
    pool: PgPool,
    source_changed: bool,
) -> Result<()> {
    let f = Fixture::new(pool).await?;
    let request = f.claimed_request().await?;
    let original = f.item().await?;
    f.change_connection(source_changed).await?;
    let error = materialize_factory_mission(
        State(f.state.clone()),
        Extension(Principal::Development),
        Path((f.ids.corp_id, original.id)),
        Json(request.clone()),
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);
    assert!(
        error.message.contains(if source_changed {
            "saved source changed"
        } else {
            "saved connection needs attention"
        }),
        "{}",
        error.message
    );
    let blocked = f.item().await?;
    assert_eq!(blocked.state, crony_domain::FactoryWorkItemState::Blocked);
    assert_eq!(blocked.policy, original.policy);
    assert!(blocked.mission_id.is_none());
    assert!(blocked.lease_expires_at <= Utc::now());
    let after = f.snapshot().await?;
    assert!(after["missions"].as_array().unwrap().is_empty());
    assert!(after["tasks"].as_array().unwrap().is_empty());
    assert!(after["runs"].as_array().unwrap().is_empty());
    assert!(
        materialize_factory_mission(
            State(f.state.clone()),
            Extension(Principal::Development),
            Path((f.ids.corp_id, original.id)),
            Json(request),
        )
        .await
        .is_err()
    );
    assert_eq!(f.snapshot().await?, after);
    f.finish().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue204_handler_post_claim_readiness_conflict_releases_exact_claim(
    pool: PgPool,
) -> Result<()> {
    assert_admission_conflict_releases_claim(pool, false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue204_handler_post_claim_source_conflict_releases_exact_claim(
    pool: PgPool,
) -> Result<()> {
    assert_admission_conflict_releases_claim(pool, true).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue204_handler_stale_claim_conflicts_do_not_release_current_claim(
    pool: PgPool,
) -> Result<()> {
    let f = Fixture::new(pool).await?;
    let original = f.claimed_request().await?;
    let item = f.item().await?;
    let before = f.snapshot().await?;
    for changed_token in [false, true] {
        let mut request = original.clone();
        if changed_token {
            request.claim_token = Uuid::new_v4();
        } else {
            request.expected_version += 1;
        }
        let error = materialize_factory_mission(
            State(f.state.clone()),
            Extension(Principal::Development),
            Path((f.ids.corp_id, item.id)),
            Json(request),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(f.snapshot().await?, before);
    }
    f.finish().await;
    Ok(())
}
