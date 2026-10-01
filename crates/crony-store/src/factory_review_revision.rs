//! Published corrections are separate native missions. This module supplies
//! immutable lineage and residual authority, not a second execution engine.
use super::*;
use anyhow::ensure;
use crony_domain::{
    AuthorizeFactoryReviewRevision, FactoryReviewRevision, FactoryReviewRevisionResponse,
    MAX_REVIEW_REVISIONS, PlannedAgent, PlannedTask, RevisionAllocation,
    SettleFactoryReviewRevision, base_refresh_policy, review_revision_allocation,
    validate_review_findings,
};

mod dispatch;
mod lifecycle;
mod settlement;
pub use dispatch::ReviewRevisionDispatch;
pub(super) use dispatch::checkpoint_tx;
pub(super) use dispatch::dispatch_tx;
pub(super) use lifecycle::{
    ensure_mutable_mission_tx, source_revision_tx, successor_tx, validate_progress_tx,
    validate_publication_lineage_tx, validate_reviewer_tx, validate_task_tx,
};
use settlement::validate_review_tx;

#[derive(Deserialize)]
struct RevisionRecord {
    #[serde(flatten)]
    revision: FactoryReviewRevision,
    request: Value,
    source_policy: Value,
    source_contract: Value,
    source_verification_policy: Value,
    source_mission_authority: Value,
    source_attempts: i32,
    source_required_adapter: String,
    replacement_contract: Value,
    replacement_verification_policy: Value,
    replacement_attempts: i32,
    observed_source_revision: String,
    source_recovery_id: Option<Uuid>,
    settlement_request: Option<Value>,
}

async fn record_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    id: Uuid,
) -> Result<RevisionRecord> {
    let value: Value = sqlx::query_scalar(
        "SELECT to_jsonb(r) FROM factory_review_revisions r WHERE corp_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(corp)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .context("review revision not found in Corp")?;
    serde_json::from_value(value).context("decode review revision authority")
}

async fn source_publication_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    id: Uuid,
) -> Result<PullRequestPublication> {
    let (publication, _) = publication::publication_by_id_tx(tx, corp, id, true)
        .await?
        .context("published source not found in Corp")?;
    ensure!(
        publication.state == PullRequestPublicationState::Published
            && publication.pull_request_head_sha.as_deref()
                == Some(publication.commit_sha.as_str())
            && publication.pull_request_number.is_some(),
        "review revision requires an exact completed publication"
    );
    Ok(publication)
}

/// Verification-only base refreshes carry source authority but do not replenish
/// provider budgets or consume a correction attempt. Resolve their original task.
async fn remaining_allocation_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    run: Uuid,
) -> Result<RevisionAllocation> {
    let mut cursor = run;
    let mut visited = HashSet::new();
    loop {
        ensure!(
            visited.insert(cursor) && visited.len() <= 16,
            "invalid correction budget lineage"
        );
        let parent: Option<Uuid> = sqlx::query_scalar(
            "SELECT source_run_id FROM factory_base_refreshes WHERE corp_id=$1 AND run_id=$2 AND state='adopted'",
        ).bind(corp).bind(cursor).fetch_optional(&mut **tx).await?;
        if let Some(parent) = parent {
            cursor = parent;
            continue;
        }
        let row = sqlx::query(
            "SELECT task.id,task.mission_id,task.contract,task.max_attempts,task.attempt_count,
            mission.budget_tokens,mission.budget_cost_microusd FROM runs run
            JOIN tasks task ON task.id=run.task_id AND task.corp_id=run.corp_id
            JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=run.corp_id
            WHERE run.corp_id=$1 AND run.id=$2 FOR SHARE OF task,mission",
        )
        .bind(corp)
        .bind(cursor)
        .fetch_one(&mut **tx)
        .await?;
        let contract: TaskContract = serde_json::from_value(row.get("contract"))?;
        let usage = sqlx::query(
            "SELECT COALESCE(SUM(input_tokens+output_tokens),0)::BIGINT tokens,
            COALESCE(SUM(cost_microusd),0)::BIGINT cost FROM runs WHERE corp_id=$1 AND task_id=$2",
        )
        .bind(corp)
        .bind(row.get::<Uuid, _>("id"))
        .fetch_one(&mut **tx)
        .await?;
        let mission = budget_revision::mission_usage_tx(tx, corp, row.get("mission_id")).await?;
        return review_revision_allocation(
            (
                contract.budget_tokens.saturating_sub(usage.get("tokens")),
                contract
                    .budget_cost_microusd
                    .saturating_sub(usage.get("cost")),
            ),
            (
                row.get::<i64, _>("budget_tokens").saturating_sub(mission.0),
                row.get::<i64, _>("budget_cost_microusd")
                    .saturating_sub(mission.1),
            ),
            row.get::<i32, _>("max_attempts")
                .saturating_sub(row.get("attempt_count")),
        )
        .map_err(|error| anyhow!(error));
    }
}

