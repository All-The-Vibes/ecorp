//! Full-migration regressions. Synthetic run metadata is not provider evidence.
use super::*;
use chrono::DateTime;
use crony_domain::{MissionDeadlinePolicy, MissionDeadlineReserve, PlannedTask, RunDeadline};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::time::{Duration as StdDuration, timeout};

const RUNNER: &str = "issue298-deadline-fixture";

fn plan(agent: Uuid, deadline_at: DateTime<Utc>, reserve: Option<u64>) -> TaskGraphPlan {
    TaskGraphPlan {
        deadline: Some(MissionDeadlinePolicy {
            deadline_at,
            reserve: reserve.map(|seconds| MissionDeadlineReserve {
                seconds,
                task_keys: vec!["delivery".into()],
            }),
        }),
        strategy: "pipeline".into(),
        max_nodes: 2,
        max_depth: 1,
        budget_tokens: 2_000,
        budget_cost_microusd: 2_000_000,
        staffing: Vec::new(),
        tasks: ["research", "delivery"]
            .into_iter()
            .enumerate()
            .map(|(index, key)| {
                PlannedTask {
            key: key.into(), title: key.into(), assigned_agent_id: agent,
            required_adapter: "fake-process".into(),
            depends_on: if index == 0 { vec![] } else { vec!["research".into()] },
            depth: index as i32, max_attempts: 3,
            contract: serde_json::from_value(json!({
                "objective":"write result.md", "expected_output":"result.md",
                "source_repository":"fixture/issue298", "source_base_ref":"main",
                "source_base_commit":"a".repeat(40), "acceptance_tests":["result.md exists"],
                "allowed_tools":["filesystem"], "prohibited_actions":["outside the owned worktree"],
                "references":[], "write_scope":["result.md"], "budget_tokens":1000,
                "budget_cost_microusd":1000000, "deadline_at":deadline_at,
                "escalation":"fail the declared time contract"
            })).unwrap(),
            verification_policy: VerificationPolicy {
                checks: vec![VerifierCheck::File { path: "result.md".into(), min_bytes: 1 }],
                manual_gate: None,
            },
        }
            })
            .collect(),
    }
}

struct Fixture {
    store: PgStore,
    ids: DemoIds,
    mission: Uuid,
    parent: Uuid,
    child: Uuid,
    policy: MissionDeadlinePolicy,
}

async fn fixture(pool: PgPool, earlier_seconds: i64, reserve: Option<u64>) -> Result<Fixture> {
    let store = PgStore { pool };
    let (ids, _) = store.bootstrap_demo().await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&store.pool)
        .await?;
    let plan = plan(
        ids.worker_agent_id,
        now + Duration::seconds(earlier_seconds + reserve.unwrap_or(0) as i64),
        reserve,
    );
    let (mission, _) = store
        .create_mission(
            ids.corp_id,
            ids.alice_actor_id,
            "Issue 298",
            "Owned native deadline regression",
            &plan,
        )
        .await?;
    let tasks: Vec<(String, Uuid)> =
        sqlx::query_as("SELECT plan_key,id FROM tasks WHERE mission_id=$1")
            .bind(mission.mission_id)
            .fetch_all(&store.pool)
            .await?;
    let task = |key| {
        tasks
            .iter()
            .find(|(candidate, _)| candidate == key)
            .unwrap()
            .1
    };
    Ok(Fixture {
        store,
        ids,
        mission: mission.mission_id,
        parent: task("research"),
        child: task("delivery"),
        policy: plan.deadline.unwrap(),
    })
}

impl Fixture {
    async fn launch(&self, task: Uuid) -> Result<LaunchRecord> {
        Ok(self
            .store
            .create_task_run(
                self.ids.corp_id,
                self.mission,
                task,
                Some(self.ids.alice_actor_id),
                RUNNER,
            )
            .await?
            .0)
    }

