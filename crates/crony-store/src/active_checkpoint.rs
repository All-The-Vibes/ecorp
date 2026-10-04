//! Draft-only remote durability. Final publication retains its complete prerequisite checks.
use super::*;
use crony_domain::{
    ActiveCheckpointAction, ActiveCheckpointOutcome, ActiveCheckpointPolicy,
    ActiveCheckpointPublication, ActiveCheckpointReceipt, ActiveCheckpointRequest,
};

#[cfg(test)]
#[path = "active_checkpoint_tests.rs"]
mod tests;

pub struct ActiveCheckpointMutation {
    pub corp_id: Uuid,
    pub work_item_id: Uuid,
    pub publisher_credential_hash: String,
    pub request: ActiveCheckpointRequest,
}

pub struct ActiveCheckpointMutationOutcome {
    pub response: ActiveCheckpointOutcome,
    pub events: Vec<DomainEvent>,
}

impl PgStore {
    pub async fn active_checkpoint_policy(
        &self,
        corp_id: Uuid,
        task_id: Uuid,
    ) -> Result<Option<ActiveCheckpointPolicy>> {
        let mut tx = self.pool.begin().await?;
        let policy = policy_tx(&mut tx, corp_id, task_id).await?;
        tx.commit().await?;
        Ok(policy)
    }

