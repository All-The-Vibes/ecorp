use super::*;

impl PgStore {
    /// Serialize human-progress enqueue with accounting and aggregate fences.
    /// Checkpoint and recovery commands have their own lifecycle authorization.
    pub async fn with_progress_command_dispatch<F>(
        &self,
        command: &PendingRunnerCommand,
        dispatch: F,
    ) -> Result<RunnerCommandDispatchOutcome>
    where
        F: FnOnce(Option<Uuid>) -> Result<bool>,
    {
        if !matches!(
            command.command_kind.as_str(),
            "approval_decision" | "control_message"
        ) {
            return Err(anyhow!(
                "budget progress dispatch requires an approval or control command"
            ));
        }
        let mut tx = self.pool.begin().await?;
        lock_corp_tx(&mut tx, command.corp_id).await?;
        // Use the same Corp -> run -> command lock order as progress writers.
        let run = sqlx::query(
            "SELECT status, breaker_stage FROM runs
             WHERE corp_id=$1 AND id=$2 AND runner_id=$3 FOR UPDATE",
        )
        .bind(command.corp_id)
        .bind(command.run_id)
        .bind(&command.runner_id)
        .fetch_optional(&mut *tx)
        .await?;
        let queued = sqlx::query(
            "SELECT command.status,
                    COALESCE(command.command_kind='approval_decision'
                      AND command.payload->'approved'='false'::jsonb
                      AND EXISTS(SELECT 1 FROM action_approvals approval
                        WHERE approval.id::text=command.payload->>'approval_id'
                          AND approval.corp_id=command.corp_id
                          AND approval.run_id=command.run_id
                          AND approval.status IN ('rejected','expired')),false) AS negative_cleanup
             FROM runner_commands command
             WHERE command.id=$1 AND command.corp_id=$2 AND command.run_id=$3
               AND command.runner_id=$4 AND command.command_kind=$5 AND command.payload=$6
             FOR UPDATE OF command",
        )
        .bind(command.id)
        .bind(command.corp_id)
        .bind(command.run_id)
        .bind(&command.runner_id)
        .bind(&command.command_kind)
        .bind(&command.payload)
        .fetch_optional(&mut *tx)
        .await?;
        let status = queued
            .as_ref()
            .map(|row| row.get::<&str, _>("status"))
            .unwrap_or("missing");
        let cleanup = queued
            .as_ref()
            .is_some_and(|row| row.get::<bool, _>("negative_cleanup"));
        // A persisted rejection/expiry must reach its assigned provider even
        // after cancellation or a budget fence. It denies an effect; it cannot
        // authorize progress. Exact command payload and approval scope are bound
        // above, and only the runner may acknowledge successful delivery.
        let mut state = if status == "pending" && run.is_some() && cleanup {
            RunnerCommandDispatchState::Pending
        } else {
            runner_command_dispatch_state(
                status,
                run.as_ref().map(|row| row.get::<&str, _>("status")),
            )
        };
        if state == RunnerCommandDispatchState::Pending && !cleanup {
            let stage: &str = run
                .as_ref()
                .context("pending command run")?
                .get("breaker_stage");
            if breaker_is_hard(stage)
                || hard_breaker_reached_tx(&mut tx, command.corp_id, command.run_id).await?
            {
                state = RunnerCommandDispatchState::Obsolete;
            }
        }
        // Lease mutation does not take the Corp budget gate. Hold the actual
        // lease and queued message rows through enqueue, then check wall time
        // after every lock wait; transaction-start now() would accept expiry.
        let lease = if state == RunnerCommandDispatchState::Pending
            && command.command_kind == "control_message"
        {
            control_command_lease_tx(&mut tx, command).await?
        } else {
            None
        };
        if state == RunnerCommandDispatchState::Pending
            && command.command_kind == "control_message"
            && lease
                .as_ref()
                .is_none_or(|lease| lease.expires_at <= Utc::now())
        {
            state = RunnerCommandDispatchState::Obsolete;
        }
        let outcome = match state {
            RunnerCommandDispatchState::Pending => {
                if dispatch(lease.map(|lease| lease.token))? {
                    RunnerCommandDispatchOutcome::Sent
                } else {
                    RunnerCommandDispatchOutcome::Disconnected
                }
            }
            RunnerCommandDispatchState::Settled => RunnerCommandDispatchOutcome::Settled,
            RunnerCommandDispatchState::Obsolete => RunnerCommandDispatchOutcome::Obsolete,
        };
        // Budget, command, message and lease locks remain held through synchronous enqueue.
        tx.commit().await?;
        Ok(outcome)
    }

