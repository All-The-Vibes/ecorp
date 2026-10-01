//! A base refresh verifies a saved source delta in a new mission. The original
//! Factory selection remains authoritative until an explicit reviewed adoption.
use super::*;
use anyhow::ensure;
use crony_domain::{
    AuthorizeFactoryBaseRefresh, FactoryBaseRefresh, FactoryBaseRefreshResponse,
    MAX_BASE_REFRESH_ATTEMPTS, PlannedAgent, PlannedTask, SettleFactoryBaseRefresh,
    base_refresh_policy,
};

mod dispatch;
mod lifecycle;
pub(super) use lifecycle::{
    adopted_source_contains_run_tx, checkpoint_tx, inherited_provider_artifact_tx, review_ready_tx,
    validate_progress_tx, validate_reviewer_tx, zero_provider_allocation_tx,
};

#[derive(Deserialize)]
struct RefreshRecord {
    #[serde(flatten)]
    refresh: FactoryBaseRefresh,
    request: Value,
    source_policy: Value,
    source_contract: Value,
    source_verification_policy: Value,
    refreshed_contract: Value,
    refreshed_verification_policy: Value,
    observed_source_revision: String,
    source_recovery_id: Option<Uuid>,
    command_id: Uuid,
    command_payload: Value,
    settlement_request: Option<Value>,
}

async fn record_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    id: Uuid,
) -> Result<RefreshRecord> {
    let value: Value = sqlx::query_scalar(
        "SELECT to_jsonb(r) FROM factory_base_refreshes r WHERE corp_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(corp)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .context("base refresh not found in Corp")?;
    serde_json::from_value(value).context("decode base refresh authority")
}

pub(super) async fn ensure_no_pending_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    item: Uuid,
) -> Result<()> {
    ensure!(!sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM factory_base_refreshes WHERE corp_id=$1 AND factory_work_item_id=$2 AND state='pending')",
    ).bind(corp).bind(item).fetch_one(&mut **tx).await?,
        "publication is fenced while a base refresh awaits adoption or abandonment");
    Ok(())
}

async fn ensure_unpublished_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    item: Uuid,
) -> Result<()> {
    ensure!(!sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM pull_request_publications WHERE corp_id=$1 AND factory_work_item_id=$2)",
    ).bind(corp).bind(item).fetch_one(&mut **tx).await?,
        "base refresh cannot replace a publication that has already started");
    Ok(())
}

pub(super) async fn ensure_ordinary_mission_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    mission: Uuid,
) -> Result<()> {
    ensure!(!sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM factory_base_refreshes WHERE corp_id=$1 AND mission_id=$2)",
    ).bind(corp).bind(mission).fetch_one(&mut **tx).await?,
        "a base-refresh mission permits only its immutable verification assignment");
    Ok(())
}

pub(super) async fn source_revision_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    item: Uuid,
    run: Uuid,
) -> Result<Option<(String, Option<Uuid>)>> {
    Ok(sqlx::query(
        "SELECT observed_source_revision,source_recovery_id FROM factory_base_refreshes WHERE corp_id=$1 AND factory_work_item_id=$2 AND run_id=$3 AND state IN ('pending','adopted')",
    ).bind(corp).bind(item).bind(run).fetch_optional(&mut **tx).await?
        .map(|row| (row.get("observed_source_revision"), row.get("source_recovery_id"))))
}