    pub async fn active_checkpoint_context(
        &self,
        corp_id: Uuid,
        actor_id: Uuid,
        item_id: Uuid,
    ) -> Result<Value> {
        let mut tx = self.pool.begin().await?;
        assert_actor_scope_tx(&mut tx, corp_id, actor_id).await?;
        let human: Option<String> = sqlx::query_scalar(
            "SELECT role FROM actors WHERE corp_id=$1 AND id=$2 AND kind='human' FOR SHARE",
        )
        .bind(corp_id)
        .bind(actor_id)
        .fetch_optional(&mut *tx)
        .await?;
        if !matches!(
            human.as_deref(),
            Some("owner" | "admin" | "manager" | "member")
        ) {
            return Err(anyhow!(
                "forbidden: a human publication operator is required"
            ));
        }
        let (work_item, _) = factory_work_item_tx(&mut tx, corp_id, item_id, false)
            .await?
            .context("factory work item not found")?;
        let room: Uuid =
            sqlx::query_scalar("SELECT room_id FROM missions WHERE id=$1 AND corp_id=$2 FOR SHARE")
                .bind(
                    work_item
                        .mission_id
                        .context("checkpoint requires a mission")?,
                )
                .bind(corp_id)
                .fetch_one(&mut *tx)
                .await?;
        assert_room_membership_tx(&mut tx, corp_id, room, actor_id).await?;
        let latest: Option<ActiveCheckpointPublication> = sqlx::query_scalar::<_, Value>(
            "SELECT snapshot FROM active_checkpoint_publications WHERE corp_id=$1 AND work_item_id=$2 ORDER BY generation DESC LIMIT 1",
        ).bind(corp_id).bind(item_id).fetch_optional(&mut *tx).await?
            .map(serde_json::from_value).transpose()?;
        let desired_body = match &latest {
            Some(publication) if publication.phase == "project_synchronized" => Some(
                draft_body_tx(
                    &mut tx,
                    &work_item,
                    publication.run_id,
                    &publication.metadata,
                    &publication.artifact_sha256,
                )
                .await?,
            ),
            Some(publication) => Some(publication.body.clone()),
            None => None,
        };
        let final_publication_started: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pull_request_publications WHERE corp_id=$1 AND factory_work_item_id=$2)",
        ).bind(corp_id).bind(item_id).fetch_one(&mut *tx).await?;
        let artifacts = sqlx::query_scalar::<_, Value>(
            r#"SELECT jsonb_build_object('id',a.id,'run_id',a.run_id,'sha256',a.sha256,
                   'metadata',a.metadata,'created_at',a.created_at,
                   'run_status',r.status,'verification_status',r.verification_status)
               FROM artifacts a JOIN tasks t ON t.id=a.task_id AND t.corp_id=a.corp_id
               JOIN runs r ON r.id=a.run_id AND r.task_id=t.id AND r.corp_id=t.corp_id
               JOIN factory_work_items f ON f.mission_id=t.mission_id AND f.corp_id=t.corp_id
               WHERE f.id=$1 AND f.corp_id=$2 AND a.artifact_role='source_checkpoint'
                 AND a.status='ready' AND a.retention_until>now()
               ORDER BY a.created_at DESC,a.id"#,
        )
        .bind(item_id)
        .bind(corp_id)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(json!({"work_item":work_item,"publication":latest,
            "desired_body":desired_body,"final_publication_started":final_publication_started,"artifacts":artifacts}))
    }

    pub async fn mutate_active_checkpoint(
        &self,
        input: ActiveCheckpointMutation,
    ) -> Result<ActiveCheckpointMutationOutcome> {
        let request = &input.request;
        if request.publisher_id.trim().is_empty() || request.publisher_id.len() > 200 {
            return Err(anyhow!("invalid checkpoint publisher identity"));
        }
        let mut tx = self.pool.begin().await?;
        assert_actor_scope_tx(&mut tx, input.corp_id, request.actor_id).await?;
        publication::revalidate_publication_publisher_credential_tx(
            &mut tx,
            input.corp_id,
            &request.publisher_id,
            &input.publisher_credential_hash,
        )
        .await?;
        let human: Option<String> = sqlx::query_scalar(
            "SELECT role FROM actors WHERE corp_id=$1 AND id=$2 AND kind='human' FOR SHARE",
        )
        .bind(input.corp_id)
        .bind(request.actor_id)
        .fetch_optional(&mut *tx)
        .await?;
        if !matches!(
            human.as_deref(),
            Some("owner" | "admin" | "manager" | "member")
        ) {
            return Err(anyhow!(
                "forbidden: a human publication operator is required"
            ));
        }
        let (pre_item, _) = factory_work_item_tx(&mut tx, input.corp_id, input.work_item_id, false)
            .await?
            .context("factory work item not found")?;
        let repository = format!(
            "{}/{}",
            pre_item.source_repository_owner, pre_item.source_repository_name
        );
        let branch = branch_for(&pre_item)?;
        lock_factory_keys_tx(
            &mut tx,
            &[
                format!(
                    "publication:factory:{}:{}",
                    input.corp_id, input.work_item_id
                ),
                format!(
                    "publication:branch:{}:{}:{}",
                    input.corp_id, repository, branch
                ),
                format!(
                    "active-checkpoint:idempotency:{}:{}",
                    input.corp_id, request.idempotency_key
                ),
            ],
        )
        .await?;
        PgStore::ensure_audit_workflow_gates_tx(&mut tx, input.corp_id).await?;
        let (item, _) = factory_work_item_tx(&mut tx, input.corp_id, input.work_item_id, true)
            .await?
            .context("factory work item not found")?;
        if item.policy != pre_item.policy || item.mission_id != pre_item.mission_id {
            return Err(anyhow!(
                "conflict: checkpoint authority changed while acquiring locks"
            ));
        }
        let mission_id = item.mission_id.context("checkpoint requires a mission")?;
        let room_id: Uuid = sqlx::query_scalar(
            "SELECT room_id FROM missions WHERE id=$1 AND corp_id=$2 FOR UPDATE",
        )
        .bind(mission_id)
        .bind(input.corp_id)
        .fetch_one(&mut *tx)
        .await?;
        assert_room_membership_tx(&mut tx, input.corp_id, room_id, request.actor_id).await?;
        if matches!(
            item.state,
            FactoryWorkItemState::Cancelled
                | FactoryWorkItemState::Publishing
                | FactoryWorkItemState::Published
        ) {
            return Err(anyhow!(
                "conflict: factory state prohibits active checkpoint publication"
            ));
        }
        let final_started: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pull_request_publications WHERE corp_id=$1 AND factory_work_item_id=$2)",
        ).bind(input.corp_id).bind(item.id).fetch_one(&mut *tx).await?;
        if final_started {
            return Err(anyhow!(
                "conflict: final publication already owns this branch"
            ));
        }
        let row = sqlx::query(
            r#"SELECT a.id,a.corp_id,a.task_id,a.run_id,a.producer_agent_id,a.producer_runner_id,
                      a.verifier,a.object_key,a.uri,a.sha256,a.media_type,a.bytes,a.artifact_role,
                      a.file_name,a.metadata,a.provenance_signature,a.retention_until,r.breaker_stage
               FROM artifacts a JOIN tasks t ON t.id=a.task_id AND t.corp_id=a.corp_id
               JOIN runs r ON r.id=a.run_id AND r.task_id=t.id AND r.corp_id=t.corp_id
               WHERE a.id=$1 AND a.corp_id=$2 AND t.mission_id=$3 AND a.status='ready'
                 AND a.artifact_role='source_checkpoint' AND a.retention_until>now()
                 AND r.status NOT IN ('cancelled','lost')
               FOR UPDATE OF t,r,a"#,
        ).bind(request.artifact_id).bind(input.corp_id).bind(mission_id)
            .fetch_optional(&mut *tx).await?.context("checkpoint artifact is not available in this mission")?;
        let breaker: String = row.get("breaker_stage");
        let artifact = map_stored_artifact(row);
        ensure_run_not_hard_blocked_tx(
            &mut tx,
            input.corp_id,
            artifact.run_id,
            &breaker,
            "draft checkpoint publication",
        )
        .await?;
        let stopped: bool = sqlx::query_scalar(
            r#"SELECT EXISTS(SELECT 1 FROM events WHERE corp_id=$1 AND aggregate_id=$2
               AND aggregate_type='run' AND type='run.stop_requested')"#,
        )
        .bind(input.corp_id)
        .bind(artifact.run_id)
        .fetch_one(&mut *tx)
        .await?;
        if stopped {
            return Err(anyhow!(
                "checkpoint publication cannot override an explicit stop"
            ));
        }
        validate_artifact_tx(&mut tx, &artifact).await?;
        let request_snapshot = operation_snapshot(request)?;
        let prior_op = sqlx::query(
            "SELECT publication_id,request FROM active_checkpoint_operations WHERE corp_id=$1 AND idempotency_key=$2",
        ).bind(input.corp_id).bind(request.idempotency_key).fetch_optional(&mut *tx).await?;
        let latest = latest_tx(&mut tx, input.corp_id, item.id).await?;
        if item.state == FactoryWorkItemState::Failed
            && !latest.as_ref().is_some_and(|row| {
                row.0.artifact_id == request.artifact_id
                    && matches!(
                        row.0.phase.as_str(),
                        "draft_published" | "project_synchronized"
                    )
                    && !matches!(request.action, ActiveCheckpointAction::BranchPushed { .. })
            })
        {
            return Err(anyhow!(
                "a failed factory may only refresh gates on its existing durable draft"
            ));
        }
        if let Some(op) = prior_op {
            if op.get::<Value, _>("request") != request_snapshot {
                return Err(anyhow!(
                    "conflict: checkpoint idempotency key was reused for a different request"
                ));
            }
            let (publication, token, lease_operation, _) =
                by_id_tx(&mut tx, input.corp_id, op.get("publication_id"))
                    .await?
                    .context("checkpoint operation lost its publication")?;
            let token_allowed = latest
                .as_ref()
                .is_some_and(|row| row.0.id == publication.id)
                && !publication.gates_synchronized()
                && publication.failure_detail.is_none()
                && publication.lease_expires_at > Utc::now()
                && publication.actor_id == request.actor_id
                && publication.publisher_id == request.publisher_id
                && (request.publisher_token == Some(token)
                    || (matches!(request.action, ActiveCheckpointAction::Acquire)
                        && lease_operation == request.idempotency_key));
            tx.commit().await?;
            return Ok(ActiveCheckpointMutationOutcome {
                response: ActiveCheckpointOutcome {
                    publication,
                    publisher_token: token_allowed.then_some(token),
                    replayed: true,
                    busy: false,
                },
                events: Vec::new(),
            });
        }
        let existing = by_artifact_tx(&mut tx, input.corp_id, request.artifact_id).await?;
        let now = Utc::now();
        let (mut publication, mut token, mut lease_operation, generation) =
            if let Some(existing) = existing {
                if latest
                    .as_ref()
                    .is_none_or(|latest| latest.0.id != existing.0.id)
                {
                    return Err(anyhow!(
                        "conflict: an older checkpoint generation cannot mutate the remote branch"
                    ));
                }
                existing
            } else {
                if !matches!(request.action, ActiveCheckpointAction::Acquire)
                    || request.expected_version.is_some()
                    || request.publisher_token.is_some()
                {
                    return Err(anyhow!("checkpoint must first acquire a new publication"));
                }
                if latest.as_ref().is_some_and(|latest| {
                    !latest.0.gates_synchronized()
                        || latest.0.lease_expires_at > now
                        || latest.0.failure_detail.is_some()
                }) {
                    return Err(anyhow!(
                        "conflict: recover the unfinished checkpoint generation first"
                    ));
                }
                let previous = latest.as_ref().map(|latest| &latest.0);
                let commit = artifact.metadata["head_commit"]
                    .as_str()
                    .context("checkpoint omitted commit")?
                    .to_owned();
                let title = format!("Draft checkpoint for issue #{}", item.source_issue_number);
                let body = draft_body_tx(
                    &mut tx,
                    &item,
                    artifact.run_id,
                    &artifact.metadata,
                    &artifact.sha256,
                )
                .await?;
                let publication = ActiveCheckpointPublication {
                    id: Uuid::new_v4(),
                    corp_id: input.corp_id,
                    work_item_id: item.id,
                    mission_id,
                    task_id: artifact.task_id,
                    run_id: artifact.run_id,
                    artifact_id: artifact.id,
                    artifact_sha256: artifact.sha256.clone(),
                    metadata: artifact.metadata.clone(),
                    target_repository: repository,
                    base_ref: item.policy["publication"]["base_ref"]
                        .as_str()
                        .context("checkpoint publication omitted base ref")?
                        .to_owned(),
                    pull_request_base_ref: previous.and_then(|p| p.pull_request_base_ref.clone()),
                    branch,
                    commit_sha: commit,
                    previous_commit_sha: previous.map(|p| p.commit_sha.clone()),
                    previous_pull_request: previous.and_then(|p| p.pull_request.clone()),
                    title,
                    body,
                    phase: "pending".into(),
                    version: 1,
                    actor_id: request.actor_id,
                    publisher_id: request.publisher_id.clone(),
                    lease_expires_at: now + Duration::seconds(120),
                    failure_detail: None,
                    pull_request: None,
                    created_at: now,
                };
                (
                    publication,
                    Uuid::new_v4(),
                    request.idempotency_key,
                    latest.as_ref().map_or(1, |r| r.3 + 1),
                )
            };
        if publication.metadata != artifact.metadata
            || publication.artifact_sha256 != artifact.sha256
        {
            return Err(anyhow!("conflict: checkpoint source provenance changed"));
        }
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM active_checkpoint_publications WHERE id=$1)",
        )
        .bind(publication.id)
        .fetch_one(&mut *tx)
        .await?;
        if exists {
            if matches!(request.action, ActiveCheckpointAction::Acquire) {
                let desired_body = if publication.phase == "project_synchronized" {
                    draft_body_tx(
                        &mut tx,
                        &item,
                        artifact.run_id,
                        &artifact.metadata,
                        &artifact.sha256,
                    )
                    .await?
                } else {
                    publication.body.clone()
                };
                if publication.gates_synchronized()
                    && publication.body == desired_body
                    && publication.failure_detail.is_none()
                {
                    tx.commit().await?;
                    return Ok(ActiveCheckpointMutationOutcome {
                        response: ActiveCheckpointOutcome {
                            publication,
                            publisher_token: None,
                            replayed: true,
                            busy: false,
                        },
                        events: Vec::new(),
                    });
                }
                if publication.lease_expires_at > now {
                    tx.commit().await?;
                    return Ok(ActiveCheckpointMutationOutcome {
                        response: ActiveCheckpointOutcome {
                            publication,
                            publisher_token: None,
                            replayed: false,
                            busy: true,
                        },
                        events: Vec::new(),
                    });
                }
                if request.expected_version != Some(publication.version)
                    || request.publisher_token.is_some()
                {
                    return Err(anyhow!(
                        "conflict: expired checkpoint acquisition requires its current version"
                    ));
                }
                token = Uuid::new_v4();
                lease_operation = request.idempotency_key;
                publication.actor_id = request.actor_id;
                publication.publisher_id = request.publisher_id.clone();
                publication.body = desired_body;
            } else if request.expected_version != Some(publication.version)
                || request.publisher_token != Some(token)
                || publication.lease_expires_at <= now
                || publication.actor_id != request.actor_id
                || publication.publisher_id != request.publisher_id
            {
                return Err(anyhow!(
                    "conflict: checkpoint lease, actor or version is stale"
                ));
            }
            publication.version += 1;
        }
        apply_action(&mut publication, &request.action, &item)?;
        publication.lease_expires_at = now + Duration::seconds(120);
        if matches!(request.action, ActiveCheckpointAction::Failed { .. })
            || publication.gates_synchronized()
        {
            publication.lease_expires_at = now;
        }
        let snapshot = serde_json::to_value(&publication)?;
        sqlx::query(
            r#"INSERT INTO active_checkpoint_publications
                (id,corp_id,work_item_id,artifact_id,generation,snapshot,publisher_token,lease_operation_id,
                 mission_id,task_id,run_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT(id) DO UPDATE SET snapshot=EXCLUDED.snapshot,
                 publisher_token=EXCLUDED.publisher_token,
                 lease_operation_id=EXCLUDED.lease_operation_id"#,
        ).bind(publication.id).bind(input.corp_id).bind(item.id).bind(artifact.id).bind(generation)
            .bind(snapshot).bind(token).bind(lease_operation).bind(mission_id)
            .bind(artifact.task_id).bind(artifact.run_id).execute(&mut *tx).await?;
        sqlx::query(
            "INSERT INTO active_checkpoint_operations(corp_id,idempotency_key,publication_id,request,resulting_version) VALUES($1,$2,$3,$4,$5)",
        ).bind(input.corp_id).bind(request.idempotency_key).bind(publication.id)
            .bind(request_snapshot).bind(publication.version).execute(&mut *tx).await?;
        let event = append_event_tx(&mut tx,NewEvent {
            room_id:Some(room_id),correlation_id:Some(mission_id),
            ..NewEvent::new(input.corp_id,Some(request.actor_id),"factory.checkpoint_publication",
                "factory_work_item",item.id,format!("active-checkpoint:{}",request.idempotency_key),
                json!({"publication_id":publication.id,"artifact_id":artifact.id,"run_id":artifact.run_id,
                    "commit_sha":publication.commit_sha,"phase":publication.phase,"version":publication.version,
                    "failure_detail":publication.failure_detail,"remote":publication.pull_request,
                    "gates_synchronized":publication.gates_synchronized(),
                    "body_sha256":hex::encode(Sha256::digest(publication.body.as_bytes())),"auto_merge":false}))
        }).await?;
        tx.commit().await?;
        let token_allowed = !publication.gates_synchronized()
            && publication.failure_detail.is_none()
            && publication.lease_expires_at > Utc::now();
        Ok(ActiveCheckpointMutationOutcome {
            response: ActiveCheckpointOutcome {
                publication,
                publisher_token: token_allowed.then_some(token),
                replayed: false,
                busy: false,
            },
            events: event.into_iter().collect(),
        })
    }

    /// The caller has authenticated this exact current runner assignment. Storage alone
    /// never produces this receipt; a trusted publisher must first record remote proof.
    pub async fn active_checkpoint_receipt(
        &self,
        input: &RunnerEventInput,
        digest: &str,
    ) -> Result<Option<ActiveCheckpointReceipt>> {
        // Authorize the assignment and read its receipt in one database snapshot.
        // Replayed storage acknowledgements cannot grant publication authority.
        let snapshot: Option<Value> = sqlx::query_scalar(
            r#"SELECT p.snapshot FROM active_checkpoint_publications p
               JOIN artifacts a ON a.id=p.artifact_id AND a.corp_id=p.corp_id
               JOIN runs r ON r.id=a.run_id AND r.corp_id=a.corp_id
               WHERE p.corp_id=$1 AND a.run_id=$2 AND a.sha256=$3 AND a.status='ready'
                 AND r.agent_id=$4 AND r.runner_id=$5 AND r.assignment_token=$6
                 AND r.status IN ('provisioning','starting','running','waiting_for_input','waiting_for_approval','verifying')
                 AND r.breaker_stage NOT IN ('suspend','stop')
                 AND NOT EXISTS(SELECT 1 FROM events e WHERE e.corp_id=r.corp_id
                     AND e.aggregate_id=r.id AND e.aggregate_type='run' AND e.type='run.stop_requested')
                 AND a.artifact_role='source_checkpoint'
                 AND p.snapshot->>'phase' IN ('draft_published','project_synchronized')
                 AND NOT EXISTS(SELECT 1 FROM active_checkpoint_publications newer
                     WHERE newer.corp_id=p.corp_id AND newer.work_item_id=p.work_item_id
                       AND newer.generation>p.generation)
               ORDER BY p.generation DESC LIMIT 1"#,
        ).bind(input.corp_id).bind(input.run_id).bind(digest).bind(input.agent_id)
            .bind(&input.runner_id).bind(input.assignment_token).fetch_optional(&self.pool).await?;
        snapshot
            .map(serde_json::from_value::<ActiveCheckpointPublication>)
            .transpose()
            .map(|publication| publication.and_then(|p| p.receipt()))
            .map_err(Into::into)
    }
}

