//! Exact cross-mission lineage; no generic verification-only privilege.
use super::*;

/// Historical checkpoint proof remains scoped to the selected adopted chain.
/// This read-only membership check grants no new execution authority: admission
/// and dispatch still require the current Factory mission. Budget accounting
/// additionally requires a completed, exactly bound zero-provider allocation.
pub(crate) async fn adopted_source_contains_run_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    item: Uuid,
    run: Uuid,
) -> Result<bool> {
    sqlx::query_scalar(
        r#"WITH RECURSIVE adopted AS (
            SELECT refresh.*, 1 AS depth, ARRAY[refresh.id] AS visited
            FROM factory_work_items item
            JOIN factory_base_refreshes refresh ON refresh.corp_id=item.corp_id
              AND refresh.factory_work_item_id=item.id AND refresh.mission_id=item.mission_id
            WHERE item.corp_id=$1 AND item.id=$2 AND refresh.state='adopted'
              AND item.policy=refresh.source_policy||jsonb_build_object('source_base_commit',refresh.refreshed_base_commit)
            UNION ALL
            SELECT parent.*, child.depth+1, child.visited||parent.id
            FROM adopted child JOIN factory_base_refreshes parent
              ON parent.corp_id=child.corp_id AND parent.factory_work_item_id=child.factory_work_item_id
              AND parent.mission_id=child.source_mission_id AND parent.run_id=child.source_run_id
              AND parent.result_deliverable_id=child.source_deliverable_id
              AND parent.result_commit=child.source_head_commit
            WHERE parent.state='adopted' AND child.depth<$4 AND NOT parent.id=ANY(child.visited)
              AND child.source_policy=parent.source_policy||jsonb_build_object('source_base_commit',parent.refreshed_base_commit)
        ), lineage AS (
            SELECT source.id,source.resumed_from_run_id,source.task_id,source.agent_id,
                   source.runner_id,source.workspace_run_id,source.source_repository,
                   source.source_base_ref,source.source_base_commit,0 AS depth,ARRAY[source.id] AS visited
            FROM adopted refresh JOIN runs source
              ON source.corp_id=refresh.corp_id AND source.id=refresh.source_run_id AND source.task_id=refresh.source_task_id
            JOIN tasks task ON task.id=source.task_id AND task.corp_id=source.corp_id
              AND task.mission_id=refresh.source_mission_id
            WHERE source.status='completed' AND source.verification_status='passed'
              AND task.status='completed' AND task.verification_status='passed'
              AND task.contract=refresh.source_contract AND task.verification_policy=refresh.source_verification_policy
            UNION ALL
            SELECT parent.id,parent.resumed_from_run_id,parent.task_id,parent.agent_id,
                   parent.runner_id,parent.workspace_run_id,parent.source_repository,
                   parent.source_base_ref,parent.source_base_commit,child.depth+1,child.visited||parent.id
            FROM lineage child JOIN runs parent ON parent.id=child.resumed_from_run_id
              AND parent.corp_id=$1 AND parent.task_id=child.task_id AND parent.agent_id=child.agent_id
              AND parent.runner_id=child.runner_id AND parent.workspace_run_id=child.workspace_run_id
              AND parent.source_repository IS NOT DISTINCT FROM child.source_repository
              AND parent.source_base_ref IS NOT DISTINCT FROM child.source_base_ref
              AND parent.source_base_commit IS NOT DISTINCT FROM child.source_base_commit
            WHERE child.depth<64 AND NOT parent.id=ANY(child.visited)
        ) SELECT EXISTS(SELECT 1 FROM lineage WHERE id=$3)"#,
    ).bind(corp).bind(item).bind(run).bind(MAX_BASE_REFRESH_ATTEMPTS)
        .fetch_one(&mut **tx).await.map_err(Into::into)
}

/// A refresh has no provider budget, so losing its exemption is not itself a
/// numeric budget overrun. Reject progress explicitly when immutable authority
/// was invalidated (including a durable stop or abandonment), even with zero
/// usage. Call under the same run lock as the event or human decision.
pub(crate) async fn validate_progress_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
) -> Result<()> {
    let refresh: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM factory_base_refreshes WHERE corp_id=$1 AND run_id=$2)",
    )
    .bind(corp)
    .bind(run)
    .fetch_one(&mut **tx)
    .await?;
    ensure!(
        !refresh || zero_provider_allocation_tx(tx, corp, run).await?,
        "base refresh lost its exact verification-only authority"
    );
    Ok(())
}

