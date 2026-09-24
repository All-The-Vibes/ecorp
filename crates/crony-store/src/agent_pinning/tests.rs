use super::*;
use crony_domain::{PlannedAgent, PlannedTask};
use tokio::time::{Duration as StdDuration, timeout};

fn plan(agent: Uuid, provision: bool) -> TaskGraphPlan {
    TaskGraphPlan {
        strategy: "single".into(),
        max_nodes: 1,
        max_depth: 0,
        budget_tokens: 100_000,
        budget_cost_microusd: 1_000_000,
        staffing: if provision {
            vec![PlannedAgent {
                id: agent,
                name: "Pin fixture".into(),
                role: "engineer".into(),
                adapter: "fake-process".into(),
                accent: "cobalt".into(),
            }]
        } else {
            vec![]
        },
        tasks: vec![PlannedTask {
            key: "deliver".into(),
            title: "Pin lifecycle fixture".into(),
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
            "Pin fixture",
            "",
            &plan(agent, true),
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
    fn input(&self, pinned: bool, version: i64) -> SetAgentPinInput {
        SetAgentPinInput {
            corp_id: self.ids.corp_id,
            agent_id: self.agent,
            actor_id: self.ids.alice_actor_id,
            pinned,
            expected_version: version,
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
        sqlx::query("INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,workspace_run_id) VALUES($1,$2,$3,$4,'issue48',$5,'running',$1)")
            .bind(run).bind(self.ids.corp_id).bind(self.task).bind(self.agent).bind(Uuid::new_v4()).execute(&self.store.pool).await?;
        Ok(run)
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

async fn ledger(pool: &PgPool) -> Result<Value> {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
          'agents',(SELECT jsonb_agg(to_jsonb(a)-'pinned' ORDER BY id) FROM agents a),
          'missions',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM missions m),
          'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
          'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM runs r),
          'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY agent_id) FROM control_leases l),
          'messages',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM queued_messages q),
          'approvals',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM action_approvals a),
          'reviews',(SELECT jsonb_agg(to_jsonb(v) ORDER BY run_id) FROM verification_requests v),
          'commands',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM runner_commands c),
          'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY seq) FROM events e
             WHERE type NOT IN ('agent.pinned','agent.unpinned')))",
    )
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_roles_match_operate_and_require_human(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let mut version = 0;
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
            .bind(f.ids.bob_actor_id)
            .execute(&f.store.pool)
            .await?;
        let before = ledger(&f.store.pool).await?;
        let mut input = f.input(true, version);
        input.actor_id = f.ids.bob_actor_id;
        let result = f.store.set_agent_pin(input).await;
        if allowed {
            version += 1;
            assert_eq!(result?.pin_version, version);
        } else {
            reject(result, "forbidden");
        }
        assert_eq!(ledger(&f.store.pool).await?, before);
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_exact_replay_does_not_undo_newer_unpin_or_retirement(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let pin = f.input(true, 0);
    let result = f.store.set_agent_pin(pin.clone()).await?;
    assert!(!result.replayed);
    let event = result.event.unwrap();
    assert_eq!(event.actor_id, Some(f.ids.alice_actor_id));
    assert_eq!(event.room_id, Some(f.ids.room_id));
    assert_eq!(event.correlation_id, Some(f.mission));
    assert_eq!(event.event_type, "agent.pinned");
    f.terminal().await?;
    assert!(f.store.retire_terminal_mission_agents().await?.is_empty());
    f.store.set_agent_pin(f.input(false, 1)).await?;
    assert_eq!(f.store.retire_terminal_mission_agents().await?.len(), 1);
    let before = ledger(&f.store.pool).await?;
    let replay = f.store.set_agent_pin(pin).await?;
    assert!(replay.replayed && replay.pinned && replay.event.is_none());
    assert_eq!(replay.pin_version, 1);
    let current = f.agent().await?;
    assert!(!current.pinned && current.retired_at.is_some());
    assert_eq!(current.pin_version, 2);
    reject(f.store.set_agent_pin(f.input(true, 2)).await, "retired");
    reject(f.store.set_agent_pin(f.input(false, 2)).await, "retired");
    assert_eq!(ledger(&f.store.pool).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_replay_rejects_key_substitution_and_stale_aba(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let pin = f.input(true, 0);
    f.store.set_agent_pin(pin.clone()).await?;
    for variant in 0..3 {
        let mut input = pin.clone();
        match variant {
            0 => input.pinned = false,
            1 => input.expected_version = 1,
            _ => input.actor_id = f.ids.bob_actor_id,
        }
        reject(f.store.set_agent_pin(input).await, "another request");
    }
    let (other, _) = f
        .store
        .create_mission(
            f.ids.corp_id,
            f.ids.alice_actor_id,
            "Another",
            "",
            &plan(Uuid::new_v4(), true),
        )
        .await?;
    let mut input = pin.clone();
    input.agent_id = sqlx::query_scalar("SELECT assigned_agent_id FROM tasks WHERE id=$1")
        .bind(other.task_ids[0])
        .fetch_one(&f.store.pool)
        .await?;
    reject(f.store.set_agent_pin(input).await, "another request");
    f.store.set_agent_pin(f.input(false, 1)).await?;
    reject(
        f.store.set_agent_pin(f.input(true, 0)).await,
        "version changed",
    );
    assert_eq!(f.agent().await?.pin_version, 2);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_foreign_missing_and_invalid_requests_do_not_mutate(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let before = ledger(&f.store.pool).await?;
    for variant in 0..6 {
        let mut input = f.input(true, 0);
        match variant {
            0 => input.corp_id = Uuid::new_v4(),
            1 => input.agent_id = Uuid::new_v4(),
            2 => input.actor_id = Uuid::new_v4(),
            3 => input.expected_version = -1,
            4 => input.idempotency_key = Uuid::nil(),
            _ => input.actor_id = f.ids.eve_actor_id,
        }
        assert!(f.store.set_agent_pin(input).await.is_err());
        assert_eq!(ledger(&f.store.pool).await?, before);
    }
    assert_eq!(f.agent().await?.pin_version, 0);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_current_authority_required_on_new_operations_and_replay(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let mut pin = f.input(true, 0);
    pin.actor_id = f.ids.bob_actor_id;
    f.store.set_agent_pin(pin.clone()).await?;
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(f.ids.room_id)
        .bind(f.ids.bob_actor_id)
        .execute(&f.store.pool)
        .await?;
    let before = ledger(&f.store.pool).await?;
    reject(f.store.set_agent_pin(pin.clone()).await, "not a member");
    let mut unpin = f.input(false, 1);
    unpin.actor_id = f.ids.bob_actor_id;
    reject(f.store.set_agent_pin(unpin).await, "not a member");
    assert_eq!(ledger(&f.store.pool).await?, before);
    sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
        .bind(f.ids.room_id)
        .bind(f.ids.bob_actor_id)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("UPDATE actors SET role='guest' WHERE id=$1")
        .bind(f.ids.bob_actor_id)
        .execute(&f.store.pool)
        .await?;
    reject(f.store.set_agent_pin(pin).await, "forbidden");
    assert_eq!(f.agent().await?.pin_version, 1);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_journal_and_snapshot_obey_room_visibility(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let event = f
        .store
        .set_agent_pin(f.input(true, 0))
        .await?
        .event
        .unwrap();
    for actor in [f.ids.alice_actor_id, f.ids.bob_actor_id] {
        let events = f
            .store
            .events_after(f.ids.corp_id, actor, event.seq - 1, 100)
            .await?;
        assert!(events.iter().any(|e| e.id == event.id));
        let snapshot = f.store.snapshot(f.ids.corp_id, actor).await?;
        assert!(
            snapshot
                .agents
                .iter()
                .any(|a| a.id == f.agent && a.pinned && a.pin_version == 1)
        );
    }
    let events = f
        .store
        .events_after(f.ids.corp_id, f.ids.eve_actor_id, event.seq - 1, 100)
        .await?;
    assert!(events.iter().all(|e| e.id != event.id));
    let snapshot = f.store.snapshot(f.ids.corp_id, f.ids.eve_actor_id).await?;
    assert!(snapshot.agents.iter().all(|a| a.id != f.agent));
    Ok(())
}

async fn obligations(f: &Fixture, run: Uuid) -> Result<()> {
    f.store
        .acquire_lease(f.ids.corp_id, f.agent, f.ids.bob_actor_id)
        .await?;
    f.store
        .queue_message(
            f.ids.corp_id,
            f.agent,
            f.ids.alice_actor_id,
            None,
            "Retain queued instruction",
            Uuid::new_v4(),
        )
        .await?;
    sqlx::query("INSERT INTO action_approvals(id,corp_id,room_id,mission_id,task_id,run_id,agent_id,action_key,action,risk,rationale,required_roles,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pin-fixture','fixture','high','test',ARRAY['owner'],now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(f.ids.corp_id).bind(f.ids.room_id).bind(f.mission).bind(f.task).bind(run).bind(f.agent).execute(&f.store.pool).await?;
    sqlx::query("INSERT INTO verification_requests(run_id,corp_id,task_id,gate_type,gate) VALUES($1,$2,$3,'human_approval',$4)")
        .bind(run).bind(f.ids.corp_id).bind(f.task)
        .bind(json!({"type":"human_approval","roles":["owner"]}))
        .execute(&f.store.pool).await?;
    sqlx::query("INSERT INTO runner_commands(id,corp_id,runner_id,run_id,command_kind,payload,idempotency_key) VALUES($1,$2,'issue48',$3,'fixture','{}','pin-fixture')")
        .bind(Uuid::new_v4()).bind(f.ids.corp_id).bind(run).execute(&f.store.pool).await?;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_active_work_and_every_obligation_are_byte_preserved(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let run = f.run().await?;
    sqlx::query(
        "UPDATE agents SET current_run_id=$1,status='working',station='terminal' WHERE id=$2",
    )
    .bind(run)
    .bind(f.agent)
    .execute(&f.store.pool)
    .await?;
    obligations(&f, run).await?;
    let before = ledger(&f.store.pool).await?;
    f.store.set_agent_pin(f.input(true, 0)).await?;
    f.store.set_agent_pin(f.input(false, 1)).await?;
    assert_eq!(ledger(&f.store.pool).await?, before);
    f.terminal().await?;
    assert!(f.store.retire_terminal_mission_agents().await?.is_empty());
    assert_eq!(f.agent().await?.current_run_id, Some(run));
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_unpin_waits_for_each_terminal_obligation(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let run = f.run().await?;
    obligations(&f, run).await?;
    f.terminal().await?;
    f.store.set_agent_pin(f.input(true, 0)).await?;
    f.store.set_agent_pin(f.input(false, 1)).await?;
    for sql in [
        "UPDATE runs SET status='completed'",
        "UPDATE control_leases SET expires_at=now()-interval '1 second'",
        "UPDATE queued_messages SET status='delivered'",
        "UPDATE action_approvals SET status='rejected'",
        "UPDATE verification_requests SET status='approved'",
    ] {
        assert!(f.store.retire_terminal_mission_agents().await?.is_empty());
        sqlx::query(sql).execute(&f.store.pool).await?;
    }
    assert!(f.store.retire_terminal_mission_agents().await?.is_empty());
    sqlx::query("UPDATE runner_commands SET status='dispatched'")
        .execute(&f.store.pool)
        .await?;
    let before = ledger(&f.store.pool).await?;
    assert_eq!(f.store.retire_terminal_mission_agents().await?.len(), 1);
    let after = ledger(&f.store.pool).await?;
    for key in [
        "missions",
        "tasks",
        "runs",
        "leases",
        "messages",
        "approvals",
        "reviews",
        "commands",
    ] {
        assert_eq!(before[key], after[key], "{key} must survive retirement");
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_pinned_reuse_then_unpin_preserves_saved_plan(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    f.store.set_agent_pin(f.input(true, 0)).await?;
    assert_eq!(
        f.store
            .agents_for_planning(f.ids.corp_id, f.ids.alice_actor_id, None)
            .await?
            .len(),
        1
    );
    let (next, _) = f
        .store
        .create_mission(
            f.ids.corp_id,
            f.ids.alice_actor_id,
            "Reused identity",
            "",
            &plan(f.agent, false),
        )
        .await?;
    f.store.set_agent_pin(f.input(false, 1)).await?;
    assert!(f.store.retire_terminal_mission_agents().await?.is_empty());
    assert!(f.agent().await?.retired_at.is_none());
    assert!(
        f.store
            .agents_for_planning(f.ids.corp_id, f.ids.alice_actor_id, None)
            .await?
            .is_empty()
    );
    assert!(
        f.store
            .create_mission(
                f.ids.corp_id,
                f.ids.alice_actor_id,
                "No new reuse",
                "",
                &plan(f.agent, false)
            )
            .await
            .is_err()
    );
    sqlx::query("UPDATE missions SET status='running' WHERE id=$1")
        .bind(next.mission_id)
        .execute(&f.store.pool)
        .await?;
    assert!(f.store.retire_terminal_mission_agents().await?.is_empty());
    sqlx::query("UPDATE missions SET status='cancelled' WHERE id=$1")
        .bind(next.mission_id)
        .execute(&f.store.pool)
        .await?;
    assert_eq!(f.store.retire_terminal_mission_agents().await?.len(), 1);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_concurrent_exact_requests_commit_once(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let pin = f.input(true, 0);
    let (a, b) = timeout(StdDuration::from_secs(10), async {
        tokio::join!(
            f.store.set_agent_pin(pin.clone()),
            f.store.set_agent_pin(pin)
        )
    })
    .await?;
    let (a, b) = (a?, b?);
    assert_ne!(a.replayed, b.replayed);
    assert_eq!(f.agent().await?.pin_version, 1);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_concurrent_different_operators_use_expected_version(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let a = f.input(true, 0);
    let mut b = f.input(false, 0);
    b.actor_id = f.ids.bob_actor_id;
    let (a, b) = timeout(StdDuration::from_secs(10), async {
        tokio::join!(f.store.set_agent_pin(a), f.store.set_agent_pin(b))
    })
    .await?;
    assert_ne!(a.is_ok(), b.is_ok());
    reject(if a.is_err() { a } else { b }, "version changed");
    assert_eq!(f.agent().await?.pin_version, 1);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_pin_serializes_with_automatic_retirement(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    f.terminal().await?;
    let (pin, retired) = timeout(StdDuration::from_secs(10), async {
        tokio::join!(
            f.store.set_agent_pin(f.input(true, 0)),
            f.store.retire_terminal_mission_agents()
        )
    })
    .await?;
    let retired = retired?;
    let agent = f.agent().await?;
    if pin.is_ok() {
        assert!(retired.is_empty() && agent.pinned && agent.retired_at.is_none());
    } else {
        reject(pin, "retired");
        assert_eq!(retired.len(), 1);
        assert!(!agent.pinned && agent.retired_at.is_some());
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
    }).await.context("pin operation did not wait on the controlled lock")?
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_role_demotion_serializes_before_replay(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let mut pin = f.input(true, 0);
    pin.actor_id = f.ids.bob_actor_id;
    f.store.set_agent_pin(pin.clone()).await?;
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    sqlx::query("UPDATE actors SET role='guest' WHERE id=$1")
        .bind(f.ids.bob_actor_id)
        .execute(&mut *gate)
        .await?;
    let store = f.store.clone();
    let pending = tokio::spawn(async move { store.set_agent_pin(pin).await });
    wait_on(&f.store.pool, pid).await?;
    gate.commit().await?;
    reject(
        timeout(StdDuration::from_secs(10), pending).await??,
        "forbidden",
    );
    assert_eq!(f.agent().await?.pin_version, 1);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_room_revocation_serializes_before_new_pin(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(f.ids.room_id)
        .bind(f.ids.bob_actor_id)
        .execute(&mut *gate)
        .await?;
    let mut pin = f.input(true, 0);
    pin.actor_id = f.ids.bob_actor_id;
    let store = f.store.clone();
    let pending = tokio::spawn(async move { store.set_agent_pin(pin).await });
    wait_on(&f.store.pool, pid).await?;
    gate.commit().await?;
    reject(
        timeout(StdDuration::from_secs(10), pending).await??,
        "not a member",
    );
    assert_eq!(f.agent().await?.pin_version, 0);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_event_failure_rolls_back_flag_and_version(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    sqlx::raw_sql("CREATE FUNCTION fail_pin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='agent.pinned' THEN RAISE EXCEPTION 'pin fixture rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_pin BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION fail_pin();").execute(&f.store.pool).await?;
    let before = ledger(&f.store.pool).await?;
    assert!(f.store.set_agent_pin(f.input(true, 0)).await.is_err());
    assert!(!f.agent().await?.pinned);
    assert_eq!(f.agent().await?.pin_version, 0);
    assert_eq!(ledger(&f.store.pool).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_unpin_keeps_native_recovered_activation_contract(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    f.store.set_agent_pin(f.input(true, 0)).await?;
    f.store.set_agent_pin(f.input(false, 1)).await?;
    sqlx::query("UPDATE missions SET status='failed' WHERE id=$1")
        .bind(f.mission)
        .execute(&f.store.pool)
        .await?;
    assert_eq!(f.store.retire_terminal_mission_agents().await?.len(), 1);
    sqlx::query("UPDATE missions SET status='running' WHERE id=$1")
        .bind(f.mission)
        .execute(&f.store.pool)
        .await?;
    assert_eq!(f.store.reactivate_running_mission_agents().await?.len(), 1);
    assert!(f.agent().await?.retired_at.is_none());
    assert_eq!(f.agent().await?.pin_version, 2);
    assert!(
        f.store
            .reactivate_running_mission_agents()
            .await?
            .is_empty()
    );
    Ok(())
}