pub(super) async fn policy_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    task_id: Uuid,
) -> Result<Option<ActiveCheckpointPolicy>> {
    let row=sqlx::query(
        r#"SELECT f.policy,t.verification_policy,t.contract,
              (SELECT count(*) FROM tasks sibling WHERE sibling.mission_id=t.mission_id AND sibling.corp_id=t.corp_id) task_count
           FROM tasks t JOIN factory_work_items f ON f.mission_id=t.mission_id AND f.corp_id=t.corp_id
           WHERE t.id=$1 AND t.corp_id=$2"#,
    ).bind(task_id).bind(corp_id).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(None) };
    let factory: Value = row.get("policy");
    let checkpoint =
        ActiveCheckpointPolicy::validate_factory_policy(&factory).map_err(anyhow::Error::msg)?;
    if let Some(checkpoint) = &checkpoint {
        if row.get::<i64, _>("task_count") != 1
            || row.get::<Value, _>("contract")["deliverable"]["form"] != "commit_branch"
        {
            return Err(anyhow!(
                "checkpoint task must retain the single-source factory deliverable contract"
            ));
        }
        let original: VerificationPolicy =
            serde_json::from_value(factory["verification_policy"].clone())?;
        let current: VerificationPolicy = serde_json::from_value(row.get("verification_policy"))?;
        checkpoint
            .validate_verification_replacement(&original, &current)
            .map_err(anyhow::Error::msg)?;
    }
    Ok(checkpoint)
}

