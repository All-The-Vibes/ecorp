use super::*;
use crony_domain::{
    AgentRetirementBlocker, AgentRetirementMode, AgentRetirementResult, AgentRetirementStatus,
    AgentRetirementTarget, MAX_CLEAR_CREW_TARGETS,
};

#[derive(Debug, Clone)]
pub struct RetireAgentsInput {
    pub corp_id: Uuid,
    pub actor_id: Uuid,
    pub mode: AgentRetirementMode,
    pub targets: Vec<AgentRetirementTarget>,
    pub idempotency_key: Uuid,
}

#[derive(Debug)]
pub struct RetireAgentsOutcome {
    pub results: Vec<AgentRetirementResult>,
    pub replayed: bool,
    pub events: Vec<DomainEvent>,
}

impl PgStore {
    /// Retire identities only. Never stop runs, clear obligations, delete history,
    /// or resolve a roster selector after the operator's request was prepared.
    pub async fn retire_agents(&self, mut input: RetireAgentsInput) -> Result<RetireAgentsOutcome> {
        validate_request(&input)?;
        input.targets.sort_by_key(|target| target.agent_id);
        let digest = hex::encode(Sha256::digest(serde_json::to_vec(&json!({
            "corp_id": input.corp_id,
            "actor_id": input.actor_id,
            "mode": input.mode,
            "targets": input.targets,
        }))?));
        let prefix = format!("agent-retirement:{}:", input.idempotency_key);
        let mut tx = self.pool.begin().await?;
        sqlx::query_scalar::<_, bool>(
            "SELECT TRUE FROM actors WHERE id = $1 AND corp_id = $2
             AND kind = 'human' AND role IN ('owner', 'admin', 'manager', 'member') FOR SHARE",
        )
        .bind(input.actor_id)
        .bind(input.corp_id)
        .fetch_optional(&mut *tx)
        .await?
        .context("forbidden: actor cannot retire agents in this Corp")?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("{}:{prefix}", input.corp_id))
            .execute(&mut *tx)
            .await?;

        // Pin, dispatch, saved-plan creation and authority grants synchronize on
        // these rows. Stable order also serializes overlapping Clear requests.
        // Do not take mission/run row locks after these agent locks.
        let mut agents = Vec::with_capacity(input.targets.len());
        for target in &input.targets {
            let agent = sqlx::query(
                "SELECT pinned, retired_at, mission_id, current_run_id, status FROM agents
                 WHERE id = $1 AND corp_id = $2 FOR UPDATE",
            )
            .bind(target.agent_id)
            .bind(input.corp_id)
            .fetch_optional(&mut *tx)
            .await?
            .context("agent does not belong to the requested Corp")?;
            let mission_id: Option<Uuid> = agent.get("mission_id");
            let room_id = if let Some(mission_id) = mission_id {
                let room: Uuid = sqlx::query_scalar(
                    "SELECT room_id FROM missions WHERE id = $1 AND corp_id = $2",
                )
                .bind(mission_id)
                .bind(input.corp_id)
                .fetch_one(&mut *tx)
                .await?;
                assert_room_membership_tx(&mut tx, input.corp_id, room, input.actor_id).await?;
                Some(room)
            } else {
                None
            };
            agents.push((agent, mission_id, room_id));
        }

        // Only per-agent room-scoped outcomes enter the journal. A Corp-wide
        // Clear event containing the candidate list would disclose private rooms.
        // Each outcome binds the entire canonical request by an opaque digest.
        let recorded = sqlx::query(
            "SELECT aggregate_id, actor_id, type, payload FROM events
             WHERE corp_id = $1 AND idempotency_key LIKE $2 ORDER BY aggregate_id",
        )
        .bind(input.corp_id)
        .bind(format!("{prefix}%"))
        .fetch_all(&mut *tx)
        .await?;
        if !recorded.is_empty() {
            if recorded.len() != input.targets.len() {
                return Err(anyhow!(
                    "conflict: retirement key was used for another request"
                ));
            }
            let mut results = Vec::with_capacity(recorded.len());
            for (event, target) in recorded.iter().zip(&input.targets) {
                let payload: Value = event.get("payload");
                if event.get::<Uuid, _>("aggregate_id") != target.agent_id
                    || event.get::<Option<Uuid>, _>("actor_id") != Some(input.actor_id)
                    || !matches!(
                        event.get::<String, _>("type").as_str(),
                        "agent.retired" | "agent.retirement_checked"
                    )
                    || payload["request_digest"] != digest
                {
                    return Err(anyhow!(
                        "conflict: retirement key was used for another request"
                    ));
                }
                results.push(serde_json::from_value(payload["result"].clone())?);
            }
            tx.commit().await?;
            return Ok(RetireAgentsOutcome {
                results,
                replayed: true,
                events: vec![],
            });
        }