    pub async fn with_run_budget_dispatch<F>(
        &self,
        corp_id: Uuid,
        run_id: Uuid,
        assignment_token: Uuid,
        runner_id: &str,
        dispatch: F,
    ) -> Result<bool>
    where
        F: FnOnce() -> bool,
    {
        let mut tx = self.pool.begin().await?;
        lock_corp_tx(&mut tx, corp_id).await?;
        let stage: String = sqlx::query_scalar(
            "SELECT breaker_stage FROM runs
             WHERE corp_id=$1 AND id=$2 AND assignment_token=$3 AND runner_id=$4
               AND status IN ('provisioning','starting') FOR UPDATE",
        )
        .bind(corp_id)
        .bind(run_id)
        .bind(assignment_token)
        .bind(runner_id)
        .fetch_optional(&mut *tx)
        .await?
        .context("native budget dispatch does not match a pending assignment")?;
        ensure_run_not_hard_blocked_tx(&mut tx, corp_id, run_id, &stage, "native dispatch").await?;
        // Native enqueue must precede any subsequent fence command, not merely
        // pass a check before asynchronous dependency/secret preparation.
        let sent = dispatch();
        tx.commit().await?;
        Ok(sent)
    }
}

async fn control_command_lease_tx(
    tx: &mut Transaction<'_, Postgres>,
    command: &PendingRunnerCommand,
) -> Result<Option<ControlLease>> {
    if command.command_kind != "control_message" {
        return Ok(None);
    }
    let message_id = command
        .payload
        .get("message_id")
        .and_then(Value::as_str)
        .context("control message command omitted message_id")
        .and_then(|value| Uuid::parse_str(value).context("control message id is invalid"))?;
    let agent_id = command
        .payload
        .get("agent_id")
        .and_then(Value::as_str)
        .context("control message command omitted agent_id")
        .and_then(|value| Uuid::parse_str(value).context("control agent id is invalid"))?;
    let actor_id = command
        .payload
        .get("actor_id")
        .and_then(Value::as_str)
        .context("control message command omitted actor_id")
        .and_then(|value| Uuid::parse_str(value).context("control actor id is invalid"))?;
    let lease_version = command
        .payload
        .get("lease_version")
        .and_then(Value::as_i64)
        .context("control message command omitted lease_version")?;
    sqlx::query(
        r#"
            SELECT lease.agent_id, lease.corp_id, lease.actor_id, lease.token,
                   lease.lease_version, lease.expires_at
            FROM runner_commands command
            JOIN queued_messages message
              ON message.command_id = command.id
             AND message.corp_id = command.corp_id
             AND message.run_id = command.run_id
             AND message.status = 'immediate'
             AND message.text = command.payload->>'text'
             AND message.id = $3
             AND message.agent_id = $4
             AND message.actor_id = $5
            JOIN control_leases lease
              ON lease.corp_id = command.corp_id
             AND lease.agent_id = message.agent_id
             AND lease.actor_id = message.actor_id
             AND lease.lease_version = $6
            JOIN runs run
              ON run.id = command.run_id
             AND run.corp_id = command.corp_id
             AND run.agent_id = message.agent_id
             AND run.runner_id = command.runner_id
             AND run.status IN ('starting', 'running', 'waiting_for_input',
                                'waiting_for_approval', 'verifying')
            WHERE command.id = $1
              AND command.runner_id = $2
              AND command.corp_id = $7
              AND command.run_id = $8
              AND command.status = 'pending'
            FOR UPDATE OF message, lease
            "#,
    )
    .bind(command.id)
    .bind(&command.runner_id)
    .bind(message_id)
    .bind(agent_id)
    .bind(actor_id)
    .bind(lease_version)
    .bind(command.corp_id)
    .bind(command.run_id)
    .fetch_optional(&mut **tx)
    .await
    .map(|row| row.map(map_lease))
    .map_err(Into::into)
}

pub(super) async fn lock_corp_tx(tx: &mut Transaction<'_, Postgres>, corp_id: Uuid) -> Result<()> {
    lock_factory_keys_tx(tx, &[format!("budget:corp:{corp_id}")]).await
}

