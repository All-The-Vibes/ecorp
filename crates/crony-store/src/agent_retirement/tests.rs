use super::*;
use crony_domain::{PlannedAgent, PlannedTask};
use tokio::time::{Duration as StdDuration, timeout};

fn plan(agent: Uuid) -> TaskGraphPlan {
    TaskGraphPlan {
        strategy: "single".into(),
        max_nodes: 1,
        max_depth: 0,
        budget_tokens: 100_000,
        budget_cost_microusd: 1_000_000,
        staffing: vec![PlannedAgent {
            id: agent,
            name: "Retirement fixture".into(),
            role: "engineer".into(),
            adapter: "fake-process".into(),
            accent: "cobalt".into(),
        }],
        tasks: vec![PlannedTask {
            key: "deliver".into(),
            title: "Retirement fixture".into(),
            assigned_agent_id: agent,
            required_adapter: "fake-process".into(),
            depends_on: vec![],
            depth: 0,
            max_attempts: 2,
            contract: TaskContract {
                workspace_connection_id: None,
                objective: "Write result.md".into(),
                expected_output: "result.md".into(),
                source_repository: None,
                source_base_ref: None,
                source_base_commit: None,
                acceptance_tests: vec!["result.md exists".into()],
                allowed_tools: vec!["filesystem".into()],
                prohibited_actions: vec!["Do not publish".into()],
                references: vec![],
                write_scope: vec!["result.md".into()],
                budget_tokens: 100_000,
                budget_cost_microusd: 1_000_000,
                deadline_at: None,
                escalation: "Ask operator".into(),
                secret_refs: vec![],
                model: None,
                reasoning_effort: None,
                deliverable: None,
            },
            verification_policy: VerificationPolicy {
                checks: vec![VerifierCheck::File {
                    path: "result.md".into(),
                    min_bytes: 1,
                }],
                manual_gate: None,
            },
        }],
    }
}

struct Fixture {
    store: PgStore,
    ids: DemoIds,
    agent: Uuid,
    mission: Uuid,
    task: Uuid,
}

async fn fixture(pool: PgPool) -> Result<Fixture> {
    let store = PgStore { pool };
    let (ids, _) = store.bootstrap_demo_with_crew(false).await?;
    let agent = Uuid::new_v4();
    let (mission, _) = store
        .create_mission(
            ids.corp_id,
            ids.alice_actor_id,
            "Retirement fixture",
            "",
            &plan(agent),
        )
        .await?;
    Ok(Fixture {
        store,
        ids,
        agent,
        mission: mission.mission_id,
        task: mission.task_ids[0],
    })
}

