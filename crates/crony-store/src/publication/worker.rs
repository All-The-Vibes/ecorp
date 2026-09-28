//! Workload access is limited to a persisted human request. The existing native
//! publication transactions remain the only way to acquire or advance a lease.
use super::*;

impl PgStore {
    pub async fn requested_publications_for_publisher(
        &self,
        scope: &PublicationPublisherScope,
        after: Option<Uuid>,
        limit: i64,
    ) -> Result<Vec<Uuid>> {
        if !(1..=100).contains(&limit) {
            return Err(anyhow!("publication queue limit must be between 1 and 100"));
        }
        let mut tx = self.pool.begin().await?;
        let repository = revalidate_publisher_repository_tx(&mut tx, scope).await?;
        // A failed attempt requires explicit recovery. Lease expiry after a
        // process crash remains recoverable through the normal start gate.
        let ids = sqlx::query_scalar(
            r#"
            SELECT id FROM pull_request_publications
            WHERE corp_id = $1 AND lower(target_repository) = lower($2)
              AND provenance->'intent'->>'kind' = 'human_requested'
              AND state <> 'published' AND failure_detail IS NULL
              AND (publisher_lease_expires_at IS NULL OR publisher_lease_expires_at <= now())
              AND ($3::uuid IS NULL OR id > $3)
            ORDER BY id LIMIT $4
            "#,
        )
        .bind(scope.corp_id)
        .bind(repository)
        .bind(after)
        .bind(limit)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(ids)
    }

    pub async fn human_requested_publication_for_publisher(
        &self,
        scope: &PublicationPublisherScope,
        publication_id: Uuid,
        artifact_control: Option<PublicationLeaseControl>,
    ) -> Result<HumanRequestedPublication> {
        let mut tx = self.pool.begin().await?;
        let (publication, token, intent) =
            human_requested_publication_tx(&mut tx, scope, publication_id).await?;
        if let Some(control) = artifact_control {
            ensure_active_publication_control_tx(
                &mut tx,
                &publication,
                token,
                ActivePublicationControl {
                    actor_id: intent.actor_id,
                    publisher_id: &scope.publisher_id,
                    presented_token: control.publisher_token,
                    expected_version: control.expected_version,
                    now: Utc::now(),
                },
            )
            .await?;
            revalidate_publication_authority_tx(&mut tx, &publication, intent.actor_id).await?;
        }
        tx.commit().await?;
        Ok(HumanRequestedPublication {
            publication,
            actor_role: intent.actor_role,
            authorization_reason: intent.authorization_reason,
        })
    }

