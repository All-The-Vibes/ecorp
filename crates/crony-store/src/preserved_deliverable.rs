//! Admission consumes runner-owned source evidence from the immutable journal.
//! It never reads a runner filesystem or widens a contract to fit old changes.

use super::*;
use crony_domain::{
    MAX_PRESERVED_PROVIDER_ARTIFACTS, PreservedDeliverableCheckpoint, PreservedProviderArtifact,
    write_scope_is_subset,
};

const RECOVERY: &str = "Keep the preserved worktree and retain write authority for its complete selected source delta. Use the current runner to checkpoint or resume under the unchanged full scope; otherwise create an explicitly authorized full-scope mission. Do not retry this correction in a fresh worktree.";

/// Legacy provider cleanup can attest a retained HEAD before any export exists.
/// This only recovers that identity; it grants neither execution nor narrowing.
/// The caller owns any source lock, so history projections remain read-only.
pub(super) async fn provider_head_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
) -> Result<Option<String>> {
    let head: Option<String> = sqlx::query_scalar(
        r#"SELECT preservation.payload->>'head_commit'
           FROM runs run
           JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
           JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=run.corp_id
           JOIN LATERAL (
             SELECT event.seq, event.type, event.payload, event.room_id, event.correlation_id
             FROM events event
             WHERE event.corp_id=run.corp_id AND event.aggregate_type='run'
               AND event.aggregate_id=run.id
               AND event.type IN ('run.workspace_preserved','run.workspace_removed','run.teardown_uncertain')
             ORDER BY event.seq DESC LIMIT 1
           ) preservation ON true
           JOIN LATERAL (
             SELECT event.seq, event.type, event.payload, event.room_id, event.correlation_id
             FROM events event
             WHERE event.corp_id=run.corp_id AND event.aggregate_type='run'
               AND event.aggregate_id=run.id
               AND event.type IN ('run.session_terminated','run.teardown_uncertain')
             ORDER BY event.seq DESC LIMIT 1
           ) termination ON true
           WHERE run.id=$1 AND run.corp_id=$2 AND run.execution_mode='provider'
             AND run.status IN ('failed','cancelled','lost','completed')
             AND run.workspace_disposition='preserved'
             AND run.workspace_path<>'' AND run.workspace_branch<>'' AND run.workspace_base_ref<>''
             AND run.workspace_fingerprint ~ '^[0-9a-f]{64}$'
             AND preservation.type='run.workspace_preserved'
             AND preservation.payload->'workspace'=to_jsonb(run.workspace_path)
             AND preservation.payload->'workspace_branch'=to_jsonb(run.workspace_branch)
             AND preservation.payload->'workspace_base_ref'=to_jsonb(run.workspace_base_ref)
             AND preservation.payload->'workspace_base_commit'=to_jsonb(run.workspace_base_commit)
             AND preservation.payload->'workspace_fingerprint'=to_jsonb(run.workspace_fingerprint)
             AND (NOT preservation.payload ? 'workspace_quarantined'
                  OR preservation.payload->'workspace_quarantined'='false'::jsonb)
             AND jsonb_typeof(preservation.payload->'head_commit')='string'
             AND preservation.room_id=mission.room_id AND preservation.correlation_id=mission.id
             AND termination.type='run.session_terminated' AND termination.seq<preservation.seq
             AND termination.payload->'provider_process_alive'='false'::jsonb
             AND termination.payload->>'outcome' IN ('completed','failed','cancelled')
             AND termination.room_id=mission.room_id AND termination.correlation_id=mission.id"#,
    )
    .bind(run_id)
    .bind(corp_id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(head) = head.as_deref() {
        validate_factory_base_commit(head)?;
    }
    Ok(head)
}

/// Only admitted provider-artifact metadata in the exact workspace ancestry may
/// describe legacy exclusions. The runner must still match contained bytes and
/// the native index; these records never become fresh verifier evidence.
pub(super) async fn provider_artifacts_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
) -> Result<Vec<PreservedProviderArtifact>> {
    let rows = sqlx::query(
        r#"WITH RECURSIVE lineage AS (
             SELECT run.*, 0 AS depth, ARRAY[run.id] AS visited
             FROM runs run WHERE run.id=$1 AND run.corp_id=$2
             UNION ALL
             SELECT parent.*, child.depth+1, child.visited || parent.id
             FROM runs parent JOIN lineage child ON parent.id=child.resumed_from_run_id
             WHERE parent.corp_id=child.corp_id AND parent.task_id=child.task_id
               AND parent.agent_id=child.agent_id AND parent.runner_id=child.runner_id
               AND parent.workspace_run_id=child.workspace_run_id
               AND parent.workspace_base_commit IS NOT DISTINCT FROM child.workspace_base_commit
               AND parent.source_repository IS NOT DISTINCT FROM child.source_repository
               AND parent.source_base_ref IS NOT DISTINCT FROM child.source_base_ref
               AND parent.source_base_commit IS NOT DISTINCT FROM child.source_base_commit
               AND NOT parent.id=ANY(child.visited) AND child.depth<64
           )
           SELECT artifact.metadata->>'workspace_relative_path' AS path,
                  artifact.sha256, artifact.bytes, artifact.media_type
           FROM lineage run JOIN artifacts artifact
             ON artifact.run_id=run.id AND artifact.corp_id=run.corp_id
            AND artifact.task_id=run.task_id AND artifact.producer_agent_id=run.agent_id
            AND artifact.producer_runner_id=run.runner_id
           WHERE artifact.artifact_role='provider_evidence' AND artifact.status='ready'
             AND artifact.metadata->>'workspace_relative_path' IS NOT NULL
           ORDER BY run.depth, artifact.created_at DESC, artifact.id
           LIMIT $3"#,
    )
    .bind(run_id)
    .bind(corp_id)
    .bind((MAX_PRESERVED_PROVIDER_ARTIFACTS + 1) as i64)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() > MAX_PRESERVED_PROVIDER_ARTIFACTS {
        return Err(native_policy!(
            "preserved provider artifact inventory exceeds its bound. {RECOVERY}"
        ));
    }
    let mut references = Vec::new();
    for row in rows {
        let Ok(bytes) = u64::try_from(row.get::<i64, _>("bytes")) else {
            continue;
        };
        let reference = PreservedProviderArtifact {
            path: row.get("path"),
            sha256: row.get("sha256"),
            bytes,
            media_type: row.get("media_type"),
        };
        if reference.is_valid() {
            references.push(reference);
        }
    }
    Ok(references)
}

