use super::*;
use crony_domain::{PullRequestPublicationPlan, PullRequestPublicationPreview};

impl PgStore {
    pub async fn preview_pull_request_publication(
        &self,
        input: PreviewPullRequestPublicationInput,
    ) -> Result<PullRequestPublicationPreview> {
        let plan = normalize_request_plan(input.plan)?;
        let mut tx = self.pool.begin().await?;
        PgStore::ensure_audit_workflow_gates_tx(&mut tx, input.corp_id).await?;
        assert_actor_scope_tx(&mut tx, input.corp_id, input.actor_id).await?;
        ensure_actor_role_tx(&mut tx, input.corp_id, input.actor_id, &input.actor_role).await?;
        let prerequisites = validate_publication_prerequisites(
            &mut tx,
            &PublicationPrerequisiteRequest {
                corp_id: input.corp_id,
                work_item_id: input.work_item_id,
                source_deliverable_id: plan.source_deliverable_id,
                target_repository: &plan.target_repository,
                base_ref: &plan.base_ref,
                branch: &plan.branch,
                body: &plan.body,
            },
            false,
        )
        .await?;
        assert_room_membership_tx(
            &mut tx,
            input.corp_id,
            prerequisites.room_id,
            input.actor_id,
        )
        .await?;
        let preview = request_preview(&plan, &prerequisites, input.actor_id, &input.actor_role)?;
        tx.commit().await?;
        Ok(preview)
    }

