//! Finite-budget regressions. Database cases use SQLx-owned disposable fixtures;
//! they are separate from browser/runner and native Factory acceptance.
use super::*;
use crate::{
    MAX_TOKEN_BUDGET, MissionPlanIds, RollingBudgetRemaining, clamped_token_allocation,
    strongest_breaker_stage,
};

#[test]
fn token_ceiling_breakers_preserve_every_integer_boundary_without_overflow() {
    for limit in [20, 100_001, MAX_TOKEN_BUDGET] {
        for (threshold, below, at_stage) in [
            (7_500_i128, None, "steer"),
            (9_000, Some("steer"), "constrain"),
            (10_000, Some("constrain"), "suspend"),
            (11_000, Some("suspend"), "stop"),
        ] {
            let at = (i128::from(limit) * threshold + 9_999) / 10_000;
            for (used, expected) in [(at - 1, below), (at, Some(at_stage))] {
                let used = i64::try_from(used).expect("finite-ceiling boundary fits i64");
                assert_eq!(
                    strongest_breaker_stage(&[("tokens", used, limit)]).map(|s| s.0),
                    expected,
                    "usage={used}, limit={limit}, boundary={threshold}"
                );
            }
        }
    }
    // Integer usage cannot represent the intermediate stages for a one-token
    // budget. These concrete expectations are independent of percentage math.
    for (used, expected) in [(0, None), (1, Some("suspend")), (2, Some("stop"))] {
        assert_eq!(
            strongest_breaker_stage(&[("tokens", used, 1)]).map(|s| s.0),
            expected
        );
    }
    assert_eq!(
        strongest_breaker_stage(&[("tokens", i64::MAX, i64::MAX)]).map(|s| s.0),
        Some("suspend")
    );
    for limit in [1, 50_000, MAX_TOKEN_BUDGET] {
        assert_eq!(
            strongest_breaker_stage(&[("tokens", i64::MAX, limit)]),
            Some(("stop", "tokens", i64::MAX, limit))
        );
    }
}

#[test]
fn token_ceiling_allocation_uses_every_remaining_authority_and_rejects_zero() {
    let full = RollingBudgetRemaining {
        actor_tokens: MAX_TOKEN_BUDGET,
        corp_tokens: MAX_TOKEN_BUDGET,
        actor_cost_microusd: 10_000_000,
        corp_cost_microusd: 100_000_000,
    };
    for smaller in [1, 50_000, MAX_TOKEN_BUDGET - 1, MAX_TOKEN_BUDGET] {
        assert_eq!(
            clamped_token_allocation(smaller, MAX_TOKEN_BUDGET, full).unwrap(),
            smaller
        );
        assert_eq!(
            clamped_token_allocation(MAX_TOKEN_BUDGET, smaller, full).unwrap(),
            smaller
        );
        assert_eq!(
            clamped_token_allocation(
                MAX_TOKEN_BUDGET,
                MAX_TOKEN_BUDGET,
                RollingBudgetRemaining {
                    actor_tokens: smaller,
                    ..full
                }
            )
            .unwrap(),
            smaller
        );
        assert_eq!(
            clamped_token_allocation(
                MAX_TOKEN_BUDGET,
                MAX_TOKEN_BUDGET,
                RollingBudgetRemaining {
                    corp_tokens: smaller,
                    ..full
                }
            )
            .unwrap(),
            smaller
        );
    }
    for invalid in [i64::MIN, -1, 0, MAX_TOKEN_BUDGET + 1, i64::MAX] {
        assert!(clamped_token_allocation(invalid, MAX_TOKEN_BUDGET, full).is_err());
    }
    for exhausted in [i64::MIN, -1, 0] {
        assert!(clamped_token_allocation(MAX_TOKEN_BUDGET, exhausted, full).is_err());
        assert!(
            clamped_token_allocation(
                MAX_TOKEN_BUDGET,
                MAX_TOKEN_BUDGET,
                RollingBudgetRemaining {
                    actor_tokens: exhausted,
                    ..full
                }
            )
            .is_err()
        );
        assert!(
            clamped_token_allocation(
                MAX_TOKEN_BUDGET,
                MAX_TOKEN_BUDGET,
                RollingBudgetRemaining {
                    corp_tokens: exhausted,
                    ..full
                }
            )
            .is_err()
        );
    }
}

#[test]
fn token_ceiling_does_not_relax_cost_or_loop_breaker_priority() {
    for metric in [
        "run_cost",
        "mission_cost",
        "actor_cost",
        "corp_cost",
        "no_progress",
        "repeated_tool",
    ] {
        assert_eq!(
            strongest_breaker_stage(&[("run_tokens", 1, MAX_TOKEN_BUDGET), (metric, 110, 100)]),
            Some(("stop", metric, 110, 100))
        );
    }
    assert_eq!(MAX_TOKEN_BUDGET, 999_999_999_999_999);
}

