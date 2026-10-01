//! A publication seed is admitted under the ordinary native run dispatch locks.
use super::*;
use crony_protocol::{
    MAX_VERIFICATION_ARTIFACT_BYTES, ReviewRevisionSource, VerificationArtifactReference,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRevisionDispatch {
    pub source: ReviewRevisionSource,
    pub artifact: StoredArtifact,
    pub expected_workspace_fingerprint: Option<String>,
    pub expected_head_commit: Option<String>,
}

impl PgStore {
    pub async fn review_revision_dispatch(
        &self,
        corp: Uuid,
        run: Uuid,
    ) -> Result<Option<ReviewRevisionDispatch>> {
        let mut tx = self.pool.begin().await?;
        aggregate_breaker::lock_corp_tx(&mut tx, corp).await?;
        sqlx::query("SELECT id FROM runs WHERE corp_id=$1 AND id=$2 FOR UPDATE")
            .bind(corp)
            .bind(run)
            .fetch_one(&mut *tx)
            .await?;
        let grant = dispatch_tx(&mut tx, corp, run).await?;
        tx.commit().await?;
        Ok(grant)
    }
}

pub(crate) async fn dispatch_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
) -> Result<Option<ReviewRevisionDispatch>> {
    let task: Uuid = sqlx::query_scalar("SELECT task_id FROM runs WHERE corp_id=$1 AND id=$2")
        .bind(corp)
        .bind(run)
        .fetch_one(&mut **tx)
        .await?;
    let Some(record) = lifecycle::for_task_tx(tx, corp, task).await? else {
        return Ok(None);
    };
    let r = &record.revision;
    lifecycle::pending_selection_tx(tx, &record).await?;
    ensure_factory_recovery_authorizer_tx(tx, corp, r.source_mission_id, r.authorized_by).await?;
    validate_contracts_tx(tx, &record).await?;
    let item = factory_work_item_tx(tx, corp, r.factory_work_item_id, false)
        .await?
        .context("correction Factory item missing")?
        .0;
    let source = validate_source_tx(tx, &item, &record).await?;
    validate_publication_lineage_tx(tx, &item, r.source_run_id).await?;
    let row = sqlx::query(
        "SELECT run.breaker_stage,run.resumed_from_run_id,run.workspace_run_id,run.workspace_connection_id,
            previous.id AS previous_id,previous.status AS previous_status,
            previous.workspace_path,previous.workspace_disposition,previous.workspace_fingerprint,
            previous.workspace_head_commit,previous.workspace_base_commit,
            previous.breaker_stage AS previous_breaker
         FROM runs run
         JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
         JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=run.corp_id
         JOIN agents agent ON agent.id=run.agent_id AND agent.corp_id=run.corp_id
         LEFT JOIN runs previous ON previous.id=run.resumed_from_run_id AND previous.corp_id=run.corp_id
            AND previous.task_id=run.task_id AND previous.agent_id=run.agent_id AND previous.runner_id=run.runner_id
            AND previous.workspace_run_id=run.workspace_run_id AND previous.execution_mode='provider'
            AND previous.provider_session_id=run.provider_session_id
            AND previous.workspace_connection_id IS NOT DISTINCT FROM run.workspace_connection_id
            AND previous.source_repository IS NOT DISTINCT FROM run.source_repository
            AND previous.source_base_ref IS NOT DISTINCT FROM run.source_base_ref
            AND previous.source_base_commit IS NOT DISTINCT FROM run.source_base_commit
         WHERE run.corp_id=$1 AND run.id=$2 AND run.task_id=$3 AND task.mission_id=$4
            AND run.status IN ('provisioning','starting') AND run.execution_mode='provider'
            AND task.status='claimed' AND mission.status='running'
            AND agent.current_run_id=run.id AND task.assigned_agent_id=agent.id AND agent.retired_at IS NULL
            AND agent.adapter=task.required_adapter AND task.attempt_count BETWEEN 1 AND task.max_attempts
            AND run.model IS NOT DISTINCT FROM task.contract->>'model'
            AND run.reasoning_effort IS NOT DISTINCT FROM task.contract->>'reasoning_effort'
            AND run.source_repository IS NOT DISTINCT FROM task.contract->>'source_repository'
            AND run.source_base_ref IS NOT DISTINCT FROM task.contract->>'source_base_ref'
            AND run.source_base_commit=$5
            AND run.workspace_disposition IS DISTINCT FROM 'quarantined'
         FOR UPDATE OF run,task,mission,agent",
    ).bind(corp).bind(run).bind(r.task_id).bind(r.mission_id).bind(&source.base_commit)
        .fetch_optional(&mut **tx).await?.context("correction no longer matches its native assignment")?;
    ensure_run_not_hard_blocked_tx(
        tx,
        corp,
        run,
        &row.get::<String, _>("breaker_stage"),
        "review revision dispatch",
    )
    .await?;
    ensure!(
        workspace_connections::validate_run_connection_tx(tx, corp, run).await?
            == row.get::<Option<Uuid>, _>("workspace_connection_id"),
        "correction connection changed"
    );
    let (fingerprint, head) = if row.get::<Option<Uuid>, _>("resumed_from_run_id").is_some() {
        ensure!(
            row.get::<Option<Uuid>, _>("previous_id").is_some()
                && matches!(
                    row.get::<Option<&str>, _>("previous_status"),
                    Some("failed" | "cancelled" | "verification_failed")
                )
                && row.get::<Option<&str>, _>("previous_breaker") != Some("stop")
                && row.get::<Option<&str>, _>("workspace_disposition") == Some("preserved")
                && row
                    .get::<Option<&str>, _>("workspace_path")
                    .is_some_and(|p| !p.is_empty())
                && row.get::<Option<&str>, _>("workspace_base_commit")
                    == Some(source.base_commit.as_str()),
            "correction resume lost its preserved native workspace lineage"
        );
        let fingerprint: String = row
            .get::<Option<String>, _>("workspace_fingerprint")
            .filter(|v| valid_sha256(v))
            .context("correction resume requires a persisted workspace fingerprint")?;
        let head: String = row
            .get::<Option<String>, _>("workspace_head_commit")
            .context("correction resume requires a runner-confirmed Git HEAD")?;
        validate_factory_base_commit(&head)?;
        (Some(fingerprint), Some(head))
    } else {
        ensure!(
            row.get::<Uuid, _>("workspace_run_id") == run,
            "fresh correction must own a fresh workspace"
        );
        (None, None)
    };
    let artifact = map_stored_artifact(
        sqlx::query(
            "SELECT artifact.* FROM artifacts artifact
         JOIN runs source ON source.corp_id=artifact.corp_id AND source.id=artifact.run_id
            AND source.task_id=artifact.task_id AND source.agent_id=artifact.producer_agent_id
            AND source.runner_id=artifact.producer_runner_id
         WHERE artifact.corp_id=$1 AND artifact.id=$2 AND artifact.task_id=$3 AND artifact.run_id=$4
            AND artifact.artifact_role='source_deliverable' AND artifact.status='ready'
            AND artifact.retention_until>now() AND artifact.sha256=$5 FOR SHARE OF artifact",
        )
        .bind(corp)
        .bind(source.artifact_id)
        .bind(source.task_id)
        .bind(source.run_id)
        .bind(&source.deliverable_sha256)
        .fetch_optional(&mut **tx)
        .await?
        .context("correction source artifact is missing, expired or has different provenance")?,
    );
    let bundle = artifact
        .metadata
        .get("git_bundle_sha256")
        .and_then(Value::as_str)
        .filter(|value| valid_sha256(value))
        .context("correction source bundle digest is invalid")?
        .to_owned();
    let bytes = usize::try_from(artifact.bytes).context("negative correction artifact size")?;
    ensure!(
        bytes > 0
            && bytes <= MAX_VERIFICATION_ARTIFACT_BYTES
            && valid_sha256(&artifact.sha256)
            && valid_sha256(&source.verification_sha256),
        "correction source artifact exceeds native bounds or has invalid digests"
    );
    Ok(Some(ReviewRevisionDispatch {
        source: ReviewRevisionSource {
            revision_id: r.id,
            publication_id: r.publication_id,
            source_run_id: r.source_run_id,
            source_deliverable_id: r.source_deliverable_id,
            original_base_commit: source.base_commit,
            source_head_commit: source.commit_sha,
            source_branch: source.source_branch,
            verification_sha256: source.verification_sha256,
            git_bundle_sha256: bundle,
            artifact: VerificationArtifactReference {
                path: artifact.file_name.clone(),
                sha256: artifact.sha256.clone(),
                bytes,
                media_type: artifact.media_type.clone(),
                data_base64: None,
            },
        },
        artifact,
        expected_workspace_fingerprint: fingerprint,
        expected_head_commit: head,
    }))
}