        let mut results = Vec::with_capacity(input.targets.len());
        let mut events = Vec::with_capacity(input.targets.len());
        for (target, (agent, mission_id, room_id)) in input.targets.iter().zip(agents) {
            let pin_version: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(aggregate_version), 0) FROM events
                 WHERE corp_id = $1 AND aggregate_id = $2 AND aggregate_type = 'agent'
                   AND type IN ('agent.pinned', 'agent.unpinned')",
            )
            .bind(input.corp_id)
            .bind(target.agent_id)
            .fetch_one(&mut *tx)
            .await?;
            let mut result = AgentRetirementResult {
                agent_id: target.agent_id,
                status: AgentRetirementStatus::AlreadyRetired,
                blockers: vec![],
                retired_at: agent.get("retired_at"),
                pinned: agent.get("pinned"),
                pin_version,
            };
            if result.retired_at.is_none() {
                if target.expected_pin_version != pin_version {
                    result
                        .blockers
                        .push(AgentRetirementBlocker::RetentionChanged);
                }
                if input.mode == AgentRetirementMode::Clear && result.pinned {
                    result.blockers.push(AgentRetirementBlocker::Pinned);
                }
                if agent.get::<Option<Uuid>, _>("current_run_id").is_some() {
                    result.blockers.push(AgentRetirementBlocker::CurrentRun);
                }
                if !matches!(
                    agent.get::<String, _>("status").as_str(),
                    "idle" | "offline"
                ) {
                    result.blockers.push(AgentRetirementBlocker::ActiveStatus);
                }
                // This statement sees fresh committed obligations after every
                // agent lock, including grants that finished while we waited.
                result
                    .blockers
                    .extend(obligations_tx(&mut tx, input.corp_id, target.agent_id).await?);
                result.status = if result.blockers.is_empty() {
                    result.retired_at = Some(
                        sqlx::query_scalar(
                            "UPDATE agents SET retired_at = now(), station = NULL
                         WHERE id = $1 AND corp_id = $2 RETURNING retired_at",
                        )
                        .bind(target.agent_id)
                        .bind(input.corp_id)
                        .fetch_one(&mut *tx)
                        .await?,
                    );
                    AgentRetirementStatus::Retired
                } else {
                    AgentRetirementStatus::Blocked
                };
            }
            let event = append_event_tx(
                &mut tx,
                NewEvent {
                    room_id,
                    correlation_id: mission_id,
                    ..NewEvent::new(
                        input.corp_id,
                        Some(input.actor_id),
                        if result.status == AgentRetirementStatus::Retired {
                            "agent.retired"
                        } else {
                            "agent.retirement_checked"
                        },
                        "agent",
                        target.agent_id,
                        format!("{prefix}{}", target.agent_id),
                        json!({
                            "mode": input.mode,
                            "request_digest": digest,
                            "target": target,
                            "mission_id": mission_id,
                            "result": result,
                        }),
                    )
                },
            )
            .await?
            .context("retirement outcome unexpectedly existed")?;
            results.push(result);
            events.push(event);
        }
        tx.commit().await?;
        Ok(RetireAgentsOutcome {
            results,
            replayed: false,
            events,
        })
    }
}

fn validate_request(input: &RetireAgentsInput) -> Result<()> {
    let mut ids = HashSet::new();
    if input.idempotency_key.is_nil()
        || input.targets.is_empty()
        || input.targets.len() > MAX_CLEAR_CREW_TARGETS
        || (input.mode == AgentRetirementMode::Retire && input.targets.len() != 1)
        || input.targets.iter().any(|target| {
            target.agent_id.is_nil()
                || target.expected_pin_version < 0
                || !ids.insert(target.agent_id)
        })
    {
        return Err(anyhow!(
            "retirement requires a non-nil operation UUID and 1..={MAX_CLEAR_CREW_TARGETS} distinct identities with nonnegative pin versions; Retire requires exactly one identity"
        ));
    }
    Ok(())
}