async fn mission_authority_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    mission: Uuid,
) -> Result<Value> {
    sqlx::query_scalar("SELECT jsonb_build_object('requested_by',requested_by,'room_id',room_id,
        'budget_tokens',budget_tokens,'budget_cost_microusd',budget_cost_microusd,
        'specification_version',specification_version,'status',status) FROM missions WHERE corp_id=$1 AND id=$2 FOR SHARE")
        .bind(corp).bind(mission).fetch_one(&mut **tx).await.map_err(Into::into)
}

async fn validate_contracts_tx(
    tx: &mut Transaction<'_, Postgres>,
    record: &RevisionRecord,
) -> Result<()> {
    let r = &record.revision;
    for (task, mission, contract, policy, attempts) in [
        (
            r.source_task_id,
            r.source_mission_id,
            &record.source_contract,
            &record.source_verification_policy,
            record.source_attempts,
        ),
        (
            r.task_id,
            r.mission_id,
            &record.replacement_contract,
            &record.replacement_verification_policy,
            record.replacement_attempts,
        ),
    ] {
        let row = sqlx::query(
            "SELECT contract,verification_policy,max_attempts,required_adapter FROM tasks
            WHERE corp_id=$1 AND id=$2 AND mission_id=$3 FOR SHARE",
        )
        .bind(r.corp_id)
        .bind(task)
        .bind(mission)
        .fetch_one(&mut **tx)
        .await?;
        ensure!(
            row.get::<Value, _>("contract") == *contract
                && row.get::<Value, _>("verification_policy") == *policy
                && row.get::<i32, _>("max_attempts") == attempts
                && row.get::<String, _>("required_adapter") == record.source_required_adapter,
            "review revision contract, verifier, adapter or attempts changed"
        );
    }
    ensure!(
        mission_authority_tx(tx, r.corp_id, r.source_mission_id).await?
            == record.source_mission_authority,
        "published source mission authority changed"
    );
    let replacement = mission_authority_tx(tx, r.corp_id, r.mission_id).await?;
    ensure!(
        replacement["requested_by"] == record.source_mission_authority["requested_by"]
            && replacement["room_id"] == record.source_mission_authority["room_id"]
            && replacement["budget_tokens"] == record.replacement_contract["budget_tokens"]
            && replacement["budget_cost_microusd"]
                == record.replacement_contract["budget_cost_microusd"]
            && replacement["specification_version"] == 1,
        "correction mission widened its immutable authority"
    );
    let allocation = remaining_allocation_tx(tx, r.corp_id, r.source_run_id).await?;
    ensure!(
        record.replacement_contract["budget_tokens"].as_i64() == Some(allocation.tokens)
            && record.replacement_contract["budget_cost_microusd"].as_i64()
                == Some(allocation.cost_microusd)
            && record.replacement_attempts == allocation.attempts,
        "source residual authority changed after revision admission"
    );
    let mut expected: TaskContract = serde_json::from_value(record.source_contract.clone())?;
    expected.budget_tokens = allocation.tokens;
    expected.budget_cost_microusd = allocation.cost_microusd;
    expected.objective =
        correction_objective(&expected.objective, &r.source_head_commit, &r.findings)?;
    let original: VerificationPolicy =
        serde_json::from_value(record.source_verification_policy.clone())?;
    ensure!(
        serde_json::to_value(expected)? == record.replacement_contract
            && serde_json::to_value(base_refresh_policy(&original))?
                == record.replacement_verification_policy,
        "correction may only append findings, use residual authority and strengthen independent review"
    );
    Ok(())
}

