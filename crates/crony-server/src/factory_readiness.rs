use super::*;
use crony_protocol::FactoryDispatchReadiness;

/// Observe the constrained, authorized plan without reserving runners or writing state.
pub(super) fn observe(
    state: &AppState,
    corp_id: Uuid,
    plan: &TaskGraphPlan,
    active_checkpoint: bool,
) -> FactoryDispatchReadiness {
    for task in &plan.tasks {
        let mut requirements = RunnerRequirements::for_planned_task(task, plan);
        requirements.active_checkpoint = active_checkpoint;
        if select_runner(state, corp_id, &requirements).is_none() {
            // Diagnostics must not borrow capabilities from another account or an
            // unreconciled connection, even when the native selector rejects it.
            let capabilities = state
                .runners
                .iter()
                .filter(|entry| entry.corp_id == corp_id && entry.dispatch_ready)
                .flat_map(|entry| entry.capabilities.clone())
                .filter(|cap| cap.workspace_connection_id == requirements.workspace_connection_id)
                .collect::<Vec<_>>();
            return FactoryDispatchReadiness::NotReady {
                reason: format!(
                    "task {} {}{}",
                    task.key,
                    runner_requirement_mismatch(
                        &capabilities,
                        requirements.adapter,
                        requirements.model,
                        requirements.reasoning_effort,
                        requirements.source_repository,
                        requirements.source_base_ref,
                        requirements.source_base_commit,
                    ),
                    if active_checkpoint {
                        "; active checkpoints also require active-source-checkpoint-v1"
                    } else {
                        ""
                    }
                ),
            };
        }
    }
    FactoryDispatchReadiness::Ready
}
