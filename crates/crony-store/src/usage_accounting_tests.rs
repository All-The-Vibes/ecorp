//! Native, opt-in usage provenance regressions. These synthetic observations do
//! not execute auditors, grant budgets, or resume the stopped budget experiments.
use super::*;
use crate::aggregate_breaker_tests::{CORP, MISSION, OWNER, add_run, event, fixture, run_id};
use crony_domain::{UsageProvenance, UsageReport, UsageScope};

async fn usage_fixture(pool: PgPool) -> PgStore {
    let store = fixture(pool).await;
    // Establish the disposable fixture's initial envelope before any observations.
    // This is fixture setup, not a runtime budget revision or grant.
    sqlx::query("UPDATE missions SET budget_tokens=10000,original_budget_tokens=10000 WHERE id=$1 AND corp_id=$2")
        .bind(MISSION).bind(CORP).execute(&store.pool).await.unwrap();
    for index in 0..2 {
        bind_session(&store, index).await;
    }
    store
}

async fn bind_session(store: &PgStore, index: u128) {
    store
        .apply_runner_event(event(
            index,
            "run.session",
            json!({"session_id":"usage-session"}),
        ))
        .await
        .unwrap();
}

fn report(
    input: Option<u64>,
    output: Option<u64>,
    native_event: Option<&str>,
    api_call: Option<&str>,
) -> Value {
    let mut provenance = UsageProvenance::new("fixture_usage_v1", UsageScope::PerCall);
    provenance.provider_session_id = Some("usage-session".to_owned());
    provenance.native_event_id = native_event.map(str::to_owned);
    provenance.api_call_id = api_call.map(str::to_owned);
    serde_json::to_value(UsageReport {
        input_tokens: input,
        output_tokens: output,
        cost_microusd: None,
        usage_provenance: Some(provenance),
    })
    .unwrap()
}

async fn observe(store: &PgStore, index: u128, payload: Value) -> DomainEvent {
    store
        .apply_runner_event(event(index, "run.usage", payload))
        .await
        .unwrap()
        .event
        .expect("new journal observation")
}

async fn counters(store: &PgStore, index: u128) -> (i64, i64, i64) {
    sqlx::query_as(
        "SELECT input_tokens,output_tokens,cost_microusd FROM runs WHERE id=$1 AND corp_id=$2",
    )
    .bind(run_id(index))
    .bind(CORP)
    .fetch_one(&store.pool)
    .await
    .unwrap()
}

