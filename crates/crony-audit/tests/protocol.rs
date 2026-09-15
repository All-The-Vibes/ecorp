use crony_audit::*;

#[test]
fn strict_wire_json_rejects_ambiguous_records_and_invalid_ledger() {
    assert!(parse_json::<serde_json::Value>(br#"{"nested":{"a":1,"a":2}}"#).is_err());
    assert!(parse_json::<serde_json::Value>(br#"{"a":1} {}"#).is_err());
    assert!(parse_json::<serde_json::Value>(br#"{"a":1.5}"#).is_err());
    assert!(parse_json::<serde_json::Value>(br#"{"a":[1,null,true]}"#).is_ok());
    let cp = Checkpoint {
        protocol_version: 1,
        ledger_id: "x".repeat(36),
        last_sequence: 1,
        last_row_hash: "11".repeat(32),
        previous_checkpoint_digest: None,
        key_id: "fixture".into(),
    };
    assert!(cp.bytes().is_err());
}
use serde_json::json;

#[test]
fn canonical_core_deterministic_vectors() {
    assert_eq!(
        hex::encode(canonical(&json!({"b":24,"a":null})).unwrap()),
        "a26161f661621818"
    );
    assert_eq!(
        hex::encode(canonical(&json!([0, 23, 24, 255, 256, -1, -25, true])).unwrap()),
        "880017181818ff190100203818f5"
    );
    // RFC 8949 core deterministic order is bytewise, not length-first.
    assert_eq!(
        hex::encode(canonical(&json!({"z":0,"aa":1})).unwrap()),
        "a2617a0062616101"
    );
    assert!(canonical(&json!(1.25)).is_err());
}

fn checkpoint() -> Checkpoint {
    Checkpoint {
        protocol_version: 1,
        ledger_id: "00000000-0000-4000-8000-000000000001".into(),
        last_sequence: 1,
        last_row_hash: "11".repeat(32),
        previous_checkpoint_digest: None,
        key_id: "fixture-key".into(),
    }
}

#[test]
fn checkpoint_signature_and_digest_are_destination_neutral() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let signed = SignedCheckpoint::sign(checkpoint(), &key).unwrap();
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("../../../docs/state-audit-v1-vector.json")).unwrap();
    assert_eq!(golden["payload_hex"], hex::encode(&signed.payload));
    assert_eq!(golden["signature_hex"], hex::encode(&signed.signature));
    assert_eq!(golden["digest"], signed.digest);
    assert_eq!(
        golden["public_key_hex"],
        hex::encode(key.verifying_key().as_bytes())
    );
    signed.verify(&key.verifying_key(), None).unwrap();
    assert!(
        signed
            .verify(&SigningKey::from_bytes(&[8; 32]).verifying_key(), None)
            .is_err()
    );
    assert!(
        signed
            .verify(&key.verifying_key(), Some(&"00".repeat(32)))
            .is_err()
    );
    let mut changed = signed.clone();
    changed.checkpoint.last_sequence += 1;
    assert!(changed.verify(&key.verifying_key(), None).is_err());
    let mut changed = signed.clone();
    changed.payload.push(0);
    assert!(changed.verify(&key.verifying_key(), None).is_err());
    assert!(!String::from_utf8_lossy(&signed.payload).contains("github"));
    assert_eq!(signed, SignedCheckpoint::sign(checkpoint(), &key).unwrap());
}

#[test]
fn hash_domains_are_not_interchangeable() {
    assert_ne!(digest("object", b"same"), digest("decision", b"same"));
    assert_ne!(digest("checkpoint", b"same"), digest("signature", b"same"));
}

#[test]
fn version_has_explicit_unclaimed_provenance() {
    let value = json!({"schema_version":1,"ledger_id":checkpoint().ledger_id,"resource_key":"mission/governance",
        "content_hash":"11".repeat(32),"parents":[],"actor":"actor","recorded_at":1,
        "provenance_assertions":[],"observed_execution_context":null,"evidence_references":[]});
    assert!(serde_json::from_value::<Version>(value).is_ok());
}

#[test]
fn ethereum_progression_skips_local_checkpoints_without_changing_them() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let first = SignedCheckpoint::sign(checkpoint(), &key).unwrap();
    let mut second = checkpoint();
    second.last_sequence = 2;
    second.previous_checkpoint_digest = Some(first.digest.clone());
    let second = SignedCheckpoint::sign(second, &key).unwrap();
    let mut third = checkpoint();
    third.last_sequence = 3;
    third.previous_checkpoint_digest = Some(second.digest.clone());
    let third = SignedCheckpoint::sign(third, &key).unwrap();
    let a = AnchorCommitment::from_checkpoint(&first, None).unwrap();
    let c = AnchorCommitment::from_checkpoint(&third, Some(a.checkpoint_digest.clone())).unwrap();
    assert!(validate_anchor_progression(None, &a).unwrap());
    assert!(validate_anchor_progression(Some(&a), &c).unwrap());
    assert!(!validate_anchor_progression(Some(&c), &c).unwrap());
    let mut wrong = c.clone();
    wrong.previous_anchor_digest = Some(second.digest);
    assert!(validate_anchor_progression(Some(&a), &wrong).is_err());
    wrong = c.clone();
    wrong.last_sequence = 1;
    assert!(validate_anchor_progression(Some(&a), &wrong).is_err());
    wrong = c.clone();
    wrong.ledger_id = UuidForTest::OTHER.into();
    assert!(validate_anchor_progression(Some(&a), &wrong).is_err());
    third.verify(&key.verifying_key(), None).unwrap();
}

struct UuidForTest;
impl UuidForTest {
    const OTHER: &'static str = "00000000-0000-4000-8000-000000000002";
}
