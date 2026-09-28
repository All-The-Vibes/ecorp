//! Human intent and workload delivery share the native publication aggregate.
//! Workload routes derive authority from the saved intent and never accept a
//! caller-selected human, grant, source, or publication plan.
use super::*;
use crony_domain::{PullRequestPublicationPlan, PullRequestPublicationPreview};
use crony_protocol::publication_requests::*;
use crony_store::{
    PreviewPullRequestPublicationInput, PublicationLeaseControl, PublicationPublisherScope,
    RequestPullRequestPublicationInput,
};

pub fn human_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/corps/{corp_id}/factory/work-items/{work_item_id}/publication/preview",
            post(preview),
        )
        .route(
            "/api/corps/{corp_id}/factory/work-items/{work_item_id}/publication/request",
            post(request),
        )
        .layer(axum::middleware::map_response(no_store))
}

pub fn publisher_routes() -> Router<AppState> {
    Router::new()
        .route("/api/corps/{corp_id}/factory/publisher/queue", get(queue))
        .route(
            "/api/corps/{corp_id}/factory/publisher/publications/{publication_id}",
            get(context),
        )
        .route(
            "/api/corps/{corp_id}/factory/publisher/publications/{publication_id}/claim",
            post(claim),
        )
        .route(
            "/api/corps/{corp_id}/factory/publisher/publications/{publication_id}/renew",
            post(renew),
        )
        .route(
            "/api/corps/{corp_id}/factory/publisher/publications/{publication_id}/checkpoint",
            post(checkpoint),
        )
        .route(
            "/api/corps/{corp_id}/factory/publisher/publications/{publication_id}/artifact",
            post(artifact),
        )
        .layer(axum::middleware::map_response(no_store))
}

async fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

async fn human_role(
    state: &AppState,
    principal: &Principal,
    corp_id: Uuid,
    actor_id: Uuid,
) -> Result<String, ApiError> {
    authorize_actor(
        state,
        principal,
        corp_id,
        Some(actor_id),
        Permission::Publish,
    )
    .await?;
    Ok(state
        .store
        .human_authorization(corp_id, actor_id)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::forbidden("publication actor is not a human Corp member"))?
        .role)
}

async fn preview(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp_id, work_item_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<PreviewHumanPublicationRequest>,
) -> Result<Json<PullRequestPublicationPreview>, ApiError> {
    let actor_role = human_role(&state, &principal, corp_id, request.actor_id).await?;
    let context = state
        .store
        .factory_publication_context(corp_id, request.actor_id, work_item_id)
        .await
        .map_err(map_store_error)?
        .ok_or_else(|| ApiError::not_found("factory publication context was not found"))?;
    let source = context
        .source_deliverables
        .iter()
        .find(|source| source.id == request.source_deliverable_id)
        .ok_or_else(|| ApiError::not_found("selected source deliverable was not found"))?;
    let item = &context.work_item;
    let policy = item
        .policy
        .get("publication")
        .ok_or_else(|| ApiError::bad_request("factory policy does not authorize publication"))?;
    let base_ref = policy
        .get("base_ref")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ApiError::bad_request("publication policy omitted the base ref"))?;
    let prefix = policy
        .get("branch_prefix")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("ecorp/");
    let commit = source
        .head_commit
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("selected source has no verified commit"))?;
    let plan = PullRequestPublicationPlan {
        source_deliverable_id: source.id,
        target_repository: format!(
            "{}/{}",
            item.source_repository_owner, item.source_repository_name
        ),
        base_ref: base_ref.into(),
        branch: format!(
            "{prefix}issue-{}-{}",
            item.source_issue_number,
            commit.chars().take(12).collect::<String>()
        ),
        title: item.source_title.clone(),
        body: format!(
            "## ECorp verified result\n\nSource issue: {}\n\n- Factory work item: `{}`\n- Verified commit: `{commit}`\n- Deliverable digest: `{}`\n\nRequested for human review. Publication does not authorize merge or deployment.",
            item.source_issue_url, item.id, source.sha256
        ),
    };
    let preview = state
        .store
        .preview_pull_request_publication(PreviewPullRequestPublicationInput {
            corp_id,
            work_item_id,
            actor_id: request.actor_id,
            actor_role,
            plan,
        })
        .await
        .map_err(map_store_error)?;
    Ok(Json(preview))
}

