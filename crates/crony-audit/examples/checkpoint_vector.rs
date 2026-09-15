use crony_audit::{Checkpoint, SignedCheckpoint, SigningKey};

fn main() -> anyhow::Result<()> {
    // Public test material only; this constant must never be used in a deployment.
    let key = SigningKey::from_bytes(&[7; 32]);
    let signed = SignedCheckpoint::sign(
        Checkpoint {
            protocol_version: 1,
            ledger_id: "00000000-0000-4000-8000-000000000001".into(),
            last_sequence: 1,
            last_row_hash: "11".repeat(32),
            previous_checkpoint_digest: None,
            key_id: "fixture-key".into(),
        },
        &key,
    )?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "public_key_hex":hex::encode(key.verifying_key().as_bytes()),
            "payload_hex":hex::encode(&signed.payload),"signature_hex":hex::encode(&signed.signature),
            "digest":signed.digest,"checkpoint":signed.checkpoint
        }))?
    );
    Ok(())
}