async fn create_plan(f: &Fixture, plan: &TaskGraphPlan) -> Result<MissionPlanIds> {
    Ok(f.store
        .create_mission(
            f.ids.corp_id,
            f.ids.alice_actor_id,
            "Finite token budget",
            "Owned store regression; no provider execution",
            plan,
        )
        .await?
        .0)
}

// Only the SQLx-owned database receives this synthetic historical usage. It is
// not evidence of a provider run, and no retained application state is edited.
async fn seed_retained_run(f: &Fixture, task_id: Uuid, used: i64) -> Result<Uuid> {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,workspace_run_id,
          status,budget_tokens_limit,input_tokens,output_tokens,cost_microusd,breaker_stage)
         VALUES($1,$2,$3,$4,$5,$6,$1,'failed',1000,$7,0,1234,'stop')",
    )
    .bind(id)
    .bind(f.ids.corp_id)
    .bind(task_id)
    .bind(f.ids.codex_agent_id)
    .bind(&f.runner.id)
    .bind(Uuid::new_v4())
    .bind(used)
    .execute(&f.store.pool)
    .await?;
    Ok(id)
}

async fn retained_history(f: &Fixture, ids: &MissionPlanIds) -> Result<Value> {
    Ok(sqlx::query_scalar(
        "SELECT jsonb_build_object(
          'mission',to_jsonb(m),
          'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM tasks t WHERE t.mission_id=m.id),
          'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.mission_id=m.id))
         FROM missions m WHERE m.corp_id=$1 AND m.id=$2",
    ).bind(f.ids.corp_id).bind(ids.mission_id).fetch_one(&f.store.pool).await?)
}

