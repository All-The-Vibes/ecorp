use super::*;
use anyhow::{Context, ensure};
use crony_store::state_audit::{AuditDestination, AuditReconciliation, GitHubDestination};
use std::io::Read;

pub struct Service {
    key: crony_audit::SigningKey,
    key_id: String,
    github_token: Option<String>,
    checkpoint_seconds: u64,
    witnesses: Vec<RetainedWitness>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RetainedWitness {
    corp_id: Uuid,
    ledger_id: Uuid,
    checkpoint_digest: String,
    #[serde(default)]
    github_commit: Option<String>,
}

impl Service {
    pub fn from_environment() -> anyhow::Result<Option<Arc<Self>>> {
        let Some(path) = std::env::var_os("CRONY_STATE_AUDIT_SIGNING_KEY_FILE") else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .context("open configured audit signing key")?
            .take(33)
            .read_to_end(&mut bytes)?;
        let raw: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("audit signing key must contain exactly 32 raw bytes"))?;
        let key_id = std::env::var("CRONY_STATE_AUDIT_KEY_ID")
            .context("CRONY_STATE_AUDIT_KEY_ID required")?;
        ensure!(
            !key_id.is_empty() && key_id.len() <= 128,
            "invalid audit key id"
        );
        let github_token =
            if let Some(path) = std::env::var_os("CRONY_STATE_AUDIT_GITHUB_TOKEN_FILE") {
                let mut token = String::new();
                std::fs::File::open(path)
                    .context("open configured audit GitHub credential")?
                    .take(4097)
                    .read_to_string(&mut token)?;
                ensure!(
                    !token.trim().is_empty() && token.len() <= 4096,
                    "invalid audit GitHub credential length"
                );
                Some(token)
            } else {
                None
            };
        let checkpoint_seconds = match std::env::var("CRONY_STATE_AUDIT_CHECKPOINT_SECONDS") {
            Ok(value) => value.parse::<u64>()?,
            Err(std::env::VarError::NotPresent) => 300,
            Err(error) => return Err(error.into()),
        };
        ensure!(
            (1..=31_536_000).contains(&checkpoint_seconds),
            "invalid local checkpoint interval"
        );
        let witnesses: Vec<RetainedWitness> =
            if let Some(path) = std::env::var_os("CRONY_STATE_AUDIT_RETAINED_WITNESSES_FILE") {
                let mut bytes = Vec::new();
                std::fs::File::open(path)
                    .context("open retained audit witnesses")?
                    .take(crony_audit::MAX_RECORD_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)?;
                ensure!(
                    bytes.len() <= crony_audit::MAX_RECORD_BYTES,
                    "retained witnesses exceed bound"
                );
                crony_audit::parse_json(&bytes)?
            } else {
                ensure!(
                    github_token.is_none(),
                    "GitHub publication requires retained audit witnesses"
                );
                Vec::new()
            };
        let mut corps = std::collections::BTreeSet::new();
        for witness in &witnesses {
            ensure!(
                !witness.corp_id.is_nil()
                    && !witness.ledger_id.is_nil()
                    && corps.insert(witness.corp_id)
                    && witness.checkpoint_digest.len() == 64
                    && witness
                        .checkpoint_digest
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    && witness.github_commit.as_ref().is_none_or(|commit| {
                        (40..=64).contains(&commit.len())
                            && commit
                                .bytes()
                                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    }),
                "invalid or duplicate retained audit witness"
            );
        }
        Ok(Some(Arc::new(Self {
            key: crony_audit::SigningKey::from_bytes(&raw),
            key_id,
            github_token,
            checkpoint_seconds,
            witnesses,
        })))
    }
    pub fn start(self: Arc<Self>, store: PgStore) {
        tokio::spawn(async move {
            let mut timer =
                tokio::time::interval(StdDuration::from_secs(self.checkpoint_seconds.min(60)));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_checkpoint: Option<tokio::time::Instant> = None;
            loop {
                timer.tick().await;
                if last_checkpoint.is_none_or(|t| t.elapsed().as_secs() >= self.checkpoint_seconds)
                {
                    let checkpoint_pass_succeeded = match store
                        .audit_ledgers_needing_checkpoint()
                        .await
                    {
                        Ok(corps) => {
                            let mut succeeded = true;
                            for corp in corps {
                                if store
                                    .audit_checkpoint(corp, &self.key_id, &self.key)
                                    .await
                                    .is_err()
                                {
                                    succeeded = false;
                                    warn!(%corp,"state audit checkpoint failed; no publication attempted for unsigned state");
                                }
                            }
                            succeeded
                        }
                        Err(_) => {
                            warn!("state audit checkpoint work discovery failed");
                            false
                        }
                    };
                    if checkpoint_pass_succeeded {
                        last_checkpoint = Some(tokio::time::Instant::now());
                    }
                }
                if let Some(token) = &self.github_token {
                    match store.due_audit_destinations().await {
                        Ok(destinations) => {
                            for destination in destinations {
                                let result = async {
                                    let witness = self.witnesses.iter().find(|w| w.corp_id == destination.corp_id)
                                        .context("publication blocked: no independently retained Corp witness")?;
                                    if let Err(error) = store.validate_audit_witness(
                                        destination.corp_id,
                                        witness.ledger_id,
                                        &witness.checkpoint_digest,
                                        &self.key.verifying_key(),
                                    ).await {
                                        store
                                            .disable_audit_destination_for_divergence(destination.id)
                                            .await?;
                                        return Err(error.context(
                                            "publication disabled pending explicit witness reconciliation",
                                        ));
                                    }
                                    let config: GitHubDestination =
                                        serde_json::from_value(destination.config)?;
                                    let transport = crony_audit::GitHubTransport::new(
                                        &config.repository,
                                        &config.branch,
                                        token,
                                    )?;
                                    store
                                        .publish_audit_destination(
                                            destination.id,
                                            &transport,
                                            &self.key.verifying_key(),
                                        )
                                        .await
                                }
                                .await;
                                if result.is_err() {
                                    warn!(destination_id=%destination.id,"state audit publication remains pending; inspect audit status");
                                }
                            }
                        }
                        Err(_) => warn!("state audit publisher discovery failed"),
                    }
                }
            }
        });
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditRequest {
    actor_id: Uuid,
    command: AuditCommand,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum AuditCommand {
    Initialize {
        ledger_id: Uuid,
    },
    Cover {
        mission_id: Uuid,
    },
    Checkpoint {},
    Export {},
    Status {},
    Receipt {
        request_id: Uuid,
    },
    Publish {
        destination_id: Uuid,
    },
    Reconcile {
        destination_id: Uuid,
        ledger_id: Uuid,
        checkpoint_digest: String,
    },
    ConfigureDestination {
        destination: AuditDestination,
    },
}

pub async fn handle(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(corp): Path<Uuid>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.len() > crony_audit::MAX_RECORD_BYTES {
        return Err(ApiError::bad_request("audit request exceeds bound"));
    }
    let request: AuditRequest = crony_audit::parse_json(&body)
        .map_err(|_| ApiError::bad_request("invalid audit request JSON"))?;
    let actor = authorize_actor(
        &state,
        &principal,
        corp,
        Some(request.actor_id),
        Permission::Operate,
    )
    .await?;
    if let AuditCommand::Receipt { request_id } = &request.command {
        return Ok(Json(
            serde_json::to_value(
                state
                    .store
                    .audit_receipt(corp, actor, *request_id)
                    .await
                    .map_err(map_store_error)?,
            )
            .map_err(ApiError::internal)?,
        ));
    }
    // Reuse native management authorization and room visibility before signing
    // or disclosing a Corp-wide history, even for an authenticated principal.
    let status = state
        .store
        .audit_status(corp, actor)
        .await
        .map_err(map_store_error)?;
    let result = match request.command {
        AuditCommand::Status {} => status,
        AuditCommand::Receipt { request_id } => serde_json::to_value(
            state
                .store
                .audit_receipt(corp, actor, request_id)
                .await
                .map_err(map_store_error)?,
        )
        .map_err(ApiError::internal)?,
        AuditCommand::Export {} => serde_json::to_value(
            state
                .store
                .audit_export(corp, actor)
                .await
                .map_err(map_store_error)?,
        )
        .map_err(ApiError::internal)?,
        AuditCommand::Publish { destination_id } => {
            state
                .store
                .request_audit_publication(corp, actor, destination_id)
                .await
                .map_err(map_store_error)?;
            serde_json::json!({"queued":true,"destination_id":destination_id,"published":false})
        }
        AuditCommand::ConfigureDestination { destination } => {
            if destination.corp_id != corp {
                return Err(ApiError::bad_request("foreign Corp destination"));
            }
            state
                .store
                .configure_audit_destination(actor, &destination)
                .await
                .map_err(map_store_error)?;
            serde_json::json!({"configured":true,"destination_id":destination.id,"ethereum_enabled":false})
        }
        AuditCommand::Reconcile {
            destination_id,
            ledger_id,
            checkpoint_digest,
        } => {
            let signer = state
                .audit
                .as_ref()
                .ok_or_else(|| ApiError::conflict("state audit signer is not configured"))?;
            let witness = signer
                .witnesses
                .iter()
                .find(|w| {
                    w.corp_id == corp
                        && w.ledger_id == ledger_id
                        && w.checkpoint_digest == checkpoint_digest
                })
                .ok_or_else(|| {
                    ApiError::conflict("reconciliation must match a configured retained witness")
                })?;
            let retained_commit = witness.github_commit.as_deref().ok_or_else(|| {
                ApiError::conflict("reconciliation requires the retained witness GitHub commit")
            })?;
            let token = signer.github_token.as_deref().ok_or_else(|| {
                ApiError::conflict("state audit GitHub credential is not configured")
            })?;
            let config = state
                .store
                .audit_github_destination_config(corp, destination_id)
                .await
                .map_err(map_store_error)?;
            let transport =
                crony_audit::GitHubTransport::new(&config.repository, &config.branch, token)
                    .map_err(ApiError::internal)?;
            state
                .store
                .reconcile_audit_destination(
                    corp,
                    actor,
                    destination_id,
                    AuditReconciliation {
                        ledger_id,
                        checkpoint_digest: &checkpoint_digest,
                        github_commit: retained_commit,
                    },
                    &transport,
                    &signer.key.verifying_key(),
                )
                .await
                .map_err(map_store_error)?;
            serde_json::json!({"reconciled":true,"destination_id":destination_id})
        }
        command => {
            let signer = state
                .audit
                .as_ref()
                .ok_or_else(|| ApiError::conflict("state audit signer is not configured"))?;
            match command {
                AuditCommand::Initialize { ledger_id } => {
                    state
                        .store
                        .initialize_state_audit(corp, actor, ledger_id)
                        .await
                        .map_err(map_store_error)?;
                    serde_json::json!({"ledger_id":ledger_id})
                }
                AuditCommand::Cover { mission_id } => serde_json::to_value(
                    state
                        .store
                        .cover_mission(corp, actor, mission_id)
                        .await
                        .map_err(map_store_error)?,
                )
                .map_err(ApiError::internal)?,
                AuditCommand::Checkpoint {} => serde_json::to_value(
                    state
                        .store
                        .audit_checkpoint(corp, &signer.key_id, &signer.key)
                        .await
                        .map_err(map_store_error)?,
                )
                .map_err(ApiError::internal)?,
                _ => unreachable!("read commands handled above"),
            }
        }
    };
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issue281_api_rejects_injected_key_token_or_destination_fields() {
        let actor = "00000000-0000-4000-8000-000000000001";
        assert!(
            serde_json::from_value::<AuditRequest>(
                serde_json::json!({"actor_id":actor,"command":{"action":"status"}})
            )
            .is_ok()
        );
        assert!(serde_json::from_value::<AuditRequest>(serde_json::json!({"actor_id":actor,"command":{"action":"checkpoint","private_key":"not accepted"}})).is_err());
        assert!(serde_json::from_value::<AuditRequest>(serde_json::json!({"actor_id":actor,"command":{"action":"checkpoint"},"token":"not accepted"})).is_err());
    }
}
