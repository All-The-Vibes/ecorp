//! Database time is authoritative. Call after the caller's final lock wait.
use super::*;
use crony_domain::{MissionDeadlinePolicy, RunDeadline};

#[derive(Debug)]
pub struct DeadlineExpired;

impl std::fmt::Display for DeadlineExpired {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("mission deadline or declared stage allowance has expired")
    }
}

impl std::error::Error for DeadlineExpired {}

pub(super) async fn admit_plan_tx(
    tx: &mut Transaction<'_, Postgres>,
    plan: &TaskGraphPlan,
) -> Result<()> {
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    plan.admit_deadline_at(now).map_err(anyhow::Error::msg)
}

pub(super) async fn for_task_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    task_id: Uuid,
) -> Result<Option<RunDeadline>> {
    let row = sqlx::query(
        "SELECT mission.deadline_policy, task.plan_key, task.contract,
                clock_timestamp() AS admitted_at
         FROM tasks task JOIN missions mission
           ON mission.id=task.mission_id AND mission.corp_id=task.corp_id
         WHERE task.corp_id=$1 AND task.id=$2",
    )
    .bind(corp_id)
    .bind(task_id)
    .fetch_one(&mut **tx)
    .await?;
    allowance(&row)
}

pub(super) async fn for_run_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
) -> Result<Option<RunDeadline>> {
    let row = sqlx::query(
        "SELECT mission.deadline_policy, task.plan_key, task.contract,
                clock_timestamp() AS admitted_at
         FROM runs run JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
         JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=task.corp_id
         WHERE run.corp_id=$1 AND run.id=$2",
    )
    .bind(corp_id)
    .bind(run_id)
    .fetch_one(&mut **tx)
    .await?;
    allowance(&row)
}

fn allowance(row: &sqlx::postgres::PgRow) -> Result<Option<RunDeadline>> {
    let Some(policy) = row.get::<Option<Value>, _>("deadline_policy") else {
        return Ok(None);
    };
    let policy: MissionDeadlinePolicy =
        serde_json::from_value(policy).context("decode persisted mission deadline")?;
    let contract: TaskContract =
        serde_json::from_value(row.get("contract")).context("decode timed task contract")?;
    if contract.deadline_at != Some(policy.deadline_at) {
        return Err(anyhow!("task differs from its immutable mission deadline"));
    }
    let now: chrono::DateTime<Utc> = row.get("admitted_at");
    let key: &str = row.get("plan_key");
    // Separate an exhausted allowance from malformed policy or database errors.
    let cutoff = policy.task_deadline_at(key).map_err(anyhow::Error::msg)?;
    if (cutoff - now).num_milliseconds() <= 0 {
        return Err(DeadlineExpired.into());
    }
    Ok(Some(
        policy.allowance_at(key, now).map_err(anyhow::Error::msg)?,
    ))
}

pub(super) fn obsolete_if_expired(
    result: Result<Option<RunDeadline>>,
) -> Result<Result<Option<RunDeadline>, DeadlineExpired>> {
    match result {
        Ok(deadline) => Ok(Ok(deadline)),
        Err(error) if error.is::<DeadlineExpired>() => Ok(Err(DeadlineExpired)),
        Err(error) => Err(error),
    }
}

