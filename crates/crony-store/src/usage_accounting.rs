//! Usage extends the existing event journal and run subtotals. No parallel ledger.
use super::*;
use crony_domain::{UsageReport, UsageScope};

/// The caller holds the Corp and exact assignment/run locks before this function.
/// Native identity is additional evidence; it never supplies tenant authority.
#[allow(clippy::too_many_arguments)]
pub(super) async fn admit_usage_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
    event_id: Uuid,
    stage: &str,
    status: &str,
    payload: Value,
) -> Result<(String, Value)> {
    let report = if serde_json::to_vec(&payload)?.len() <= 16 * 1024 {
        serde_json::from_value::<UsageReport>(payload)
            .ok()
            .filter(|report| report.validate().is_ok())
    } else {
        None
    };
    // Invalid input is retained as a bounded, redacted observation, never repaired
    // into zero spend or retried indefinitely through the runner's journal.
    let mut payload = match &report {
        Some(report) => serde_json::to_value(report)?,
        None => json!({"input_tokens":null,"output_tokens":null,"cost_microusd":null}),
    };
    let mut reason = report.is_none().then_some("invalid_usage");
    let mut disposition = if reason.is_some() {
        "invalid"
    } else {
        "accepted"
    };
    let mut origin_event_id = event_id;
    let mut identity_keys = Vec::new();

    if let Some(report) = &report {
        payload["usage_coverage"] = report.coverage();
        let row = sqlx::query(
            "SELECT run.provider_session_id,run.input_tokens,run.output_tokens,run.cost_microusd,
                    task.mission_id,mission.requested_by,
                    run.created_at>=now()-interval '24 hours' AS in_rolling_window
             FROM runs run
             JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
             JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=task.corp_id
             WHERE run.id=$1 AND run.corp_id=$2",
        )
        .bind(run_id)
        .bind(corp_id)
        .fetch_one(&mut **tx)
        .await?;
        let stored_session: Option<String> = row.get("provider_session_id");
        let scoped_report = with_stored_session(report, stored_session.as_deref());
        if let Some(provenance) = &report.usage_provenance {
            if provenance.scope == UsageScope::RetainedAggregate {
                reason = Some("retained_usage_aggregate");
                disposition = "aggregate";
            } else if provenance
                .provider_session_id
                .as_deref()
                .is_some_and(|session| stored_session.as_deref() != Some(session))
            {
                reason = Some("usage_session_mismatch");
                disposition = "unattributed";
            } else if matches!(provenance.scope, UsageScope::PerCall | UsageScope::LastCall)
                && stored_session.is_none()
            {
                reason = Some("usage_session_unavailable");
                disposition = "unattributed";
            } else {
                identity_keys = scoped_report
                    .usage_provenance
                    .as_ref()
                    .expect("reported provenance")
                    .native_identity_keys();
            }
        }
        if reason.is_none() && !identity_keys.is_empty() {
            // Duplicate observations retain newly supplied identity aliases, so a
            // later replay using only an enriched alias still finds its original.
            // Conflicting observations never acquire new accounting identities.
            let previous = sqlx::query(
                "SELECT id,payload FROM events
                 WHERE corp_id=$1 AND aggregate_type='run' AND aggregate_id=$2
                   AND (type='run.usage' OR
                        (type='run.usage_observed' AND payload->'usage_validation'->>'disposition'='duplicate'))
                   AND EXISTS (
                     SELECT 1 FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(payload->'usage_identity_keys')='array'
                            THEN payload->'usage_identity_keys' ELSE '[]'::jsonb END
                     ) AS identity(value) WHERE identity.value = ANY($3::text[]))",
            ).bind(corp_id).bind(run_id).bind(&identity_keys).fetch_all(&mut **tx).await?;
            if !previous.is_empty() {
                let mut origins = HashSet::new();
                let mut matching = true;
                for previous in previous {
                    let previous_payload: Value = previous.get("payload");
                    origins.insert(
                        previous_payload
                            .get("usage_origin_event_id")
                            .and_then(Value::as_str)
                            .and_then(|id| Uuid::parse_str(id).ok())
                            .unwrap_or_else(|| previous.get("id")),
                    );
                    matching &= serde_json::from_value::<UsageReport>(previous_payload)
                        .ok()
                        .is_some_and(|previous| {
                            previous.validate().is_ok()
                                && with_stored_session(&previous, stored_session.as_deref())
                                    .same_observation(&scoped_report)
                        });
                }
                if matching && origins.len() == 1 {
                    origin_event_id = *origins.iter().next().expect("one native usage origin");
                    reason = Some("native_usage_replay");
                    disposition = "duplicate";
                } else {
                    reason = Some("native_usage_conflict");
                    disposition = "conflict";
                }
            }
        }
        if reason.is_none() {
            let next = |field, reported: Option<u64>| {
                let previous = row.get::<i64, _>(field);
                (previous >= 0)
                    .then_some(previous)
                    .and_then(|previous| previous.checked_add(reported.unwrap_or(0) as i64))
            };
            let input = next("input_tokens", report.input_tokens);
            let output = next("output_tokens", report.output_tokens);
            if input
                .zip(output)
                .and_then(|(input, output)| input.checked_add(output))
                .is_none()
                || next("cost_microusd", report.cost_microusd).is_none()
                || !aggregate_subtotals_fit_tx(
                    tx,
                    corp_id,
                    row.get("mission_id"),
                    row.get("requested_by"),
                    row.get("in_rolling_window"),
                    (report.input_tokens.unwrap_or(0) + report.output_tokens.unwrap_or(0)) as i64,
                    report.cost_microusd.unwrap_or(0) as i64,
                )
                .await?
            {
                reason = Some("usage_accounting_overflow");
                disposition = "overflow";
            }
        }
    } else {
        payload["usage_coverage"] = json!({
            "tokens":"invalid","usd":"invalid","complete_provider_bill":false,
            "token_denominator":"input_plus_output","native_billing_is_usd":false,
            "call_identity":"unavailable"
        });
    }
    payload["usage_validation"] =
        json!({"policy":"native_usage_v1","disposition":disposition,"reason":reason});
    if matches!(disposition, "accepted" | "duplicate") {
        payload["usage_identity_keys"] = json!(identity_keys);
        payload["usage_origin_event_id"] = json!(origin_event_id);
    }
    // Preserve the database-clock grace period and every terminal/hard-stop rule.
    let (mut event_type, mut payload) =
        control_accounting::admit_usage_tx(tx, corp_id, run_id, stage, status, payload).await?;
    payload["accounting"]["known_subtotal_only"] = json!(true);
    if let Some(reason) = reason {
        event_type = "run.usage_observed".to_owned();
        payload["accounting"]["charged"] = json!(false);
        if payload["accounting"]["reason"].is_null() {
            payload["accounting"]["reason"] = json!(reason);
        }
    }
    Ok((event_type, payload))
}

