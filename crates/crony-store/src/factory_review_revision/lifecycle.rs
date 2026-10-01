//! Guards for ordinary native dispatch, review and publication of corrections.
use super::*;

pub(crate) async fn ensure_mutable_mission_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    mission: Uuid,
) -> Result<()> {
    ensure!(!sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM factory_review_revisions WHERE corp_id=$1 AND (source_mission_id=$2 OR mission_id=$2))",
    ).bind(corp).bind(mission).fetch_one(&mut **tx).await?,
        "published review lineage has immutable source, budget and verifier authority");
    Ok(())
}

pub(super) async fn for_task_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    task: Uuid,
) -> Result<Option<RevisionRecord>> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM factory_review_revisions WHERE corp_id=$1 AND task_id=$2",
    )
    .bind(corp)
    .bind(task)
    .fetch_optional(&mut **tx)
    .await?;
    match id {
        Some(id) => Ok(Some(record_tx(tx, corp, id).await?)),
        None => Ok(None),
    }
}

pub(super) async fn pending_selection_tx(
    tx: &mut Transaction<'_, Postgres>,
    record: &RevisionRecord,
) -> Result<()> {
    let r = &record.revision;
    let (item, _) = factory_work_item_tx(tx, r.corp_id, r.factory_work_item_id, false)
        .await?
        .context("review revision Factory item missing")?;
    ensure!(
        r.state == "pending"
            && item.state == FactoryWorkItemState::ReviewRevision
            && item.mission_id == Some(r.source_mission_id)
            && item.policy == record.source_policy,
        "correction lost its pending authorization or original Factory selection"
    );
    Ok(())
}

pub(crate) async fn validate_task_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    task: Uuid,
) -> Result<()> {
    if let Some(record) = for_task_tx(tx, corp, task).await? {
        pending_selection_tx(tx, &record).await?;
        validate_contracts_tx(tx, &record).await?;
    }
    Ok(())
}

/// Do not call publication validation here: publication checks this guard too.
/// Native state machines reject new events on terminal runs. Historical terminal
/// attempts remain readable after adoption, without granting another dispatch.
pub(crate) async fn validate_progress_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
) -> Result<()> {
    let row = sqlx::query("SELECT task_id,status FROM runs WHERE corp_id=$1 AND id=$2")
        .bind(corp)
        .bind(run)
        .fetch_one(&mut **tx)
        .await?;
    let Some(record) = for_task_tx(tx, corp, row.get("task_id")).await? else {
        return Ok(());
    };
    if record.revision.state == "pending" {
        pending_selection_tx(tx, &record).await?;
    } else {
        ensure!(
            record.revision.state == "adopted"
                && matches!(
                    row.get::<&str, _>("status"),
                    "completed" | "failed" | "cancelled" | "lost" | "verification_failed"
                ),
            "settled correction permits no further execution"
        );
        let selected: bool = sqlx::query_scalar(
            "WITH RECURSIVE lineage AS (
                SELECT r.id,r.source_mission_id,r.corp_id,r.factory_work_item_id,1 depth,ARRAY[r.id] visited
                FROM factory_review_revisions r JOIN factory_work_items i
                  ON i.corp_id=r.corp_id AND i.id=r.factory_work_item_id AND i.mission_id=r.mission_id
                WHERE r.corp_id=$1 AND i.id=$2 AND r.state='adopted' AND i.policy=r.source_policy
                UNION ALL
                SELECT r.id,r.source_mission_id,r.corp_id,r.factory_work_item_id,c.depth+1,c.visited||r.id
                FROM lineage c JOIN factory_review_revisions r ON r.corp_id=c.corp_id
                  AND r.factory_work_item_id=c.factory_work_item_id AND r.mission_id=c.source_mission_id
                WHERE r.state='adopted' AND c.depth<$4 AND NOT r.id=ANY(c.visited)
            ) SELECT EXISTS(SELECT 1 FROM lineage WHERE id=$3)",
        ).bind(corp).bind(record.revision.factory_work_item_id).bind(record.revision.id)
            .bind(MAX_REVIEW_REVISIONS as i32).fetch_one(&mut **tx).await?;
        ensure!(
            selected,
            "adopted correction is no longer in the selected publication lineage"
        );
    }
    validate_contracts_tx(tx, &record).await
}

