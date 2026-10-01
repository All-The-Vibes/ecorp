//! The final native enqueue retains the same locks as admission and settlement.
use super::*;

async fn authorize_dispatch_tx(
    tx: &mut Transaction<'_, Postgres>,
    command: &PendingRunnerCommand,
) -> Result<()> {
    ensure!(
        command.command_kind == "factory_base_refresh",
        "not a base refresh command"
    );
    aggregate_breaker::lock_corp_tx(tx, command.corp_id).await?;
    let identity = sqlx::query(
        "SELECT id,factory_work_item_id FROM factory_base_refreshes
         WHERE corp_id=$1 AND run_id=$2 AND command_id=$3",
    )
    .bind(command.corp_id)
    .bind(command.run_id)
    .bind(command.id)
    .fetch_optional(&mut **tx)
    .await?
    .context("refresh command has no saved authority")?;
    let (item, token) = factory_work_item_tx(
        tx,
        command.corp_id,
        identity.get("factory_work_item_id"),
        true,
    )
    .await?
    .context("refresh Factory item missing")?;
    let record = record_tx(tx, command.corp_id, identity.get("id")).await?;
    let r = &record.refresh;
    ensure!(
        r.state == "pending"
            && record.command_id == command.id
            && record.command_payload == command.payload
            && item.mission_id == Some(r.source_mission_id)
            && item.state == FactoryWorkItemState::Verified
            && item.policy == record.source_policy,
        "refresh command or original selection changed"
    );
    ensure_factory_recovery_authorizer_tx(tx, r.corp_id, r.source_mission_id, r.authorized_by)
        .await?;
    let request: AuthorizeFactoryBaseRefresh = serde_json::from_value(record.request.clone())?;
    // Renewal may advance the version, but never transfers this authorization
    // to a new claimant/token or changes its immutable selection and policy.
    ensure!(
        item.version > request.expected_version,
        "refresh claim version went backwards"
    );
    ensure_active_factory_control(
        &item,
        token,
        r.authorized_by,
        request.claim_token,
        item.version,
        Utc::now(),
    )?;
    ensure_unpublished_tx(tx, r.corp_id, item.id).await?;
    PgStore::ensure_audit_workflow_gates_tx(tx, r.corp_id).await?;
    validate_contracts_tx(tx, &record).await?;
    let source =
        publication::validate_refresh_source_tx(tx, item.clone(), r.source_deliverable_id).await?;
    ensure!(
        source.run_id == r.source_run_id
            && source.task_id == r.source_task_id
            && source.base_commit == r.original_base_commit
            && source.commit_sha == r.source_head_commit
            && source.effective_source_revision == record.observed_source_revision
            && source.source_recovery_id == record.source_recovery_id,
        "refresh original source authority changed"
    );
    validate_adopted_lineage_tx(tx, &item, source.run_id).await?;
    let row = sqlx::query(
        r#"SELECT run.breaker_stage FROM runner_commands command
        JOIN runs run ON run.id=command.run_id AND run.corp_id=command.corp_id AND run.runner_id=command.runner_id
        JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
        JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=run.corp_id
        JOIN agents agent ON agent.id=run.agent_id AND agent.corp_id=run.corp_id
        WHERE command.id=$1 AND command.corp_id=$2 AND command.run_id=$3 AND command.runner_id=$4
          AND command.status='pending' AND command.command_kind='factory_base_refresh' AND command.payload=$5
          AND run.task_id=$6 AND task.mission_id=$7 AND agent.current_run_id=run.id
          AND run.status IN ('starting','running','verifying','waiting_for_approval')
          AND task.status IN ('claimed','running','awaiting_approval') AND mission.status='running'
          AND task.attempt_count=1 AND task.max_attempts=1 AND agent.adapter=task.required_adapter
          AND command.payload->>'refresh_id'=$8::text
          AND command.payload->>'corp_id'=run.corp_id::text
          AND command.payload->>'room_id'=mission.room_id::text
          AND command.payload->>'mission_id'=mission.id::text
          AND command.payload->>'task_id'=task.id::text
          AND command.payload->>'run_id'=run.id::text
          AND command.payload->>'workspace_run_id'=run.id::text
          AND command.payload->>'agent_id'=run.agent_id::text
          AND command.payload->>'assignment_token'=run.assignment_token::text
          AND command.payload->>'workspace_connection_id' IS NOT DISTINCT FROM run.workspace_connection_id::text
          AND command.payload->>'source_repository'=run.source_repository
          AND command.payload->>'source_base_ref'=run.source_base_ref
          AND command.payload->>'source_base_commit'=run.source_base_commit
          AND command.payload->>'workspace_base_commit'=run.source_base_commit
          AND command.payload->'verification_policy'=task.verification_policy
          AND command.payload->'write_scope'=task.contract->'write_scope'
          AND command.payload->'deliverable'=task.contract->'deliverable'
        FOR UPDATE OF run,task,mission,agent,command"#,
    ).bind(command.id).bind(r.corp_id).bind(r.run_id).bind(&command.runner_id).bind(&command.payload)
        .bind(r.task_id).bind(r.mission_id).bind(r.id.to_string())
        .fetch_optional(&mut **tx).await?.context("refresh assignment no longer matches native command")?;
    ensure!(
        zero_provider_allocation_tx(tx, r.corp_id, r.run_id).await?,
        "refresh is not an exact provider-free allocation"
    );
    workspace_connections::validate_run_connection_tx(tx, r.corp_id, r.run_id).await?;
    ensure_run_not_hard_blocked_tx(
        tx,
        r.corp_id,
        r.run_id,
        &row.get::<String, _>("breaker_stage"),
        "base refresh dispatch",
    )
    .await?;
    Ok(())
}