/// Revalidate every original source, including checkpoint/breaker authority,
/// through the same publication rules. There is no generic lineage bypass.
pub(super) async fn validate_adopted_lineage_tx(
    tx: &mut Transaction<'_, Postgres>,
    item: &FactoryWorkItem,
    run: Uuid,
) -> Result<()> {
    let mut cursor = run;
    let mut selected = item.clone();
    let mut visited = HashSet::new();
    loop {
        let id: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM factory_base_refreshes WHERE corp_id=$1 AND factory_work_item_id=$2 AND run_id=$3",
        ).bind(item.corp_id).bind(item.id).bind(cursor).fetch_optional(&mut **tx).await?;
        let Some(id) = id else {
            break;
        };
        ensure!(
            visited.insert(id) && visited.len() <= MAX_BASE_REFRESH_ATTEMPTS as usize,
            "invalid or unbounded refresh lineage"
        );
        let record = record_tx(tx, item.corp_id, id).await?;
        ensure!(
            record.refresh.state == "adopted"
                && selected.mission_id == Some(record.refresh.mission_id)
                && selected.policy == refreshed_policy(&record),
            "selected refresh lineage is not an adopted immutable authority"
        );
        validate_contracts_tx(tx, &record).await?;
        validate_review_tx(tx, &record).await?;
        selected.policy = record.source_policy.clone();
        selected.mission_id = Some(record.refresh.source_mission_id);
        selected.state = FactoryWorkItemState::Verified;
        let source = publication::validate_refresh_source_tx(
            tx,
            selected.clone(),
            record.refresh.source_deliverable_id,
        )
        .await?;
        ensure!(
            source.run_id == record.refresh.source_run_id
                && source.commit_sha == record.refresh.source_head_commit
                && source.effective_source_revision == record.observed_source_revision
                && source.source_recovery_id == record.source_recovery_id,
            "base refresh lost its original source authority"
        );
        cursor = record.refresh.source_run_id;
    }
    Ok(())
}

fn refreshed_policy(record: &RefreshRecord) -> Value {
    let mut policy = record.source_policy.clone();
    policy["source_base_commit"] = json!(record.refresh.refreshed_base_commit);
    policy
}

async fn validate_contracts_tx(
    tx: &mut Transaction<'_, Postgres>,
    record: &RefreshRecord,
) -> Result<()> {
    let r = &record.refresh;
    for (task, mission, contract, policy) in [
        (
            r.source_task_id,
            r.source_mission_id,
            &record.source_contract,
            &record.source_verification_policy,
        ),
        (
            r.task_id,
            r.mission_id,
            &record.refreshed_contract,
            &record.refreshed_verification_policy,
        ),
    ] {
        let row = sqlx::query(
            "SELECT contract,verification_policy FROM tasks WHERE corp_id=$1 AND id=$2 AND mission_id=$3 FOR UPDATE",
        ).bind(r.corp_id).bind(task).bind(mission).fetch_optional(&mut **tx).await?
            .context("refresh task scope no longer exists")?;
        ensure!(
            row.get::<Value, _>("contract") == *contract
                && row.get::<Value, _>("verification_policy") == *policy,
            "base refresh source contract or complete verifier policy changed"
        );
    }
    let mut expected = record.source_contract.clone();
    expected["source_base_commit"] = json!(r.refreshed_base_commit);
    let original: VerificationPolicy =
        serde_json::from_value(record.source_verification_policy.clone())?;
    ensure!(
        expected == record.refreshed_contract
            && serde_json::to_value(base_refresh_policy(&original))?
                == record.refreshed_verification_policy,
        "refresh may change only the base commit and strengthen independent review"
    );
    Ok(())
}

