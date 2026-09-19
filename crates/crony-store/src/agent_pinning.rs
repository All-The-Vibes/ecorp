use super::*;

#[derive(Debug, Clone)]
pub struct SetAgentPinInput {
    pub corp_id: Uuid,
    pub agent_id: Uuid,
    pub actor_id: Uuid,
    pub pinned: bool,
    pub expected_version: i64,
    pub idempotency_key: Uuid,
}

#[derive(Debug)]
pub struct SetAgentPinOutcome {
    pub agent_id: Uuid,
    pub pinned: bool,
    pub pin_version: i64,
    pub replayed: bool,
    pub event: Option<DomainEvent>,
}

impl PgStore {
    /// Retention preference only: no process, assignment, lease or recovery mutation.
    pub async fn set_agent_pin(&self, input: SetAgentPinInput) -> Result<SetAgentPinOutcome> {
        if input.expected_version < 0 || input.idempotency_key.is_nil() {
            return Err(anyhow!(
                "pin requires a nonnegative version and non-nil operation UUID"
            ));
        }
        let mut tx = self.pool.begin().await?;
        // Match Operate, retaining both human identity and current role on replay.
        sqlx::query_scalar::<_, bool>(
            "SELECT TRUE FROM actors WHERE id = $1 AND corp_id = $2
             AND kind = 'human' AND role IN ('owner', 'admin', 'manager', 'member') FOR SHARE",
        )
        .bind(input.actor_id)
        .bind(input.corp_id)
        .fetch_optional(&mut *tx)
        .await?
        .context("forbidden: actor cannot operate agents in this Corp")?;
        let key = format!("agent-pin:{}", input.idempotency_key);
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("{}:{key}", input.corp_id))
            .execute(&mut *tx)
            .await?;
        let agent = sqlx::query(
            "SELECT pinned, retired_at, mission_id FROM agents
             WHERE id = $1 AND corp_id = $2 FOR UPDATE",
        )
        .bind(input.agent_id)
        .bind(input.corp_id)
        .fetch_optional(&mut *tx)
        .await?
        .context("agent does not belong to the requested Corp")?;
        let mission_id: Option<Uuid> = agent.get("mission_id");
        let room_id = if let Some(mission_id) = mission_id {
            let room: Uuid =
                sqlx::query_scalar("SELECT room_id FROM missions WHERE id = $1 AND corp_id = $2")
                    .bind(mission_id)
                    .bind(input.corp_id)
                    .fetch_one(&mut *tx)
                    .await?;
            assert_room_membership_tx(&mut tx, input.corp_id, room, input.actor_id).await?;
            Some(room)
        } else {
            None
        };
        let request = json!({
            "agent_id": input.agent_id,
            "actor_id": input.actor_id,
            "pinned": input.pinned,
            "expected_version": input.expected_version,
        });
        if let Some(event) = sqlx::query(
            "SELECT aggregate_id, actor_id, type, aggregate_version, payload FROM events
             WHERE corp_id = $1 AND idempotency_key = $2",
        )
        .bind(input.corp_id)
        .bind(&key)
        .fetch_optional(&mut *tx)
        .await?
        {
            if event.get::<Uuid, _>("aggregate_id") != input.agent_id
                || event.get::<Option<Uuid>, _>("actor_id") != Some(input.actor_id)
                || !matches!(
                    event.get::<String, _>("type").as_str(),
                    "agent.pinned" | "agent.unpinned"
                )
                || event.get::<Value, _>("payload")["request"] != request
            {
                return Err(anyhow!(
                    "conflict: pin operation key was used for another request"
                ));
            }
            let result = SetAgentPinOutcome {
                agent_id: input.agent_id,
                pinned: input.pinned,
                pin_version: event.get("aggregate_version"),
                replayed: true,
                event: None,
            };
            tx.commit().await?;
            return Ok(result);
        }
        if agent
            .get::<Option<chrono::DateTime<Utc>>, _>("retired_at")
            .is_some()
        {
            return Err(anyhow!(
                "conflict: agent is retired; pinning cannot reactivate historical work"
            ));
        }
        let version: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(aggregate_version), 0) FROM events
             WHERE corp_id = $1 AND aggregate_id = $2 AND aggregate_type = 'agent'
               AND type IN ('agent.pinned', 'agent.unpinned')",
        )
        .bind(input.corp_id)
        .bind(input.agent_id)
        .fetch_one(&mut *tx)
        .await?;
        if input.expected_version != version {
            return Err(anyhow!(
                "conflict: agent pin version changed; refresh before a new operation"
            ));
        }
        let next_version = version
            .checked_add(1)
            .context("agent pin version exhausted")?;
        let previous_pinned: bool = agent.get("pinned");
        sqlx::query("UPDATE agents SET pinned = $1 WHERE id = $2 AND corp_id = $3")
            .bind(input.pinned)
            .bind(input.agent_id)
            .bind(input.corp_id)
            .execute(&mut *tx)
            .await?;
        let event = append_event_tx(
            &mut tx,
            NewEvent {
                room_id,
                correlation_id: mission_id,
                aggregate_version: next_version,
                ..NewEvent::new(
                    input.corp_id,
                    Some(input.actor_id),
                    if input.pinned {
                        "agent.pinned"
                    } else {
                        "agent.unpinned"
                    },
                    "agent",
                    input.agent_id,
                    key,
                    json!({
                        "request": request,
                        "mission_id": mission_id,
                        "previous_pinned": previous_pinned,
                        "pinned": input.pinned,
                        "pin_version": next_version,
                    }),
                )
            },
        )
        .await?
        .context("pin event unexpectedly existed")?;
        tx.commit().await?;
        Ok(SetAgentPinOutcome {
            agent_id: input.agent_id,
            pinned: input.pinned,
            pin_version: next_version,
            replayed: false,
            event: Some(event),
        })
    }
}

#[cfg(test)]
mod tests;