pub(crate) async fn zero_provider_allocation_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
) -> Result<bool> {
    let row = sqlx::query(
        r#"SELECT refresh.source_verification_policy,refresh.refreshed_verification_policy
        FROM factory_base_refreshes refresh
        JOIN factory_work_items item ON item.id=refresh.factory_work_item_id AND item.corp_id=refresh.corp_id
        JOIN runs run ON run.id=refresh.run_id AND run.corp_id=refresh.corp_id AND run.task_id=refresh.task_id
        JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id AND task.mission_id=refresh.mission_id
        JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=run.corp_id
        JOIN runs source ON source.id=refresh.source_run_id AND source.corp_id=run.corp_id AND source.task_id=refresh.source_task_id
        JOIN tasks original ON original.id=source.task_id AND original.corp_id=run.corp_id AND original.mission_id=refresh.source_mission_id
        JOIN missions origin ON origin.id=original.mission_id AND origin.corp_id=run.corp_id
        JOIN source_deliverables deliverable ON deliverable.id=refresh.source_deliverable_id
          AND deliverable.corp_id=run.corp_id AND deliverable.task_id=source.task_id AND deliverable.run_id=source.id
        WHERE run.corp_id=$1 AND run.id=$2 AND refresh.state IN ('pending','adopted')
          AND run.execution_mode='verification_only' AND run.resumed_from_run_id IS NULL AND run.workspace_run_id=run.id
          AND run.provider_session_id IS NULL AND run.model IS NULL AND run.reasoning_effort IS NULL
          AND run.budget_tokens_limit=0 AND run.budget_cost_microusd_limit=0
          AND run.input_tokens=0 AND run.output_tokens=0 AND run.cost_microusd=0
          AND run.workspace_disposition IS DISTINCT FROM 'quarantined'
          AND task.contract=refresh.refreshed_contract AND task.verification_policy=refresh.refreshed_verification_policy
          AND original.contract=refresh.source_contract AND original.verification_policy=refresh.source_verification_policy
          AND refresh.refreshed_contract=refresh.source_contract||jsonb_build_object('source_base_commit',refresh.refreshed_base_commit)
          AND original.contract->>'source_base_commit'=refresh.original_base_commit
          AND source.source_base_commit=refresh.original_base_commit
          AND source.source_repository=run.source_repository AND source.source_base_ref=run.source_base_ref
          AND task.contract->>'source_repository'=run.source_repository AND task.contract->>'source_base_ref'=run.source_base_ref
          AND task.contract->>'source_base_commit'=run.source_base_commit AND run.source_base_commit=refresh.refreshed_base_commit
          AND task.contract->>'workspace_connection_id' IS NOT DISTINCT FROM run.workspace_connection_id::text
          AND run.artifact_id IS NOT DISTINCT FROM source.artifact_id
          AND run.artifact_sha256 IS NOT DISTINCT FROM source.artifact_sha256
          AND mission.room_id=origin.room_id AND mission.requested_by=origin.requested_by
          AND task.required_adapter=original.required_adapter
          AND source.status='completed' AND source.verification_status='passed'
          AND original.status='completed' AND original.verification_status='passed' AND origin.status='completed'
          AND deliverable.base_commit=refresh.original_base_commit AND deliverable.head_commit=refresh.source_head_commit
          AND deliverable.verification_sha256=source.verification_sha256
          AND NOT EXISTS(SELECT 1 FROM events stop WHERE stop.corp_id=run.corp_id AND stop.aggregate_id=run.id
            AND stop.aggregate_type='run' AND stop.type='run.stop_requested')"#,
    ).bind(corp).bind(run).fetch_optional(&mut **tx).await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let policy: VerificationPolicy = serde_json::from_value(row.get("source_verification_policy"))?;
    Ok(serde_json::to_value(base_refresh_policy(&policy))?
        == row.get::<Value, _>("refreshed_verification_policy"))
}

