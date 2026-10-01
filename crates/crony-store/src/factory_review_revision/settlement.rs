//! Adopt only an independently reviewed native result; abandonment preserves
//! both the accepted publication and every correction artifact and workspace.
use super::*;

pub(super) async fn validate_review_tx(
    tx: &mut Transaction<'_, Postgres>,
    record: &RevisionRecord,
    run: Uuid,
) -> Result<Uuid> {
    let r = &record.revision;
    let row = sqlx::query(
        "SELECT review.status,review.gate,review.decision_key,review.decided_by,
           mission.requested_by,mission.room_id,producer.actor_id AS producer
         FROM verification_requests review
         JOIN runs run ON run.id=review.run_id AND run.corp_id=review.corp_id
         JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
         JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=run.corp_id
         JOIN agents producer ON producer.id=run.agent_id AND producer.corp_id=run.corp_id
         WHERE review.corp_id=$1 AND review.run_id=$2 AND task.id=$3 AND mission.id=$4
         FOR UPDATE OF review",
    )
    .bind(r.corp_id)
    .bind(run)
    .bind(r.task_id)
    .bind(r.mission_id)
    .fetch_optional(&mut **tx)
    .await?
    .context("correction requires a fresh independent review")?;
    let actor: Uuid = row
        .get::<Option<Uuid>, _>("decided_by")
        .context("reviewer missing")?;
    let decision: Uuid = row
        .get::<Option<Uuid>, _>("decision_key")
        .context("review decision missing")?;
    let reviewer = sqlx::query("SELECT kind,role FROM actors WHERE corp_id=$1 AND id=$2 FOR SHARE")
        .bind(r.corp_id)
        .bind(actor)
        .fetch_optional(&mut **tx)
        .await?
        .context("reviewer no longer exists")?;
    assert_room_membership_tx(tx, r.corp_id, row.get("room_id"), actor).await?;
    validate_reviewer_tx(tx, r.corp_id, run, actor, Some(decision)).await?;
    let roles = record
        .replacement_verification_policy
        .pointer("/manual_gate/roles")
        .and_then(Value::as_array)
        .context("saved independent review roles missing")?;
    ensure!(
        row.get::<&str, _>("status") == "approved"
            && row.get::<Value, _>("gate") == record.replacement_verification_policy["manual_gate"]
            && actor != r.authorized_by
            && actor != row.get::<Uuid, _>("requested_by")
            && actor != row.get::<Uuid, _>("producer")
            && !decision.is_nil()
            && reviewer.get::<&str, _>("kind") == "human"
            && roles
                .iter()
                .any(|role| role.as_str() == Some(reviewer.get::<&str, _>("role")))
            && r.review_decision_id.is_none_or(|saved| saved == decision),
        "correction requires a current authorized independent decision on the replacement run"
    );
    Ok(decision)
}