    async fn allowance(&self, run: Uuid, token: Uuid) -> Result<RunDeadline> {
        let outcome = self
            .store
            .with_run_budget_dispatch(self.ids.corp_id, run, token, RUNNER, |deadline| {
                deadline.expect("timed run must retain allowance")
            })
            .await?;
        assert!(
            outcome.commit_error.is_none(),
            "dispatch commit must be observed"
        );
        Ok(outcome.transport_result)
    }

    fn event(&self, run: &LaunchRecord, kind: &str) -> RunnerEventInput {
        RunnerEventInput {
            event_id: Uuid::new_v4(),
            runner_id: RUNNER.into(),
            corp_id: self.ids.corp_id,
            connection_epoch: Uuid::new_v4(),
            run_id: run.run_id,
            agent_id: run.agent_id,
            assignment_token: run.assignment_token,
            event_type: kind.into(),
            payload: json!({"summary":"native metadata fixture"}),
        }
    }

    async fn passed(&self, run: &LaunchRecord) -> Result<()> {
        // Isolate the acceptance transaction from the separately tested verifier.
        // This is synthetic persisted policy state, never a provider receipt.
        sqlx::query("UPDATE runs SET status='running',verification_status='passed' WHERE id=$1")
            .bind(run.run_id)
            .execute(&self.store.pool)
            .await?;
        sqlx::query("UPDATE tasks SET status='running' WHERE id=$1")
            .bind(run.task_id)
            .execute(&self.store.pool)
            .await?;
        Ok(())
    }

    async fn preserved(&self, run: Uuid) -> Result<()> {
        sqlx::query(
            "UPDATE runs SET status='failed',provider_session_id='synthetic-session',
            workspace_disposition='preserved',workspace_path='owned-fixture-worktree',
            workspace_base_commit=$2,workspace_fingerprint=$3 WHERE id=$1",
        )
        .bind(run)
        .bind("a".repeat(40))
        .bind("b".repeat(64))
        .execute(&self.store.pool)
        .await?;
        sqlx::query("UPDATE tasks SET status='failed' WHERE id=$1")
            .bind(self.parent)
            .execute(&self.store.pool)
            .await?;
        sqlx::query("UPDATE agents SET status='idle',current_run_id=NULL WHERE id=$1")
            .bind(self.ids.worker_agent_id)
            .execute(&self.store.pool)
            .await?;
        Ok(())
    }
}

async fn ledger(pool: &PgPool) -> Result<Value> {
    Ok(sqlx::query_scalar("SELECT jsonb_build_object(
        'missions',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM missions m),
        'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
        'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM runs r),
        'agents',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM agents a),
        'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY seq) FROM events e),
        'commands',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM runner_commands c),
        'verification',(SELECT jsonb_agg(to_jsonb(v) ORDER BY run_id) FROM verification_requests v))")
        .fetch_one(pool).await?)
}

async fn authority(f: &Fixture) -> Result<Value> {
    Ok(sqlx::query_scalar(
        "SELECT jsonb_build_object('deadline',deadline_policy,
        'budget_tokens',budget_tokens,'original_budget_tokens',original_budget_tokens,
        'budget_cost',budget_cost_microusd,'original_budget_cost',original_budget_cost_microusd,
        'contracts',(SELECT jsonb_agg(contract ORDER BY plan_key) FROM tasks WHERE mission_id=$1),
        'usage',(SELECT jsonb_build_array(sum(input_tokens),sum(output_tokens),sum(cost_microusd))
          FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.mission_id=$1))
        FROM missions WHERE id=$1",
    )
    .bind(f.mission)
    .fetch_one(&f.store.pool)
    .await?)
}

fn reject<T>(result: Result<T>, expected: &str) {
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("expected admission rejection containing {expected}"),
    };
    for cause in error.chain() {
        if let Some(sqlx::Error::Database(database)) = cause.downcast_ref::<sqlx::Error>() {
            assert_ne!(
                database.code().as_deref(),
                Some("40P01"),
                "deadlock is not admission denial"
            );
        }
    }
    assert!(
        format!("{error:#}").contains(expected),
        "expected {expected}: {error:#}"
    );
}