async fn validate_review_tx(
    tx: &mut Transaction<'_, Postgres>,
    record: &RefreshRecord,
) -> Result<Uuid> {
    let r = &record.refresh;
    let row = sqlx::query(
        "SELECT review.status,review.gate,review.decision_key,review.decided_by,
           source_mission.requested_by,source_agent.actor_id AS producer,
           reviewer.kind,reviewer.role,reviewer_membership.actor_id AS member
         FROM verification_requests review
         JOIN missions source_mission ON source_mission.id=$3 AND source_mission.corp_id=review.corp_id
         JOIN runs source_run ON source_run.id=$4 AND source_run.corp_id=review.corp_id
         JOIN agents source_agent ON source_agent.id=source_run.agent_id AND source_agent.corp_id=review.corp_id
         LEFT JOIN actors reviewer ON reviewer.id=review.decided_by AND reviewer.corp_id=review.corp_id
         LEFT JOIN room_memberships reviewer_membership ON reviewer_membership.actor_id=reviewer.id
           AND reviewer_membership.room_id=source_mission.room_id
         WHERE review.corp_id=$1 AND review.run_id=$2 FOR UPDATE OF review",
    ).bind(r.corp_id).bind(r.run_id).bind(r.source_mission_id).bind(r.source_run_id)
        .fetch_optional(&mut **tx).await?.context("refresh requires a fresh independent review")?;
    let actor: Option<Uuid> = row.get("decided_by");
    let decision: Option<Uuid> = row.get("decision_key");
    let reviewer_id = actor.context("fresh review has no reviewer")?;
    let reviewer = sqlx::query("SELECT kind,role FROM actors WHERE corp_id=$1 AND id=$2 FOR SHARE")
        .bind(r.corp_id)
        .bind(reviewer_id)
        .fetch_optional(&mut **tx)
        .await?
        .context("fresh reviewer no longer exists")?;
    let room: Uuid = sqlx::query_scalar("SELECT room_id FROM missions WHERE corp_id=$1 AND id=$2")
        .bind(r.corp_id)
        .bind(r.source_mission_id)
        .fetch_one(&mut **tx)
        .await?;
    assert_room_membership_tx(tx, r.corp_id, room, reviewer_id).await?;
    validate_reviewer_tx(tx, r.corp_id, r.run_id, reviewer_id, decision).await?;
    let roles = record
        .refreshed_verification_policy
        .pointer("/manual_gate/roles")
        .and_then(Value::as_array)
        .context("saved independent review roles missing")?;
    ensure!(
        row.get::<String, _>("status") == "approved"
            && row.get::<Value, _>("gate") == record.refreshed_verification_policy["manual_gate"]
            && actor.is_some_and(|actor| actor != r.authorized_by
                && actor != row.get::<Uuid, _>("requested_by")
                && actor != row.get::<Uuid, _>("producer"))
            && reviewer.get::<&str, _>("kind") == "human"
            && roles
                .iter()
                .any(|role| role.as_str() == Some(reviewer.get::<&str, _>("role")))
            && decision.is_some()
            && r.review_decision_id
                .is_none_or(|saved| Some(saved) == decision),
        "refresh requires a current authorized independent review of the replacement run"
    );
    decision.context("fresh review decision key missing")
}

