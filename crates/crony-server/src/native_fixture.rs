//! Opt-in local infrastructure for the normal server/worker, never a worker substitute.
#[cfg(not(debug_assertions))]
compile_error!("native fixture is forbidden in release builds");

use alloy::{
    consensus::{SignableTransaction, TxEip1559, TxEnvelope},
    eips::eip2718::Encodable2718,
    network::TxSigner,
    primitives::keccak256,
    signers::local::PrivateKeySigner,
    sol_types::SolCall,
};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use crony_base::{
    Address, B256, Bytes, U256,
    abi::ECorpCheckpointRegistryV1,
    config::{Assurance, BaseDestinationConfig},
    fees::SpendingPolicy,
    gateway::{GatewayAccess, router},
    manifest::{
        CheckpointKey, DestinationManifestV1, ManifestTrust, NetworkIdentity, SignedManifest,
        TrustPin,
    },
    signing::{
        GatewayIdentity, JournalSnapshot, NonExportableSigner, PolicyGateway,
        PostgresSigningJournal, SignRequest, SignedTransaction, SigningGateway,
    },
};
use crony_store::{PgStore, base_audit::BaseDestinationInput};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use uuid::Uuid;

const NODE: &str = "http://127.0.0.1:18557";
const ORACLE: &str = "0x420000000000000000000000000000000000000F";
const ORACLE_CODE: &str = "0x6103e860005260206000f3";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    corp_id: Uuid,
    ledger_id: Uuid,
    checkpoint_key_id: String,
    checkpoint_public_key: [u8; 32],
    host_directory: PathBuf,
    output_directory: PathBuf,
}

async fn node(method: &str, params: Value) -> Result<Value> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()?;
    node_with_client(&client, method, params).await
}

async fn node_with_client(client: &reqwest::Client, method: &str, params: Value) -> Result<Value> {
    let reply: Value = client
        .post(NODE)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    ensure!(
        reply.get("error").is_none(),
        "local provisioning RPC failed: {method}"
    );
    reply
        .get("result")
        .cloned()
        .context("local RPC result missing")
}

