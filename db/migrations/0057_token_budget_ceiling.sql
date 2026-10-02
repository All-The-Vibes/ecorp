-- Increase only defaults and the mission upper bound. Existing allocations,
-- policies, spend, attempts and terminal history retain their original values.
ALTER TABLE missions
    DROP CONSTRAINT missions_graph_limits_check;

ALTER TABLE missions
    ADD CONSTRAINT missions_graph_limits_check
    CHECK (
        max_nodes BETWEEN 1 AND 32
        AND max_depth BETWEEN 0 AND 8
        AND budget_tokens BETWEEN 1 AND 999999999999999
    );

ALTER TABLE missions
    ALTER COLUMN budget_tokens SET DEFAULT 999999999999999;

ALTER TABLE runs
    ALTER COLUMN budget_tokens_limit SET DEFAULT 999999999999999;

ALTER TABLE corp_budget_policies
    ALTER COLUMN actor_tokens_per_24h SET DEFAULT 999999999999999,
    ALTER COLUMN corp_tokens_per_24h SET DEFAULT 999999999999999;