pub(super) async fn validate_artifact_tx(
    tx: &mut Transaction<'_, Postgres>,
    artifact: &StoredArtifact,
) -> Result<()> {
    let checkpoint = policy_tx(tx, artifact.corp_id, artifact.task_id)
        .await?
        .context("source checkpoint is not authorized by this task")?;
    let row = sqlx::query(
        r#"SELECT t.verification_policy,r.source_base_commit,r.workspace_base_commit
           FROM tasks t JOIN runs r ON r.task_id=t.id AND r.corp_id=t.corp_id
           WHERE t.id=$1 AND t.corp_id=$2 AND r.id=$3"#,
    )
    .bind(artifact.task_id)
    .bind(artifact.corp_id)
    .bind(artifact.run_id)
    .fetch_one(&mut **tx)
    .await?;
    let full: VerificationPolicy =
        serde_json::from_value(artifact.metadata["verification_policy"].clone())?;
    let current: VerificationPolicy = serde_json::from_value(row.get("verification_policy"))?;
    checkpoint
        .validate_verification_replacement(&current, &full)
        .map_err(anyhow::Error::msg)?;
    if artifact.artifact_role != "source_checkpoint"
        || artifact.metadata["purpose"] != "active_checkpoint"
        || artifact.metadata["publication_ready"] != false
        || artifact.metadata["integration_state"] != "checkpoint_pending"
        || artifact.metadata["checkpoint_policy"] != serde_json::to_value(&checkpoint)?
        || artifact.metadata["base_commit"].as_str()
            != row
                .get::<Option<String>, _>("source_base_commit")
                .as_deref()
        || artifact.metadata["base_commit"].as_str()
            != row
                .get::<Option<String>, _>("workspace_base_commit")
                .as_deref()
    {
        return Err(anyhow!(
            "checkpoint artifact does not match immutable task and source authority"
        ));
    }
    checkpoint
        .validate_report(&full, &artifact.metadata["checkpoint_report"])
        .map_err(anyhow::Error::msg)
}

