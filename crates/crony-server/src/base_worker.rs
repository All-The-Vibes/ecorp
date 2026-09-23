//! Optional trusted Base worker. It never deploys, registers, funds or owns a private key.
#[cfg(all(feature = "native-qualification", not(debug_assertions)))]
compile_error!("native-qualification is forbidden in release builds");
#[cfg(all(test, debug_assertions))]
#[path = "base_worker_tests.rs"]
mod tests;

use anyhow::{Context, Result, ensure};
use crony_base::{
    Address, B256,
    abi::AnchorCall,
    manifest::ManifestTrust,
    rpc::{
        BaseConnection, BlockTag, EndpointPolicy, EndpointSecret, EndpointSecrets,
        FeeOracleQualification, FinalityObservation, HttpSigningGateway, ReceiptEvidence,
        SealedHeader,
    },
    signing::{FrozenTransaction, SigningGateway},
};
use crony_store::{
    PgStore,
    base_audit::{BaseClaim, BaseDestination},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    str::FromStr,
    sync::Arc,
    time::Duration,
};
use uuid::Uuid;

/// The same module can run embedded in crony-server or as an isolated trusted worker process.
#[allow(dead_code)]
#[tokio::main]
async fn main() -> Result<()> {
    qualification_mode()?;
    if std::env::var_os("CRONY_BASE_WORKER_CONFIG_FILE").is_none() {
        return Ok(());
    }
    let service = Service::from_environment()?.context("worker configuration unavailable")?;
    let database = std::env::var("DATABASE_URL").context("worker DATABASE_URL is required")?;
    let store = PgStore::connect(&database).await?;
    tracing_subscriber::fmt().with_env_filter("info").init();
    service
        .start(store)
        .await
        .context("Base worker task failed")?;
    Ok(())
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionSettings {
    destination_id: Uuid,
    expected_owner: Address,
    gateway_secret: String,
    allowed_hosts: BTreeSet<String>,
    fee_oracle: FeeOracleQualification,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerSettings {
    secrets_file: PathBuf,
    connections: Vec<ConnectionSettings>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretValue {
    url: String,
    bearer: Option<String>,
}
struct FileSecrets(BTreeMap<String, SecretValue>);
#[async_trait::async_trait]
impl EndpointSecrets for FileSecrets {
    async fn resolve(&self, reference: &str) -> crony_base::Result<EndpointSecret> {
        let value = self.0.get(reference).ok_or(crony_base::Error::Config(
            "host secret reference unavailable",
        ))?;
        Ok(EndpointSecret {
            url: value.url.clone(),
            bearer: value.bearer.clone(),
        })
    }
}

fn settings() -> Result<Option<(WorkerSettings, FileSecrets)>> {
    let Some(path) = std::env::var_os("CRONY_BASE_WORKER_CONFIG_FILE") else {
        return Ok(None);
    };
    let bytes = std::fs::read(PathBuf::from(path))
        .map_err(|_| anyhow::anyhow!("Base host configuration unavailable"))?;
    ensure!(
        bytes.len() <= 262144,
        "Base host configuration exceeds bounds"
    );
    let config: WorkerSettings = crony_audit::parse_json(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid Base host configuration"))?;
    ensure!(
        config.connections.len() <= 1024,
        "too many Base host connections"
    );
    let ids: BTreeSet<_> = config
        .connections
        .iter()
        .map(|c| c.destination_id)
        .collect();
    ensure!(
        ids.len() == config.connections.len(),
        "duplicate Base host destination"
    );
    let secrets = std::fs::read(&config.secrets_file)
        .map_err(|_| anyhow::anyhow!("Base host secret file unavailable"))?;
    ensure!(
        secrets.len() <= 262144,
        "Base host secret file exceeds bounds"
    );
    let secrets: BTreeMap<String, SecretValue> = crony_audit::parse_json(&secrets)
        .map_err(|_| anyhow::anyhow!("invalid Base host secret file"))?;
    Ok(Some((config, FileSecrets(secrets))))
}

pub struct Service {
    settings: WorkerSettings,
    secrets: FileSecrets,
}

impl Service {
    /// No network, database, or signing work occurs during ordinary server initialization.
    pub fn from_environment() -> Result<Option<Arc<Self>>> {
        qualification_mode()?;
        Ok(settings()?.map(|(settings, secrets)| Arc::new(Self { settings, secrets })))
    }

    pub fn start(self: &Arc<Self>, store: PgStore) -> tokio::task::JoinHandle<()> {
        spawn_configured_worker(Arc::clone(self), store)
    }

    pub async fn validate(
        &self,
        store: &PgStore,
        corp: Uuid,
        actor: Uuid,
        destination: Uuid,
    ) -> Result<Value> {
        Ok(self
            .validate_admin_destination(store, corp, actor, destination)
            .await?
            .unwrap_or_else(|| pending_validation(destination)))
    }

    async fn validate_admin_destination(
        &self,
        store: &PgStore,
        corp: Uuid,
        actor: Uuid,
        destination: Uuid,
    ) -> Result<Option<Value>> {
        let d = store
            .base_destination_for_admin(corp, actor, destination)
            .await?;
        let host = self
            .settings
            .connections
            .iter()
            .find(|h| h.destination_id == destination)
            .context("Base destination has no customer host connection")?;
        let connected = connect(&d, host, &self.secrets).await?;
        validate_connection(store, &d, &connected).await
    }

    pub async fn enable(
        &self,
        store: &PgStore,
        corp: Uuid,
        actor: Uuid,
        destination: Uuid,
        expected_version: i64,
    ) -> Result<Value> {
        let d = store
            .base_destination_for_admin(corp, actor, destination)
            .await?;
        ensure!(
            d.version == expected_version,
            "stale Base destination version"
        );
        if self
            .validate_admin_destination(store, corp, actor, destination)
            .await?
            .is_none()
        {
            return Ok(pending_validation(destination));
        }
        Ok(serde_json::to_value(
            store
                .control_base_destination(corp, actor, destination, expected_version, true)
                .await?,
        )?)
    }

    pub async fn preview(
        &self,
        store: &PgStore,
        corp: Uuid,
        actor: Uuid,
        destination: Uuid,
    ) -> Result<Value> {
        preview_configured_destination(self, store, corp, actor, destination).await
    }
}

struct Connected {
    chain: BaseConnection,
    gateway: HttpSigningGateway,
    settings: ConnectionSettings,
}

#[derive(Debug, PartialEq, Eq)]
enum ReconciliationStage {
    RetainedObservations,
    HistoricalScan,
    NewObservations,
}

#[derive(Debug, PartialEq, Eq)]
#[must_use]
enum Reconciliation {
    Complete,
    Pending(ReconciliationStage),
}

fn pending_validation(destination: Uuid) -> Value {
    json!({"destination_id":destination,"validated":false,
        "status":"reconciliation_pending","retry_after_seconds":15})
}
async fn connect(
    d: &BaseDestination,
    host: &ConnectionSettings,
    secrets: &FileSecrets,
) -> Result<Connected> {
    d.input.trusted_manifest()?;
    let mut trust = ManifestTrust::bootstrap(&d.input.trust_pin, &d.input.manifests[0])?;
    for next in d.input.manifests.iter().skip(1) {
        trust.advance(next)?;
    }
    #[cfg(all(feature = "native-qualification", debug_assertions))]
    if qualification_mode()? {
        return Ok(Connected {
            chain: BaseConnection::connect_test_loopback(d.input.config.clone(), trust, secrets)
                .await?,
            gateway: HttpSigningGateway::connect_test_loopback(
                &host.gateway_secret,
                &d.input.config.signer_gateway_identity,
                secrets,
            )
            .await?,
            settings: host.clone(),
        });
    }
    let policy = EndpointPolicy::production(host.allowed_hosts.clone());
    let chain = BaseConnection::connect(
        d.input.config.clone(),
        trust,
        secrets,
        policy.clone(),
        policy.clone(),
    )
    .await?;
    let gateway = HttpSigningGateway::connect(
        &host.gateway_secret,
        &d.input.config.signer_gateway_identity,
        secrets,
        policy,
    )
    .await?;
    Ok(Connected {
        chain,
        gateway,
        settings: host.clone(),
    })
}

pub(crate) fn qualification_mode() -> Result<bool> {
    match std::env::var("CRONY_NATIVE_QUALIFICATION") {
        Err(std::env::VarError::NotPresent) => Ok(false),
        Ok(value) => {
            ensure!(
                cfg!(all(feature = "native-qualification", debug_assertions)) && value == "1",
                "native qualification requires an explicit debug fixture build and value 1"
            );
            Ok(true)
        }
        Err(_) => anyhow::bail!("invalid native qualification mode"),
    }
}

async fn validate_connection(
    store: &PgStore,
    d: &BaseDestination,
    c: &Connected,
) -> Result<Option<Value>> {
    store.begin_base_recovery(d.corp_id, d.id).await?;
    let identity = c.gateway.identity().await?;
    ensure!(
        identity.chain_id == d.input.config.chain_id
            && identity.publisher == d.input.config.publisher
            && identity.immutable_key_identity == d.input.config.signer_key_identity,
        "gateway immutable key identity mismatch"
    );
    let observation = c
        .chain
        .startup(identity.publisher, c.settings.expected_owner)
        .await?;
    let journal = c
        .gateway
        .journal_snapshot(d.input.config.chain_id, d.input.config.publisher)
        .await?;
    ensure!(
        journal.complete,
        "incomplete signing journal; publication remains paused"
    );
    let nonce = c
        .chain
        .primary
        .nonce(d.input.config.publisher, BlockTag::Pending)
        .await?;
    ensure!(
        nonce
            == c.chain
                .secondary
                .nonce(d.input.config.publisher, BlockTag::Pending)
                .await?,
        "provider nonce disagreement"
    );
    // Scan retained canonical effects BEFORE authorizing new signatures after a restart.
    if let Reconciliation::Pending(stage) = reconcile_events(store, d, c).await? {
        tracing::info!(destination_id=%d.id,?stage,"Base validation awaits bounded canonical reconciliation");
        return Ok(None);
    }
    let evidence = serde_json::to_value(&observation)?;
    store
        .complete_base_validation(
            d.corp_id,
            d.id,
            crony_store::base_audit::BaseValidation {
                epoch: &journal.epoch,
                cursor: journal.cursor,
                requests: &journal.requests,
                pending_nonce: nonce,
                observation: &evidence,
            },
        )
        .await?;
    Ok(Some(
        json!({"destination_id":d.id,"validated":true,"observation":observation,"journal_cursor":journal.cursor}),
    ))
}

async fn preview_configured_destination(
    service: &Service,
    store: &PgStore,
    corp: Uuid,
    actor: Uuid,
    destination: Uuid,
) -> Result<Value> {
    let selection = store.base_audit_preview(corp, actor, destination).await?;
    let Some(checkpoint) = &selection.checkpoint else {
        return Ok(json!({"selection":selection,"status":"no_checkpoint","fee_quote":null}));
    };
    let host = service
        .settings
        .connections
        .iter()
        .find(|h| h.destination_id == destination)
        .context("Base customer host connection unavailable")?;
    let connected = connect(&selection.destination, host, &service.secrets).await?;
    let d = &selection.destination;
    let identity = connected.gateway.identity().await?;
    ensure!(
        identity.chain_id == d.input.config.chain_id
            && identity.publisher == d.input.config.publisher
            && identity.immutable_key_identity == d.input.config.signer_key_identity,
        "gateway identity mismatch"
    );
    let startup = connected
        .chain
        .startup(identity.publisher, host.expected_owner)
        .await?;
    let block = connected.chain.primary.block(BlockTag::Latest).await?;
    let nonce = connected
        .chain
        .primary
        .nonce(identity.publisher, BlockTag::Pending)
        .await?;
    let (max_fee, priority) = connected.chain.primary.fee_suggestion().await?;
    let transaction = FrozenTransaction {
        chain_id: d.input.config.chain_id,
        sender: identity.publisher,
        contract: d.input.config.contract_address,
        nonce,
        gas_limit: d
            .input
            .config
            .spending_policy
            .as_ref()
            .context("fee policy absent")?
            .max_gas,
        max_fee_per_gas: max_fee,
        max_priority_fee_per_gas: priority,
        call: AnchorCall {
            stream_id: d.input.config.stream_id,
            sequence: checkpoint.checkpoint.last_sequence,
            checkpoint_digest: B256::from_str(&checkpoint.digest)?,
            previous_anchor_digest: d
                .verified_digest
                .as_deref()
                .map(B256::from_str)
                .transpose()?
                .unwrap_or(B256::ZERO),
        },
    };
    connected
        .chain
        .primary
        .simulate(&transaction, block.hash)
        .await?;
    let quote = connected
        .chain
        .primary
        .quote(&transaction, block.hash, &host.fee_oracle)
        .await?;
    let balance = connected
        .chain
        .primary
        .balance(identity.publisher, block.hash)
        .await?;
    let exposure = crony_base::fees::exposure(
        d.input
            .config
            .spending_policy
            .as_ref()
            .context("fee policy absent")?,
        &quote,
    )?;
    Ok(
        json!({"selection":selection,"startup":startup,"fee_quote":quote,"estimated_liability_wei":exposure.to_string(),
        "balance_wei":balance.to_string(),"all_in_hard_cap":false,"network":"Base","chain_id":transaction.chain_id}),
    )
}

fn spawn_configured_worker(service: Arc<Service>, store: PgStore) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let settings = &service.settings;
        let secrets = &service.secrets;
        let destination_ids: Vec<_> = settings
            .connections
            .iter()
            .map(|c| c.destination_id)
            .collect();
        let worker = Uuid::new_v4();
        let mut connections = BTreeMap::new();
        let mut ticker = tokio::time::interval(Duration::from_secs(15));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let destinations = match store.base_worker_destinations(&destination_ids).await {
                Ok(ds) => ds,
                Err(_) => {
                    tracing::warn!("Base worker persistence unavailable");
                    continue;
                }
            };
            for d in destinations {
                // Configuring a default-disabled destination never creates network traffic.
                if !d.enabled && !connections.contains_key(&d.id) {
                    match store.base_has_unresolved_attempt(d.corp_id, d.id).await {
                        Ok(true) => {}
                        Ok(false) => continue,
                        Err(_) => {
                            tracing::warn!(destination_id=%d.id,"Base pending-transaction lookup unavailable");
                            continue;
                        }
                    }
                }
                let Some(host) = settings
                    .connections
                    .iter()
                    .find(|h| h.destination_id == d.id)
                else {
                    tracing::warn!(destination_id=%d.id,"Base destination has no customer host connection");
                    continue;
                };
                let mut reconciled = false;
                if let std::collections::btree_map::Entry::Vacant(entry) = connections.entry(d.id) {
                    match connect(&d, host, secrets).await {
                        Ok(c) => match validate_connection(&store, &d, &c).await {
                            Ok(Some(_)) => {
                                entry.insert(c);
                                reconciled = true;
                            }
                            Ok(None) => {
                                continue;
                            }
                            Err(_) => {
                                tracing::warn!(destination_id=%d.id,"Base startup or journal reconciliation rejected");
                                continue;
                            }
                        },
                        Err(_) => {
                            tracing::warn!(destination_id=%d.id,"Base customer connection unavailable");
                            continue;
                        }
                    }
                }
                let Some(c) = connections.get(&d.id) else {
                    continue;
                };
                if !reconciled && d.restore_required {
                    match validate_connection(&store, &d, c).await {
                        Ok(Some(_)) => reconciled = true,
                        Ok(None) => continue,
                        Err(_) => {
                            tracing::warn!(destination_id=%d.id,"Base canonical rescan or journal recovery remains unresolved");
                            continue;
                        }
                    }
                }
                if !reconciled {
                    match reconcile_events(&store, &d, c).await {
                        Ok(Reconciliation::Complete) => {}
                        Ok(Reconciliation::Pending(stage)) => {
                            tracing::info!(destination_id=%d.id,?stage,"Base canonical reconciliation deferred; no effects attempted");
                            continue;
                        }
                        Err(_) => {
                            tracing::warn!(destination_id=%d.id,"Base event reconciliation unresolved; no effects attempted");
                            continue;
                        }
                    }
                }
                if d.enabled
                    && let Err(_error) = store.schedule_base_anchor(d.corp_id, d.id).await
                {
                    tracing::warn!(destination_id=%d.id,"Base schedule blocked by evidence or authority");
                }
                match store.claim_base_intent(d.corp_id, d.id, worker).await {
                    Ok(Some(claim)) => {
                        if let Err(error) = drive_intent(&store, &d, c, &claim).await {
                            let state = match error.downcast_ref::<crony_base::Error>() {
                                Some(crony_base::Error::Admission(message))
                                    if *message == "awaiting funds" =>
                                {
                                    "awaiting_funds"
                                }
                                Some(crony_base::Error::Admission(_)) => "fee_deferred",
                                Some(crony_base::Error::Signing(_)) => "signer_unavailable",
                                _ => "rpc_unavailable",
                            };
                            if store.release_base_claim(&claim, state).await.is_err() {
                                tracing::warn!(destination_id=%d.id,"Base worker fenced or paused during retry");
                            }
                            tracing::warn!(destination_id=%d.id,state,"Base intent retained for reconciliation");
                        }
                    }
                    Ok(None) => {}
                    Err(_) => tracing::warn!(destination_id=%d.id,"Base durable claim unavailable"),
                }
            }
        }
    })
}

