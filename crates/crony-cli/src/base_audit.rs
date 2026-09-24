use anyhow::{Context, Result, ensure};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf};
use uuid::Uuid;

#[derive(Debug, Args)]
pub struct BaseAuditArgs {
    pub corp_id: Uuid,
    pub actor_id: Uuid,
    #[command(subcommand)]
    pub operation: BaseAuditOperation,
}

#[derive(Debug, Subcommand)]
pub enum BaseAuditOperation {
    /// Save a destination and spending policy without enabling publication.
    Configure { destination: PathBuf },
    /// Check customer-provisioned connections; never deploy or fund a wallet.
    Validate { destination_id: Uuid },
    /// Preview eligibility and funding without signing or broadcasting.
    Preview { destination_id: Uuid },
    /// Enable only a previously validated, customer-authorized destination.
    Enable {
        destination_id: Uuid,
        #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
        expected_version: i64,
    },
    /// Stop new effects; outstanding signed transactions are not canceled.
    Pause {
        destination_id: Uuid,
        #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
        expected_version: i64,
    },
    /// Queue one budget-controlled anchor. This operation may spend Base ETH.
    Request {
        destination_id: Uuid,
        #[arg(long)]
        idempotency_key: Uuid,
    },
    /// Show V1 and Base coverage separately.
    Status,
    /// Read a bounded page of retained anchor evidence.
    History {
        destination_id: Uuid,
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
        after: Option<i64>,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },
}

impl BaseAuditOperation {
    pub fn command(self) -> Result<Value> {
        let command = match self {
            Self::Configure { destination } => {
                let mut bytes = Vec::new();
                std::fs::File::open(destination)
                    .context("open Base destination configuration")?
                    .take(crony_audit::MAX_RECORD_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)?;
                ensure!(
                    bytes.len() <= crony_audit::MAX_RECORD_BYTES,
                    "Base destination configuration exceeds bound"
                );
                let destination: Value = crony_audit::parse_json(&bytes)?;
                ensure!(
                    destination.is_object(),
                    "expected a Base destination object"
                );
                json!({"action": "configure", "destination": destination})
            }
            Self::Validate { destination_id } => {
                json!({"action": "validate", "destination_id": destination_id})
            }
            Self::Preview { destination_id } => {
                json!({"action": "preview", "destination_id": destination_id})
            }
            Self::Enable {
                destination_id,
                expected_version,
            } => json!({
                "action": "enable", "destination_id": destination_id,
                "expected_version": expected_version
            }),
            Self::Pause {
                destination_id,
                expected_version,
            } => json!({
                "action": "pause", "destination_id": destination_id,
                "expected_version": expected_version
            }),
            Self::Request {
                destination_id,
                idempotency_key,
            } => {
                ensure!(!idempotency_key.is_nil(), "idempotency key must be non-nil");
                json!({
                    "action": "request", "destination_id": destination_id,
                    "idempotency_key": idempotency_key
                })
            }
            Self::Status => json!({"action": "status"}),
            Self::History {
                destination_id,
                after,
                limit,
            } => json!({
                "action": "history", "destination_id": destination_id,
                "after": after, "limit": limit
            }),
        };
        if let Some(destination_id) = command.get("destination_id").and_then(Value::as_str) {
            ensure!(
                !Uuid::parse_str(destination_id)?.is_nil(),
                "destination ID must be non-nil"
            );
        }
        Ok(command)
    }
}

pub async fn run(client: &reqwest::Client, server: &str, args: BaseAuditArgs) -> Result<Value> {
    ensure!(
        !args.corp_id.is_nil() && !args.actor_id.is_nil(),
        "Corp and actor IDs must be non-nil"
    );
    let command = args.operation.command()?;
    super::request(
        client,
        reqwest::Method::POST,
        format!(
            "{}/api/corps/{}/base-audit",
            server.trim_end_matches('/'),
            args.corp_id
        ),
        Some(json!({"actor_id": args.actor_id, "command": command})),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn base_v2_cli_posts_exact_native_authorized_operation() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let corp_id = Uuid::new_v4();
        let actor_id = Uuid::new_v4();
        let destination_id = Uuid::new_v4();
        let idempotency_key = Uuid::new_v4();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let body_start;
            loop {
                let mut buffer = [0; 1024];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0 && request.len() < 16_384);
                request.extend_from_slice(&buffer[..count]);
                if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    body_start = index + 4;
                    break;
                }
            }
            let headers = std::str::from_utf8(&request[..body_start])
                .unwrap()
                .to_owned();
            let content_length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            while request.len() < body_start + content_length {
                let mut buffer = [0; 1024];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            assert!(headers.starts_with(&format!("POST /api/corps/{corp_id}/base-audit HTTP/1.1")));
            let body: Value = serde_json::from_slice(&request[body_start..]).unwrap();
            assert_eq!(
                body,
                json!({
                    "actor_id": actor_id,
                    "command": {
                        "action": "request", "destination_id": destination_id,
                        "idempotency_key": idempotency_key
                    }
                })
            );
            let response = r#"{"queued":true,"published":false}"#;
            socket.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            ).as_bytes()).await.unwrap();
        });
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run(
                &reqwest::Client::new(),
                &format!("http://{address}/"),
                BaseAuditArgs {
                    corp_id,
                    actor_id,
                    operation: BaseAuditOperation::Request {
                        destination_id,
                        idempotency_key,
                    },
                },
            ),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(result.unwrap(), json!({"queued":true,"published":false}));
    }

    #[test]
    fn base_v2_commands_preserve_idempotency_and_do_not_accept_transaction_fields() {
        let destination_id = Uuid::new_v4();
        let idempotency_key = Uuid::new_v4();
        assert_eq!(
            BaseAuditOperation::Request {
                destination_id,
                idempotency_key,
            }
            .command()
            .unwrap(),
            json!({
                "action": "request", "destination_id": destination_id,
                "idempotency_key": idempotency_key
            })
        );
        assert!(
            BaseAuditOperation::Request {
                destination_id,
                idempotency_key: Uuid::nil(),
            }
            .command()
            .is_err()
        );
        assert_eq!(
            BaseAuditOperation::Status.command().unwrap(),
            json!({"action": "status"})
        );
    }
}