async fn obligations_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    agent_id: Uuid,
) -> Result<Vec<AgentRetirementBlocker>> {
    let row = sqlx::query(r#"
        SELECT
          EXISTS (SELECT 1 FROM tasks t JOIN missions m
            ON m.id = t.mission_id AND m.corp_id = t.corp_id
            WHERE t.assigned_agent_id = $1 AND t.corp_id = $2
              AND m.status IN ('draft', 'ready', 'running')
              AND t.status NOT IN ('completed', 'cancelled')) AS assigned_work,
          EXISTS (SELECT 1 FROM runs r WHERE r.agent_id = $1 AND r.corp_id = $2
            AND r.status IN ('provisioning', 'starting', 'running',
              'waiting_for_input', 'waiting_for_approval', 'verifying')) AS active_run,
          EXISTS (SELECT 1 FROM control_leases l WHERE l.agent_id = $1
            AND l.corp_id = $2 AND l.expires_at > now()) AS control_lease,
          EXISTS (SELECT 1 FROM queued_messages q WHERE q.agent_id = $1
            AND q.corp_id = $2 AND q.status IN ('queued', 'reserved', 'pending')) AS queued_message,
          EXISTS (SELECT 1 FROM action_approvals p JOIN runs r
            ON r.id = p.run_id AND r.corp_id = p.corp_id
            WHERE r.agent_id = $1 AND p.corp_id = $2 AND p.status = 'pending') AS pending_approval,
          EXISTS (SELECT 1 FROM verification_requests v JOIN runs r
            ON r.id = v.run_id AND r.corp_id = v.corp_id
            WHERE r.agent_id = $1 AND v.corp_id = $2 AND v.status = 'pending') AS pending_verification,
          EXISTS (SELECT 1 FROM runner_commands c JOIN runs r
            ON r.id = c.run_id AND r.corp_id = c.corp_id
            WHERE r.agent_id = $1 AND c.corp_id = $2 AND c.status = 'pending') AS runner_command,
          EXISTS (SELECT 1 FROM events e JOIN runs r
            ON r.id = e.aggregate_id AND r.corp_id = e.corp_id
            WHERE r.agent_id = $1 AND e.corp_id = $2
              AND e.type IN ('run.session', 'run.teardown_uncertain')
              AND NOT EXISTS (SELECT 1 FROM events done
                WHERE done.aggregate_id = r.id AND done.corp_id = $2
                  AND done.type = 'run.session_terminated' AND done.seq > e.seq)) AS provider_teardown
    "#)
    .bind(agent_id).bind(corp_id).fetch_one(&mut **tx).await?;
    Ok([
        ("assigned_work", AgentRetirementBlocker::AssignedWork),
        ("active_run", AgentRetirementBlocker::ActiveRun),
        ("control_lease", AgentRetirementBlocker::ControlLease),
        ("queued_message", AgentRetirementBlocker::QueuedMessage),
        ("pending_approval", AgentRetirementBlocker::PendingApproval),
        (
            "pending_verification",
            AgentRetirementBlocker::PendingVerification,
        ),
        ("runner_command", AgentRetirementBlocker::RunnerCommand),
        (
            "provider_teardown",
            AgentRetirementBlocker::ProviderTeardown,
        ),
    ]
    .into_iter()
    .filter_map(|(column, blocker)| row.get::<bool, _>(column).then_some(blocker))
    .collect())
}

/// Call with the agent row locked before admitting a new recovery run. Existing
/// automatic retirement remains recoverable; an operator's retirement does not.
pub(super) async fn ensure_not_manually_retired_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    agent_id: Uuid,
) -> Result<()> {
    let retired: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM agents a JOIN events e
           ON e.corp_id = a.corp_id AND e.aggregate_id = a.id
         WHERE a.id = $1 AND a.corp_id = $2 AND a.retired_at IS NOT NULL
           AND e.type = 'agent.retired' AND e.aggregate_type = 'agent'
           AND e.actor_id IS NOT NULL AND e.created_at = a.retired_at)",
    )
    .bind(agent_id)
    .bind(corp_id)
    .fetch_one(&mut **tx)
    .await?;
    if retired {
        return Err(anyhow!(
            "conflict: agent was manually retired; recovery cannot reactivate this identity"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