/// Freeze the complete policy when the authenticated runner uploads this artifact.
/// Later contract revisions cannot reinterpret an older run's pending/failed gates.
pub(super) async fn validate_artifact_intake_tx(
    tx: &mut Transaction<'_, Postgres>,
    artifact: &StoredArtifact,
) -> Result<()> {
    validate_artifact_tx(tx, artifact).await?;
    let current: Value =
        sqlx::query_scalar("SELECT verification_policy FROM tasks WHERE id=$1 AND corp_id=$2")
            .bind(artifact.task_id)
            .bind(artifact.corp_id)
            .fetch_one(&mut **tx)
            .await?;
    let current: VerificationPolicy = serde_json::from_value(current)?;
    let frozen: VerificationPolicy =
        serde_json::from_value(artifact.metadata["verification_policy"].clone())?;
    if frozen != current {
        return Err(anyhow!(
            "checkpoint upload must freeze its complete current task verifier policy"
        ));
    }
    Ok(())
}

fn branch_for(item: &FactoryWorkItem) -> Result<String> {
    ActiveCheckpointPolicy::validate_factory_policy(&item.policy)
        .map_err(anyhow::Error::msg)?
        .context("factory policy did not opt into active checkpoints")?;
    let prefix = item.policy["publication"]["branch_prefix"]
        .as_str()
        .unwrap_or("ecorp/");
    let branch = format!(
        "{prefix}issue-{}-{}",
        item.source_issue_number,
        &item.id.to_string()[..8]
    );
    validate_factory_base_ref(&branch)?;
    let repository = format!(
        "{}/{}",
        item.source_repository_owner, item.source_repository_name
    );
    let base = item.policy["publication"]["base_ref"]
        .as_str()
        .context("checkpoint base ref missing")?;
    publication::validate_publication_target(item, &repository, base, &branch)?;
    Ok(branch)
}

#[derive(Debug)]
struct CheckpointGateEvidence {
    index: i32,
    kind: String,
    status: String,
    payload: Value,
}

