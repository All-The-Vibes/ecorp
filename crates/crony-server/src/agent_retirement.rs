use super::*;
use crony_domain::{AgentRetirementMode, AgentRetirementTarget};
use crony_protocol::{AgentRetirementResponse, ClearCrewRequest, RetireAgentRequest};
use crony_store::RetireAgentsInput;

pub(super) async fn retire_agent(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp_id, agent_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<RetireAgentRequest>,
) -> Result<Json<AgentRetirementResponse>, ApiError> {
    retire(
        &state,
        &principal,
        RetireAgentsInput {
            corp_id,
            actor_id: request.actor_id,
            mode: AgentRetirementMode::Retire,
            targets: vec![AgentRetirementTarget {
                agent_id,
                expected_pin_version: request.expected_pin_version,
            }],
            idempotency_key: request.idempotency_key,
        },
    )
    .await
}

pub(super) async fn clear_crew(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(corp_id): Path<Uuid>,
    Json(request): Json<ClearCrewRequest>,
) -> Result<Json<AgentRetirementResponse>, ApiError> {
    retire(
        &state,
        &principal,
        RetireAgentsInput {
            corp_id,
            actor_id: request.actor_id,
            mode: AgentRetirementMode::Clear,
            targets: request.targets,
            idempotency_key: request.idempotency_key,
        },
    )
    .await
}

async fn retire(
    state: &AppState,
    principal: &Principal,
    mut input: RetireAgentsInput,
) -> Result<Json<AgentRetirementResponse>, ApiError> {
    input.actor_id = authorize_actor(
        state,
        principal,
        input.corp_id,
        Some(input.actor_id),
        Permission::Operate,
    )
    .await?;
    let outcome = state
        .store
        .retire_agents(input)
        .await
        .map_err(map_store_error)?;
    for event in outcome.events {
        publish(state, event);
    }
    Ok(Json(AgentRetirementResponse {
        results: outcome.results,
        replayed: outcome.replayed,
    }))
}

#[cfg(test)]
mod tests;