impl Fixture {
    fn input(&self) -> RetireAgentsInput {
        RetireAgentsInput {
            corp_id: self.ids.corp_id,
            actor_id: self.ids.alice_actor_id,
            mode: AgentRetirementMode::Retire,
            targets: vec![AgentRetirementTarget {
                agent_id: self.agent,
                expected_pin_version: 0,
            }],
            idempotency_key: Uuid::new_v4(),
        }
    }
    async fn terminal(&self) -> Result<()> {
        sqlx::query("UPDATE missions SET status='completed' WHERE id=$1")
            .bind(self.mission)
            .execute(&self.store.pool)
            .await?;
        sqlx::query("UPDATE tasks SET status='completed' WHERE id=$1")
            .bind(self.task)
            .execute(&self.store.pool)
            .await?;
        Ok(())
    }
    async fn agent(&self) -> Result<Agent> {
        self.store
            .snapshot(self.ids.corp_id, self.ids.alice_actor_id)
            .await?
            .agents
            .into_iter()
            .find(|a| a.id == self.agent)
            .context("fixture agent")
    }
    async fn run(&self) -> Result<Uuid> {
        let run = Uuid::new_v4();
        sqlx::query("INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,workspace_run_id) VALUES($1,$2,$3,$4,'issue48-retirement',$5,'completed',$1)")
            .bind(run).bind(self.ids.corp_id).bind(self.task).bind(self.agent)
            .bind(Uuid::new_v4()).execute(&self.store.pool).await?;
        Ok(run)
    }
    async fn pin(&self, pinned: bool, expected_version: i64) -> Result<()> {
        self.store
            .set_agent_pin(SetAgentPinInput {
                corp_id: self.ids.corp_id,
                actor_id: self.ids.alice_actor_id,
                agent_id: self.agent,
                pinned,
                expected_version,
                idempotency_key: Uuid::new_v4(),
            })
            .await?;
        Ok(())
    }
    async fn run_event(&self, run: Uuid, kind: &str) -> Result<()> {
        let mut tx = self.store.pool.begin().await?;
        append_event_tx(
            &mut tx,
            NewEvent::new(
                self.ids.corp_id,
                None,
                kind,
                "run",
                run,
                Uuid::new_v4().to_string(),
                json!({}),
            ),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

fn reject<T: std::fmt::Debug>(result: Result<T>, reason: &str) {
    let error = result.unwrap_err();
    for cause in error.chain() {
        if let Some(sqlx::Error::Database(database)) = cause.downcast_ref::<sqlx::Error>() {
            assert_ne!(
                database.code().as_deref(),
                Some("40P01"),
                "deadlock is not denial"
            );
        }
    }
    assert!(error.to_string().contains(reason), "{error:#}");
}

// All historical/operational bytes, excluding only the two allowed identity
// changes and the immutable outcome events produced by this operation.
async fn ledger(pool: &PgPool) -> Result<Value> {
    Ok(sqlx::query_scalar(
        "SELECT jsonb_build_object(
          'agents',(SELECT jsonb_agg(to_jsonb(a)-'retired_at'-'station' ORDER BY id) FROM agents a),
          'missions',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM missions m),
          'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
          'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM runs r),
          'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY agent_id) FROM control_leases l),
          'messages',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM queued_messages q),
          'approvals',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM action_approvals p),
          'reviews',(SELECT jsonb_agg(to_jsonb(v) ORDER BY run_id) FROM verification_requests v),
          'commands',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM runner_commands c),
          'artifacts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM artifacts a),
          'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY seq) FROM events e
             WHERE type NOT IN ('agent.retired','agent.retirement_checked')))",
    )
    .fetch_one(pool)
    .await?)
}

