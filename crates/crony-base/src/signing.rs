use crate::{
    Address, B256, Bytes, Error, Result, U256, abi::AnchorCall, config::identifier,
    fees::SpendingPolicy, manifest::ManifestTrust,
};
use alloy::{
    consensus::{TxEip1559, TxEnvelope},
    eips::eip2718::{Decodable2718, Encodable2718},
    primitives::{TxKind, keccak256},
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FrozenTransaction {
    pub chain_id: u64,
    pub sender: Address,
    pub contract: Address,
    pub nonce: u64,
    pub gas_limit: u64,
    #[serde(with = "crate::wei_u128")]
    pub max_fee_per_gas: u128,
    #[serde(with = "crate::wei_u128")]
    pub max_priority_fee_per_gas: u128,
    pub call: AnchorCall,
}
impl FrozenTransaction {
    pub fn unsigned(&self) -> Result<TxEip1559> {
        self.call.validate()?;
        if !matches!(self.chain_id, 8453 | 84532)
            || self.sender.is_zero()
            || self.contract.is_zero()
            || self.gas_limit < 21_000
            || self.max_fee_per_gas == 0
            || self.max_priority_fee_per_gas > self.max_fee_per_gas
            || self.nonce > i64::MAX as u64
        {
            return Err(Error::Signing("invalid frozen transaction"));
        }
        Ok(TxEip1559 {
            chain_id: self.chain_id,
            nonce: self.nonce,
            gas_limit: self.gas_limit,
            max_fee_per_gas: self.max_fee_per_gas,
            max_priority_fee_per_gas: self.max_priority_fee_per_gas,
            to: TxKind::Call(self.contract),
            value: U256::ZERO,
            access_list: Default::default(),
            input: self.call.calldata()?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SignRequest {
    pub attempt_id: Uuid,
    pub intent_id: Uuid,
    pub corp_id: Uuid,
    pub manifest_digest: B256,
    pub immutable_key_identity: String,
    pub transaction: FrozenTransaction,
}
impl SignRequest {
    pub fn validate(&self) -> Result<()> {
        if self.attempt_id.is_nil()
            || self.intent_id.is_nil()
            || self.corp_id.is_nil()
            || self.manifest_digest.is_zero()
            || !identifier(&self.immutable_key_identity)
            || self.immutable_key_identity.contains(":alias/")
        {
            return Err(Error::Signing("invalid immutable attempt identity"));
        }
        self.transaction.unsigned()?;
        Ok(())
    }
}

/// Raw signed bytes are a broadcast capability. Debug never prints those bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct SignedTransaction {
    raw: Bytes,
    hash: B256,
}
impl std::fmt::Debug for SignedTransaction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignedTransaction")
            .field("hash", &self.hash)
            .finish_non_exhaustive()
    }
}
impl SignedTransaction {
    pub fn validate(request: &SignRequest, raw: &[u8]) -> Result<Self> {
        request.validate()?;
        if raw.is_empty() || raw.len() > 4096 || raw[0] != 2 {
            return Err(Error::Signing(
                "only bounded EIP-1559 transactions permitted",
            ));
        }
        let mut remaining = raw;
        let envelope = TxEnvelope::decode_2718(&mut remaining)
            .map_err(|_| Error::Signing("malformed signed transaction"))?;
        if !remaining.is_empty() || envelope.encoded_2718() != raw {
            return Err(Error::Signing("noncanonical signed transaction"));
        }
        let TxEnvelope::Eip1559(signed) = envelope else {
            return Err(Error::Signing("wrong transaction type"));
        };
        if signed.tx() != &request.transaction.unsigned()?
            || signed
                .recover_signer()
                .map_err(|_| Error::Signing("invalid transaction signature"))?
                != request.transaction.sender
        {
            return Err(Error::Signing(
                "signed transaction differs from immutable attempt",
            ));
        }
        if signed.signature().normalize_s().is_some() {
            return Err(Error::Signing("high-s signature rejected"));
        }
        Ok(Self {
            raw: raw.to_vec().into(),
            hash: keccak256(raw),
        })
    }
    pub fn raw(&self) -> &[u8] {
        &self.raw
    }
    pub fn hash(&self) -> B256 {
        self.hash
    }
}

#[async_trait]
pub trait SigningGateway: Send + Sync {
    async fn identity(&self) -> Result<GatewayIdentity>;
    async fn journal_snapshot(&self, chain_id: u64, publisher: Address) -> Result<JournalSnapshot>;
    async fn sign(&self, request: &SignRequest) -> Result<SignedTransaction>;
    async fn lookup(&self, request: &SignRequest) -> Result<Option<SignedTransaction>>;
}

/// Implementations must be an independently administered durable store. No in-memory production fallback.
#[async_trait]
pub trait SigningJournal: Send + Sync {
    async fn snapshot(&self, chain_id: u64, publisher: Address) -> Result<JournalSnapshot>;
    /// Atomically insert the exact request, or reject reuse with different fields.
    async fn freeze(&self, request: &SignRequest) -> Result<()>;
    async fn lookup(&self, request: &SignRequest) -> Result<Option<SignedTransaction>>;
    /// Durably commit before returning. Concurrent signers return the already committed winner.
    async fn commit(
        &self,
        request: &SignRequest,
        signed: &SignedTransaction,
    ) -> Result<SignedTransaction>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GatewayIdentity {
    pub chain_id: u64,
    pub publisher: Address,
    pub immutable_key_identity: String,
}
impl GatewayIdentity {
    pub fn validate(&self) -> Result<()> {
        if !matches!(self.chain_id, 8453 | 84532)
            || self.publisher.is_zero()
            || !identifier(&self.immutable_key_identity)
            || self.immutable_key_identity.contains(":alias/")
        {
            return Err(Error::Signing(
                "gateway identity is not immutable and scoped",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct JournalSnapshot {
    pub epoch: String,
    pub cursor: i64,
    pub requests: Vec<SignRequest>,
    pub complete: bool,
}
impl JournalSnapshot {
    pub fn validate(&self, chain_id: u64, publisher: Address) -> Result<()> {
        if self.cursor < 0
            || !matches!(chain_id, 8453 | 84532)
            || publisher.is_zero()
            || self.requests.len() > 4096
        {
            return Err(Error::Signing("invalid journal snapshot bounds"));
        }
        let epoch = Uuid::parse_str(&self.epoch)
            .map_err(|_| Error::Signing("journal epoch missing or invalid"))?;
        if epoch.is_nil() || epoch.to_string() != self.epoch {
            return Err(Error::Signing("invalid journal epoch"));
        }
        let mut ids = std::collections::BTreeSet::new();
        for request in &self.requests {
            request.validate()?;
            if request.transaction.chain_id != chain_id
                || request.transaction.sender != publisher
                || !ids.insert(request.attempt_id)
            {
                return Err(Error::Signing("journal snapshot scope or attempt mismatch"));
            }
        }
        if self.cursor == 0 && !self.requests.is_empty() {
            return Err(Error::Signing(
                "journal cursor contradicts retained requests",
            ));
        }
        Ok(())
    }
}

pub struct AuthorizedAttempt {
    pub request: SignRequest,
    pub archive: crony_audit::Archive,
    pub retained_until: chrono::DateTime<chrono::Utc>,
    pub archive_receipt_digest: B256,
}

/// Read-only view of the currently authorized, reserved and frozen application attempt.
/// The implementation rechecks Corp, fence, nonce reservation, budget and archive authority.
#[async_trait]
pub trait IntentAuthorizer: Send + Sync {
    async fn authorize(&self, attempt_id: Uuid, corp_id: Uuid) -> Result<AuthorizedAttempt>;
}

#[async_trait]
pub trait NonExportableSigner: Send + Sync {
    fn address(&self) -> Address;
    fn immutable_key_identity(&self) -> &str;
    async fn sign_transaction(&self, transaction: TxEip1559) -> Result<Bytes>;
}

pub struct PolicyGateway<J, A, S> {
    journal: J,
    authorizer: A,
    signer: S,
    trust: ManifestTrust,
    policy: SpendingPolicy,
}
impl<J: SigningJournal, A: IntentAuthorizer, S: NonExportableSigner> PolicyGateway<J, A, S> {
    pub fn new(
        journal: J,
        authorizer: A,
        signer: S,
        trust: ManifestTrust,
        policy: SpendingPolicy,
    ) -> Result<Self> {
        policy.validate()?;
        if signer.address().is_zero() || !identifier(signer.immutable_key_identity()) {
            return Err(Error::Signing("unqualified signer identity"));
        }
        Ok(Self {
            journal,
            authorizer,
            signer,
            trust,
            policy,
        })
    }
    async fn authorize(&self, request: &SignRequest) -> Result<()> {
        request.validate()?;
        let m = &self.trust.current().manifest;
        let t = &request.transaction;
        if request.manifest_digest != self.trust.current().digest
            || t.chain_id != m.chain_id
            || t.contract != m.contract_address
            || t.call.stream_id != m.stream_id
            || t.sender != self.signer.address()
            || request.immutable_key_identity != self.signer.immutable_key_identity()
            || t.gas_limit > self.policy.max_gas
            || t.max_fee_per_gas > self.policy.max_fee_per_gas
            || t.max_priority_fee_per_gas > self.policy.max_priority_fee_per_gas
            || U256::from(t.gas_limit) * U256::from(t.max_fee_per_gas) > self.policy.max_attempt_fee
        {
            return Err(Error::Signing(
                "gateway destination, signer, or fee policy mismatch",
            ));
        }
        let approved = self
            .authorizer
            .authorize(request.attempt_id, request.corp_id)
            .await?;
        if approved.request != *request
            || approved.archive.schema_version != 1
            || approved.retained_until <= chrono::Utc::now()
            || approved.archive_receipt_digest.is_zero()
            || approved.archive.ledger_id != m.ledger_id
            || approved.archive.rows.is_empty()
            || approved.archive.rows.len() > crony_audit::MAX_ARCHIVE_ROWS
        {
            return Err(Error::Signing(
                "durable attempt or retained source authority mismatch",
            ));
        }
        let mut history = crony_audit::HistoryVerifier::new(&m.ledger_id);
        let mut checkpoints = approved.archive.checkpoints.iter().peekable();
        for row in &approved.archive.rows {
            history
                .push(row)
                .map_err(|_| Error::Signing("source history invalid"))?;
            if let Some(cp) = checkpoints.peek()
                && cp.checkpoint.last_sequence == history.sequence()
            {
                m.verify_checkpoint(cp)?;
                let key = m
                    .checkpoint_keys
                    .iter()
                    .find(|k| k.key_id == cp.checkpoint.key_id)
                    .ok_or(Error::Signing("source key unavailable"))?;
                let public = ed25519_dalek::VerifyingKey::from_bytes(&key.public_key)
                    .map_err(|_| Error::Signing("invalid source key"))?;
                history
                    .checkpoint(cp, &public)
                    .map_err(|_| Error::Signing("source checkpoint continuity invalid"))?;
                checkpoints.next();
            }
        }
        let cp = approved
            .archive
            .checkpoints
            .last()
            .ok_or(Error::Signing("source checkpoint missing"))?;
        if !t.call.previous_anchor_digest.is_zero()
            && !approved.archive.checkpoints.iter().any(|previous| {
                previous.checkpoint.last_sequence < t.call.sequence
                    && previous.digest == hex::encode(t.call.previous_anchor_digest)
            })
        {
            return Err(Error::Signing(
                "previous external anchor absent from retained checkpoint chain",
            ));
        }
        if checkpoints.next().is_some()
            || cp.checkpoint.last_sequence != t.call.sequence
            || history.sequence() != t.call.sequence
            || cp.digest != hex::encode(t.call.checkpoint_digest)
            || history.refs() != &approved.archive.refs
        {
            return Err(Error::Signing(
                "source does not establish exact intent coverage",
            ));
        }
        history
            .finish(Some(&cp.digest))
            .map_err(|_| Error::Signing("source checkpoint coverage incomplete"))?;
        Ok(())
    }
}
#[async_trait]
impl<J: SigningJournal, A: IntentAuthorizer, S: NonExportableSigner> SigningGateway
    for PolicyGateway<J, A, S>
{
    async fn identity(&self) -> Result<GatewayIdentity> {
        let identity = GatewayIdentity {
            chain_id: self.trust.current().manifest.chain_id,
            publisher: self.signer.address(),
            immutable_key_identity: self.signer.immutable_key_identity().into(),
        };
        identity.validate()?;
        Ok(identity)
    }
    async fn journal_snapshot(&self, chain_id: u64, publisher: Address) -> Result<JournalSnapshot> {
        let identity = self.identity().await?;
        if identity.chain_id != chain_id || identity.publisher != publisher {
            return Err(Error::Signing("journal wallet scope mismatch"));
        }
        let snapshot = self.journal.snapshot(chain_id, publisher).await?;
        snapshot.validate(chain_id, publisher)?;
        Ok(snapshot)
    }
    async fn sign(&self, request: &SignRequest) -> Result<SignedTransaction> {
        self.authorize(request).await?;
        self.journal.freeze(request).await?;
        if let Some(signed) = self.journal.lookup(request).await? {
            return Ok(signed);
        }
        let raw = self
            .signer
            .sign_transaction(request.transaction.unsigned()?)
            .await?;
        let signed = SignedTransaction::validate(request, &raw)?;
        self.journal.commit(request, &signed).await
    }
    async fn lookup(&self, request: &SignRequest) -> Result<Option<SignedTransaction>> {
        request.validate()?;
        self.journal.lookup(request).await
    }
}

/// Uses the separately administered schema in gateway-journal.sql, never the application database.
pub struct PostgresSigningJournal {
    pool: sqlx::PgPool,
}
impl PostgresSigningJournal {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }
}
fn journal_error(_: sqlx::Error) -> Error {
    Error::Signing("independent signing journal unavailable")
}
#[async_trait]
impl SigningJournal for PostgresSigningJournal {
    async fn snapshot(&self, chain_id: u64, publisher: Address) -> Result<JournalSnapshot> {
        if !matches!(chain_id, 8453 | 84532) || publisher.is_zero() {
            return Err(Error::Signing("invalid journal wallet scope"));
        }
        let mut tx = self.pool.begin().await.map_err(journal_error)?;
        // Serialize against request freezes; no lower sequence can become visible after this watermark.
        sqlx::query("SELECT pg_advisory_xact_lock(721080512521)")
            .execute(&mut *tx)
            .await
            .map_err(journal_error)?;
        let epoch: Uuid =
            sqlx::query_scalar("SELECT epoch FROM base_gateway_identity WHERE singleton")
                .fetch_one(&mut *tx)
                .await
                .map_err(journal_error)?;
        let cursor: i64 = sqlx::query_scalar(
            "SELECT COALESCE(max(journal_cursor),0)::bigint FROM base_gateway_attempts",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(journal_error)?;
        let values: Vec<serde_json::Value> = sqlx::query_scalar("SELECT request FROM base_gateway_attempts WHERE request->'transaction'->'chain_id'=$1::jsonb AND request->'transaction'->'sender'=$2::jsonb ORDER BY journal_cursor LIMIT 4097")
            .bind(serde_json::json!(chain_id)).bind(serde_json::json!(publisher)).fetch_all(&mut *tx).await.map_err(journal_error)?;
        let complete = values.len() <= 4096;
        let requests = values
            .into_iter()
            .take(4096)
            .map(|value| {
                serde_json::from_value(value)
                    .map_err(|_| Error::Signing("retained journal request invalid"))
            })
            .collect::<Result<Vec<_>>>()?;
        let snapshot = JournalSnapshot {
            epoch: epoch.to_string(),
            cursor,
            requests,
            complete,
        };
        snapshot.validate(chain_id, publisher)?;
        tx.commit().await.map_err(journal_error)?;
        Ok(snapshot)
    }
    async fn freeze(&self, request: &SignRequest) -> Result<()> {
        request.validate()?;
        let value =
            serde_json::to_value(request).map_err(|_| Error::Signing("request encoding failed"))?;
        let mut tx = self.pool.begin().await.map_err(journal_error)?;
        sqlx::query("SELECT pg_advisory_xact_lock(721080512521)")
            .execute(&mut *tx)
            .await
            .map_err(journal_error)?;
        sqlx::query("SET LOCAL synchronous_commit = on")
            .execute(&mut *tx)
            .await
            .map_err(journal_error)?;
        sqlx::query("INSERT INTO base_gateway_attempts(attempt_id, request) VALUES($1,$2) ON CONFLICT (attempt_id) DO NOTHING")
            .bind(request.attempt_id).bind(&value).execute(&mut *tx).await.map_err(journal_error)?;
        let stored: serde_json::Value =
            sqlx::query_scalar("SELECT request FROM base_gateway_attempts WHERE attempt_id=$1")
                .bind(request.attempt_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(journal_error)?;
        if stored != value {
            return Err(Error::Signing("attempt ID reused with changed fields"));
        }
        tx.commit().await.map_err(journal_error)?;
        Ok(())
    }

    async fn lookup(&self, request: &SignRequest) -> Result<Option<SignedTransaction>> {
        use sqlx::Row;
        let row = sqlx::query("SELECT a.request, r.raw_transaction FROM base_gateway_attempts a LEFT JOIN base_gateway_results r USING(attempt_id) WHERE a.attempt_id=$1")
            .bind(request.attempt_id).fetch_optional(&self.pool).await.map_err(journal_error)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let stored: serde_json::Value = row.try_get("request").map_err(journal_error)?;
        if serde_json::to_value(request).map_err(|_| Error::Signing("request encoding failed"))?
            != stored
        {
            return Err(Error::Signing("attempt ID reused with changed fields"));
        }
        let raw: Option<Vec<u8>> = row.try_get("raw_transaction").map_err(journal_error)?;
        raw.map(|r| SignedTransaction::validate(request, &r))
            .transpose()
    }
    async fn commit(
        &self,
        request: &SignRequest,
        signed: &SignedTransaction,
    ) -> Result<SignedTransaction> {
        self.freeze(request).await?;
        SignedTransaction::validate(request, signed.raw())?;
        let mut tx = self.pool.begin().await.map_err(journal_error)?;
        sqlx::query("SET LOCAL synchronous_commit = on")
            .execute(&mut *tx)
            .await
            .map_err(journal_error)?;
        sqlx::query("INSERT INTO base_gateway_results(attempt_id, raw_transaction, transaction_hash) VALUES($1,$2,$3) ON CONFLICT(attempt_id) DO NOTHING")
            .bind(request.attempt_id).bind(signed.raw()).bind(signed.hash().as_slice()).execute(&mut *tx).await.map_err(journal_error)?;
        let raw: Vec<u8> = sqlx::query_scalar(
            "SELECT raw_transaction FROM base_gateway_results WHERE attempt_id=$1",
        )
        .bind(request.attempt_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(journal_error)?;
        let winner = SignedTransaction::validate(request, &raw)?;
        tx.commit().await.map_err(journal_error)?;
        Ok(winner)
    }
}
