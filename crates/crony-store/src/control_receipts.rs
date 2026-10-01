//! Socket send, runner receipt, and acknowledgment are distinct observations.
use super::*;

#[derive(Debug, Clone)]
pub struct RunnerCommandReceipt {
    pub corp_id: Uuid,
    pub connection_epoch: Uuid,
    pub runner_received_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RunnerCommandSocketSend {
    pub corp_id: Uuid,
    pub runner_id: String,
    pub connection_epoch: Uuid,
    pub command_id: Uuid,
    pub run_id: Uuid,
    pub sent_at: chrono::DateTime<Utc>,
}

pub(super) async fn validate_receipt_scope_tx(
    tx: &mut Transaction<'_, Postgres>,
    runner_id: &str,
    receipt: Option<&RunnerCommandReceipt>,
) -> Result<()> {
    if let Some(receipt) = receipt {
        // Serialize with reconnect/revocation rather than relying only on the
        // server's earlier in-memory connection check.
        sqlx::query(
            "SELECT id FROM runner_nodes WHERE id=$1 AND corp_id=$2
             AND connection_epoch=$3 AND status='connected' FOR SHARE",
        )
        .bind(runner_id)
        .bind(receipt.corp_id)
        .bind(receipt.connection_epoch)
        .fetch_optional(&mut **tx)
        .await?
        .context("command receipt does not match the current runner connection")?;
    }
    Ok(())
}

pub(super) fn bounded_detail(detail: &str) -> String {
    let mut result = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    while result.len() > 1_000 {
        result.pop();
    }
    result
}

pub(super) fn observation(
    receipt: Option<&RunnerCommandReceipt>,
    detail: &str,
    recorded_at: chrono::DateTime<Utc>,
) -> Value {
    let supplied_time = receipt.and_then(|receipt| receipt.runner_received_at.as_deref());
    let received_at = supplied_time
        .filter(|value| value.len() <= 64)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    json!({
        "detail": bounded_detail(detail),
        "connection_epoch": receipt.map(|receipt| receipt.connection_epoch),
        "runner_received_at": received_at,
        "runner_timestamp_valid": supplied_time.map(|_| received_at.is_some()),
        "server_acknowledged_at": recorded_at,
        "provider_termination_confirmed": false
    })
}

impl PgStore {
    pub async fn record_runner_command_socket_send(
        &self,
        input: RunnerCommandSocketSend,
    ) -> Result<Option<DomainEvent>> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT t.mission_id,m.room_id,c.payload
             FROM runner_commands c
             JOIN runs r ON r.id=c.run_id AND r.corp_id=c.corp_id AND r.runner_id=c.runner_id
             JOIN tasks t ON t.id=r.task_id AND t.corp_id=r.corp_id
             JOIN missions m ON m.id=t.mission_id AND m.corp_id=t.corp_id
             WHERE c.id=$1 AND c.corp_id=$2 AND c.runner_id=$3 AND c.run_id=$4
               AND c.command_kind='circuit_breaker'",
        )
        .bind(input.command_id)
        .bind(input.corp_id)
        .bind(&input.runner_id)
        .bind(input.run_id)
        .fetch_optional(&mut *tx)
        .await?
        .context("socket send does not match the durable control command")?;
        let payload: Value = row.get("payload");
        // The server captures authenticated socket identity before the send.
        // A delayed observation may outlive that epoch, so do not relabel it as
        // the runner's newer connection or drop it solely because of reconnect.
        let event = append_event_tx(
            &mut tx,
            NewEvent {
                room_id: Some(row.get("room_id")),
                correlation_id: Some(row.get("mission_id")),
                ..NewEvent::new(
                    input.corp_id,
                    None,
                    "runner.command_socket_sent",
                    "run",
                    input.run_id,
                    format!(
                        "runner-command-send:{}:{}",
                        input.command_id, input.connection_epoch
                    ),
                    json!({
                        "command_id": input.command_id,
                        "runner_id": input.runner_id,
                        "connection_epoch": input.connection_epoch,
                        "stage": payload.get("stage"),
                        "socket_sent_at": input.sent_at,
                        "source": "server_socket",
                        "runner_receipt_confirmed": false
                    }),
                )
            },
        )
        .await?;
        tx.commit().await?;
        Ok(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue87_invalid_and_absent_runner_clocks_are_not_invented() {
        let receipt = RunnerCommandReceipt {
            corp_id: Uuid::new_v4(),
            connection_epoch: Uuid::new_v4(),
            runner_received_at: Some("invalid".into()),
        };
        let value = observation(Some(&receipt), &"é".repeat(1000), Utc::now());
        assert_eq!(value["runner_timestamp_valid"], false);
        assert!(value["runner_received_at"].is_null());
        assert!(value["detail"].as_str().unwrap().len() <= 1000);
        let legacy = observation(None, "", Utc::now());
        assert!(legacy["runner_received_at"].is_null());
        assert!(legacy["runner_timestamp_valid"].is_null());
        assert_eq!(legacy["provider_termination_confirmed"], false);
    }
}
