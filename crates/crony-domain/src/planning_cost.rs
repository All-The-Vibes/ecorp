use serde_json::Value;

pub const MAX_TASK_BUDGET_COST_MICROUSD: i64 = 10_000_000;
pub const MAX_GRAPH_BUDGET_COST_MICROUSD: i64 = 50_000_000;

/// The planner's ordered cost allocation, without changing explicit budgets.
/// Validate before arithmetic so even hostile i64 inputs cannot overflow.
pub fn strategy_cost_budgets(strategy: &str, total: i64) -> Result<Vec<i64>, String> {
    if !(1..=MAX_GRAPH_BUDGET_COST_MICROUSD).contains(&total) {
        return Err(format!(
            "strategy cost budget must be between 1 and {MAX_GRAPH_BUDGET_COST_MICROUSD} microusd"
        ));
    }
    let costs = match strategy {
        "single"
        | "verification-matrix"
        | "verification-failure"
        | "human-approval"
        | "independent-review" => vec![total],
        "parallel-specialists" => {
            let specialist = (total * 2 / 7).max(1);
            vec![specialist, specialist, (total - specialist * 2).max(1)]
        }
        "studio-swarm" => {
            if total < 4 {
                return Err(
                    "studio-swarm cost budget must fund four tasks (at least 4 microusd)"
                        .to_owned(),
                );
            }
            let specialist = (total * 3 / 20).max(1);
            vec![specialist, specialist, specialist, total - specialist * 3]
        }
        _ => return Err("unknown manager strategy for cost allocation".to_owned()),
    };
    if costs.iter().sum::<i64>() > total {
        return Err(format!(
            "strategy {strategy} cost budget {total} microusd cannot fund every task"
        ));
    }
    if let Some(cost) = costs
        .iter()
        .find(|cost| !(1..=MAX_TASK_BUDGET_COST_MICROUSD).contains(cost))
    {
        return Err(format!(
            "strategy {strategy} cost budget {total} microusd allocates {cost} microusd to a task; per-task limit is {MAX_TASK_BUDGET_COST_MICROUSD} microusd"
        ));
    }
    Ok(costs)
}

/// Prospective admission only. Historical policy decoding must remain lossless.
pub fn validate_factory_cost_policy(policy: &Value) -> Result<(), String> {
    let total = policy
        .get("budget_cost_microusd")
        .and_then(Value::as_i64)
        .ok_or("factory policy budget_cost_microusd must be an integer")?;
    let strategies = policy
        .get("strategy_allowlist")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or("factory policy strategy_allowlist must be a non-empty array")?;
    for strategy in strategies {
        let strategy = strategy
            .as_str()
            .ok_or("factory policy strategy_allowlist entries must be strings")?;
        strategy_cost_budgets(strategy, total)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn issue79_cost_allocations_preserve_small_defaults_and_boundaries() {
        for (strategy, total, expected) in [
            ("single", 1, vec![1]),
            ("single", 10_000_000, vec![10_000_000]),
            ("parallel-specialists", 3, vec![1, 1, 1]),
            (
                "parallel-specialists",
                3_000_000,
                vec![857_142, 857_142, 1_285_716],
            ),
            (
                "parallel-specialists",
                23_333_332,
                vec![6_666_666, 6_666_666, 10_000_000],
            ),
            ("studio-swarm", 4, vec![1, 1, 1, 1]),
            (
                "studio-swarm",
                6_000_000,
                vec![900_000, 900_000, 900_000, 3_300_000],
            ),
            (
                "studio-swarm",
                18_181_816,
                vec![2_727_272, 2_727_272, 2_727_272, 10_000_000],
            ),
        ] {
            assert_eq!(strategy_cost_budgets(strategy, total).unwrap(), expected);
        }
    }

    #[test]
    fn issue79_cost_rejects_overflow_impossible_splits_and_unknown_strategies() {
        for (strategy, costs) in [
            (
                "single",
                vec![0, -1, 10_000_001, 20_000_000, i64::MAX, i64::MIN],
            ),
            (
                "parallel-specialists",
                vec![1, 2, 23_333_333, 50_000_001, i64::MAX],
            ),
            (
                "studio-swarm",
                vec![1, 2, 3, 18_181_817, 20_000_000, i64::MAX],
            ),
            ("unknown", vec![1]),
        ] {
            for cost in costs {
                assert!(
                    strategy_cost_budgets(strategy, cost).is_err(),
                    "{strategy}/{cost}"
                );
            }
        }
        for strategy in [
            "verification-matrix",
            "verification-failure",
            "human-approval",
            "independent-review",
        ] {
            assert_eq!(strategy_cost_budgets(strategy, 1).unwrap(), vec![1]);
            assert!(strategy_cost_budgets(strategy, 10_000_001).is_err());
        }
    }

    #[test]
    fn issue79_policy_validates_every_strategy_without_rewriting_json() {
        let policy =
            json!({"strategy_allowlist":["single","studio-swarm"],"budget_cost_microusd":4});
        let before = policy.clone();
        validate_factory_cost_policy(&policy).unwrap();
        assert_eq!(policy, before);
        for invalid in [
            json!({}),
            json!({"strategy_allowlist":[],"budget_cost_microusd":1}),
            json!({"strategy_allowlist":[null],"budget_cost_microusd":1}),
            json!({"strategy_allowlist":["single"],"budget_cost_microusd":"1"}),
            json!({"strategy_allowlist":["single"],"budget_cost_microusd":1.0}),
            json!({"strategy_allowlist":["parallel-specialists","single"],"budget_cost_microusd":20_000_000}),
        ] {
            assert!(validate_factory_cost_policy(&invalid).is_err());
        }
    }
}