// This is a replay identity, not a bearer grant. The store independently checks
// the authenticated human, exact preview, current authority and original intent.
fn request_identity(
    corp_id: Uuid,
    actor_id: Uuid,
    work_item_id: Uuid,
    fingerprint: &str,
) -> (Uuid, String) {
    let digest = Sha256::digest(format!(
        "ecorp:human-publication:v1:{corp_id}:{actor_id}:{work_item_id}:{fingerprint}"
    ));
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    (
        Uuid::from_bytes(bytes),
        format!("human-publication:{}", hex::encode(digest)),
    )
}

async fn request(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp_id, work_item_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<RequestHumanPublicationRequest>,
) -> Result<Json<PullRequestPublicationResponse>, ApiError> {
    let actor_role = human_role(&state, &principal, corp_id, request.actor_id).await?;
    let (authorization_id, idempotency_key) = request_identity(
        corp_id,
        request.actor_id,
        work_item_id,
        &request.preview.fingerprint,
    );
    let outcome = state
        .store
        .request_pull_request_publication(RequestPullRequestPublicationInput {
            corp_id,
            work_item_id,
            actor_id: request.actor_id,
            actor_role,
            preview: request.preview,
            authorization_id,
            idempotency_key,
            authorization_reason:
                "Requested publication of this exact verified result for human review in ECorp."
                    .into(),
        })
        .await
        .map_err(map_store_error)?;
    publish_publication_events(&state, &outcome);
    Ok(Json(publication_response(outcome)))
}

async fn publisher_scope(
    state: &AppState,
    headers: &HeaderMap,
    corp_id: Uuid,
    repository: String,
) -> Result<PublicationPublisherScope, ApiError> {
    let publisher = authenticate_publication_publisher(state, headers, corp_id).await?;
    let granted_repository = publisher.repository.ok_or_else(|| {
        ApiError::forbidden("publication workload access requires a repository grant")
    })?;
    if !granted_repository.eq_ignore_ascii_case(repository.trim()) {
        return Err(ApiError::forbidden(
            "publication publisher credential does not authorize this repository",
        ));
    }
    Ok(PublicationPublisherScope {
        corp_id,
        // Caller input selects a grant; it cannot establish one. Each store
        // transaction independently rechecks this exact credential's grant.
        repository: granted_repository,
        publisher_id: publisher.publisher_id,
        credential_hash: publisher.credential_hash,
    })
}

fn workload_error(error: anyhow::Error) -> ApiError {
    if error.to_string().starts_with("not found:") {
        ApiError::not_found(error)
    } else {
        map_store_error(error)
    }
}

async fn queue(
    State(state): State<AppState>,
    Path(corp_id): Path<Uuid>,
    Query(query): Query<PublisherQueueQuery>,
    headers: HeaderMap,
) -> Result<Json<PublisherQueueResponse>, ApiError> {
    let scope = publisher_scope(&state, &headers, corp_id, query.repository).await?;
    let publication_ids = state
        .store
        .requested_publications_for_publisher(&scope, query.after, query.limit)
        .await
        .map_err(workload_error)?;
    Ok(Json(PublisherQueueResponse {
        publisher_id: scope.publisher_id,
        publication_ids,
    }))
}