pub(crate) async fn source_revision_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    item: Uuid,
    run: Uuid,
) -> Result<Option<(String, Option<Uuid>)>> {
    Ok(sqlx::query(
        "SELECT r.observed_source_revision,r.source_recovery_id FROM factory_review_revisions r
         JOIN runs run ON run.corp_id=r.corp_id AND run.task_id=r.task_id
         WHERE r.corp_id=$1 AND r.factory_work_item_id=$2 AND run.id=$3 AND r.state IN ('pending','adopted')",
    ).bind(corp).bind(item).bind(run).fetch_optional(&mut **tx).await?
        .map(|row|(row.get("observed_source_revision"), row.get("source_recovery_id"))))
}

pub(crate) async fn successor_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    item: Uuid,
    mission: Uuid,
) -> Result<Option<FactoryReviewRevision>> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM factory_review_revisions WHERE corp_id=$1 AND factory_work_item_id=$2 AND mission_id=$3",
    ).bind(corp).bind(item).bind(mission).fetch_optional(&mut **tx).await?;
    match id {
        Some(id) => {
            let record = record_tx(tx, corp, id).await?;
            ensure!(
                record.revision.state == "adopted",
                "publication requires an adopted correction"
            );
            Ok(Some(record.revision))
        }
        None => Ok(None),
    }
}

pub(crate) async fn validate_publication_lineage_tx(
    tx: &mut Transaction<'_, Postgres>,
    item: &FactoryWorkItem,
    run: Uuid,
) -> Result<()> {
    let mut selected = item.clone();
    let mut cursor = run;
    let mut visited = HashSet::new();
    loop {
        let task: Uuid = sqlx::query_scalar("SELECT task_id FROM runs WHERE corp_id=$1 AND id=$2")
            .bind(item.corp_id)
            .bind(cursor)
            .fetch_one(&mut **tx)
            .await?;
        let Some(record) = for_task_tx(tx, item.corp_id, task).await? else {
            break;
        };
        let r = &record.revision;
        ensure!(
            visited.insert(r.id) && visited.len() <= MAX_REVIEW_REVISIONS,
            "invalid or unbounded correction lineage"
        );
        ensure!(
            r.state == "adopted"
                && r.factory_work_item_id == item.id
                && selected.mission_id == Some(r.mission_id)
                && selected.policy == record.source_policy
                && r.result_run_id == Some(cursor),
            "publication lost its adopted correction lineage"
        );
        validate_contracts_tx(tx, &record).await?;
        validate_review_tx(tx, &record, cursor).await?;
        validate_source_tx(tx, &selected, &record).await?;
        selected.mission_id = Some(r.source_mission_id);
        selected.state = FactoryWorkItemState::Published;
        cursor = r.source_run_id;
    }
    factory_base_refresh::validate_adopted_lineage_tx(tx, &selected, cursor).await
}

/// A fresh decision cannot come from a correction authorizer, an ancestor's
/// requester or producer, or reuse an ancestor's decision. Traverse both native
/// correction and verification-only refresh links, with one bounded cycle guard.
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
            "SELECT link.id,link.authorized_by,link.source_run_id,mission.requested_by,producer.actor_id,review.decision_key
             FROM (
                SELECT r.id,r.authorized_by,r.source_run_id,r.source_mission_id FROM factory_review_revisions r
                JOIN runs run ON run.corp_id=r.corp_id AND run.task_id=r.task_id WHERE r.corp_id=$1 AND run.id=$2
                UNION ALL
                SELECT id,authorized_by,source_run_id,source_mission_id FROM factory_base_refreshes WHERE corp_id=$1 AND run_id=$2
             ) link
             JOIN missions mission ON mission.id=link.source_mission_id AND mission.corp_id=$1
             JOIN runs source ON source.id=link.source_run_id AND source.corp_id=$1
             JOIN agents producer ON producer.id=source.agent_id AND producer.corp_id=$1
             LEFT JOIN verification_requests review ON review.run_id=source.id AND review.corp_id=$1",
        ).bind(corp).bind(cursor).fetch_optional(&mut **tx).await?;
        let Some(row) = row else { break };
        ensure!(
            visited.insert(row.get::<Uuid, _>("id")) && visited.len() <= 16,
            "review ancestry is cyclic or unbounded"
        );
        ensure!(
            key.is_some_and(|key| !key.is_nil())
                && key != row.get::<Option<Uuid>, _>("decision_key"),
            "correction requires a fresh durable review decision"
        );
        ensure!(
            actor != row.get::<Uuid, _>("authorized_by")
                && actor != row.get::<Uuid, _>("requested_by")
                && actor != row.get::<Uuid, _>("actor_id"),
            "reviewer must be independent of correction authorization and all original producers"
        );
        cursor = row.get("source_run_id");
    }
    Ok(())
}