async fn receipt(hash: Value) -> Result<Value> {
    for _ in 0..100 {
        let value = node("eth_getTransactionReceipt", json!([hash])).await?;
        if !value.is_null() {
            ensure!(value["status"] == "0x1", "local provisioning reverted");
            return Ok(value);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("local provisioning receipt timed out")
}

struct LocalSigner {
    signer: PrivateKeySigner,
    calls: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl NonExportableSigner for LocalSigner {
    fn address(&self) -> Address {
        self.signer.address()
    }
    fn immutable_key_identity(&self) -> &str {
        "native-qualification-memory-key"
    }
    async fn sign_transaction(&self, mut tx: TxEip1559) -> crony_base::Result<Bytes> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let signature = self
            .signer
            .sign_transaction(&mut tx)
            .await
            .map_err(|_| crony_base::Error::Signing("local fixture signing failed"))?;
        Ok(TxEnvelope::Eip1559(tx.into_signed(signature))
            .encoded_2718()
            .into())
    }
}

struct HeldReply {
    inner: Arc<dyn SigningGateway>,
    held: Arc<AtomicBool>,
    committed: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl SigningGateway for HeldReply {
    async fn identity(&self) -> crony_base::Result<GatewayIdentity> {
        self.inner.identity().await
    }
    async fn journal_snapshot(
        &self,
        chain: u64,
        publisher: Address,
    ) -> crony_base::Result<JournalSnapshot> {
        self.inner.journal_snapshot(chain, publisher).await
    }
    async fn lookup(&self, request: &SignRequest) -> crony_base::Result<Option<SignedTransaction>> {
        if self.committed.load(Ordering::SeqCst) && self.held.load(Ordering::SeqCst) {
            return Err(crony_base::Error::Signing(
                "local fixture withholding committed response",
            ));
        }
        self.inner.lookup(request).await
    }
    async fn sign(&self, request: &SignRequest) -> crony_base::Result<SignedTransaction> {
        let result = self.inner.sign(request).await?;
        self.committed.store(true, Ordering::SeqCst);
        if self.held.load(Ordering::SeqCst) {
            return Err(crony_base::Error::Signing(
                "local fixture lost response after journal commit",
            ));
        }
        Ok(result)
    }
}

#[derive(Clone)]
struct Controls {
    calls: Arc<AtomicUsize>,
    held: Arc<AtomicBool>,
    committed: Arc<AtomicBool>,
}
async fn metrics(State(state): State<Controls>) -> Json<Value> {
    Json(json!({"signatures":state.calls.load(Ordering::SeqCst),
        "response_held":state.held.load(Ordering::SeqCst),
        "journal_committed":state.committed.load(Ordering::SeqCst)}))
}
async fn release(State(state): State<Controls>) -> Json<Value> {
    state.held.store(false, Ordering::SeqCst);
    Json(json!({"released":true}))
}
async fn secondary(
    State(client): State<reqwest::Client>,
    Json(request): Json<Value>,
) -> Result<Json<Value>, axum::http::StatusCode> {
    let method = request["method"]
        .as_str()
        .ok_or(axum::http::StatusCode::BAD_REQUEST)?;
    if !matches!(
        method,
        "eth_chainId"
            | "eth_getBlockByNumber"
            | "eth_getBlockByHash"
            | "eth_getCode"
            | "eth_call"
            | "eth_getBalance"
            | "eth_getTransactionCount"
            | "eth_getTransactionReceipt"
            | "eth_getTransactionByHash"
            | "eth_getLogs"
            | "eth_estimateGas"
            | "eth_gasPrice"
            | "eth_maxPriorityFeePerGas"
            | "eth_feeHistory"
    ) {
        return Err(axum::http::StatusCode::FORBIDDEN);
    }
    let result = node_with_client(&client, method, request["params"].clone())
        .await
        .map_err(|_| axum::http::StatusCode::BAD_GATEWAY)?;
    Ok(Json(
        json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
    ))
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::var("CRONY_NATIVE_QUALIFICATION").as_deref() == Ok("1"),
        "explicit local fixture opt-in required"
    );
    let config_path =
        std::env::var_os("CRONY_NATIVE_FIXTURE_CONFIG_FILE").context("fixture input required")?;
    let input: Input = crony_audit::parse_json(&std::fs::read(config_path)?)?;
    ensure!(
        input.host_directory.is_absolute() && input.output_directory.is_absolute(),
        "absolute fixture paths required"
    );
    ensure!(
        node("eth_chainId", json!([])).await? == "0x14a34",
        "wrong local fixture chain"
    );
    let accounts: Vec<Address> = serde_json::from_value(node("eth_accounts", json!([])).await?)?;
    let owner = *accounts.first().context("local owner missing")?;
    let signer = PrivateKeySigner::random();
    let publisher = signer.address();
    node(
        "anvil_setBalance",
        json!([publisher, "0x3635c9adc5dea00000"]),
    )
    .await?;
    node("anvil_setCode", json!([ORACLE, ORACLE_CODE])).await?;
    let compiled: Value = serde_json::from_str(include_str!(
        "../../../contracts/ECorpCheckpointRegistryV1.compiled.json"
    ))?;
    let code = compiled["contract"]["evm"]["bytecode"]["object"]
        .as_str()
        .context("registry bytecode missing")?;
    let deployment = receipt(node("eth_sendTransaction", json!([{"from":owner,"data":format!("0x{}",code.trim_start_matches("0x")),"gas":"0x600000"}])).await?).await?;
    let registry: Address = serde_json::from_value(deployment["contractAddress"].clone())?;
    let local_key = B256::from_slice(&Uuid::new_v4().as_bytes().repeat(2));
    let stream = crony_base::abi::stream_id(owner, local_key);
    let registration = ECorpCheckpointRegistryV1::registerCall {
        localStreamKey: local_key,
        publisher,
    }
    .abi_encode();
    let registered = receipt(
        node(
            "eth_sendTransaction",
            json!([{"from":owner,"to":registry,"data":Bytes::from(registration),"gas":"0x600000"}]),
        )
        .await?,
    )
    .await?;
    node("anvil_mine", json!(["0x40"])).await?;
    let runtime: Bytes =
        serde_json::from_value(node("eth_getCode", json!([registry, "latest"])).await?)?;
    let genesis = node("eth_getBlockByNumber", json!(["0x0", false])).await?;
    let authority = crony_audit::SigningKey::from_bytes(&rand_bytes());
    let manifest = DestinationManifestV1 {
        schema_version: 1,
        customer_trust_id: B256::from_slice(&Uuid::new_v4().as_bytes().repeat(2)),
        manifest_version: 1,
        previous_manifest_digest: None,
        ledger_id: input.ledger_id.to_string(),
        chain_id: 84532,
        network_identity: NetworkIdentity {
            genesis_hash: serde_json::from_value(genesis["hash"].clone())?,
            checkpoint: None,
        },
        contract_address: registry,
        contract_version: 1,
        runtime_code_hash: keccak256(runtime),
        deployment_block_hash: serde_json::from_value(deployment["blockHash"].clone())?,
        deployment_block_number: u64::from_str_radix(
            deployment["blockNumber"]
                .as_str()
                .context("deployment number")?
                .trim_start_matches("0x"),
            16,
        )?,
        stream_id: stream,
        registering_owner: owner,
        local_stream_key: local_key,
        checkpoint_keys: vec![CheckpointKey {
            key_id: input.checkpoint_key_id,
            public_key: input.checkpoint_public_key,
            first_sequence: 1,
            last_sequence: None,
        }],
        assurance_policy: Assurance::ProviderObservedFinalized,
        evidence_retention_policy: "local-qualification-retained".into(),
        migration: None,
        next_manifest_authority: None,
    };
    let signed = SignedManifest::sign(manifest, &authority, None)?;
    let policy = SpendingPolicy {
        max_gas: 1_000_000,
        max_fee_per_gas: 100_000_000_000,
        max_priority_fee_per_gas: 10_000_000_000,
        max_attempt_fee: U256::from(1_000_000_000_000_000_000_u128),
        monthly_budget: U256::from(2_000_000_000_000_000_000_u128),
        safety_margin_bps: 2000,
        max_replacements: 2,
        quote_max_age_seconds: 60,
        max_deferral_seconds: 3600,
        low_balance_threshold: U256::from(100),
    };
    let destination = BaseDestinationInput {
        id: Uuid::new_v4(),
        config: BaseDestinationConfig {
            chain_id: 84532,
            manifest_digest: signed.digest,
            contract_address: registry,
            stream_id: stream,
            publisher,
            primary_rpc_secret: "fixture/primary".into(),
            secondary_rpc_secret: "fixture/secondary".into(),
            primary_operator: "local-anvil-primary".into(),
            secondary_operator: "local-proxy-same-anvil-not-independent".into(),
            signer_gateway_identity: "worker-gateway".into(),
            signer_key_identity: "native-qualification-memory-key".into(),
            customer_accepted_network_risk: true,
            customer_accepted_public_metadata: true,
            spending_policy: Some(policy.clone()),
            ..Default::default()
        },
        trust_pin: TrustPin {
            authority: authority.verifying_key().to_bytes(),
            initial_manifest_digest: signed.digest,
        },
        manifests: vec![signed],
        retention_days: 3650,
    };
    let app_database = std::env::var("DATABASE_URL").context("application database required")?;
    let journal_database = std::env::var("CRONY_NATIVE_JOURNAL_DATABASE_URL")
        .context("separate journal database required")?;
    ensure!(
        app_database != journal_database,
        "journal database must be separate"
    );
    let store = PgStore::connect(&app_database).await?;
    let journal = PgPoolOptions::new()
        .max_connections(5)
        .connect(&journal_database)
        .await?;
    sqlx::raw_sql(include_str!("../../crony-base/gateway-journal.sql"))
        .execute(&journal)
        .await?;
    let controls = Controls {
        calls: Arc::new(AtomicUsize::new(0)),
        held: Arc::new(AtomicBool::new(true)),
        committed: Arc::new(AtomicBool::new(false)),
    };
    let gateway = PolicyGateway::new(
        PostgresSigningJournal::new(journal),
        store,
        LocalSigner {
            signer,
            calls: controls.calls.clone(),
        },
        ManifestTrust::bootstrap(&destination.trust_pin, &destination.manifests[0])?,
        policy,
    )?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let app = router(
        Arc::new(HeldReply {
            inner: Arc::new(gateway),
            held: controls.held.clone(),
            committed: controls.committed.clone(),
        }),
        GatewayAccess::new(token.as_bytes(), BTreeSet::from([input.corp_id]))?,
    )
    .merge(
        Router::new()
            .route("/qualification/metrics", get(metrics))
            .route("/qualification/release", post(release))
            .with_state(controls),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:18560").await?;
    let proxy_listener = tokio::net::TcpListener::bind("127.0.0.1:18559").await?;
    let secrets_path = input.host_directory.join("base-secrets.json");
    std::fs::write(
        &secrets_path,
        serde_json::to_vec_pretty(&json!({
            "fixture/primary":{"url":NODE,"bearer":null},
            "fixture/secondary":{"url":"http://127.0.0.1:18559","bearer":null},
            "fixture/gateway":{"url":"http://127.0.0.1:18560","bearer":token}
        }))?,
    )?;
    std::fs::write(
        input.host_directory.join("base-worker.json"),
        serde_json::to_vec_pretty(&json!({
            "secrets_file":secrets_path,"connections":[{"destination_id":destination.id,"expected_owner":owner,
            "gateway_secret":"fixture/gateway","allowed_hosts":[],
            "fee_oracle":{"qualification_id":"local-fixed-fee-not-base-fee-qualification",
            "runtime_code_hash":keccak256(hex::decode(ORACLE_CODE.trim_start_matches("0x"))?),"implementation":null}}]
        }))?,
    )?;
    std::fs::write(
        input.output_directory.join("destination.json"),
        serde_json::to_vec_pretty(&destination)?,
    )?;
    std::fs::write(
        input.output_directory.join("local-provisioning.json"),
        serde_json::to_vec_pretty(&json!({
            "registry":registry,"stream":stream,"publisher":publisher,"owner":owner,"deployment":deployment,"registration":registered,
            "provider_independence":false,"gateway":"policy-gateway/native-postgres-journal/memory-only-test-signer"
        }))?,
    )?;
    let proxy = Router::new().route("/", post(secondary)).with_state(
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(30))
            .build()?,
    );
    println!("Local fixture ready; signing key remains memory-only; no public network operations.");
    tokio::try_join!(async { axum::serve(listener, app).await }, async {
        axum::serve(proxy_listener, proxy).await
    })?;
    Ok(())
}

fn rand_bytes() -> [u8; 32] {
    let mut bytes = [0; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes
}