/// Retain the real producer/task/run of inherited evidence, walking only exact
/// authorized refresh or verifier-recovery links until reaching its producer.
pub(crate) async fn inherited_provider_artifact_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
) -> Result<Option<StoredArtifact>> {
    if !zero_provider_allocation_tx(tx, corp, run).await? {
        return Ok(None);
    }
    let artifact = sqlx::query(
        "SELECT artifact.* FROM runs run JOIN artifacts artifact ON artifact.id=run.artifact_id AND artifact.corp_id=run.corp_id
         WHERE run.corp_id=$1 AND run.id=$2 AND artifact.status='ready' AND artifact.artifact_role='provider_evidence'
           AND artifact.sha256=run.artifact_sha256 AND artifact.retention_until>now()",
    ).bind(corp).bind(run).fetch_optional(&mut **tx).await?.map(map_stored_artifact);
    let Some(artifact) = artifact else {
        return Ok(None);
    };
    let mut cursor = run;
    let mut visited = HashSet::new();
    loop {
        ensure!(
            visited.insert(cursor) && visited.len() <= 64,
            "provider evidence lineage is cyclic or unbounded"
        );
        let row = sqlx::query(
            "SELECT task_id,agent_id,runner_id,artifact_id,artifact_sha256 FROM runs WHERE corp_id=$1 AND id=$2",
        ).bind(corp).bind(cursor).fetch_one(&mut **tx).await?;
        ensure!(
            row.get::<Option<Uuid>, _>("artifact_id") == Some(artifact.id)
                && row.get::<Option<String>, _>("artifact_sha256").as_deref()
                    == Some(artifact.sha256.as_str()),
            "inherited provider evidence changed along its lineage"
        );
        if cursor == artifact.run_id {
            ensure!(
                row.get::<Uuid, _>("task_id") == artifact.task_id
                    && row.get::<Uuid, _>("agent_id") == artifact.producer_agent_id
                    && row.get::<String, _>("runner_id") == artifact.producer_runner_id,
                "provider evidence producer identity is invalid"
            );
            return Ok(Some(artifact));
        }
        if zero_provider_allocation_tx(tx, corp, cursor).await? {
            cursor = sqlx::query_scalar(
                "SELECT source_run_id FROM factory_base_refreshes WHERE corp_id=$1 AND run_id=$2",
            )
            .bind(corp)
            .bind(cursor)
            .fetch_one(&mut **tx)
            .await?;
            continue;
        }
        cursor = sqlx::query_scalar(
            r#"SELECT source.id FROM runs run
            JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
            JOIN factory_verification_recoveries recovery ON recovery.corp_id=run.corp_id
              AND recovery.replacement_run_id=run.id AND recovery.task_id=run.task_id AND recovery.mission_id=task.mission_id
            JOIN runs source ON source.id=recovery.source_run_id AND source.id=run.resumed_from_run_id
              AND source.corp_id=run.corp_id AND source.task_id=run.task_id AND source.agent_id=run.agent_id
              AND source.runner_id=run.runner_id AND source.workspace_run_id=run.workspace_run_id
              AND source.source_repository IS NOT DISTINCT FROM run.source_repository
              AND source.source_base_ref IS NOT DISTINCT FROM run.source_base_ref
              AND source.source_base_commit IS NOT DISTINCT FROM run.source_base_commit
              AND source.artifact_id=run.artifact_id AND source.artifact_sha256=run.artifact_sha256
            WHERE run.corp_id=$1 AND run.id=$2 AND run.execution_mode='verification_only'
              AND recovery.mode IN ('verifier_only','checkpoint_verification') AND recovery.status='completed'
              AND recovery.replacement_verification_policy=task.verification_policy"#,
        ).bind(corp).bind(cursor).fetch_optional(&mut **tx).await?.context("inherited provider evidence has no exact producer lineage")?;
    }
}

async fn exported_head_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
) -> Result<Option<String>> {
    let head: Option<String> = sqlx::query_scalar(
        r#"SELECT deliverable.head_commit FROM runs run
        JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
        JOIN factory_base_refreshes refresh ON refresh.run_id=run.id AND refresh.corp_id=run.corp_id
          AND refresh.task_id=task.id AND refresh.mission_id=task.mission_id
        JOIN source_deliverables deliverable ON deliverable.run_id=run.id AND deliverable.task_id=run.task_id AND deliverable.corp_id=run.corp_id
        JOIN artifacts artifact ON artifact.id=deliverable.artifact_id AND artifact.corp_id=run.corp_id
          AND artifact.run_id=run.id AND artifact.task_id=run.task_id AND artifact.producer_agent_id=run.agent_id
          AND artifact.producer_runner_id=run.runner_id AND artifact.artifact_role='source_deliverable' AND artifact.status='ready'
        WHERE run.id=$2 AND run.corp_id=$1 AND run.execution_mode='verification_only'
          AND task.verification_policy=refresh.refreshed_verification_policy AND task.contract=refresh.refreshed_contract
          AND run.workspace_run_id=run.id AND run.resumed_from_run_id IS NULL
          AND artifact.sha256=run.deliverable_sha256 AND artifact.retention_until>now()
          AND deliverable.verification_sha256=run.verification_sha256
          AND artifact.metadata->>'verification_sha256'=deliverable.verification_sha256
          AND artifact.metadata->>'head_commit'=deliverable.head_commit
          AND artifact.metadata->>'base_commit'=deliverable.base_commit
          AND artifact.metadata->>'branch'=deliverable.branch AND artifact.metadata->>'form'=deliverable.form
          AND deliverable.base_commit=refresh.refreshed_base_commit AND deliverable.base_commit=run.source_base_commit
          AND deliverable.base_commit=run.workspace_base_commit AND deliverable.branch=run.workspace_branch
          AND deliverable.form='commit_branch' AND deliverable.form=task.contract#>>'{deliverable,form}'
          AND deliverable.head_commit IS NOT NULL"#,
    ).bind(corp).bind(run).fetch_optional(&mut **tx).await?;
    if let Some(head) = &head {
        validate_factory_base_commit(head)?;
    }
    Ok(head)
}

