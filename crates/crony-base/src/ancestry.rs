//! Bounded, append-only continuation of provider-observed finalized ancestry.
use crate::{B256, Error, Result, config::identifier, rpc::SealedHeader};
use ConsensusHeader as Header;
pub use alloy::consensus::Header as ConsensusHeader;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_SEGMENT_HEADERS: usize = 512;

pub fn sealed_header(header: &Header) -> SealedHeader {
    SealedHeader {
        number: header.number,
        hash: header.hash_slow(),
        parent_hash: header.parent_hash,
        timestamp: header.timestamp,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AncestryBinding {
    pub manifest_digest: B256,
    pub chain_id: u64,
    pub transaction_hash: B256,
    pub provider_identity: String,
    pub included: SealedHeader,
    pub finalized: SealedHeader,
    pub observed_at: DateTime<Utc>,
}
impl AncestryBinding {
    pub fn key(&self) -> B256 {
        ancestry_key(
            self.manifest_digest,
            self.chain_id,
            self.transaction_hash,
            &self.provider_identity,
            self.included.hash,
        )
    }
    pub fn validate(&self) -> Result<()> {
        if self.manifest_digest.is_zero()
            || self.transaction_hash.is_zero()
            || !matches!(self.chain_id, 8453 | 84532)
            || !identifier(&self.provider_identity)
            || self.included.hash.is_zero()
            || self.finalized.hash.is_zero()
            || self.finalized.number < self.included.number
            || self.finalized.timestamp < self.included.timestamp
        {
            return Err(Error::Evidence("invalid retained ancestry binding"));
        }
        Ok(())
    }
}

pub fn ancestry_key(
    manifest: B256,
    chain: u64,
    transaction: B256,
    provider: &str,
    included: B256,
) -> B256 {
    let mut hash = blake3::Hasher::new();
    hash.update(b"ecorp-audit/retained-ancestry-key/v1\0");
    hash.update(manifest.as_slice());
    hash.update(&chain.to_be_bytes());
    hash.update(transaction.as_slice());
    hash.update(&(provider.len() as u64).to_be_bytes());
    hash.update(provider.as_bytes());
    hash.update(included.as_slice());
    B256::from(*hash.finalize().as_bytes())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AncestrySegment {
    pub binding: AncestryBinding,
    pub headers: Vec<Header>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AncestryState {
    pub binding: AncestryBinding,
    pub segments: u64,
    pub header_count: u64,
    pub next_hash: B256,
    pub next_number: u64,
    pub child_timestamp: u64,
    pub commitment: B256,
    pub complete: bool,
}
impl AncestryState {
    pub fn apply_segment(previous: Option<&Self>, segment: &AncestrySegment) -> Result<Self> {
        segment.binding.validate()?;
        if segment.headers.is_empty() || segment.headers.len() > MAX_SEGMENT_HEADERS {
            return Err(Error::Evidence("ancestry segment outside bounded window"));
        }
        let mut state = if let Some(previous) = previous {
            previous.validate()?;
            if previous.complete || previous.binding != segment.binding {
                return Err(Error::Evidence(
                    "ancestry append changed binding or completed proof",
                ));
            }
            previous.clone()
        } else {
            Self {
                binding: segment.binding.clone(),
                segments: 0,
                header_count: 0,
                next_hash: segment.binding.finalized.hash,
                next_number: segment.binding.finalized.number,
                child_timestamp: segment.binding.finalized.timestamp,
                commitment: segment.binding.key(),
                complete: false,
            }
        };
        for header in &segment.headers {
            if state.complete || header.extra_data.len() > 32 || header.gas_used > header.gas_limit
            {
                return Err(Error::Evidence(
                    "invalid or excessive retained consensus header",
                ));
            }
            let sealed = sealed_header(header);
            if sealed.hash != state.next_hash
                || sealed.number != state.next_number
                || sealed.timestamp > state.child_timestamp
            {
                return Err(Error::Evidence(
                    "retained ancestry hash, number, or timestamp discontinuity",
                ));
            }
            if state.header_count == 0 && sealed != state.binding.finalized {
                return Err(Error::Evidence(
                    "retained ancestry does not start at observed finalized header",
                ));
            }
            let mut commitment = blake3::Hasher::new();
            commitment.update(b"ecorp-audit/retained-ancestry-header/v1\0");
            commitment.update(state.commitment.as_slice());
            commitment.update(sealed.hash.as_slice());
            state.commitment = B256::from(*commitment.finalize().as_bytes());
            state.header_count = state
                .header_count
                .checked_add(1)
                .ok_or(Error::Evidence("ancestry count overflow"))?;
            if sealed.number == state.binding.included.number {
                if sealed != state.binding.included {
                    return Err(Error::Evidence(
                        "ancestry did not reach exact inclusion header",
                    ));
                }
                state.complete = true;
            } else {
                state.next_number = sealed
                    .number
                    .checked_sub(1)
                    .ok_or(Error::Evidence("ancestry crossed genesis"))?;
                state.next_hash = sealed.parent_hash;
                state.child_timestamp = sealed.timestamp;
            }
        }
        state.segments = state
            .segments
            .checked_add(1)
            .ok_or(Error::Evidence("ancestry segment count overflow"))?;
        state.validate()?;
        Ok(state)
    }
    pub fn validate(&self) -> Result<()> {
        self.binding.validate()?;
        let total = self
            .binding
            .finalized
            .number
            .checked_sub(self.binding.included.number)
            .and_then(|n| n.checked_add(1))
            .ok_or(Error::Evidence("ancestry range overflow"))?;
        if self.segments == 0
            || self.header_count == 0
            || self.header_count > total
            || self.segments > self.header_count
            || self.header_count > self.segments.saturating_mul(MAX_SEGMENT_HEADERS as u64)
            || self.complete != (self.header_count == total)
            || self.commitment.is_zero()
            || (!self.complete
                && (self.next_number != self.binding.finalized.number - self.header_count
                    || self.next_hash.is_zero()))
        {
            return Err(Error::Evidence("retained ancestry state is inconsistent"));
        }
        Ok(())
    }
}

/// Only an authoritative append-only evidence store may implement this interface.
/// Persist the complete segment and derived state atomically using `apply_segment`;
/// reject conflicting CAS, modified segments, or summary rows without retained evidence.
/// Never deserialize a caller-supplied state as trusted progress.
#[async_trait]
pub trait AncestryStore: Send + Sync {
    async fn load(&self, key: B256) -> Result<Option<AncestryState>>;
    async fn append(
        &self,
        key: B256,
        expected_segments: u64,
        segment: &AncestrySegment,
    ) -> Result<()>;
    async fn header(&self, key: B256, number: u64) -> Result<Option<Header>>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RetainedAncestry {
    pub key: B256,
    pub segments: u64,
    pub header_count: u64,
    pub commitment: B256,
}
impl RetainedAncestry {
    pub fn from_complete(state: &AncestryState) -> Result<Self> {
        state.validate()?;
        if !state.complete {
            return Err(Error::Evidence("retained ancestry incomplete"));
        }
        Ok(Self {
            key: state.binding.key(),
            segments: state.segments,
            header_count: state.header_count,
            commitment: state.commitment,
        })
    }
}