    pub async fn request_pull_request_publication(
        &self,
        mut input: RequestPullRequestPublicationInput,
    ) -> Result<PullRequestPublicationOutcome> {
        input.preview.plan = normalize_request_plan(input.preview.plan)?;
        input.actor_role = normalize_factory_identifier(&input.actor_role, "actor role", 40)?;
        input.authorization_reason = normalize_factory_text(
            &input.authorization_reason,
            "publication authorization reason",
            2_000,
        )?;
        input.idempotency_key = normalize_factory_identifier(
            &input.idempotency_key,
            "publication idempotency key",
            500,
        )?;
        if input.authorization_id.is_nil() {
            return Err(anyhow!("publication authorization id must not be nil"));
        }
        let request = HumanPublicationRequest {
            schema_version: 1,
            kind: "human_requested".into(),
            corp_id: input.corp_id,
            work_item_id: input.work_item_id,
            actor_id: input.actor_id,
            actor_role: input.actor_role.clone(),
            preview: input.preview.clone(),
            authorization_id: input.authorization_id,
            authorization_reason: input.authorization_reason.clone(),
        };
        let operation_request = serde_json::to_value(&request)?;
        let effect_key = format!(
            "github-pr:{}:{}",
            input.work_item_id, input.preview.fingerprint
        );
        let plan = &input.preview.plan;
        let mut tx = self.pool.begin().await?;
        PgStore::ensure_audit_workflow_gates_tx(&mut tx, input.corp_id).await?;
        assert_actor_scope_tx(&mut tx, input.corp_id, input.actor_id).await?;
        ensure_actor_role_tx(&mut tx, input.corp_id, input.actor_id, &input.actor_role).await?;
        lock_factory_keys_tx(
            &mut tx,
            &[
                format!(
                    "publication:idempotency:{}:{}",
                    input.corp_id, input.idempotency_key
                ),
                format!(
                    "publication:factory:{}:{}",
                    input.corp_id, input.work_item_id
                ),
                format!("publication:effect:{}:{effect_key}", input.corp_id),
                format!(
                    "publication:branch:{}:{}:{}",
                    input.corp_id, plan.target_repository, plan.branch
                ),
            ],
        )
        .await?;
        let operation =
            publication_operation_tx(&mut tx, input.corp_id, &input.idempotency_key).await?;
        let existing = if let Some(operation) = &operation {
            ensure_publication_operation_matches(
                operation,
                "request",
                input.actor_id,
                None,
                &operation_request,
            )?;
            Some(
                publication_by_id_tx(&mut tx, input.corp_id, operation.publication_id, true)
                    .await?
                    .context("human publication request references a missing publication")?,
            )
        } else {
            publication_collision_tx(
                &mut tx,
                input.corp_id,
                input.work_item_id,
                &effect_key,
                &plan.target_repository,
                &plan.branch,
            )
            .await?
        };
        if let Some((publication, _)) = existing {
            let original = human_request_tx(&mut tx, &publication).await?.context(
                "conflict: existing publication was not requested through the human request route",
            )?;
            if original.actor_id != input.actor_id
                || original.actor_role != input.actor_role
                || original.preview != input.preview
                || original.work_item_id != input.work_item_id
            {
                return Err(anyhow!(
                    "conflict: request differs from the saved human publication intent"
                ));
            }
            assert_publication_room_membership_tx(&mut tx, &publication, input.actor_id).await?;
            // A completed readback grants no effect authority. Active intent must
            // still match the exact policy, authorizer and verified source.
            if publication.state != PullRequestPublicationState::Published {
                revalidate_human_request_tx(&mut tx, &publication, &original).await?;
            }
            if operation.is_none() {
                record_publication_operation_tx(
                    &mut tx,
                    NewPublicationOperation {
                        corp_id: input.corp_id,
                        idempotency_key: &input.idempotency_key,
                        publication_id: publication.id,
                        actor_id: input.actor_id,
                        operation: "request",
                        resulting_version: publication.version,
                        publisher_token: None,
                        request: &operation_request,
                    },
                )
                .await?;
            }
            tx.commit().await?;
            return Ok(PullRequestPublicationOutcome {
                publication,
                publisher_token: None,
                events: Vec::new(),
                replayed: true,
                busy: false,
            });
        }
        let prerequisites = validate_publication_prerequisites(
            &mut tx,
            &PublicationPrerequisiteRequest {
                corp_id: input.corp_id,
                work_item_id: input.work_item_id,
                source_deliverable_id: plan.source_deliverable_id,
                target_repository: &plan.target_repository,
                base_ref: &plan.base_ref,
                branch: &plan.branch,
                body: &plan.body,
            },
            false,
        )
        .await?;
        lock_request_membership_tx(
            &mut tx,
            input.corp_id,
            input.actor_id,
            &input.actor_role,
            prerequisites.room_id,
        )
        .await?;
        if request_preview(plan, &prerequisites, input.actor_id, &input.actor_role)?
            != input.preview
        {
            return Err(anyhow!(
                "conflict: publication preview changed; review the current result before requesting publication"
            ));
        }
        let authorization = explicit_publication_authorization(
            input.actor_id,
            &input.actor_role,
            input.authorization_id,
            &input.authorization_reason,
            Utc::now(),
        );
        let mut provenance =
            publication_provenance(&prerequisites, plan, &effect_key, &authorization);
        provenance["intent"] = operation_request.clone();
        let row = sqlx::query(&format!(
            r#"
            INSERT INTO pull_request_publications
                (id, corp_id, factory_work_item_id, mission_id, source_deliverable_id,
                 artifact_id, task_id, run_id, source_issue_number, source_issue_url,
                 target_repository, base_ref, branch, commit_sha, title, body,
                 actor_id, authorization_id, authorization_snapshot, effect_key, idempotency_key,
                 state, version, attempt_count, project_owner, project_number,
                 project_item_id, project_status_before, provenance)
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19, $20, $21, 'requested', 1, 0,
                 $22, $23, $24, $25, $26)
            RETURNING {}
        "#,
            publication_returning_columns()
        ))
        .bind(Uuid::new_v4())
        .bind(input.corp_id)
        .bind(input.work_item_id)
        .bind(prerequisites.mission_id)
        .bind(plan.source_deliverable_id)
        .bind(prerequisites.artifact_id)
        .bind(prerequisites.task_id)
        .bind(prerequisites.run_id)
        .bind(prerequisites.work_item.source_issue_number)
        .bind(&prerequisites.work_item.source_issue_url)
        .bind(&plan.target_repository)
        .bind(&plan.base_ref)
        .bind(&plan.branch)
        .bind(&prerequisites.commit_sha)
        .bind(&plan.title)
        .bind(&plan.body)
        .bind(input.actor_id)
        .bind(input.authorization_id)
        .bind(&authorization)
        .bind(&effect_key)
        .bind(&input.idempotency_key)
        .bind(&prerequisites.work_item.source_project_owner)
        .bind(prerequisites.work_item.source_project_number)
        .bind(&prerequisites.work_item.source_project_item_id)
        .bind(&prerequisites.project_status_before)
        .bind(&provenance)
        .fetch_one(&mut *tx)
        .await?;
        let publication = map_pull_request_publication(row)?;
        record_publication_operation_tx(
            &mut tx,
            NewPublicationOperation {
                corp_id: input.corp_id,
                idempotency_key: &input.idempotency_key,
                publication_id: publication.id,
                actor_id: input.actor_id,
                operation: "request",
                resulting_version: publication.version,
                publisher_token: None,
                request: &operation_request,
            },
        )
        .await?;
        let event = publication_event_tx(
            &mut tx,
            &publication,
            input.actor_id,
            "factory.publication_requested",
            json!({
                "factory_work_item_id": publication.factory_work_item_id,
                "source_deliverable_id": publication.source_deliverable_id,
                "state": "requested", "attempt": 0, "intent_kind": "human_requested",
                "auto_merge": false, "merge": false, "deploy": false,
            }),
        )
        .await?;
        tx.commit().await?;
        Ok(PullRequestPublicationOutcome {
            publication,
            publisher_token: None,
            events: event.into_iter().collect(),
            replayed: false,
            busy: false,
        })
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HumanPublicationRequest {
    schema_version: u32,
    kind: String,
    corp_id: Uuid,
    work_item_id: Uuid,
    pub(super) actor_id: Uuid,
    pub(super) actor_role: String,
    pub(super) preview: PullRequestPublicationPreview,
    pub(super) authorization_id: Uuid,
    pub(super) authorization_reason: String,
}

pub(super) async fn human_request_tx(
    tx: &mut Transaction<'_, Postgres>,
    publication: &PullRequestPublication,
) -> Result<Option<HumanPublicationRequest>> {
    let operation =
        publication_operation_tx(tx, publication.corp_id, &publication.idempotency_key).await?;
    let Some(intent) = publication.provenance.get("intent") else {
        // Absence cannot downgrade queued intent into the direct CLI path. The
        // latter has its own original, token-bearing start operation.
        if !operation.as_ref().is_some_and(|value| {
            value.operation == "start"
                && value.publication_id == publication.id
                && value.actor_id == publication.actor_id
                && value.resulting_version == 1
                && value.publisher_token.is_some()
        }) || publication.attempt_count == 0
        {
            return Err(anyhow!(
                "forbidden: publication omitted its saved human request provenance"
            ));
        }
        return Ok(None);
    };
    let request: HumanPublicationRequest = serde_json::from_value(intent.clone())
        .context("forbidden: malformed human publication request provenance")?;
    let operation =
        operation.context("forbidden: human publication request operation is missing")?;
    ensure_publication_operation_matches(
        &operation,
        "request",
        publication.actor_id,
        None,
        intent,
    )?;
    let plan = &request.preview.plan;
    let authorized_at: chrono::DateTime<Utc> = serde_json::from_value(
        publication
            .authorization_snapshot
            .get("authorized_at")
            .cloned()
            .unwrap_or(Value::Null),
    )
    .context("forbidden: human publication authorization omitted its timestamp")?;
    let expected_authorization = explicit_publication_authorization(
        request.actor_id,
        &request.actor_role,
        request.authorization_id,
        &request.authorization_reason,
        authorized_at,
    );
    if request.schema_version != 1
        || request.kind != "human_requested"
        || request.corp_id != publication.corp_id
        || request.work_item_id != publication.factory_work_item_id
        || request.actor_id != publication.actor_id
        || request.authorization_id != publication.authorization_id
        || operation.publication_id != publication.id
        || operation.resulting_version != 1
        || operation.publisher_token.is_some()
        || plan.source_deliverable_id != publication.source_deliverable_id
        || plan.target_repository != publication.target_repository
        || plan.base_ref != publication.base_ref
        || plan.branch != publication.branch
        || plan.title != publication.title
        || plan.body != publication.body
        || request.preview.commit_sha != publication.commit_sha
        || publication.effect_key
            != format!(
                "github-pr:{}:{}",
                publication.factory_work_item_id, request.preview.fingerprint
            )
        || publication.authorization_snapshot != expected_authorization
        || publication.provenance.get("authorization_snapshot") != Some(&expected_authorization)
    {
        return Err(anyhow!(
            "forbidden: human publication request does not match its durable authority and plan"
        ));
    }
    Ok(Some(request))
}

pub(super) async fn revalidate_human_request_tx(
    tx: &mut Transaction<'_, Postgres>,
    publication: &PullRequestPublication,
    request: &HumanPublicationRequest,
) -> Result<()> {
    let prerequisites = validate_publication_prerequisites(
        tx,
        &PublicationPrerequisiteRequest::from_publication(publication),
        true,
    )
    .await?;
    revalidate_human_request_prerequisites_tx(tx, publication, request, &prerequisites).await
}

pub(super) fn ensure_human_request_matches_start(
    request: &HumanPublicationRequest,
    input: &StartPullRequestPublicationInput,
) -> Result<()> {
    if request.actor_id != input.actor_id
        || request.actor_role != input.actor_role
        || request.authorization_id != input.authorization_id
        || request.authorization_reason != input.authorization_reason
    {
        return Err(anyhow!(
            "forbidden: publisher cannot replace the saved human publication authorization"
        ));
    }
    Ok(())
}

pub(super) async fn revalidate_human_request_prerequisites_tx(
    tx: &mut Transaction<'_, Postgres>,
    publication: &PullRequestPublication,
    request: &HumanPublicationRequest,
    prerequisites: &PublicationPrerequisites,
) -> Result<()> {
    lock_request_membership_tx(
        tx,
        publication.corp_id,
        request.actor_id,
        &request.actor_role,
        prerequisites.room_id,
    )
    .await?;
    if request_preview(
        &request.preview.plan,
        prerequisites,
        request.actor_id,
        &request.actor_role,
    )? != request.preview
    {
        return Err(admission::denied(
            "conflict: saved human publication intent no longer matches current authority, policy or verified source",
        ));
    }
    Ok(())
}

async fn lock_request_membership_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    actor_id: Uuid,
    expected_role: &str,
    room_id: Uuid,
) -> Result<()> {
    let role: Option<String> = sqlx::query_scalar(
        r#"
        SELECT actor.role FROM actors actor
        JOIN room_memberships membership ON membership.actor_id = actor.id
        JOIN rooms room ON room.id = membership.room_id AND room.corp_id = actor.corp_id
        WHERE actor.id = $1 AND actor.corp_id = $2 AND actor.kind = 'human' AND room.id = $3
        FOR SHARE OF actor, membership
    "#,
    )
    .bind(actor_id)
    .bind(corp_id)
    .bind(room_id)
    .fetch_optional(&mut **tx)
    .await?;
    if role.as_deref() != Some(expected_role)
        || !matches!(expected_role, "owner" | "admin" | "manager")
    {
        return Err(admission::denied(
            "forbidden: current human room membership and Publish permission are required",
        ));
    }
    Ok(())
}

