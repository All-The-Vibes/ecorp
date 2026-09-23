use super::*;
use alloy::{
    consensus::{SignableTransaction, TxEip1559, TxEnvelope},
    eips::eip2718::Encodable2718,
    network::TxSigner,
    primitives::keccak256,
    signers::local::PrivateKeySigner,
    sol_types::{SolCall, SolEvent, SolValue},
};
use crony_base::{
    Bytes, U256,
    abi::ECorpCheckpointRegistryV1,
    config::{Assurance, BaseDestinationConfig},
    fees::SpendingPolicy,
    gateway::{GatewayAccess, router},
    manifest::{CheckpointKey, DestinationManifestV1, NetworkIdentity, SignedManifest, TrustPin},
    signing::{
        GatewayIdentity, JournalSnapshot, NonExportableSigner, PolicyGateway,
        PostgresSigningJournal, SignRequest, SignedTransaction,
    },
};
use crony_domain::{MissionContractRevisionAction, TaskGraphPlan};
use crony_store::{CreateMissionContractRevisionInput, base_audit::BaseDestinationInput};
use futures_util::FutureExt;
use sqlx::{ConnectOptions, PgPool, postgres::PgPoolOptions};
use std::sync::atomic::{AtomicUsize, Ordering};

const NODE: &str = "http://127.0.0.1:18556";
const TOKEN: &str = "local-worker-fixture-credential-not-production";
const ORACLE: &str = "0x420000000000000000000000000000000000000F";
const ORACLE_CODE: &str = "0x6103e860005260206000f3";

#[derive(Default)]
struct ArchiveTransport(std::sync::Mutex<BTreeMap<String, Vec<u8>>>);

impl crony_audit::PublicationTransport for ArchiveTransport {
    fn head(&self) -> futures_util::future::BoxFuture<'_, Result<String>> {
        async { Ok("worker-fixture-archive-head".into()) }.boxed()
    }
    fn descends_from<'a>(
        &'a self,
        old: &'a str,
        new: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<bool>> {
        async move { Ok(old == new) }.boxed()
    }
    fn read<'a>(
        &'a self,
        path: &'a str,
        _head: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<Option<Vec<u8>>>> {
        async move { Ok(self.0.lock().unwrap().get(path).cloned()) }.boxed()
    }
    fn create<'a>(
        &'a self,
        path: &'a str,
        body: &'a [u8],
    ) -> futures_util::future::BoxFuture<'a, Result<()>> {
        async move {
            let mut files = self.0.lock().unwrap();
            ensure!(
                !files.contains_key(path),
                "immutable fixture archive collision"
            );
            files.insert(path.into(), body.into());
            Ok(())
        }
        .boxed()
    }
}

async fn node(method: &str, params: Value) -> Result<Value> {
    let response: Value = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(if method == "anvil_mine" {
            120
        } else {
            15
        }))
        .build()?
        .post(NODE)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        .send()
        .await
        .with_context(|| format!("owned fixture RPC {method}"))?
        .error_for_status()?
        .json()
        .await?;
    ensure!(
        response.get("error").is_none(),
        "local fixture RPC {method} returned error code {:?}",
        response["error"]["code"].as_i64()
    );
    response
        .get("result")
        .cloned()
        .context("RPC result missing")
}

async fn node_receipt(hash: Value) -> Result<Value> {
    for _ in 0..200 {
        let receipt = node("eth_getTransactionReceipt", json!([hash])).await?;
        if !receipt.is_null() {
            return Ok(receipt);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("owned fixture transaction did not mine before timeout")
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
        "worker-fixture-key"
    }
    async fn sign_transaction(&self, mut transaction: TxEip1559) -> crony_base::Result<Bytes> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let signature = self
            .signer
            .sign_transaction(&mut transaction)
            .await
            .map_err(|_| crony_base::Error::Signing("fixture signature failed"))?;
        Ok(TxEnvelope::Eip1559(transaction.into_signed(signature))
            .encoded_2718()
            .into())
    }
}

struct LostReplyGateway {
    inner: Arc<dyn SigningGateway>,
    replies: AtomicUsize,
}

#[async_trait::async_trait]
impl SigningGateway for LostReplyGateway {
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
        self.inner.lookup(request).await
    }
    async fn sign(&self, request: &SignRequest) -> crony_base::Result<SignedTransaction> {
        let signed = self.inner.sign(request).await?;
        if self.replies.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(crony_base::Error::Signing(
                "fixture lost reply after durable commit",
            ));
        }
        Ok(signed)
    }
}

struct AbortTask(tokio::task::JoinHandle<()>);
impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Clone, Default)]
struct ObservationRpc {
    blocks: Arc<std::sync::Mutex<Vec<u64>>>,
    forks: Arc<std::sync::Mutex<BTreeMap<u64, B256>>>,
    event: Arc<std::sync::Mutex<Option<ObservationEvent>>>,
}