impl PgStore {
    pub async fn factory_base_refreshes(
        &self,
        corp: Uuid,
        actor: Uuid,
        item: Uuid,
    ) -> Result<Vec<FactoryBaseRefresh>> {
        let mut tx = self.pool.begin().await?;
        let (work_item, _) = factory_work_item_tx(&mut tx, corp, item, false)
            .await?
            .context("factory item not found")?;
        let mission = work_item
            .mission_id
            .context("factory item has no mission")?;
        let room: Uuid =
            sqlx::query_scalar("SELECT room_id FROM missions WHERE corp_id=$1 AND id=$2")
                .bind(corp)
                .bind(mission)
                .fetch_one(&mut *tx)
                .await?;
        assert_actor_scope_tx(&mut tx, corp, actor).await?;
        assert_room_membership_tx(&mut tx, corp, room, actor).await?;
        let rows: Vec<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(r) FROM factory_base_refreshes r WHERE corp_id=$1 AND factory_work_item_id=$2 ORDER BY created_at,id LIMIT 4",
        ).bind(corp).bind(item).fetch_all(&mut *tx).await?;
        ensure!(
            rows.len() <= MAX_BASE_REFRESH_ATTEMPTS as usize,
            "refresh attempt bound exceeded"
        );
        rows.into_iter()
            .map(|row| serde_json::from_value(row).context("decode refresh"))
            .collect()
    }

    pub async fn authorize_factory_base_refresh(
        &self,
        corp: Uuid,
        item: Uuid,
        input: AuthorizeFactoryBaseRefresh,
    ) -> Result<FactoryBaseRefreshResponse> {
        validate_factory_base_commit(&input.new_base_commit)?;
        ensure!(
            input.new_base_commit == input.new_base_commit.to_ascii_lowercase(),
            "base commit must be lowercase"
        );
        normalize_factory_text(&input.reason, "base refresh reason", 4_000)?;
        normalize_factory_text(
            &input.observed_source_revision,
            "observed source revision",
            200,
        )?;
        ensure!(
            input.expected_version > 0 && !input.idempotency_key.is_nil(),
            "invalid refresh version or key"
        );
        let mission: Uuid = sqlx::query_scalar(
            "SELECT COALESCE((SELECT source_mission_id FROM factory_base_refreshes
                WHERE corp_id=$1 AND authorized_by=$3 AND idempotency_key=$4),mission_id)
             FROM factory_work_items WHERE corp_id=$1 AND id=$2",
        )
        .bind(corp)
        .bind(item)
        .bind(input.actor_id)
        .bind(input.idempotency_key)
        .fetch_optional(&self.pool)
        .await?
        .context("factory item has no mission")?;
        let op = state_audit::Operation {
            corp,
            actor: input.actor_id,
            mission,
            request_id: input.idempotency_key,
            name: "base_refresh_authorize",
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

    pub async fn settle_factory_base_refresh(
        &self,
        corp: Uuid,
        item: Uuid,
        refresh: Uuid,
        input: SettleFactoryBaseRefresh,
        adopt: bool,
    ) -> Result<FactoryBaseRefreshResponse> {
        normalize_factory_text(&input.reason, "refresh settlement reason", 4_000)?;
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
            "SELECT source_mission_id FROM factory_base_refreshes WHERE corp_id=$1 AND factory_work_item_id=$2 AND id=$3",
        ).bind(corp).bind(item).bind(refresh).fetch_optional(&self.pool).await?
            .context("base refresh not found")?;
        let action = if adopt {
            "base_refresh_adopt"
        } else {
            "base_refresh_abandon"
        };
        let request = json!({"refresh_id":refresh,"action":action,"input":input});
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
            // The locked Factory row serializes this with every publication. Do
            // not take publication advisory locks after the audit ledger lock.
            let (mut work_item, token) = factory_work_item_tx(&mut tx, corp, item, true).await?
                .context("factory item missing")?;
            let record = record_tx(&mut tx, corp, refresh).await?;
            ensure!(record.refresh.factory_work_item_id == item, "refresh belongs to another item");
            ensure_factory_recovery_authorizer_tx(&mut tx, corp, mission, input.actor_id).await?;
            if record.refresh.state != "pending" {
                ensure!(record.refresh.settlement_key == Some(input.idempotency_key)
                    && record.refresh.settled_by == Some(input.actor_id)
                    && record.settlement_request.as_ref() == Some(&request),
                    "refresh settlement is terminal; retry must match its original request");
                return Ok(FactoryBaseRefreshResponse { refresh: record.refresh,
                    work_item, events: vec![], replayed: true });
            }
            ensure_active_factory_control(&work_item, token, input.actor_id,
                input.claim_token, input.expected_version, Utc::now())?;
            let (result, review) = if adopt {
                ensure_unpublished_tx(&mut tx, corp, item).await?;
                ensure!(work_item.mission_id == Some(mission) && work_item.policy == record.source_policy
                    && work_item.state == FactoryWorkItemState::Verified,
                    "original Factory selection or authority changed during refresh");
                ensure!(input.observed_source_revision == record.observed_source_revision,
                    "issue revision changed; the original refresh cannot be adopted");
                PgStore::ensure_audit_workflow_gates_tx(&mut tx, corp).await?;
                validate_contracts_tx(&mut tx, &record).await?;
                let source = publication::validate_refresh_source_tx(&mut tx,
                    work_item.clone(), record.refresh.source_deliverable_id).await?;
                ensure!(source.effective_source_revision == input.observed_source_revision
                    && source.source_recovery_id == record.source_recovery_id,
                    "source issue or recovery authority changed");
                validate_adopted_lineage_tx(&mut tx, &work_item, source.run_id).await?;
                let decision = validate_review_tx(&mut tx, &record).await?;
                let deliverable: Uuid = sqlx::query_scalar(
                    "SELECT id FROM source_deliverables WHERE corp_id=$1 AND task_id=$2 AND run_id=$3",
                ).bind(corp).bind(record.refresh.task_id).bind(record.refresh.run_id)
                    .fetch_optional(&mut *tx).await?.context("refreshed source deliverable missing")?;
                let mut candidate = work_item.clone();
                candidate.mission_id = Some(record.refresh.mission_id);
                candidate.policy = refreshed_policy(&record);
                let result = publication::validate_refresh_source_tx(&mut tx, candidate, deliverable).await?;
                ensure!(result.run_id == record.refresh.run_id
                    && result.base_commit == record.refresh.refreshed_base_commit,
                    "replacement source is not the authorized refresh");
                (Some((deliverable, result.commit_sha)), Some(decision))
            } else {
                // Abandonment changes no selected source or policy. Current
                // claim authority and a terminal run suffice even when the
                // issue changed and this refresh can no longer be adopted.
                let status: String = sqlx::query_scalar("SELECT status FROM runs WHERE corp_id=$1 AND id=$2 FOR UPDATE")
                    .bind(corp).bind(record.refresh.run_id).fetch_one(&mut *tx).await?;
                ensure!(matches!(status.as_str(), "completed"|"failed"|"cancelled"|"lost"|"verification_failed"),
                    "stop the active refresh through durable run cancellation before abandonment");
                (None, None)
            };
            let state = if adopt { "adopted" } else { "abandoned" };
            sqlx::query("UPDATE factory_base_refreshes SET state=$3,result_deliverable_id=$4,
                result_commit=$5,review_decision_id=$6,settled_by=$7,settlement_key=$8,
                settlement_request=$9,updated_at=now() WHERE corp_id=$1 AND id=$2")
                .bind(corp).bind(refresh).bind(state).bind(result.as_ref().map(|r|r.0))
                .bind(result.as_ref().map(|r|r.1.as_str())).bind(review).bind(input.actor_id)
                .bind(input.idempotency_key).bind(&request).execute(&mut *tx).await?;
            if adopt {
                sqlx::query("UPDATE factory_work_items SET mission_id=$3,policy=$4,version=version+1,updated_at=now() WHERE corp_id=$1 AND id=$2")
                    .bind(corp).bind(item).bind(record.refresh.mission_id).bind(refreshed_policy(&record))
                    .execute(&mut *tx).await?;
            } else {
                sqlx::query("UPDATE factory_work_items SET version=version+1,updated_at=now() WHERE corp_id=$1 AND id=$2")
                    .bind(corp).bind(item).execute(&mut *tx).await?;
            }
            work_item = factory_work_item_tx(&mut tx, corp, item, false).await?.context("factory item missing")?.0;
            let refresh = record_tx(&mut tx, corp, refresh).await?.refresh;
            state_audit::refresh_secondary_tx(&mut tx, &refresh, input.actor_id, action, input.idempotency_key).await?;
            let events = refresh_event_tx(&mut tx, &refresh, input.actor_id, action, &input.reason).await?;
            tx.commit().await?;
            Ok(FactoryBaseRefreshResponse { refresh, work_item, events, replayed: false })
        })).await
    }
}