fn correction_objective(
    objective: &str,
    head: &str,
    findings: &[crony_domain::ReviewFinding],
) -> Result<String> {
    Ok(format!(
        "{objective}\n\nCorrect the authenticated review findings for published commit {head}:\n{}",
        serde_json::to_string(findings)?
    ))
}

async fn validate_source_tx(
    tx: &mut Transaction<'_, Postgres>,
    item: &FactoryWorkItem,
    record: &RevisionRecord,
) -> Result<publication::PublicationPrerequisites> {
    let r = &record.revision;
    let publication = source_publication_tx(tx, r.corp_id, r.publication_id).await?;
    ensure!(
        publication.factory_work_item_id == item.id
            && publication.mission_id == r.source_mission_id
            && publication.task_id == r.source_task_id
            && publication.run_id == r.source_run_id
            && publication.source_deliverable_id == r.source_deliverable_id
            && publication.commit_sha == r.source_head_commit,
        "review revision lost its exact published source"
    );
    let mut historical = item.clone();
    historical.mission_id = Some(r.source_mission_id);
    historical.policy = record.source_policy.clone();
    let source = publication::validate_published_source_tx(tx, historical, &publication).await?;
    ensure!(
        source.effective_source_revision == record.observed_source_revision
            && source.source_recovery_id == record.source_recovery_id,
        "published issue or recovery authority changed"
    );
    Ok(source)
}

impl PgStore {
    pub async fn factory_review_revisions(
        &self,
        corp: Uuid,
        actor: Uuid,
        item: Uuid,
    ) -> Result<Vec<FactoryReviewRevision>> {
        Ok(self
            .factory_publication_context(corp, actor, item)
            .await?
            .context("Factory review history is unavailable to this operator")?
            .review_revisions)
    }

    pub async fn authorize_factory_review_revision(
        &self,
        corp: Uuid,
        item: Uuid,
        input: AuthorizeFactoryReviewRevision,
    ) -> Result<FactoryReviewRevisionResponse> {
        validate_review_findings(&input.findings).map_err(|error| anyhow!(error))?;
        validate_factory_base_commit(&input.published_head_commit)?;
        normalize_factory_text(
            &input.observed_source_revision,
            "observed source revision",
            200,
        )?;
        ensure!(
            input.expected_version > 0 && !input.idempotency_key.is_nil(),
            "invalid revision version or key"
        );
        let mission:Uuid=sqlx::query_scalar("SELECT mission_id FROM pull_request_publications WHERE corp_id=$1 AND factory_work_item_id=$2 AND id=$3")
            .bind(corp).bind(item).bind(input.publication_id).fetch_optional(&self.pool).await?.context("source publication not found")?;
        let op = state_audit::Operation {
            corp,
            actor: input.actor_id,
            mission,
            request_id: input.idempotency_key,
            name: "review_revision_authorize",
            request: json!({"work_item_id":item,"input":input}),
        };
        self.audited(op, move |outer| {
            Box::pin(async move {
                let mut tx = outer.begin().await?;
                let result = authorize_tx(&mut tx, corp, item, &input).await?;
                tx.commit().await?;
                Ok(result)
            })
        })
        .await
    }
}