impl PgStore {
    pub async fn settle_factory_review_revision(
        &self,
        corp: Uuid,
        item: Uuid,
        revision: Uuid,
        input: SettleFactoryReviewRevision,
        adopt: bool,
    ) -> Result<FactoryReviewRevisionResponse> {
        normalize_factory_text(&input.reason, "revision settlement reason", 4_000)?;
        normalize_factory_text(
            &input.observed_source_revision,
            "observed source revision",
            200,
        )?;
        ensure!(
            input.expected_version > 0 && !input.idempotency_key.is_nil(),
            "invalid settlement version or key"
        );
        let mission: Uuid = sqlx::query_scalar(
            "SELECT source_mission_id FROM factory_review_revisions WHERE corp_id=$1 AND factory_work_item_id=$2 AND id=$3",
        ).bind(corp).bind(item).bind(revision).fetch_optional(&self.pool).await?.context("revision not found")?;
        let action = if adopt {
            "review_revision_adopt"
        } else {
            "review_revision_abandon"
        };
        let request = json!({"revision_id":revision,"action":action,"input":input});
        let op = state_audit::Operation {
            corp,
            actor: input.actor_id,
            mission,
            request_id: input.idempotency_key,
            name: action,
            request: request.clone(),
        };
        self.audited(op, move |outer| Box::pin(async move {
            let mut tx = outer.begin().await?;
            // audited() holds the ledger, then Corp, before native item/run locks.
            let (mut work_item, _) = factory_work_item_tx(&mut tx, corp, item, true).await?.context("factory item missing")?;
            let record = record_tx(&mut tx, corp, revision).await?;
            let r = &record.revision;
            ensure!(r.factory_work_item_id == item, "revision belongs to another item");
            ensure_factory_recovery_authorizer_tx(&mut tx, corp, mission, input.actor_id).await?;
            if r.state != "pending" {
                ensure!(r.settlement_key == Some(input.idempotency_key) && r.settled_by == Some(input.actor_id)
                    && record.settlement_request.as_ref() == Some(&request),
                    "revision settlement is terminal; retries must match the original request");
                tx.commit().await?;
                return Ok(FactoryReviewRevisionResponse { revision:record.revision, work_item, events:vec![], replayed:true });
            }
            ensure!(work_item.version == input.expected_version
                && work_item.state == FactoryWorkItemState::ReviewRevision
                && work_item.mission_id == Some(mission) && work_item.policy == record.source_policy,
                "revision lost its current version or original Factory selection");
            let result = if adopt {
                ensure!(input.observed_source_revision == record.observed_source_revision,
                    "issue revision changed; correction cannot be adopted");
                PgStore::ensure_audit_workflow_gates_tx(&mut tx, corp).await?;
                validate_contracts_tx(&mut tx, &record).await?;
                validate_source_tx(&mut tx, &work_item, &record).await?;
                let mut source_item = work_item.clone();
                source_item.mission_id = Some(r.source_mission_id);
                validate_publication_lineage_tx(&mut tx, &source_item, r.source_run_id).await?;
                let candidates = sqlx::query(
                    "SELECT d.id,d.run_id FROM source_deliverables d JOIN runs run
                       ON run.id=d.run_id AND run.corp_id=d.corp_id AND run.task_id=d.task_id
                     WHERE d.corp_id=$1 AND d.task_id=$2 AND run.status='completed' AND run.verification_status='passed'
                     ORDER BY d.id LIMIT 2",
                ).bind(corp).bind(r.task_id).fetch_all(&mut *tx).await?;
                ensure!(candidates.len() == 1, "correction requires one exact completed replacement deliverable");
                let run: Uuid = candidates[0].get("run_id");
                let deliverable: Uuid = candidates[0].get("id");
                let review = validate_review_tx(&mut tx, &record, run).await?;
                let mut candidate = work_item.clone();
                candidate.mission_id = Some(r.mission_id);
                candidate.state = FactoryWorkItemState::Verified;
                let checked = publication::validate_refresh_source_tx(&mut tx, candidate, deliverable).await?;
                ensure!(checked.run_id == run && checked.effective_source_revision == record.observed_source_revision
                    && checked.source_recovery_id == record.source_recovery_id
                    && checked.commit_sha != r.source_head_commit,
                    "replacement must be a newly verified correction of the exact published source");
                Some((run, deliverable, checked.commit_sha, review))
            } else {
                let statuses: Vec<String> = sqlx::query_scalar("SELECT status FROM runs WHERE corp_id=$1 AND task_id=$2 FOR UPDATE")
                    .bind(corp).bind(r.task_id).fetch_all(&mut *tx).await?;
                ensure!(statuses.iter().all(|status| matches!(status.as_str(), "completed"|"failed"|"cancelled"|"lost"|"verification_failed")),
                    "stop active correction runs through durable cancellation before abandonment");
                // Never rewrite a terminal accepted result. A never-started or
                // retry-ready correction is cancelled so it cannot keep scheduling.
                sqlx::query("UPDATE tasks SET status='cancelled',updated_at=now() WHERE corp_id=$1 AND id=$2 AND status IN ('pending','ready','blocked')")
                    .bind(corp).bind(r.task_id).execute(&mut *tx).await?;
                sqlx::query("UPDATE missions SET status='cancelled',updated_at=now() WHERE corp_id=$1 AND id=$2 AND status IN ('ready','running','blocked')")
                    .bind(corp).bind(r.mission_id).execute(&mut *tx).await?;
                None
            };
            sqlx::query("UPDATE factory_review_revisions SET state=$3,result_run_id=$4,result_deliverable_id=$5,
                result_commit=$6,review_decision_id=$7,settled_by=$8,settlement_key=$9,settlement_request=$10,updated_at=now()
                WHERE corp_id=$1 AND id=$2")
                .bind(corp).bind(revision).bind(if adopt { "adopted" } else { "abandoned" })
                .bind(result.as_ref().map(|r|r.0)).bind(result.as_ref().map(|r|r.1))
                .bind(result.as_ref().map(|r|r.2.as_str())).bind(result.as_ref().map(|r|r.3))
                .bind(input.actor_id).bind(input.idempotency_key).bind(&request).execute(&mut *tx).await?;
            sqlx::query("UPDATE factory_work_items SET state=$3,mission_id=$4,version=version+1,updated_at=now() WHERE corp_id=$1 AND id=$2")
                .bind(corp).bind(item).bind(if adopt { "verified" } else { "published" })
                .bind(if adopt { r.mission_id } else { r.source_mission_id }).execute(&mut *tx).await?;
            work_item = factory_work_item_tx(&mut tx, corp, item, false).await?.context("factory item missing")?.0;
            let revision = record_tx(&mut tx, corp, revision).await?.revision;
            state_audit::review_revision_secondary_tx(&mut tx, &revision, input.actor_id, action, input.idempotency_key).await?;
            let events = revision_event_tx(&mut tx, &revision, input.actor_id, action).await?;
            tx.commit().await?;
            Ok(FactoryReviewRevisionResponse { revision, work_item, events, replayed:false })
        })).await
    }
}