async fn authorize_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    item: Uuid,
    input: &AuthorizeFactoryBaseRefresh,
) -> Result<FactoryBaseRefreshResponse> {
    lock_factory_keys_tx(
        tx,
        &[format!(
            "base-refresh:{corp}:{}:{}",
            input.actor_id, input.idempotency_key
        )],
    )
    .await?;
    let (work_item, token) = factory_work_item_tx(tx, corp, item, true)
        .await?
        .context("factory item missing")?;
    let request = serde_json::to_value(input)?;
    let prior: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM factory_base_refreshes WHERE corp_id=$1 AND authorized_by=$2 AND idempotency_key=$3",
    ).bind(corp).bind(input.actor_id).bind(input.idempotency_key).fetch_optional(&mut **tx).await?;
    if let Some(id) = prior {
        let record = record_tx(tx, corp, id).await?;
        ensure_factory_recovery_authorizer_tx(
            tx,
            corp,
            record.refresh.source_mission_id,
            input.actor_id,
        )
        .await?;
        ensure!(
            record.refresh.factory_work_item_id == item && record.request == request,
            "refresh idempotency key was reused with a different request"
        );
        return Ok(FactoryBaseRefreshResponse {
            refresh: record.refresh,
            work_item,
            events: vec![],
            replayed: true,
        });
    }
    let mission = work_item
        .mission_id
        .context("refresh requires a selected source mission")?;
    ensure_factory_recovery_authorizer_tx(tx, corp, mission, input.actor_id).await?;
    ensure_active_factory_control(
        &work_item,
        token,
        input.actor_id,
        input.claim_token,
        input.expected_version,
        Utc::now(),
    )?;
    ensure_unpublished_tx(tx, corp, item).await?;
    ensure_no_pending_tx(tx, corp, item).await?;
    let attempts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM factory_base_refreshes WHERE corp_id=$1 AND factory_work_item_id=$2",
    )
    .bind(corp)
    .bind(item)
    .fetch_one(&mut **tx)
    .await?;
    ensure!(
        attempts < MAX_BASE_REFRESH_ATTEMPTS,
        "base refresh attempt limit reached"
    );
    PgStore::ensure_audit_workflow_gates_tx(tx, corp).await?;
    let source =
        publication::validate_refresh_source_tx(tx, work_item.clone(), input.source_deliverable_id)
            .await?;
    validate_adopted_lineage_tx(tx, &work_item, source.run_id).await?;
    ensure!(
        source.effective_source_revision == input.observed_source_revision,
        "issue changed since source verification; refresh cannot revise issue authority"
    );
    ensure!(
        input.new_base_commit != source.base_commit,
        "base refresh requires an advanced base"
    );
    let row = sqlx::query(
        "SELECT task.contract,task.verification_policy,task.required_adapter,mission.requested_by,
           run.runner_id,run.artifact_id,run.artifact_uri,run.artifact_signature,run.artifact_path,
           run.artifact_sha256,run.artifact_media_type,provider.bytes AS provider_bytes,
           provider.file_name AS provider_file_name,provider.metadata AS provider_metadata,
           bundle.bytes AS bundle_bytes,bundle.file_name AS bundle_file_name,bundle.media_type AS bundle_media_type,
           bundle.metadata AS bundle_metadata
         FROM tasks task JOIN missions mission ON mission.id=task.mission_id AND mission.corp_id=task.corp_id
         JOIN runs run ON run.task_id=task.id AND run.corp_id=task.corp_id
         JOIN artifacts bundle ON bundle.id=$4 AND bundle.corp_id=task.corp_id
         LEFT JOIN artifacts provider ON provider.id=run.artifact_id AND provider.corp_id=task.corp_id
         WHERE task.corp_id=$1 AND task.id=$2 AND run.id=$3 FOR UPDATE OF task,mission,run,bundle",
    ).bind(corp).bind(source.task_id).bind(source.run_id).bind(source.artifact_id).fetch_one(&mut **tx).await?;
    let source_contract: Value = row.get("contract");
    let mut contract: TaskContract = serde_json::from_value(source_contract.clone())?;
    ensure!(
        contract.source_base_commit.as_deref() == Some(source.base_commit.as_str()),
        "source contract base changed"
    );
    contract.source_base_commit = Some(input.new_base_commit.clone());
    let source_policy: Value = row.get("verification_policy");
    let verifier = base_refresh_policy(&serde_json::from_value(source_policy.clone())?);
    let agent = Uuid::new_v4();
    let adapter: String = row.get("required_adapter");
    let plan = TaskGraphPlan {
        strategy: "governed-base-refresh".into(),
        max_nodes: 1,
        max_depth: 1,
        budget_tokens: contract.budget_tokens,
        budget_cost_microusd: contract.budget_cost_microusd,
        staffing: vec![PlannedAgent {
            id: agent,
            name: "Base verification".into(),
            role: "worker".into(),
            adapter: adapter.clone(),
            accent: "blue".into(),
        }],
        tasks: vec![PlannedTask {
            key: "base-refresh".into(),
            title: "Verify source on advanced base".into(),
            contract: contract.clone(),
            assigned_agent_id: agent,
            required_adapter: adapter,
            depends_on: vec![],
            depth: 0,
            max_attempts: 1,
            verification_policy: verifier.clone(),
        }],
    };
    let (created, mut events) = create_mission_in_room_tx(tx,corp,row.get("requested_by"),
        &format!("Re-verify issue #{} on advanced base",work_item.source_issue_number),
        &format!("{}\nSource mission: {}. Source result: {}. Original mission remains selected pending verification and independent review.",input.reason,mission,input.source_deliverable_id),
        &plan,source.room_id).await?;
    let task = created.task_ids[0];
    let run = Uuid::new_v4();
    let refresh = Uuid::new_v4();
    let assignment = Uuid::new_v4();
    let command = Uuid::new_v4();
    let runner: String = row.get("runner_id");
    sqlx::query("INSERT INTO runs (id,corp_id,task_id,agent_id,runner_id,assignment_token,status,
        workspace_run_id,budget_tokens_limit,budget_cost_microusd_limit,source_repository,source_base_ref,
        source_base_commit,execution_mode,artifact_id,artifact_uri,artifact_signature,artifact_path,artifact_sha256,artifact_media_type)
        VALUES($1,$2,$3,$4,$5,$6,'starting',$1,0,0,$7,$8,$9,'verification_only',$10,$11,$12,$13,$14,$15)")
        .bind(run).bind(corp).bind(task).bind(agent).bind(&runner).bind(assignment)
        .bind(&contract.source_repository).bind(&contract.source_base_ref).bind(&contract.source_base_commit)
        .bind(row.get::<Option<Uuid>,_>("artifact_id")).bind(row.get::<Option<String>,_>("artifact_uri"))
        .bind(row.get::<Option<String>,_>("artifact_signature")).bind(row.get::<Option<String>,_>("artifact_path"))
        .bind(row.get::<Option<String>,_>("artifact_sha256")).bind(row.get::<Option<String>,_>("artifact_media_type"))
        .execute(&mut **tx).await?;
    workspace_connections::bind_new_run_tx(tx, corp, run).await?;
    sqlx::query("UPDATE missions SET status='running',updated_at=now() WHERE id=$1 AND corp_id=$2")
        .bind(created.mission_id)
        .bind(corp)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE tasks SET status='claimed',attempt_count=1,updated_at=now() WHERE id=$1 AND corp_id=$2")
        .bind(task).bind(corp).execute(&mut **tx).await?;
    sqlx::query("UPDATE agents SET status='starting',station='review',current_run_id=$3 WHERE id=$1 AND corp_id=$2")
        .bind(agent).bind(corp).bind(run).execute(&mut **tx).await?;
    let provider = if row.get::<Option<Uuid>, _>("artifact_id").is_some() {
        let metadata: Value = row.get("provider_metadata");
        let path = metadata
            .get("workspace_relative_path")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| row.get("artifact_path"))
            .or_else(|| row.get("provider_file_name"))
            .context("source provider artifact path missing")?;
        Some(
            json!({"path":path,"sha256":row.get::<Option<String>,_>("artifact_sha256"),
            "bytes":row.get::<Option<i64>,_>("provider_bytes"),"media_type":row.get::<Option<String>,_>("artifact_media_type")}),
        )
    } else {
        None
    };
    let bundle_metadata: Value = row.get("bundle_metadata");
    let payload = json!({
        "refresh_id":refresh,"corp_id":corp,"room_id":source.room_id,"mission_id":created.mission_id,
        "task_id":task,"run_id":run,"workspace_run_id":run,"agent_id":agent,"assignment_token":assignment,
        "workspace_connection_id":contract.workspace_connection_id,
        "source_repository":contract.source_repository,"source_base_ref":contract.source_base_ref,
        "source_base_commit":contract.source_base_commit,"workspace_base_commit":contract.source_base_commit,
        "verification_policy":verifier,"write_scope":contract.write_scope,"deliverable":contract.deliverable,
        "provider_artifact":provider,
        "base_refresh":{"refresh_id":refresh,"source_deliverable_id":input.source_deliverable_id,
            "old_base_commit":source.base_commit,"source_head_commit":source.commit_sha,
            "source_branch":source.source_branch,"verification_sha256":source.verification_sha256,
            "git_bundle_sha256":bundle_metadata["git_bundle_sha256"],
            "artifact":{"path":row.get::<String,_>("bundle_file_name"),"sha256":source.deliverable_sha256,
                "bytes":row.get::<i64,_>("bundle_bytes"),"media_type":row.get::<String,_>("bundle_media_type")}}
    });
    sqlx::query("INSERT INTO factory_base_refreshes(id,corp_id,factory_work_item_id,source_mission_id,
        source_task_id,source_run_id,source_deliverable_id,mission_id,task_id,run_id,authorized_by,idempotency_key,
        request,command_id,command_payload,source_policy,source_contract,source_verification_policy,
        refreshed_contract,refreshed_verification_policy,observed_source_revision,source_recovery_id,
        original_base_commit,refreshed_base_commit,source_head_commit)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)")
        .bind(refresh).bind(corp).bind(item).bind(mission).bind(source.task_id).bind(source.run_id)
        .bind(input.source_deliverable_id).bind(created.mission_id).bind(task).bind(run).bind(input.actor_id)
        .bind(input.idempotency_key).bind(request).bind(command).bind(&payload).bind(&work_item.policy)
        .bind(source_contract).bind(source_policy).bind(serde_json::to_value(&contract)?)
        .bind(serde_json::to_value(&verifier)?).bind(&input.observed_source_revision).bind(source.source_recovery_id)
        .bind(&source.base_commit).bind(&input.new_base_commit).bind(&source.commit_sha).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO runner_commands(id,corp_id,runner_id,run_id,command_kind,payload,idempotency_key)
        VALUES($1,$2,$3,$4,'factory_base_refresh',$5,$6)")
        .bind(command).bind(corp).bind(runner).bind(run).bind(payload)
        .bind(format!("factory-base-refresh:{refresh}")).execute(&mut **tx).await?;
    sqlx::query("UPDATE factory_work_items SET version=version+1,updated_at=now() WHERE corp_id=$1 AND id=$2")
        .bind(corp).bind(item).execute(&mut **tx).await?;
    let refresh = record_tx(tx, corp, refresh).await?.refresh;
    state_audit::refresh_secondary_tx(
        tx,
        &refresh,
        input.actor_id,
        "base_refresh_authorize",
        input.idempotency_key,
    )
    .await?;
    events.extend(
        refresh_event_tx(
            tx,
            &refresh,
            input.actor_id,
            "base_refresh_authorize",
            &input.reason,
        )
        .await?,
    );
    let work_item = factory_work_item_tx(tx, corp, item, false)
        .await?
        .context("factory item missing")?
        .0;
    Ok(FactoryBaseRefreshResponse {
        refresh,
        work_item,
        events,
        replayed: false,
    })
}

async fn refresh_event_tx(
    tx: &mut Transaction<'_, Postgres>,
    refresh: &FactoryBaseRefresh,
    actor: Uuid,
    action: &str,
    reason: &str,
) -> Result<Vec<DomainEvent>> {
    let room: Uuid = sqlx::query_scalar("SELECT room_id FROM missions WHERE corp_id=$1 AND id=$2")
        .bind(refresh.corp_id)
        .bind(refresh.source_mission_id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(append_event_tx(
        tx,
        NewEvent {
            room_id: Some(room),
            correlation_id: Some(refresh.mission_id),
            causation_id: Some(refresh.source_run_id),
            ..NewEvent::new(
                refresh.corp_id,
                Some(actor),
                format!("factory.{action}"),
                "factory_base_refresh",
                refresh.id,
                format!("base-refresh:{}:{action}", refresh.id),
                json!({"refresh":refresh,"reason":reason}),
            )
        },
    )
    .await?
    .into_iter()
    .collect())
}
