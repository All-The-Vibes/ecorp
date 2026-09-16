use crate::{
    Address, B256, Bytes, Error, Result, U256,
    abi::{AnchorCall, ECorpCheckpointRegistryV1, GasPriceOracle},
    ancestry::{
        AncestryBinding, AncestrySegment, AncestryState, AncestryStore, MAX_SEGMENT_HEADERS,
        RetainedAncestry, ancestry_key, sealed_header,
    },
    config::{Assurance, BaseDestinationConfig, identifier},
    fees::{FeeQuote, SettledFee},
    manifest::ManifestTrust,
    signing::{FrozenTransaction, SignRequest, SignedTransaction, SigningGateway},
};
use alloy::{
    consensus::{SignableTransaction, TxEnvelope},
    eips::eip2718::Encodable2718,
    primitives::{PrimitiveSignature, U64, keccak256},
    rpc::types::{Log, TransactionReceipt},
    sol_types::{SolCall, SolEvent},
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    net::{IpAddr, SocketAddr},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

pub const MAX_LOG_RANGE: u64 = 1000;
pub const MAX_ANCESTRY_HEADERS: usize = 8192;
pub const OFFLINE_ASSURANCE: &str =
    "checkpoint verified; chain inclusion/finality not independently established offline";
const ORACLE: Address = alloy::primitives::address!("420000000000000000000000000000000000000F");
const IMPLEMENTATION_SLOT: B256 =
    alloy::primitives::b256!("360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");

#[derive(Debug, Clone)]
pub struct EndpointPolicy {
    pub allowed_hosts: BTreeSet<String>,
    pub timeout: Duration,
    pub max_response_bytes: usize,
    pub read_attempts: u8,
    #[cfg(all(feature = "test-support", debug_assertions))]
    test_loopback: Option<SocketAddr>,
}
impl EndpointPolicy {
    pub fn production(allowed_hosts: BTreeSet<String>) -> Self {
        Self {
            allowed_hosts,
            timeout: Duration::from_secs(15),
            max_response_bytes: 4 * 1024 * 1024,
            read_attempts: 3,
            #[cfg(all(feature = "test-support", debug_assertions))]
            test_loopback: None,
        }
    }
    /// Debug/test builds only. Never qualifies provider independence or production connectivity.
    #[cfg(all(feature = "test-support", debug_assertions))]
    pub fn test_only_loopback(address: SocketAddr) -> Result<Self> {
        if !address.ip().is_loopback() || address.port() == 0 {
            return Err(Error::Config(
                "test endpoint must be explicit nonzero loopback",
            ));
        }
        let mut policy = Self::production([address.ip().to_string()].into());
        policy.test_loopback = Some(address);
        policy.read_attempts = 1;
        Ok(policy)
    }
    async fn resolve(&self, url: &url::Url) -> Result<Vec<SocketAddr>> {
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(Error::Config("endpoint not authorized by outbound policy"));
        }
        #[cfg(all(feature = "test-support", debug_assertions))]
        if let Some(expected) = self.test_loopback {
            let ip = match url.host() {
                Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
                Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
                _ => return Err(Error::Config("test endpoint must use literal loopback")),
            };
            if url.scheme() != "http" || ip != expected.ip() || url.port() != Some(expected.port())
            {
                return Err(Error::Config(
                    "test endpoint does not match exact loopback pin",
                ));
            }
            return Ok(vec![expected]);
        }
        let host = url
            .host_str()
            .ok_or(Error::Config("endpoint has no host"))?;
        if url.scheme() != "https"
            || url.port_or_known_default() != Some(443)
            || !self.allowed_hosts.contains(host)
        {
            return Err(Error::Config("endpoint not authorized by outbound policy"));
        }
        let addresses: Vec<SocketAddr> =
            tokio::time::timeout(self.timeout, tokio::net::lookup_host((host, 443)))
                .await
                .map_err(|_| Error::Rpc("DNS timeout"))?
                .map_err(|_| Error::Rpc("DNS failed"))?
                .collect();
        if addresses.is_empty()
            || addresses.len() > 32
            || addresses.iter().any(|a| !public_rpc_ip(a.ip()))
        {
            return Err(Error::Config(
                "endpoint resolves to nonpublic or excessive addresses",
            ));
        }
        Ok(addresses)
    }
    fn validate(&self) -> Result<()> {
        if self.allowed_hosts.is_empty()
            || self.allowed_hosts.len() > 32
            || self.timeout.is_zero()
            || self.timeout > Duration::from_secs(30)
            || self.max_response_bytes == 0
            || self.max_response_bytes > 32 * 1024 * 1024
            || !(1..=4).contains(&self.read_attempts)
        {
            return Err(Error::Config("invalid outbound bounds"));
        }
        Ok(())
    }
}

/// Resolved credentials never implement Debug/Serialize.
pub struct EndpointSecret {
    pub url: String,
    pub bearer: Option<String>,
}
#[async_trait]
pub trait EndpointSecrets: Send + Sync {
    async fn resolve(&self, reference: &str) -> Result<EndpointSecret>;
}

pub fn public_rpc_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0)
                || (a == 192 && b == 88 && c == 99)
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

pub struct HttpRpc {
    client: reqwest::Client,
    url: url::Url,
    bearer: Option<reqwest::header::HeaderValue>,
    provider_identity: String,
    policy: EndpointPolicy,
    next_id: AtomicU64,
}
impl std::fmt::Debug for HttpRpc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpRpc")
            .field("provider_identity", &self.provider_identity)
            .finish_non_exhaustive()
    }
}
impl HttpRpc {
    #[cfg(all(feature = "test-support", debug_assertions))]
    pub async fn connect_test_loopback(
        reference: &str,
        provider_identity: &str,
        secrets: &dyn EndpointSecrets,
    ) -> Result<Self> {
        let secret = secrets.resolve(reference).await?;
        let url =
            url::Url::parse(&secret.url).map_err(|_| Error::Config("invalid test endpoint URL"))?;
        let ip = match url.host() {
            Some(url::Host::Ipv4(ip)) if ip == std::net::Ipv4Addr::LOCALHOST => IpAddr::V4(ip),
            Some(url::Host::Ipv6(ip)) if ip == std::net::Ipv6Addr::LOCALHOST => IpAddr::V6(ip),
            _ => {
                return Err(Error::Config(
                    "test endpoint requires literal 127.0.0.1 or ::1",
                ));
            }
        };
        let port = url
            .port()
            .ok_or(Error::Config("test endpoint requires explicit port"))?;
        Self::connect(
            reference,
            provider_identity,
            secrets,
            EndpointPolicy::test_only_loopback(SocketAddr::new(ip, port))?,
        )
        .await
    }