async fn draft_body_tx(
    tx: &mut Transaction<'_, Postgres>,
    item: &FactoryWorkItem,
    run_id: Uuid,
    metadata: &Value,
    artifact_sha256: &str,
) -> Result<String> {
    let run = sqlx::query(
        "SELECT r.task_id,r.status FROM runs r JOIN tasks t ON t.id=r.task_id AND t.corp_id=r.corp_id \
         WHERE r.id=$1 AND r.corp_id=$2 AND t.mission_id=$3",
    ).bind(run_id).bind(item.corp_id).bind(item.mission_id).fetch_one(&mut **tx).await?;
    let task_id: Uuid = run.get("task_id");
    let event = sqlx::query(
        "SELECT type,payload FROM events WHERE corp_id=$1 AND aggregate_type='run' AND aggregate_id=$2 \
         AND type IN ('run.verification_passed','run.verification_failed') ORDER BY seq DESC LIMIT 1",
    ).bind(item.corp_id).bind(run_id).fetch_optional(&mut **tx).await?
        .map(|row| (row.get::<String,_>("type"),row.get::<Value,_>("payload")));
    let evidence = sqlx::query(
        "SELECT check_index,kind,status,payload FROM verification_evidence \
         WHERE corp_id=$1 AND task_id=$2 AND run_id=$3 ORDER BY check_index",
    )
    .bind(item.corp_id)
    .bind(task_id)
    .bind(run_id)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|row| CheckpointGateEvidence {
        index: row.get("check_index"),
        kind: row.get("kind"),
        status: row.get("status"),
        payload: row.get("payload"),
    })
    .collect::<Vec<_>>();
    let manual = sqlx::query(
        "SELECT status,gate,decided_by FROM verification_requests WHERE corp_id=$1 AND task_id=$2 AND run_id=$3",
    ).bind(item.corp_id).bind(task_id).bind(run_id).fetch_optional(&mut **tx).await?;
    let full: VerificationPolicy = serde_json::from_value(metadata["verification_policy"].clone())?;
    let review = manual.as_ref().and_then(|row| {
        let gate: Value = row.get("gate");
        let status: String = row.get("status");
        let decided_by: Option<Uuid> = row.get("decided_by");
        (full
            .manual_gate
            .as_ref()
            .and_then(|gate| serde_json::to_value(gate).ok())
            .as_ref()
            == Some(&gate)
            && (status == "pending" || decided_by.is_some()))
        .then_some(status)
    });
    render_draft_body(
        item,
        run_id,
        metadata,
        artifact_sha256,
        &run.get::<String, _>("status"),
        event.as_ref(),
        &evidence,
        review.as_deref(),
    )
}

#[allow(clippy::too_many_arguments)]
fn render_draft_body(
    item: &FactoryWorkItem,
    run_id: Uuid,
    metadata: &Value,
    artifact_sha256: &str,
    run_status: &str,
    final_event: Option<&(String, Value)>,
    evidence: &[CheckpointGateEvidence],
    review: Option<&str>,
) -> Result<String> {
    let policy: ActiveCheckpointPolicy =
        serde_json::from_value(metadata["checkpoint_policy"].clone())?;
    let source =
        crony_domain::SourceVerification::from_payload(metadata).map_err(anyhow::Error::msg)?;
    let full: VerificationPolicy = serde_json::from_value(metadata["verification_policy"].clone())?;
    let report = &metadata["checkpoint_report"];
    policy
        .validate_report(&full, report)
        .map_err(anyhow::Error::msg)?;
    // The final verifier measures its own candidate commit and ignored inputs.
    // Match its actual complete identity across the event and rows, then bind the
    // canonical tree/base to this checkpoint. Never manufacture a final identity
    // by substituting the export commit into the focused verifier identity.
    let final_source = final_event
        .and_then(|(_, payload)| crony_domain::SourceVerification::from_payload(payload).ok())
        .filter(|observed| {
            observed.tree == source.tree && observed.base_commit == source.base_commit
        });
    let final_results = full
        .checks
        .iter()
        .enumerate()
        .map(|(index, check)| {
            let observed = evidence
                .iter()
                .filter(|row| row.index == index as i32)
                .collect::<Vec<_>>();
            match (final_source.as_ref(), observed.as_slice()) {
                (Some(source), [row])
                    if row.kind == check.kind()
                        && matches!(row.status.as_str(), "passed" | "failed")
                        && serde_json::from_value::<crony_domain::SourceVerification>(
                            row.payload["source"].clone(),
                        )
                        .ok()
                        .as_ref()
                            == Some(source) =>
                {
                    Some(row.status.as_str())
                }
                _ => None,
            }
        })
        .collect::<Vec<_>>();
    let final_passed = final_event.is_some_and(|(kind, _)| kind == "run.verification_passed")
        && final_source.is_some()
        && evidence.len() == full.checks.len()
        && final_results.iter().all(|status| *status == Some("passed"));
    let final_status = if final_passed {
        "passed"
    } else if final_event.is_some_and(|(kind, _)| kind == "run.verification_failed") {
        if final_source.is_some() {
            "failed"
        } else {
            "pending; final attempt failed without matching source evidence"
        }
    } else {
        "pending"
    };
    let mut body = format!(
        "Active checkpoint for {}.\n\nThis draft preserves work before full verification. It is not ready for review or merge.\n\n\
         Mission: {}\nRun: {}\nCommit: {}\nArtifact SHA-256: {}\n\n\
         Observed gates for this source:\n\n| Gate | Result |\n| --- | --- |\n",
        item.source_issue_url,
        item.mission_id.context("checkpoint mission missing")?,
        run_id,
        metadata["head_commit"]
            .as_str()
            .context("checkpoint head missing")?,
        artifact_sha256
    );
    for (index, check) in full.checks.iter().enumerate() {
        let status = final_results[index].unwrap_or_else(|| {
            if policy.check_indices.contains(&index) {
                "passed (focused checkpoint only)"
            } else {
                "pending"
            }
        });
        body.push_str(&format!("| {} ({}) | {status} |\n", index, check.kind()));
    }
    let manual_status = if full.manual_gate.is_none() {
        "not required by the persisted verifier policy"
    } else if final_passed {
        match review {
            Some("approved") => "approved",
            Some("rejected") => "rejected",
            _ => "pending",
        }
    } else {
        "pending"
    };
    body.push_str(&format!(
        "| Complete immutable verification policy | {final_status} |\n\
        | Persisted manual verification gate | {manual_status} |\n| Run state | {run_status} |\n"
    ));
    body.push_str("| Ready-for-review authorization | separate final publication required |\n\
        | Merge authorization | not granted |\n\
        | Deployment authorization | not granted |\n\nAuto-merge is disabled. This is a source-bound snapshot, not an acceptance receipt.\n");
    body.push_str(&format!(
        "\nFocused verifier candidate: {}\nFocused ignored-input SHA-256: {}\n",
        source.candidate_commit, source.ignored_input_sha256
    ));
    if let Some(source) = final_source {
        body.push_str(&format!(
            "\nFinal verifier candidate: {}\nFinal ignored-input SHA-256: {}\n",
            source.candidate_commit, source.ignored_input_sha256
        ));
    }
    Ok(body)
}

