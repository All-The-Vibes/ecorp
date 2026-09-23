use anyhow::{Context, Result, ensure};
use clap::Args;
use crony_audit::{Archive, HistoryVerifier, VerifyingKey};
use crony_base::{
    B256,
    manifest::{ManifestTrust, SignedManifest, TrustPin},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Args)]
pub struct BaseVerifyArgs {
    pub archive: PathBuf,
    #[arg(long)]
    pub manifests: PathBuf,
    #[arg(long)]
    pub trust_pin: PathBuf,
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
    pub expected_manifest_version: u64,
    #[arg(long)]
    pub expected_manifest_digest: B256,
    #[arg(long)]
    pub expected_checkpoint: B256,
}

fn read_json<T: DeserializeOwned>(path: &Path, bound: u64) -> Result<T> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .context("open offline verification input")?
        .take(bound + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= bound,
        "offline verification input exceeds bound"
    );
    crony_audit::parse_json(&bytes)
}

pub fn run(args: BaseVerifyArgs) -> Result<Value> {
    let archive: Archive = read_json(&args.archive, crony_audit::MAX_ARCHIVE_BYTES)?;
    let manifests: Vec<SignedManifest> =
        read_json(&args.manifests, crony_audit::MAX_ARCHIVE_BYTES)?;
    let pin: TrustPin = read_json(&args.trust_pin, crony_audit::MAX_RECORD_BYTES as u64)?;
    verify(
        &archive,
        &manifests,
        &pin,
        args.expected_manifest_version,
        args.expected_manifest_digest,
        args.expected_checkpoint,
    )
}

