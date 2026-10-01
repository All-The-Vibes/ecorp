use super::*;
use crony_domain::{
    AuthorizeFactoryBaseRefresh, FactoryBaseRefresh, FactoryBaseRefreshResponse,
    SettleFactoryBaseRefresh,
};
use crony_protocol::BaseRefreshSource;
use crony_store::StoredArtifact;

pub(super) async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp, item)): Path<(Uuid, Uuid)>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<Vec<FactoryBaseRefresh>>, ApiError> {
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
            .factory_base_refreshes(corp, actor, item)
            .await
            .map_err(map_store_error)?,
    ))
}

pub(super) async fn authorize(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp, item)): Path<(Uuid, Uuid)>,
    Json(mut input): Json<AuthorizeFactoryBaseRefresh>,
) -> Result<Json<FactoryBaseRefreshResponse>, ApiError> {
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
        .authorize_factory_base_refresh(corp, item, input)
        .await
        .map_err(map_store_error)?;
    for event in &result.events {
        publish(&state, event.clone());
    }
    // The durable queue survives disconnect and a lost HTTP response. Native
    // dispatch errors are recorded on the refresh run, never on the old result.
    let runner: String =
        sqlx::query_scalar("SELECT runner_id FROM runs WHERE corp_id=$1 AND id=$2")
            .bind(corp)
            .bind(result.refresh.run_id)
            .fetch_one(state.store.pool())
            .await
            .map_err(ApiError::internal)?;
    dispatch_pending_runner_commands(&state, &runner)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(result))
}