    pub async fn human_requested_publication_context_for_publisher(
        &self,
        scope: &PublicationPublisherScope,
        publication_id: Uuid,
    ) -> Result<FactoryPublicationContext> {
        let mut tx = self.pool.begin().await?;
        let (publication, _, intent) =
            human_requested_publication_tx(&mut tx, scope, publication_id).await?;
        // The enrolled publisher may read this exact saved request after human
        // membership or role changes. Artifact access and every effect still
        // require the native active lease and current authority checks.
        let work_item = sqlx::query(
            r#"
            SELECT item.id, item.corp_id, item.source_kind, item.source_project_owner,
                   item.source_project_number, item.source_project_item_id,
                   item.source_repository_owner, item.source_repository_name,
                   item.source_issue_number, item.source_issue_node_id, item.source_issue_url,
                   item.source_title, item.source_revision, item.state, item.version,
                   item.claim_owner_id, item.lease_expires_at, item.policy, item.mission_id,
                   item.failure_detail, item.created_at, item.updated_at
            FROM factory_work_items item
            JOIN missions mission
              ON mission.id = item.mission_id AND mission.corp_id = item.corp_id
            WHERE item.id = $1 AND item.corp_id = $2 AND item.mission_id = $3
            "#,
        )
        .bind(publication.factory_work_item_id)
        .bind(scope.corp_id)
        .bind(publication.mission_id)
        .fetch_optional(&mut *tx)
        .await?
        .map(map_factory_work_item)
        .transpose()?
        .context("not found: requested publication context was not found")?;
        let repository = format!(
            "{}/{}",
            work_item.source_repository_owner, work_item.source_repository_name
        );
        if !publication
            .target_repository
            .eq_ignore_ascii_case(&repository)
        {
            return Err(anyhow!(
                "not found: requested publication context was not found"
            ));
        }
        let source = sqlx::query(
            r#"
            SELECT deliverable.id, deliverable.corp_id, deliverable.task_id,
                   deliverable.run_id, deliverable.artifact_id, deliverable.form,
                   deliverable.file_name, artifact.uri, artifact.sha256,
                   artifact.media_type, artifact.bytes, artifact.provenance_signature,
                   deliverable.verification_sha256, deliverable.base_commit,
                   deliverable.head_commit, deliverable.branch,
                   deliverable.integration_state, artifact.retention_until,
                   deliverable.created_at
            FROM source_deliverables deliverable
            JOIN artifacts artifact
              ON artifact.id = deliverable.artifact_id
             AND artifact.corp_id = deliverable.corp_id
             AND artifact.task_id = deliverable.task_id
             AND artifact.run_id = deliverable.run_id
             AND artifact.status = 'ready'
            JOIN runs run
              ON run.id = deliverable.run_id AND run.corp_id = deliverable.corp_id
             AND run.task_id = deliverable.task_id
            JOIN tasks task
              ON task.id = deliverable.task_id AND task.corp_id = deliverable.corp_id
            JOIN missions mission
              ON mission.id = task.mission_id AND mission.corp_id = deliverable.corp_id
            WHERE deliverable.corp_id = $1 AND deliverable.id = $2
              AND deliverable.artifact_id = $3 AND deliverable.task_id = $4
              AND deliverable.run_id = $5 AND mission.id = $6
            "#,
        )
        .bind(scope.corp_id)
        .bind(publication.source_deliverable_id)
        .bind(publication.artifact_id)
        .bind(publication.task_id)
        .bind(publication.run_id)
        .bind(publication.mission_id)
        .fetch_optional(&mut *tx)
        .await?
        .map(map_source_deliverable)
        .transpose()?
        .context("not found: requested publication source was not found")?;
        if source.head_commit.as_deref() != Some(publication.commit_sha.as_str())
            || source.sha256 != intent.preview.artifact_sha256
            || source.verification_sha256 != intent.preview.verification_sha256
        {
            return Err(anyhow!(
                "not found: requested publication source was not found"
            ));
        }
        tx.commit().await?;
        Ok(FactoryPublicationContext {
            work_item,
            publication: Some(publication),
            source_deliverables: vec![source],
        })
    }