/// The contents fingerprint does not bind Git HEAD. Save both only from this
/// authenticated assignment's native cleanup receipt; replay cannot change them.
pub(crate) async fn checkpoint_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
    disposition: &str,
    fingerprint: Option<&str>,
    payload: &Value,
) -> Result<()> {
    let linked: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM factory_review_revisions r JOIN runs run
        ON run.corp_id=r.corp_id AND run.task_id=r.task_id WHERE run.corp_id=$1 AND run.id=$2)",
    )
    .bind(corp)
    .bind(run)
    .fetch_one(&mut **tx)
    .await?;
    if !linked || disposition != "preserved" || fingerprint.is_none() {
        return Ok(());
    }
    let head = payload
        .get("head_commit")
        .and_then(Value::as_str)
        .context("correction checkpoint requires a runner-confirmed Git HEAD")?;
    validate_factory_base_commit(head)?;
    let existing: Option<String> =
        sqlx::query_scalar("SELECT workspace_head_commit FROM runs WHERE corp_id=$1 AND id=$2")
            .bind(corp)
            .bind(run)
            .fetch_one(&mut **tx)
            .await?;
    ensure!(
        existing.as_deref().is_none_or(|old| old == head),
        "correction checkpoint HEAD cannot change after retention"
    );
    sqlx::query("UPDATE runs SET workspace_head_commit=$3 WHERE corp_id=$1 AND id=$2")
        .bind(corp)
        .bind(run)
        .bind(head)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