async fn context(
    State(state): State<AppState>,
    Path((corp_id, publication_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<PublisherRepositoryQuery>,
    headers: HeaderMap,
) -> Result<Json<RequestedPublicationContextResponse>, ApiError> {
    let scope = publisher_scope(&state, &headers, corp_id, query.repository).await?;
    let context = state
        .store
        .human_requested_publication_context_for_publisher(&scope, publication_id)
        .await
        .map_err(workload_error)?;
    Ok(Json(RequestedPublicationContextResponse {
        publisher_id: scope.publisher_id,
        context: FactoryPublicationContextResponse {
            work_item: context.work_item,
            publication: context.publication,
            source_deliverables: context.source_deliverables,
        },
    }))
}

async fn claim(
    State(state): State<AppState>,
    Path((corp_id, publication_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<ClaimRequestedPublicationRequest>,
) -> Result<Json<PullRequestPublicationResponse>, ApiError> {
    let scope = publisher_scope(&state, &headers, corp_id, request.repository).await?;
    let outcome = state
        .store
        .claim_human_requested_publication(
            &scope,
            publication_id,
            request.idempotency_key,
            request.lease_seconds,
        )
        .await
        .map_err(workload_error)?;
    publish_publication_events(&state, &outcome);
    Ok(Json(publication_response(outcome)))
}

async fn renew(
    State(state): State<AppState>,
    Path((corp_id, publication_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<RenewRequestedPublicationRequest>,
) -> Result<Json<PullRequestPublicationResponse>, ApiError> {
    let scope = publisher_scope(&state, &headers, corp_id, request.repository).await?;
    let requested = state
        .store
        .human_requested_publication_for_publisher(&scope, publication_id, None)
        .await
        .map_err(workload_error)?;
    let outcome = state
        .store
        .renew_pull_request_publication(RenewPullRequestPublicationInput {
            corp_id,
            publication_id,
            actor_id: requested.publication.actor_id,
            publisher_id: scope.publisher_id,
            publisher_credential_hash: scope.credential_hash,
            publisher_token: request.publisher_token,
            expected_version: request.expected_version,
            idempotency_key: request.idempotency_key,
            lease_seconds: request.lease_seconds,
        })
        .await
        .map_err(workload_error)?;
    publish_publication_events(&state, &outcome);
    Ok(Json(publication_response(outcome)))
}

async fn checkpoint(
    State(state): State<AppState>,
    Path((corp_id, publication_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<RequestedPublicationCheckpointRequest>,
) -> Result<Json<PullRequestPublicationResponse>, ApiError> {
    let scope = publisher_scope(&state, &headers, corp_id, request.repository).await?;
    let requested = state
        .store
        .human_requested_publication_for_publisher(&scope, publication_id, None)
        .await
        .map_err(workload_error)?;
    // The native transaction distinguishes failure-only cleanup from renewal
    // and effect advancement, including after the human's authority is revoked.
    let outcome = state
        .store
        .record_pull_request_publication_checkpoint(RecordPullRequestPublicationCheckpointInput {
            corp_id,
            publication_id,
            actor_id: requested.publication.actor_id,
            publisher_id: scope.publisher_id,
            publisher_credential_hash: scope.credential_hash,
            publisher_token: request.publisher_token,
            expected_version: request.expected_version,
            idempotency_key: request.idempotency_key,
            checkpoint: publication_checkpoint_input(request.checkpoint),
        })
        .await
        .map_err(workload_error)?;
    publish_publication_events(&state, &outcome);
    Ok(Json(publication_response(outcome)))
}

async fn artifact(
    State(state): State<AppState>,
    Path((corp_id, publication_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<RequestedPublicationArtifactRequest>,
) -> Result<Response, ApiError> {
    let scope = publisher_scope(&state, &headers, corp_id, request.repository).await?;
    let requested = state
        .store
        .human_requested_publication_for_publisher(
            &scope,
            publication_id,
            Some(PublicationLeaseControl {
                publisher_token: request.publisher_token,
                expected_version: request.expected_version,
            }),
        )
        .await
        .map_err(workload_error)?;
    let publication = requested.publication;
    let artifact = state
        .store
        .artifact_for_download(corp_id, publication.artifact_id, publication.actor_id)
        .await
        .map_err(workload_error)?
        .ok_or_else(|| ApiError::not_found("requested publication artifact was not found"))?;
    verified_artifact_response(&state, &artifact).await
}