fn verify(
    archive: &Archive,
    manifests: &[SignedManifest],
    pin: &TrustPin,
    expected_version: u64,
    expected_manifest: B256,
    expected_checkpoint: B256,
) -> Result<Value> {
    ensure!(
        !manifests.is_empty() && manifests.len() <= 128,
        "invalid manifest chain bounds"
    );
    let mut trust = ManifestTrust::bootstrap(pin, &manifests[0])?;
    for manifest in &manifests[1..] {
        trust.advance(manifest)?;
    }
    trust.require_current(expected_version, expected_manifest)?;
    let manifest = &trust.current().manifest;
    ensure!(
        archive.schema_version == 1
            && !archive.rows.is_empty()
            && archive.rows.len() <= crony_audit::MAX_ARCHIVE_ROWS
            && !archive.checkpoints.is_empty()
            && archive.checkpoints.len() <= archive.rows.len(),
        "invalid archive bounds or schema"
    );
    let covering = archive
        .checkpoints
        .last()
        .context("missing covering checkpoint")?;
    ensure!(
        covering.digest.parse::<B256>()? == expected_checkpoint,
        "archive does not contain the separately expected covering checkpoint"
    );
    let mut history = HistoryVerifier::new(&archive.ledger_id);
    let mut checkpoints = archive.checkpoints.iter().peekable();
    for row in &archive.rows {
        history.push(row)?;
        if checkpoints
            .peek()
            .is_some_and(|cp| cp.checkpoint.last_sequence == history.sequence())
        {
            let checkpoint = checkpoints.next().context("missing checkpoint")?;
            manifest.verify_checkpoint(checkpoint)?;
            let key = manifest
                .checkpoint_keys
                .iter()
                .find(|key| key.key_id == checkpoint.checkpoint.key_id)
                .context("checkpoint key is absent from trusted manifest")?;
            history.checkpoint(checkpoint, &VerifyingKey::from_bytes(&key.public_key)?)?;
        }
    }
    ensure!(
        checkpoints.next().is_none(),
        "missing, unordered or uncovered intermediate checkpoints"
    );
    ensure!(
        history.refs() == &archive.refs,
        "archive ref index differs from verified history"
    );
    history.finish(Some(&covering.digest))?;
    Ok(json!({
        "checkpoint_verified": true,
        "ledger_id": archive.ledger_id,
        "last_sequence": history.sequence(),
        "checkpoint_digest": covering.digest,
        "manifest_version": expected_version,
        "manifest_digest": expected_manifest,
        "chain_assurance": crony_base::rpc::OFFLINE_ASSURANCE,
        "chain_inclusion_verified": false,
        "chain_finality_verified": false,
        "freshness": "matches supplied pins; current public-chain head not queried",
        "prior_to_baseline": "not attested",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crony_audit::SigningKey;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fixture {
        archive: Archive,
        manifests: Vec<SignedManifest>,
        trust_pin: TrustPin,
        current_version: u64,
        current_digest: B256,
        checkpoint_digest: String,
    }

    impl Fixture {
        fn load() -> Self {
            crony_audit::parse_json(include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../crony-base/vectors/full-history-v1.json"
            )))
            .unwrap()
        }

        fn verify(&self) -> Result<Value> {
            verify(
                &self.archive,
                &self.manifests,
                &self.trust_pin,
                self.current_version,
                self.current_digest,
                self.checkpoint_digest.parse()?,
            )
        }
    }

    #[test]
    fn base_v2_offline_complete_rotated_history_has_no_chain_assurance() {
        let fixture = Fixture::load();
        let result = fixture.verify().unwrap();
        assert_eq!(result["checkpoint_verified"], true);
        assert_eq!(result["last_sequence"], 2);
        assert_eq!(result["manifest_version"], 3);
        assert_eq!(result["checkpoint_digest"], fixture.checkpoint_digest);
        assert_eq!(
            result["chain_assurance"],
            crony_base::rpc::OFFLINE_ASSURANCE
        );
        assert_eq!(result["chain_inclusion_verified"], false);
        assert_eq!(result["chain_finality_verified"], false);
        assert_eq!(result["prior_to_baseline"], "not attested");
    }

    #[test]
    fn base_v2_offline_rejects_missing_and_tampered_history() {
        let mut fixture = Fixture::load();
        fixture.archive.rows[0].objects[0].bytes[0] ^= 1;
        assert!(fixture.verify().is_err(), "tampered object bytes");

        let mut fixture = Fixture::load();
        fixture.archive.rows[0].objects.clear();
        assert!(fixture.verify().is_err(), "missing historical objects");

        let mut fixture = Fixture::load();
        fixture.archive.rows.remove(0);
        assert!(fixture.verify().is_err(), "missing baseline");

        let mut fixture = Fixture::load();
        fixture.archive.checkpoints.remove(0);
        assert!(fixture.verify().is_err(), "missing intermediate checkpoint");

        let mut fixture = Fixture::load();
        fixture.archive.checkpoints[0].signature[0] ^= 1;
        assert!(fixture.verify().is_err(), "tampered intermediate signature");

        let mut fixture = Fixture::load();
        fixture.archive.checkpoints.swap(0, 1);
        assert!(fixture.verify().is_err(), "reordered checkpoints");

        let mut fixture = Fixture::load();
        fixture.archive.refs.clear();
        assert!(fixture.verify().is_err(), "incomplete final ref index");

        let mut fixture = Fixture::load();
        fixture.archive.ledger_id = uuid::Uuid::nil().to_string();
        assert!(fixture.verify().is_err(), "foreign ledger");
    }

    #[test]
    fn base_v2_offline_requires_independent_bootstrap_and_current_pins() {
        let mut fixture = Fixture::load();
        fixture.trust_pin.authority = SigningKey::from_bytes(&[12; 32]).verifying_key().to_bytes();
        assert!(fixture.verify().is_err(), "untrusted root authority");

        let mut fixture = Fixture::load();
        fixture.trust_pin.initial_manifest_digest = B256::ZERO;
        assert!(fixture.verify().is_err(), "wrong bootstrap digest");

        let mut fixture = Fixture::load();
        fixture.manifests.pop();
        assert!(fixture.verify().is_err(), "valid but stale manifest chain");

        let mut fixture = Fixture::load();
        fixture.current_digest = B256::ZERO;
        assert!(fixture.verify().is_err(), "wrong accepted manifest digest");

        let mut fixture = Fixture::load();
        fixture.checkpoint_digest = B256::ZERO.to_string();
        assert!(fixture.verify().is_err(), "wrong expected commitment");

        let mut fixture = Fixture::load();
        fixture.manifests[1].successor_countersignature = None;
        assert!(
            fixture.verify().is_err(),
            "uncountersigned authority rotation"
        );
    }

    #[test]
    fn base_v2_offline_manifest_key_boundaries_override_embedded_keys() {
        let mut fixture = Fixture::load();
        fixture.archive.signing_keys.clear();
        assert!(fixture.verify().is_ok(), "archive keys are not trust roots");

        let mut fixture = Fixture::load();
        let mut manifest = fixture.manifests.last().unwrap().manifest.clone();
        manifest.checkpoint_keys[0].last_sequence = Some(1);
        let signed =
            SignedManifest::sign(manifest, &SigningKey::from_bytes(&[11; 32]), None).unwrap();
        fixture.current_digest = signed.digest;
        *fixture.manifests.last_mut().unwrap() = signed;
        assert!(
            fixture.verify().is_err(),
            "embedded unretired key cannot authorize sequence 2 past manifest boundary"
        );
    }

    #[test]
    fn base_v2_offline_reads_separate_files_and_enforces_json_bounds() {
        let fixture = Fixture::load();
        let directory = std::env::temp_dir().join(format!("base-verify-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let archive = directory.join("archive.json");
        let manifests = directory.join("manifests.json");
        let trust_pin = directory.join("trust.json");
        std::fs::write(&archive, serde_json::to_vec(&fixture.archive).unwrap()).unwrap();
        std::fs::write(&manifests, serde_json::to_vec(&fixture.manifests).unwrap()).unwrap();
        std::fs::write(&trust_pin, serde_json::to_vec(&fixture.trust_pin).unwrap()).unwrap();
        let result = run(BaseVerifyArgs {
            archive,
            manifests,
            trust_pin: trust_pin.clone(),
            expected_manifest_version: fixture.current_version,
            expected_manifest_digest: fixture.current_digest,
            expected_checkpoint: fixture.checkpoint_digest.parse().unwrap(),
        });
        std::fs::write(&trust_pin, br#"{"authority":[],"authority":[]}"#).unwrap();
        let duplicate = read_json::<Value>(&trust_pin, 100);
        std::fs::write(&trust_pin, b"[]").unwrap();
        let bounded = read_json::<Value>(&trust_pin, 2);
        let oversized = read_json::<Value>(&trust_pin, 1);
        std::fs::remove_dir_all(directory).unwrap();

        assert_eq!(result.unwrap()["checkpoint_verified"], true);
        assert!(duplicate.is_err(), "duplicate keys must not be normalized");
        assert_eq!(bounded.unwrap(), json!([]));
        assert!(
            oversized.is_err(),
            "read must stop at its explicit byte bound"
        );
    }
}