#[derive(Clone)]
struct ObservationEvent {
    number: u64,
    log: Value,
    receipt: Value,
    head: Bytes,
}

fn observation_event(input: &BaseDestinationInput) -> ObservationEvent {
    let number = 19_999;
    let block = observation_header(number);
    let hash = B256::repeat_byte(91);
    let digest = B256::repeat_byte(92);
    let event = ECorpCheckpointRegistryV1::Anchored {
        streamId: input.config.stream_id,
        sequence: 1,
        checkpointDigest: digest,
        previousAnchorDigest: B256::ZERO,
        anchorOrdinal: 1,
        publisher: input.config.publisher,
    }
    .encode_log_data();
    let log = json!({"address":input.config.contract_address,"topics":event.topics(),"data":event.data,
        "blockHash":block.hash,"blockNumber":format!("0x{number:x}"),"transactionHash":hash,
        "transactionIndex":"0x0","logIndex":"0x0","removed":false});
    let receipt = json!({"type":"0x2","status":"0x1","transactionHash":hash,"transactionIndex":"0x0",
        "blockHash":block.hash,"blockNumber":format!("0x{number:x}"),"from":input.config.publisher,"to":input.config.contract_address,
        "cumulativeGasUsed":"0x2710","gasUsed":"0x2710","effectiveGasPrice":"0x5","l1Fee":"0x1",
        "logsBloom":format!("0x{}","00".repeat(256)),"logs":[log.clone()],"contractAddress":null});
    let head = (
        true,
        input.manifests[0].manifest.registering_owner,
        Address::ZERO,
        input.config.publisher,
        false,
        1_u64,
        digest,
        B256::ZERO,
        1_u64,
    )
        .abi_encode_params()
        .into();
    ObservationEvent {
        number,
        log,
        receipt,
        head,
    }
}

fn observation_header(number: u64) -> SealedHeader {
    SealedHeader {
        number,
        hash: B256::from(U256::from(number + 1)),
        parent_hash: B256::from(U256::from(number)),
        timestamp: number,
    }
}

async fn observation_rpc(
    axum::extract::State(state): axum::extract::State<ObservationRpc>,
    axum::Json(request): axum::Json<Value>,
) -> axum::Json<Value> {
    let result = match request["method"].as_str().expect("fixture RPC method") {
        "eth_getBlockByNumber" => {
            let tag = request["params"][0].as_str().expect("fixture block tag");
            let number = if tag == "latest" {
                20_000
            } else {
                u64::from_str_radix(tag.trim_start_matches("0x"), 16).expect("fixture block number")
            };
            state.blocks.lock().unwrap().push(number);
            let mut block = observation_header(number);
            if let Some(hash) = state.forks.lock().unwrap().get(&number) {
                block.hash = *hash;
            }
            json!({"number":format!("0x{number:x}"),"hash":block.hash,
                "parentHash":block.parent_hash,"timestamp":format!("0x{number:x}")})
        }
        "eth_getLogs" => {
            let from = u64::from_str_radix(
                request["params"][0]["fromBlock"]
                    .as_str()
                    .unwrap()
                    .trim_start_matches("0x"),
                16,
            )
            .unwrap();
            let to = u64::from_str_radix(
                request["params"][0]["toBlock"]
                    .as_str()
                    .unwrap()
                    .trim_start_matches("0x"),
                16,
            )
            .unwrap();
            match state.event.lock().unwrap().as_ref() {
                Some(event) if (from..=to).contains(&event.number) => json!([event.log]),
                _ => json!([]),
            }
        }
        "eth_getTransactionReceipt" => {
            let event = state.event.lock().unwrap();
            let event = event.as_ref().expect("fixture receipt");
            assert_eq!(request["params"][0], event.receipt["transactionHash"]);
            event.receipt.clone()
        }
        "eth_call" => match state.event.lock().unwrap().as_ref() {
            Some(event) => json!(event.head),
            None => json!(format!("0x{}", "0".repeat(64 * 9))),
        },
        other => panic!("unexpected paging RPC: {other}"),
    };
    axum::Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
}

