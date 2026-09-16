use crony_base::{Address, B256, manifest::*};
use ed25519_dalek::SigningKey;

fn fixture() -> DestinationManifestV1 {
    let owner = Address::repeat_byte(7);
    let local = B256::repeat_byte(8);
    DestinationManifestV1 {
        schema_version: 1,
        customer_trust_id: B256::repeat_byte(1),
        manifest_version: 1,
        previous_manifest_digest: None,
        ledger_id: "11111111-1111-4111-8111-111111111111".into(),
        chain_id: 8453,
        network_identity: NetworkIdentity {
            genesis_hash: B256::repeat_byte(2),
            checkpoint: Some(BlockIdentity {
                number: 100,
                hash: B256::repeat_byte(3),
            }),
        },
        contract_address: Address::repeat_byte(4),
        contract_version: 1,
        runtime_code_hash: B256::repeat_byte(5),
        deployment_block_hash: B256::repeat_byte(6),
        deployment_block_number: 90,
        stream_id: crony_base::abi::stream_id(owner, local),
        registering_owner: owner,
        local_stream_key: local,
        checkpoint_keys: vec![CheckpointKey {
            key_id: "checkpoint-1".into(),
            public_key: SigningKey::from_bytes(&[9; 32]).verifying_key().to_bytes(),
            first_sequence: 1,
            last_sequence: None,
        }],
        assurance_policy: crony_base::config::Assurance::ProviderObservedFinalized,
        evidence_retention_policy: "customer-retention-v1".into(),
        migration: None,
        next_manifest_authority: None,
    }
}

#[test]
fn root_cannot_be_authenticated_by_export_and_rollback_is_rejected() {
    let authority = SigningKey::from_bytes(&[10; 32]);
    let signed = SignedManifest::sign(fixture(), &authority, None).unwrap();
    let pin = TrustPin {
        authority: authority.verifying_key().to_bytes(),
        initial_manifest_digest: signed.digest,
    };
    let mut trust = ManifestTrust::bootstrap(&pin, &signed).unwrap();
    assert!(
        ManifestTrust::bootstrap(
            &TrustPin {
                initial_manifest_digest: B256::repeat_byte(2),
                ..pin
            },
            &signed
        )
        .is_err()
    );
    let mut next = fixture();
    next.manifest_version = 2;
    next.previous_manifest_digest = Some(signed.digest);
    let next = SignedManifest::sign(next, &authority, None).unwrap();
    trust.advance(&next).unwrap();
    assert!(trust.advance(&signed).is_err());
}

#[test]
fn authority_rotation_requires_successor_countersignature() {
    let authority = SigningKey::from_bytes(&[10; 32]);
    let successor = SigningKey::from_bytes(&[11; 32]);
    let signed = SignedManifest::sign(fixture(), &authority, None).unwrap();
    let mut trust = ManifestTrust::bootstrap(
        &TrustPin {
            authority: authority.verifying_key().to_bytes(),
            initial_manifest_digest: signed.digest,
        },
        &signed,
    )
    .unwrap();
    let mut rotated = fixture();
    rotated.manifest_version = 2;
    rotated.previous_manifest_digest = Some(signed.digest);
    rotated.next_manifest_authority = Some(successor.verifying_key().to_bytes());
    let mut valid = SignedManifest::sign(rotated, &authority, Some(&successor)).unwrap();
    let saved = valid.successor_countersignature.take();
    assert!(trust.advance(&valid).is_err());
    valid.successor_countersignature = saved;
    trust.advance(&valid).unwrap();
    let mut next = fixture();
    next.manifest_version = 3;
    next.previous_manifest_digest = Some(valid.digest);
    trust
        .advance(&SignedManifest::sign(next, &successor, None).unwrap())
        .unwrap();
}

#[test]
fn canonical_format_uses_byte_strings_and_rejects_changed_payload() {
    let mut signed =
        SignedManifest::sign(fixture(), &SigningKey::from_bytes(&[10; 32]), None).unwrap();
    assert_eq!(&signed.canonical[0..4], &[0x94, 1, 0x58, 0x20]);
    signed.canonical[5] ^= 1;
    assert!(
        signed
            .verify(&SigningKey::from_bytes(&[10; 32]).verifying_key().to_bytes())
            .is_err()
    );
}

#[test]
fn frozen_manifest_and_stream_vector() {
    let authority = SigningKey::from_bytes(&[10; 32]);
    let signed = SignedManifest::sign(fixture(), &authority, None).unwrap();
    let actual = serde_json::json!({
        "canonical_cbor_hex": hex::encode(signed.canonical),
        "signature_hex": hex::encode(signed.signature),
        "digest_hex": hex::encode(signed.digest),
        "authority_hex": hex::encode(authority.verifying_key().to_bytes()),
        "stream_id_hex": hex::encode(signed.manifest.stream_id),
    });
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../vectors/destination-manifest-v1.json")).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn v1_frozen_digest_is_opaque_in_alloy_calldata() {
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("../../../docs/state-audit-v1-vector.json")).unwrap();
    let checkpoint = crony_audit::SignedCheckpoint {
        checkpoint: serde_json::from_value(golden["checkpoint"].clone()).unwrap(),
        payload: hex::decode(golden["payload_hex"].as_str().unwrap()).unwrap(),
        signature: hex::decode(golden["signature_hex"].as_str().unwrap()).unwrap(),
        digest: golden["digest"].as_str().unwrap().into(),
    };
    let mut manifest = fixture();
    manifest.ledger_id = checkpoint.checkpoint.ledger_id.clone();
    manifest.checkpoint_keys[0].key_id = "fixture-key".into();
    manifest.checkpoint_keys[0].public_key =
        hex::decode(golden["public_key_hex"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
    let authority = SigningKey::from_bytes(&[10; 32]);
    let signed = SignedManifest::sign(manifest, &authority, None).unwrap();
    let trust = ManifestTrust::bootstrap(
        &TrustPin {
            authority: authority.verifying_key().to_bytes(),
            initial_manifest_digest: signed.digest,
        },
        &signed,
    )
    .unwrap();
    let call =
        crony_base::abi::AnchorCall::from_checkpoint(&trust, &checkpoint, B256::ZERO).unwrap();
    assert_eq!(
        &call.calldata().unwrap()[68..100],
        &hex::decode(&checkpoint.digest).unwrap()
    );
}