async fn wait_until(pool: &PgPool, deadline: DateTime<Utc>) -> Result<()> {
    sqlx::query("SELECT pg_sleep((GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))) + 0.015)::double precision)")
        .bind(deadline).execute(pool).await?;
    Ok(())
}

async fn backend(tx: &mut Transaction<'_, Postgres>) -> Result<i32> {
    Ok(sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut **tx)
        .await?)
}

async fn waiting(pool: &PgPool, blocker: i32, query: &str) -> Result<()> {
    timeout(StdDuration::from_secs(8), async {
        loop {
            let pid: Option<i32> = sqlx::query_scalar(
                "SELECT pid FROM pg_stat_activity
                WHERE datname=current_database() AND wait_event_type='Lock'
                  AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2",
            )
            .bind(blocker)
            .bind(query)
            .fetch_optional(pool)
            .await?;
            if let Some(pid) = pid {
                eprintln!("Observed native transaction {pid} waiting on fixture backend {blocker}");
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(StdDuration::from_millis(10)).await;
        }
    })
    .await
    .context("expected native database lock wait was not observed")?
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue298_deadline_policy_scope_and_task_contract_are_immutable(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool, 60, Some(10)).await?;
    let before = ledger(&f.store.pool).await?;
    for sql in [
        "UPDATE missions SET deadline_policy=NULL WHERE id=$1",
        "UPDATE missions SET deadline_policy=jsonb_set(deadline_policy,'{deadline_at}',to_jsonb((clock_timestamp()+interval '1 day')::text)) WHERE id=$1",
        "UPDATE missions SET deadline_policy=deadline_policy-'reserve' WHERE id=$1",
    ] {
        let result = sqlx::query(sql)
            .bind(f.mission)
            .execute(&f.store.pool)
            .await;
        reject(
            result.map_err(Into::into),
            "mission deadline policy is immutable",
        );
    }
    for sql in [
        "UPDATE tasks SET contract=contract-'deadline_at' WHERE id=$1",
        "UPDATE tasks SET contract=jsonb_set(contract,'{deadline_at}',to_jsonb((clock_timestamp()+interval '1 day')::text)) WHERE id=$1",
        "UPDATE tasks SET plan_key='delivery' WHERE id=$1",
        "UPDATE tasks SET mission_id=gen_random_uuid() WHERE id=$1",
        "UPDATE tasks SET corp_id=gen_random_uuid() WHERE id=$1",
    ] {
        let result = sqlx::query(sql).bind(f.parent).execute(&f.store.pool).await;
        reject(result.map_err(Into::into), "deadline");
    }
    let other_corp = Uuid::new_v4();
    let mut tx = f.store.pool.begin().await?;
    assert!(
        mission_deadline::for_task_tx(&mut tx, other_corp, f.parent)
            .await
            .is_err()
    );
    tx.rollback().await?;
    assert!(
        f.store
            .expire_mission_deadline(other_corp, f.mission)
            .await
            .is_err()
    );
    assert_eq!(ledger(&f.store.pool).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue298_expired_creation_and_launch_have_no_partial_effects(pool: PgPool) -> Result<()> {
    let f = fixture(pool, 2, None).await?;
    wait_until(&f.store.pool, f.policy.deadline_at).await?;
    let before = ledger(&f.store.pool).await?;
    let expired_plan = plan(f.ids.worker_agent_id, f.policy.deadline_at, None);
    reject(
        f.store
            .create_mission(
                f.ids.corp_id,
                f.ids.alice_actor_id,
                "Expired",
                "Expired native fixture",
                &expired_plan,
            )
            .await,
        "expired",
    );
    reject(f.launch(f.parent).await, "expired");
    assert_eq!(ledger(&f.store.pool).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue298_creation_rechecks_time_after_event_write_wait(pool: PgPool) -> Result<()> {
    let store = PgStore { pool };
    let (ids, _) = store.bootstrap_demo().await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&store.pool)
        .await?;
    let deadline = now + Duration::seconds(5);
    let plan = plan(ids.worker_agent_id, deadline, None);
    let before = ledger(&store.pool).await?;
    let mut barrier = store.pool.begin().await?;
    let pid = backend(&mut barrier).await?;
    sqlx::query("LOCK TABLE events IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *barrier)
        .await?;
    let creator = store.clone();
    let pending = tokio::spawn(async move {
        creator
            .create_mission(
                ids.corp_id,
                ids.alice_actor_id,
                "Late creation",
                "Native fixture",
                &plan,
            )
            .await
    });
    waiting(&store.pool, pid, "%events%").await?;
    wait_until(&store.pool, deadline).await?;
    barrier.commit().await?;
    reject(
        timeout(StdDuration::from_secs(8), pending).await??,
        "expired",
    );
    assert_eq!(ledger(&store.pool).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue298_dispatch_samples_time_after_observed_corp_lock_wait(pool: PgPool) -> Result<()> {
    let f = fixture(pool, 5, None).await?;
    let run = f.launch(f.parent).await?;
    let before = ledger(&f.store.pool).await?;
    let mut barrier = f.store.pool.begin().await?;
    let pid = backend(&mut barrier).await?;
    aggregate_breaker::lock_corp_tx(&mut barrier, f.ids.corp_id).await?;
    let called = Arc::new(AtomicBool::new(false));
    let sent = called.clone();
    let store = f.store.clone();
    let pending = tokio::spawn(async move {
        store
            .with_run_budget_dispatch(
                run.corp_id,
                run.run_id,
                run.assignment_token,
                RUNNER,
                |_| sent.store(true, Ordering::SeqCst),
            )
            .await
    });
    waiting(&f.store.pool, pid, "%pg_advisory_xact_lock%").await?;
    wait_until(&f.store.pool, f.policy.deadline_at).await?;
    barrier.commit().await?;
    reject(
        timeout(StdDuration::from_secs(8), pending).await??,
        "expired",
    );
    assert!(
        !called.load(Ordering::SeqCst),
        "expired work must never enter transport"
    );
    assert_eq!(ledger(&f.store.pool).await?, before);
    Ok(())
}

async fn late_completion(pool: PgPool, manual: bool) -> Result<()> {
    let f = fixture(pool, 5, None).await?;
    let run = f.launch(f.parent).await?;
    f.passed(&run).await?;
    if manual {
        sqlx::query("UPDATE runs SET status='waiting_for_approval' WHERE id=$1")
            .bind(run.run_id)
            .execute(&f.store.pool)
            .await?;
        sqlx::query("UPDATE tasks SET status='awaiting_approval' WHERE id=$1")
            .bind(run.task_id)
            .execute(&f.store.pool)
            .await?;
        sqlx::query("INSERT INTO verification_requests(run_id,corp_id,task_id,gate_type,gate)
            VALUES($1,$2,$3,'human_approval','{\"type\":\"human_approval\",\"roles\":[\"owner\"]}')")
            .bind(run.run_id).bind(f.ids.corp_id).bind(run.task_id).execute(&f.store.pool).await?;
    }
    let before = ledger(&f.store.pool).await?;
    let mut barrier = f.store.pool.begin().await?;
    let pid = backend(&mut barrier).await?;
    sqlx::query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE")
        .bind(f.child)
        .execute(&mut *barrier)
        .await?;
    let store = f.store.clone();
    let actor = f.ids.alice_actor_id;
    let event = f.event(&run, "run.completed");
    let pending = tokio::spawn(async move {
        if manual {
            store
                .decide_verification(
                    run.corp_id,
                    run.run_id,
                    actor,
                    true,
                    "Synthetic test decision",
                    Some(Uuid::new_v4()),
                )
                .await
                .map(|_| ())
        } else {
            store.apply_runner_event(event).await.map(|_| ())
        }
    });
    waiting(&f.store.pool, pid, "%UPDATE tasks child%").await?;
    wait_until(&f.store.pool, f.policy.deadline_at).await?;
    barrier.commit().await?;
    reject(
        timeout(StdDuration::from_secs(8), pending).await??,
        "expired",
    );
    assert_eq!(
        ledger(&f.store.pool).await?,
        before,
        "late acceptance must roll back the decision, run, task, child readiness and events"
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue298_completion_cannot_commit_after_dependent_row_wait(pool: PgPool) -> Result<()> {
    late_completion(pool, false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue298_approval_cannot_commit_after_dependent_row_wait(pool: PgPool) -> Result<()> {
    late_completion(pool, true).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue298_resume_and_reopened_store_consume_the_same_deadline(pool: PgPool) -> Result<()> {
    let mut f = fixture(pool, 5, None).await?;
    let run = f.launch(f.parent).await?;
    let first = f.allowance(run.run_id, run.assignment_token).await?;
    f.preserved(run.run_id).await?;
    let before = authority(&f).await?;
    sqlx::query("SELECT pg_sleep(0.2)")
        .execute(&f.store.pool)
        .await?;
    let reopened = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(f.store.pool.connect_options().as_ref().clone())
        .await?;
    // A new pool models a server reopening persisted state, without a clock reset.
    f.store = PgStore { pool: reopened };
    let (resumed, _) = f
        .store
        .create_resume_run(f.ids.corp_id, run.run_id, f.ids.alice_actor_id)
        .await?;
    let second = f
        .allowance(resumed.run_id, resumed.assignment_token)
        .await?;
    assert_eq!(first.mission_deadline_at, second.mission_deadline_at);
    assert_eq!(first.task_deadline_at, second.task_deadline_at);
    assert!(first.remaining_ms > second.remaining_ms + 150);
    assert_eq!(resumed.workspace_run_id, run.run_id);
    assert_eq!(
        authority(&f).await?,
        before,
        "resume cannot reset policy or usage"
    );
    f.preserved(resumed.run_id).await?;
    wait_until(&f.store.pool, f.policy.deadline_at).await?;
    let expired_before = ledger(&f.store.pool).await?;
    reject(
        f.store
            .create_resume_run(f.ids.corp_id, resumed.run_id, f.ids.alice_actor_id)
            .await,
        "expired",
    );
    assert_eq!(ledger(&f.store.pool).await?, expired_before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue298_disconnected_expiry_is_idempotent_and_never_claims_physical_stop(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool, 2, None).await?;
    let run = f.launch(f.parent).await?;
    f.passed(&run).await?;
    sqlx::query(
        "UPDATE runs SET input_tokens=11,output_tokens=13,cost_microusd=17,
        workspace_disposition='preserved',workspace_path='owned-fixture-worktree',
        workspace_fingerprint=$2 WHERE id=$1",
    )
    .bind(run.run_id)
    .bind("b".repeat(64))
    .execute(&f.store.pool)
    .await?;
    let before = authority(&f).await?;
    wait_until(&f.store.pool, f.policy.deadline_at).await?;
    let events = f
        .store
        .expire_mission_deadline(f.ids.corp_id, f.mission)
        .await?;
    assert_eq!(
        events
            .iter()
            .filter(|e| e.event_type == "mission.deadline_expired")
            .count(),
        1
    );
    let expired = ledger(&f.store.pool).await?;
    assert!(
        f.store
            .expire_mission_deadline(f.ids.corp_id, f.mission)
            .await?
            .is_empty()
    );
    assert_eq!(ledger(&f.store.pool).await?, expired);
    assert_eq!(authority(&f).await?, before);
    let state: (String, String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT status,breaker_stage,workspace_disposition,workspace_path FROM runs WHERE id=$1",
    )
    .bind(run.run_id)
    .fetch_one(&f.store.pool)
    .await?;
    assert_eq!(
        state,
        (
            "running".into(),
            "stop".into(),
            Some("preserved".into()),
            Some("owned-fixture-worktree".into())
        )
    );
    let stops: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM runner_commands WHERE run_id=$1
         AND command_kind='circuit_breaker' AND payload->>'stage'='stop'",
    )
    .bind(run.run_id)
    .fetch_one(&f.store.pool)
    .await?;
    assert_eq!(stops, 1);
    let truth: Value = sqlx::query_scalar(
        "SELECT payload FROM events WHERE aggregate_id=$1 AND type='mission.deadline_expired'",
    )
    .bind(f.mission)
    .fetch_one(&f.store.pool)
    .await?;
    assert_eq!(truth["physical_stop_confirmed"], false);
    assert_eq!(truth["budget_reset"], false);
    assert_eq!(truth["status"], "failed");
    reject(
        f.store
            .apply_runner_event(f.event(&run, "run.completed"))
            .await,
        "blocked",
    );
    f.store
        .apply_runner_event(f.event(&run, "run.cancelled"))
        .await?;
    let cancelled = ledger(&f.store.pool).await?;
    assert!(
        f.store
            .apply_runner_event(f.event(&run, "run.completed"))
            .await
            .is_err()
    );
    assert!(
        f.store
            .create_resume_run(f.ids.corp_id, run.run_id, f.ids.alice_actor_id)
            .await
            .is_err()
    );
    reject(f.launch(f.child).await, "already failed");
    assert_eq!(ledger(&f.store.pool).await?, cancelled);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue298_queued_parent_exhausting_reserve_fails_without_fabricated_handoff(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool, 2, Some(10)).await?;
    let before = authority(&f).await?;
    let cutoff = f
        .policy
        .task_deadline_at("research")
        .map_err(anyhow::Error::msg)?;
    wait_until(&f.store.pool, cutoff).await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&f.store.pool)
        .await?;
    assert!(f.policy.allowance_at("delivery", now).unwrap().remaining_ms > 5_000);
    f.store
        .expire_mission_deadline(f.ids.corp_id, f.mission)
        .await?;
    let statuses: Vec<String> =
        sqlx::query_scalar("SELECT status FROM tasks WHERE mission_id=$1 ORDER BY plan_key")
            .bind(f.mission)
            .fetch_all(&f.store.pool)
            .await?;
    assert_eq!(statuses, ["cancelled", "cancelled"]);
    assert_eq!(authority(&f).await?, before);
    reject(f.launch(f.child).await, "already failed");
    let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM runs")
        .fetch_one(&f.store.pool)
        .await?;
    assert_eq!(runs, 0, "queue expiration cannot invent a handoff run");
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue298_completed_parent_leaves_only_actual_shared_time_for_reserved_child(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool, 10, Some(10)).await?;
    let run = f.launch(f.parent).await?;
    let parent_allowance = f.allowance(run.run_id, run.assignment_token).await?;
    f.passed(&run).await?;
    let before = authority(&f).await?;
    f.store
        .apply_runner_event(f.event(&run, "run.completed"))
        .await?;
    let child = f.launch(f.child).await?;
    let child_allowance = f.allowance(child.run_id, child.assignment_token).await?;
    assert_eq!(child_allowance.task_deadline_at, f.policy.deadline_at);
    assert_eq!(
        child_allowance.mission_deadline_at,
        parent_allowance.mission_deadline_at
    );
    assert!(child_allowance.remaining_ms < parent_allowance.remaining_ms + 10_000);
    assert!(child_allowance.remaining_ms > parent_allowance.remaining_ms);
    assert_eq!(authority(&f).await?, before);
    assert!(
        f.store
            .expire_mission_deadline(f.ids.corp_id, f.mission)
            .await?
            .is_empty()
    );
    Ok(())
}