pub(super) async fn settle(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp, item, refresh, action)): Path<(Uuid, Uuid, Uuid, String)>,
    Json(mut input): Json<SettleFactoryBaseRefresh>,
) -> Result<Json<FactoryBaseRefreshResponse>, ApiError> {
    let adopt = match action.as_str() {
        "adopt" => true,
        "abandon" => false,
        _ => return Err(ApiError::not_found("unknown base refresh action")),
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
        .settle_factory_base_refresh(corp, item, refresh, input, adopt)
        .await
        .map_err(map_store_error)?;
    for event in &result.events {
        publish(&state, event.clone());
    }
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    refresh_id: Uuid,
    corp_id: Uuid,
    room_id: Uuid,
    mission_id: Uuid,
    task_id: Uuid,
    run_id: Uuid,
    workspace_run_id: Uuid,
    agent_id: Uuid,
    assignment_token: Uuid,
    workspace_connection_id: Option<Uuid>,
    source_repository: String,
    source_base_ref: String,
    source_base_commit: String,
    workspace_base_commit: String,
    verification_policy: VerificationPolicy,
    write_scope: Vec<String>,
    deliverable: DeliverableSpec,
    provider_artifact: Option<VerificationArtifactReference>,
    base_refresh: BaseRefreshSource,
}

pub(super) fn supported(capabilities: &[RunnerCapability]) -> bool {
    [
        crony_domain::BASE_REFRESH_CAPABILITY,
        "durable-control-v1",
        "verification-artifact-transfer-v1",
        crony_domain::CANONICAL_SOURCE_VERIFICATION_CAPABILITY,
    ]
    .iter()
    .all(|name| {
        capabilities
            .iter()
            .any(|cap| cap.workspace_connection_id.is_none() && cap.name == *name && cap.available)
    })
}

fn same_artifact(left: &StoredArtifact, right: &StoredArtifact) -> bool {
    left.id == right.id
        && left.corp_id == right.corp_id
        && left.task_id == right.task_id
        && left.run_id == right.run_id
        && left.sha256 == right.sha256
        && left.bytes == right.bytes
        && left.media_type == right.media_type
        && left.producer_agent_id == right.producer_agent_id
        && left.producer_runner_id == right.producer_runner_id
        && left.object_key == right.object_key
        && left.provenance_signature == right.provenance_signature
        && left.artifact_role == right.artifact_role
        && left.metadata == right.metadata
}

pub(super) async fn hydrate(
    state: &AppState,
    artifact: &StoredArtifact,
    reference: &mut VerificationArtifactReference,
) -> anyhow::Result<()> {
    validate_verification_artifact_reference(reference)?;
    anyhow::ensure!(
        reference.sha256 == artifact.sha256
            && usize::try_from(artifact.bytes).ok() == Some(reference.bytes)
            && reference.media_type == artifact.media_type,
        "refresh reference does not match its exact stored artifact"
    );
    let bytes = state
        .artifacts
        .read_verified_bounded(artifact, crony_protocol::MAX_VERIFICATION_ARTIFACT_BYTES)
        .await?;
    reference.data_base64 = Some(BASE64.encode(bytes));
    Ok(())
}

pub(super) async fn decode(
    state: &AppState,
    command: &PendingRunnerCommand,
) -> anyhow::Result<Option<ServerToRunner>> {
    if !recovery_command_can_dispatch(state, command).await? {
        return Ok(None);
    }
    let mut payload: Payload = serde_json::from_value(command.payload.clone())
        .context("decode exact base refresh command")?;
    anyhow::ensure!(
        payload.refresh_id == payload.base_refresh.refresh_id
            && payload.corp_id == command.corp_id
            && payload.run_id == command.run_id
            && payload.workspace_run_id == payload.run_id
            && payload.workspace_base_commit == payload.source_base_commit,
        "base refresh command scope mismatch"
    );
    anyhow::ensure!(
        state
            .runners
            .get(&command.runner_id)
            .is_some_and(|runner| runner.corp_id == command.corp_id
                && runner.dispatch_ready
                && supported(&runner.capabilities)),
        "runner lacks governed base-refresh, canonical verification or artifact-transfer support"
    );
    let Some((bundle, provider)) = state.store.base_refresh_dispatch_artifacts(command).await?
    else {
        if !recovery_command_can_dispatch(state, command).await? {
            return Ok(None);
        }
        anyhow::bail!("base refresh authorization is no longer current");
    };
    hydrate(state, &bundle, &mut payload.base_refresh.artifact).await?;
    match (&provider, &mut payload.provider_artifact) {
        (Some(artifact), Some(reference)) => hydrate(state, artifact, reference).await?,
        (None, None) => {}
        _ => anyhow::bail!("base refresh provider evidence has no exact inherited authority"),
    }
    let Some((current_bundle, current_provider)) =
        state.store.base_refresh_dispatch_artifacts(command).await?
    else {
        if !recovery_command_can_dispatch(state, command).await? {
            return Ok(None);
        }
        anyhow::bail!("base refresh authority changed during artifact transfer");
    };
    anyhow::ensure!(
        same_artifact(&bundle, &current_bundle)
            && match (&provider, &current_provider) {
                (Some(before), Some(after)) => same_artifact(before, after),
                (None, None) => true,
                _ => false,
            },
        "base refresh artifact provenance changed during transfer"
    );
    Ok(Some(ServerToRunner::VerifyRun {
        command_id: command.id,
        corp_id: payload.corp_id,
        room_id: payload.room_id,
        mission_id: payload.mission_id,
        task_id: payload.task_id,
        run_id: payload.run_id,
        workspace_run_id: payload.workspace_run_id,
        agent_id: payload.agent_id,
        assignment_token: payload.assignment_token,
        workspace_connection_id: payload.workspace_connection_id,
        source_repository: Some(payload.source_repository),
        source_base_ref: Some(payload.source_base_ref),
        source_base_commit: Some(payload.source_base_commit),
        workspace_base_commit: payload.workspace_base_commit,
        // These guards are assigned by native reconstruction of the authorized
        // delta before verification; they never describe the original checkout.
        expected_workspace_fingerprint: String::new(),
        expected_head_commit: None,
        checkpoint_verification: false,
        verification_policy: payload.verification_policy,
        write_scope: payload.write_scope,
        deliverable: Some(payload.deliverable),
        provider_artifact: payload.provider_artifact,
        retained_provider_receipt: None,
        base_refresh: Some(Box::new(payload.base_refresh)),
    }))
}
