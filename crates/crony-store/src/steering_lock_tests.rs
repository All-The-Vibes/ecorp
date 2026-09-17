//! Real migration, native store regressions for steering/run-status lock ordering.
use super::*;
use crony_domain::PlannedTask;
use tokio::time::{Duration as StdDuration, timeout};

fn plan(agent_id: Uuid) -> TaskGraphPlan {
    TaskGraphPlan {
        strategy: "single".to_owned(),
        max_nodes: 1,
        max_depth: 0,
        budget_tokens: 1_000,
        budget_cost_microusd: 1_000_000,
        staffing: Vec::new(),
        tasks: vec![PlannedTask {
            key: "deliver".to_owned(),
            title: "Prepare context fixture".to_owned(),
            assigned_agent_id: agent_id,
            required_adapter: "fake-process".to_owned(),
            depends_on: Vec::new(),
            depth: 0,
            max_attempts: 1,
            contract: TaskContract {
                workspace_connection_id: None,
                objective: "Write result.md".to_owned(),
                expected_output: "result.md".to_owned(),
                source_repository: Some("fixture/issue223".to_owned()),
                source_base_ref: Some("main".to_owned()),
                source_base_commit: Some("a".repeat(40)),
                acceptance_tests: vec!["result.md exists".to_owned()],
                allowed_tools: vec!["filesystem".to_owned()],
                prohibited_actions: vec!["merge requires separate authorization".to_owned()],
                references: Vec::new(),
                write_scope: vec!["result.md".to_owned()],
                budget_tokens: 1_000,
                budget_cost_microusd: 1_000_000,
                deadline_at: None,
                escalation: "ask the operator".to_owned(),
                secret_refs: Vec::new(),
                model: None,
                reasoning_effort: None,
                deliverable: None,
            },
            verification_policy: VerificationPolicy {
                checks: vec![VerifierCheck::File {
                    path: "result.md".to_owned(),
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
    run: Uuid,
    token: Uuid,
    lease: Uuid,
}
async fn fixture(pool: PgPool) -> Result<Fixture> {
    let store = PgStore { pool };
    let (ids, _) = store.bootstrap_demo().await?;
    let (mission, _) = store
        .create_mission(
            ids.corp_id,
            ids.alice_actor_id,
            "Issue 223",
            "Deterministic steering fixture",
            &plan(ids.worker_agent_id),
        )
        .await?;
    let run = Uuid::new_v4();
    let token = Uuid::new_v4();
    sqlx::query("INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,workspace_run_id) VALUES($1,$2,$3,$4,'issue223',$5,'running',$1)")
        .bind(run).bind(ids.corp_id).bind(mission.task_ids[0]).bind(ids.worker_agent_id).bind(token).execute(&store.pool).await?;
    sqlx::query("UPDATE agents SET current_run_id=$1,mission_id=$2,status='working' WHERE id=$3")
        .bind(run)
        .bind(mission.mission_id)
        .bind(ids.worker_agent_id)
        .execute(&store.pool)
        .await?;
    sqlx::query("UPDATE missions SET status='running' WHERE id=$1")
        .bind(mission.mission_id)
        .execute(&store.pool)
        .await?;
    sqlx::query("UPDATE tasks SET status='running',attempt_count=1 WHERE id=$1")
        .bind(mission.task_ids[0])
        .execute(&store.pool)
        .await?;
    let lease = store
        .acquire_lease(ids.corp_id, ids.worker_agent_id, ids.alice_actor_id)
        .await?
        .lease
        .token;
    Ok(Fixture {
        store,
        ids,
        run,
        token,
        lease,
    })
}
impl Fixture {
    fn status(&self) -> RunnerEventInput {
        RunnerEventInput {
            event_id: Uuid::new_v4(),
            runner_id: "issue223".into(),
            corp_id: self.ids.corp_id,
            connection_epoch: Uuid::new_v4(),
            run_id: self.run,
            agent_id: self.ids.worker_agent_id,
            assignment_token: self.token,
            event_type: "run.status".into(),
            payload: json!({"status":"working","station":"terminal"}),
        }
    }
    fn message(&self, key: Uuid) -> tokio::task::JoinHandle<Result<MessageOutcome>> {
        let store = self.store.clone();
        let corp = self.ids.corp_id;
        let agent = self.ids.worker_agent_id;
        let actor = self.ids.alice_actor_id;
        let lease = self.lease;
        tokio::spawn(async move {
            store
                .queue_message(corp, agent, actor, Some(lease), "steer fixture", key)
                .await
        })
    }
}
async fn waiting(pool: &PgPool, blocker: i32, query: &str) -> Result<i32> {
    timeout(StdDuration::from_secs(8),async {
        loop {
            if let Some(pid)=sqlx::query_scalar::<_,i32>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2")
                .bind(blocker).bind(query).fetch_optional(pool).await? { return Ok(pid); }
            tokio::task::yield_now().await;
        }
    }).await.context("expected database lock wait not observed")?
}
fn reject<T: std::fmt::Debug>(result: Result<T>, expected: &str) {
    let error = result.unwrap_err();
    for cause in error.chain() {
        if let Some(sqlx::Error::Database(database)) = cause.downcast_ref::<sqlx::Error>() {
            assert_ne!(
                database.code().as_deref(),
                Some("40P01"),
                "a deadlock is not an authorized rejection"
            );
        }
    }
    assert!(
        format!("{error:#}").contains(expected),
        "expected {expected}: {error:#}"
    );
}
async fn ledger(pool: &PgPool) -> Result<Value> {
    let state:Value = sqlx::query_scalar("SELECT jsonb_build_object('runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM runs r),'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),'missions',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM missions m),'agents',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM agents a),'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY agent_id) FROM control_leases l))").fetch_one(pool).await?;
    Ok(json!({"state":state,"messages":messages(pool).await?}))
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue223_steering_and_status_complete_under_observed_contention(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let key = Uuid::new_v4();
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("control-message:{}:{key}", f.ids.corp_id))
        .execute(&mut *gate)
        .await?;
    let message = f.message(key);
    let message_pid = waiting(&f.store.pool, pid, "%pg_advisory_xact_lock%").await?;
    let store = f.store.clone();
    let input = f.status();
    let status = tokio::spawn(async move { store.apply_runner_event(input).await });
    let status_pid = waiting(&f.store.pool, message_pid, "%").await?;
    let query: String = sqlx::query_scalar("SELECT query FROM pg_stat_activity WHERE pid=$1")
        .bind(status_pid)
        .fetch_one(&f.store.pool)
        .await?;
    eprintln!(
        "Observed steering PID {message_pid} blocked by gate {pid}; status PID {status_pid} blocked by steering. Query: {query}"
    );
    gate.commit().await?;
    let (message, status) = timeout(StdDuration::from_secs(8), async {
        tokio::join!(message, status)
    })
    .await?;
    let message = message??;
    status??;
    assert!(
        query.contains("FROM runs r"),
        "status must wait on the run before acquiring the agent"
    );
    assert_eq!(message.delivery, "immediate");
    assert_eq!(message.run_id, Some(f.run));
    let replay = f
        .store
        .queue_message(
            f.ids.corp_id,
            f.ids.worker_agent_id,
            f.ids.alice_actor_id,
            Some(f.lease),
            "steer fixture",
            key,
        )
        .await?;
    assert!(replay.replayed);
    assert_eq!(message.message.id, replay.message.id);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM runner_commands WHERE run_id=$1 AND command_kind='control_message'",
    )
    .bind(f.run)
    .fetch_one(&f.store.pool)
    .await?;
    assert_eq!(count, 1);
    Ok(())
}

async fn messages(pool: &PgPool) -> Result<Value> {
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('messages',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM queued_messages q),'commands',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM runner_commands c),'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY seq),'[]') FROM events e))").fetch_one(pool).await?)
}
#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue223_authority_replay_and_queued_delivery(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    for (corp, actor, token, reason) in [
        (
            Uuid::new_v4(),
            f.ids.alice_actor_id,
            Some(f.lease),
            "actor does not belong",
        ),
        (
            f.ids.corp_id,
            f.ids.eve_actor_id,
            Some(f.lease),
            "not a member",
        ),
        (
            f.ids.corp_id,
            f.ids.alice_actor_id,
            Some(Uuid::new_v4()),
            "stale or unauthorized",
        ),
    ] {
        let before = ledger(&f.store.pool).await?;
        reject(
            f.store
                .queue_message(
                    corp,
                    f.ids.worker_agent_id,
                    actor,
                    token,
                    "denied",
                    Uuid::new_v4(),
                )
                .await,
            reason,
        );
        assert_eq!(ledger(&f.store.pool).await?, before);
    }
    let key = Uuid::new_v4();
    let original = f.message(key).await??;
    let before = messages(&f.store.pool).await?;
    reject(
        f.store
            .queue_message(
                f.ids.corp_id,
                f.ids.worker_agent_id,
                f.ids.alice_actor_id,
                Some(f.lease),
                "different",
                key,
            )
            .await,
        "idempotency key was reused",
    );
    assert_eq!(messages(&f.store.pool).await?, before);
    let other = f
        .store
        .queue_message(
            f.ids.corp_id,
            f.ids.worker_agent_id,
            f.ids.bob_actor_id,
            None,
            "queued",
            Uuid::new_v4(),
        )
        .await?;
    assert_eq!(other.delivery, "queued");
    assert_eq!(other.run_id, None);
    assert!(!other.command_queued);
    sqlx::query("UPDATE runs SET status='completed' WHERE id=$1")
        .bind(f.run)
        .execute(&f.store.pool)
        .await?;
    let replay = f
        .store
        .queue_message(
            f.ids.corp_id,
            f.ids.worker_agent_id,
            f.ids.alice_actor_id,
            Some(f.lease),
            "steer fixture",
            key,
        )
        .await?;
    assert!(replay.replayed);
    assert_eq!(replay.message.id, original.message.id);
    let queued = f.message(Uuid::new_v4()).await??;
    assert_eq!(queued.delivery, "queued");
    sqlx::query("UPDATE agents SET retired_at=now() WHERE id=$1")
        .bind(f.ids.worker_agent_id)
        .execute(&f.store.pool)
        .await?;
    let before = messages(&f.store.pool).await?;
    reject(f.message(Uuid::new_v4()).await?, "retired");
    assert_eq!(messages(&f.store.pool).await?, before);
    Ok(())
}
#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue223_changed_destination_rolls_back(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let before = messages(&f.store.pool).await?;
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    sqlx::query("UPDATE runs SET status='completed' WHERE id=$1")
        .bind(f.run)
        .execute(&mut *gate)
        .await?;
    let message = f.message(Uuid::new_v4());
    waiting(&f.store.pool, pid, "%FOR UPDATE%").await?;
    gate.commit().await?;
    reject(
        timeout(StdDuration::from_secs(8), message).await??,
        "message destination changed",
    );
    assert_eq!(messages(&f.store.pool).await?, before);
    Ok(())
}
#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue223_late_run_is_not_steered_without_its_lock(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    sqlx::query("UPDATE runs SET status='completed' WHERE id=$1")
        .bind(f.run)
        .execute(&f.store.pool)
        .await?;
    let before = messages(&f.store.pool).await?;
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    sqlx::query("SELECT id FROM agents WHERE id=$1 FOR UPDATE")
        .bind(f.ids.worker_agent_id)
        .fetch_one(&mut *gate)
        .await?;
    let message = f.message(Uuid::new_v4());
    waiting(&f.store.pool, pid, "%FROM agents%FOR SHARE%").await?;
    // A legitimate dispatch commits a run while the message has observed no run.
    let late_run = Uuid::new_v4();
    sqlx::query("INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,workspace_run_id) SELECT $2,corp_id,task_id,agent_id,runner_id,$3,'running',$2 FROM runs WHERE id=$1")
        .bind(f.run).bind(late_run).bind(Uuid::new_v4()).execute(&mut *gate).await?;
    sqlx::query("UPDATE agents SET current_run_id=$2 WHERE id=$1")
        .bind(f.ids.worker_agent_id)
        .bind(late_run)
        .execute(&mut *gate)
        .await?;
    gate.commit().await?;
    reject(
        timeout(StdDuration::from_secs(8), message).await??,
        "message destination changed",
    );
    assert_eq!(messages(&f.store.pool).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue223_retirement_while_waiting_rejects_grant(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let before = messages(&f.store.pool).await?;
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    sqlx::query("SELECT id FROM runs WHERE id=$1 FOR UPDATE")
        .bind(f.run)
        .fetch_one(&mut *gate)
        .await?;
    let message = f.message(Uuid::new_v4());
    waiting(&f.store.pool, pid, "%FOR UPDATE%").await?;
    sqlx::query("UPDATE agents SET retired_at=now() WHERE id=$1")
        .bind(f.ids.worker_agent_id)
        .execute(&mut *gate)
        .await?;
    gate.commit().await?;
    reject(
        timeout(StdDuration::from_secs(8), message).await??,
        "retired",
    );
    assert_eq!(messages(&f.store.pool).await?, before);
    Ok(())
}
#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue223_lease_rotation_while_waiting_rejects_stale_token(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let before = messages(&f.store.pool).await?;
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    sqlx::query(
        "UPDATE control_leases SET token=$2,lease_version=lease_version+1 WHERE agent_id=$1",
    )
    .bind(f.ids.worker_agent_id)
    .bind(Uuid::new_v4())
    .execute(&mut *gate)
    .await?;
    let message = f.message(Uuid::new_v4());
    waiting(&f.store.pool, pid, "%FROM control_leases%FOR UPDATE%").await?;
    gate.commit().await?;
    reject(
        timeout(StdDuration::from_secs(8), message).await??,
        "stale or unauthorized",
    );
    assert_eq!(messages(&f.store.pool).await?, before);
    Ok(())
}
#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue223_membership_revocation_rejects_waiting_message(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let before = messages(&f.store.pool).await?;
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(f.ids.room_id)
        .bind(f.ids.alice_actor_id)
        .execute(&mut *gate)
        .await?;
    let message = f.message(Uuid::new_v4());
    waiting(&f.store.pool, pid, "%FROM room_memberships%FOR KEY SHARE%").await?;
    gate.commit().await?;
    reject(
        timeout(StdDuration::from_secs(8), message).await??,
        "not a member",
    );
    assert_eq!(messages(&f.store.pool).await?, before);
    Ok(())
}
#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue223_message_failure_rolls_back_already_inserted_command(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    sqlx::raw_sql("CREATE FUNCTION reject_fixture_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'issue223 injected message failure'; END $$; CREATE TRIGGER reject_fixture_message BEFORE INSERT ON queued_messages FOR EACH ROW EXECUTE FUNCTION reject_fixture_message();")
        .execute(&f.store.pool).await?;
    let before = messages(&f.store.pool).await?;
    let error = f.message(Uuid::new_v4()).await?.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("issue223 injected message failure")
    );
    assert_eq!(messages(&f.store.pool).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue223_stale_assignment_rejected_and_usage_output_preserved(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let before = ledger(&f.store.pool).await?;
    let mut stale = f.status();
    stale.assignment_token = Uuid::new_v4();
    reject(
        f.store.apply_runner_event(stale).await,
        "runner event does not match an active run",
    );
    assert_eq!(ledger(&f.store.pool).await?, before);
    let mut usage = f.status();
    usage.event_type = "run.usage".into();
    usage.payload = json!({"input_tokens":11,"output_tokens":7,"cost_microusd":3});
    f.store.apply_runner_event(usage).await?;
    let mut output = f.status();
    output.event_type = "run.output".into();
    output.payload = json!({"stream":"terminal","text":"retained output"});
    f.store.apply_runner_event(output).await?;
    let original: Value = sqlx::query_scalar(
        "SELECT jsonb_build_array(input_tokens,output_tokens,cost_microusd) FROM runs WHERE id=$1",
    )
    .bind(f.run)
    .fetch_one(&f.store.pool)
    .await?;
    assert_eq!(original, json!([11, 7, 3]));
    let key = Uuid::new_v4();
    f.message(key).await??;
    f.store.apply_runner_event(f.status()).await?;
    let current: Value = sqlx::query_scalar(
        "SELECT jsonb_build_array(input_tokens,output_tokens,cost_microusd) FROM runs WHERE id=$1",
    )
    .bind(f.run)
    .fetch_one(&f.store.pool)
    .await?;
    assert_eq!(current, original);
    let text: String = sqlx::query_scalar(
        "SELECT payload->>'text' FROM events WHERE aggregate_id=$1 AND type='run.output'",
    )
    .bind(f.run)
    .fetch_one(&f.store.pool)
    .await?;
    assert_eq!(text, "retained output");
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue223_replay_retains_original_destination_across_replacement(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let key = Uuid::new_v4();
    let original = f.message(key).await??;
    sqlx::query("UPDATE runs SET status='completed' WHERE id=$1")
        .bind(f.run)
        .execute(&f.store.pool)
        .await?;
    let replacement = Uuid::new_v4();
    sqlx::query("INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,workspace_run_id) SELECT $2,corp_id,task_id,agent_id,runner_id,$3,'running',$2 FROM runs WHERE id=$1")
        .bind(f.run).bind(replacement).bind(Uuid::new_v4()).execute(&f.store.pool).await?;
    sqlx::query("UPDATE agents SET current_run_id=$2 WHERE id=$1")
        .bind(f.ids.worker_agent_id)
        .bind(replacement)
        .execute(&f.store.pool)
        .await?;
    let before = messages(&f.store.pool).await?;
    let mut gate = f.store.pool.begin().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    sqlx::query("UPDATE runs SET status='completed' WHERE id=$1")
        .bind(replacement)
        .execute(&mut *gate)
        .await?;
    let replay = f.message(key);
    waiting(&f.store.pool, pid, "%FOR UPDATE%").await?;
    gate.commit().await?;
    let replay = timeout(StdDuration::from_secs(8), replay).await???;
    assert!(replay.replayed);
    assert_eq!(replay.message.id, original.message.id);
    assert_eq!(replay.run_id, Some(f.run));
    assert_eq!(messages(&f.store.pool).await?, before);
    Ok(())
}
