use crony_base::{
    B256,
    manifest::{ManifestTrust, SignedManifest, TrustPin},
};

#[test]
fn documented_destination_shape_is_disabled_and_unenrolled() {
    let config: crony_base::config::BaseDestinationConfig =
        serde_json::from_str(include_str!("../vectors/destination-config.example.json")).unwrap();
    assert!(!config.enabled);
    assert!(config.validate().is_err());
}

#[derive(serde::Deserialize)]
struct Fixture {
    archive: crony_audit::Archive,
    manifests: Vec<SignedManifest>,
    trust_pin: TrustPin,
    current_version: u64,
    current_digest: B256,
    checkpoint_digest: String,
}

#[test]
fn frozen_full_history_verifies_against_separate_manifest_trust() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../vectors/full-history-v1.json")).unwrap();
    let mut trust = ManifestTrust::bootstrap(&fixture.trust_pin, &fixture.manifests[0]).unwrap();
    for next in &fixture.manifests[1..] {
        trust.advance(next).unwrap();
    }
    trust
        .require_current(fixture.current_version, fixture.current_digest)
        .unwrap();
    let manifest = &trust.current().manifest;
    let mut history = crony_audit::HistoryVerifier::new(&fixture.archive.ledger_id);
    let mut checkpoints = fixture.archive.checkpoints.iter().peekable();
    for row in &fixture.archive.rows {
        history.push(row).unwrap();
        if checkpoints
            .peek()
            .is_some_and(|cp| cp.checkpoint.last_sequence == history.sequence())
        {
            let cp = checkpoints.next().unwrap();
            manifest.verify_checkpoint(cp).unwrap();
            let key = manifest
                .checkpoint_keys
                .iter()
                .find(|key| key.key_id == cp.checkpoint.key_id)
                .unwrap();
            history
                .checkpoint(
                    cp,
                    &ed25519_dalek::VerifyingKey::from_bytes(&key.public_key).unwrap(),
                )
                .unwrap();
        }
    }
    assert!(checkpoints.next().is_none());
    assert_eq!(history.refs(), &fixture.archive.refs);
    history.finish(Some(&fixture.checkpoint_digest)).unwrap();
    assert_eq!(fixture.archive.rows.len(), 2);
    assert_eq!(fixture.archive.checkpoints.len(), 2);
    assert_eq!(fixture.manifests.len(), 3);
}
