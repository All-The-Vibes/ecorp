use crate::{DecisionBundle, HistoryVerifier, SignedCheckpoint, VerifyingKey};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_ARCHIVE_ROWS: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TrustedSigningKey {
    pub key_id: String,
    pub public_key_hex: String,
    pub activated_sequence: u64,
    pub retired_sequence: Option<u64>,
}

impl TrustedSigningKey {
    pub fn verifying_key(&self) -> Result<VerifyingKey> {
        ensure!(
            !self.key_id.is_empty()
                && self.key_id.len() <= 128
                && self.activated_sequence > 0
                && self
                    .retired_sequence
                    .is_none_or(|retired| retired >= self.activated_sequence),
            "invalid signing-key history"
        );
        let bytes: [u8; 32] = hex::decode(&self.public_key_hex)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("audit public key must contain 32 bytes"))?;
        Ok(VerifyingKey::from_bytes(&bytes)?)
    }

    fn covers(&self, sequence: u64) -> bool {
        sequence >= self.activated_sequence
            && self.retired_sequence.is_none_or(|end| sequence <= end)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Archive {
    pub schema_version: u32,
    pub ledger_id: String,
    pub rows: Vec<DecisionBundle>,
    pub checkpoints: Vec<SignedCheckpoint>,
    #[serde(default)]
    pub signing_keys: Vec<TrustedSigningKey>,
    pub refs: BTreeMap<String, (String, u64)>,
}

impl Archive {
    fn verify_history_using<F>(&self, mut key_for: F) -> Result<HistoryVerifier>
    where
        F: FnMut(&SignedCheckpoint) -> Result<VerifyingKey>,
    {
        ensure!(
            self.schema_version == 1
                && !self.rows.is_empty()
                && self.rows.len() <= MAX_ARCHIVE_ROWS,
            "invalid archive bounds or schema"
        );
        ensure!(
            self.checkpoints.len() <= self.rows.len(),
            "too many checkpoints"
        );
        let mut v = HistoryVerifier::new(&self.ledger_id);
        let mut checkpoints = self.checkpoints.iter().peekable();
        for row in &self.rows {
            v.push(row)?;
            if checkpoints
                .peek()
                .is_some_and(|c| c.checkpoint.last_sequence == v.sequence())
            {
                let checkpoint = checkpoints.next().expect("peeked checkpoint");
                v.checkpoint(checkpoint, &key_for(checkpoint)?)?;
            }
        }
        ensure!(
            checkpoints.next().is_none(),
            "missing, unordered or uncovered checkpoint prefix"
        );
        ensure!(
            v.refs() == &self.refs,
            "export ref index disagrees with history"
        );
        Ok(v)
    }

    pub fn verify_history_with_key_history(
        &self,
        trusted: &[TrustedSigningKey],
    ) -> Result<HistoryVerifier> {
        ensure!(
            trusted == self.signing_keys,
            "archive signing-key history differs from trusted history"
        );
        let mut keys = BTreeMap::new();
        for (index, record) in trusted.iter().enumerate() {
            let key = record.verifying_key()?;
            ensure!(
                keys.insert(record.key_id.clone(), (record, key)).is_none(),
                "duplicate signing key id"
            );
            if let Some(previous) = index.checked_sub(1).and_then(|i| trusted.get(i)) {
                ensure!(
                    previous.retired_sequence == record.activated_sequence.checked_sub(1),
                    "signing-key history has a gap or overlap"
                );
            }
            ensure!(
                index + 1 < trusted.len() || record.retired_sequence.is_none(),
                "last signing key must remain active"
            );
        }
        self.verify_history_using(|checkpoint| {
            let (record, key) = keys
                .get(&checkpoint.checkpoint.key_id)
                .ok_or_else(|| anyhow::anyhow!("checkpoint signing key is not trusted"))?;
            ensure!(
                record.covers(checkpoint.checkpoint.last_sequence),
                "checkpoint lies outside signing-key activation range"
            );
            Ok(*key)
        })
    }

    pub fn verify_history(&self, key: &VerifyingKey) -> Result<HistoryVerifier> {
        if self.signing_keys.is_empty() {
            return self.verify_history_using(|_| Ok(*key));
        }
        ensure!(
            self.signing_keys.iter().all(|record| record
                .verifying_key()
                .is_ok_and(|candidate| candidate == *key)),
            "archive uses signing-key rotation; supply the trusted key history"
        );
        self.verify_history_with_key_history(&self.signing_keys)
    }
    pub fn verify(&self, key: &VerifyingKey, expected: Option<&str>) -> Result<()> {
        self.verify_history(key)?.finish(expected)
    }

    pub fn verify_with_key_history(
        &self,
        trusted: &[TrustedSigningKey],
        expected: Option<&str>,
    ) -> Result<()> {
        self.verify_history_with_key_history(trusted)?
            .finish(expected)
    }
}