    pub async fn claim_human_requested_publication(
        &self,
        scope: &PublicationPublisherScope,
        publication_id: Uuid,
        idempotency_key: String,
        lease_seconds: i64,
    ) -> Result<PullRequestPublicationOutcome> {
        let requested = self
            .human_requested_publication_for_publisher(scope, publication_id, None)
            .await?;
        let publication = requested.publication;
        // The native start transaction rechecks this exact intent, current human
        // authority, source/policy, credential, collision and fencing state.
        let input = normalize_start_input(StartPullRequestPublicationInput {
            corp_id: scope.corp_id,
            work_item_id: publication.factory_work_item_id,
            actor_id: publication.actor_id,
            actor_role: requested.actor_role,
            source_deliverable_id: publication.source_deliverable_id,
            target_repository: publication.target_repository,
            base_ref: publication.base_ref,
            branch: publication.branch,
            title: publication.title,
            body: publication.body,
            authorization_id: publication.authorization_id,
            authorization_reason: requested.authorization_reason,
            effect_key: publication.effect_key,
            idempotency_key,
            publisher_id: scope.publisher_id.clone(),
            publisher_credential_hash: scope.credential_hash.clone(),
            lease_seconds,
        })?;
        let mut tx = self.pool.begin().await?;
        // Native start locks the credential before the shared publication gates.
        // Keep that ordering when a worker and a direct claim run concurrently.
        revalidate_publisher_repository_tx(&mut tx, scope).await?;
        lock_publication_start_tx(&mut tx, &input).await?;
        // Re-read the exact authenticated request before deciding whether it can
        // be retired. The credential lock above remains held by this transaction.
        let (publication, _, intent) =
            human_requested_publication_tx(&mut tx, scope, publication_id).await?;
        ensure_publication_matches_start(&publication, &input)?;
        request::ensure_human_request_matches_start(&intent, &input)?;
        let operation_request = start_operation_request(&input);
        let operation =
            publication_operation_tx(&mut tx, scope.corp_id, &input.idempotency_key).await?;
        if let Some(operation) = &operation {
            ensure_publication_operation_matches(
                operation,
                "start",
                intent.actor_id,
                None,
                &operation_request,
            )?;
            if operation.publication_id != publication.id {
                return Err(anyhow!(
                    "conflict: publication claim key belongs to another request"
                ));
            }
        }
        if publication.state == PullRequestPublicationState::Published
            || publication.failure_detail.is_some()
        {
            tx.commit().await?;
            return Ok(PullRequestPublicationOutcome {
                publication,
                publisher_token: None,
                events: Vec::new(),
                replayed: true,
                busy: false,
            });
        }
        // A competing or replayed live claim retains the existing native lease
        // checks. Admission rejection must never terminate an active publisher.
        if publication
            .publisher_lease_expires_at
            .is_none_or(|expiry| expiry <= Utc::now())
            && let Err(error) =
                request::revalidate_human_request_tx(&mut tx, &publication, &intent).await
        {
            let Some(denial) = error.downcast_ref::<admission::Denied>() else {
                return Err(error);
            };
            let detail = format!("Saved human publication request rejected: {denial}");
            let rejected = fail_publication_tx(&mut tx, &publication, &detail).await?;
            if operation.is_none() {
                record_publication_operation_tx(
                    &mut tx,
                    NewPublicationOperation {
                        corp_id: scope.corp_id,
                        idempotency_key: &input.idempotency_key,
                        publication_id: rejected.id,
                        actor_id: intent.actor_id,
                        operation: "start",
                        resulting_version: rejected.version,
                        publisher_token: None,
                        request: &operation_request,
                    },
                )
                .await?;
            }
            let events = publication_event_tx(
                &mut tx,
                &rejected,
                intent.actor_id,
                "factory.publication_failed",
                json!({
                    "state": rejected.state.as_str(), "attempt": rejected.attempt_count,
                    "failure_detail": rejected.failure_detail, "admission": "rejected",
                    "publisher_id": scope.publisher_id,
                }),
            )
            .await?
            .into_iter()
            .collect();
            tx.commit().await?;
            return Ok(PullRequestPublicationOutcome {
                publication: rejected,
                publisher_token: None,
                events,
                replayed: false,
                busy: false,
            });
        }
        tx.commit().await?;
        // Recheck every native prerequisite after preflight; a concurrent change
        // never inherits authority from this earlier, non-authorizing read.
        self.start_pull_request_publication(input).await
    }
}

async fn human_requested_publication_tx(
    tx: &mut Transaction<'_, Postgres>,
    scope: &PublicationPublisherScope,
    publication_id: Uuid,
) -> Result<(
    PullRequestPublication,
    Option<Uuid>,
    request::HumanPublicationRequest,
)> {
    let repository = revalidate_publisher_repository_tx(tx, scope).await?;
    let (publication, token) = publication_by_id_tx(tx, scope.corp_id, publication_id, true)
        .await?
        .context("not found: requested publication was not found")?;
    if !publication
        .target_repository
        .eq_ignore_ascii_case(&repository)
    {
        return Err(anyhow!("not found: requested publication was not found"));
    }
    let intent = request::human_request_tx(tx, &publication)
        .await?
        .context("forbidden: workload access requires a saved human publication request")?;
    Ok((publication, token, intent))
}

async fn revalidate_publisher_repository_tx(
    tx: &mut Transaction<'_, Postgres>,
    scope: &PublicationPublisherScope,
) -> Result<String> {
    let repository = normalize_publication_repository(&scope.repository)?;
    let grant = revalidate_publication_publisher_credential_tx(
        tx,
        scope.corp_id,
        &scope.publisher_id,
        &scope.credential_hash,
    )
    .await?;
    grant.require_workload_target(&repository)?;
    Ok(repository)
}
