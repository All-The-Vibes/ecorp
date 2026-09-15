//! Destination-neutral compatibility model, not an Ethereum transaction client.
use crate::{SignedCheckpoint, valid_hash};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnchorCommitment {
    pub ledger_id: String,
    pub last_sequence: u64,
    pub checkpoint_digest: String,
    pub previous_anchor_digest: Option<String>,
}
impl AnchorCommitment {
    pub fn from_checkpoint(
        checkpoint: &SignedCheckpoint,
        previous_anchor_digest: Option<String>,
    ) -> Result<Self> {
        checkpoint.validate_envelope()?;
        ensure!(
            previous_anchor_digest
                .as_ref()
                .is_none_or(|h| valid_hash(h)),
            "invalid prior anchor digest"
        );
        Ok(Self {
            ledger_id: checkpoint.checkpoint.ledger_id.clone(),
            last_sequence: checkpoint.checkpoint.last_sequence,
            checkpoint_digest: checkpoint.digest.clone(),
            previous_anchor_digest,
        })
    }
}
/// Returns false for an identical retry. Authority/registration are a contract
/// responsibility and are deliberately not simulated by this format model.
pub fn validate_anchor_progression(
    previous: Option<&AnchorCommitment>,
    next: &AnchorCommitment,
) -> Result<bool> {
    ensure!(
        next.last_sequence > 0 && valid_hash(&next.checkpoint_digest),
        "invalid anchor commitment"
    );
    if let Some(previous) = previous {
        ensure!(
            previous.ledger_id == next.ledger_id,
            "foreign ledger anchor"
        );
        if previous == next {
            return Ok(false);
        }
        ensure!(
            next.last_sequence > previous.last_sequence
                && next.previous_anchor_digest.as_ref() == Some(&previous.checkpoint_digest),
            "anchor conflict or broken external continuity"
        );
    } else {
        ensure!(
            next.previous_anchor_digest.is_none(),
            "genesis anchor must be explicit"
        );
    }
    Ok(true)
}