    pub async fn connect(
        reference: &str,
        provider_identity: &str,
        secrets: &dyn EndpointSecrets,
        policy: EndpointPolicy,
    ) -> Result<Self> {
        policy.validate()?;
        if !identifier(reference) || !identifier(provider_identity) {
            return Err(Error::Config("invalid endpoint identity"));
        }
        let secret = secrets.resolve(reference).await?;
        if secret.url.len() > 4096 {
            return Err(Error::Config("endpoint exceeds bounds"));
        }
        let url =
            url::Url::parse(&secret.url).map_err(|_| Error::Config("invalid endpoint URL"))?;
        let host = url
            .host_str()
            .ok_or(Error::Config("endpoint has no host"))?;
        let addresses = policy.resolve(&url).await?;
        let client = reqwest::Client::builder()
            .timeout(policy.timeout)
            .connect_timeout(policy.timeout)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .https_only(url.scheme() == "https")
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| Error::Config("HTTP client initialization failed"))?;
        let bearer = secret
            .bearer
            .map(|b| {
                if b.is_empty() || b.len() > 8192 {
                    return Err(Error::Config("invalid endpoint credential"));
                }
                let mut h = reqwest::header::HeaderValue::from_str(&format!("Bearer {b}"))
                    .map_err(|_| Error::Config("invalid endpoint credential"))?;
                h.set_sensitive(true);
                Ok(h)
            })
            .transpose()?;
        Ok(Self {
            client,
            url,
            bearer,
            provider_identity: provider_identity.into(),
            policy,
            next_id: AtomicU64::new(1),
        })
    }
    pub fn provider_identity(&self) -> &str {
        &self.provider_identity
    }
    async fn json_once(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .map_err(|_| Error::Rpc("request encoding failed"))?;
        if body.len() > 128 * 1024 {
            return Err(Error::Rpc("request exceeds bounds"));
        }
        let mut request = self
            .client
            .post(self.url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
        if let Some(auth) = &self.bearer {
            request = request.header(reqwest::header::AUTHORIZATION, auth.clone());
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| Error::Rpc("transport failed"))?;
        if !response.status().is_success() {
            return Err(Error::Rpc("HTTP request rejected"));
        }
        if response
            .content_length()
            .is_some_and(|n| n > self.policy.max_response_bytes as u64)
        {
            return Err(Error::Rpc("response exceeds bounds"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| Error::Rpc("response read failed"))?
        {
            if bytes.len().saturating_add(chunk.len()) > self.policy.max_response_bytes {
                return Err(Error::Rpc("response exceeds bounds"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let response: Value = crate::rpc_json::parse(&bytes)
            .map_err(|_| Error::Rpc("invalid or duplicate JSON fields"))?;
        if response.get("jsonrpc") != Some(&json!("2.0"))
            || response.get("id") != Some(&json!(id))
            || response.get("error").is_some()
            || !response
                .as_object()
                .is_some_and(|o| o.len() == 3 && o.contains_key("result"))
        {
            return Err(Error::Rpc("JSON-RPC envelope rejected"));
        }
        Ok(response["result"].clone())
    }
    async fn request<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        let attempts = if method == "eth_sendRawTransaction" {
            1
        } else {
            self.policy.read_attempts
        };
        let mut last = Error::Rpc("request not attempted");
        for attempt in 0..attempts {
            match self.json_once(method, params.clone()).await {
                Ok(value) => {
                    return serde_json::from_value(value)
                        .map_err(|_| Error::Rpc("invalid typed result"));
                }
                Err(e) => last = e,
            }
            if attempt + 1 < attempts {
                let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]) % 100;
                tokio::time::sleep(Duration::from_millis(100 * (1u64 << attempt) + jitter)).await;
            }
        }
        Err(last)
    }
    async fn call(
        &self,
        contract: Address,
        input: Bytes,
        from: Option<Address>,
        block: Value,
    ) -> Result<Bytes> {
        let mut call = json!({"to":contract,"data":input,"value":"0x0"});
        if let Some(from) = from {
            call["from"] = json!(from);
        }
        self.request("eth_call", json!([call, block])).await
    }
    pub async fn chain_id(&self) -> Result<u64> {
        Ok(self.request::<U64>("eth_chainId", json!([])).await?.to())
    }
    /// Retains every consensus field and recomputes the hash instead of trusting RPC header labels.
    pub async fn consensus_header(&self, hash: B256) -> Result<crate::ancestry::ConsensusHeader> {
        let value: Value = self
            .request("eth_getBlockByHash", json!([hash, false]))
            .await?;
        let claimed: B256 = serde_json::from_value(
            value
                .get("hash")
                .cloned()
                .ok_or(Error::Evidence("header hash missing"))?,
        )
        .map_err(|_| Error::Evidence("invalid header hash"))?;
        let header: crate::ancestry::ConsensusHeader = serde_json::from_value(value)
            .map_err(|_| Error::Evidence("complete consensus header unavailable"))?;
        if hash != claimed
            || header.hash_slow() != hash
            || header.extra_data.len() > 32
            || header.gas_used > header.gas_limit
        {
            return Err(Error::Evidence(
                "consensus header does not hash to requested block",
            ));
        }
        Ok(header)
    }
    pub async fn block(&self, tag: BlockTag) -> Result<SealedHeader> {
        let value = match tag {
            BlockTag::Pending => {
                return Err(Error::Evidence("pending block is not sealed evidence"));
            }
            BlockTag::Number(n) => json!(format!("0x{n:x}")),
            BlockTag::Latest => json!("latest"),
            BlockTag::Finalized => json!("finalized"),
            BlockTag::Safe => json!("safe"),
        };
        let raw: RawHeader = self
            .request("eth_getBlockByNumber", json!([value, false]))
            .await?;
        let header = raw.sealed()?;
        if let BlockTag::Number(n) = tag
            && header.number != n
        {
            return Err(Error::Evidence("block number mismatch"));
        }
        Ok(header)
    }
    pub async fn block_hash(&self, hash: B256) -> Result<SealedHeader> {
        let raw: RawHeader = self
            .request("eth_getBlockByHash", json!([hash, false]))
            .await?;
        let header = raw.sealed()?;
        if header.hash != hash {
            return Err(Error::Evidence("block hash mismatch"));
        }
        Ok(header)
    }
    pub async fn code(&self, address: Address, block: B256) -> Result<Bytes> {
        self.request(
            "eth_getCode",
            json!([address,{"blockHash":block,"requireCanonical":true}]),
        )
        .await
    }
    pub async fn balance(&self, address: Address, block: B256) -> Result<U256> {
        self.request(
            "eth_getBalance",
            json!([address,{"blockHash":block,"requireCanonical":true}]),
        )
        .await
    }
    pub async fn nonce(&self, address: Address, tag: BlockTag) -> Result<u64> {
        let tag = match tag {
            BlockTag::Pending => "pending".into(),
            BlockTag::Latest => "latest".into(),
            BlockTag::Finalized => "finalized".into(),
            BlockTag::Safe => "safe".into(),
            BlockTag::Number(n) => format!("0x{n:x}"),
        };
        Ok(self
            .request::<U64>("eth_getTransactionCount", json!([address, tag]))
            .await?
            .to())
    }
    pub async fn head(&self, contract: Address, stream: B256, block: B256) -> Result<RegistryHead> {
        let bytes = self
            .call(
                contract,
                ECorpCheckpointRegistryV1::headCall { streamId: stream }
                    .abi_encode()
                    .into(),
                None,
                json!({"blockHash":block,"requireCanonical":true}),
            )
            .await?;
        let head = ECorpCheckpointRegistryV1::headCall::abi_decode_returns(&bytes, true)
            .map_err(|_| Error::Evidence("invalid registry head ABI"))?
            ._0;
        let result = RegistryHead {
            registered: head.registered,
            owner: head.owner,
            pending_owner: head.pendingOwner,
            publisher: head.publisher,
            paused: head.paused,
            sequence: head.lastSequence,
            digest: head.lastDigest,
            previous_digest: head.previousAnchorDigest,
            anchor_ordinal: head.anchorOrdinal,
        };
        if result.sequence > i64::MAX as u64
            || result.anchor_ordinal > i64::MAX as u64
            || (result.sequence == 0) != result.digest.is_zero()
            || (result.sequence == 0) != (result.anchor_ordinal == 0)
        {
            return Err(Error::Evidence("invalid registry head invariants"));
        }
        Ok(result)
    }
    pub async fn receipt(&self, hash: B256) -> Result<Option<ReceiptEvidence>> {
        let value: Value = self
            .request("eth_getTransactionReceipt", json!([hash]))
            .await?;
        if value.is_null() {
            return Ok(None);
        }
        let receipt = ReceiptEvidence::parse(value)?;
        if receipt.receipt.transaction_hash != hash {
            return Err(Error::Evidence("receipt hash mismatch"));
        }
        Ok(Some(receipt))
    }
    pub async fn logs(
        &self,
        contract: Address,
        stream: B256,
        from: u64,
        to: u64,
    ) -> Result<Vec<Log>> {
        if to < from || to - from >= MAX_LOG_RANGE {
            return Err(Error::Rpc("log range exceeds 1000 blocks"));
        }
        let logs: Vec<Log> = self.request("eth_getLogs", json!([{"address":contract,"fromBlock":format!("0x{from:x}"),"toBlock":format!("0x{to:x}"),
            "topics":[ECorpCheckpointRegistryV1::Anchored::SIGNATURE_HASH,stream]}])).await?;
        if logs.len() > 4096 {
            return Err(Error::Rpc("log count exceeds bounds"));
        }
        for log in &logs {
            if log.address() != contract
                || log.removed
                || log.block_number.is_none_or(|b| b < from || b > to)
                || log.topics().first()
                    != Some(&ECorpCheckpointRegistryV1::Anchored::SIGNATURE_HASH)
                || log.topics().get(1) != Some(&stream)
                || log.block_hash.is_none()
                || log.transaction_hash.is_none()
                || log.log_index.is_none()
            {
                return Err(Error::Evidence("log escaped pinned filter or is unsealed"));
            }
        }
        Ok(logs)
    }
    /// One bounded adaptive page. Persist its end hash and rescan overlap on recovery.
    pub async fn log_page(
        &self,
        contract: Address,
        stream: B256,
        from: u64,
        latest: u64,
    ) -> Result<LogPage> {
        if from > latest {
            return Err(Error::Rpc("scan cursor exceeds canonical head"));
        }
        let mut to = latest.min(from.saturating_add(MAX_LOG_RANGE - 1));
        loop {
            match self.logs(contract, stream, from, to).await {
                Ok(logs) => {
                    let end = self.block(BlockTag::Number(to)).await?;
                    return Ok(LogPage {
                        from_block: from,
                        end,
                        logs,
                    });
                }
                Err(Error::Rpc(_)) if to > from => to = from + (to - from) / 2,
                Err(e) => return Err(e),
            }
        }
    }
    pub async fn broadcast(&self, signed: &SignedTransaction) -> Result<B256> {
        let returned: B256 = self
            .request(
                "eth_sendRawTransaction",
                json!([Bytes::copy_from_slice(signed.raw())]),
            )
            .await?;
        if returned != signed.hash() {
            return Err(Error::Evidence("broadcast returned unexpected hash"));
        }
        Ok(returned)
    }
    pub async fn simulate(&self, transaction: &FrozenTransaction, block: B256) -> Result<()> {
        let result = self
            .call(
                transaction.contract,
                transaction.call.calldata()?,
                Some(transaction.sender),
                json!({"blockHash":block,"requireCanonical":true}),
            )
            .await?;
        if !result.is_empty() {
            return Err(Error::Evidence("unexpected anchor simulation result"));
        }
        Ok(())
    }
    pub async fn quote(
        &self,
        transaction: &FrozenTransaction,
        block: B256,
        qualification: &FeeOracleQualification,
    ) -> Result<FeeQuote> {
        qualification.verify(self, block).await?;
        let mut unsigned = transaction.unsigned()?;
        let gas: U64 = self.request("eth_estimateGas", json!([{"from":transaction.sender,"to":transaction.contract,"value":"0x0","data":transaction.call.calldata()?},
            {"blockHash":block,"requireCanonical":true}])).await?;
        let gas_limit = gas
            .to::<u64>()
            .checked_mul(120)
            .and_then(|n| n.checked_add(99))
            .map(|n| n / 100)
            .ok_or(Error::Admission("gas overflow"))?;
        unsigned.gas_limit = gas_limit;
        let signature = PrimitiveSignature::new(U256::MAX, U256::MAX, true);
        let serialized = TxEnvelope::Eip1559(unsigned.into_signed(signature)).encoded_2718();
        let bytes = self
            .call(
                ORACLE,
                GasPriceOracle::getL1FeeCall {
                    data: serialized.into(),
                }
                .abi_encode()
                .into(),
                None,
                json!({"blockHash":block,"requireCanonical":true}),
            )
            .await?;
        let l1_data_fee = GasPriceOracle::getL1FeeCall::abi_decode_returns(&bytes, true)
            .map_err(|_| Error::Evidence("invalid oracle ABI"))?
            ._0;
        Ok(FeeQuote {
            gas_limit,
            max_fee_per_gas: transaction.max_fee_per_gas,
            max_priority_fee_per_gas: transaction.max_priority_fee_per_gas,
            l1_data_fee,
            observed_at: Utc::now(),
            fee_model_qualified: true,
        })
    }
    pub async fn fee_suggestion(&self) -> Result<(u128, u128)> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct History {
            base_fee_per_gas: Vec<U256>,
            reward: Vec<Vec<U256>>,
        }
        let history: History = self
            .request("eth_feeHistory", json!(["0x4", "latest", [50]]))
            .await?;
        if history.base_fee_per_gas.len() != 5
            || history.reward.len() != 4
            || history.reward.iter().any(|r| r.len() != 1)
        {
            return Err(Error::Evidence("fee history incomplete"));
        }
        let base = history.base_fee_per_gas[4];
        let priority = history
            .reward
            .iter()
            .map(|r| r[0])
            .max()
            .ok_or(Error::Evidence("fee reward missing"))?;
        let max = base
            .checked_mul(U256::from(2))
            .and_then(|b| b.checked_add(priority))
            .ok_or(Error::Admission("fee overflow"))?;
        Ok((
            max.try_into()
                .map_err(|_| Error::Admission("fee exceeds u128"))?,
            priority
                .try_into()
                .map_err(|_| Error::Admission("priority exceeds u128"))?,
        ))
    }
}

#[derive(Debug, Clone, Copy)]
pub enum BlockTag {
    Number(u64),
    Pending,
    Latest,
    Safe,
    Finalized,
}

#[async_trait]
pub trait AnchorRpc: Send + Sync {
    async fn chain_id(&self) -> Result<u64>;
    async fn block(&self, tag: BlockTag) -> Result<SealedHeader>;
    async fn head(&self, contract: Address, stream: B256, block: B256) -> Result<RegistryHead>;
    async fn receipt(&self, hash: B256) -> Result<Option<ReceiptEvidence>>;
    async fn logs(&self, contract: Address, stream: B256, from: u64, to: u64) -> Result<Vec<Log>>;
    async fn broadcast(&self, signed: &SignedTransaction) -> Result<B256>;
}
#[async_trait]
impl AnchorRpc for HttpRpc {
    async fn chain_id(&self) -> Result<u64> {
        HttpRpc::chain_id(self).await
    }
    async fn block(&self, tag: BlockTag) -> Result<SealedHeader> {
        HttpRpc::block(self, tag).await
    }
    async fn head(&self, contract: Address, stream: B256, block: B256) -> Result<RegistryHead> {
        HttpRpc::head(self, contract, stream, block).await
    }
    async fn receipt(&self, hash: B256) -> Result<Option<ReceiptEvidence>> {
        HttpRpc::receipt(self, hash).await
    }
    async fn logs(&self, contract: Address, stream: B256, from: u64, to: u64) -> Result<Vec<Log>> {
        HttpRpc::logs(self, contract, stream, from, to).await
    }
    async fn broadcast(&self, signed: &SignedTransaction) -> Result<B256> {
        HttpRpc::broadcast(self, signed).await
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawHeader {
    number: U64,
    hash: B256,
    parent_hash: B256,
    timestamp: U64,
}
impl RawHeader {
    fn sealed(self) -> Result<SealedHeader> {
        if self.hash.is_zero() || (self.number != U64::ZERO && self.parent_hash.is_zero()) {
            return Err(Error::Evidence("unsealed block"));
        }
        Ok(SealedHeader {
            number: self.number.to(),
            hash: self.hash,
            parent_hash: self.parent_hash,
            timestamp: self.timestamp.to(),
        })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SealedHeader {
    pub number: u64,
    pub hash: B256,
    pub parent_hash: B256,
    pub timestamp: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegistryHead {
    pub registered: bool,
    pub owner: Address,
    pub pending_owner: Address,
    pub publisher: Address,
    pub paused: bool,
    pub sequence: u64,
    pub digest: B256,
    pub previous_digest: B256,
    pub anchor_ordinal: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptEvidence {
    pub receipt: TransactionReceipt,
    pub l1_fee: Option<U256>,
    pub raw: Value,
}
impl ReceiptEvidence {
    pub fn parse(raw: Value) -> Result<Self> {
        if raw.get("status") != Some(&json!("0x0")) && raw.get("status") != Some(&json!("0x1")) {
            return Err(Error::Evidence("receipt status missing"));
        }
        let receipt: TransactionReceipt =
            serde_json::from_value(raw.clone()).map_err(|_| Error::Evidence("invalid receipt"))?;
        if receipt.block_hash.is_none_or(|h| h.is_zero())
            || receipt.block_number.is_none()
            || receipt.transaction_index.is_none()
            || receipt.inner.logs().len() > 4096
        {
            return Err(Error::Evidence("receipt not sealed"));
        }
        let l1_fee = raw
            .get("l1Fee")
            .map(|v| {
                serde_json::from_value(v.clone())
                    .map_err(|_| Error::Evidence("invalid L1 receipt fee"))
            })
            .transpose()?;
        Ok(Self {
            receipt,
            l1_fee,
            raw,
        })
    }
    pub fn cost(&self) -> Result<SettledFee> {
        let gas = self
            .receipt
            .gas_used
            .try_into()
            .map_err(|_| Error::Evidence("receipt gas exceeds u64"))?;
        SettledFee::from_receipt(gas, self.receipt.effective_gas_price, self.l1_fee)
    }
    pub fn exact_event(
        &self,
        contract: Address,
        call: &AnchorCall,
        expected_publisher: Address,
    ) -> Result<AnchorEvent> {
        if !self.receipt.status() || self.receipt.to != Some(contract) {
            return Err(Error::Evidence("anchor receipt failed or wrong target"));
        }
        let mut matched = None;
        for log in self.receipt.inner.logs() {
            if log.address() != contract
                || log.topics().first()
                    != Some(&ECorpCheckpointRegistryV1::Anchored::SIGNATURE_HASH)
            {
                continue;
            }
            let event = AnchorEvent::decode(log)?;
            if event.call == *call && event.publisher == expected_publisher {
                if matched.is_some() {
                    return Err(Error::Evidence("duplicate matching anchor event"));
                }
                if log.block_hash != self.receipt.block_hash
                    || log.block_number != self.receipt.block_number
                    || log.transaction_hash != Some(self.receipt.transaction_hash)
                    || log.transaction_index != self.receipt.transaction_index
                {
                    return Err(Error::Evidence("event and receipt identity mismatch"));
                }
                matched = Some(event);
            }
        }
        matched.ok_or(Error::Evidence(
            "matching event absent; exact replay needs original event reconciliation",
        ))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnchorEvent {
    pub call: AnchorCall,
    pub publisher: Address,
    pub ordinal: u64,
    pub block_hash: B256,
    pub block_number: u64,
    pub transaction_hash: B256,
    pub log_index: u64,
}
impl AnchorEvent {
    pub fn decode(log: &Log) -> Result<Self> {
        let event = ECorpCheckpointRegistryV1::Anchored::decode_log(&log.inner, true)
            .map_err(|_| Error::Evidence("invalid anchor event ABI"))?;
        let call = AnchorCall {
            stream_id: event.data.streamId,
            sequence: event.data.sequence,
            checkpoint_digest: event.data.checkpointDigest,
            previous_anchor_digest: event.data.previousAnchorDigest,
        };
        call.validate()?;
        if log.removed || event.data.anchorOrdinal == 0 || event.data.publisher.is_zero() {
            return Err(Error::Evidence("invalid anchor event"));
        }
        Ok(Self {
            call,
            publisher: event.data.publisher,
            ordinal: event.data.anchorOrdinal,
            block_hash: log
                .block_hash
                .filter(|h| !h.is_zero())
                .ok_or(Error::Evidence("event unsealed"))?,
            block_number: log
                .block_number
                .ok_or(Error::Evidence("event block missing"))?,
            transaction_hash: log
                .transaction_hash
                .ok_or(Error::Evidence("event transaction missing"))?,
            log_index: log
                .log_index
                .ok_or(Error::Evidence("event index missing"))?,
        })
    }
}

pub fn verify_ancestry(
    included: &SealedHeader,
    finalized: &SealedHeader,
    descending: &[SealedHeader],
) -> Result<()> {
    if included.hash.is_zero()
        || finalized.hash.is_zero()
        || finalized.number < included.number
        || descending.len() > MAX_ANCESTRY_HEADERS
    {
        return Err(Error::Evidence(
            "finality ancestry invalid or exceeds bounds",
        ));
    }
    let distance = finalized.number - included.number;
    if distance == 0 {
        if included != finalized || !descending.is_empty() {
            return Err(Error::Evidence("finality fork"));
        }
        return Ok(());
    }
    if distance != descending.len() as u64 || descending.first() != Some(finalized) {
        return Err(Error::Evidence("finality ancestry incomplete"));
    }
    for (child, parent) in descending
        .iter()
        .zip(descending.iter().skip(1).chain(std::iter::once(included)))
    {
        if parent.number.checked_add(1) != Some(child.number)
            || parent.hash != child.parent_hash
            || parent.timestamp > child.timestamp
        {
            return Err(Error::Evidence("finality ancestry fork"));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OracleImplementation {
    pub address: Address,
    pub runtime_code_hash: B256,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeeOracleQualification {
    pub runtime_code_hash: B256,
    pub implementation: Option<OracleImplementation>,
    pub qualification_id: String,
}
impl FeeOracleQualification {
    async fn verify(&self, rpc: &HttpRpc, block: B256) -> Result<()> {
        if !identifier(&self.qualification_id) || self.runtime_code_hash.is_zero() {
            return Err(Error::Admission("fee adapter unqualified"));
        }
        let code = rpc.code(ORACLE, block).await?;
        if code.is_empty() || keccak256(&code) != self.runtime_code_hash {
            return Err(Error::Admission("unexpected oracle code"));
        }
        let slot: B256 = rpc
            .request(
                "eth_getStorageAt",
                json!([ORACLE,IMPLEMENTATION_SLOT,{"blockHash":block,"requireCanonical":true}]),
            )
            .await?;
        match &self.implementation {
            None if slot.is_zero() => {}
            Some(implementation)
                if slot.as_slice()[..12] == [0; 12]
                    && Address::from_slice(&slot.as_slice()[12..]) == implementation.address
                    && !implementation.address.is_zero() =>
            {
                let code = rpc.code(implementation.address, block).await?;
                if code.is_empty() || keccak256(code) != implementation.runtime_code_hash {
                    return Err(Error::Admission("unexpected oracle implementation"));
                }
            }
            _ => return Err(Error::Admission("oracle implementation unqualified")),
        }
        Ok(())
    }
}

/// A read-only, qualified dual-provider connection. A value cannot be deserialized as proof.
pub struct BaseConnection {
    pub primary: HttpRpc,
    pub secondary: HttpRpc,
    config: BaseDestinationConfig,
    trust: ManifestTrust,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupObservation {
    pub block: SealedHeader,
    pub head: RegistryHead,
    pub provider_identities: [String; 2],
    pub observed_at: DateTime<Utc>,
}
impl BaseConnection {
    pub async fn connect(
        config: BaseDestinationConfig,
        trust: ManifestTrust,
        secrets: &dyn EndpointSecrets,
        primary_policy: EndpointPolicy,
        secondary_policy: EndpointPolicy,
    ) -> Result<Self> {
        Self::validate_destination(&config, &trust)?;
        let primary = HttpRpc::connect(
            &config.primary_rpc_secret,
            &config.primary_operator,
            secrets,
            primary_policy,
        )
        .await?;
        let secondary = HttpRpc::connect(
            &config.secondary_rpc_secret,
            &config.secondary_operator,
            secrets,
            secondary_policy,
        )
        .await?;
        let same_host = primary.url.host_str() == secondary.url.host_str();
        #[cfg(all(feature = "test-support", debug_assertions))]
        let same_host = same_host
            && !matches!(
                (primary.policy.test_loopback, secondary.policy.test_loopback),
                (Some(a), Some(b)) if a != b
            );
        if same_host {
            return Err(Error::Config("independent provider hosts required"));
        }
        Ok(Self {
            primary,
            secondary,
            config,
            trust,
        })
    }

    fn validate_destination(config: &BaseDestinationConfig, trust: &ManifestTrust) -> Result<()> {
        config.validate()?;
        let manifest = &trust.current().manifest;
        if trust.current().digest != config.manifest_digest
            || manifest.chain_id != config.chain_id
            || manifest.contract_address != config.contract_address
            || manifest.stream_id != config.stream_id
            || manifest.assurance_policy != config.assurance
        {
            return Err(Error::Trust(
                "configuration is not the current authorized manifest",
            ));
        }
        if config.assurance != Assurance::ProviderObservedFinalized {
            return Err(Error::Config(
                "independently derived node qualification not implemented; no assurance fallback",
            ));
        }
        Ok(())
    }

    /// Synthetic integration only; sharing one local node never proves provider independence.
    #[cfg(all(feature = "test-support", debug_assertions))]
    pub async fn connect_test_loopback(
        config: BaseDestinationConfig,
        trust: ManifestTrust,
        secrets: &dyn EndpointSecrets,
    ) -> Result<Self> {
        Self::validate_destination(&config, &trust)?;
        let primary = HttpRpc::connect_test_loopback(
            &config.primary_rpc_secret,
            &config.primary_operator,
            secrets,
        )
        .await?;
        let secondary = HttpRpc::connect_test_loopback(
            &config.secondary_rpc_secret,
            &config.secondary_operator,
            secrets,
        )
        .await?;
        Ok(Self {
            primary,
            secondary,
            config,
            trust,
        })
    }
    /// Does at most 512 parent-header reads per provider and persists progress before returning.
    /// `None` means pending retained ancestry, never verified inclusion or finality.
    pub async fn verify_receipt_finality_resumable(
        &self,
        hash: B256,
        store: &dyn AncestryStore,
    ) -> Result<Option<FinalizedReceipt>> {
        if hash.is_zero() {
            return Err(Error::Evidence("transaction hash missing"));
        }
        let mut original: Option<(ReceiptEvidence, SealedHeader)> = None;
        let mut states = Vec::with_capacity(2);
        for rpc in [&self.primary, &self.secondary] {
            let receipt = rpc
                .receipt(hash)
                .await?
                .ok_or(Error::Evidence("receipt unavailable"))?;
            let number = receipt
                .receipt
                .block_number
                .ok_or(Error::Evidence("receipt unsealed"))?;
            let included = rpc.block(BlockTag::Number(number)).await?;
            if Some(included.hash) != receipt.receipt.block_hash {
                return Err(Error::Evidence("receipt reorged"));
            }
            if let Some((first, block)) = &original {
                if first.receipt != receipt.receipt
                    || first.l1_fee != receipt.l1_fee
                    || block != &included
                {
                    return Err(Error::Evidence(
                        "independent providers disagree on inclusion",
                    ));
                }
            } else {
                original = Some((receipt, included.clone()));
            }
            let key = ancestry_key(
                self.trust.current().digest,
                self.config.chain_id,
                hash,
                &rpc.provider_identity,
                included.hash,
            );
            let previous = store.load(key).await?;
            let observed_finalized = rpc.block(BlockTag::Finalized).await?;
            let binding = if let Some(state) = &previous {
                state.validate()?;
                if state.binding.key() != key
                    || state.binding.included != included
                    || state.binding.manifest_digest != self.trust.current().digest
                    || state.binding.provider_identity != rpc.provider_identity
                    || state.binding.transaction_hash != hash
                    || state.binding.chain_id != self.config.chain_id
                {
                    return Err(Error::Evidence(
                        "retained ancestry has wrong destination binding",
                    ));
                }
                if observed_finalized.number < state.binding.finalized.number
                    || rpc
                        .block(BlockTag::Number(state.binding.finalized.number))
                        .await?
                        != state.binding.finalized
                {
                    return Err(Error::Evidence(
                        "retained finalized observation reorged or regressed",
                    ));
                }
                state.binding.clone()
            } else {
                AncestryBinding {
                    manifest_digest: self.trust.current().digest,
                    chain_id: self.config.chain_id,
                    transaction_hash: hash,
                    provider_identity: rpc.provider_identity.clone(),
                    included: included.clone(),
                    finalized: observed_finalized,
                    observed_at: Utc::now(),
                }
            };
            binding.validate()?;
            let state = if previous.as_ref().is_some_and(|state| state.complete) {
                previous.ok_or(Error::Evidence("retained ancestry state missing"))?
            } else {
                let mut next_hash = previous
                    .as_ref()
                    .map_or(binding.finalized.hash, |state| state.next_hash);
                let mut next_number = previous
                    .as_ref()
                    .map_or(binding.finalized.number, |state| state.next_number);
                let mut headers = Vec::with_capacity(MAX_SEGMENT_HEADERS);
                for _ in 0..MAX_SEGMENT_HEADERS {
                    let header = rpc.consensus_header(next_hash).await?;
                    if header.number != next_number {
                        return Err(Error::Evidence("parent header number discontinuity"));
                    }
                    let complete = header.number == binding.included.number;
                    next_hash = header.parent_hash;
                    next_number = header.number.saturating_sub(1);
                    headers.push(header);
                    if complete {
                        break;
                    }
                }
                let segment = AncestrySegment { binding, headers };
                let next = AncestryState::apply_segment(previous.as_ref(), &segment)?;
                store
                    .append(
                        key,
                        previous.as_ref().map_or(0, |state| state.segments),
                        &segment,
                    )
                    .await?;
                next
            };
            states.push(state);
        }
        if states.iter().any(|state| !state.complete) {
            return Ok(None);
        }
        let common_number = states[0]
            .binding
            .finalized
            .number
            .min(states[1].binding.finalized.number);
        let common_primary = self.primary.block(BlockTag::Number(common_number)).await?;
        let common_secondary = self
            .secondary
            .block(BlockTag::Number(common_number))
            .await?;
        if common_primary != common_secondary {
            return Err(Error::Evidence("providers disagree on finalized ancestry"));
        }
        let mut observations = Vec::with_capacity(2);
        for (rpc, state) in [&self.primary, &self.secondary].into_iter().zip(&states) {
            let common = store
                .header(state.binding.key(), common_number)
                .await?
                .ok_or(Error::Evidence("retained common finalized header missing"))?;
            if sealed_header(&common) != common_primary
                || rpc
                    .block(BlockTag::Number(state.binding.included.number))
                    .await?
                    != state.binding.included
                || rpc
                    .block(BlockTag::Number(state.binding.finalized.number))
                    .await?
                    != state.binding.finalized
            {
                return Err(Error::Evidence("retained ancestry no longer canonical"));
            }
            observations.push(FinalityObservation {
                provider_identity: rpc.provider_identity.clone(),
                observed_at: state.binding.observed_at,
                finalized: state.binding.finalized.clone(),
                ancestry: vec![],
                retained_ancestry: Some(RetainedAncestry::from_complete(state)?),
            });
        }
        let (receipt, included) = original.ok_or(Error::Evidence("receipt observation missing"))?;
        Ok(Some(FinalizedReceipt {
            receipt,
            included,
            observations,
            assurance: Assurance::ProviderObservedFinalized,
        }))
    }

    pub async fn verify_anchor_resumable(
        &self,
        hash: B256,
        call: &AnchorCall,
        publisher: Address,
        store: &dyn AncestryStore,
    ) -> Result<Option<FinalizedAnchor>> {
        call.validate()?;
        if call.stream_id != self.config.stream_id {
            return Err(Error::Evidence("wrong destination stream"));
        }
        let Some(finality) = self.verify_receipt_finality_resumable(hash, store).await? else {
            return Ok(None);
        };
        let event = finality
            .receipt
            .exact_event(self.config.contract_address, call, publisher)?;
        Ok(Some(FinalizedAnchor {
            receipt: finality.receipt,
            event,
            included: finality.included,
            observations: finality.observations,
            assurance: finality.assurance,
        }))
    }

    pub fn config(&self) -> &BaseDestinationConfig {
        &self.config
    }
    pub async fn startup(
        &self,
        signer_address: Address,
        expected_owner: Address,
    ) -> Result<StartupObservation> {
        if signer_address != self.config.publisher || expected_owner.is_zero() {
            return Err(Error::Evidence("signer or owner mismatch"));
        }
        let m = &self.trust.current().manifest;
        let mut finalized = Vec::new();
        for rpc in [&self.primary, &self.secondary] {
            if rpc.chain_id().await? != m.chain_id
                || rpc.block(BlockTag::Number(0)).await?.hash != m.network_identity.genesis_hash
            {
                return Err(Error::Evidence("network identity mismatch"));
            }
            if let Some(checkpoint) = &m.network_identity.checkpoint
                && rpc.block(BlockTag::Number(checkpoint.number)).await?.hash != checkpoint.hash
            {
                return Err(Error::Evidence("network checkpoint mismatch"));
            }
            let deployment = rpc
                .block(BlockTag::Number(m.deployment_block_number))
                .await?;
            if deployment.hash != m.deployment_block_hash {
                return Err(Error::Evidence("deployment identity mismatch"));
            }
            let code = rpc.code(m.contract_address, deployment.hash).await?;
            if code.is_empty() || keccak256(code) != m.runtime_code_hash {
                return Err(Error::Evidence("deployment code mismatch"));
            }
            if m.deployment_block_number > 0 {
                let before = rpc
                    .block(BlockTag::Number(m.deployment_block_number - 1))
                    .await?;
                if !rpc.code(m.contract_address, before.hash).await?.is_empty() {
                    return Err(Error::Evidence("contract predates claimed deployment"));
                }
            }
            #[derive(Deserialize)]
            struct DeploymentBlock {
                transactions: Vec<B256>,
            }
            let txs: DeploymentBlock = rpc
                .request("eth_getBlockByHash", json!([deployment.hash, false]))
                .await?;
            let first = txs
                .transactions
                .first()
                .ok_or(Error::Evidence("deployment block has no transactions"))?;
            let receipt = rpc
                .receipt(*first)
                .await?
                .ok_or(Error::Evidence("historical receipt capability missing"))?;
            if receipt.receipt.block_hash != Some(deployment.hash)
                || receipt.receipt.block_number != Some(deployment.number)
            {
                return Err(Error::Evidence("historical receipt identity mismatch"));
            }
            let latest = rpc.block(BlockTag::Latest).await?;
            let head = rpc.block(BlockTag::Finalized).await?;
            if head.number > latest.number {
                return Err(Error::Evidence("finalized head exceeds sealed latest"));
            }
            finalized.push(head);
        }
        let number = finalized[0].number.min(finalized[1].number);
        let block = self.primary.block(BlockTag::Number(number)).await?;
        if block != self.secondary.block(BlockTag::Number(number)).await? {
            return Err(Error::Evidence("providers disagree on canonical block"));
        }
        if number < m.deployment_block_number {
            return Err(Error::Evidence("deployment is not finalized"));
        }
        Self::ancestry(&self.primary, &block, &finalized[0]).await?;
        Self::ancestry(&self.secondary, &block, &finalized[1]).await?;
        let mut heads = Vec::new();
        for rpc in [&self.primary, &self.secondary] {
            if keccak256(rpc.code(m.contract_address, block.hash).await?) != m.runtime_code_hash {
                return Err(Error::Evidence("unexpected registry code"));
            }
            let version = rpc
                .call(
                    m.contract_address,
                    ECorpCheckpointRegistryV1::versionCall {}
                        .abi_encode()
                        .into(),
                    None,
                    json!({"blockHash":block.hash,"requireCanonical":true}),
                )
                .await?;
            if ECorpCheckpointRegistryV1::versionCall::abi_decode_returns(&version, true)
                .map_err(|_| Error::Evidence("invalid registry version"))?
                ._0
                != U256::from(m.contract_version)
            {
                return Err(Error::Evidence("registry version mismatch"));
            }
            let head = rpc
                .head(m.contract_address, m.stream_id, block.hash)
                .await?;
            if !head.registered
                || head.paused
                || head.owner != expected_owner
                || head.publisher != signer_address
            {
                return Err(Error::Evidence("stream authorization mismatch"));
            }
            // Historical capability probes use actual enrollment-era blocks, not a successful empty latest query.
            rpc.logs(
                m.contract_address,
                m.stream_id,
                m.deployment_block_number,
                m.deployment_block_number,
            )
            .await?;
            heads.push(head);
        }
        if heads[0] != heads[1] {
            return Err(Error::Evidence("providers disagree on registry head"));
        }
        Ok(StartupObservation {
            block,
            head: heads.remove(0),
            provider_identities: [
                self.primary.provider_identity.clone(),
                self.secondary.provider_identity.clone(),
            ],
            observed_at: Utc::now(),
        })
    }
    async fn ancestry(
        rpc: &HttpRpc,
        included: &SealedHeader,
        finalized: &SealedHeader,
    ) -> Result<Vec<SealedHeader>> {
        let distance = finalized
            .number
            .checked_sub(included.number)
            .ok_or(Error::Evidence("anchor not finalized"))?;
        if distance > MAX_ANCESTRY_HEADERS as u64 {
            return Err(Error::Evidence(
                "ancestry exceeds bounded verification window; retain intermediate evidence",
            ));
        }
        let mut proof = Vec::with_capacity(distance as usize);
        let mut current = finalized.clone();
        while current.number > included.number {
            let parent_hash = current.parent_hash;
            proof.push(current);
            current = rpc.block_hash(parent_hash).await?;
        }
        if &current != included {
            return Err(Error::Evidence(
                "finality ancestry does not reach inclusion",
            ));
        }
        verify_ancestry(included, finalized, &proof)?;
        Ok(proof)
    }
    pub async fn verify_anchor(
        &self,
        hash: B256,
        call: &AnchorCall,
        publisher: Address,
    ) -> Result<FinalizedAnchor> {
        call.validate()?;
        if call.stream_id != self.config.stream_id {
            return Err(Error::Evidence("wrong destination stream"));
        }
        let finality = self.verify_receipt_finality(hash).await?;
        let event = finality
            .receipt
            .exact_event(self.config.contract_address, call, publisher)?;
        Ok(FinalizedAnchor {
            receipt: finality.receipt,
            event,
            included: finality.included,
            observations: finality.observations,
            assurance: finality.assurance,
        })
    }

    /// Establishes canonical finality of this exact transaction, including reverts and no-ops.
    /// It never establishes checkpoint coverage without a separately matched original anchor event.
    pub async fn verify_receipt_finality(&self, hash: B256) -> Result<FinalizedReceipt> {
        if hash.is_zero() {
            return Err(Error::Evidence("transaction hash missing"));
        }
        let mut observations = Vec::new();
        let mut original: Option<(ReceiptEvidence, SealedHeader)> = None;
        for rpc in [&self.primary, &self.secondary] {
            let receipt = rpc
                .receipt(hash)
                .await?
                .ok_or(Error::Evidence("receipt unavailable"))?;
            let number = receipt
                .receipt
                .block_number
                .ok_or(Error::Evidence("receipt unsealed"))?;
            let included = rpc.block(BlockTag::Number(number)).await?;
            if Some(included.hash) != receipt.receipt.block_hash {
                return Err(Error::Evidence("receipt reorged"));
            }
            if let Some((first, first_block)) = &original {
                if first.receipt != receipt.receipt
                    || first.l1_fee != receipt.l1_fee
                    || first_block != &included
                {
                    return Err(Error::Evidence(
                        "independent providers disagree on inclusion",
                    ));
                }
            } else {
                original = Some((receipt, included.clone()));
            }
            let finalized = rpc.block(BlockTag::Finalized).await?;
            let ancestry = Self::ancestry(rpc, &included, &finalized).await?;
            observations.push(FinalityObservation {
                provider_identity: rpc.provider_identity.clone(),
                observed_at: Utc::now(),
                finalized,
                ancestry,
                retained_ancestry: None,
            });
        }
        // Different finalized heights are permitted only if both providers agree on the common canonical finalized block.
        let common_number = observations[0]
            .finalized
            .number
            .min(observations[1].finalized.number);
        let common_primary = self.primary.block(BlockTag::Number(common_number)).await?;
        let common_secondary = self
            .secondary
            .block(BlockTag::Number(common_number))
            .await?;
        if common_primary != common_secondary {
            return Err(Error::Evidence("providers disagree on finalized ancestry"));
        }
        let (receipt, included) =
            original.ok_or(Error::Evidence("inclusion observation missing"))?;
        for observation in &observations {
            let retained_common = if common_number == included.number {
                Some(&included)
            } else if common_number == observation.finalized.number {
                Some(&observation.finalized)
            } else {
                observation
                    .ancestry
                    .iter()
                    .find(|header| header.number == common_number)
            };
            if retained_common != Some(&common_primary) {
                return Err(Error::Evidence(
                    "canonical finalized block changed during verification",
                ));
            }
        }
        Ok(FinalizedReceipt {
            receipt,
            included,
            observations,
            assurance: Assurance::ProviderObservedFinalized,
        })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalityObservation {
    pub provider_identity: String,
    pub observed_at: DateTime<Utc>,
    pub finalized: SealedHeader,
    pub ancestry: Vec<SealedHeader>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_ancestry: Option<RetainedAncestry>,
}
#[derive(Debug, Clone, Serialize)]
pub struct FinalizedAnchor {
    pub receipt: ReceiptEvidence,
    pub event: AnchorEvent,
    pub included: SealedHeader,
    pub observations: Vec<FinalityObservation>,
    pub assurance: Assurance,
}

#[derive(Debug, Clone, Serialize)]
pub struct FinalizedReceipt {
    pub receipt: ReceiptEvidence,
    pub included: SealedHeader,
    pub observations: Vec<FinalityObservation>,
    pub assurance: Assurance,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogPage {
    pub from_block: u64,
    pub end: SealedHeader,
    pub logs: Vec<Log>,
}

/// Authenticated gateway client; raw replies are revalidated against immutable transaction fields.
pub struct HttpSigningGateway {
    transport: HttpRpc,
}
impl HttpSigningGateway {
    #[cfg(all(feature = "test-support", debug_assertions))]
    pub async fn connect_test_loopback(
        reference: &str,
        identity: &str,
        secrets: &dyn EndpointSecrets,
    ) -> Result<Self> {
        Ok(Self {
            transport: HttpRpc::connect_test_loopback(reference, identity, secrets).await?,
        })
    }
    pub async fn identity(&self) -> Result<crate::signing::GatewayIdentity> {
        <Self as SigningGateway>::identity(self).await
    }

    pub async fn journal_snapshot(
        &self,
        chain_id: u64,
        publisher: Address,
    ) -> Result<crate::signing::JournalSnapshot> {
        <Self as SigningGateway>::journal_snapshot(self, chain_id, publisher).await
    }

    pub async fn connect(
        reference: &str,
        identity: &str,
        secrets: &dyn EndpointSecrets,
        policy: EndpointPolicy,
    ) -> Result<Self> {
        Ok(Self {
            transport: HttpRpc::connect(reference, identity, secrets, policy).await?,
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GatewayReply {
    raw_transaction: Bytes,
    transaction_hash: B256,
}
#[async_trait]
impl SigningGateway for HttpSigningGateway {
    async fn identity(&self) -> Result<crate::signing::GatewayIdentity> {
        let identity: crate::signing::GatewayIdentity = self
            .transport
            .request("ecorp_gatewayIdentity", json!([]))
            .await?;
        identity.validate()?;
        Ok(identity)
    }
    async fn journal_snapshot(
        &self,
        chain_id: u64,
        publisher: Address,
    ) -> Result<crate::signing::JournalSnapshot> {
        let snapshot: crate::signing::JournalSnapshot = self
            .transport
            .request(
                "ecorp_journalSnapshot",
                json!([{"chain_id":chain_id,"publisher":publisher}]),
            )
            .await?;
        snapshot.validate(chain_id, publisher)?;
        Ok(snapshot)
    }
    async fn sign(&self, request: &SignRequest) -> Result<SignedTransaction> {
        request.validate()?;
        let reply: GatewayReply = self
            .transport
            .request("ecorp_signAttempt", json!([request]))
            .await?;
        let signed = SignedTransaction::validate(request, &reply.raw_transaction)?;
        if signed.hash() != reply.transaction_hash {
            return Err(Error::Signing("gateway hash mismatch"));
        }
        Ok(signed)
    }
    async fn lookup(&self, request: &SignRequest) -> Result<Option<SignedTransaction>> {
        request.validate()?;
        let reply: Option<GatewayReply> = self
            .transport
            .request("ecorp_lookupAttempt", json!([request]))
            .await?;
        reply
            .map(|reply| {
                let signed = SignedTransaction::validate(request, &reply.raw_transaction)?;
                if signed.hash() != reply.transaction_hash {
                    return Err(Error::Signing("gateway hash mismatch"));
                }
                Ok(signed)
            })
            .transpose()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use alloy::sol_types::SolValue;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn fee_history_accepts_unused_finite_ratios_but_rejects_duplicate_and_float_wei() {
        let history = json!({
            "oldestBlock":"0x1",
            "baseFeePerGas":["0xa","0xa","0xa","0xa","0xa"],
            "reward":[["0x1"],["0x2"],["0x1"],["0x1"]],
            "gasUsedRatio":[0.0,0.25,0.5,1.0],
            "baseFeePerBlobGas":["0x1","0x1","0x1","0x1","0x1"],
            "blobGasUsedRatio":[0.0,0.0,0.0,0.0]
        });
        let (rpc, task) = fixture(vec![("eth_feeHistory", history.clone())]).await;
        assert_eq!(rpc.fee_suggestion().await.unwrap(), (22, 2));
        task.await.unwrap();
        let mut float_wei = history;
        float_wei["baseFeePerGas"][4] = json!(10.0);
        let (rpc, task) = fixture(vec![("eth_feeHistory", float_wei)]).await;
        assert!(rpc.fee_suggestion().await.is_err());
        task.await.unwrap();
        let (rpc,task)=fixture(vec![("eth_feeHistory",json!({"_raw":
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"gasUsedRatio\":[0.0],\"gasUsedRatio\":[1.0]}}"
        }))]).await;
        assert!(rpc.fee_suggestion().await.is_err());
        task.await.unwrap();
    }

    #[tokio::test]
    async fn pending_nonce_uses_pending_tag_and_cannot_be_a_sealed_evidence_block() {
        let (rpc, task) = fixture(vec![(
            "eth_getTransactionCount",
            json!({
                "_expected_params":[Address::repeat_byte(1),"pending"],"_result":"0x2a"
            }),
        )])
        .await;
        assert_eq!(
            rpc.nonce(Address::repeat_byte(1), BlockTag::Pending)
                .await
                .unwrap(),
            42
        );
        assert!(rpc.block(BlockTag::Pending).await.is_err());
        task.await.unwrap();
    }

    #[derive(Default)]
    struct RetainedFixture(
        tokio::sync::Mutex<std::collections::BTreeMap<B256, (AncestryState, Vec<AncestrySegment>)>>,
    );
    #[async_trait]
    impl AncestryStore for RetainedFixture {
        async fn load(&self, key: B256) -> Result<Option<AncestryState>> {
            // Round-trip every load to exercise restart serialization rather than pointer identity.
            self.0
                .lock()
                .await
                .get(&key)
                .map(|(state, _)| {
                    serde_json::from_value(serde_json::to_value(state).unwrap())
                        .map_err(|_| Error::Evidence("fixture state decode"))
                })
                .transpose()
        }
        async fn append(&self, key: B256, count: u64, segment: &AncestrySegment) -> Result<()> {
            let mut map = self.0.lock().await;
            let current = map.get(&key);
            if current.map_or(0, |(state, _)| state.segments) != count
                || segment.binding.key() != key
            {
                return Err(Error::Evidence("fixture ancestry CAS rejected"));
            }
            let next = AncestryState::apply_segment(current.map(|(state, _)| state), segment)?;
            let mut segments = current.map_or_else(Vec::new, |(_, segments)| segments.clone());
            segments.push(segment.clone());
            map.insert(key, (next, segments));
            Ok(())
        }
        async fn header(
            &self,
            key: B256,
            number: u64,
        ) -> Result<Option<crate::ancestry::ConsensusHeader>> {
            Ok(self.0.lock().await.get(&key).and_then(|(_, segments)| {
                segments
                    .iter()
                    .flat_map(|segment| &segment.headers)
                    .find(|header| header.number == number)
                    .cloned()
            }))
        }
    }
    fn full_header_value(header: &crate::ancestry::ConsensusHeader) -> Value {
        let mut value = serde_json::to_value(header).unwrap();
        value["hash"] = json!(header.hash_slow());
        value
    }
    #[tokio::test]
    async fn receipt_finality_resumes_persisted_consensus_segments_over_real_http() {
        let mut headers = Vec::new();
        let mut parent = B256::ZERO;
        for number in 0..515 {
            let header = crate::ancestry::ConsensusHeader {
                number,
                parent_hash: parent,
                timestamp: number + 100,
                ..crate::ancestry::ConsensusHeader::default()
            };
            parent = header.hash_slow();
            headers.push(header);
        }
        let mut receipt = receipt(json!([]), "0x0");
        receipt["blockNumber"] = json!("0x1");
        receipt["blockHash"] = json!(headers[1].hash_slow());
        let mut responses = vec![
            ("eth_getTransactionReceipt", receipt.clone()),
            ("eth_getBlockByNumber", full_header_value(&headers[1])),
            ("eth_getBlockByNumber", full_header_value(&headers[514])),
        ];
        responses.extend(
            headers[3..]
                .iter()
                .rev()
                .map(|header| ("eth_getBlockByHash", full_header_value(header))),
        );
        responses.extend([
            ("eth_getTransactionReceipt", receipt),
            ("eth_getBlockByNumber", full_header_value(&headers[1])),
            ("eth_getBlockByNumber", full_header_value(&headers[514])),
            ("eth_getBlockByNumber", full_header_value(&headers[514])),
            ("eth_getBlockByHash", full_header_value(&headers[2])),
            ("eth_getBlockByHash", full_header_value(&headers[1])),
            ("eth_getBlockByNumber", full_header_value(&headers[514])),
            ("eth_getBlockByNumber", full_header_value(&headers[1])),
            ("eth_getBlockByNumber", full_header_value(&headers[514])),
        ]);
        let (primary, p) = fixture(responses.clone()).await;
        let (mut secondary, s) = fixture(responses).await;
        secondary.provider_identity = "independent-fixture".into();
        let connection = BaseConnection {
            primary,
            secondary,
            config: BaseDestinationConfig::default(),
            trust: trust_fixture(),
        };
        let store = RetainedFixture::default();
        assert!(
            connection
                .verify_receipt_finality_resumable(B256::repeat_byte(3), &store)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .0
                .lock()
                .await
                .values()
                .all(|(state, _)| state.header_count == 512 && !state.complete)
        );
        let result = connection
            .verify_receipt_finality_resumable(B256::repeat_byte(3), &store)
            .await
            .unwrap()
            .unwrap();
        assert!(!result.receipt.receipt.status());
        for observation in result.observations {
            assert!(observation.ancestry.is_empty());
            let retained = observation.retained_ancestry.unwrap();
            assert_eq!(retained.header_count, 514);
            assert_eq!(retained.segments, 2);
        }
        p.await.unwrap();
        s.await.unwrap();
    }

    fn receipt_finality_responses(status: &str, hash: u8) -> Vec<(&'static str, Value)> {
        vec![
            ("eth_getTransactionReceipt", receipt(json!([]), status)),
            ("eth_getBlockByNumber", header(10, hash, 3)),
            ("eth_getBlockByNumber", header(11, 5, hash)),
            ("eth_getBlockByHash", header(10, hash, 3)),
            ("eth_getBlockByNumber", header(11, 5, hash)),
        ]
    }
    #[tokio::test]
    async fn noop_and_reverted_receipts_prove_own_nonce_finality_without_anchor_coverage() {
        for status in ["0x0", "0x1"] {
            let (primary, p) = fixture(receipt_finality_responses(status, 4)).await;
            let (mut secondary, s) = fixture(receipt_finality_responses(status, 4)).await;
            secondary.provider_identity = "fixture-independent-b".into();
            let connection = BaseConnection {
                primary,
                secondary,
                config: BaseDestinationConfig::default(),
                trust: trust_fixture(),
            };
            let finality = connection
                .verify_receipt_finality(B256::repeat_byte(3))
                .await
                .unwrap();
            assert_eq!(finality.receipt.receipt.status(), status == "0x1");
            assert_eq!(finality.included.number, 10);
            assert_eq!(finality.observations.len(), 2);
            assert_eq!(finality.observations[0].ancestry.len(), 1);
            assert!(finality.receipt.receipt.inner.logs().is_empty());
            p.await.unwrap();
            s.await.unwrap();
        }
    }
    #[tokio::test]
    async fn receipt_finality_rejects_reorg_even_for_successful_noop() {
        let mut responses = receipt_finality_responses("0x1", 9);
        responses.truncate(2);
        let (primary, p) = fixture(responses).await;
        let (secondary, s) = fixture(vec![]).await;
        let connection = BaseConnection {
            primary,
            secondary,
            config: BaseDestinationConfig::default(),
            trust: trust_fixture(),
        };
        assert!(
            connection
                .verify_receipt_finality(B256::repeat_byte(3))
                .await
                .is_err()
        );
        p.await.unwrap();
        s.await.unwrap();
    }

    #[tokio::test]
    async fn receipt_finality_rejects_changed_finalized_observation() {
        let mut responses = receipt_finality_responses("0x1", 4);
        responses[4].1 = header(11, 9, 4);
        let (primary, p) = fixture(responses.clone()).await;
        let (secondary, s) = fixture(responses).await;
        let connection = BaseConnection {
            primary,
            secondary,
            config: BaseDestinationConfig::default(),
            trust: trust_fixture(),
        };
        let result = connection
            .verify_receipt_finality(B256::repeat_byte(3))
            .await;
        p.abort();
        s.abort();
        assert!(
            result.is_err(),
            "matching later observations cannot replace retained finality"
        );
    }

    #[tokio::test]
    async fn receipt_finality_rejects_independent_cost_disagreement() {
        let mut primary_responses = receipt_finality_responses("0x0", 4);
        primary_responses.truncate(4);
        let mut secondary_responses = receipt_finality_responses("0x0", 4);
        secondary_responses.truncate(2);
        secondary_responses[0].1["l1Fee"] = json!("0x1");
        let (primary, p) = fixture(primary_responses).await;
        let (secondary, s) = fixture(secondary_responses).await;
        let connection = BaseConnection {
            primary,
            secondary,
            config: BaseDestinationConfig::default(),
            trust: trust_fixture(),
        };
        assert!(
            connection
                .verify_receipt_finality(B256::repeat_byte(3))
                .await
                .is_err()
        );
        p.await.unwrap();
        s.await.unwrap();
    }

    #[tokio::test]
    async fn gateway_identity_and_journal_snapshot_use_real_bounded_http() {
        let publisher = Address::repeat_byte(1);
        let (transport,task) = fixture(vec![
            ("ecorp_gatewayIdentity",json!({"chain_id":8453,"publisher":publisher,"immutable_key_identity":"fixture-key"})),
            ("ecorp_journalSnapshot",json!({"epoch":"11111111-1111-4111-8111-111111111111","cursor":0,"requests":[],"complete":true})),
        ]).await;
        let gateway = HttpSigningGateway { transport };
        let identity = gateway.identity().await.unwrap();
        assert_eq!(identity.publisher, publisher);
        let snapshot = gateway
            .journal_snapshot(identity.chain_id, identity.publisher)
            .await
            .unwrap();
        assert!(snapshot.complete);
        task.await.unwrap();
    }

    fn trust_fixture() -> ManifestTrust {
        use crate::manifest::{
            CheckpointKey, DestinationManifestV1, NetworkIdentity, SignedManifest, TrustPin,
        };
        let key = ed25519_dalek::SigningKey::from_bytes(&[10; 32]);
        let owner = Address::repeat_byte(1);
        let local = B256::repeat_byte(2);
        let manifest = DestinationManifestV1 {
            schema_version: 1,
            customer_trust_id: B256::repeat_byte(1),
            manifest_version: 1,
            previous_manifest_digest: None,
            ledger_id: "11111111-1111-4111-8111-111111111111".into(),
            chain_id: 8453,
            network_identity: NetworkIdentity {
                genesis_hash: B256::repeat_byte(2),
                checkpoint: None,
            },
            contract_address: Address::repeat_byte(6),
            contract_version: 1,
            runtime_code_hash: keccak256(b"fixture-registry"),
            deployment_block_hash: B256::repeat_byte(4),
            deployment_block_number: 1,
            stream_id: crate::abi::stream_id(owner, local),
            registering_owner: owner,
            local_stream_key: local,
            checkpoint_keys: vec![CheckpointKey {
                key_id: "checkpoint".into(),
                public_key: key.verifying_key().to_bytes(),
                first_sequence: 1,
                last_sequence: None,
            }],
            assurance_policy: Assurance::ProviderObservedFinalized,
            evidence_retention_policy: "fixture-retention".into(),
            migration: None,
            next_manifest_authority: None,
        };
        let signed = SignedManifest::sign(manifest, &key, None).unwrap();
        ManifestTrust::bootstrap(
            &TrustPin {
                authority: key.verifying_key().to_bytes(),
                initial_manifest_digest: signed.digest,
            },
            &signed,
        )
        .unwrap()
    }
    fn header(number: u64, hash: u8, parent: u8) -> Value {
        json!({"number":format!("0x{number:x}"),"hash":B256::repeat_byte(hash),"parentHash":B256::repeat_byte(parent),"timestamp":format!("0x{:x}",number+100)})
    }
    fn startup_responses() -> Vec<(&'static str, Value)> {
        let mut deployment_receipt = receipt(json!([]), "0x1");
        deployment_receipt["blockNumber"] = json!("0x1");
        let head = ECorpCheckpointRegistryV1::Head {
            registered: true,
            owner: Address::repeat_byte(1),
            pendingOwner: Address::ZERO,
            publisher: Address::repeat_byte(5),
            paused: false,
            lastSequence: 0,
            lastDigest: B256::ZERO,
            previousAnchorDigest: B256::ZERO,
            anchorOrdinal: 0,
        };
        vec![
            ("eth_chainId", json!("0x2105")),
            ("eth_getBlockByNumber", header(0, 2, 0)),
            ("eth_getBlockByNumber", header(1, 4, 2)),
            (
                "eth_getCode",
                json!(Bytes::from_static(b"fixture-registry")),
            ),
            ("eth_getBlockByNumber", header(0, 2, 0)),
            ("eth_getCode", json!("0x")),
            (
                "eth_getBlockByHash",
                json!({"transactions":[B256::repeat_byte(3)]}),
            ),
            ("eth_getTransactionReceipt", deployment_receipt),
            ("eth_getBlockByNumber", header(2, 5, 4)),
            ("eth_getBlockByNumber", header(2, 5, 4)),
            ("eth_getBlockByNumber", header(2, 5, 4)),
            (
                "eth_getCode",
                json!(Bytes::from_static(b"fixture-registry")),
            ),
            ("eth_call", json!(Bytes::from(U256::from(1).abi_encode()))),
            ("eth_call", json!(Bytes::from((head,).abi_encode_params()))),
            ("eth_getLogs", json!([])),
        ]
    }

    #[tokio::test]
    async fn startup_qualifies_independent_network_deployment_code_receipts_and_head() {
        let (primary, p) = fixture(startup_responses()).await;
        let (mut secondary, s) = fixture(startup_responses()).await;
        secondary.provider_identity = "fixture-independent-b".into();
        let trust = trust_fixture();
        let config = BaseDestinationConfig {
            publisher: Address::repeat_byte(5),
            ..Default::default()
        };
        let connection = BaseConnection {
            primary,
            secondary,
            config,
            trust,
        };
        let observed = connection
            .startup(Address::repeat_byte(5), Address::repeat_byte(1))
            .await
            .unwrap();
        assert_eq!(observed.block.number, 2);
        assert!(observed.head.registered);
        p.await.unwrap();
        s.await.unwrap();
    }

    #[tokio::test]
    async fn startup_rejects_wrong_network_before_any_signing() {
        let (primary, p) = fixture(vec![("eth_chainId", json!("0x1"))]).await;
        let (secondary, s) = fixture(vec![]).await;
        let connection = BaseConnection {
            primary,
            secondary,
            config: BaseDestinationConfig {
                publisher: Address::repeat_byte(5),
                ..Default::default()
            },
            trust: trust_fixture(),
        };
        assert!(
            connection
                .startup(Address::repeat_byte(5), Address::repeat_byte(1))
                .await
                .is_err()
        );
        p.await.unwrap();
        s.await.unwrap();
    }

    async fn fixture(
        responses: Vec<(&'static str, Value)>,
    ) -> (HttpRpc, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            for (method, result) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let request = loop {
                    let mut chunk = [0; 4096];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    assert!(bytes.len() <= 128 * 1024);
                    if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = std::str::from_utf8(&bytes[..index]).unwrap();
                        let length: usize = header
                            .lines()
                            .find_map(|l| {
                                let (name, value) = l.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap();
                        if bytes.len() >= index + 4 + length {
                            break serde_json::from_slice::<Value>(
                                &bytes[index + 4..index + 4 + length],
                            )
                            .unwrap();
                        }
                    }
                };
                assert_eq!(request["method"], method);
                let result = if let Some(expected) = result.get("_expected_params") {
                    assert_eq!(&request["params"], expected);
                    result["_result"].clone()
                } else {
                    result
                };
                let body = if result.get("_raw").is_some() {
                    result["_raw"].as_str().unwrap().to_owned()
                } else {
                    json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string()
                };
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(),body).as_bytes()).await.unwrap();
            }
        });
        let rpc = HttpRpc {
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            url: format!("http://{address}/synthetic-secret")
                .parse()
                .unwrap(),
            bearer: None,
            provider_identity: "fixture-independent-a".into(),
            policy: EndpointPolicy {
                allowed_hosts: BTreeSet::new(),
                timeout: Duration::from_secs(2),
                max_response_bytes: 64 * 1024,
                read_attempts: 1,
                #[cfg(all(feature = "test-support", debug_assertions))]
                test_loopback: None,
            },
            next_id: AtomicU64::new(1),
        };
        (rpc, task)
    }
    fn receipt(logs: Value, status: &str) -> Value {
        json!({"type":"0x2","transactionHash":B256::repeat_byte(3),"transactionIndex":"0x0",
                "blockHash":B256::repeat_byte(4),"blockNumber":"0xa","from":Address::repeat_byte(5),"to":Address::repeat_byte(6),
                "cumulativeGasUsed":"0x13880","gasUsed":"0x13880","effectiveGasPrice":"0xa","status":status,
                "logsBloom":format!("0x{}", "00".repeat(256)),"logs":logs,"contractAddress":null})
    }
    fn log() -> Value {
        let event = ECorpCheckpointRegistryV1::Anchored {
            streamId: B256::repeat_byte(7),
            sequence: 10,
            checkpointDigest: B256::repeat_byte(8),
            previousAnchorDigest: B256::ZERO,
            anchorOrdinal: 1,
            publisher: Address::repeat_byte(5),
        };
        let data = event.encode_log_data();
        json!({"address":Address::repeat_byte(6),"topics":data.topics(),"data":data.data,"blockHash":B256::repeat_byte(4),
                "blockNumber":"0xa","transactionHash":B256::repeat_byte(3),"transactionIndex":"0x0","logIndex":"0x0","removed":false})
    }
    #[tokio::test]
    async fn real_http_json_rpc_and_redacted_debug() {
        let (rpc, task) = fixture(vec![
            ("eth_chainId", json!("0x2105")),
            ("eth_getTransactionReceipt", receipt(json!([log()]), "0x1")),
        ])
        .await;
        assert_eq!(rpc.chain_id().await.unwrap(), 8453);
        assert!(!format!("{rpc:?}").contains("synthetic-secret"));
        let receipt = rpc.receipt(B256::repeat_byte(3)).await.unwrap().unwrap();
        let call = AnchorCall {
            stream_id: B256::repeat_byte(7),
            sequence: 10,
            checkpoint_digest: B256::repeat_byte(8),
            previous_anchor_digest: B256::ZERO,
        };
        assert_eq!(
            receipt
                .exact_event(Address::repeat_byte(6), &call, Address::repeat_byte(5))
                .unwrap()
                .ordinal,
            1
        );
        assert_eq!(receipt.cost().unwrap().total_wei, None);
        assert_eq!(receipt.cost().unwrap().execution_wei, U256::from(800_000));
        task.await.unwrap();
    }
    #[tokio::test]
    async fn duplicate_json_wrong_id_and_response_bounds_fail_closed() {
        for raw in [
            r#"{"jsonrpc":"2.0","id":1,"result":"0x2105","result":"0x1"}"#,
            r#"{"jsonrpc":"2.0","id":2,"result":"0x2105"}"#,
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"https://secret.invalid/token"},"result":"0x2105"}"#,
        ] {
            let (rpc, task) = fixture(vec![("eth_chainId", json!({"_raw":raw}))]).await;
            let error = rpc.chain_id().await.unwrap_err();
            assert!(!error.to_string().contains("secret.invalid"));
            task.await.unwrap();
        }
        let (mut rpc, task) = fixture(vec![("eth_chainId", json!("0x2105"))]).await;
        rpc.policy.max_response_bytes = 8;
        assert!(rpc.chain_id().await.is_err());
        task.await.unwrap();
    }
    #[test]
    fn receipts_reject_preconfirmations_reverts_noop_and_wrong_event() {
        let call = AnchorCall {
            stream_id: B256::repeat_byte(7),
            sequence: 10,
            checkpoint_digest: B256::repeat_byte(8),
            previous_anchor_digest: B256::ZERO,
        };
        let mut pending = receipt(json!([log()]), "0x1");
        pending["blockHash"] = Value::Null;
        assert!(ReceiptEvidence::parse(pending).is_err());
        for raw in [receipt(json!([log()]), "0x0"), receipt(json!([]), "0x1")] {
            assert!(
                ReceiptEvidence::parse(raw)
                    .unwrap()
                    .exact_event(Address::repeat_byte(6), &call, Address::repeat_byte(5))
                    .is_err()
            );
        }
        let mut wrong = log();
        wrong["blockHash"] = json!(B256::repeat_byte(9));
        assert!(
            ReceiptEvidence::parse(receipt(json!([wrong]), "0x1"))
                .unwrap()
                .exact_event(Address::repeat_byte(6), &call, Address::repeat_byte(5))
                .is_err()
        );
        let mut missing_fee = receipt(json!([]), "0x1");
        missing_fee["l1Fee"] = json!("not-wei");
        assert!(ReceiptEvidence::parse(missing_fee).is_err());
    }
    #[tokio::test]
    async fn logs_enforce_filter_and_adapt_only_bounded_ranges() {
        let (rpc, task) = fixture(vec![("eth_getLogs", json!([log()]))]).await;
        assert!(
            rpc.logs(Address::repeat_byte(9), B256::repeat_byte(7), 10, 10)
                .await
                .is_err()
        );
        assert!(
            rpc.logs(Address::repeat_byte(6), B256::repeat_byte(7), 0, 1000)
                .await
                .is_err()
        );
        task.await.unwrap();
    }
    #[tokio::test]
    async fn unknown_oracle_code_never_returns_fee_quote() {
        let (rpc, task) = fixture(vec![("eth_getCode", json!("0x1234"))]).await;
        let qualified = FeeOracleQualification {
            runtime_code_hash: B256::repeat_byte(9),
            implementation: None,
            qualification_id: "fixture-model".into(),
        };
        assert!(qualified.verify(&rpc, B256::repeat_byte(4)).await.is_err());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn production_endpoint_rejects_ssrf_and_no_cleartext_test_escape() {
        struct Secrets;
        #[async_trait]
        impl EndpointSecrets for Secrets {
            async fn resolve(&self, _: &str) -> Result<EndpointSecret> {
                Ok(EndpointSecret {
                    url: "http://127.0.0.1:1/token".into(),
                    bearer: None,
                })
            }
        }
        let policy = EndpointPolicy::production(BTreeSet::from(["127.0.0.1".into()]));
        assert!(
            HttpRpc::connect("secret/ref", "operator", &Secrets, policy)
                .await
                .is_err()
        );
    }
}