pub(crate) async fn checkpoint_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
    lock: bool,
) -> Result<Option<SourceWorkspaceCheckpoint>> {
    let query = format!(
        "SELECT run.* FROM runs run JOIN factory_base_refreshes refresh ON refresh.corp_id=run.corp_id
         AND refresh.run_id=run.id AND refresh.task_id=run.task_id WHERE run.corp_id=$1 AND run.id=$2 {}",
        if lock { "FOR UPDATE OF run" } else { "" },
    );
    let Some(row) = sqlx::query(&query)
        .bind(corp)
        .bind(run)
        .fetch_optional(&mut **tx)
        .await?
    else {
        return Ok(None);
    };
    ensure!(
        zero_provider_allocation_tx(tx, corp, run).await?,
        "refresh checkpoint has no exact immutable lineage"
    );
    let head = exported_head_tx(tx, corp, run).await?;
    ensure!(
        head.is_some(),
        "refresh checkpoint has no exact ready export binding"
    );
    let fingerprint: Option<String> = row.get("workspace_fingerprint");
    ensure!(
        fingerprint.as_deref().is_none_or(valid_sha256),
        "refresh checkpoint fingerprint is invalid"
    );
    Ok(Some(SourceWorkspaceCheckpoint {
        status: row.get("status"),
        execution_mode: row.get("execution_mode"),
        source_correction_recovery: false,
        verification_status: row.get("verification_status"),
        workspace_path: row.get("workspace_path"),
        disposition: row.get("workspace_disposition"),
        expected_verifier_fingerprint: fingerprint.clone(),
        fingerprint,
        expected_head_commit: head,
    }))
}

pub(crate) async fn review_ready_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
) -> Result<bool> {
    let waiting: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM runs run
        JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
        JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=run.corp_id
        JOIN factory_base_refreshes refresh ON refresh.run_id=run.id AND refresh.corp_id=run.corp_id
          AND refresh.task_id=task.id AND refresh.mission_id=mission.id
        JOIN factory_work_items item ON item.id=refresh.factory_work_item_id AND item.corp_id=run.corp_id
          AND item.mission_id=refresh.source_mission_id AND item.policy=refresh.source_policy
        JOIN verification_requests request ON request.run_id=run.id AND request.corp_id=run.corp_id AND request.task_id=task.id
        WHERE run.corp_id=$1 AND run.id=$2 AND refresh.state='pending' AND item.state='verified'
          AND run.status='waiting_for_approval' AND run.verification_status='waiting_for_approval'
          AND task.status='awaiting_approval' AND task.verification_status='waiting_for_approval'
          AND request.status='pending' AND request.gate=refresh.refreshed_verification_policy->'manual_gate'
          AND mission.status='running')"#,
    ).bind(corp).bind(run).fetch_one(&mut **tx).await?;
    Ok(waiting
        && zero_provider_allocation_tx(tx, corp, run).await?
        && exported_head_tx(tx, corp, run).await?.is_some())
}

/// Exclude every refresh author and all original requesters/producers, not only
/// the newly allocated verifier agent. The ordinary gate still validates role.
pub(crate) async fn validate_reviewer_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
    actor: Uuid,
    key: Option<Uuid>,
) -> Result<()> {
    let mut cursor = run;
    let mut visited = HashSet::new();
    loop {
        let row = sqlx::query(
            "SELECT refresh.id,refresh.authorized_by,refresh.source_run_id,mission.requested_by,producer.actor_id
             FROM factory_base_refreshes refresh
             JOIN missions mission ON mission.id=refresh.source_mission_id AND mission.corp_id=refresh.corp_id
             JOIN runs source ON source.id=refresh.source_run_id AND source.corp_id=refresh.corp_id AND source.task_id=refresh.source_task_id
             JOIN agents producer ON producer.id=source.agent_id AND producer.corp_id=refresh.corp_id
             WHERE refresh.corp_id=$1 AND refresh.run_id=$2 FOR SHARE OF refresh,mission,producer",
        ).bind(corp).bind(cursor).fetch_optional(&mut **tx).await?;
        let Some(row) = row else {
            return Ok(());
        };
        ensure!(
            visited.insert(row.get::<Uuid, _>("id"))
                && visited.len() <= MAX_BASE_REFRESH_ATTEMPTS as usize,
            "review lineage is cyclic or unbounded"
        );
        ensure!(
            key.is_some_and(|key| !key.is_nil()),
            "refresh review requires a durable decision key"
        );
        ensure!(
            actor != row.get::<Uuid, _>("authorized_by")
                && actor != row.get::<Uuid, _>("requested_by")
                && actor != row.get::<Uuid, _>("actor_id"),
            "refresh requires a reviewer independent of original work and refresh authorization"
        );
        cursor = row.get("source_run_id");
    }
}