async fn authorized_tx(
    tx: &mut Transaction<'_, Postgres>,
    command: &PendingRunnerCommand,
) -> Result<bool> {
    match authorize_dispatch_tx(tx, command).await {
        Ok(()) => Ok(true),
        Err(error) if error.downcast_ref::<sqlx::Error>().is_some() => Err(error),
        Err(_) => Ok(false),
    }
}

impl PgStore {
    /// Object reads take place between two of these exact scoped grants. Final
    /// enqueue independently checks authority while holding all relevant locks.
    pub async fn base_refresh_dispatch_artifacts(
        &self,
        command: &PendingRunnerCommand,
    ) -> Result<Option<(StoredArtifact, Option<StoredArtifact>)>> {
        let mut tx = self.pool.begin().await?;
        if !authorized_tx(&mut tx, command).await? {
            return Ok(None);
        }
        let row = sqlx::query(
            "SELECT artifact.* FROM factory_base_refreshes refresh
             JOIN source_deliverables source ON source.id=refresh.source_deliverable_id
               AND source.corp_id=refresh.corp_id AND source.run_id=refresh.source_run_id AND source.task_id=refresh.source_task_id
             JOIN artifacts artifact ON artifact.id=source.artifact_id AND artifact.corp_id=source.corp_id
               AND artifact.run_id=source.run_id AND artifact.task_id=source.task_id
             WHERE refresh.corp_id=$1 AND refresh.run_id=$2 AND refresh.command_id=$3
               AND artifact.status='ready' AND artifact.artifact_role='source_deliverable' AND artifact.retention_until>now()",
        ).bind(command.corp_id).bind(command.run_id).bind(command.id)
            .fetch_optional(&mut *tx).await?.context("authorized refresh bundle is unavailable")?;
        let bundle = map_stored_artifact(row);
        let provider =
            inherited_provider_artifact_tx(&mut tx, command.corp_id, command.run_id).await?;
        tx.commit().await?;
        Ok(Some((bundle, provider)))
    }