async fn reconcile_events(
    store: &PgStore,
    d: &BaseDestination,
    c: &Connected,
) -> Result<Reconciliation> {
    let latest = c.chain.primary.block(BlockTag::Latest).await?;
    let other = c.chain.secondary.block(BlockTag::Latest).await?;
    let end = latest.number.min(other.number);
    let sealed = c.chain.primary.block(BlockTag::Number(end)).await?;
    ensure!(
        sealed == c.chain.secondary.block(BlockTag::Number(end)).await?,
        "provider sealed-head disagreement"
    );
    if let (Some(number), Some(hash)) = (d.scan_block, &d.scan_hash) {
        let current = c
            .chain
            .primary
            .block(BlockTag::Number(u64::try_from(number)?))
            .await?;
        ensure!(
            current
                == c.chain
                    .secondary
                    .block(BlockTag::Number(current.number))
                    .await?,
            "provider scan-cursor disagreement"
        );
        if current.hash != B256::from_str(hash)? {
            store
                .record_base_reorg(d.corp_id, d.id, B256::from_str(hash)?, &current)
                .await?;
            anyhow::bail!("canonical scan cursor reorged");
        }
    }
    let Some(observation_fence) = reconcile_retained_observations(store, d, c, &sealed).await?
    else {
        return Ok(Reconciliation::Pending(
            ReconciliationStage::RetainedObservations,
        ));
    };
    let deployment = d.input.trusted_manifest()?.manifest.deployment_block_number;
    let mut from = d
        .scan_block
        .map(u64::try_from)
        .transpose()?
        .map(|n| n.saturating_sub(16))
        .unwrap_or(deployment)
        .max(deployment);
    let mut range = 1000_u64;
    // Bounded per tick; old chains catch up continuously rather than one unbounded startup call.
    for _ in 0..16 {
        if from > end {
            break;
        }
        let to = from.saturating_add(range - 1).min(end);
        let logs = match c
            .chain
            .primary
            .logs(
                d.input.config.contract_address,
                d.input.config.stream_id,
                from,
                to,
            )
            .await
        {
            Ok(logs) => logs,
            Err(error) if range > 1 => {
                range = (range / 2).max(1);
                tracing::debug!("Base log scan narrowed after provider failure");
                let _ = error;
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let secondary = c
            .chain
            .secondary
            .logs(
                d.input.config.contract_address,
                d.input.config.stream_id,
                from,
                to,
            )
            .await?;
        ensure!(logs == secondary, "independent log providers disagree");
        for log in logs {
            let event = crony_base::rpc::AnchorEvent::decode(&log)?;
            let receipt = c
                .chain
                .primary
                .receipt(event.transaction_hash)
                .await?
                .context("event receipt missing")?;
            let other = c
                .chain
                .secondary
                .receipt(event.transaction_hash)
                .await?
                .context("independent event receipt missing")?;
            ensure!(
                receipt.receipt == other.receipt && receipt.l1_fee == other.l1_fee,
                "independent receipts disagree"
            );
            let block = c
                .chain
                .primary
                .block(BlockTag::Number(event.block_number))
                .await?;
            ensure!(
                block
                    == c.chain
                        .secondary
                        .block(BlockTag::Number(event.block_number))
                        .await?,
                "independent inclusion headers disagree"
            );
            store
                .observe_base_event(d.corp_id, d.id, &event, &receipt, &block)
                .await?;
        }
        let cursor = c.chain.primary.block(BlockTag::Number(to)).await?;
        ensure!(
            cursor == c.chain.secondary.block(BlockTag::Number(to)).await?,
            "independent cursor headers disagree"
        );
        store.record_base_scan(d.corp_id, d.id, &cursor).await?;
        from = to.checked_add(1).context("scan block overflow")?;
    }
    if from <= end {
        return Ok(Reconciliation::Pending(ReconciliationStage::HistoricalScan));
    }
    let head = c
        .chain
        .primary
        .head(
            d.input.config.contract_address,
            d.input.config.stream_id,
            sealed.hash,
        )
        .await?;
    ensure!(
        head == c
            .chain
            .secondary
            .head(
                d.input.config.contract_address,
                d.input.config.stream_id,
                sealed.hash
            )
            .await?,
        "provider stream heads disagree"
    );
    let refreshed = store
        .base_worker_destinations(&[d.id])
        .await?
        .into_iter()
        .find(|x| x.id == d.id && x.corp_id == d.corp_id)
        .context("destination disappeared")?;
    ensure!(
        head.sequence == u64::try_from(refreshed.observed_sequence)?
            && (head.sequence == 0
                || refreshed.observed_digest.as_deref() == Some(&hex::encode(head.digest))),
        "unscanned or conflicting canonical stream head"
    );
    if !store
        .finish_base_observation_sweep(&observation_fence)
        .await?
    {
        return Ok(Reconciliation::Pending(
            ReconciliationStage::NewObservations,
        ));
    }
    Ok(Reconciliation::Complete)
}

async fn reconcile_retained_observations(
    store: &PgStore,
    d: &BaseDestination,
    c: &Connected,
    tip: &SealedHeader,
) -> Result<Option<crony_store::base_observations::BaseObservationFence>> {
    let page = store.base_observation_page(d.corp_id, d.id, tip).await?;
    // The persisted tip protects pages checked by a previous process from an intervening fork.
    for old in std::iter::once(&page.anchor).chain(page.headers.iter()) {
        ensure!(
            old.number <= tip.number,
            "provider head is behind retained observations"
        );
        let current = c.chain.primary.block(BlockTag::Number(old.number)).await?;
        ensure!(
            current
                == c.chain
                    .secondary
                    .block(BlockTag::Number(old.number))
                    .await?,
            "provider retained-header disagreement"
        );
        if old.hash != current.hash {
            store
                .record_base_reorg(d.corp_id, d.id, old.hash, &current)
                .await?;
            anyhow::bail!("retained inclusion, finalized observation, or sweep tip contradicted");
        }
        ensure!(
            current == *old,
            "retained header fields disagree with their hash"
        );
    }
    ensure!(
        c.chain.primary.block(BlockTag::Number(tip.number)).await? == *tip
            && c.chain
                .secondary
                .block(BlockTag::Number(tip.number))
                .await?
                == *tip,
        "canonical observation tip changed while checking page"
    );
    // Terminal intents are deliberately unclaimable. Their retained spend proof
    // supplies accounting identity without restoring any signing/broadcast authority.
    for (evidence_id, prior) in store
        .base_terminal_fee_receipts(d.corp_id, d.id, &page.evidence_ids)
        .await?
    {
        let (receipt, block) = c
            .chain
            .receipt_inclusion(prior.receipt.transaction_hash)
            .await?
            .context("terminal finalized receipt unavailable")?;
        receipt.ensure_successor_of(&prior)?;
        if receipt.l1_fee.is_some() {
            store
                .reconcile_base_terminal_fee(d.corp_id, d.id, evidence_id, &receipt, &block)
                .await?;
        }
    }
    store.acknowledge_base_observation_page(&page, tip).await
}

async fn receipt_finality(
    c: &Connected,
    ancestry: &dyn crony_base::ancestry::AncestryStore,
    receipt: &ReceiptEvidence,
    block: &SealedHeader,
) -> Result<Option<(ReceiptEvidence, Vec<FinalityObservation>)>> {
    let Some(finalized) = c
        .chain
        .verify_receipt_finality_resumable(receipt.receipt.transaction_hash, ancestry)
        .await?
    else {
        return Ok(None);
    };
    finalized.receipt.ensure_successor_of(receipt)?;
    ensure!(
        finalized.included == *block,
        "receipt changed between inclusion and finality"
    );
    Ok(Some((finalized.receipt, finalized.observations)))
}

async fn drive_intent(
    store: &PgStore,
    d: &BaseDestination,
    c: &Connected,
    claim: &BaseClaim,
) -> Result<()> {
    let ancestry = store.base_ancestry(d.corp_id, d.id);
    let mut attempts = store.base_attempts(claim).await?;
    let call = AnchorCall {
        stream_id: d.input.config.stream_id,
        sequence: u64::try_from(claim.intent.sequence)?,
        checkpoint_digest: B256::from_str(&claim.intent.checkpoint_digest)?,
        previous_anchor_digest: B256::from_str(&claim.intent.previous_digest)?,
    };
    let original = store.base_original_event(d.corp_id, d.id, &call).await?;
    if attempts.is_empty() {
        if let Some(event) = original {
            let Some(finalized) = c
                .chain
                .verify_anchor_resumable(event.transaction_hash, &call, event.publisher, &ancestry)
                .await?
            else {
                store.release_base_claim(claim, "ready").await?;
                return Ok(());
            };
            store.finalize_base_anchor(claim, &finalized).await?;
            return Ok(());
        }
        let startup = c
            .chain
            .startup(d.input.config.publisher, c.settings.expected_owner)
            .await?;
        let latest = c.chain.primary.block(BlockTag::Latest).await?;
        ensure!(
            latest
                == c.chain
                    .secondary
                    .block(BlockTag::Number(latest.number))
                    .await?,
            "quote block disagreement"
        );
        ensure!(
            startup.head.sequence < call.sequence,
            "canonical head already advanced"
        );
        let nonce = c
            .chain
            .primary
            .nonce(d.input.config.publisher, BlockTag::Pending)
            .await?;
        ensure!(
            nonce
                == c.chain
                    .secondary
                    .nonce(d.input.config.publisher, BlockTag::Pending)
                    .await?,
            "provider pending nonce disagreement"
        );
        let (max_fee, priority) = c.chain.primary.fee_suggestion().await?;
        let candidate = FrozenTransaction {
            chain_id: d.input.config.chain_id,
            sender: d.input.config.publisher,
            contract: d.input.config.contract_address,
            nonce,
            gas_limit: d
                .input
                .config
                .spending_policy
                .as_ref()
                .context("missing fee policy")?
                .max_gas,
            max_fee_per_gas: max_fee,
            max_priority_fee_per_gas: priority,
            call: call.clone(),
        };
        c.chain.primary.simulate(&candidate, latest.hash).await?;
        let quote = c
            .chain
            .primary
            .quote(&candidate, latest.hash, &c.settings.fee_oracle)
            .await?;
        let balance = c
            .chain
            .primary
            .balance(d.input.config.publisher, latest.hash)
            .await?;
        attempts.push(
            store
                .reserve_base_attempt(claim, &quote, balance, nonce, false)
                .await?,
        );
    }
    // Check every same-nonce hash before replacing or rebroadcasting the newest one.
    for attempt in &mut attempts {
        if attempt.signed.is_none()
            && let Some(signed) = c.gateway.lookup(&attempt.request).await?
        {
            store
                .persist_base_signed(claim, &attempt.request, &signed, 0)
                .await?;
            attempt.signed = Some(signed);
        }
        let Some(signed) = &attempt.signed else {
            continue;
        };
        if let Some((receipt, block)) = c.chain.receipt_inclusion(signed.hash()).await? {
            store.record_base_inclusion(claim, &receipt, &block).await?;
            let Some((receipt, observations)) =
                receipt_finality(c, &ancestry, &receipt, &block).await?
            else {
                store.release_base_claim(claim, "included").await?;
                return Ok(());
            };
            store
                .record_base_spend_finality(claim, &receipt, &block, &observations)
                .await?;
            if !receipt.receipt.status() {
                return Ok(());
            }
            let event = match receipt.exact_event_or_replay(
                d.input.config.contract_address,
                &call,
                d.input.config.publisher,
            )? {
                Some(event) => event,
                None => store
                    .base_original_event(d.corp_id, d.id, &call)
                    .await?
                    .context("successful no-op receipt has no established original event")?,
            };
            let Some(finalized) = c
                .chain
                .verify_anchor_resumable(event.transaction_hash, &call, event.publisher, &ancestry)
                .await?
            else {
                store.release_base_claim(claim, "included").await?;
                return Ok(());
            };
            store.finalize_base_anchor(claim, &finalized).await?;
            return Ok(());
        }
    }
    if !d.enabled {
        store
            .release_base_claim(claim, "dropped_or_unknown")
            .await?;
        return Ok(());
    }
    let nonce = c.chain.latest_nonce(d.input.config.publisher).await?;
    let mut attempt = attempts.last().context("frozen attempt absent")?.clone();
    if nonce > attempt.request.transaction.nonce {
        store
            .quarantine_base_wallet(claim, "nonce_conflict")
            .await?;
        anyhow::bail!("unknown transaction consumed publisher nonce");
    }
    let policy = d
        .input
        .config
        .spending_policy
        .as_ref()
        .context("spending policy absent")?;
    if attempt.signed.is_some()
        && attempt.ordinal < policy.max_replacements
        && chrono::Utc::now().signed_duration_since(attempt.created_at)
            >= chrono::Duration::minutes(5)
    {
        let block = c.chain.primary.block(BlockTag::Latest).await?;
        let (suggested, priority) = c.chain.primary.fee_suggestion().await?;
        let bump = |fee: u128| -> Result<u128> {
            fee.checked_mul(9)
                .and_then(|f| f.checked_add(7))
                .map(|f| f / 8)
                .and_then(|f| if f > fee { Some(f) } else { fee.checked_add(1) })
                .context("replacement fee overflow")
        };
        let mut transaction = attempt.request.transaction.clone();
        transaction.max_fee_per_gas = suggested.max(bump(transaction.max_fee_per_gas)?);
        transaction.max_priority_fee_per_gas =
            priority.max(bump(transaction.max_priority_fee_per_gas)?);
        c.chain.primary.simulate(&transaction, block.hash).await?;
        let quote = c
            .chain
            .primary
            .quote(&transaction, block.hash, &c.settings.fee_oracle)
            .await?;
        let balance = c
            .chain
            .primary
            .balance(transaction.sender, block.hash)
            .await?;
        attempt = store
            .reserve_base_attempt(claim, &quote, balance, nonce, true)
            .await?;
    }
    let signed = match &attempt.signed {
        Some(signed) => signed.clone(),
        None => {
            store.check_base_fence(claim).await?;
            let signed = c.gateway.sign(&attempt.request).await?;
            store
                .persist_base_signed(claim, &attempt.request, &signed, 0)
                .await?;
            signed
        }
    };
    store.check_base_fence(claim).await?;
    c.chain.primary.broadcast(&signed).await?;
    store.release_base_claim(claim, "broadcast").await?;
    Ok(())
}
