use super::*;
use anyhow::{Context, ensure};
use crony_store::state_audit::{
    AuditDestination, AuditPublicationRetry, AuditReconciliation, AuditWitnessError,
    GitHubDestination,
};
use futures_util::StreamExt;
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
    #[serde(default)]
    destination_id: Option<Uuid>,
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
        Self::validate_witnesses(&witnesses)?;
        Ok(Some(Arc::new(Self {
            key: crony_audit::SigningKey::from_bytes(&raw),
            key_id,
            github_token,
            checkpoint_seconds,
            witnesses,
        })))
    }
    fn validate_witnesses(witnesses: &[RetainedWitness]) -> anyhow::Result<()> {
        let mut destinations = std::collections::BTreeSet::new();
        let mut scopes = std::collections::BTreeMap::new();
        for witness in witnesses {
            ensure!(
                witness.github_commit.is_none() || witness.destination_id.is_some(),
                "retained github_commit requires an explicit immutable destination_id"
            );
            ensure!(
                scopes
                    .insert(witness.corp_id, witness.destination_id.is_some())
                    .is_none_or(|bound| bound == witness.destination_id.is_some()),
                "cannot mix Corp-only bootstrap and destination-bound retained witnesses"
            );
            ensure!(
                !witness.corp_id.is_nil()
                    && !witness.ledger_id.is_nil()
                    && witness.destination_id.is_none_or(|id| !id.is_nil())
                    && destinations.insert((witness.corp_id, witness.destination_id))
                    && witness.checkpoint_digest.len() == 64
                    && witness
                        .checkpoint_digest
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    && witness
                        .github_commit
                        .as_ref()
                        .is_none_or(|commit| crony_audit::validate_github_commit(commit).is_ok()),
                "invalid or duplicate retained audit witness"
            );
        }
        Ok(())
    }

    fn witness(&self, corp: Uuid, destination: Uuid) -> Option<&RetainedWitness> {
        self.witnesses.iter().find(|w| {
            w.corp_id == corp
                && (w.destination_id == Some(destination)
                    || (w.destination_id.is_none() && w.github_commit.is_none()))
        })
    }

    async fn publish_destination<T: crony_audit::PublicationTransport>(
        &self,
        store: &PgStore,
        destination: &AuditDestination,
        transport: &T,
    ) -> anyhow::Result<bool> {
        let Some(witness) = self.witness(destination.corp_id, destination.id) else {
            store
                .disable_audit_destination_for_divergence(destination.id)
                .await?;
            anyhow::bail!(
                "publication disabled: no independently retained Corp/destination witness"
            );
        };
        if let Err(error) = store
            .validate_audit_witness(
                destination.corp_id,
                witness.ledger_id,
                &witness.checkpoint_digest,
                &self.key.verifying_key(),
            )
            .await
        {
            match error {
                AuditWitnessError::Diverged => {
                    store
                        .disable_audit_destination_for_divergence(destination.id)
                        .await?;
                }
                AuditWitnessError::Unavailable => {
                    // The database may still be unavailable. Preserve the
                    // sanitized failure class even if a retry marker cannot
                    // be saved; the worker itself also has a bounded cadence.
                    let _ = tokio::time::timeout(
                        StdDuration::from_secs(5),
                        store.defer_audit_publication(
                            destination.id,
                            AuditPublicationRetry::WitnessUnavailable,
                        ),
                    )
                    .await;
                }
            }
            return Err(error.into());
        }
        store
            .publish_audit_destination(
                destination.id,
                transport,
                &self.key.verifying_key(),
                witness.github_commit.as_deref(),
            )
            .await
    }

    async fn checkpoint_batch(
        &self,
        store: &PgStore,
        cursor: &mut Option<Uuid>,
    ) -> anyhow::Result<()> {
        let mut corps = store.audit_ledgers_needing_checkpoint(*cursor).await?;
        if corps.is_empty() && cursor.take().is_some() {
            corps = store.audit_ledgers_needing_checkpoint(None).await?;
        }
        for corp in corps {
            // Advance even on failure. Persistent failures in the first page
            // must not hide another tenant's pending checkpoint indefinitely.
            *cursor = Some(corp);
            if !matches!(
                tokio::time::timeout(
                    StdDuration::from_secs(30),
                    store.audit_checkpoint(corp, &self.key_id, &self.key),
                )
                .await,
                Ok(Ok(_))
            ) {
                warn!(%corp, "state audit checkpoint failed; unsigned state remains unpublished");
            }
        }
        Ok(())
    }

    async fn publish_batch<T, F>(
        &self,
        store: &PgStore,
        make_transport: F,
        deadline: StdDuration,
    ) -> anyhow::Result<()>
    where
        T: crony_audit::PublicationTransport,
        F: Fn(&AuditDestination) -> anyhow::Result<T> + Sync,
    {
        let make_transport = &make_transport;
        futures_util::stream::iter(store.due_audit_destinations().await?)
            .for_each_concurrent(4, |destination| async move {
                let result = tokio::time::timeout(deadline, async {
                    let transport = make_transport(&destination)?;
                    self.publish_destination(store, &destination, &transport).await
                })
                .await;
                if result.is_err() {
                    // Cancellation rolls back the destination transaction.
                    // A retry reads any immutable files written before timeout.
                    let _ = tokio::time::timeout(
                        StdDuration::from_secs(5),
                        store.defer_audit_publication(
                            destination.id,
                            AuditPublicationRetry::AttemptTimedOut,
                        ),
                    )
                    .await;
                }
                if !matches!(result, Ok(Ok(_))) {
                    warn!(destination_id=%destination.id, "state audit publication remains pending; inspect audit status");
                }
            })
            .await;
        Ok(())
    }

    pub fn start(self: Arc<Self>, store: PgStore) {
        let checkpoint_service = self.clone();
        let checkpoint_store = store.clone();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(StdDuration::from_secs(
                checkpoint_service.checkpoint_seconds,
            ));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut cursor = None;
            loop {
                timer.tick().await;
                if checkpoint_service
                    .checkpoint_batch(&checkpoint_store, &mut cursor)
                    .await
                    .is_err()
                {
                    warn!("state audit checkpoint discovery unavailable");
                }
            }
        });
        tokio::spawn(async move {
            let Some(token) = &self.github_token else {
                return;
            };
            let mut timer = tokio::time::interval(StdDuration::from_secs(60));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                timer.tick().await;
                if self
                    .publish_batch(
                        &store,
                        |destination| {
                            let config: GitHubDestination =
                                serde_json::from_value(destination.config.clone())?;
                            crony_audit::GitHubTransport::new(
                                &config.repository,
                                &config.branch,
                                token,
                            )
                        },
                        StdDuration::from_secs(90),
                    )
                    .await
                    .is_err()
                {
                    warn!("state audit publisher discovery unavailable");
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
                .witness(corp, destination_id)
                .filter(|w| w.ledger_id == ledger_id && w.checkpoint_digest == checkpoint_digest)
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
    use sqlx::{ConnectOptions, PgPool};

    async fn assert_missing_witness_disables(
        pool: PgPool,
        witness_corp: Option<Uuid>,
    ) -> anyhow::Result<()> {
        let database = pool.connect_options().to_url_lossy();
        let store = PgStore::connect(database.as_str()).await?;
        let (ids, _) = store.bootstrap_demo().await?;
        let ledger = Uuid::new_v4();
        store
            .initialize_state_audit(ids.corp_id, ids.alice_actor_id, ledger)
            .await?;
        let destination = AuditDestination {
            id: Uuid::new_v4(),
            corp_id: ids.corp_id,
            kind: "github".into(),
            interval_seconds: 60,
            calendar_schedule: None,
            overdue_after_seconds: 3600,
            workflow_gate: "published".into(),
            config: serde_json::json!({
                "repository": "fixture/audit",
                "branch": "main",
                "path": "audit"
            }),
        };
        store
            .configure_audit_destination(ids.alice_actor_id, &destination)
            .await?;
        assert_eq!(store.due_audit_destinations().await?.len(), 1);
        Arc::new(Service {
            key: crony_audit::SigningKey::from_bytes(&[7; 32]),
            key_id: "fixture-key".into(),
            github_token: Some("test-only-never-sent".into()),
            checkpoint_seconds: 1,
            witnesses: witness_corp
                .map(|corp_id| RetainedWitness {
                    corp_id,
                    ledger_id: ledger,
                    checkpoint_digest: "00".repeat(32),
                    github_commit: None,
                    destination_id: None,
                })
                .into_iter()
                .collect(),
        })
        .start(store.clone());
        tokio::time::timeout(StdDuration::from_secs(5), async {
            loop {
                let status = store.audit_status(ids.corp_id, ids.alice_actor_id).await?;
                if status["destinations"][0]["publication_disabled"] == true {
                    return Ok::<(), anyhow::Error>(());
                }
                tokio::time::sleep(StdDuration::from_millis(10)).await;
            }
        })
        .await
        .context("publisher did not durably disable the missing-witness destination")??;

        // A second poll and a new store connection must retain the failure, not retry it.
        tokio::time::sleep(StdDuration::from_millis(1100)).await;
        let reopened = PgStore::connect(database.as_str()).await?;
        let status = reopened
            .audit_status(ids.corp_id, ids.alice_actor_id)
            .await?;
        let retained = &status["destinations"][0];
        assert_eq!(retained["publication_disabled"], true);
        assert_eq!(
            retained["reconciliation_error"],
            "retained_witness_divergence"
        );
        assert_eq!(retained["last_error"], "retained_witness_divergence");
        assert_eq!(retained["failures"], 1);
        assert!(!retained["last_attempted_publication"].is_null());
        assert_eq!(status["assurance"]["publication_errors"], 1);
        assert!(reopened.due_audit_destinations().await?.is_empty());
        assert!(
            !reopened
                .audit_workflow_gate_satisfied(ids.corp_id, destination.id, 1)
                .await?
        );
        Ok(())
    }

    #[sqlx::test(migrations = "../../db/migrations")]
    #[ignore = "requires explicitly owned disposable PostgreSQL"]
    async fn issue281_publisher_missing_witness_is_durably_disabled(
        pool: PgPool,
    ) -> anyhow::Result<()> {
        assert_missing_witness_disables(pool, None).await
    }

    #[sqlx::test(migrations = "../../db/migrations")]
    #[ignore = "requires explicitly owned disposable PostgreSQL"]
    async fn issue281_publisher_other_corp_witness_is_not_authority(
        pool: PgPool,
    ) -> anyhow::Result<()> {
        assert_missing_witness_disables(pool, Some(Uuid::new_v4())).await
    }

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

#[cfg(test)]
#[path = "state_audit_retained_pin_tests.rs"]
mod retained_pin_tests;