fn assert_uncharged(observed: &DomainEvent, disposition: &str) {
    assert_eq!(observed.event_type, "run.usage_observed");
    assert_eq!(
        observed.payload["usage_validation"]["disposition"],
        disposition
    );
    assert_eq!(observed.payload["accounting"]["charged"], false);
    assert_eq!(observed.payload["accounting"]["known_subtotal_only"], true);
    if !matches!(disposition, "accepted" | "duplicate") {
        assert_eq!(
            observed.payload["usage_coverage"]["call_identity"],
            "unavailable"
        );
        assert!(observed.payload.get("usage_identity_keys").is_none());
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_four_scoped_calls_sum_once_with_replays_and_terminal_evidence(
    pool: PgPool,
) {
    let store = usage_fixture(pool).await;
    for index in 2..4 {
        add_run(&store, index, CORP, MISSION).await;
        bind_session(&store, index).await;
    }
    // Four reported calls can represent worker/retry/auditor/failed work. This
    // fixture proves accounting only, not those workflows or auditor independence.
    let mut origins = Vec::new();
    for (index, input, output) in [(0, 100, 20), (1, 30, 10), (2, 10, 5), (3, 7, 3)] {
        // Even identical provider aliases in separate assigned runs are scoped.
        let frame = event(
            index,
            "run.usage",
            report(
                Some(input),
                Some(output),
                Some("native-event"),
                Some("native-call"),
            ),
        );
        let accepted = store
            .apply_runner_event(frame.clone())
            .await
            .unwrap()
            .event
            .unwrap();
        assert_eq!(accepted.event_type, "run.usage");
        assert_eq!(
            accepted.payload["usage_origin_event_id"],
            json!(frame.event_id)
        );
        assert_eq!(accepted.payload["usage_coverage"]["usd"], "unavailable");
        assert!(
            store
                .apply_runner_event(frame.clone())
                .await
                .unwrap()
                .event
                .is_none()
        );
        let replay = observe(&store, index, frame.payload).await;
        assert_uncharged(&replay, "duplicate");
        assert_eq!(replay.payload["usage_origin_event_id"], json!(accepted.id));
        origins.push(accepted.id);
    }
    let sum: (i64,i64,i64) = sqlx::query_as(
        "SELECT SUM(input_tokens)::bigint,SUM(output_tokens)::bigint,SUM(cost_microusd)::bigint FROM runs WHERE corp_id=$1",
    ).bind(CORP).fetch_one(&store.pool).await.unwrap();
    assert_eq!(sum, (147, 38, 0));
    assert_eq!(sum.0 + sum.1, 185);
    let lineage: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events e JOIN runs r ON r.id=e.aggregate_id AND r.corp_id=e.corp_id
         JOIN tasks t ON t.id=r.task_id AND t.corp_id=r.corp_id
         JOIN missions m ON m.id=t.mission_id AND m.corp_id=t.corp_id
         WHERE e.id=ANY($1) AND e.corp_id=$2 AND m.id=$3 AND e.room_id=m.room_id AND e.correlation_id=m.id",
    ).bind(&origins).bind(CORP).bind(MISSION).fetch_one(&store.pool).await.unwrap();
    assert_eq!(lineage, 4);
    let mut aggregate = report(Some(147), Some(38), None, None);
    aggregate["usage_provenance"]["scope"] = json!("retained_aggregate");
    assert_uncharged(&observe(&store, 0, aggregate).await, "aggregate");
    sqlx::query("UPDATE runs SET status='failed' WHERE id=$1 AND corp_id=$2")
        .bind(run_id(3))
        .bind(CORP)
        .execute(&store.pool)
        .await
        .unwrap();
    let terminal = observe(
        &store,
        3,
        report(Some(50), Some(5), Some("late-event"), Some("late-call")),
    )
    .await;
    assert_uncharged(&terminal, "accepted");
    assert_eq!(terminal.payload["accounting"]["reason"], "run_terminal");
    assert_eq!(counters(&store, 3).await, (7, 3, 0));
    let replay = observe(
        &store,
        3,
        report(Some(7), Some(3), Some("native-event"), Some("native-call")),
    )
    .await;
    assert_uncharged(&replay, "duplicate");
    assert_eq!(replay.payload["accounting"]["reason"], "run_terminal");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_equal_counts_and_missing_ids_do_not_collapse_calls(pool: PgPool) {
    let store = usage_fixture(pool).await;
    for api in [Some("call-a"), Some("call-b"), None, None] {
        let accepted = observe(&store, 0, report(Some(10), Some(2), None, api)).await;
        assert_eq!(accepted.event_type, "run.usage");
        assert_eq!(
            accepted.payload["usage_coverage"]["call_identity"],
            if api.is_some() {
                "reported"
            } else {
                "unavailable"
            }
        );
    }
    assert_eq!(counters(&store, 0).await, (40, 8, 0));
    let mut spoof = report(Some(1), Some(1), None, None);
    spoof["usage_identity_keys"] = json!(["invented-prior-key"]);
    spoof["usage_origin_event_id"] = json!(Uuid::new_v4());
    spoof["usage_coverage"] = json!({"complete_provider_bill":true});
    spoof["usage_validation"] = json!({"disposition":"duplicate"});
    spoof["accounting"] = json!({"charged":false});
    let accepted = observe(&store, 0, spoof).await;
    assert_eq!(accepted.event_type, "run.usage");
    assert_eq!(accepted.payload["usage_identity_keys"], json!([]));
    assert_eq!(
        accepted.payload["usage_origin_event_id"],
        json!(accepted.id)
    );
    assert_eq!(
        accepted.payload["usage_coverage"]["complete_provider_bill"],
        false
    );
    assert_eq!(counters(&store, 0).await, (41, 9, 0));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_alias_enrichment_is_transitive_and_conflicts_cannot_claim_aliases(
    pool: PgPool,
) {
    let store = usage_fixture(pool).await;
    let first = observe(&store, 0, report(Some(10), Some(2), Some("event-a"), None)).await;
    let enriched = report(Some(10), Some(2), Some("event-a"), Some("api-a"));
    let mut api_provider = report(Some(10), Some(2), None, Some("api-a"));
    api_provider["usage_provenance"]["provider_call_id"] = json!("provider-a");
    let mut provider_only = report(Some(10), Some(2), None, None);
    provider_only["usage_provenance"]["provider_call_id"] = json!("provider-a");
    for replay in [enriched, api_provider, provider_only] {
        let observed = observe(&store, 0, replay).await;
        assert_uncharged(&observed, "duplicate");
        assert_eq!(observed.payload["usage_origin_event_id"], json!(first.id));
    }
    let conflict = observe(
        &store,
        0,
        report(Some(11), Some(2), Some("event-a"), Some("unclaimed-api")),
    )
    .await;
    assert_uncharged(&conflict, "conflict");
    assert!(conflict.payload.get("usage_identity_keys").is_none());
    assert!(conflict.payload.get("usage_origin_event_id").is_none());
    let separate = observe(
        &store,
        0,
        report(Some(11), Some(2), None, Some("unclaimed-api")),
    )
    .await;
    assert_eq!(separate.event_type, "run.usage");
    let other = observe(&store, 0, report(Some(10), Some(2), None, Some("api-b"))).await;
    assert_eq!(other.event_type, "run.usage");
    let bridge = observe(
        &store,
        0,
        report(Some(10), Some(2), Some("event-a"), Some("api-b")),
    )
    .await;
    assert_uncharged(&bridge, "conflict");
    assert!(bridge.payload.get("usage_identity_keys").is_none());
    assert_eq!(counters(&store, 0).await, (31, 6, 0));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_optional_session_uses_fenced_run_identity_without_rewriting_provenance(
    pool: PgPool,
) {
    let store = usage_fixture(pool).await;
    let mut omitted = report(Some(10), Some(2), Some("event-a"), None);
    omitted["usage_provenance"]["provider_session_id"] = Value::Null;
    let first = observe(&store, 0, omitted.clone()).await;
    assert_eq!(first.event_type, "run.usage");
    assert_eq!(first.payload["usage_coverage"]["call_identity"], "reported");
    assert_eq!(
        first.payload["usage_provenance"]["provider_session_id"],
        Value::Null
    );
    let enriched = report(Some(10), Some(2), Some("event-a"), Some("api-a"));
    for payload in [enriched, omitted] {
        let replay = observe(&store, 0, payload).await;
        assert_uncharged(&replay, "duplicate");
        assert_eq!(replay.payload["usage_origin_event_id"], json!(first.id));
        assert_eq!(
            replay.payload["usage_coverage"]["call_identity"],
            "reported"
        );
    }
    let mut api_only = report(Some(10), Some(2), None, Some("api-a"));
    api_only["usage_provenance"]["provider_session_id"] = Value::Null;
    assert_uncharged(&observe(&store, 0, api_only).await, "duplicate");
    assert_eq!(counters(&store, 0).await, (10, 2, 0));

    // An unbound run cannot manufacture a native session from optional fields.
    sqlx::query("UPDATE runs SET provider_session_id=NULL WHERE id=$1 AND corp_id=$2")
        .bind(run_id(1))
        .bind(CORP)
        .execute(&store.pool)
        .await
        .unwrap();
    let mut unbound = report(Some(3), Some(1), Some("unbound-event"), None);
    unbound["usage_provenance"]["provider_session_id"] = Value::Null;
    let observed = observe(&store, 1, unbound).await;
    assert_uncharged(&observed, "unattributed");
    assert_eq!(
        observed.payload["accounting"]["reason"],
        "usage_session_unavailable"
    );
    assert!(observed.payload.get("usage_identity_keys").is_none());
    assert_eq!(counters(&store, 1).await, (0, 0, 0));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_last_call_identity_coverage_uses_the_admitted_session(pool: PgPool) {
    let store = usage_fixture(pool).await;
    let mut payload = report(Some(10), Some(2), None, None);
    payload["usage_provenance"]["scope"] = json!("last_call");
    payload["usage_provenance"]["provider_session_id"] = Value::Null;
    payload["usage_provenance"]["turn_id"] = json!("turn-1");
    payload["usage_provenance"]["cumulative_total_tokens"] = json!(12);
    let accepted = observe(&store, 0, payload.clone()).await;
    assert_eq!(accepted.event_type, "run.usage");
    assert_eq!(
        accepted.payload["usage_coverage"]["call_identity"],
        "reported"
    );
    assert_eq!(
        accepted.payload["usage_identity_keys"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(accepted.payload["usage_provenance"]["provider_session_id"].is_null());
    let replay = observe(&store, 0, payload.clone()).await;
    assert_uncharged(&replay, "duplicate");
    assert_eq!(
        replay.payload["usage_coverage"]["call_identity"],
        "reported"
    );
    assert_eq!(replay.payload["usage_origin_event_id"], json!(accepted.id));
    payload["usage_provenance"]["provider_session_id"] = json!("other-session");
    let rejected = observe(&store, 0, payload).await;
    assert_uncharged(&rejected, "unattributed");
    assert_eq!(
        rejected.payload["usage_validation"]["reason"],
        "usage_session_mismatch"
    );
    assert_eq!(counters(&store, 0).await, (10, 2, 0));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_partial_tokens_and_native_units_never_fabricate_free_usd(pool: PgPool) {
    let store = usage_fixture(pool).await;
    let mut partial = report(None, Some(0), Some("partial"), None);
    partial["usage_provenance"]["model_multiplier"] = json!(0.5);
    partial["usage_provenance"]["nano_aiu"] = json!(1.25);
    let partial = observe(&store, 0, partial).await;
    assert_eq!(partial.payload["input_tokens"], Value::Null);
    assert_eq!(partial.payload["output_tokens"], 0);
    assert_eq!(partial.payload["cost_microusd"], Value::Null);
    assert_eq!(partial.payload["usage_coverage"]["tokens"], "partial");
    assert_eq!(partial.payload["usage_coverage"]["usd"], "unavailable");
    assert_eq!(partial.payload["usage_provenance"]["nano_aiu"], 1.25);
    assert_eq!(
        partial.payload["usage_coverage"]["native_billing_is_usd"],
        false
    );
    let legacy = observe(
        &store,
        0,
        json!({"input_tokens":0,"output_tokens":0,"cost_microusd":0}),
    )
    .await;
    assert_eq!(legacy.payload["usage_coverage"]["tokens"], "reported");
    assert_eq!(legacy.payload["usage_coverage"]["usd"], "legacy_unverified");
    assert_eq!(
        legacy.payload["usage_coverage"]["complete_provider_bill"],
        false
    );
    let absent = observe(&store, 0, json!({})).await;
    assert_eq!(absent.payload["usage_coverage"]["tokens"], "unavailable");
    assert_eq!(absent.payload["usage_coverage"]["usd"], "unavailable");
    let mut zero = report(Some(0), Some(0), Some("zero"), None);
    zero["cost_microusd"] = json!(0);
    let zero = observe(&store, 0, zero).await;
    assert_eq!(zero.payload["usage_coverage"]["usd"], "reported");
    assert_eq!(counters(&store, 0).await, (0, 0, 0));
    let mut subsets = report(Some(100), Some(20), Some("subsets"), None);
    for (field, value) in [
        ("cached_input_tokens", 40),
        ("cache_write_input_tokens", 10),
        ("reasoning_output_tokens", 5),
    ] {
        subsets["usage_provenance"][field] = json!(value);
    }
    subsets["usage_provenance"]["cache_tokens_are_input_subsets"] = json!(true);
    subsets["usage_provenance"]["reasoning_tokens_are_output_subsets"] = json!(true);
    observe(&store, 0, subsets).await;
    assert_eq!(counters(&store, 0).await, (100, 20, 0));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_invalid_reports_are_redacted_without_any_partial_charge(pool: PgPool) {
    let store = usage_fixture(pool).await;
    let mut malformed = vec![
        json!(null),
        json!([]),
        json!({"input_tokens":-1,"output_tokens":2}),
        json!({"input_tokens":1.5}),
        json!({"input_tokens":u64::MAX}),
        json!({"input_tokens":i64::MAX,"output_tokens":1}),
        json!({"input_tokens":"SENSITIVE_SENTINEL"}),
        json!({"input_tokens":1,"private":"SENSITIVE_SENTINEL".repeat(2000)}),
    ];
    let mut bad = report(Some(10), Some(2), Some("bad"), None);
    bad["usage_provenance"]["model"] = json!("bad\nSENSITIVE_SENTINEL");
    malformed.push(bad);
    let mut bad = report(Some(10), Some(2), Some("bad"), None);
    bad["usage_provenance"]["private"] = json!("SENSITIVE_SENTINEL");
    malformed.push(bad);
    let mut bad = report(Some(10), Some(2), Some("bad"), None);
    bad["usage_provenance"]["cached_input_tokens"] = json!(11);
    bad["usage_provenance"]["cache_tokens_are_input_subsets"] = json!(true);
    malformed.push(bad);
    let mut bad = report(Some(10), Some(2), Some("bad"), None);
    bad["usage_provenance"]["invalid_fields"] =
        json!([{"field":"SENSITIVE_SENTINEL","reason":"invalid_number"}]);
    malformed.push(bad);
    for payload in malformed {
        let observed = observe(&store, 0, payload).await;
        assert_uncharged(&observed, "invalid");
        assert_eq!(observed.payload["usage_coverage"]["tokens"], "invalid");
        assert_eq!(observed.payload["input_tokens"], Value::Null);
        assert!(
            !serde_json::to_string(&observed.payload)
                .unwrap()
                .contains("SENSITIVE_SENTINEL")
        );
        assert_eq!(counters(&store, 0).await, (0, 0, 0));
    }
    let recovered = observe(&store, 0, report(Some(10), Some(2), Some("bad"), None)).await;
    assert_eq!(recovered.event_type, "run.usage");
    assert_eq!(counters(&store, 0).await, (10, 2, 0));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_integer_subtotal_overflow_never_partially_updates_counters(pool: PgPool) {
    let store = usage_fixture(pool).await;
    for (initial, payload) in [
        (
            (i64::MAX, 0, 0),
            json!({"input_tokens":1,"output_tokens":0}),
        ),
        (
            (i64::MAX, 0, 0),
            json!({"input_tokens":0,"output_tokens":1}),
        ),
        (
            (0, 0, i64::MAX),
            json!({"input_tokens":1,"cost_microusd":1}),
        ),
        ((-1, 0, 0), json!({"input_tokens":1,"output_tokens":2})),
    ] {
        sqlx::query("UPDATE runs SET input_tokens=$1,output_tokens=$2,cost_microusd=$3 WHERE id=$4 AND corp_id=$5")
            .bind(initial.0).bind(initial.1).bind(initial.2).bind(run_id(0)).bind(CORP)
            .execute(&store.pool).await.unwrap();
        let observed = observe(&store, 0, payload).await;
        assert_uncharged(&observed, "overflow");
        assert_eq!(counters(&store, 0).await, initial);
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_mission_aggregate_overflow_keeps_the_journal_frame(pool: PgPool) {
    let store = usage_fixture(pool).await;
    // Seed a historic, already-accounted subtotal. The new call fits its own run,
    // but adding it to the same mission would overflow the existing projection.
    for (input, output, cost, payload) in [
        (i64::MAX, 0, 0, json!({"input_tokens":1,"output_tokens":0})),
        (0, i64::MAX, 0, json!({"input_tokens":0,"output_tokens":1})),
        (0, 0, i64::MAX, json!({"input_tokens":1,"cost_microusd":1})),
    ] {
        sqlx::query(
            "UPDATE runs SET input_tokens=$1,output_tokens=$2,cost_microusd=$3,
                    created_at=now()-interval '48 hours' WHERE id=$4 AND corp_id=$5",
        )
        .bind(input)
        .bind(output)
        .bind(cost)
        .bind(run_id(0))
        .bind(CORP)
        .execute(&store.pool)
        .await
        .unwrap();
        let frame = event(1, "run.usage", payload);
        let observed = store
            .apply_runner_event(frame.clone())
            .await
            .unwrap()
            .event
            .unwrap();
        assert_uncharged(&observed, "overflow");
        assert_eq!(observed.id, frame.event_id);
        assert_eq!(
            observed.payload["accounting"]["reason"],
            "usage_accounting_overflow"
        );
        assert_eq!(counters(&store, 1).await, (0, 0, 0));
        assert_eq!(counters(&store, 0).await, (input, output, cost));
        assert!(
            store
                .apply_runner_event(frame)
                .await
                .unwrap()
                .event
                .is_none()
        );
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_aggregate_range_uses_the_existing_rolling_window(pool: PgPool) {
    let store = usage_fixture(pool).await;
    let other_mission = Uuid::from_u128(23601);
    let other_requester = Uuid::from_u128(23602);
    sqlx::query("INSERT INTO actors(id,corp_id,name,kind,role) VALUES($1,$2,'Other requester','human','owner')")
        .bind(other_requester).bind(CORP).execute(&store.pool).await.unwrap();
    sqlx::query(
        "INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,budget_tokens,
                    original_budget_tokens,budget_cost_microusd,original_budget_cost_microusd)
                SELECT $1,corp_id,room_id,$2,'Usage window','running',10000,10000,1000000,1000000
                FROM missions WHERE id=$3 AND corp_id=$4",
    )
    .bind(other_mission)
    .bind(other_requester)
    .bind(MISSION)
    .bind(CORP)
    .execute(&store.pool)
    .await
    .unwrap();
    add_run(&store, 2, CORP, other_mission).await;
    bind_session(&store, 2).await;
    sqlx::query(
        "UPDATE runs SET input_tokens=$1,cost_microusd=$1,
                created_at=now()-interval '48 hours' WHERE id=$2 AND corp_id=$3",
    )
    .bind(i64::MAX)
    .bind(run_id(0))
    .bind(CORP)
    .execute(&store.pool)
    .await
    .unwrap();
    // Different mission, outside the rolling window: there is no all-history
    // Corp cap. The fixture is sequential and never runs a budget-race scenario.
    let accepted = observe(
        &store,
        2,
        json!({"input_tokens":1,"output_tokens":0,"cost_microusd":1}),
    )
    .await;
    assert_eq!(accepted.event_type, "run.usage");
    assert_eq!(counters(&store, 2).await, (1, 0, 1));
    for (input, cost) in [(i64::MAX, 0), (0, i64::MAX)] {
        sqlx::query(
            "UPDATE runs SET input_tokens=$1,cost_microusd=$2,created_at=now()
                    WHERE id=$3 AND corp_id=$4",
        )
        .bind(input)
        .bind(cost)
        .bind(run_id(0))
        .bind(CORP)
        .execute(&store.pool)
        .await
        .unwrap();
        let observed = observe(
            &store,
            2,
            json!({"input_tokens":1,"output_tokens":0,"cost_microusd":1}),
        )
        .await;
        assert_uncharged(&observed, "overflow");
        assert_eq!(counters(&store, 2).await, (1, 0, 1));
        assert_eq!(counters(&store, 0).await, (input, 0, cost));
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_requires_exact_assignment_and_matching_native_session(pool: PgPool) {
    let store = usage_fixture(pool).await;
    for field in ["corp", "run", "agent", "runner", "assignment"] {
        let mut input = event(
            0,
            "run.usage",
            report(Some(10), Some(2), Some("event-a"), None),
        );
        match field {
            "corp" => input.corp_id = Uuid::new_v4(),
            "run" => input.run_id = run_id(1),
            "agent" => input.agent_id = Uuid::new_v4(),
            "runner" => input.runner_id = "issue56-runner-1".to_owned(),
            "assignment" => input.assignment_token = Uuid::new_v4(),
            _ => unreachable!(),
        }
        assert!(store.apply_runner_event(input).await.is_err());
    }
    let mut wrong_session = report(Some(10), Some(2), Some("event-a"), None);
    wrong_session["usage_provenance"]["provider_session_id"] = json!("other-session");
    let observed = observe(&store, 0, wrong_session).await;
    assert_uncharged(&observed, "unattributed");
    assert_eq!(
        observed.payload["accounting"]["reason"],
        "usage_session_mismatch"
    );
    assert!(observed.payload.get("usage_identity_keys").is_none());
    assert!(
        store
            .apply_runner_event(event(0, "run.usage_observed", json!({})))
            .await
            .is_err()
    );
    sqlx::query("UPDATE runs SET execution_mode='verification_only' WHERE id=$1 AND corp_id=$2")
        .bind(run_id(1))
        .bind(CORP)
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(
        store
            .apply_runner_event(event(1, "run.usage", report(Some(10), Some(2), None, None)))
            .await
            .unwrap_err()
            .to_string()
            .contains("provider-free verification")
    );
    assert_eq!(counters(&store, 0).await, (0, 0, 0));
    assert_eq!(counters(&store, 1).await, (0, 0, 0));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_hard_control_still_prevents_new_charges(pool: PgPool) {
    let store = usage_fixture(pool).await;
    sqlx::query("UPDATE runs SET breaker_stage='stop' WHERE id=$1 AND corp_id=$2")
        .bind(run_id(0))
        .bind(CORP)
        .execute(&store.pool)
        .await
        .unwrap();
    let observed = observe(
        &store,
        0,
        report(Some(10), Some(2), Some("after-stop"), None),
    )
    .await;
    assert_uncharged(&observed, "accepted");
    assert_eq!(
        observed.payload["accounting"]["reason"],
        "hard_boundary_time_unavailable"
    );
    let invalid = observe(&store, 0, json!({"input_tokens":-1})).await;
    assert_uncharged(&invalid, "invalid");
    assert_eq!(
        invalid.payload["accounting"]["reason"],
        "hard_boundary_time_unavailable"
    );
    assert_eq!(counters(&store, 0).await, (0, 0, 0));
    let stage: String =
        sqlx::query_scalar("SELECT breaker_stage FROM runs WHERE id=$1 AND corp_id=$2")
            .bind(run_id(0))
            .bind(CORP)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(stage, "stop");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue236_usage_room_revocation_hides_evidence_without_deleting_accounting(pool: PgPool) {
    let store = usage_fixture(pool).await;
    let observed = observe(
        &store,
        0,
        report(Some(10), Some(2), Some("visible-event"), None),
    )
    .await;
    assert!(
        store
            .events_after(CORP, OWNER, 0, 100)
            .await
            .unwrap()
            .iter()
            .any(|row| row.id == observed.id)
    );
    assert!(
        store
            .events_after(CORP, Uuid::new_v4(), 0, 100)
            .await
            .unwrap()
            .iter()
            .all(|row| row.id != observed.id)
    );
    assert!(
        store
            .events_after(Uuid::new_v4(), OWNER, 0, 100)
            .await
            .unwrap()
            .is_empty()
    );
    sqlx::query("DELETE FROM room_memberships WHERE actor_id=$1 AND room_id=$2")
        .bind(OWNER)
        .bind(observed.room_id.unwrap())
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(
        store
            .events_after(CORP, OWNER, 0, 100)
            .await
            .unwrap()
            .iter()
            .all(|row| row.id != observed.id)
    );
    let retained: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE id=$1 AND corp_id=$2")
            .bind(observed.id)
            .bind(CORP)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(retained, 1);
    assert_eq!(counters(&store, 0).await, (10, 2, 0));
}