pub(super) fn ensure_scope(
    proof: &PreservedDeliverableCheckpoint,
    contract: &TaskContract,
) -> Result<()> {
    if !proof.is_valid() || proof.deliverable != contract.deliverable {
        return Err(native_policy!(
            "preserved deliverable checkpoint does not match the source policy. {RECOVERY}"
        ));
    }
    if let Some(path) = proof.excluded_deliverable_path(&contract.write_scope) {
        return Err(native_policy!(
            "write scope excludes preserved deliverable path {path}. {RECOVERY}"
        ));
    }
    Ok(())
}

pub(super) async fn checkpoint_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
    contract: &TaskContract,
) -> Result<Option<PreservedDeliverableCheckpoint>> {
    // Event ingestion locks this same run before updating its retained state.
    // Read the latest journal entry only after obtaining that lock, including
    // when a new checkpoint changes just the native index, not physical bytes.
    let source = sqlx::query(
        "SELECT run.workspace_run_id, run.workspace_base_commit, run.workspace_fingerprint,
                run.workspace_disposition, run.status, run.execution_mode,
                task.mission_id, mission.room_id
         FROM runs run
         JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
         JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=run.corp_id
         WHERE run.id=$1 AND run.corp_id=$2 FOR UPDATE OF run",
    )
    .bind(run_id)
    .bind(corp_id)
    .fetch_one(&mut **tx)
    .await?;
    let event = sqlx::query(
        "SELECT seq, type AS event_type, payload, room_id, correlation_id FROM events
         WHERE corp_id=$1 AND aggregate_id=$2 AND aggregate_type='run'
           AND type IN ('run.workspace_preserved','run.workspace_removed','run.teardown_uncertain')
         ORDER BY seq DESC LIMIT 1",
    )
    .bind(corp_id)
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(event) = event else { return Ok(None) };
    let payload: Value = event.get("payload");
    let Some(value) = payload
        .get("deliverable_checkpoint")
        .filter(|value| !value.is_null())
    else {
        // An older valid event is never substituted for the latest cleanup.
        return Ok(None);
    };
    let proof: PreservedDeliverableCheckpoint = serde_json::from_value(value.clone())
        .context("invalid preserved deliverable checkpoint")?;
    if event.get::<String, _>("event_type") != "run.workspace_preserved"
        || !proof.is_valid()
        || proof.run_id != run_id
        || proof.workspace_run_id != source.get::<Uuid, _>("workspace_run_id")
        || Some(proof.workspace_base_commit.as_str())
            != source
                .get::<Option<String>, _>("workspace_base_commit")
                .as_deref()
        || Some(proof.workspace_fingerprint.as_str())
            != source
                .get::<Option<String>, _>("workspace_fingerprint")
                .as_deref()
        || payload.get("workspace_fingerprint").and_then(Value::as_str)
            != Some(proof.workspace_fingerprint.as_str())
        || payload.get("head_commit").and_then(Value::as_str) != Some(proof.head_commit.as_str())
        || payload
            .get("workspace_quarantined")
            .and_then(Value::as_bool)
            != Some(false)
        || source
            .get::<Option<String>, _>("workspace_disposition")
            .as_deref()
            != Some("preserved")
        || !matches!(
            source.get::<String, _>("status").as_str(),
            "failed" | "cancelled" | "lost" | "completed"
        ) && !(source.get::<String, _>("status") == "waiting_for_approval"
            && source.get::<String, _>("execution_mode") == "verification_only"
            && checkpoint_retention::review_ready_tx(tx, corp_id, run_id).await?)
        || event.get::<Option<Uuid>, _>("room_id") != Some(source.get("room_id"))
        || event.get::<Option<Uuid>, _>("correlation_id") != Some(source.get("mission_id"))
    {
        return Err(native_policy!(
            "preserved deliverable checkpoint is not bound to the latest trusted source. {RECOVERY}"
        ));
    }
    if source.get::<String, _>("execution_mode") == "provider" {
        let stopped = sqlx::query(
            "SELECT seq, type AS event_type, payload, room_id, correlation_id FROM events
             WHERE corp_id=$1 AND aggregate_id=$2 AND aggregate_type='run'
               AND type IN ('run.session_terminated','run.teardown_uncertain')
             ORDER BY seq DESC LIMIT 1",
        )
        .bind(corp_id)
        .bind(run_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| {
            native_policy!("preserved source has no proven provider termination. {RECOVERY}")
        })?;
        let termination: Value = stopped.get("payload");
        if stopped.get::<String, _>("event_type") != "run.session_terminated"
            || stopped.get::<i64, _>("seq") >= event.get::<i64, _>("seq")
            || termination
                .get("provider_process_alive")
                .and_then(Value::as_bool)
                != Some(false)
            || !matches!(
                termination.get("outcome").and_then(Value::as_str),
                Some("completed" | "failed" | "cancelled")
            )
            || stopped.get::<Option<Uuid>, _>("room_id") != Some(source.get("room_id"))
            || stopped.get::<Option<Uuid>, _>("correlation_id") != Some(source.get("mission_id"))
        {
            return Err(native_policy!(
                "preserved deliverable source is not quiescent. {RECOVERY}"
            ));
        }
    } else if source.get::<String, _>("execution_mode") != "verification_only" {
        return Err(native_policy!(
            "unknown execution mode for preserved deliverable source"
        ));
    }
    ensure_scope(&proof, contract)?;
    Ok(Some(proof))
}

pub(super) async fn ensure_narrowing_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    run_id: Uuid,
    current: &TaskContract,
    replacement: &TaskContract,
) -> Result<()> {
    let narrowed = current.write_scope.iter().any(|scope| {
        !replacement
            .write_scope
            .iter()
            .any(|allowed| write_scope_is_subset(scope, allowed))
    });
    if narrowed && current.deliverable.is_some() {
        let proof = checkpoint_tx(tx, corp_id, run_id, current).await?
            .ok_or_else(|| native_policy!("narrowing requires a complete runner checkpoint of retained deliverable paths and artifact exclusions. {RECOVERY}"))?;
        ensure_scope(&proof, replacement)?;
    }
    Ok(())
}