async fn observation_connection(
    input: &BaseDestinationInput,
    secrets: &FileSecrets,
) -> Result<Connected> {
    Ok(Connected {
        chain: BaseConnection::connect_test_loopback(
            input.config.clone(),
            ManifestTrust::bootstrap(&input.trust_pin, &input.manifests[0])?,
            secrets,
        )
        .await?,
        gateway: HttpSigningGateway::connect_test_loopback(
            "fixture/gateway",
            "worker-gateway",
            secrets,
        )
        .await?,
        settings: ConnectionSettings {
            destination_id: input.id,
            expected_owner: input.manifests[0].manifest.registering_owner,
            gateway_secret: "fixture/gateway".into(),
            allowed_hosts: BTreeSet::new(),
            fee_oracle: FeeOracleQualification {
                qualification_id: "unused-read-only-fixture".into(),
                runtime_code_hash: B256::repeat_byte(31),
                implementation: None,
            },
        },
    })
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires owned PostgreSQL; HTTP fixture binds fresh loopback ports, no Anvil"]
async fn base_worker_observation_paging_http_restart_and_finalized_boundary(
    pool: PgPool,
) -> Result<()> {
    let store = PgStore::connect(pool.connect_options().to_url_lossy().as_str()).await?;
    let (ids, ledger) = source_fixture(&store).await?;
    let fixture: Value = serde_json::from_str(include_str!(
        "../../crony-base/vectors/full-history-v1.json"
    ))?;
    let mut manifest: DestinationManifestV1 =
        serde_json::from_value(fixture["manifests"][0]["manifest"].clone())?;
    manifest.ledger_id = ledger.to_string();
    manifest.deployment_block_number = 1;
    manifest.checkpoint_keys = vec![CheckpointKey {
        key_id: "worker-checkpoint".into(),
        public_key: crony_audit::SigningKey::from_bytes(&[7; 32])
            .verifying_key()
            .to_bytes(),
        first_sequence: 1,
        last_sequence: None,
    }];
    let authority = crony_audit::SigningKey::from_bytes(&[8; 32]);
    let signed = SignedManifest::sign(manifest, &authority, None)?;
    let input = BaseDestinationInput {
        id: Uuid::new_v4(),
        config: BaseDestinationConfig {
            chain_id: signed.manifest.chain_id,
            manifest_digest: signed.digest,
            contract_address: signed.manifest.contract_address,
            stream_id: signed.manifest.stream_id,
            publisher: Address::repeat_byte(17),
            primary_rpc_secret: "fixture/primary".into(),
            secondary_rpc_secret: "fixture/secondary".into(),
            primary_operator: "fixture-one".into(),
            secondary_operator: "fixture-two".into(),
            signer_gateway_identity: "worker-gateway".into(),
            signer_key_identity: "worker-fixture-key".into(),
            customer_accepted_network_risk: true,
            customer_accepted_public_metadata: true,
            spending_policy: Some(SpendingPolicy {
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
            }),
            ..Default::default()
        },
        trust_pin: TrustPin {
            authority: authority.verifying_key().to_bytes(),
            initial_manifest_digest: signed.digest,
        },
        manifests: vec![signed],
        retention_days: 3650,
    };
    store
        .configure_base_destination(ids.corp_id, ids.alice_actor_id, &input)
        .await?;
    let mut secret_values = BTreeMap::new();
    let mut providers = Vec::new();
    let mut servers = Vec::new();
    for reference in ["fixture/primary", "fixture/secondary"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let state = ObservationRpc::default();
        providers.push(state.clone());
        let router = axum::Router::new()
            .route("/", axum::routing::post(observation_rpc))
            .with_state(state);
        servers.push(AbortTask(tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap()
        })));
        secret_values.insert(reference.into(), SecretValue { url, bearer: None });
    }
    secret_values.insert(
        "fixture/gateway".into(),
        SecretValue {
            url: secret_values["fixture/primary"].url.clone(),
            bearer: Some(TOKEN.into()),
        },
    );
    let secrets = FileSecrets(secret_values);
    let tip = observation_header(20_000);
    sqlx::query("INSERT INTO base_audit_evidence(corp_id,destination_id,kind,identity,evidence) SELECT $1,$2,'inclusion','paging-'||g,jsonb_build_object('block',jsonb_build_object('number',g,'hash','0x'||lpad(to_hex(g+1),64,'0'),'parent_hash','0x'||lpad(to_hex(g),64,'0'),'timestamp',g)) FROM generate_series(1,1056) g")
        .bind(ids.corp_id).bind(input.id).execute(&pool).await?;
    let mut writer = pool.begin().await?;
    sqlx::query("SELECT id FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE")
        .bind(ids.corp_id)
        .bind(input.id)
        .execute(&mut *writer)
        .await?;
    sqlx::query("INSERT INTO base_audit_evidence(corp_id,destination_id,kind,identity,evidence) VALUES($1,$2,'inclusion','paging-1057',$3)")
        .bind(ids.corp_id).bind(input.id).bind(json!({"block":observation_header(1057)})).execute(&mut *writer).await?;
    let reader = store.clone();
    let corp = ids.corp_id;
    let destination = input.id;
    let held_tip = tip.clone();
    let mut blocked = tokio::spawn(async move {
        reader
            .base_observation_page(corp, destination, &held_tip)
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut blocked)
            .await
            .is_err(),
        "watermark capture must wait for the writer holding the destination lock"
    );
    writer.commit().await?;
    assert_eq!(blocked.await??.evidence_ids.len(), 64);

    // A fresh DB pool and HTTP clients each tick exercise durable progress, not process memory.
    for tick in 0..18 {
        let restarted = PgStore::connect(pool.connect_options().to_url_lossy().as_str()).await?;
        let connected = observation_connection(&input, &secrets).await?;
        let before: Vec<_> = providers
            .iter()
            .map(|p| p.blocks.lock().unwrap().len())
            .collect();
        let destination = restarted
            .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
            .await?;
        let result = reconcile_events(&restarted, &destination, &connected).await;
        if tick < 16 {
            assert_eq!(
                result?,
                Reconciliation::Pending(ReconciliationStage::RetainedObservations)
            );
        } else if tick == 16 {
            assert_eq!(
                result?,
                Reconciliation::Pending(ReconciliationStage::HistoricalScan)
            );
            let complete:bool=sqlx::query_scalar("SELECT complete FROM base_audit_observation_sweeps WHERE corp_id=$1 AND destination_id=$2")
                .bind(ids.corp_id).bind(input.id).fetch_one(&pool).await?;
            assert!(
                complete,
                "completed headers persist while bounded event scanning catches up"
            );
        } else {
            assert_eq!(result?, Reconciliation::Complete);
        }
        for (provider, start) in providers.iter().zip(before) {
            assert!(
                provider.blocks.lock().unwrap().len() - start <= 90,
                "RPC work must be bounded per tick"
            );
        }
        restarted.pool().close().await;
    }
    for provider in &providers {
        let blocks = provider.blocks.lock().unwrap();
        assert!(
            (1..=1057).all(|number| blocks.contains(&number)),
            "every retained row, including the late writer, must reach both providers"
        );
    }
    let connected = observation_connection(&input, &secrets).await?;
    // Discover a real encoded event only after the retained sweep has started.
    // Its receipt must create an unchecked tail, while overlap replays must not.
    for provider in &providers {
        *provider.event.lock().unwrap() = Some(observation_event(&input));
    }
    for _ in 0..16 {
        let destination = store
            .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
            .await?;
        assert!(
            reconcile_retained_observations(&store, &destination, &connected, &tip)
                .await?
                .is_none()
        );
    }
    let destination = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert_eq!(
        reconcile_events(&store, &destination, &connected).await?,
        Reconciliation::Pending(ReconciliationStage::NewObservations)
    );
    let before:(i64,i64)=sqlx::query_as("SELECT count(*),max(id) FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind='observed_event'")
        .bind(ids.corp_id).bind(input.id).fetch_one(&pool).await?;
    assert_eq!(before.0, 1, "log scan retains exactly one observed event");
    let tail = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert_eq!(
        tail.evidence_ids,
        vec![before.1],
        "new log evidence remains pending, not implicitly acknowledged"
    );
    let fresh = PgStore::connect(pool.connect_options().to_url_lossy().as_str()).await?;
    let resumed = observation_connection(&input, &secrets).await?;
    let destination = fresh
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert_eq!(
        reconcile_events(&fresh, &destination, &resumed).await?,
        Reconciliation::Complete
    );
    let after:(i64,i64)=sqlx::query_as("SELECT count(*),max(id) FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind='observed_event'")
        .bind(ids.corp_id).bind(input.id).fetch_one(&pool).await?;
    assert_eq!(
        after, before,
        "overlap replay cannot produce an infinite new-tail loop"
    );
    fresh.pool().close().await;
    sqlx::query("INSERT INTO base_audit_evidence(corp_id,destination_id,kind,identity,evidence) VALUES($1,$2,'spend_finalized','paging-finalized',$3)")
        .bind(ids.corp_id).bind(input.id).bind(json!({"block":observation_header(1058)})).execute(&pool).await?;
    for _ in 0..16 {
        let destination = store
            .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
            .await?;
        assert!(
            reconcile_retained_observations(&store, &destination, &connected, &tip)
                .await?
                .is_none()
        );
    }
    for provider in &providers {
        provider
            .forks
            .lock()
            .unwrap()
            .insert(1058, B256::repeat_byte(93));
    }
    let destination = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert!(
        reconcile_retained_observations(&store, &destination, &connected, &tip)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
            .await?
            .status,
        "finalized_contradiction"
    );
    Ok(())
}