fn operation_snapshot(request: &ActiveCheckpointRequest) -> Result<Value> {
    let mut snapshot = serde_json::to_value(request)?;
    snapshot
        .as_object_mut()
        .expect("request object")
        .remove("publisher_token");
    snapshot["publisher_token_sha256"] = request
        .publisher_token
        .map(|token| json!(hex::encode(Sha256::digest(token.as_bytes()))))
        .unwrap_or(Value::Null);
    Ok(snapshot)
}

fn apply_action(
    p: &mut ActiveCheckpointPublication,
    action: &ActiveCheckpointAction,
    item: &FactoryWorkItem,
) -> Result<()> {
    match action {
        ActiveCheckpointAction::Acquire | ActiveCheckpointAction::Renew => {
            p.failure_detail = None;
        }
        ActiveCheckpointAction::BranchPushed {
            commit_sha,
            base_ref,
        } => {
            if p.phase != "pending" || commit_sha != &p.commit_sha {
                return Err(anyhow!(
                    "conflict: checkpoint branch proof does not match pending source"
                ));
            }
            validate_resolved_base(p, base_ref)?;
            p.pull_request_base_ref = Some(base_ref.clone());
            p.phase = "branch_pushed".into();
        }
        ActiveCheckpointAction::DraftPublished {
            number,
            node_id,
            url,
            head_sha,
            head_ref,
            base_ref,
            head_repository_owner,
            is_cross_repository,
            draft,
            state,
            auto_merge_enabled,
            title,
            body,
            evidence_comment,
        } => {
            let owner = p.target_repository.split('/').next().unwrap_or("");
            let refreshing = p.phase == "project_synchronized";
            let desired_text = title == &p.title && body == &p.body;
            let creation_text = title == &p.title && body == &p.initial_pull_request_body();
            let retained_text = p
                .pull_request
                .as_ref()
                .or(p.previous_pull_request.as_ref())
                .is_some_and(|previous| previous["title"] == *title && previous["body"] == *body);
            if let Some(comment) = evidence_comment {
                comment
                    .validate(&p.target_repository, *number, &p.evidence_body())
                    .map_err(anyhow::Error::msg)?;
            }
            if (!refreshing && p.phase != "branch_pushed")
                || *number <= 0
                || node_id.is_empty()
                || !publication::github_pull_request_url_matches(url, &p.target_repository, *number)
                || head_sha != &p.commit_sha
                || head_ref != &p.branch
                || Some(base_ref.as_str()) != p.pull_request_base_ref.as_deref()
                || !head_repository_owner.eq_ignore_ascii_case(owner)
                || *is_cross_repository
                || !*draft
                || !state.eq_ignore_ascii_case("open")
                || *auto_merge_enabled
                || (!desired_text
                    && (evidence_comment.is_none() || (!retained_text && !creation_text)))
                || p.previous_pull_request.as_ref().is_some_and(|previous| {
                    previous["number"] != *number || previous["node_id"] != *node_id
                })
                || p.pull_request.as_ref().is_some_and(|previous| {
                    previous["number"] != *number || previous["node_id"] != *node_id
                })
            {
                return Err(anyhow!(
                    "draft proof must match the exact authorized source, branch, PR and incomplete gates"
                ));
            }
            p.pull_request = Some(json!({"number":number,"node_id":node_id,"url":url,
                "head_sha":head_sha,"head_ref":head_ref,"base_ref":base_ref,"title":title,"body":body,
                "draft":true,"auto_merge_enabled":false,"state":"OPEN",
                "evidence_comment":evidence_comment}));
            if !refreshing {
                p.phase = "draft_published".into();
            }
        }
        ActiveCheckpointAction::ProjectSynchronized {
            status,
            field_id,
            option_id,
        } => {
            if p.phase != "draft_published"
                || status
                    != item.policy["publication"]["status_before"]
                        .as_str()
                        .unwrap_or("")
                || field_id.is_empty()
                || option_id.is_empty()
            {
                return Err(anyhow!(
                    "project synchronization requires a remote draft and the authorized in-progress status"
                ));
            }
            p.phase = "project_synchronized".into();
        }
        ActiveCheckpointAction::Failed { reason } => {
            p.failure_detail = Some(reason.message().to_owned());
        }
    }
    Ok(())
}

