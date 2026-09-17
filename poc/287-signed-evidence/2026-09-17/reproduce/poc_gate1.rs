use anyhow::{Context, Result, ensure};
use crony_audit::{Archive, SigningKey, VerifyingKey, canonical, digest};
use crony_store::PgStore;
use serde_json::{Value, json};
use std::{fs, io::Read, path::Path};
use uuid::Uuid;

fn verify(envelope: &Value, public_key: &[u8]) -> Result<Value> {
    let raw: [u8; 32] = public_key.try_into().context("expected raw public key")?;
    let key = VerifyingKey::from_bytes(&raw)?;
    ensure!(
        envelope["public_key_hex"] == hex::encode(raw),
        "envelope key differs from independently retained key"
    );
    let archive: Archive = serde_json::from_value(envelope["archive"].clone())?;
    let expected = envelope["checkpoint_digest"]
        .as_str()
        .context("missing checkpoint digest")?;
    archive.verify(&key, Some(expected))?;
    let payload = &envelope["payload"];
    let bytes = canonical(payload)?;
    ensure!(
        envelope["canonical_payload_hex"] == hex::encode(&bytes)
            && envelope["payload_digest"] == digest("contract-input", &bytes),
        "work-item payload canonical bytes or digest differ"
    );
    let contents: Vec<_> = archive
        .rows
        .iter()
        .flat_map(|r| &r.objects)
        .filter(|o| o.kind == "content" && o.value["mission_id"] == envelope["mission_id"])
        .collect();
    ensure!(
        contents.len() == 1,
        "expected one baseline work-item content"
    );
    let content = &contents[0].value;
    ensure!(content["corp_id"] == envelope["corp_id"], "foreign Corp");
    let tasks = content["tasks"]
        .as_array()
        .context("missing audited tasks")?;
    let selected: Vec<_> = tasks
        .iter()
        .filter(|t| t["task_id"] == envelope["task_id"])
        .collect();
    ensure!(
        selected.len() == 1,
        "task is not uniquely bound to signed content"
    );
    ensure!(
        selected[0]["contract_digest"] == envelope["payload_digest"]
            && selected[0]["contract_version"] == envelope["contract_version"],
        "signed task contract binding differs"
    );
    ensure!(
        archive.rows.len() == 1 && archive.checkpoints.len() == 1,
        "POC requires one complete baseline and one covering checkpoint"
    );
    Ok(json!({
        "status":"PASS",
        "task_id":envelope["task_id"],
        "payload_digest":envelope["payload_digest"],
        "checkpoint_digest":expected,
        "ledger_id":archive.ledger_id,
        "canonical_payload_matches":true,
        "payload_to_task_to_content_to_version_to_decision_to_checkpoint":true,
        "archive_signature_and_history_verified":true
    }))
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 4,
        "usage: poc_gate1 sign INPUT OUTPUT | verify ENVELOPE PUBLIC_KEY"
    );
    if args[1] == "verify" {
        let envelope: Value = crony_audit::parse_json(&fs::read(&args[2])?)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&verify(&envelope, &fs::read(&args[3])?)?)?
        );
        return Ok(());
    }
    ensure!(args[1] == "sign", "unknown action");
    let input: Value = crony_audit::parse_json(&fs::read(&args[2])?)?;
    let id = |name: &str| -> Result<Uuid> {
        Ok(Uuid::parse_str(
            input[name].as_str().context("missing input identity")?,
        )?)
    };
    let corp = id("corp_id")?;
    let actor = id("actor_id")?;
    let mission = id("mission_id")?;
    let ledger = id("ledger_id")?;
    let task = id("task_id")?;
    ensure!(
        input["payload"]["secret_refs"] == json!([]),
        "unexpected secret references"
    );
    let out = Path::new(&args[3]);
    fs::create_dir(out).context("use a new evidence directory; never overwrite a prior attempt")?;

    // The launcher supplies fresh entropy over an anonymous pipe, never a file,
    // argument, environment variable, prompt, or log.
    let mut seed = [0_u8; 32];
    let mut stdin = std::io::stdin().lock();
    stdin.read_exact(&mut seed)?;
    ensure!(
        stdin.read(&mut [0_u8; 1])? == 0,
        "unexpected signing input length"
    );
    let key = SigningKey::from_bytes(&seed);
    seed.fill(0);
    let public = key.verifying_key().to_bytes();
    write_new(&out.join("trusted-public-key.bin"), &public)?;
    let database =
        std::env::var("DATABASE_URL").context("trusted database environment required")?;
    let store = PgStore::connect(&database).await?;
    ensure!(
        store.audit_status(corp, actor).await?["ledger"].is_null(),
        "existing ledger must not be reset"
    );
    store.initialize_state_audit(corp, actor, ledger).await?;
    let receipt = store.cover_mission(corp, actor, mission).await?;
    let signed = store
        .audit_checkpoint(corp, "poc-gate1-ephemeral-ed25519", &key)
        .await?;
    drop(key);
    let archive = store.audit_export(corp, actor).await?;
    let bytes = canonical(&input["payload"])?;
    let envelope = json!({
        "schema":"ecorp-poc-gate1-native-audit-envelope-v1",
        "signature_scope":"task contract committed through native mission-governance audit chain",
        "algorithm":"Ed25519",
        "canonicalization":"crony_audit::canonical; RFC8949 core deterministic CBOR; integers only; map keys sorted by encoded bytes",
        "payload_digest_algorithm":"BLAKE3(ecorp.state-audit.v1\\0contract-input\\0 || canonical_payload)",
        "corp_id":corp,
        "mission_id":mission,
        "task_id":task,
        "contract_version":input["contract_version"],
        "payload":input["payload"],
        "canonical_payload_hex":hex::encode(&bytes),
        "payload_digest":digest("contract-input", &bytes),
        "public_key_hex":hex::encode(public),
        "key_id":signed.checkpoint.key_id,
        "checkpoint_digest":signed.digest,
        "archive":archive
    });
    let verification = verify(&envelope, &public)?;
    write_new(&out.join("payload.cbor"), &bytes)?;
    write_new(
        &out.join("payload.json"),
        &serde_json::to_vec_pretty(&input["payload"])?,
    )?;
    write_new(
        &out.join("archive.json"),
        &serde_json::to_vec_pretty(&envelope["archive"])?,
    )?;
    write_new(
        &out.join("signed-envelope.json"),
        &serde_json::to_vec_pretty(&envelope)?,
    )?;
    write_new(&out.join("checkpoint.cbor"), &signed.payload)?;
    write_new(&out.join("checkpoint.ed25519"), &signed.signature)?;
    write_new(
        &out.join("baseline-receipt.json"),
        &serde_json::to_vec_pretty(&receipt)?,
    )?;
    write_new(
        &out.join("native-verification.json"),
        &serde_json::to_vec_pretty(&verification)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&verification)?);
    Ok(())
}
