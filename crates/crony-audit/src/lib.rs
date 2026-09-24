//! Portable state-audit protocol, independent of persistence and destinations.
mod history;
mod wire;
pub use wire::parse_json;
mod anchor;
pub use anchor::*;
mod archive;
pub use archive::*;
mod publication;
use anyhow::{Result, bail, ensure};
use ed25519_dalek::{Signature, Signer};
pub use ed25519_dalek::{SigningKey, VerifyingKey};
pub use history::*;
pub use publication::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_RECORD_BYTES: usize = 262_144;

/// RFC 8949 core deterministic CBOR over the protocol's JSON-compatible subset.
/// Floats are deliberately forbidden. Records use explicit nulls and fixed fields.
pub fn canonical(value: &impl Serialize) -> Result<Vec<u8>> {
    fn head(out: &mut Vec<u8>, major: u8, n: u64) {
        match n {
            0..=23 => out.push(major * 32 + n as u8),
            24..=255 => out.extend([major * 32 + 24, n as u8]),
            256..=65535 => {
                out.push(major * 32 + 25);
                out.extend((n as u16).to_be_bytes());
            }
            65536..=4294967295 => {
                out.push(major * 32 + 26);
                out.extend((n as u32).to_be_bytes());
            }
            _ => {
                out.push(major * 32 + 27);
                out.extend(n.to_be_bytes());
            }
        }
    }
    fn encode(v: &Value, out: &mut Vec<u8>, depth: usize) -> Result<()> {
        ensure!(
            depth < 32 && out.len() <= MAX_RECORD_BYTES,
            "audit record exceeds bounds"
        );
        match v {
            Value::Null => out.push(0xf6),
            Value::Bool(b) => out.push(if *b { 0xf5 } else { 0xf4 }),
            Value::Number(n) => {
                if let Some(n) = n.as_u64() {
                    head(out, 0, n);
                } else if let Some(n) = n.as_i64() {
                    head(out, 1, (-1_i128 - n as i128) as u64);
                } else {
                    bail!("floating-point audit metadata is forbidden");
                }
            }
            Value::String(s) => {
                head(out, 3, s.len() as u64);
                out.extend(s.as_bytes());
            }
            Value::Array(a) => {
                head(out, 4, a.len() as u64);
                for v in a {
                    encode(v, out, depth + 1)?;
                }
            }
            Value::Object(m) => {
                let mut entries = Vec::with_capacity(m.len());
                for (k, v) in m {
                    let mut key = Vec::new();
                    encode(&Value::String(k.clone()), &mut key, depth + 1)?;
                    entries.push((key, v));
                }
                entries.sort_by(|a, b| a.0.cmp(&b.0));
                head(out, 5, entries.len() as u64);
                for (key, v) in entries {
                    out.extend(key);
                    encode(v, out, depth + 1)?;
                }
            }
        }
        ensure!(out.len() <= MAX_RECORD_BYTES, "audit record exceeds bounds");
        Ok(())
    }
    let mut bytes = Vec::new();
    encode(&serde_json::to_value(value)?, &mut bytes, 0)?;
    Ok(bytes)
}

/// BLAKE3("ecorp.state-audit.v1\\0" || domain || "\\0" || bytes).
pub fn digest(domain: &str, bytes: &[u8]) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"ecorp.state-audit.v1\0");
    h.update(domain.as_bytes());
    h.update(b"\0");
    h.update(bytes);
    h.finalize().to_hex().to_string()
}

pub fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub protocol_version: u32,
    pub ledger_id: String,
    pub last_sequence: u64,
    pub last_row_hash: String,
    pub previous_checkpoint_digest: Option<String>,
    pub key_id: String,
}

impl Checkpoint {
    pub fn bytes(&self) -> Result<Vec<u8>> {
        ensure!(
            self.protocol_version == 1 && self.last_sequence > 0,
            "unsupported checkpoint"
        );
        let ledger = self.ledger_id.as_bytes();
        ensure!(
            ledger.len() == 36
                && ledger
                    .iter()
                    .enumerate()
                    .all(|(i, b)| if [8, 13, 18, 23].contains(&i) {
                        *b == b'-'
                    } else {
                        b.is_ascii_digit() || (b'a'..=b'f').contains(b)
                    })
                && ledger.iter().any(|b| *b != b'0' && *b != b'-')
                && self.key_id.len() <= 128
                && !self.key_id.is_empty(),
            "invalid checkpoint identity"
        );
        ensure!(
            valid_hash(&self.last_row_hash)
                && self
                    .previous_checkpoint_digest
                    .as_ref()
                    .is_none_or(|h| valid_hash(h)),
            "invalid checkpoint hash"
        );
        // Fixed array layout is part of the versioned protocol, not serde field order.
        canonical(&(
            self.protocol_version,
            &self.ledger_id,
            self.last_sequence,
            &self.last_row_hash,
            &self.previous_checkpoint_digest,
            &self.key_id,
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SignedCheckpoint {
    pub checkpoint: Checkpoint,
    pub payload: Vec<u8>,
    pub signature: Vec<u8>,
    pub digest: String,
}

impl SignedCheckpoint {
    pub fn validate_envelope(&self) -> Result<()> {
        ensure!(
            self.payload == self.checkpoint.bytes()? && self.signature.len() == 64,
            "invalid checkpoint envelope"
        );
        let mut committed = self.payload.clone();
        committed.extend(&self.signature);
        ensure!(
            self.digest == digest("checkpoint", &committed),
            "checkpoint digest mismatch"
        );
        Ok(())
    }
    pub fn sign(checkpoint: Checkpoint, key: &SigningKey) -> Result<Self> {
        let payload = checkpoint.bytes()?;
        let mut message = b"ecorp.state-audit.v1\0checkpoint-signature\0".to_vec();
        message.extend(&payload);
        let signature = key.sign(&message).to_bytes().to_vec();
        let mut committed = payload.clone();
        committed.extend(&signature);
        let digest = digest("checkpoint", &committed);
        Ok(Self {
            checkpoint,
            payload,
            signature,
            digest,
        })
    }

    pub fn verify(&self, key: &VerifyingKey, expected: Option<&str>) -> Result<()> {
        self.validate_envelope()?;
        let signature = Signature::from_slice(&self.signature)?;
        let mut message = b"ecorp.state-audit.v1\0checkpoint-signature\0".to_vec();
        message.extend(&self.payload);
        key.verify_strict(&message, &signature)?;
        ensure!(
            expected.is_none_or(|e| e == self.digest),
            "expected checkpoint differs (possible restore divergence)"
        );
        Ok(())
    }
}
