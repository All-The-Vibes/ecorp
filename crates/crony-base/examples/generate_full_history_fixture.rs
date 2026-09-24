//! Deterministic synthetic fixture generation only; no network, deployment, or production key.
use crony_audit::{
    Archive, Change, Checkpoint, Decision, DecisionBundle, Object, SignedCheckpoint,
    TrustedSigningKey, Version,
};
use crony_base::{
    Address, B256,
    abi::stream_id,
    config::Assurance,
    manifest::{
        CheckpointKey, DestinationManifestV1, ManifestTrust, NetworkIdentity, SignedManifest,
        TrustPin,
    },
};
use ed25519_dalek::SigningKey;
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let ledger = "11111111-1111-4111-8111-111111111111";
    let corp = "22222222-2222-4222-8222-222222222222";
    let mission = "33333333-3333-4333-8333-333333333333";
    let actor = "55555555-5555-4555-8555-555555555555";
    let resource = format!("mission/{mission}/governance");
    let evaluator = "native-mission-governance-v1";
    let checkpoint_key = SigningKey::from_bytes(&[9; 32]);
    let root_authority = SigningKey::from_bytes(&[10; 32]);
    let successor_authority = SigningKey::from_bytes(&[11; 32]);
    let key_id = "synthetic-checkpoint-key";
    let policy = Object::new(
        "policy",
        json!({
            "schema_version":1,"evaluator_version":evaluator,
            "authority":"native-mission-contract-and-budget-rules","coverage":"mission-governance-v1"
        }),
    )?;
    let mut rows = Vec::new();
    let mut checkpoints = Vec::new();
    let mut previous_version: Option<String> = None;
    let mut previous_row: Option<String> = None;
    let mut previous_checkpoint: Option<String> = None;
    for sequence in 1..=2 {
        let recorded_at = 1_700_000_000 + sequence as i64;
        let content = Object::new(
            "content",
            json!({
                "schema_version":1,"ledger_id":ledger,"corp_id":corp,"mission_id":mission,
                "room_id":"44444444-4444-4444-8444-444444444444","requested_by":actor,
                "resource_key":resource,"description_digest":crony_audit::digest("synthetic-description",b"fixture mission"),
                "specification_version":1,"budget_tokens":sequence*1000,"budget_cost_microusd":sequence*10000,
                "tasks":[],"pending_budget_proposals":[]
            }),
        )?;
        let version = Object::new(
            "version",
            serde_json::to_value(Version {
                schema_version: 1,
                ledger_id: ledger.into(),
                resource_key: resource.clone(),
                content_hash: content.hash.clone(),
                parents: previous_version.iter().cloned().collect(),
                actor: actor.into(),
                recorded_at,
                provenance_assertions: vec![],
                observed_execution_context: None,
                evidence_references: vec![],
            })?,
        )?;
        let bundle = DecisionBundle::new(
            Decision {
                schema_version: 1,
                ledger_id: ledger.into(),
                sequence,
                previous_row_hash: previous_row.clone(),
                actor: actor.into(),
                operation: if sequence == 1 {
                    "baseline"
                } else {
                    "budget_decision"
                }
                .into(),
                recorded_at,
                request_id: format!("synthetic-request-{sequence}"),
                request_digest: crony_audit::digest("synthetic-request", &sequence.to_be_bytes()),
                decision: if sequence == 1 {
                    "baseline"
                } else {
                    "accepted"
                }
                .into(),
                reason_code: if sequence == 1 {
                    "coverage_started"
                } else {
                    "native_policy_accepted"
                }
                .into(),
                policy_hash: policy.hash.clone(),
                evaluator_version: evaluator.into(),
                changes: vec![Change {
                    resource_key: resource.clone(),
                    before: previous_version.clone(),
                    after: version.hash.clone(),
                    before_revision: sequence - 1,
                    after_revision: sequence,
                }],
                correlation_id: "synthetic-correlation".into(),
                causation_id: None,
            },
            vec![policy.clone(), content, version.clone()],
        )?;
        let checkpoint = SignedCheckpoint::sign(
            Checkpoint {
                protocol_version: 1,
                ledger_id: ledger.into(),
                last_sequence: sequence,
                last_row_hash: bundle.row_hash.clone(),
                previous_checkpoint_digest: previous_checkpoint.clone(),
                key_id: key_id.into(),
            },
            &checkpoint_key,
        )?;
        previous_row = Some(bundle.row_hash.clone());
        previous_version = Some(version.hash);
        previous_checkpoint = Some(checkpoint.digest.clone());
        rows.push(bundle);
        checkpoints.push(checkpoint);
    }
    let checkpoint_digest = checkpoints.last().unwrap().digest.clone();
    let archive = Archive {
        schema_version: 1,
        ledger_id: ledger.into(),
        rows,
        checkpoints,
        signing_keys: vec![TrustedSigningKey {
            key_id: key_id.into(),
            public_key_hex: hex::encode(checkpoint_key.verifying_key().to_bytes()),
            activated_sequence: 1,
            retired_sequence: None,
        }],
        refs: [(resource, (previous_version.unwrap(), 2))].into(),
    };
    archive.verify(&checkpoint_key.verifying_key(), Some(&checkpoint_digest))?;
    let owner = Address::repeat_byte(7);
    let local_key = B256::repeat_byte(8);
    let root = SignedManifest::sign(
        DestinationManifestV1 {
            schema_version: 1,
            customer_trust_id: B256::repeat_byte(1),
            manifest_version: 1,
            previous_manifest_digest: None,
            ledger_id: ledger.into(),
            chain_id: 84532,
            network_identity: NetworkIdentity {
                genesis_hash: B256::repeat_byte(2),
                checkpoint: None,
            },
            contract_address: Address::repeat_byte(4),
            contract_version: 1,
            runtime_code_hash: "0xe2e734ff4a294b7c36ad6ab657267015538e28b16fcb5a3dc2ea89654e24c3cc"
                .parse()?,
            deployment_block_hash: B256::repeat_byte(6),
            deployment_block_number: 90,
            stream_id: stream_id(owner, local_key),
            registering_owner: owner,
            local_stream_key: local_key,
            checkpoint_keys: vec![CheckpointKey {
                key_id: key_id.into(),
                public_key: checkpoint_key.verifying_key().to_bytes(),
                first_sequence: 1,
                last_sequence: None,
            }],
            assurance_policy: Assurance::ProviderObservedFinalized,
            evidence_retention_policy: "synthetic-retention-v1".into(),
            migration: None,
            next_manifest_authority: None,
        },
        &root_authority,
        None,
    )?;
    let trust_pin = TrustPin {
        authority: root_authority.verifying_key().to_bytes(),
        initial_manifest_digest: root.digest,
    };
    let mut rotation = root.manifest.clone();
    rotation.manifest_version = 2;
    rotation.previous_manifest_digest = Some(root.digest);
    rotation.next_manifest_authority = Some(successor_authority.verifying_key().to_bytes());
    let rotated = SignedManifest::sign(rotation, &root_authority, Some(&successor_authority))?;
    let mut third = rotated.manifest.clone();
    third.manifest_version = 3;
    third.previous_manifest_digest = Some(rotated.digest);
    third.next_manifest_authority = None;
    let current = SignedManifest::sign(third, &successor_authority, None)?;
    let mut trust = ManifestTrust::bootstrap(&trust_pin, &root)?;
    trust.advance(&rotated)?;
    trust.advance(&current)?;
    for checkpoint in &archive.checkpoints {
        trust.current().manifest.verify_checkpoint(checkpoint)?;
    }
    let fixture = json!({
        "archive":archive,"manifests":[root,rotated,current],
        "trust_pin":trust_pin,"current_version":trust.current().manifest.manifest_version,
        "current_digest":trust.current().digest,"checkpoint_digest":checkpoint_digest,
    });
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("vectors")
        .join("full-history-v1.json");
    std::fs::write(path, format!("{}\n", serde_json::to_string(&fixture)?))?;
    println!(
        "Generated and verified synthetic complete archive and independently pinned manifest chain"
    );
    Ok(())
}