async fn source_fixture(store: &PgStore) -> Result<(crony_store::DemoIds, Uuid)> {
    let (ids, _) = store.bootstrap_demo().await?;
    let plan: TaskGraphPlan = serde_json::from_value(json!({
        "strategy":"single","max_nodes":1,"max_depth":0,"budget_tokens":1000,
        "budget_cost_microusd":100000,"staffing":[],
        "tasks":[{"key":"deliver","title":"worker acceptance","assigned_agent_id":ids.worker_agent_id,
        "required_adapter":"fake-process","depends_on":[],"depth":0,"max_attempts":1,
        "contract":{"objective":"Write result.md","expected_output":"result.md",
        "acceptance_tests":["exists"],"allowed_tools":["filesystem"],"prohibited_actions":["no deployment"],
        "references":[],"write_scope":["result.md"],"budget_tokens":1000,"budget_cost_microusd":100000,
        "deadline_at":null,"escalation":"ask owner","secret_refs":[],"source_repository":null,
        "source_base_ref":null,"source_base_commit":null,"model":null,"reasoning_effort":null,
        "deliverable":null,"workspace_connection_id":null},
        "verification_policy":{"checks":[{"type":"file","path":"result.md","min_bytes":1}],"manual_gate":null}}]
    }))?;
    let (mission, _) = store
        .create_mission(
            ids.corp_id,
            ids.alice_actor_id,
            "Worker fixture",
            "Initial",
            &plan,
        )
        .await?;
    let ledger = Uuid::new_v4();
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, ledger)
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    store
        .create_mission_contract_revision(CreateMissionContractRevisionInput {
            corp_id: ids.corp_id,
            actor_id: ids.alice_actor_id,
            mission_id: mission.mission_id,
            task_id: mission.task_ids[0],
            expected_contract_version: 1,
            next_action: MissionContractRevisionAction::Redispatch,
            source_run_id: None,
            reason: "local worker acceptance".into(),
            idempotency_key: Uuid::new_v4(),
            description: "Retained worker source".into(),
            contract: plan.tasks[0].contract.clone(),
            verification_policy: plan.tasks[0].verification_policy.clone(),
        })
        .await?;
    store
        .audit_checkpoint(
            ids.corp_id,
            "worker-checkpoint",
            &crony_audit::SigningKey::from_bytes(&[7; 32]),
        )
        .await?;
    Ok((ids, ledger))
}