fn validate_resolved_base(p: &ActiveCheckpointPublication, base: &str) -> Result<()> {
    validate_factory_base_ref(base)?;
    if base == "HEAD"
        || base.starts_with("refs/")
        || base == p.branch
        || (p.base_ref != "HEAD"
            && p.base_ref
                .strip_prefix("refs/heads/")
                .unwrap_or(&p.base_ref)
                != base)
        || p.pull_request_base_ref
            .as_ref()
            .is_some_and(|previous| previous != base)
    {
        return Err(anyhow!(
            "checkpoint PR base must retain the explicit branch resolved from policy"
        ));
    }
    Ok(())
}

type PublicationRow = (ActiveCheckpointPublication, Uuid, Uuid, i64);
fn map_row(row: sqlx::postgres::PgRow) -> Result<PublicationRow> {
    Ok((
        serde_json::from_value(row.get("snapshot"))?,
        row.get("publisher_token"),
        row.get("lease_operation_id"),
        row.get("generation"),
    ))
}
async fn latest_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    item: Uuid,
) -> Result<Option<PublicationRow>> {
    sqlx::query("SELECT snapshot,publisher_token,lease_operation_id,generation FROM active_checkpoint_publications WHERE corp_id=$1 AND work_item_id=$2 ORDER BY generation DESC LIMIT 1 FOR UPDATE")
        .bind(corp).bind(item).fetch_optional(&mut **tx).await?.map(map_row).transpose()
}
async fn by_id_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    id: Uuid,
) -> Result<Option<PublicationRow>> {
    sqlx::query("SELECT snapshot,publisher_token,lease_operation_id,generation FROM active_checkpoint_publications WHERE corp_id=$1 AND id=$2 FOR UPDATE")
        .bind(corp).bind(id).fetch_optional(&mut **tx).await?.map(map_row).transpose()
}
async fn by_artifact_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    id: Uuid,
) -> Result<Option<PublicationRow>> {
    sqlx::query("SELECT snapshot,publisher_token,lease_operation_id,generation FROM active_checkpoint_publications WHERE corp_id=$1 AND artifact_id=$2 FOR UPDATE")
        .bind(corp).bind(id).fetch_optional(&mut **tx).await?.map(map_row).transpose()
}

pub(super) struct FinalCheckpointSource<'a> {
    pub task_id: Uuid,
    pub run_id: Uuid,
    pub commit: &'a str,
    pub branch: &'a str,
    pub metadata: &'a Value,
    pub verification_policy: &'a VerificationPolicy,
}

fn validate_final_source(
    checkpoint: &ActiveCheckpointPublication,
    item: &FactoryWorkItem,
    source: &FinalCheckpointSource<'_>,
) -> Result<()> {
    let focused = crony_domain::SourceVerification::from_payload(&checkpoint.metadata)
        .map_err(anyhow::Error::msg)?;
    let verified = crony_domain::SourceVerification::from_payload(source.metadata)
        .map_err(anyhow::Error::msg)?;
    let frozen_policy: VerificationPolicy =
        serde_json::from_value(checkpoint.metadata["verification_policy"].clone())?;
    if checkpoint.corp_id != item.corp_id
        || checkpoint.work_item_id != item.id
        || Some(checkpoint.mission_id) != item.mission_id
        || checkpoint.task_id != source.task_id
        || checkpoint.run_id != source.run_id
        || checkpoint.commit_sha != source.commit
        || checkpoint.metadata["head_commit"].as_str() != Some(source.commit)
        || source.metadata["head_commit"].as_str() != Some(source.commit)
        || checkpoint.metadata["branch"].as_str() != Some(source.branch)
        || source.metadata["branch"].as_str() != Some(source.branch)
        || focused.base_commit != verified.base_commit
        || focused.tree != verified.tree
        || frozen_policy != *source.verification_policy
    {
        return Err(anyhow!(
            "final source must retain the exact checkpoint task, run, commit, tree and verifier policy"
        ));
    }
    // Each invocation measures its own candidate and ignored inputs. Retain the
    // complete final identity rather than inventing one from the focused report.
    Ok(())
}

/// A draft cannot be replaced or silently acquired after final publication starts.
/// Legacy publications with no active checkpoint keep their existing contract.
pub(super) fn validate_frozen_provenance(
    provenance: &Value,
    checkpoint: Option<&ActiveCheckpointPublication>,
) -> Result<()> {
    let expected = serde_json::to_value(checkpoint)?;
    if provenance.get("active_checkpoint").unwrap_or(&Value::Null) != &expected {
        return Err(anyhow!(
            "conflict: final publication lost or changed its frozen active checkpoint provenance"
        ));
    }
    Ok(())
}

pub(super) async fn final_adoption_tx(
    tx: &mut Transaction<'_, Postgres>,
    item: &FactoryWorkItem,
    source: &FinalCheckpointSource<'_>,
    repository: &str,
    base_ref: &str,
    branch: &str,
) -> Result<Option<ActiveCheckpointPublication>> {
    let latest = latest_tx(tx, item.corp_id, item.id).await?.map(|row| row.0);
    if let Some(p) = &latest {
        validate_final_source(p, item, source)?;
        let desired = draft_body_tx(tx, item, p.run_id, &p.metadata, &p.artifact_sha256).await?;
        if !p.gates_synchronized()
            || p.branch != branch
            || p.target_repository != repository
            || p.base_ref != base_ref
            || p.body != desired
            || p.failure_detail.is_some()
            || p.lease_expires_at > Utc::now()
        {
            return Err(anyhow!(
                "final publication must adopt the exact draft checkpoint with current synchronized gates"
            ));
        }
    } else if ActiveCheckpointPolicy::from_factory_policy(&item.policy)
        .map_err(anyhow::Error::msg)?
        .is_some()
    {
        return Err(anyhow!(
            "final publication requires the authorized active checkpoint to be remotely durable first"
        ));
    }
    Ok(latest)
}
