//! Real-store cost admission and historical reconciliation; no provider or GitHub access.
use super::*;
use std::{future::Future, task::Poll};

fn assert_no_graph(state: &(Value, Value)) {
    for table in ["missions", "tasks", "runs"] {
        assert_eq!(state.0[table], json!([]), "unexpected {table}");
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue79_invalid_cost_claims_and_preflight_leave_all_ledgers_unchanged(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let initial = ledger(&f).await?;
    assert_no_graph(&initial);
    assert_eq!(initial.1["items"], json!([]));
    for (index, (strategy, cost)) in [
        ("single", json!(20_000_000)),
        ("single", json!(10_000_001)),
        ("single", json!(0)),
        ("single", json!(-1)),
        ("single", json!("1000")),
        ("single", json!(1.5)),
        ("single", json!(i64::MAX)),
        ("parallel-specialists", json!(2)),
        ("parallel-specialists", json!(23_333_333)),
        ("studio-swarm", json!(3)),
        ("studio-swarm", json!(18_181_817)),
        ("unknown", json!(1000)),
    ]
    .into_iter()
    .enumerate()
    {
        let mut invalid = policy(None);
        invalid["budget_cost_microusd"] = cost;
        invalid["strategy_allowlist"] = json!([strategy]);
        assert!(
            f.store
                .claim_factory_work_item(claim_input(&f, invalid.clone(), &format!("cost-{index}")))
                .await
                .is_err()
        );
        assert!(
            f.store
                .preflight_factory_mission(preflight(&f, invalid), &factory_plan(&f, None))
                .await
                .is_err()
        );
        assert_eq!(ledger(&f).await?, initial, "{strategy}");
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue79_valid_small_and_max_costs_materialize_without_budget_or_attempt_changes(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    for cost in [1, 1_000_000, 10_000_000] {
        let mut approved = policy(None);
        approved["budget_cost_microusd"] = json!(cost);
        approved["max_task_attempts"] = json!(3);
        let mut plan = factory_plan(&f, None);
        plan.budget_cost_microusd = cost;
        plan.tasks[0].contract.budget_cost_microusd = cost;
        plan.tasks[0].max_attempts = 3;
        let mut proposed = preflight(&f, approved.clone());
        proposed.request["max_task_attempts"] = json!(3);
        let before = ledger(&f).await?;
        let checked = f.store.preflight_factory_mission(proposed, &plan).await?;
        assert_eq!(ledger(&f).await?, before);
        assert_eq!(checked.budget_tokens, plan.budget_tokens);
        let claim = f
            .store
            .claim_factory_work_item(claim_input(&f, approved, &format!("cost-{cost}")))
            .await?;
        let mut input = materialize(&f, &claim, &format!("cost-{cost}"));
        input.request["max_task_attempts"] = json!(3);
        let outcome = f
            .store
            .materialize_factory_mission(input.clone(), &checked)
            .await?;
        let saved = ledger(&f).await?;
        let task = saved.0["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["mission_id"] == json!(outcome.ids.mission_id))
            .unwrap();
        assert_eq!(task["contract"]["budget_cost_microusd"], cost);
        assert_eq!(
            task["contract"]["budget_tokens"],
            plan.tasks[0].contract.budget_tokens
        );
        assert_eq!(task["max_attempts"], 3);
        assert_eq!(task["attempt_count"], 0);
        assert_eq!(saved.0["runs"], json!([]));
        assert_materialization_replays(&f, &input, &checked, &outcome).await?;
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue79_legacy_invalid_claim_reconciles_once_with_audit_and_no_policy_rewrite(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    for (index, state, upgrade) in [(0, "claimed", false), (1, "blocked", true)] {
        let mut original_input = claim_input(&f, policy(None), &format!("legacy-{index}"));
        let claim = f
            .store
            .claim_factory_work_item(original_input.clone())
            .await?;
        let mut legacy = claim.work_item.policy.clone();
        legacy["budget_cost_microusd"] = json!(20_000_000);
        if upgrade {
            legacy.as_object_mut().unwrap().remove("source_base_commit");
            legacy["source_commit_upgrade_required"] = json!(true);
        }
        sqlx::query("UPDATE factory_work_items SET policy=$1,state=$2 WHERE id=$3")
            .bind(&legacy)
            .bind(state)
            .bind(claim.work_item.id)
            .execute(&f.store.pool)
            .await?;
        sqlx::query("UPDATE factory_operations SET request=jsonb_set(request,'{policy}',$1) WHERE work_item_id=$2")
            .bind(&legacy).bind(claim.work_item.id).execute(&f.store.pool).await?;
        original_input.policy = legacy.clone();
        let mut input = original_input.clone();
        input.policy = legacy.clone();
        input.idempotency_key = format!("issue79-reconcile-{index}");
        let before = ledger(&f).await?;
        let read = f
            .store
            .snapshot(f.ids.corp_id, f.ids.alice_actor_id)
            .await?;
        assert_eq!(
            read.factory_work_items
                .iter()
                .find(|item| item.id == claim.work_item.id)
                .unwrap()
                .policy,
            legacy
        );
        assert_eq!(ledger(&f).await?, before);
        let mut foreign = input.clone();
        foreign.actor_id = f.ids.bob_actor_id;
        assert!(f.store.claim_factory_work_item(foreign).await.is_err());
        let mut changed = input.clone();
        changed.policy["budget_cost_microusd"] = json!(1_000_000);
        assert!(f.store.claim_factory_work_item(changed).await.is_err());
        let mut changed = input.clone();
        changed.source.revision = "changed-revision".to_owned();
        assert!(f.store.claim_factory_work_item(changed).await.is_err());
        assert!(
            f.store
                .claim_factory_work_item(original_input)
                .await
                .is_err()
        );
        assert_eq!(ledger(&f).await?, before);
        if upgrade {
            sqlx::query("UPDATE factory_work_items SET lease_expires_at=now()-interval '1 second' WHERE id=$1")
                .bind(claim.work_item.id).execute(&f.store.pool).await?;
            input.actor_id = f.ids.bob_actor_id;
        }
        let reconciled = f.store.claim_factory_work_item(input.clone()).await?;
        assert_eq!(reconciled.work_item.state, FactoryWorkItemState::Failed);
        assert_eq!(reconciled.work_item.version, claim.work_item.version + 1);
        assert_eq!(reconciled.work_item.policy, legacy);
        assert_eq!(
            reconciled.work_item.source_revision,
            claim.work_item.source_revision
        );
        assert!(reconciled.work_item.lease_expires_at < chrono::Utc::now());
        assert!(reconciled.claim_token.is_none());
        let event = reconciled.event.unwrap();
        assert_eq!(event.event_type, "factory.state_changed");
        assert_eq!(event.actor_id, Some(input.actor_id));
        assert!(event.room_id.is_none());
        assert_eq!(event.payload["previous_state"], state);
        assert_eq!(event.payload["state"], "failed");
        assert!(
            event.payload["failure_detail"]
                .as_str()
                .unwrap()
                .contains("10000000")
        );
        assert!(
            !event
                .payload
                .to_string()
                .contains(&claim.claim_token.unwrap().to_string())
        );
        let saved = ledger(&f).await?;
        assert_no_graph(&saved);
        let previous_operations = before.1["operations"].as_array().unwrap();
        for previous in previous_operations {
            assert!(
                saved.1["operations"].as_array().unwrap().contains(previous),
                "historical operation changed"
            );
        }
        let replay = f.store.claim_factory_work_item(input.clone()).await?;
        assert!(replay.replayed && replay.event.is_none() && replay.claim_token.is_none());
        input.idempotency_key.push_str("-another");
        assert!(f.store.claim_factory_work_item(input).await.is_err());
        assert!(
            f.store
                .materialize_factory_mission(
                    materialize(&f, &claim, "stale"),
                    &factory_plan(&f, None)
                )
                .await
                .is_err()
        );
        assert_eq!(ledger(&f).await?, saved);
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue79_legacy_reconciliation_is_atomic_and_competing_requests_emit_one_failure(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let mut input = claim_input(&f, policy(None), "race");
    let claim = f.store.claim_factory_work_item(input.clone()).await?;
    input.policy = claim.work_item.policy.clone();
    input.policy["budget_cost_microusd"] = json!(20_000_000);
    sqlx::query("UPDATE factory_work_items SET policy=$1 WHERE id=$2")
        .bind(&input.policy)
        .bind(claim.work_item.id)
        .execute(&f.store.pool)
        .await?;
    input.idempotency_key = "issue79-race".to_owned();
    let before = ledger(&f).await?;
    // Force failure after the state/event write, at the ordinary operation journal.
    sqlx::query("CREATE FUNCTION issue79_reject_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'issue79 injected operation failure'; END $$")
        .execute(&f.store.pool).await?;
    sqlx::query("CREATE TRIGGER issue79_reject_operation BEFORE INSERT ON factory_operations FOR EACH ROW EXECUTE FUNCTION issue79_reject_operation()")
        .execute(&f.store.pool).await?;
    assert!(
        f.store
            .claim_factory_work_item(input.clone())
            .await
            .is_err()
    );
    assert_eq!(ledger(&f).await?, before);
    sqlx::query("DROP TRIGGER issue79_reject_operation ON factory_operations")
        .execute(&f.store.pool)
        .await?;
    let mut requests = [
        Box::pin(f.store.claim_factory_work_item(input.clone())),
        Box::pin(f.store.claim_factory_work_item(input.clone())),
    ];
    let mut results = [None, None];
    std::future::poll_fn(|cx| {
        for (request, result) in requests.iter_mut().zip(&mut results) {
            if result.is_none()
                && let Poll::Ready(value) = request.as_mut().poll(cx)
            {
                *result = Some(value);
            }
        }
        if results.iter().all(Option::is_some) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
    let [first, second] = results.map(Option::unwrap);
    let first = first?;
    let second = second?;
    assert_ne!(first.replayed, second.replayed);
    assert_ne!(first.event.is_some(), second.event.is_some());
    assert_eq!(first.work_item.version, claim.work_item.version + 1);
    assert_eq!(json!(first.work_item), json!(second.work_item));
    assert!(first.claim_token.is_none() && second.claim_token.is_none());
    assert_no_graph(&ledger(&f).await?);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue79_materialized_history_is_not_revalidated_or_rewritten_on_reclaim(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let claim = f
        .store
        .claim_factory_work_item(claim_input(&f, policy(None), "historical"))
        .await?;
    let plan = factory_plan(&f, None);
    let input = materialize(&f, &claim, "historical");
    let mut outcome = f
        .store
        .materialize_factory_mission(input.clone(), &plan)
        .await?;
    let mut legacy = claim.work_item.policy.clone();
    legacy["budget_cost_microusd"] = json!(20_000_000);
    sqlx::query("UPDATE factory_work_items SET policy=$1,lease_expires_at=now()-interval '1 second' WHERE id=$2")
        .bind(&legacy).bind(claim.work_item.id).execute(&f.store.pool).await?;
    let before = ledger(&f).await?;
    let mut reclaim = claim_input(&f, legacy.clone(), "historical");
    reclaim.idempotency_key.push_str("-reclaim");
    let reclaimed = f.store.claim_factory_work_item(reclaim).await?;
    assert_eq!(reclaimed.work_item.policy, legacy);
    assert_eq!(reclaimed.work_item.mission_id, Some(outcome.ids.mission_id));
    assert_eq!(
        reclaimed.work_item.state,
        FactoryWorkItemState::MissionCreated
    );
    assert!(reclaimed.claim_token.is_some());
    let after = ledger(&f).await?;
    for key in ["missions", "tasks", "runs"] {
        assert_eq!(before.0[key], after.0[key]);
    }
    outcome.work_item.policy = legacy;
    assert_materialization_replays(&f, &input, &plan, &outcome).await?;
    Ok(())
}