async fn assert_launch_allocation(
    f: &Fixture,
    ids: &MissionPlanIds,
    task: usize,
    expected: i64,
) -> Result<()> {
    let (launch, _) = f
        .store
        .create_task_run(
            f.ids.corp_id,
            ids.mission_id,
            ids.task_ids[task],
            Some(f.ids.alice_actor_id),
            &f.runner.id,
        )
        .await?;
    assert_eq!(launch.attempt, 1);
    let limits: (i64, i64) = sqlx::query_as(
        "SELECT budget_tokens_limit,budget_cost_microusd_limit FROM runs WHERE id=$1 AND corp_id=$2",
    ).bind(launch.run_id).bind(f.ids.corp_id).fetch_one(&f.store.pool).await?;
    assert_eq!(limits, (expected, 1_000_000));
    // No runner is connected to this metadata fixture. Retire only this newly
    // created zero-usage dispatch so the next independent case can use the agent.
    sqlx::query("UPDATE runs SET status='cancelled' WHERE id=$1")
        .bind(launch.run_id)
        .execute(&f.store.pool)
        .await?;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn token_ceiling_store_and_factory_accept_exact_and_smaller_budgets(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    for tokens in [1, 50_003, MAX_TOKEN_BUDGET - 1, MAX_TOKEN_BUDGET] {
        let mut plan = factory_plan(&f, None);
        plan.budget_tokens = tokens;
        plan.tasks[0].contract.budget_tokens = tokens;
        let ordinary = create_plan(&f, &plan).await?;
        let before = retained_history(&f, &ordinary).await?;
        assert_eq!(before["mission"]["budget_tokens"], tokens);
        assert_eq!(before["tasks"][0]["contract"]["budget_tokens"], tokens);
        let mut approved = policy(None);
        approved["budget_tokens"] = json!(tokens);
        let checked = f
            .store
            .preflight_factory_mission(preflight(&f, approved.clone()), &plan)
            .await?;
        let claim = f
            .store
            .claim_factory_work_item(claim_input(&f, approved, &format!("tokens-{tokens}")))
            .await?;
        let input = materialize(&f, &claim, &format!("tokens-{tokens}"));
        let outcome = f
            .store
            .materialize_factory_mission(input.clone(), &checked)
            .await?;
        let saved = retained_history(&f, &outcome.ids).await?;
        assert_eq!(saved["mission"]["budget_tokens"], tokens);
        assert_eq!(saved["mission"]["original_budget_tokens"], tokens);
        assert_eq!(saved["tasks"][0]["contract"]["budget_tokens"], tokens);
        assert_eq!(
            saved["tasks"][0]["contract"]["budget_cost_microusd"],
            1_000_000
        );
        assert_eq!(saved["tasks"][0]["max_attempts"], 1);
        assert_eq!(saved["tasks"][0]["attempt_count"], 0);
        assert_materialization_replays(&f, &input, &checked, &outcome).await?;
        assert_eq!(retained_history(&f, &ordinary).await?, before);
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn token_ceiling_invalid_admission_does_not_write_ledgers(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let before = ledger(&f).await?;
    for (index, value) in [
        json!(0),
        json!(-1),
        json!(MAX_TOKEN_BUDGET + 1),
        json!(i64::MAX),
        json!(u64::MAX),
        json!("999999999999999"),
        json!(1.5),
        Value::Null,
    ]
    .into_iter()
    .enumerate()
    {
        let mut invalid = policy(None);
        invalid["budget_tokens"] = value;
        assert!(
            f.store
                .claim_factory_work_item(claim_input(
                    &f,
                    invalid.clone(),
                    &format!("invalid-token-{index}")
                ))
                .await
                .is_err()
        );
        assert!(
            f.store
                .preflight_factory_mission(preflight(&f, invalid), &factory_plan(&f, None))
                .await
                .is_err()
        );
        assert_eq!(ledger(&f).await?, before);
    }
    for invalid in [i64::MIN, -1, 0, MAX_TOKEN_BUDGET + 1, i64::MAX] {
        let mut plan = factory_plan(&f, None);
        plan.budget_tokens = invalid;
        assert!(create_plan(&f, &plan).await.is_err());
        plan.budget_tokens = MAX_TOKEN_BUDGET;
        plan.tasks[0].contract.budget_tokens = invalid;
        assert!(create_plan(&f, &plan).await.is_err());
        let mut approved = policy(None);
        approved["budget_tokens"] = json!(MAX_TOKEN_BUDGET);
        assert!(
            f.store
                .preflight_factory_mission(preflight(&f, approved), &plan)
                .await
                .is_err()
        );
        assert_eq!(ledger(&f).await?, before);
    }
    let mut overallocated = factory_plan(&f, None);
    overallocated.tasks[0].contract.budget_tokens = 1001;
    assert!(create_plan(&f, &overallocated).await.is_err());
    assert!(
        f.store
            .preflight_factory_mission(preflight(&f, policy(None)), &overallocated)
            .await
            .is_err()
    );
    assert_eq!(ledger(&f).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn token_ceiling_initial_dispatch_clamps_rolling_allowances_and_preserves_history(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let old = create_plan(&f, &factory_plan(&f, None)).await?;
    seed_retained_run(&f, old.task_ids[0], 30).await?;
    let old_snapshot = retained_history(&f, &old).await?;
    for (actor_tokens, corp_tokens, task_tokens, expected) in [
        (80, 90, MAX_TOKEN_BUDGET, 50),
        (90, 80, MAX_TOKEN_BUDGET, 50),
        (90, 90, 20, 20),
        (31, 90, MAX_TOKEN_BUDGET, 1),
    ] {
        f.store
            .set_budget_policy(
                f.ids.corp_id,
                f.ids.alice_actor_id,
                actor_tokens,
                10_000_000,
                corp_tokens,
                100_000_000,
                8,
                4,
            )
            .await?;
        let mut plan = factory_plan(&f, None);
        plan.budget_tokens = MAX_TOKEN_BUDGET;
        plan.tasks[0].contract.budget_tokens = task_tokens;
        let ids = create_plan(&f, &plan).await?;
        assert_launch_allocation(&f, &ids, 0, expected).await?;
        assert_eq!(retained_history(&f, &old).await?, old_snapshot);
    }
    for (actor_tokens, corp_tokens) in [(30, 90), (90, 30)] {
        f.store
            .set_budget_policy(
                f.ids.corp_id,
                f.ids.alice_actor_id,
                actor_tokens,
                10_000_000,
                corp_tokens,
                100_000_000,
                8,
                4,
            )
            .await?;
        let ids = create_plan(&f, &factory_plan(&f, None)).await?;
        let before = ledger(&f).await?;
        let error = f
            .store
            .create_task_run(
                f.ids.corp_id,
                ids.mission_id,
                ids.task_ids[0],
                Some(f.ids.alice_actor_id),
                &f.runner.id,
            )
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("rolling budget has no remaining authority")
        );
        assert_eq!(
            ledger(&f).await?,
            before,
            "zero remainder must not reserve an attempt or run"
        );
        assert_eq!(retained_history(&f, &old).await?, old_snapshot);
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn token_ceiling_initial_dispatch_clamps_mission_remaining_and_rejects_exhaustion(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    for spent in [1500, 2000] {
        let mut plan = factory_plan(&f, None);
        plan.budget_tokens = 2000;
        plan.budget_cost_microusd = 2_000_000;
        let mut other = plan.tasks[0].clone();
        other.key = "prior-attempt".to_owned();
        plan.tasks.push(other);
        let ids = create_plan(&f, &plan).await?;
        seed_retained_run(&f, ids.task_ids[1], spent).await?;
        if spent == 1500 {
            assert_launch_allocation(&f, &ids, 0, 500).await?;
        } else {
            let before = ledger(&f).await?;
            let error = f
                .store
                .create_task_run(
                    f.ids.corp_id,
                    ids.mission_id,
                    ids.task_ids[0],
                    Some(f.ids.alice_actor_id),
                    &f.runner.id,
                )
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("mission has no remaining authorized budget")
            );
            assert_eq!(ledger(&f).await?, before);
        }
    }
    Ok(())
}

#[sqlx::test(migrations = false)]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn token_ceiling_migration_preserves_existing_allocations_spend_and_graph_bounds(
    pool: PgPool,
) -> Result<()> {
    let current = sqlx::migrate!("../../db/migrations");
    let previous = sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(
            current
                .iter()
                .filter(|m| m.version <= 56)
                .cloned()
                .collect(),
        ),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    assert_eq!(previous.iter().count(), 56);
    previous.run(&pool).await?;
    let applied_before: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM _sqlx_migrations m",
    )
    .fetch_one(&pool)
    .await?;
    assert_eq!(applied_before.as_array().unwrap().len(), 56);
    let f = fixture(pool).await?;
    let old = create_plan(&f, &factory_plan(&f, None)).await?;
    seed_retained_run(&f, old.task_ids[0], 30).await?;
    f.store
        .set_budget_policy(
            f.ids.corp_id,
            f.ids.alice_actor_id,
            80,
            10_000_000,
            90,
            100_000_000,
            8,
            4,
        )
        .await?;
    let before = ledger(&f).await?;
    let policy_before: Value =
        sqlx::query_scalar("SELECT to_jsonb(p) FROM corp_budget_policies p WHERE corp_id=$1")
            .bind(f.ids.corp_id)
            .fetch_one(&f.store.pool)
            .await?;
    current.run(&f.store.pool).await?;
    let applied_after: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM _sqlx_migrations m WHERE version<=56",
    )
    .fetch_one(&f.store.pool)
    .await?;
    assert_eq!(applied_after, applied_before);
    let applied_ceiling: bool =
        sqlx::query_scalar("SELECT success FROM _sqlx_migrations WHERE version=57")
            .fetch_one(&f.store.pool)
            .await?;
    assert!(applied_ceiling);
    assert_eq!(ledger(&f).await?, before);
    let policy_after: Value =
        sqlx::query_scalar("SELECT to_jsonb(p) FROM corp_budget_policies p WHERE corp_id=$1")
            .bind(f.ids.corp_id)
            .fetch_one(&f.store.pool)
            .await?;
    assert_eq!(policy_after, policy_before);
    for (table, column) in [
        ("missions", "budget_tokens"),
        ("runs", "budget_tokens_limit"),
        ("corp_budget_policies", "actor_tokens_per_24h"),
        ("corp_budget_policies", "corp_tokens_per_24h"),
    ] {
        let expression: String = sqlx::query_scalar(
            "SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
        ).bind(table).bind(column).fetch_one(&f.store.pool).await?;
        // This expression comes from the owned database's catalog, not a request.
        let actual: i64 = sqlx::query_scalar(&format!("SELECT {expression}"))
            .fetch_one(&f.store.pool)
            .await?;
        assert_eq!(actual, 999_999_999_999_999, "{table}.{column}");
    }
    for invalid in [0, -1, MAX_TOKEN_BUDGET + 1, i64::MAX] {
        let error = sqlx::query("UPDATE missions SET budget_tokens=$1 WHERE id=$2")
            .bind(invalid)
            .bind(old.mission_id)
            .execute(&f.store.pool)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().and_then(|e| e.code()).as_deref(),
            Some("23514")
        );
    }
    for (nodes, depth) in [(0, 0), (33, 0), (1, -1), (1, 9)] {
        assert!(
            sqlx::query("UPDATE missions SET max_nodes=$1,max_depth=$2 WHERE id=$3")
                .bind(nodes)
                .bind(depth)
                .bind(old.mission_id)
                .execute(&f.store.pool)
                .await
                .is_err()
        );
    }
    assert_eq!(ledger(&f).await?, before);
    Ok(())
}
