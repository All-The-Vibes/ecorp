use crate::{
    Address, B256, Error, Result,
    abi::stream_id,
    config::{Assurance, identifier},
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

const SIGN_DOMAIN: &[u8] = b"ecorp-audit/destination-manifest-signature/v1\0";
const DIGEST_DOMAIN: &[u8] = b"ecorp-audit/destination-manifest-digest/v1\0";
const ROTATION_DOMAIN: &[u8] = b"ecorp-audit/destination-manifest-rotation-countersignature/v1\0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BlockIdentity {
    pub number: u64,
    pub hash: B256,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NetworkIdentity {
    pub genesis_hash: B256,
    pub checkpoint: Option<BlockIdentity>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CheckpointKey {
    pub key_id: String,
    pub public_key: [u8; 32],
    pub first_sequence: u64,
    pub last_sequence: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DestinationIdentity {
    pub chain_id: u64,
    pub contract: Address,
    pub stream_id: B256,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AnchorIdentity {
    pub sequence: u64,
    pub checkpoint_digest: B256,
    pub transaction_hash: B256,
    pub log_index: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Migration {
    pub old_destination: DestinationIdentity,
    pub last_verified_anchor: AnchorIdentity,
    pub incident_event: Option<AnchorIdentity>,
    pub first_new_checkpoint: B256,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DestinationManifestV1 {
    pub schema_version: u32,
    pub customer_trust_id: B256,
    pub manifest_version: u64,
    pub previous_manifest_digest: Option<B256>,
    pub ledger_id: String,
    pub chain_id: u64,
    pub network_identity: NetworkIdentity,
    pub contract_address: Address,
    pub contract_version: u32,
    pub runtime_code_hash: B256,
    pub deployment_block_hash: B256,
    pub deployment_block_number: u64,
    pub stream_id: B256,
    pub registering_owner: Address,
    pub local_stream_key: B256,
    pub checkpoint_keys: Vec<CheckpointKey>,
    pub assurance_policy: Assurance,
    pub evidence_retention_policy: String,
    pub migration: Option<Migration>,
    pub next_manifest_authority: Option<[u8; 32]>,
}

impl DestinationManifestV1 {
    pub fn identity(&self) -> DestinationIdentity {
        DestinationIdentity {
            chain_id: self.chain_id,
            contract: self.contract_address,
            stream_id: self.stream_id,
        }
    }
    pub fn validate(&self) -> Result<()> {
        let bad = Error::Trust("invalid manifest fields");
        if self.schema_version != 1
            || self.manifest_version == 0
            || self.manifest_version > i64::MAX as u64
            || self.customer_trust_id.is_zero()
            || !matches!(self.chain_id, 8453 | 84532)
            || self.contract_version != 1
            || self.contract_address.is_zero()
            || self.registering_owner.is_zero()
            || self.runtime_code_hash.is_zero()
            || self.deployment_block_hash.is_zero()
            || self.local_stream_key.is_zero()
            || self.deployment_block_number > i64::MAX as u64
            || self.network_identity.genesis_hash.is_zero()
            || self
                .network_identity
                .checkpoint
                .as_ref()
                .is_some_and(|c| c.hash.is_zero() || c.number > i64::MAX as u64)
            || self.stream_id != stream_id(self.registering_owner, self.local_stream_key)
            || !identifier(&self.evidence_retention_policy)
            || self.checkpoint_keys.is_empty()
            || self.checkpoint_keys.len() > 128
            || self.previous_manifest_digest.is_some_and(|h| h.is_zero())
        {
            return Err(bad);
        }
        let ledger = uuid::Uuid::parse_str(&self.ledger_id)
            .map_err(|_| Error::Trust("invalid ledger ID"))?;
        if ledger.is_nil() || ledger.to_string() != self.ledger_id {
            return Err(bad);
        }
        let mut previous_id: Option<&str> = None;
        for key in &self.checkpoint_keys {
            if !identifier(&key.key_id)
                || key.first_sequence == 0
                || key.first_sequence > i64::MAX as u64
                || key
                    .last_sequence
                    .is_some_and(|s| s < key.first_sequence || s > i64::MAX as u64)
                || previous_id.is_some_and(|p| p >= key.key_id.as_str())
            {
                return Err(Error::Trust(
                    "keys must be sorted, unique and sequence-bounded",
                ));
            }
            verify_key(&key.public_key)?;
            previous_id = Some(&key.key_id);
        }
        if let Some(key) = self.next_manifest_authority {
            verify_key(&key)?;
        }
        if let Some(m) = &self.migration {
            if m.old_destination.contract.is_zero()
                || m.old_destination.stream_id.is_zero()
                || m.old_destination.chain_id == 0
                || m.first_new_checkpoint.is_zero()
                || m.old_destination == self.identity()
            {
                return Err(Error::Trust("invalid migration"));
            }
            validate_anchor(&m.last_verified_anchor)?;
            if let Some(incident) = &m.incident_event {
                validate_anchor(incident)?;
            }
        }
        Ok(())
    }

    /// Frozen V1 fixed array layout, deterministic shortest CBOR, explicit nulls.
    /// Addresses, hashes, keys are byte strings, never hex text or arrays of integers.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut c = Cbor(Vec::new());
        c.array(20);
        c.uint(self.schema_version.into());
        c.bytes(self.customer_trust_id.as_slice());
        c.uint(self.manifest_version);
        c.opt(self.previous_manifest_digest.as_ref(), |c, h| {
            c.bytes(h.as_slice())
        });
        c.text(&self.ledger_id);
        c.uint(self.chain_id);
        c.array(2);
        c.bytes(self.network_identity.genesis_hash.as_slice());
        c.opt(self.network_identity.checkpoint.as_ref(), |c, b| {
            c.array(2);
            c.uint(b.number);
            c.bytes(b.hash.as_slice());
        });
        c.bytes(self.contract_address.as_slice());
        c.uint(self.contract_version.into());
        c.bytes(self.runtime_code_hash.as_slice());
        c.bytes(self.deployment_block_hash.as_slice());
        c.uint(self.deployment_block_number);
        c.bytes(self.stream_id.as_slice());
        c.bytes(self.registering_owner.as_slice());
        c.bytes(self.local_stream_key.as_slice());
        c.array(self.checkpoint_keys.len() as u64);
        for key in &self.checkpoint_keys {
            c.array(4);
            c.text(&key.key_id);
            c.bytes(&key.public_key);
            c.uint(key.first_sequence);
            c.opt(key.last_sequence.as_ref(), |c, n| c.uint(*n));
        }
        c.text(match self.assurance_policy {
            Assurance::ProviderObservedFinalized => "provider-observed-finalized",
            Assurance::IndependentlyDerivedFinalized => "independently-derived-finalized",
        });
        c.text(&self.evidence_retention_policy);
        c.opt(self.migration.as_ref(), |c, m| {
            c.array(4);
            c.array(3);
            c.uint(m.old_destination.chain_id);
            c.bytes(m.old_destination.contract.as_slice());
            c.bytes(m.old_destination.stream_id.as_slice());
            c.anchor(&m.last_verified_anchor);
            c.opt(m.incident_event.as_ref(), |c, a| c.anchor(a));
            c.bytes(m.first_new_checkpoint.as_slice());
        });
        c.opt(self.next_manifest_authority.as_ref(), |c, k| c.bytes(k));
        Ok(c.0)
    }

    pub fn verify_checkpoint(&self, checkpoint: &crony_audit::SignedCheckpoint) -> Result<()> {
        self.validate()?;
        if checkpoint.checkpoint.ledger_id != self.ledger_id {
            return Err(Error::Evidence("checkpoint ledger mismatch"));
        }
        let seq = checkpoint.checkpoint.last_sequence;
        let key = self
            .checkpoint_keys
            .iter()
            .find(|k| {
                k.key_id == checkpoint.checkpoint.key_id
                    && seq >= k.first_sequence
                    && seq <= k.last_sequence.unwrap_or(i64::MAX as u64)
            })
            .ok_or(Error::Evidence("checkpoint key not authorized at sequence"))?;
        checkpoint
            .verify(&verify_key(&key.public_key)?, None)
            .map_err(|_| Error::Evidence("checkpoint signature or envelope invalid"))
    }
}

fn validate_anchor(a: &AnchorIdentity) -> Result<()> {
    if a.sequence == 0
        || a.sequence > i64::MAX as u64
        || a.checkpoint_digest.is_zero()
        || a.transaction_hash.is_zero()
        || a.log_index > i64::MAX as u64
    {
        return Err(Error::Trust("invalid migration anchor"));
    }
    Ok(())
}
fn verify_key(bytes: &[u8; 32]) -> Result<VerifyingKey> {
    let key =
        VerifyingKey::from_bytes(bytes).map_err(|_| Error::Trust("invalid Ed25519 authority"))?;
    if key.is_weak() {
        return Err(Error::Trust("weak Ed25519 authority"));
    }
    Ok(key)
}
fn message(domain: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(domain.len() + bytes.len());
    m.extend(domain);
    m.extend(bytes);
    m
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SignedManifest {
    pub manifest: DestinationManifestV1,
    pub canonical: Vec<u8>,
    pub signature: Vec<u8>,
    pub digest: B256,
    pub successor_countersignature: Option<Vec<u8>>,
}

impl SignedManifest {
    /// Offline administrative utility, not an unattended signing path.
    pub fn sign(
        manifest: DestinationManifestV1,
        authority: &SigningKey,
        successor: Option<&SigningKey>,
    ) -> Result<Self> {
        let canonical = manifest.canonical_bytes()?;
        let signature = authority
            .sign(&message(SIGN_DOMAIN, &canonical))
            .to_bytes()
            .to_vec();
        let mut committed = canonical.clone();
        committed.extend(&signature);
        let digest = B256::from(*blake3::hash(&message(DIGEST_DOMAIN, &committed)).as_bytes());
        let successor_countersignature = match (manifest.next_manifest_authority, successor) {
            (Some(k), Some(s)) if k == s.verifying_key().to_bytes() => Some(
                s.sign(&message(ROTATION_DOMAIN, &committed))
                    .to_bytes()
                    .to_vec(),
            ),
            (None, None) => None,
            _ => return Err(Error::Trust("matching successor countersignature required")),
        };
        Ok(Self {
            manifest,
            canonical,
            signature,
            digest,
            successor_countersignature,
        })
    }
    pub fn verify(&self, authority: &[u8; 32]) -> Result<()> {
        if self.canonical.len() > 65_536
            || self.signature.len() != 64
            || self.canonical != self.manifest.canonical_bytes()?
        {
            return Err(Error::Trust("noncanonical manifest envelope"));
        }
        let signature = Signature::from_slice(&self.signature)
            .map_err(|_| Error::Trust("invalid manifest signature"))?;
        verify_key(authority)?
            .verify_strict(&message(SIGN_DOMAIN, &self.canonical), &signature)
            .map_err(|_| Error::Trust("manifest signature rejected"))?;
        let mut committed = self.canonical.clone();
        committed.extend(&self.signature);
        if self.digest != B256::from(*blake3::hash(&message(DIGEST_DOMAIN, &committed)).as_bytes())
        {
            return Err(Error::Trust("manifest digest mismatch"));
        }
        match (
            self.manifest.next_manifest_authority,
            &self.successor_countersignature,
        ) {
            (Some(next), Some(sig)) => {
                if next == *authority {
                    return Err(Error::Trust("rotation must change authority"));
                }
                verify_key(&next)?
                    .verify_strict(
                        &message(ROTATION_DOMAIN, &committed),
                        &Signature::from_slice(sig)
                            .map_err(|_| Error::Trust("invalid countersignature"))?,
                    )
                    .map_err(|_| Error::Trust("successor countersignature rejected"))?;
            }
            (None, None) => {}
            _ => return Err(Error::Trust("successor countersignature required")),
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TrustPin {
    pub authority: [u8; 32],
    pub initial_manifest_digest: B256,
}

/// Retain this state independently of imported evidence. No Deserialize: replay from the pinned chain.
#[derive(Debug, Clone)]
pub struct ManifestTrust {
    authority: [u8; 32],
    current: SignedManifest,
}
impl ManifestTrust {
    pub fn bootstrap(pin: &TrustPin, initial: &SignedManifest) -> Result<Self> {
        initial.verify(&pin.authority)?;
        if initial.digest != pin.initial_manifest_digest
            || initial.manifest.previous_manifest_digest.is_some()
        {
            return Err(Error::Trust(
                "manifest does not match independently pinned root",
            ));
        }
        Ok(Self {
            authority: initial
                .manifest
                .next_manifest_authority
                .unwrap_or(pin.authority),
            current: initial.clone(),
        })
    }
    pub fn current(&self) -> &SignedManifest {
        &self.current
    }
    pub fn advance(&mut self, next: &SignedManifest) -> Result<()> {
        next.verify(&self.authority)?;
        let old = &self.current.manifest;
        let new = &next.manifest;
        if new.manifest_version <= old.manifest_version
            || new.previous_manifest_digest != Some(self.current.digest)
            || new.customer_trust_id != old.customer_trust_id
            || new.ledger_id != old.ledger_id
        {
            return Err(Error::Trust(
                "manifest rollback, fork, or trust identity change",
            ));
        }
        if new.identity() != old.identity()
            && new
                .migration
                .as_ref()
                .is_none_or(|m| m.old_destination != old.identity())
        {
            return Err(Error::Trust("destination change requires linked migration"));
        }
        if new.identity() == old.identity()
            && (new.network_identity.genesis_hash != old.network_identity.genesis_hash
                || new.runtime_code_hash != old.runtime_code_hash
                || new.deployment_block_hash != old.deployment_block_hash
                || new.deployment_block_number != old.deployment_block_number
                || new.registering_owner != old.registering_owner
                || new.local_stream_key != old.local_stream_key)
        {
            return Err(Error::Trust("immutable destination changed"));
        }
        for old_key in &old.checkpoint_keys {
            let new_key = new
                .checkpoint_keys
                .iter()
                .find(|k| k.key_id == old_key.key_id)
                .ok_or(Error::Trust("historical checkpoint key removed"))?;
            if old_key.public_key != new_key.public_key
                || old_key.first_sequence != new_key.first_sequence
                || old_key
                    .last_sequence
                    .is_some_and(|end| new_key.last_sequence != Some(end))
            {
                return Err(Error::Trust("historical key authority rewritten"));
            }
        }
        self.authority = new.next_manifest_authority.unwrap_or(self.authority);
        self.current = next.clone();
        Ok(())
    }
    pub fn require_current(&self, version: u64, digest: B256) -> Result<()> {
        if self.current.manifest.manifest_version != version || self.current.digest != digest {
            return Err(Error::Trust("current-authorization pin mismatch"));
        }
        Ok(())
    }
}

struct Cbor(Vec<u8>);
impl Cbor {
    fn head(&mut self, major: u8, n: u64) {
        match n {
            0..=23 => self.0.push(major * 32 + n as u8),
            24..=255 => self.0.extend([major * 32 + 24, n as u8]),
            256..=65535 => {
                self.0.push(major * 32 + 25);
                self.0.extend((n as u16).to_be_bytes());
            }
            65536..=4294967295 => {
                self.0.push(major * 32 + 26);
                self.0.extend((n as u32).to_be_bytes());
            }
            _ => {
                self.0.push(major * 32 + 27);
                self.0.extend(n.to_be_bytes());
            }
        }
    }
    fn array(&mut self, n: u64) {
        self.head(4, n);
    }
    fn uint(&mut self, n: u64) {
        self.head(0, n);
    }
    fn bytes(&mut self, b: &[u8]) {
        self.head(2, b.len() as u64);
        self.0.extend(b);
    }
    fn text(&mut self, s: &str) {
        self.head(3, s.len() as u64);
        self.0.extend(s.as_bytes());
    }
    fn opt<T>(&mut self, v: Option<&T>, f: impl FnOnce(&mut Self, &T)) {
        match v {
            Some(v) => f(self, v),
            None => self.0.push(0xf6),
        }
    }
    fn anchor(&mut self, a: &AnchorIdentity) {
        self.array(4);
        self.uint(a.sequence);
        self.bytes(a.checkpoint_digest.as_slice());
        self.bytes(a.transaction_hash.as_slice());
        self.uint(a.log_index);
    }
}