    pub async fn with_base_refresh_command_dispatch<F>(
        &self,
        command: &PendingRunnerCommand,
        dispatch: F,
    ) -> Result<RunBudgetDispatchOutcome<RunnerCommandDispatchOutcome>>
    where
        F: FnOnce() -> Result<bool>,
    {
        let mut tx = self.pool.begin().await?;
        if !authorized_tx(&mut tx, command).await? {
            let status: Option<String> = sqlx::query_scalar(
                "SELECT status FROM runner_commands WHERE id=$1 AND corp_id=$2 AND run_id=$3
                   AND runner_id=$4 AND command_kind='factory_base_refresh' AND payload=$5",
            )
            .bind(command.id)
            .bind(command.corp_id)
            .bind(command.run_id)
            .bind(&command.runner_id)
            .bind(&command.payload)
            .fetch_optional(&mut *tx)
            .await?;
            return Ok(RunBudgetDispatchOutcome {
                transport_result: if status.is_some_and(|status| status != "pending") {
                    RunnerCommandDispatchOutcome::Settled
                } else {
                    RunnerCommandDispatchOutcome::Obsolete
                },
                commit_error: None,
            });
        }
        let transport_result = if dispatch()? {
            RunnerCommandDispatchOutcome::Sent
        } else {
            RunnerCommandDispatchOutcome::Disconnected
        };
        // Once enqueue succeeds, an uncertain commit response cannot justify
        // failing the run. The durable command remains pending until native ACK.
        let commit_error = tx.commit().await.err();
        Ok(RunBudgetDispatchOutcome {
            transport_result,
            commit_error,
        })
    }

    pub async fn fail_base_refresh_before_dispatch(
        &self,
        command: &PendingRunnerCommand,
        reason: &str,
    ) -> Result<Vec<DomainEvent>> {
        ensure!(
            command.command_kind == "factory_base_refresh",
            "wrong command kind for refresh failure"
        );
        let mut tx = self.pool.begin().await?;
        aggregate_breaker::lock_corp_tx(&mut tx, command.corp_id).await?;
        let valid: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM factory_base_refreshes refresh JOIN runner_commands command
               ON command.id=refresh.command_id AND command.corp_id=refresh.corp_id AND command.run_id=refresh.run_id
             WHERE command.id=$1 AND command.corp_id=$2 AND command.run_id=$3 AND command.runner_id=$4
               AND command.command_kind='factory_base_refresh' AND command.payload=$5
               AND refresh.command_payload=command.payload)",
        ).bind(command.id).bind(command.corp_id).bind(command.run_id).bind(&command.runner_id)
            .bind(&command.payload).fetch_one(&mut *tx).await?;
        ensure!(valid, "refresh failure has no matching saved command");
        // Native ACK must win over stale artifact-transfer failures, even before
        // run.started arrives. Hold the exact pending command through lifecycle
        // cleanup and command retirement, so neither can commit on its own.
        let mut events = Self::fail_run_before_dispatch_tx(
            &mut tx,
            command.corp_id,
            command.run_id,
            reason,
            Some(command),
        )
        .await?;
        let row = sqlx::query(
            "SELECT command.status AS command_status, run.status AS run_status
             FROM runner_commands command JOIN runs run
               ON run.id=command.run_id AND run.corp_id=command.corp_id AND run.runner_id=command.runner_id
             WHERE command.id=$1 AND command.corp_id=$2 AND command.run_id=$3 AND command.runner_id=$4",
        ).bind(command.id).bind(command.corp_id).bind(command.run_id).bind(&command.runner_id)
            .fetch_one(&mut *tx).await?;
        // A started run can still have a pending ACK. Preserve both in that
        // case; only inactive allocations may have their command retired.
        if runner_command_dispatch_state(
            &row.get::<String, _>("command_status"),
            Some(&row.get::<String, _>("run_status")),
        ) == RunnerCommandDispatchState::Obsolete
            && let Some(event) =
                Self::fail_runner_command_tx(&mut tx, command.id, &command.runner_id, reason)
                    .await?
        {
            events.push(event);
        }
        tx.commit().await?;
        Ok(events)
    }
}