impl PgStore {
    /// Keyset pagination advances even when one mission is locked or malformed.
    /// Successful reconciliations disappear from later pages; no runner or UI
    /// connection is required to reconcile a queued mission.
    pub async fn deadline_missions_after(&self, after: Option<Uuid>) -> Result<Vec<(Uuid, Uuid)>> {
        Ok(sqlx::query_as(
            "SELECT DISTINCT mission.corp_id,mission.id FROM tasks task
             JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=task.corp_id
             WHERE task.deadline_cutoff_at <= statement_timestamp() AND task.status <> 'completed'
               AND mission.status NOT IN ('completed','failed','cancelled')
               AND ($1::uuid IS NULL OR mission.id>$1)
             ORDER BY mission.id,mission.corp_id LIMIT 64",
        )
        .bind(after)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn expire_mission_deadline(
        &self,
        corp_id: Uuid,
        mission_id: Uuid,
    ) -> Result<Vec<DomainEvent>> {
        let mut tx = self.pool.begin().await?;
        // A blocked tenant cannot indefinitely stall the shared lifecycle loop.
        // Retrying a later page never changes deadline or physical-stop truth.
        sqlx::query("SET LOCAL lock_timeout = '250ms'")
            .execute(&mut *tx)
            .await?;
        aggregate_breaker::lock_corp_tx(&mut tx, corp_id).await?;
        let scope =
            factory_run_failure::RunScope::lock_mission_tx(&mut tx, corp_id, mission_id).await?;
        let runs = sqlx::query(
            "SELECT run.id,run.task_id,run.runner_id,run.agent_id,run.breaker_stage
             FROM runs run JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
             WHERE run.corp_id=$1 AND task.mission_id=$2
               AND run.status IN ('provisioning','starting','running','waiting_for_input',
                                  'waiting_for_approval','verifying')
             ORDER BY run.id FOR UPDATE OF run",
        )
        .bind(corp_id)
        .bind(mission_id)
        .fetch_all(&mut *tx)
        .await?;
        let tasks = sqlx::query(
            "SELECT id,plan_key,contract,status FROM tasks
             WHERE corp_id=$1 AND mission_id=$2 ORDER BY id FOR UPDATE",
        )
        .bind(corp_id)
        .bind(mission_id)
        .fetch_all(&mut *tx)
        .await?;
        let mission = sqlx::query(
            "SELECT room_id,status,deadline_policy FROM missions
             WHERE corp_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(corp_id)
        .bind(mission_id)
        .fetch_one(&mut *tx)
        .await?;
        scope.validate_tx(&mut tx, corp_id, mission_id).await?;
        let already_recorded: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM events WHERE corp_id=$1 AND aggregate_id=$2
             AND aggregate_type='mission' AND type='mission.deadline_expired')",
        )
        .bind(corp_id)
        .bind(mission_id)
        .fetch_one(&mut *tx)
        .await?;
        if already_recorded
            || matches!(
                mission.get::<&str, _>("status"),
                "completed" | "failed" | "cancelled"
            )
        {
            return Ok(Vec::new());
        }
        let Some(policy) = mission.get::<Option<Value>, _>("deadline_policy") else {
            return Ok(Vec::new());
        };
        let policy: MissionDeadlinePolicy = serde_json::from_value(policy)?;
        // The authoritative sample follows every lifecycle lock wait. Terminal
        // failures/cancellations still cannot become a fabricated parent handoff.
        let now: chrono::DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&mut *tx)
            .await?;
        let mut expired_tasks = Vec::new();
        for task in &tasks {
            if task.get::<&str, _>("status") == "completed" {
                continue;
            }
            let contract: TaskContract = serde_json::from_value(task.get("contract"))?;
            if contract.deadline_at != Some(policy.deadline_at) {
                return Err(anyhow!("task differs from its immutable mission deadline"));
            }
            if policy
                .task_deadline_at(task.get("plan_key"))
                .map_err(anyhow::Error::msg)?
                <= now
            {
                expired_tasks.push(task.get::<Uuid, _>("id"));
            }
        }
        if expired_tasks.is_empty() {
            return Ok(Vec::new());
        }
        let room_id: Uuid = mission.get("room_id");
        let reason = "Mission deadline or declared stage allowance expired; unfinished work is cancelled and source is retained.";
        let mut events = Vec::new();
        for run in &runs {
            let run_id = run.get("id");
            let command_id = control_accounting::enqueue_stop_tx(
                &mut tx,
                corp_id,
                run_id,
                run.get("runner_id"),
                run.get("task_id"),
                mission_id,
                reason,
                json!({"scope":"mission", "scope_id":mission_id,
                    "metric":"mission_deadline", "policy":policy,
                    "expired_task_ids":expired_tasks, "admitted_at":now}),
            )
            .await?;
            if let Some(event) = append_event_tx(
                &mut tx,
                NewEvent {
                    room_id: Some(room_id),
                    correlation_id: Some(mission_id),
                    ..NewEvent::new(
                        corp_id,
                        None,
                        "run.stop_requested",
                        "run",
                        run_id,
                        format!("mission-deadline:{mission_id}:stop:{run_id}"),
                        json!({"reason":reason, "cause":"mission_deadline_expired",
                        "agent_id":run.get::<Uuid,_>("agent_id"), "command_id":command_id,
                        "stage":"stop", "previous_stage":run.get::<String,_>("breaker_stage"),
                        "physical_stop_confirmed":false}),
                    )
                },
            )
            .await?
            {
                events.push(event);
            }
        }
        let cancelled_tasks: Vec<Uuid> = sqlx::query_scalar(
            "UPDATE tasks SET status='cancelled',updated_at=clock_timestamp()
             WHERE corp_id=$1 AND mission_id=$2 AND status NOT IN ('completed','failed','cancelled')
             RETURNING id",
        )
        .bind(corp_id)
        .bind(mission_id)
        .fetch_all(&mut *tx)
        .await?;
        sqlx::query("UPDATE missions SET status='failed',updated_at=clock_timestamp() WHERE corp_id=$1 AND id=$2")
            .bind(corp_id).bind(mission_id).execute(&mut *tx).await?;
        if let Some(event) =
            factory_run_failure::block_deadline_tx(&mut tx, &scope, corp_id, room_id, reason)
                .await?
        {
            events.push(event);
        }
        let event = append_event_tx(&mut tx, NewEvent {
            room_id: Some(room_id), correlation_id: Some(mission_id),
            ..NewEvent::new(corp_id, None, "mission.deadline_expired", "mission", mission_id,
                format!("mission-deadline:{mission_id}"),
                json!({"deadline_policy":policy, "admitted_at":now, "reason":reason,
                    "previous_status":mission.get::<String,_>("status"), "status":"failed",
                    "expired_task_ids":expired_tasks, "cancelled_task_ids":cancelled_tasks,
                    "stop_requested_run_ids":runs.iter().map(|r| r.get::<Uuid,_>("id")).collect::<Vec<_>>(),
                    "physical_stop_confirmed":false, "budget_reset":false}))
        }).await?.context("mission deadline event unexpectedly existed")?;
        events.push(event);
        tx.commit().await?;
        Ok(events)
    }
}