#[test]
fn issue48_retirement_request_requires_explicit_bounded_versioned_targets() {
    let valid = RetireAgentsInput {
        corp_id: Uuid::new_v4(),
        actor_id: Uuid::new_v4(),
        mode: AgentRetirementMode::Retire,
        targets: vec![AgentRetirementTarget {
            agent_id: Uuid::new_v4(),
            expected_pin_version: 0,
        }],
        idempotency_key: Uuid::new_v4(),
    };
    assert!(validate_request(&valid).is_ok());
    for variant in 0..6 {
        let mut input = valid.clone();
        match variant {
            0 => input.idempotency_key = Uuid::nil(),
            1 => input.targets.clear(),
            2 => input.targets[0].agent_id = Uuid::nil(),
            3 => input.targets[0].expected_pin_version = -1,
            4 => input.targets.push(input.targets[0].clone()),
            _ => input.targets.push(AgentRetirementTarget {
                agent_id: Uuid::new_v4(),
                expected_pin_version: 0,
            }),
        }
        assert!(validate_request(&input).is_err());
    }
    let mut bulk = valid;
    bulk.mode = AgentRetirementMode::Clear;
    bulk.targets = (0..100)
        .map(|_| AgentRetirementTarget {
            agent_id: Uuid::new_v4(),
            expected_pin_version: 0,
        })
        .collect();
    assert!(validate_request(&bulk).is_ok());
    bulk.targets.push(bulk.targets[0].clone());
    assert!(validate_request(&bulk).is_err());
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_preserves_history_and_uses_room_scoped_audit(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    f.run().await?;
    f.pin(true, 0).await?;
    let mut input = f.input();
    input.targets[0].expected_pin_version = 1;
    let before = ledger(&f.store.pool).await?;
    let outcome = f.store.retire_agents(input.clone()).await?;
    assert_eq!(outcome.results[0].status, AgentRetirementStatus::Retired);
    assert!(outcome.results[0].pinned);
    let agent = f.agent().await?;
    assert!(agent.pinned && agent.retired_at.is_some() && agent.station.is_none());
    assert_eq!(ledger(&f.store.pool).await?, before);
    let event = &outcome.events[0];
    assert_eq!(event.actor_id, Some(f.ids.alice_actor_id));
    assert_eq!(event.room_id, Some(f.ids.room_id));
    assert_eq!(event.correlation_id, Some(f.mission));
    assert_eq!(event.created_at, agent.retired_at.unwrap());
    assert_eq!(event.event_type, "agent.retired");
    for actor in [f.ids.alice_actor_id, f.ids.bob_actor_id] {
        assert!(
            f.store
                .events_after(f.ids.corp_id, actor, event.seq - 1, 100)
                .await?
                .iter()
                .any(|e| e.id == event.id)
        );
    }
    assert!(
        f.store
            .events_after(f.ids.corp_id, f.ids.eve_actor_id, event.seq - 1, 100)
            .await?
            .iter()
            .all(|e| e.id != event.id)
    );
    assert!(
        f.store
            .snapshot(f.ids.corp_id, f.ids.eve_actor_id)
            .await?
            .agents
            .iter()
            .all(|a| a.id != f.agent)
    );
    let replay = f.store.retire_agents(input).await?;
    assert!(replay.replayed && replay.events.is_empty());
    assert_eq!(replay.results, outcome.results);
    let again = f.store.retire_agents(f.input()).await?;
    assert_eq!(
        again.results[0].status,
        AgentRetirementStatus::AlreadyRetired
    );
    assert_eq!(f.agent().await?.retired_at, agent.retired_at);
    assert_eq!(ledger(&f.store.pool).await?, before);
    reject(
        f.store
            .acquire_lease(f.ids.corp_id, f.agent, f.ids.alice_actor_id)
            .await,
        "retired",
    );
    reject(
        f.store
            .queue_message(
                f.ids.corp_id,
                f.agent,
                f.ids.alice_actor_id,
                None,
                "must not resurrect",
                Uuid::new_v4(),
            )
            .await,
        "retired",
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_clear_reports_every_identity_and_never_includes_new_workers(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    let busy = Uuid::new_v4();
    f.store
        .create_mission(
            f.ids.corp_id,
            f.ids.alice_actor_id,
            "Held plan",
            "",
            &plan(busy),
        )
        .await?;
    let pinned = Uuid::new_v4();
    let (pinned_mission, _) = f
        .store
        .create_mission(
            f.ids.corp_id,
            f.ids.alice_actor_id,
            "Pinned",
            "",
            &plan(pinned),
        )
        .await?;
    sqlx::query("UPDATE missions SET status='completed' WHERE id=$1")
        .bind(pinned_mission.mission_id)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("UPDATE agents SET pinned=true WHERE id=$1")
        .bind(pinned)
        .execute(&f.store.pool)
        .await?;
    let mut input = f.input();
    input.mode = AgentRetirementMode::Clear;
    input
        .targets
        .extend([busy, pinned].map(|agent_id| AgentRetirementTarget {
            agent_id,
            expected_pin_version: 0,
        }));
    let later = Uuid::new_v4();
    f.store
        .create_mission(
            f.ids.corp_id,
            f.ids.alice_actor_id,
            "Later",
            "",
            &plan(later),
        )
        .await?;
    let before = ledger(&f.store.pool).await?;
    let result = f.store.retire_agents(input.clone()).await?;
    assert_eq!(result.results.len(), 3);
    assert_eq!(
        result
            .results
            .iter()
            .find(|r| r.agent_id == f.agent)
            .unwrap()
            .status,
        AgentRetirementStatus::Retired
    );
    assert_eq!(
        result
            .results
            .iter()
            .find(|r| r.agent_id == busy)
            .unwrap()
            .blockers,
        vec![AgentRetirementBlocker::AssignedWork]
    );
    assert_eq!(
        result
            .results
            .iter()
            .find(|r| r.agent_id == pinned)
            .unwrap()
            .blockers,
        vec![AgentRetirementBlocker::Pinned]
    );
    assert_eq!(ledger(&f.store.pool).await?, before);
    assert!(
        f.store
            .snapshot(f.ids.corp_id, f.ids.alice_actor_id)
            .await?
            .agents
            .iter()
            .find(|a| a.id == later)
            .unwrap()
            .retired_at
            .is_none()
    );
    for event in &result.events {
        assert_eq!(event.room_id, Some(f.ids.room_id));
        assert!(event.payload.get("targets").is_none());
        assert_eq!(
            event.payload["target"]["agent_id"],
            json!(event.aggregate_id)
        );
    }
    input.targets.reverse();
    let replay = f.store.retire_agents(input).await?;
    assert!(replay.replayed && replay.events.is_empty());
    assert_eq!(result.results, replay.results);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_replay_binds_actor_mode_targets_and_versions(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let original = f.input();
    let blocked = f.store.retire_agents(original.clone()).await?;
    assert_eq!(blocked.results[0].status, AgentRetirementStatus::Blocked);
    f.terminal().await?;
    let replay = f.store.retire_agents(original.clone()).await?;
    assert!(replay.replayed);
    assert_eq!(
        replay.results, blocked.results,
        "replay must not reevaluate a settled obligation"
    );
    assert!(f.agent().await?.retired_at.is_none());
    for variant in 0..4 {
        let mut input = original.clone();
        match variant {
            0 => input.actor_id = f.ids.bob_actor_id,
            1 => input.mode = AgentRetirementMode::Clear,
            2 => input.targets[0].expected_pin_version = 1,
            _ => {
                let other = Uuid::new_v4();
                f.store
                    .create_mission(
                        f.ids.corp_id,
                        f.ids.alice_actor_id,
                        "Other",
                        "",
                        &plan(other),
                    )
                    .await?;
                input.targets[0].agent_id = other;
            }
        }
        reject(f.store.retire_agents(input).await, "another request");
    }
    assert_eq!(
        f.store.retire_agents(f.input()).await?.results[0].status,
        AgentRetirementStatus::Retired
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_detects_pin_unpin_aba(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    f.pin(true, 0).await?;
    f.pin(false, 1).await?;
    let result = f.store.retire_agents(f.input()).await?;
    assert_eq!(
        result.results[0].blockers,
        vec![AgentRetirementBlocker::RetentionChanged]
    );
    assert!(f.agent().await?.retired_at.is_none());
    let mut current = f.input();
    current.targets[0].expected_pin_version = 2;
    assert_eq!(
        f.store.retire_agents(current).await?.results[0].status,
        AgentRetirementStatus::Retired
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_rechecks_current_role_room_and_corp_on_replay(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let original = f.input();
    f.store.retire_agents(original.clone()).await?;
    for (kind, role, allowed) in [
        ("human", "owner", true),
        ("human", "admin", true),
        ("human", "manager", true),
        ("human", "member", true),
        ("human", "guest", false),
        ("human", "spectator", false),
        ("agent", "owner", false),
        ("service", "owner", false),
    ] {
        sqlx::query("UPDATE actors SET kind=$1,role=$2 WHERE id=$3")
            .bind(kind)
            .bind(role)
            .bind(f.ids.alice_actor_id)
            .execute(&f.store.pool)
            .await?;
        let result = f.store.retire_agents(original.clone()).await;
        if allowed {
            assert!(result?.replayed);
        } else {
            reject(result, "forbidden");
        }
    }
    sqlx::query("UPDATE actors SET kind='human',role='owner' WHERE id=$1")
        .bind(f.ids.alice_actor_id)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("DELETE FROM room_memberships WHERE actor_id=$1")
        .bind(f.ids.alice_actor_id)
        .execute(&f.store.pool)
        .await?;
    reject(f.store.retire_agents(original).await, "not a member");
    let before = ledger(&f.store.pool).await?;
    let mut foreign = f.input();
    foreign.corp_id = Uuid::new_v4();
    reject(f.store.retire_agents(foreign).await, "forbidden");
    assert_eq!(ledger(&f.store.pool).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_clear_unauthorized_target_rolls_back_the_entire_request(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    let secret = Uuid::new_v4();
    let (mission, _) = f
        .store
        .create_mission(
            f.ids.corp_id,
            f.ids.alice_actor_id,
            "Private",
            "",
            &plan(secret),
        )
        .await?;
    let room = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO rooms(id,corp_id,name,purpose) VALUES($1,$2,'Private','Retirement fixture')",
    )
    .bind(room)
    .bind(f.ids.corp_id)
    .execute(&f.store.pool)
    .await?;
    sqlx::query("UPDATE missions SET room_id=$1 WHERE id=$2")
        .bind(room)
        .bind(mission.mission_id)
        .execute(&f.store.pool)
        .await?;
    let before = ledger(&f.store.pool).await?;
    let mut input = f.input();
    input.mode = AgentRetirementMode::Clear;
    input.targets.push(AgentRetirementTarget {
        agent_id: secret,
        expected_pin_version: 0,
    });
    reject(f.store.retire_agents(input).await, "not a member");
    assert!(f.agent().await?.retired_at.is_none());
    assert_eq!(ledger(&f.store.pool).await?, before);
    let mut missing = f.input();
    missing.targets[0].agent_id = Uuid::new_v4();
    reject(f.store.retire_agents(missing).await, "does not belong");
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_reports_each_obligation_without_discarding_it(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    let run = f.run().await?;
    f.store
        .acquire_lease(f.ids.corp_id, f.agent, f.ids.bob_actor_id)
        .await?;
    f.store
        .queue_message(
            f.ids.corp_id,
            f.agent,
            f.ids.alice_actor_id,
            None,
            "Keep instruction",
            Uuid::new_v4(),
        )
        .await?;
    sqlx::query(
        "UPDATE agents SET current_run_id=$1,status='working',station='terminal' WHERE id=$2",
    )
    .bind(run)
    .bind(f.agent)
    .execute(&f.store.pool)
    .await?;
    sqlx::query("UPDATE runs SET status='running' WHERE id=$1")
        .bind(run)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("INSERT INTO action_approvals(id,corp_id,room_id,mission_id,task_id,run_id,agent_id,action_key,action,risk,rationale,required_roles,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'retire-fixture','fixture','high','test',ARRAY['owner'],now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(f.ids.corp_id).bind(f.ids.room_id).bind(f.mission).bind(f.task).bind(run).bind(f.agent).execute(&f.store.pool).await?;
    sqlx::query("INSERT INTO verification_requests(run_id,corp_id,task_id,gate_type,gate) VALUES($1,$2,$3,'human_approval',$4)")
        .bind(run).bind(f.ids.corp_id).bind(f.task).bind(json!({"type":"human_approval","roles":["owner"]})).execute(&f.store.pool).await?;
    sqlx::query("INSERT INTO runner_commands(id,corp_id,runner_id,run_id,command_kind,payload,idempotency_key) VALUES($1,$2,'issue48-retirement',$3,'fixture','{}','retire-fixture')")
        .bind(Uuid::new_v4()).bind(f.ids.corp_id).bind(run).execute(&f.store.pool).await?;
    f.run_event(run, "run.session").await?;
    for (blocker, sql) in [
        (
            AgentRetirementBlocker::CurrentRun,
            "UPDATE agents SET current_run_id=NULL",
        ),
        (
            AgentRetirementBlocker::ActiveStatus,
            "UPDATE agents SET status='idle'",
        ),
        (
            AgentRetirementBlocker::ActiveRun,
            "UPDATE runs SET status='completed'",
        ),
        (
            AgentRetirementBlocker::ControlLease,
            "UPDATE control_leases SET expires_at=now()-interval '1 second'",
        ),
        (
            AgentRetirementBlocker::QueuedMessage,
            "UPDATE queued_messages SET status='delivered'",
        ),
        (
            AgentRetirementBlocker::PendingApproval,
            "UPDATE action_approvals SET status='rejected'",
        ),
        (
            AgentRetirementBlocker::PendingVerification,
            "UPDATE verification_requests SET status='approved'",
        ),
        (
            AgentRetirementBlocker::RunnerCommand,
            "UPDATE runner_commands SET status='dispatched'",
        ),
    ] {
        let before = ledger(&f.store.pool).await?;
        let result = f.store.retire_agents(f.input()).await?;
        assert_eq!(result.results[0].status, AgentRetirementStatus::Blocked);
        assert!(
            result.results[0].blockers.contains(&blocker),
            "missing {blocker:?}"
        );
        assert!(f.agent().await?.retired_at.is_none());
        assert_eq!(ledger(&f.store.pool).await?, before);
        sqlx::query(sql).execute(&f.store.pool).await?;
    }
    assert_eq!(
        f.store.retire_agents(f.input()).await?.results[0].blockers,
        vec![AgentRetirementBlocker::ProviderTeardown]
    );
    f.run_event(run, "run.session_terminated").await?;
    f.run_event(run, "run.teardown_uncertain").await?;
    assert_eq!(
        f.store.retire_agents(f.input()).await?.results[0].blockers,
        vec![AgentRetirementBlocker::ProviderTeardown]
    );
    f.run_event(run, "run.session_terminated").await?;
    assert_eq!(
        f.store.retire_agents(f.input()).await?.results[0].status,
        AgentRetirementStatus::Retired
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_checks_every_saved_or_running_assignment(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    for state in ["draft", "ready", "running"] {
        sqlx::query("UPDATE missions SET status=$1 WHERE id=$2")
            .bind(state)
            .bind(f.mission)
            .execute(&f.store.pool)
            .await?;
        for task_state in ["pending", "ready", "failed", "claimed", "blocked"] {
            sqlx::query("UPDATE tasks SET status=$1 WHERE id=$2")
                .bind(task_state)
                .bind(f.task)
                .execute(&f.store.pool)
                .await?;
            assert_eq!(
                f.store.retire_agents(f.input()).await?.results[0].blockers,
                vec![AgentRetirementBlocker::AssignedWork],
                "{state}/{task_state}"
            );
        }
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_concurrent_duplicates_commit_once(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    let input = f.input();
    let (a, b) = timeout(StdDuration::from_secs(10), async {
        tokio::join!(
            f.store.retire_agents(input.clone()),
            f.store.retire_agents(input)
        )
    })
    .await?;
    let (a, b) = (a?, b?);
    assert_ne!(a.replayed, b.replayed);
    assert_eq!(a.results, b.results);
    assert_eq!(a.events.len() + b.events.len(), 1);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_serializes_with_native_authority_grants(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    let (retire, lease) = timeout(StdDuration::from_secs(10), async {
        tokio::join!(
            f.store.retire_agents(f.input()),
            f.store
                .acquire_lease(f.ids.corp_id, f.agent, f.ids.alice_actor_id)
        )
    })
    .await?;
    let retire = retire?;
    match retire.results[0].status {
        AgentRetirementStatus::Retired => reject(lease, "retired"),
        AgentRetirementStatus::Blocked => {
            assert!(lease?.acquired);
            assert!(
                retire.results[0]
                    .blockers
                    .contains(&AgentRetirementBlocker::ControlLease)
            );
            assert!(f.agent().await?.retired_at.is_none());
        }
        other => panic!("unexpected result: {other:?}"),
    }
    Ok(())
}

async fn wait_on(pool: &PgPool, pid: i32) -> Result<()> {
    timeout(StdDuration::from_secs(10), async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))")
                .bind(pid).fetch_one(pool).await?;
            if blocked { return Ok(()); }
            tokio::task::yield_now().await;
        }
    }).await.context("retirement did not wait on the controlled lock")?
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_sees_grants_committed_while_waiting_for_agent(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    // Same lock and row mutation as a native lease grant, held across the wait.
    lock_agent_for_grant_tx(&mut gate, f.ids.corp_id, f.agent).await?;
    sqlx::query("INSERT INTO control_leases(corp_id,agent_id,actor_id,token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(f.ids.corp_id).bind(f.agent).bind(f.ids.alice_actor_id).bind(Uuid::new_v4()).execute(&mut *gate).await?;
    let store = f.store.clone();
    let input = f.input();
    let pending = tokio::spawn(async move { store.retire_agents(input).await });
    wait_on(&f.store.pool, pid).await?;
    gate.commit().await?;
    let result = timeout(StdDuration::from_secs(10), pending).await???;
    assert_eq!(
        result.results[0].blockers,
        vec![AgentRetirementBlocker::ControlLease]
    );
    assert!(f.agent().await?.retired_at.is_none());
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_journal_failure_rolls_back_identity(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    sqlx::raw_sql("CREATE FUNCTION fail_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='agent.retired' THEN RAISE EXCEPTION 'retirement fixture rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_retirement BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION fail_retirement();").execute(&f.store.pool).await?;
    let before = ledger(&f.store.pool).await?;
    assert!(f.store.retire_agents(f.input()).await.is_err());
    assert!(f.agent().await?.retired_at.is_none());
    assert_eq!(ledger(&f.store.pool).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_checks_preserve_automatic_recovery_provenance(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    sqlx::query("UPDATE missions SET status='failed' WHERE id=$1")
        .bind(f.mission)
        .execute(&f.store.pool)
        .await?;
    assert_eq!(f.store.retire_terminal_mission_agents().await?.len(), 1);
    let original = f.agent().await?.retired_at;
    assert_eq!(
        f.store.retire_agents(f.input()).await?.results[0].status,
        AgentRetirementStatus::AlreadyRetired
    );
    assert_eq!(f.agent().await?.retired_at, original);
    sqlx::query("UPDATE missions SET status='running' WHERE id=$1")
        .bind(f.mission)
        .execute(&f.store.pool)
        .await?;
    assert_eq!(f.store.reactivate_running_mission_agents().await?.len(), 1);
    assert!(f.agent().await?.retired_at.is_none());
    sqlx::query("UPDATE missions SET status='failed' WHERE id=$1")
        .bind(f.mission)
        .execute(&f.store.pool)
        .await?;
    assert_eq!(
        f.store.retire_agents(f.input()).await?.results[0].status,
        AgentRetirementStatus::Retired
    );
    sqlx::query("UPDATE missions SET status='running' WHERE id=$1")
        .bind(f.mission)
        .execute(&f.store.pool)
        .await?;
    assert!(
        f.store
            .reactivate_running_mission_agents()
            .await?
            .is_empty()
    );
    assert!(f.agent().await?.retired_at.is_some());
    Ok(())
}

async fn resumable_run(f: &Fixture) -> Result<Uuid> {
    f.terminal().await?;
    let run = f.run().await?;
    // Store-only metadata, with an actual successful admission as the control.
    // This does not claim a physical workspace or live provider session.
    sqlx::query("UPDATE runs SET status='failed', provider_session_id='retirement-session', workspace_disposition='preserved', workspace_base_commit=$1 WHERE id=$2")
        .bind("a".repeat(40)).bind(run).execute(&f.store.pool).await?;
    Ok(run)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_manual_retirement_blocks_otherwise_valid_generic_resume(
    pool: PgPool,
) -> Result<()> {
    let control = fixture(pool.clone()).await?;
    let source = resumable_run(&control).await?;
    let (launch, _) = control
        .store
        .create_resume_run(control.ids.corp_id, source, control.ids.alice_actor_id)
        .await?;
    assert_eq!(launch.source_run_id, source);
    assert_eq!(launch.provider_session_id, "retirement-session");

    let retired = fixture(pool).await?;
    let source = resumable_run(&retired).await?;
    assert_eq!(
        retired.store.retire_agents(retired.input()).await?.results[0].status,
        AgentRetirementStatus::Retired
    );
    let before = ledger(&retired.store.pool).await?;
    let retired_at = retired.agent().await?.retired_at;
    reject(
        retired
            .store
            .create_resume_run(retired.ids.corp_id, source, retired.ids.alice_actor_id)
            .await,
        "manually retired",
    );
    assert_eq!(ledger(&retired.store.pool).await?, before);
    assert_eq!(retired.agent().await?.retired_at, retired_at);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_overlapping_clear_requests_lock_in_stable_order_and_preserve_history(
    pool: PgPool,
) -> Result<()> {
    let a = fixture(pool.clone()).await?;
    let b = fixture(pool).await?;
    for f in [&a, &b] {
        f.terminal().await?;
        f.run().await?;
    }
    let before = ledger(&a.store.pool).await?;
    let mut left = a.input();
    left.mode = AgentRetirementMode::Clear;
    left.targets.push(AgentRetirementTarget {
        agent_id: b.agent,
        expected_pin_version: 0,
    });
    left.targets.sort_by_key(|target| target.agent_id);
    let mut right = left.clone();
    right.idempotency_key = Uuid::new_v4();
    right.targets.reverse();

    let mut gate = a.store.pool.begin().await?;
    sqlx::query("SELECT id FROM agents WHERE id=$1 FOR UPDATE")
        .bind(left.targets[0].agent_id)
        .fetch_one(&mut *gate)
        .await?;
    let store_left = a.store.clone();
    let store_right = a.store.clone();
    let first = tokio::spawn(async move { store_left.retire_agents(left).await });
    let second = tokio::spawn(async move { store_right.retire_agents(right).await });
    timeout(StdDuration::from_secs(10), async {
        loop {
            let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0")
                .fetch_one(&a.store.pool).await?;
            if waiting == 2 { return Ok::<_, anyhow::Error>(()); }
            tokio::task::yield_now().await;
        }
    }).await.context("both Clear requests must reach the controlled row lock")??;
    gate.commit().await?;
    let first = timeout(StdDuration::from_secs(10), first).await???;
    let second = timeout(StdDuration::from_secs(10), second).await???;
    assert!(!first.replayed && !second.replayed);
    for agent in [a.agent, b.agent] {
        let outcomes: Vec<_> = first
            .results
            .iter()
            .chain(&second.results)
            .filter(|result| result.agent_id == agent)
            .collect();
        assert_eq!(outcomes.len(), 2);
        assert_eq!(
            outcomes
                .iter()
                .filter(|result| result.status == AgentRetirementStatus::Retired)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|result| result.status == AgentRetirementStatus::AlreadyRetired)
                .count(),
            1
        );
        assert_eq!(outcomes[0].retired_at, outcomes[1].retired_at);
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM events WHERE aggregate_id=$1 AND type='agent.retired'",
        )
        .bind(agent)
        .fetch_one(&a.store.pool)
        .await?;
        assert_eq!(count, 1);
    }
    assert_eq!(ledger(&a.store.pool).await?, before);
    Ok(())
}

async fn retirement_authority_race(pool: PgPool, room: bool, replay: bool) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    let mut input = f.input();
    input.actor_id = f.ids.bob_actor_id;
    if replay {
        assert_eq!(
            f.store.retire_agents(input.clone()).await?.results[0].status,
            AgentRetirementStatus::Retired
        );
    }
    let before = ledger(&f.store.pool).await?;
    let retired_at = f.agent().await?.retired_at;
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM events")
        .fetch_one(&f.store.pool)
        .await?;
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    if room {
        sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
            .bind(f.ids.room_id)
            .bind(f.ids.bob_actor_id)
            .execute(&mut *gate)
            .await?;
    } else {
        sqlx::query("UPDATE actors SET role='guest' WHERE id=$1")
            .bind(f.ids.bob_actor_id)
            .execute(&mut *gate)
            .await?;
    }
    let store = f.store.clone();
    let pending = tokio::spawn(async move { store.retire_agents(input).await });
    wait_on(&f.store.pool, pid).await?;
    gate.commit().await?;
    reject(
        timeout(StdDuration::from_secs(10), pending).await??,
        if room { "not a member" } else { "forbidden" },
    );
    assert_eq!(ledger(&f.store.pool).await?, before);
    assert_eq!(f.agent().await?.retired_at, retired_at);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM events")
            .fetch_one(&f.store.pool)
            .await?,
        events
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_role_demotion_serializes_before_new_retirement(pool: PgPool) -> Result<()> {
    retirement_authority_race(pool, false, false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_role_demotion_serializes_before_retirement_replay(pool: PgPool) -> Result<()> {
    retirement_authority_race(pool, false, true).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_room_revocation_serializes_before_new_retirement(pool: PgPool) -> Result<()> {
    retirement_authority_race(pool, true, false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_room_revocation_serializes_before_retirement_replay(pool: PgPool) -> Result<()> {
    retirement_authority_race(pool, true, true).await
}
