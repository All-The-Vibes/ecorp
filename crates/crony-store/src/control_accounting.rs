//! Hard-control accounting uses authoritative database time, never runner clocks.
use super::*;

pub(super) const USAGE_GRACE_SECONDS: i64 = 5;

#[allow(clippy::too_many_arguments)]
pub(super) async fn enqueue_emergency_stop_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
    runner_id: &str,
    task_id: Uuid,
    mission_id: Uuid,
    actor_id: Uuid,
    reason: &str,
) -> Result<Uuid> {
    enqueue_stop_tx(
        tx,
        corp_id,
        run_id,
        runner_id,
        task_id,
        mission_id,
        reason,
        json!({"scope":"run","scope_id":run_id,"metric":"operator_stop","actor_id":actor_id}),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn enqueue_stop_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
    runner_id: &str,
    task_id: Uuid,
    mission_id: Uuid,
    reason: &str,
    input: Value,
) -> Result<Uuid> {
    // Reuse the existing monotonic breaker boundary and durable runner command.
    // Repeated stop requests never replace the first incident or its timestamp.
    sqlx::query(
        "UPDATE runs SET breaker_stage='stop', updated_at=clock_timestamp()
                 WHERE id=$1 AND corp_id=$2",
    )
    .bind(run_id)
    .bind(corp_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO circuit_breaker_incidents
         (id,corp_id,mission_id,task_id,run_id,stage,reason,input,created_at)
         VALUES($1,$2,$3,$4,$5,'stop',$6,$7,clock_timestamp())
         ON CONFLICT (run_id,stage) DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(corp_id)
    .bind(mission_id)
    .bind(task_id)
    .bind(run_id)
    .bind(reason)
    .bind(input)
    .execute(&mut **tx)
    .await?;
    let key = format!("breaker:{run_id}:stop");
    sqlx::query(
        "INSERT INTO runner_commands
         (id,corp_id,runner_id,run_id,command_kind,payload,idempotency_key,created_at)
         VALUES($1,$2,$3,$4,'circuit_breaker',$5,$6,clock_timestamp())
         ON CONFLICT (corp_id,idempotency_key) DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(corp_id)
    .bind(runner_id)
    .bind(run_id)
    .bind(json!({"stage":"stop","reason":reason}))
    .bind(&key)
    .execute(&mut **tx)
    .await?;
    sqlx::query_scalar(
        "SELECT id FROM runner_commands WHERE corp_id=$1 AND idempotency_key=$2
         AND runner_id=$3 AND run_id=$4 AND command_kind='circuit_breaker'
         AND payload->>'stage'='stop'",
    )
    .bind(corp_id)
    .bind(key)
    .bind(runner_id)
    .bind(run_id)
    .fetch_one(&mut **tx)
    .await
    .context("emergency stop command conflicts with its authoritative scope")
}

pub(super) async fn admit_usage_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
    stage: &str,
    status: &str,
    mut payload: Value,
) -> Result<(String, Value)> {
    // The caller already holds the Corp and exact run locks. A transaction that
    // waited for those locks must not use its earlier transaction-start time.
    let row = sqlx::query(
        r#"
        SELECT clock_timestamp() AS admitted_at,
               (SELECT MIN(created_at) FROM (
                    SELECT created_at FROM circuit_breaker_incidents
                    WHERE corp_id=$1 AND run_id=$2 AND stage IN ('suspend','stop')
                    UNION ALL
                    SELECT created_at FROM events
                    WHERE corp_id=$1 AND aggregate_type='run' AND aggregate_id=$2
                      AND type='run.stop_requested'
                      AND payload->>'command_id' IS NULL
               ) boundaries) AS hard_boundary_at
        "#,
    )
    .bind(corp_id)
    .bind(run_id)
    .fetch_one(&mut **tx)
    .await?;
    let admitted_at: chrono::DateTime<Utc> = row.get("admitted_at");
    let hard_boundary_at: Option<chrono::DateTime<Utc>> = row.get("hard_boundary_at");
    // Current stops persist a durable incident at the actual transition. Only
    // legacy stops rely on event time, which can precede a transaction's lock wait.
    let cutoff_at = hard_boundary_at.map(|at| at + Duration::seconds(USAGE_GRACE_SECONDS));
    let reason = if matches!(status, "completed" | "failed" | "cancelled" | "lost") {
        Some("run_terminal")
    } else if breaker_is_hard(stage) && hard_boundary_at.is_none() {
        // Historical/inconsistent hard state cannot acquire a fresh grace window.
        Some("hard_boundary_time_unavailable")
    } else if cutoff_at.is_some_and(|cutoff| admitted_at >= cutoff) {
        Some("hard_control_grace_expired")
    } else {
        None
    };
    let object = payload
        .as_object_mut()
        .context("run.usage payload must be an object")?;
    object.insert(
        "accounting".to_owned(),
        json!({
            "policy": "hard_control_grace_v1",
            "charged": reason.is_none(),
            "reason": reason,
            "admitted_at": admitted_at,
            "hard_boundary_at": hard_boundary_at,
            "cutoff_at": cutoff_at,
            "grace_seconds": USAGE_GRACE_SECONDS,
            "generation_time_known": false
        }),
    );
    Ok((
        if reason.is_some() {
            "run.usage_observed"
        } else {
            "run.usage"
        }
        .to_owned(),
        payload,
    ))
}

pub(super) async fn stop_was_requested_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM events
         WHERE corp_id=$1 AND aggregate_type='run' AND aggregate_id=$2
           AND type='run.stop_requested')",
    )
    .bind(corp_id)
    .bind(run_id)
    .fetch_one(&mut **tx)
    .await?)
}

pub(super) async fn run_observation_tx(
    tx: &mut Transaction<'_, Postgres>,
    mut payload: Value,
) -> Result<Value> {
    if serde_json::to_vec(&payload)?.len() > 16 * 1024 {
        return Err(anyhow!("control observation exceeds 16 KiB"));
    }
    let phase = payload.get("phase").and_then(Value::as_str);
    if !matches!(
        phase,
        Some(
            "adapter_received"
                | "transport_closed"
                | "interrupt_queued"
                | "interrupt_written"
                | "interrupt_responded"
                | "interrupt_deadline"
                | "native_terminal"
                | "usage_observed"
                | "process_terminated"
        )
    ) {
        return Err(anyhow!("unknown runner control observation phase"));
    }
    let observed_at = payload
        .get("observed_at")
        .and_then(Value::as_str)
        .context("runner control observation omitted its timestamp")?;
    let observed_at = chrono::DateTime::parse_from_rfc3339(observed_at)
        .context("invalid runner observation timestamp")?
        .with_timezone(&Utc);
    let recorded_at: chrono::DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    let object = payload
        .as_object_mut()
        .expect("validated observation object");
    object.insert("observed_at".to_owned(), json!(observed_at));
    object.insert("server_recorded_at".to_owned(), json!(recorded_at));
    object.insert(
        "clock_authority".to_owned(),
        json!("runner_observation_only"),
    );
    Ok(payload)
}