fn normalize_request_plan(
    mut plan: PullRequestPublicationPlan,
) -> Result<PullRequestPublicationPlan> {
    let parts = plan.target_repository.trim().split('/').collect::<Vec<_>>();
    let [owner, repository] = parts.as_slice() else {
        return Err(anyhow!(
            "publication target repository must use owner/name form"
        ));
    };
    plan.target_repository = format!(
        "{}/{}",
        normalize_github_component(owner, "publication repository owner", 100)?,
        normalize_github_component(repository, "publication repository name", 100)?
    );
    plan.base_ref = normalize_factory_identifier(&plan.base_ref, "publication base ref", 240)?;
    validate_factory_base_ref(&plan.base_ref)?;
    plan.branch = normalize_factory_identifier(&plan.branch, "publication branch", 500)?;
    validate_factory_branch_ref(&plan.branch)?;
    if plan.branch == plan.base_ref {
        return Err(anyhow!(
            "publication branch must differ from the target base ref"
        ));
    }
    plan.title = normalize_factory_text(&plan.title, "pull request title", 256)?;
    plan.body = normalize_publication_body(&plan.body)?;
    Ok(plan)
}

fn request_preview(
    plan: &PullRequestPublicationPlan,
    prerequisites: &PublicationPrerequisites,
    actor_id: Uuid,
    actor_role: &str,
) -> Result<PullRequestPublicationPreview> {
    // State/attempt versions advance during delivery. Bind the immutable plan and
    // the actual authority, policy and verified source, not a publisher's lease.
    let binding = json!({
        "schema_version": 1,
        "corp_id": prerequisites.work_item.corp_id,
        "work_item_id": prerequisites.work_item.id,
        "actor_id": actor_id,
        "actor_role": actor_role,
        "plan": plan,
        "policy": prerequisites.work_item.policy,
        "source_revision": prerequisites.effective_source_revision,
        "claimed_revision": prerequisites.work_item.source_revision,
        "source_recovery_id": prerequisites.source_recovery_id,
        "mission_id": prerequisites.mission_id,
        "room_id": prerequisites.room_id,
        "artifact_id": prerequisites.artifact_id,
        "task_id": prerequisites.task_id,
        "run_id": prerequisites.run_id,
        "commit_sha": prerequisites.commit_sha,
        "artifact_sha256": prerequisites.deliverable_sha256,
        "verification_sha256": prerequisites.verification_sha256,
        "base_commit": prerequisites.base_commit,
        "source_branch": prerequisites.source_branch,
        "checkpoint": prerequisites.checkpoint.as_ref().map(|value| value.provenance()),
    });
    Ok(PullRequestPublicationPreview {
        plan: plan.clone(),
        commit_sha: prerequisites.commit_sha.clone(),
        artifact_sha256: prerequisites.deliverable_sha256.clone(),
        verification_sha256: prerequisites.verification_sha256.clone(),
        source_revision: prerequisites.effective_source_revision.clone(),
        fingerprint: hex::encode(Sha256::digest(serde_json::to_vec(&binding)?)),
    })
}
