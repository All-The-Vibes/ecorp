use super::*;

pub(super) async fn inspect(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(corp_id): Path<Uuid>,
    Query(query): Query<SnapshotQuery>,
) -> Result<(HeaderMap, Json<serde_json::Value>), ApiError> {
    let actor_id = authorize_actor(
        &state,
        &principal,
        corp_id,
        Some(query.actor_id),
        Permission::Read,
    )
    .await?;
    let authority = state
        .store
        .factory_authority(corp_id, actor_id)
        .await
        .map_err(map_store_error)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok((
        headers,
        Json(json!({
            "authority": authority,
            "mode": if state.auth.mode() == ServerMode::Production { "production" } else { "development" },
            "new_claim_pin_required": state.auth.mode() == ServerMode::Production,
            "notice": "Only controllers using the same authenticated control plane, Corp and Project namespace share claim exclusion. An ID is not a lock across independent databases."
        })),
    ))
}

pub(super) async fn validate_controller(
    state: &AppState,
    corp_id: Uuid,
    actor_id: Uuid,
    expected: Option<Uuid>,
) -> Result<(), ApiError> {
    let Some(expected) = expected else {
        if state.auth.mode() == ServerMode::Production {
            return Err(ApiError::bad_request(
                "claim_authority_id is required for production controller registration",
            ));
        }
        return Ok(());
    };
    let actual = state
        .store
        .factory_authority(corp_id, actor_id)
        .await
        .map_err(map_store_error)?;
    if expected.is_nil() || expected != actual.claim_authority_id {
        return Err(ApiError::bad_request("factory claim authority mismatch"));
    }
    Ok(())
}
