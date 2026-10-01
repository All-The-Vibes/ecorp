//! Published corrections use authenticated Factory authority and native dispatch.
use super::*;
use crony_domain::{
    AuthorizeFactoryReviewRevision, FactoryReviewRevision, FactoryReviewRevisionResponse,
    SettleFactoryReviewRevision,
};
use crony_protocol::ReviewRevisionSource;
use crony_store::ReviewRevisionDispatch;

pub(super) async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp, item)): Path<(Uuid, Uuid)>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<Vec<FactoryReviewRevision>>, ApiError> {
    let actor = authorize_actor(
        &state,
        &principal,
        corp,
        Some(query.actor_id),
        Permission::Operate,
    )
    .await?;
    Ok(Json(
        state
            .store
            .factory_review_revisions(corp, actor, item)
            .await
            .map_err(map_store_error)?,
    ))
}

pub(super) async fn authorize(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp, item)): Path<(Uuid, Uuid)>,
    Json(mut input): Json<AuthorizeFactoryReviewRevision>,
) -> Result<Json<FactoryReviewRevisionResponse>, ApiError> {
    input.actor_id = authorize_actor(
        &state,
        &principal,
        corp,
        Some(input.actor_id),
        Permission::Recover,
    )
    .await?;
    let result = state
        .store
        .authorize_factory_review_revision(corp, item, input)
        .await
        .map_err(map_store_error)?;
    for event in &result.events {
        publish(&state, event.clone());
    }
    // The saved mission uses the ordinary explicit launch and resume APIs.
    Ok(Json(result))
}

pub(super) async fn settle(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp, item, revision, action)): Path<(Uuid, Uuid, Uuid, String)>,
    Json(mut input): Json<SettleFactoryReviewRevision>,
) -> Result<Json<FactoryReviewRevisionResponse>, ApiError> {
    let adopt = match action.as_str() {
        "adopt" => true,
        "abandon" => false,
        _ => return Err(ApiError::not_found("unknown review revision action")),
    };
    input.actor_id = authorize_actor(
        &state,
        &principal,
        corp,
        Some(input.actor_id),
        Permission::Recover,
    )
    .await?;
    let result = state
        .store
        .settle_factory_review_revision(corp, item, revision, input, adopt)
        .await
        .map_err(map_store_error)?;
    for event in &result.events {
        publish(&state, event.clone());
    }
    Ok(Json(result))
}

pub(super) fn supported(capabilities: &[RunnerCapability]) -> bool {
    [
        crony_domain::REVIEW_REVISION_CAPABILITY,
        "verification-artifact-transfer-v1",
        crony_domain::CANONICAL_SOURCE_VERIFICATION_CAPABILITY,
    ]
    .iter()
    .all(|name| {
        capabilities
            .iter()
            .any(|cap| cap.workspace_connection_id.is_none() && cap.available && cap.name == *name)
    })
}

pub(super) async fn prepare(
    state: &AppState,
    corp: Uuid,
    run: Uuid,
) -> anyhow::Result<(
    Option<ReviewRevisionDispatch>,
    Option<Box<ReviewRevisionSource>>,
)> {
    let result = async {
        let Some(grant) = state.store.review_revision_dispatch(corp, run).await? else {
            return Ok((None, None));
        };
        let mut source = grant.source.clone();
        anyhow::ensure!(
            source.artifact.path == grant.artifact.file_name,
            "correction artifact path mismatch"
        );
        factory_base_refresh::hydrate(state, &grant.artifact, &mut source.artifact).await?;
        anyhow::ensure!(
            state
                .store
                .review_revision_dispatch(corp, run)
                .await?
                .as_ref()
                == Some(&grant),
            "published correction authority changed during artifact transfer"
        );
        Ok((Some(grant), Some(Box::new(source))))
    }
    .await;
    if let Err(error) = &result {
        let events = state
            .store
            .fail_run_before_dispatch(
                corp,
                run,
                &format!("published correction source could not be verified: {error}"),
            )
            .await?;
        for event in events {
            publish(state, event);
        }
    }
    result
}