async fn fixture_connection(
    input: &BaseDestinationInput,
    gateway_url: &str,
    secondary_url: &str,
    oracle_hash: B256,
) -> Result<Connected> {
    let trust = ManifestTrust::bootstrap(&input.trust_pin, &input.manifests[0])?;
    let secrets = FileSecrets(BTreeMap::from([
        (
            "fixture/primary".into(),
            SecretValue {
                url: NODE.into(),
                bearer: None,
            },
        ),
        (
            "fixture/secondary".into(),
            SecretValue {
                url: secondary_url.into(),
                bearer: None,
            },
        ),
        (
            "fixture/gateway".into(),
            SecretValue {
                url: gateway_url.into(),
                bearer: Some(TOKEN.into()),
            },
        ),
    ]));
    Ok(Connected {
        chain: BaseConnection::connect(
            input.config.clone(),
            trust,
            &secrets,
            EndpointPolicy::test_only_loopback("127.0.0.1:18556".parse()?)?,
            EndpointPolicy::test_only_loopback(
                secondary_url.trim_start_matches("http://").parse()?,
            )?,
        )
        .await?,
        gateway: HttpSigningGateway::connect(
            "fixture/gateway",
            "worker-gateway",
            &secrets,
            EndpointPolicy::test_only_loopback(gateway_url.trim_start_matches("http://").parse()?)?,
        )
        .await?,
        settings: ConnectionSettings {
            destination_id: input.id,
            expected_owner: input.manifests[0].manifest.registering_owner,
            gateway_secret: "fixture/gateway".into(),
            allowed_hosts: BTreeSet::new(),
            fee_oracle: FeeOracleQualification {
                qualification_id: "local-fixed-oracle".into(),
                runtime_code_hash: oracle_hash,
                implementation: None,
            },
        },
    })
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires owned PostgreSQL and separate owned Anvil at loopback18556"]
async fn base_worker_http_gateway_restart_and_finality(pool: PgPool) -> Result<()> {
    let journal_name = format!("worker_journal_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {journal_name}"))
        .execute(&pool)
        .await?;
    let journal_pool = PgPoolOptions::new()
        .max_connections(5)
        .connect_with(
            pool.connect_options()
                .as_ref()
                .clone()
                .database(&journal_name),
        )
        .await?;
    let outcome = std::panic::AssertUnwindSafe(run_acceptance(&pool, &journal_pool))
        .catch_unwind()
        .await;
    journal_pool.close().await;
    if matches!(&outcome, Ok(Ok(()))) {
        sqlx::query(&format!("DROP DATABASE {journal_name} WITH (FORCE)"))
            .execute(&pool)
            .await?;
    } else {
        eprintln!("retained failed fixture signing journal database={journal_name}");
    }
    match outcome {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn run_acceptance(pool: &PgPool, journal_pool: &PgPool) -> Result<()> {
    let started = std::time::Instant::now();
    let step = |stage: &str| {
        eprintln!(
            "worker fixture stage={stage} elapsed_ms={}",
            started.elapsed().as_millis()
        );
    };
    step("local_prerequisites");
    ensure!(
        node("eth_chainId", json!([])).await? == json!("0x14a34"),
        "wrong fixture chain"
    );
    let accounts: Vec<Address> = serde_json::from_value(node("eth_accounts", json!([])).await?)?;
    let owner = accounts[0];
    let signer = PrivateKeySigner::from_bytes(&B256::repeat_byte(17))?;
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
    let bytecode = compiled["contract"]["evm"]["bytecode"]["object"]
        .as_str()
        .context("registry bytecode missing")?;
    let deployed = node("eth_sendTransaction", json!([{"from":owner,"data":format!("0x{}",bytecode.trim_start_matches("0x")),"gas":"0x600000"}])).await?;
    let deployment = node_receipt(deployed).await?;
    ensure!(
        deployment["status"] == "0x1",
        "fixture registry deployment failed"
    );
    let registry: Address = serde_json::from_value(deployment["contractAddress"].clone())?;
    let local_key = B256::from_slice(Uuid::new_v4().as_bytes().repeat(2).as_slice());
    let stream = crony_base::abi::stream_id(owner, local_key);
    let registration = ECorpCheckpointRegistryV1::registerCall {
        localStreamKey: local_key,
        publisher,
    }
    .abi_encode();
    let registered = node(
        "eth_sendTransaction",
        json!([{"from":owner,"to":registry,"data":Bytes::from(registration),"gas":"0x600000"}]),
    )
    .await?;
    ensure!(
        node_receipt(registered).await?["status"] == "0x1",
        "owned fixture registration reverted"
    );
    node("anvil_mine", json!(["0x40"])).await?;
    let store = PgStore::connect(pool.connect_options().to_url_lossy().as_str()).await?;
    let (ids, ledger) = source_fixture(&store).await?;
    let checkpoint_key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    let authority = crony_audit::SigningKey::from_bytes(&[8; 32]);
    let code: Bytes =
        serde_json::from_value(node("eth_getCode", json!([registry, "latest"])).await?)?;
    let genesis = node("eth_getBlockByNumber", json!(["0x0", false])).await?;
    let manifest = DestinationManifestV1 {
        schema_version: 1,
        customer_trust_id: B256::repeat_byte(9),
        manifest_version: 1,
        previous_manifest_digest: None,
        ledger_id: ledger.to_string(),
        chain_id: 84532,
        network_identity: NetworkIdentity {
            genesis_hash: serde_json::from_value(genesis["hash"].clone())?,
            checkpoint: None,
        },
        contract_address: registry,
        contract_version: 1,
        runtime_code_hash: keccak256(code),
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
            key_id: "worker-checkpoint".into(),
            public_key: checkpoint_key.verifying_key().to_bytes(),
            first_sequence: 1,
            last_sequence: None,
        }],
        assurance_policy: Assurance::ProviderObservedFinalized,
        evidence_retention_policy: "ten-year".into(),
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
    let input = BaseDestinationInput {
        id: Uuid::new_v4(),
        config: BaseDestinationConfig {
            chain_id: 84532,
            manifest_digest: signed.digest,
            contract_address: registry,
            stream_id: stream,
            publisher,
            primary_rpc_secret: "fixture/primary".into(),
            secondary_rpc_secret: "fixture/secondary".into(),
            primary_operator: "fixture-one".into(),
            secondary_operator: "fixture-two".into(),
            signer_gateway_identity: "worker-gateway".into(),
            signer_key_identity: "worker-fixture-key".into(),
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
    store
        .configure_base_destination(ids.corp_id, ids.alice_actor_id, &input)
        .await?;
    sqlx::raw_sql(include_str!("../../crony-base/gateway-journal.sql"))
        .execute(journal_pool)
        .await?;
    let calls = Arc::new(AtomicUsize::new(0));
    let gateway = PolicyGateway::new(
        PostgresSigningJournal::new(journal_pool.clone()),
        store.clone(),
        LocalSigner {
            signer,
            calls: Arc::clone(&calls),
        },
        ManifestTrust::bootstrap(&input.trust_pin, &input.manifests[0])?,
        policy,
    )?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let app = router(
        Arc::new(LostReplyGateway {
            inner: Arc::new(gateway),
            replies: AtomicUsize::new(0),
        }),
        GatewayAccess::new(TOKEN.as_bytes(), BTreeSet::from([ids.corp_id]))?,
    )
    .layer(axum::middleware::from_fn(
        |request: axum::extract::Request, next: axum::middleware::Next| async move {
            let response = next.run(request).await;
            if !response.status().is_success() {
                eprintln!(
                    "worker fixture gateway HTTP status={}",
                    response.status().as_u16()
                );
            }
            response
        },
    ));
    let _server = AbortTask(tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("fixture gateway server");
    }));
    let gateway_url = format!("http://{address}");
    let secondary_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let secondary_url = format!("http://{}", secondary_listener.local_addr()?);
    let proxy = axum::Router::new().route(
        "/",
        axum::routing::post(|axum::extract::State(client): axum::extract::State<reqwest::Client>, axum::Json(request): axum::Json<Value>| async move {
            // Only fixed method labels and transport metadata may enter fixture diagnostics.
            let method = match request["method"].as_str() {
                Some("eth_getBlockByHash") => "eth_getBlockByHash",
                Some("eth_getBlockByNumber") => "eth_getBlockByNumber",
                Some("eth_getTransactionReceipt") => "eth_getTransactionReceipt",
                Some("eth_getLogs") => "eth_getLogs",
                Some("eth_call") => "eth_call",
                Some("eth_getCode") => "eth_getCode",
                Some("eth_chainId") => "eth_chainId",
                Some("eth_getTransactionCount") => "eth_getTransactionCount",
                Some("eth_getBalance") => "eth_getBalance",
                Some("eth_feeHistory") => "eth_feeHistory",
                Some("eth_estimateGas") => "eth_estimateGas",
                _ => "other",
            };
            let started = std::time::Instant::now();
            let response = client
                .post(NODE)
                .json(&request)
                .send()
                .await
                .map_err(|error| {
                    eprintln!(
                        "worker fixture secondary method={method} send_failed=true timeout={} connect={} elapsed_ms={}",
                        error.is_timeout(),
                        error.is_connect(),
                        started.elapsed().as_millis()
                    );
                    axum::http::StatusCode::BAD_GATEWAY
                })?;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                eprintln!("worker fixture secondary method={method} upstream_status={status}");
            }
            let response = response
                .json::<Value>()
                .await
                .map_err(|error| {
                    eprintln!(
                        "worker fixture secondary method={method} decode_failed=true timeout={} upstream_status={status} elapsed_ms={}",
                        error.is_timeout(),
                        started.elapsed().as_millis()
                    );
                    axum::http::StatusCode::BAD_GATEWAY
                })?;
            Ok::<_, axum::http::StatusCode>(axum::Json(response))
        }),
    )
    .with_state(
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(15))
            .build()?,
    );
    let _secondary = AbortTask(tokio::spawn(async move {
        axum::serve(secondary_listener, proxy)
            .await
            .expect("fixture secondary RPC proxy");
    }));
    let oracle_hash = keccak256(hex::decode(ORACLE_CODE.trim_start_matches("0x"))?);
    step("initial_validation");
    let connection = fixture_connection(&input, &gateway_url, &secondary_url, oracle_hash).await?;
    let disabled = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert!(!disabled.enabled);
    assert!(
        validate_connection(&store, &disabled, &connection)
            .await
            .context("fixture initial validation")?
            .is_some()
    );
    store
        .control_base_destination(ids.corp_id, ids.alice_actor_id, input.id, 1, true)
        .await?;
    let intent = store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, Uuid::new_v4())
        .await?;
    assert_eq!(intent.state, "archive_pending");
    let github = crony_store::state_audit::AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "github".into(),
        interval_seconds: 60,
        calendar_schedule: None,
        overdue_after_seconds: 3600,
        workflow_gate: "published".into(),
        config: json!({"repository":"fixture/worker-audit","branch":"main","path":"audit"}),
    };
    store
        .configure_audit_destination(ids.alice_actor_id, &github)
        .await?;
    assert!(
        store
            .publish_audit_destination(
                github.id,
                &ArchiveTransport::default(),
                &checkpoint_key.verifying_key()
            )
            .await?
    );
    let claim = store
        .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
        .await?
        .context("first claim")?;
    let d = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    step("injected_lost_sign_reply");
    let first_error = drive_intent(&store, &d, &connection, &claim)
        .await
        .expect_err("injected lost sign reply");
    let frozen = store.base_attempts(&claim).await?;
    assert_eq!(frozen.len(), 1, "first worker error: {first_error:#}");
    assert!(frozen[0].signed.is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let journaled = connection
        .gateway
        .lookup(&frozen[0].request)
        .await?
        .context("committed gateway result")?;
    assert!(
        connection
            .chain
            .primary
            .receipt(journaled.hash())
            .await?
            .is_none()
    );
    store
        .release_base_claim(&claim, "signer_unavailable")
        .await?;
    drop(connection);
    step("reconnect_after_journal_commit");
    let restarted = fixture_connection(&input, &gateway_url, &secondary_url, oracle_hash).await?;
    assert!(
        validate_connection(&store, &d, &restarted)
            .await
            .context("fixture validation after journal commit")?
            .is_some()
    );
    let recovered = store
        .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
        .await?
        .context("restarted claim")?;
    let snapshot_before_broadcast = node("evm_snapshot", json!([])).await?;
    step("recover_and_broadcast");
    drive_intent(&store, &d, &restarted, &recovered)
        .await
        .context("fixture recover signature and broadcast")?;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "restart must lookup, not sign again"
    );
    let raw: Vec<u8> =
        sqlx::query_scalar("SELECT raw_tx FROM base_audit_signed_results WHERE attempt_id=$1")
            .bind(frozen[0].request.attempt_id)
            .fetch_one(pool)
            .await?;
    assert!(raw == journaled.raw(), "broadcast exactly journaled bytes");
    let tentative = store
        .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
        .await?
        .context("tentative inclusion claim")?;
    step("tentative_inclusion");
    assert!(
        drive_intent(&store, &d, &restarted, &tentative)
            .await
            .is_err(),
        "recent receipt is not finalized"
    );
    store.release_base_claim(&tentative, "included").await?;
    let d = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert!(
        validate_connection(&store, &d, &restarted)
            .await
            .context("current-inclusion validation")?
            .is_none(),
        "validation must defer when its log scan discovers unchecked retained evidence"
    );
    let pending = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert!(pending.enabled && pending.restore_required);
    assert!(
        store
            .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
            .await?
            .is_none(),
        "pending canonical reconciliation must not admit any worker effect"
    );
    assert!(
        store
            .control_base_destination(
                ids.corp_id,
                ids.alice_actor_id,
                input.id,
                pending.version,
                true
            )
            .await
            .is_err(),
        "pending validation must not leave a usable enable ticket"
    );
    drop(restarted);
    step("resume_scanner_tail");
    let restarted = fixture_connection(&input, &gateway_url, &secondary_url, oracle_hash).await?;
    let d = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert!(
        validate_connection(&store, &d, &restarted)
            .await
            .context("resumed current-inclusion validation")?
            .is_some(),
        "the next bounded validation tick must verify the scanner-created tail"
    );
    step("revert_tentative_inclusion");
    ensure!(
        node("evm_revert", json!([snapshot_before_broadcast])).await? == json!(true),
        "owned fixture revert failed"
    );
    let latest = node("eth_getBlockByNumber", json!(["latest", false])).await?;
    let timestamp = u64::from_str_radix(
        latest["timestamp"]
            .as_str()
            .context("fixture timestamp")?
            .trim_start_matches("0x"),
        16,
    )?;
    node("evm_setNextBlockTimestamp", json!([timestamp + 30])).await?;
    node("evm_mine", json!([])).await?;
    assert!(
        reconcile_events(&store, &d, &restarted).await.is_err(),
        "tentative receipt reorg must be detected"
    );
    let reorged = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert!(reorged.enabled && reorged.restore_required);
    assert!(
        validate_connection(&store, &reorged, &restarted)
            .await
            .context("fixture validation after tentative reorg")?
            .is_some()
    );
    let retry = store
        .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
        .await?
        .context("reorg retry claim")?;
    step("rebroadcast_after_reorg");
    drive_intent(&store, &reorged, &restarted, &retry)
        .await
        .context("fixture rebroadcast after tentative reorg")?;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "reorg retry must preserve identical signed bytes"
    );
    step("mine_long_ancestry");
    for _ in 0..33 {
        node("anvil_mine", json!(["0x100"])).await?;
    }
    step("historical_reconciliation");
    let d = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert_eq!(
        reconcile_events(&store, &d, &restarted)
            .await
            .context("historical event reconciliation")?,
        Reconciliation::Pending(ReconciliationStage::NewObservations)
    );
    let d = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert_eq!(
        reconcile_events(&store, &d, &restarted)
            .await
            .context("resumed historical event reconciliation")?,
        Reconciliation::Complete,
        "the next bounded tick must verify the scanner-created tail before proceeding"
    );
    let mut terminal = false;
    step("bounded_finality");
    for tick in 0..32 {
        let final_claim = store
            .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
            .await?
            .context("finality continuation claim")?;
        drive_intent(&store, &d, &restarted, &final_claim)
            .await
            .with_context(|| format!("fixture finality continuation tick {tick}"))?;
        terminal = sqlx::query_scalar("SELECT terminal FROM base_audit_intents WHERE id=$1")
            .bind(intent.id)
            .fetch_one(pool)
            .await?;
        if terminal {
            break;
        }
        eprintln!("worker fixture finality_tick={tick} terminal=false");
    }
    assert!(
        terminal,
        "bounded resumable finality must complete beyond8192headers"
    );
    let retained:i64=sqlx::query_scalar("SELECT sum(jsonb_array_length(segment->'headers'))::bigint FROM base_audit_ancestry_segments WHERE destination_id=$1")
        .bind(input.id).fetch_one(pool).await?;
    assert!(
        retained > 16384,
        "both providers must retain full long-history ancestry"
    );
    step("retained_finality_history");
    let history = store
        .base_history(ids.corp_id, ids.alice_actor_id, input.id, None, 100)
        .await?;
    ensure!(
        history.to_string().contains("spend_finalized"),
        "own transaction finality not retained"
    );
    let snapshot = restarted.gateway.journal_snapshot(84532, publisher).await?;
    assert_eq!(snapshot.requests, vec![frozen[0].request.clone()]);
    assert!(snapshot.complete);
    println!(
        "worker HTTP acceptance: intent={}, tx={}, journal_cursor={}, sign_calls=1, terminal=true, tentative_reorg_recovered=true, tail_deferred_then_resumed=true, retained_headers={}",
        intent.id,
        journaled.hash(),
        snapshot.cursor,
        retained
    );
    Ok(())
}