pub(super) async fn evaluate_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
) -> Result<CircuitBreakerOutcome> {
    let mut outcome = CircuitBreakerOutcome::default();
    let row = sqlx::query(
        r#"
        SELECT run.input_tokens + run.output_tokens AS run_tokens,
               run.cost_microusd AS run_cost,
               run.budget_tokens_limit AS run_token_limit,
               run.budget_cost_microusd_limit AS run_cost_limit,
               run.no_progress_events, run.repeated_tool_count,
               task.mission_id, mission.requested_by,
               mission.budget_tokens AS mission_token_limit,
               mission.budget_cost_microusd AS mission_cost_limit,
               COALESCE(policy.actor_tokens_per_24h, 4000000) AS actor_token_limit,
               COALESCE(policy.actor_cost_microusd_per_24h, 10000000) AS actor_cost_limit,
               COALESCE(policy.corp_tokens_per_24h, 20000000) AS corp_token_limit,
               COALESCE(policy.corp_cost_microusd_per_24h, 100000000) AS corp_cost_limit,
               COALESCE(policy.no_progress_event_limit, 8) AS no_progress_limit,
               COALESCE(policy.repeated_tool_limit, 5) AS repeated_tool_limit
        FROM runs run
        JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
        JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=task.corp_id
        LEFT JOIN corp_budget_policies policy ON policy.corp_id=run.corp_id
        WHERE run.id=$1 AND run.corp_id=$2
          AND run.status IN ('provisioning','starting','running','waiting_for_input',
                             'waiting_for_approval','verifying')
        "#,
    )
    .bind(run_id)
    .bind(corp_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else { return Ok(outcome) };
    let mission_id: Uuid = row.get("mission_id");
    let requester: Uuid = row.get("requested_by");
    let usage = sqlx::query(
        r#"
        SELECT
          COALESCE(SUM(run.input_tokens+run.output_tokens)
            FILTER (WHERE task.mission_id=$2),0)::BIGINT AS mission_tokens,
          COALESCE(SUM(run.cost_microusd)
            FILTER (WHERE task.mission_id=$2),0)::BIGINT AS mission_cost,
          COALESCE(SUM(run.input_tokens+run.output_tokens)
            FILTER (WHERE mission.requested_by=$3 AND run.created_at>=now()-interval '24 hours'),0)::BIGINT AS actor_tokens,
          COALESCE(SUM(run.cost_microusd)
            FILTER (WHERE mission.requested_by=$3 AND run.created_at>=now()-interval '24 hours'),0)::BIGINT AS actor_cost,
          COALESCE(SUM(run.input_tokens+run.output_tokens)
            FILTER (WHERE run.created_at>=now()-interval '24 hours'),0)::BIGINT AS corp_tokens,
          COALESCE(SUM(run.cost_microusd)
            FILTER (WHERE run.created_at>=now()-interval '24 hours'),0)::BIGINT AS corp_cost
        FROM runs run
        JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
        JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=task.corp_id
        WHERE run.corp_id=$1
        "#,
    )
    .bind(corp_id)
    .bind(mission_id)
    .bind(requester)
    .fetch_one(&mut **tx)
    .await?;
    let inputs = [
        (
            "run_tokens",
            row.get("run_tokens"),
            row.get("run_token_limit"),
        ),
        ("run_cost", row.get("run_cost"), row.get("run_cost_limit")),
        (
            "mission_tokens",
            usage.get("mission_tokens"),
            row.get("mission_token_limit"),
        ),
        (
            "mission_cost",
            usage.get("mission_cost"),
            row.get("mission_cost_limit"),
        ),
        (
            "actor_tokens_24h",
            usage.get("actor_tokens"),
            row.get("actor_token_limit"),
        ),
        (
            "actor_cost_24h",
            usage.get("actor_cost"),
            row.get("actor_cost_limit"),
        ),
        (
            "corp_tokens_24h",
            usage.get("corp_tokens"),
            row.get("corp_token_limit"),
        ),
        (
            "corp_cost_24h",
            usage.get("corp_cost"),
            row.get("corp_cost_limit"),
        ),
        (
            "no_progress",
            i64::from(row.get::<i32, _>("no_progress_events")),
            i64::from(row.get::<i32, _>("no_progress_limit")),
        ),
        (
            "repeated_tool",
            i64::from(row.get::<i32, _>("repeated_tool_count")),
            i64::from(row.get::<i32, _>("repeated_tool_limit")),
        ),
    ];
    if strongest_breaker_stage(&inputs).is_none() {
        return Ok(outcome);
    }
    let candidates = sqlx::query(
        r#"
        SELECT run.id,run.task_id,run.runner_id,run.breaker_stage,
               task.mission_id,mission.room_id,mission.requested_by
        FROM runs run
        JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
        JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=task.corp_id
        WHERE run.corp_id=$1 AND run.status IN
          ('provisioning','starting','running','waiting_for_input','waiting_for_approval','verifying')
        ORDER BY run.id
        FOR UPDATE OF run
        "#,
    )
    .bind(corp_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut exempt = HashSet::new();
    for candidate in &candidates {
        let id: Uuid = candidate.get("id");
        if budget_checkpoint::zero_provider_allocation_tx(tx, corp_id, id).await? {
            exempt.insert(id);
        }
    }
    for candidate in &candidates {
        let id: Uuid = candidate.get("id");
        let applicable: Vec<_> = inputs
            .iter()
            .copied()
            .filter(|input| {
                let metric = input.0;
                if exempt.contains(&id) && !matches!(metric, "no_progress" | "repeated_tool") {
                    return false;
                }
                if id == run_id {
                    return true;
                }
                if !strongest_breaker_stage(std::slice::from_ref(input))
                    .is_some_and(|stage| breaker_is_hard(stage.0))
                {
                    return false;
                }
                scope_matches(metric, candidate, mission_id, requester)
            })
            .collect();
        let Some((stage, metric, used, limit)) = strongest_breaker_stage(&applicable) else {
            continue;
        };
        if breaker_rank(stage) <= breaker_rank(&candidate.get::<String, _>("breaker_stage")) {
            continue;
        }
        let (scope, scope_id) = if metric.starts_with("mission_") {
            ("mission", mission_id)
        } else if metric.starts_with("actor_") {
            ("requester_24h", requester)
        } else if metric.starts_with("corp_") {
            ("corp_24h", corp_id)
        } else {
            ("run", run_id)
        };
        let affected_run_ids: Vec<Uuid> = candidates
            .iter()
            .filter_map(|other| {
                let other_id: Uuid = other.get("id");
                let affected = if scope == "run" || !breaker_is_hard(stage) {
                    other_id == run_id
                } else {
                    !exempt.contains(&other_id)
                        && scope_matches(metric, other, mission_id, requester)
                };
                affected.then_some(other_id)
            })
            .collect();
        let task_id: Uuid = candidate.get("task_id");
        sqlx::query(
            "UPDATE runs SET breaker_stage=$1,updated_at=now(),
                     status=CASE WHEN $1='suspend' AND status='running'
                                 THEN 'waiting_for_input' ELSE status END
                     WHERE id=$2 AND corp_id=$3",
        )
        .bind(stage)
        .bind(id)
        .bind(corp_id)
        .execute(&mut **tx)
        .await?;
        if stage == "suspend" {
            sqlx::query(
                "UPDATE tasks SET status='blocked',updated_at=now()
                         WHERE id=$1 AND corp_id=$2 AND status='running'",
            )
            .bind(task_id)
            .bind(corp_id)
            .execute(&mut **tx)
            .await?;
        }
        let reason = format!("{metric} reached {used} of {limit}");
        let input = json!({
            "scope":scope,"scope_id":scope_id,"metric":metric,"used":used,"limit":limit,
            "affected_run_ids":affected_run_ids,"evaluated_run_id":run_id
        });
        sqlx::query(
            "INSERT INTO circuit_breaker_incidents
            (id,corp_id,mission_id,task_id,run_id,stage,reason,input)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        )
        .bind(Uuid::new_v4())
        .bind(corp_id)
        .bind(candidate.get::<Uuid, _>("mission_id"))
        .bind(task_id)
        .bind(id)
        .bind(stage)
        .bind(&reason)
        .bind(&input)
        .execute(&mut **tx)
        .await?;
        let command = PendingRunnerCommand {
            id: Uuid::new_v4(),
            corp_id,
            runner_id: candidate.get("runner_id"),
            run_id: id,
            command_kind: "circuit_breaker".to_owned(),
            payload: json!({"stage":stage,"reason":reason}),
        };
        sqlx::query(
            "INSERT INTO runner_commands
            (id,corp_id,runner_id,run_id,command_kind,payload,idempotency_key)
            VALUES($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(command.id)
        .bind(corp_id)
        .bind(&command.runner_id)
        .bind(id)
        .bind(&command.command_kind)
        .bind(&command.payload)
        .bind(format!("breaker:{id}:{stage}"))
        .execute(&mut **tx)
        .await?;
        if let Some(event) = append_event_tx(
            tx,
            NewEvent {
                room_id: Some(candidate.get("room_id")),
                correlation_id: Some(candidate.get("mission_id")),
                ..NewEvent::new(
                    corp_id,
                    None,
                    "run.breaker_transition",
                    "run",
                    id,
                    format!("breaker-event:{id}:{stage}"),
                    json!({
                        "stage":stage,"reason":reason,"input":input,"command_id":command.id,
                        "runner_id":command.runner_id
                    }),
                )
            },
        )
        .await?
        {
            outcome.events.push(event);
        }
        outcome.commands.push(command);
    }
    Ok(outcome)
}

fn scope_matches(
    metric: &str,
    row: &sqlx::postgres::PgRow,
    mission: Uuid,
    requester: Uuid,
) -> bool {
    (metric.starts_with("mission_") && row.get::<Uuid, _>("mission_id") == mission)
        || (metric.starts_with("actor_") && row.get::<Uuid, _>("requested_by") == requester)
        || metric.starts_with("corp_")
}