async fn authorize_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    item: Uuid,
    input: &AuthorizeFactoryReviewRevision,
) -> Result<FactoryReviewRevisionResponse> {
    let (work_item, _) = factory_work_item_tx(tx, corp, item, true)
        .await?
        .context("factory item missing")?;
    let publication = source_publication_tx(tx, corp, input.publication_id).await?;
    ensure!(
        publication.factory_work_item_id == item,
        "publication belongs to another Factory item"
    );
    ensure_factory_recovery_authorizer_tx(tx, corp, publication.mission_id, input.actor_id).await?;
    let request = serde_json::to_value(input)?;
    let prior:Option<Uuid>=sqlx::query_scalar("SELECT id FROM factory_review_revisions WHERE corp_id=$1 AND authorized_by=$2 AND idempotency_key=$3")
        .bind(corp).bind(input.actor_id).bind(input.idempotency_key).fetch_optional(&mut **tx).await?;
    if let Some(id) = prior {
        let record = record_tx(tx, corp, id).await?;
        ensure!(
            record.revision.factory_work_item_id == item && record.request == request,
            "revision idempotency key reused with different input"
        );
        return Ok(FactoryReviewRevisionResponse {
            revision: record.revision,
            work_item,
            events: vec![],
            replayed: true,
        });
    }
    ensure!(
        work_item.state == FactoryWorkItemState::Published
            && work_item.version == input.expected_version
            && work_item.mission_id == Some(publication.mission_id)
            && publication.commit_sha == input.published_head_commit,
        "revision requires the current published selection, version and exact review head"
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM factory_review_revisions WHERE corp_id=$1 AND factory_work_item_id=$2")
        .bind(corp).bind(item).fetch_one(&mut **tx).await?;
    ensure!(
        count < MAX_REVIEW_REVISIONS as i64,
        "review revision chain limit reached"
    );
    ensure!(!sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM factory_review_revisions WHERE corp_id=$1 AND publication_id=$2)")
        .bind(corp).bind(publication.id).fetch_one(&mut **tx).await?,"publication already has a correction; resume that mission");
    factory_base_refresh::ensure_no_pending_tx(tx, corp, item).await?;
    PgStore::ensure_audit_workflow_gates_tx(tx, corp).await?;
    let source =
        publication::validate_published_source_tx(tx, work_item.clone(), &publication).await?;
    validate_publication_lineage_tx(tx, &work_item, source.run_id).await?;
    ensure!(
        source.effective_source_revision == input.observed_source_revision,
        "source issue changed since publication"
    );
    let row=sqlx::query("SELECT contract,verification_policy,max_attempts,required_adapter FROM tasks WHERE corp_id=$1 AND id=$2 FOR UPDATE")
        .bind(corp).bind(source.task_id).fetch_one(&mut **tx).await?;
    let source_contract: Value = row.get("contract");
    let mut contract: TaskContract = serde_json::from_value(source_contract.clone())?;
    let allocation = remaining_allocation_tx(tx, corp, source.run_id).await?;
    contract.budget_tokens = allocation.tokens;
    contract.budget_cost_microusd = allocation.cost_microusd;
    // The original objective and constraints remain binding. Findings are
    // additional correction instructions, never replacement scope or tools.
    contract.objective = correction_objective(
        &contract.objective,
        &publication.commit_sha,
        &input.findings,
    )?;
    let source_verifier: Value = row.get("verification_policy");
    let verifier = base_refresh_policy(&serde_json::from_value(source_verifier.clone())?);
    let adapter: String = row.get("required_adapter");
    let agent = Uuid::new_v4();
    let plan = TaskGraphPlan {
        strategy: "governed-review-revision".into(),
        max_nodes: 1,
        max_depth: 1,
        budget_tokens: allocation.tokens,
        budget_cost_microusd: allocation.cost_microusd,
        staffing: vec![PlannedAgent {
            id: agent,
            name: "Review correction".into(),
            role: "worker".into(),
            adapter: adapter.clone(),
            accent: "blue".into(),
        }],
        tasks: vec![PlannedTask {
            key: "review-revision".into(),
            title: "Correct published review findings".into(),
            contract: contract.clone(),
            assigned_agent_id: agent,
            required_adapter: adapter.clone(),
            depends_on: vec![],
            depth: 0,
            max_attempts: allocation.attempts,
            verification_policy: verifier.clone(),
        }],
    };
    let source_authority = mission_authority_tx(tx, corp, source.mission_id).await?;
    let requester = serde_json::from_value(source_authority["requested_by"].clone())?;
    let (created,mut events)=create_attributed_mission_in_room_tx(tx,corp,(requester,input.actor_id),
        &format!("Review revision for issue #{}",work_item.source_issue_number),
        &format!("Correct findings on publication {} at {}. Preserve the accepted result and all original constraints.\n{}",publication.id,publication.commit_sha,serde_json::to_string(&input.findings)?),
        &plan,source.room_id).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO factory_review_revisions(id,corp_id,factory_work_item_id,publication_id,
        source_mission_id,source_task_id,source_run_id,source_deliverable_id,source_head_commit,mission_id,task_id,
        authorized_by,idempotency_key,request,findings,source_policy,source_contract,source_verification_policy,
        source_mission_authority,source_attempts,replacement_contract,replacement_verification_policy,replacement_attempts,
        observed_source_revision,source_recovery_id,source_required_adapter)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)")
        .bind(id).bind(corp).bind(item).bind(publication.id).bind(source.mission_id).bind(source.task_id).bind(source.run_id)
        .bind(publication.source_deliverable_id).bind(&publication.commit_sha).bind(created.mission_id).bind(created.task_ids[0])
        .bind(input.actor_id).bind(input.idempotency_key).bind(request).bind(json!(input.findings)).bind(&work_item.policy)
        .bind(source_contract).bind(source_verifier).bind(source_authority).bind(row.get::<i32,_>("max_attempts"))
        .bind(serde_json::to_value(&contract)?).bind(serde_json::to_value(verifier)?).bind(allocation.attempts)
        .bind(&input.observed_source_revision).bind(source.source_recovery_id).bind(adapter).execute(&mut **tx).await?;
    sqlx::query("UPDATE factory_work_items SET state='review_revision',version=version+1,updated_at=now() WHERE corp_id=$1 AND id=$2")
        .bind(corp).bind(item).execute(&mut **tx).await?;
    let revision = record_tx(tx, corp, id).await?.revision;
    state_audit::review_revision_secondary_tx(
        tx,
        &revision,
        input.actor_id,
        "review_revision_authorize",
        input.idempotency_key,
    )
    .await?;
    events.extend(
        revision_event_tx(tx, &revision, input.actor_id, "review_revision_authorize").await?,
    );
    let work_item = factory_work_item_tx(tx, corp, item, false)
        .await?
        .context("factory item missing")?
        .0;
    Ok(FactoryReviewRevisionResponse {
        revision,
        work_item,
        events,
        replayed: false,
    })
}

async fn revision_event_tx(
    tx: &mut Transaction<'_, Postgres>,
    revision: &FactoryReviewRevision,
    actor: Uuid,
    action: &str,
) -> Result<Vec<DomainEvent>> {
    let room: Uuid = sqlx::query_scalar("SELECT room_id FROM missions WHERE corp_id=$1 AND id=$2")
        .bind(revision.corp_id)
        .bind(revision.source_mission_id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(append_event_tx(
        tx,
        NewEvent {
            room_id: Some(room),
            correlation_id: Some(revision.mission_id),
            causation_id: Some(revision.source_run_id),
            ..NewEvent::new(
                revision.corp_id,
                Some(actor),
                format!("factory.{action}"),
                "factory_review_revision",
                revision.id,
                format!("review-revision:{}:{action}", revision.id),
                json!({"revision":revision}),
            )
        },
    )
    .await?
    .into_iter()
    .collect())
}