/// Resolve an omitted native session only for identity comparison, from the
/// already fenced run. Keep the reported provenance unchanged in the journal.
/// Otherwise adding or dropping an optional session field could charge a replay
/// again despite the same native event/call ID and authoritative assignment.
fn with_stored_session(report: &UsageReport, session: Option<&str>) -> UsageReport {
    let mut scoped = report.clone();
    if let Some(provenance) = &mut scoped.usage_provenance
        && provenance.provider_session_id.is_none()
    {
        provenance.provider_session_id = session.map(str::to_owned);
    }
    scoped
}

/// The existing breaker and resume projections return signed 64-bit subtotals.
/// Compare in PostgreSQL NUMERIC before changing any counters, while the caller
/// holds the same Corp lock used by aggregate enforcement. An old run contributes
/// to its mission but not to a rolling requester/Corp window. This is admission
/// to the existing accounting range, not a spending limit or a budget grant.
async fn aggregate_subtotals_fit_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    mission_id: Uuid,
    requester: Uuid,
    in_rolling_window: bool,
    tokens: i64,
    cost: i64,
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        r#"
        SELECT COALESCE(BOOL_AND(run.input_tokens>=0 AND run.output_tokens>=0
                   AND run.cost_microusd>=0
                   AND run.input_tokens::numeric+run.output_tokens<=9223372036854775807::numeric),true)
          AND COALESCE(SUM(run.input_tokens::numeric+run.output_tokens)
                FILTER (WHERE task.mission_id=$2),0)+$4::bigint::numeric<=9223372036854775807::numeric
          AND COALESCE(SUM(run.cost_microusd::numeric)
                FILTER (WHERE task.mission_id=$2),0)+$5::bigint::numeric<=9223372036854775807::numeric
          AND COALESCE(SUM(run.input_tokens::numeric+run.output_tokens)
                FILTER (WHERE mission.requested_by=$3 AND run.created_at>=now()-interval '24 hours'),0)
                +CASE WHEN $6 THEN $4::bigint::numeric ELSE 0 END<=9223372036854775807::numeric
          AND COALESCE(SUM(run.cost_microusd::numeric)
                FILTER (WHERE mission.requested_by=$3 AND run.created_at>=now()-interval '24 hours'),0)
                +CASE WHEN $6 THEN $5::bigint::numeric ELSE 0 END<=9223372036854775807::numeric
          AND COALESCE(SUM(run.input_tokens::numeric+run.output_tokens)
                FILTER (WHERE run.created_at>=now()-interval '24 hours'),0)
                +CASE WHEN $6 THEN $4::bigint::numeric ELSE 0 END<=9223372036854775807::numeric
          AND COALESCE(SUM(run.cost_microusd::numeric)
                FILTER (WHERE run.created_at>=now()-interval '24 hours'),0)
                +CASE WHEN $6 THEN $5::bigint::numeric ELSE 0 END<=9223372036854775807::numeric
        FROM runs run
        JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
        JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=task.corp_id
        WHERE run.corp_id=$1
          AND (task.mission_id=$2 OR run.created_at>=now()-interval '24 hours')
        "#,
    )
    .bind(corp_id).bind(mission_id).bind(requester).bind(tokens).bind(cost)
    .bind(in_rolling_window).fetch_one(&mut **tx).await?)
}
