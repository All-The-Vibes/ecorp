use anyhow::{Result, bail};
use crony_audit::*;
use futures_util::future::BoxFuture;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Default)]
struct Fake {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
    writes: Mutex<usize>,
    fail_at: Mutex<Option<usize>>,
    rewritten: Mutex<bool>,
    discard_at: Mutex<Option<usize>>,
    lose_response_at: Mutex<Option<usize>>,
    head_calls: Mutex<usize>,
    read_heads: Mutex<Vec<String>>,
}
impl PublicationTransport for Fake {
    fn head(&self) -> BoxFuture<'_, Result<String>> {
        Box::pin(async {
            let mut calls = self.head_calls.lock().unwrap();
            *calls += 1;
            Ok(format!("head-{calls}"))
        })
    }
    fn descends_from<'a>(&'a self, _old: &'a str, _new: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async { Ok(!*self.rewritten.lock().unwrap()) })
    }
    fn read<'a>(&'a self, path: &'a str, head: &'a str) -> BoxFuture<'a, Result<Option<Vec<u8>>>> {
        Box::pin(async move {
            self.read_heads.lock().unwrap().push(head.into());
            Ok(self.files.lock().unwrap().get(path).cloned())
        })
    }
    fn create<'a>(&'a self, path: &'a str, body: &'a [u8]) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut count = self.writes.lock().unwrap();
            *count += 1;
            if *self.fail_at.lock().unwrap() == Some(*count) {
                bail!("interrupted transport")
            }
            if *self.discard_at.lock().unwrap() == Some(*count) {
                return Ok(());
            }
            let mut files = self.files.lock().unwrap();
            if files.contains_key(path) {
                bail!("conflict; never overwrite");
            }
            files.insert(path.into(), body.into());
            if *self.lose_response_at.lock().unwrap() == Some(*count) {
                bail!("lost create response");
            }
            Ok(())
        })
    }
}

// The same complete mission-governance objects and version-parent relationships
// as history.rs, with a task marker and optionally large, valid tool metadata.
fn archive_fixture(row_count: usize, padding: usize) -> (Archive, Vec<TrustedSigningKey>) {
    let key = SigningKey::from_bytes(&[7; 32]);
    let keys = vec![TrustedSigningKey {
        key_id: "fixture".into(),
        public_key_hex: hex::encode(key.verifying_key().as_bytes()),
        activated_sequence: 1,
        retired_sequence: None,
    }];
    let ledger = "00000000-0000-4000-8000-000000000001";
    let mission = "00000000-0000-4000-8000-000000000010";
    let resource = format!("mission/{mission}/governance");
    let policy = Object::new(
            "policy",
            json!({"schema_version":1,"evaluator_version":"native-mission-governance-v1",
                "authority":"native-mission-contract-and-budget-rules","coverage":"mission-governance-v1"}),
        )
        .unwrap();
    let mut archive = Archive {
        schema_version: 1,
        ledger_id: ledger.into(),
        rows: vec![],
        checkpoints: vec![],
        signing_keys: keys.clone(),
        refs: BTreeMap::new(),
    };
    for number in 1..=row_count {
        let before = archive.refs.get(&resource).map(|(hash, _)| hash.clone());
        let content = Object::new(
            "content",
            json!({
                "schema_version":1,"ledger_id":ledger,"corp_id":ledger,
                "mission_id":mission,"room_id":"room","requested_by":"actor",
                "resource_key":resource,"description_digest":"11".repeat(32),
                "specification_version":number,"budget_tokens":100,"budget_cost_microusd":1000,
                "tasks":[{
                    "task_id":"native-archive-task-marker","contract_version":1,
                    "contract_digest":"22".repeat(32),"verification_digest":"33".repeat(32),
                    "allowed_tools":["x".repeat(padding)],"write_scope":[],
                    "budget_tokens":100,"budget_cost_microusd":1000
                }],
                "pending_budget_proposals":[]
            }),
        )
        .unwrap();
        let version = Object::new(
            "version",
            json!({
                "schema_version":1,"ledger_id":ledger,"resource_key":resource,
                "content_hash":content.hash,"parents":before.iter().collect::<Vec<_>>(),
                "actor":"actor","recorded_at":number,"provenance_assertions":[],
                "observed_execution_context":null,"evidence_references":[]
            }),
        )
        .unwrap();
        let row = DecisionBundle::new(
            Decision {
                schema_version: 1,
                ledger_id: ledger.into(),
                sequence: number as u64,
                previous_row_hash: archive.rows.last().map(|row| row.row_hash.clone()),
                actor: "actor".into(),
                operation: if number == 1 {
                    "baseline"
                } else {
                    "contract_revision"
                }
                .into(),
                recorded_at: number as i64,
                request_id: format!("request-{number}"),
                request_digest: "44".repeat(32),
                decision: if number == 1 { "baseline" } else { "accepted" }.into(),
                reason_code: if number == 1 {
                    "coverage_started"
                } else {
                    "native_policy_accepted"
                }
                .into(),
                policy_hash: policy.hash.clone(),
                evaluator_version: "native-mission-governance-v1".into(),
                changes: vec![Change {
                    resource_key: resource.clone(),
                    before,
                    after: version.hash.clone(),
                    before_revision: number as u64 - 1,
                    after_revision: number as u64,
                }],
                correlation_id: mission.into(),
                causation_id: None,
            },
            vec![content, version.clone(), policy.clone()],
        )
        .unwrap();
        let checkpoint = SignedCheckpoint::sign(
            Checkpoint {
                protocol_version: 1,
                ledger_id: ledger.into(),
                last_sequence: number as u64,
                last_row_hash: row.row_hash.clone(),
                previous_checkpoint_digest: archive.checkpoints.last().map(|cp| cp.digest.clone()),
                key_id: "fixture".into(),
            },
            &key,
        )
        .unwrap();
        archive.rows.push(row);
        archive.checkpoints.push(checkpoint);
        archive
            .refs
            .insert(resource.clone(), (version.hash, number as u64));
    }
    (archive, keys)
}

fn blob_sha1(bytes: &[u8]) -> String {
    let mut git_bytes = format!("blob {}\0", bytes.len()).into_bytes();
    git_bytes.extend_from_slice(bytes);
    hex::encode(<sha1::Sha1 as sha1::Digest>::digest(git_bytes))
}

fn reconstruct(fake: &Fake, receipt: &PublishedArchive) -> Archive {
    let files = fake.files.lock().unwrap();
    let index_bytes = files.get(&receipt.index_path).unwrap();
    assert!(index_bytes.len() <= MAX_RECORD_BYTES);
    assert_eq!(receipt.index_git_blob_sha1, blob_sha1(index_bytes));
    assert_eq!(
        receipt.index_sha256,
        hex::encode(Sha256::digest(index_bytes))
    );
    let index: ArchivePublicationIndex = serde_json::from_slice(index_bytes).unwrap();
    assert_eq!(index, receipt.archive);
    let mut bytes = Vec::new();
    for (number, part) in index.parts.iter().enumerate() {
        assert!(part.path.ends_with(&format!("/archive-{number:05}.json")));
        validate_destination("audit/validation", "audit", &part.path).unwrap();
        let body = files.get(&part.path).unwrap();
        assert!(body.len() <= MAX_RECORD_BYTES);
        assert_eq!(body.len() as u64, part.byte_count);
        assert_eq!(part.sha256, hex::encode(Sha256::digest(body)));
        assert_eq!(part.git_blob_sha1, blob_sha1(body));
        bytes.extend_from_slice(body);
    }
    assert_eq!(bytes.len() as u64, index.byte_count);
    assert_eq!(index.sha256, hex::encode(Sha256::digest(&bytes)));
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn legacy_keyless_archive_requires_the_independent_historical_key() {
    let (mut archive, keys) = archive_fixture(1, 0);
    archive.signing_keys.clear();
    let checkpoint = archive.checkpoints.last().unwrap();
    let fake = Fake::default();
    let published = publish_checkpoint_archive(&fake, "audit", checkpoint, &archive, &keys, None)
        .await
        .unwrap();
    let recovered = reconstruct(&fake, &published);
    assert!(
        recovered.signing_keys.is_empty(),
        "Legacy archive bytes must not gain embedded authority"
    );
    recovered
        .verify(&keys[0].verifying_key().unwrap(), Some(&checkpoint.digest))
        .unwrap();
    let mut wrong = keys.clone();
    wrong[0].public_key_hex =
        hex::encode(SigningKey::from_bytes(&[9; 32]).verifying_key().as_bytes());
    assert!(
        publish_checkpoint_archive(
            &Fake::default(),
            "audit",
            checkpoint,
            &archive,
            &wrong,
            None
        )
        .await
        .is_err()
    );
    assert!(
        publish_checkpoint_archive(&Fake::default(), "audit", checkpoint, &archive, &[], None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn legacy_publication_extends_to_complete_archive_without_changing_v1() {
    let (archive, keys) = archive_fixture(2, 0);
    let checkpoint = archive.checkpoints.last().unwrap();
    let fake = Fake::default();
    let legacy_head = publish_checkpoint(&fake, "audit", checkpoint, None)
        .await
        .unwrap();
    let legacy = fake.files.lock().unwrap().clone();
    assert_eq!(legacy.len(), 4);
    assert!(!legacy.keys().any(|path| path.contains("/archive")));
    let stem = format!(
        "audit/{}/{:020}-{}",
        archive.ledger_id, checkpoint.checkpoint.last_sequence, checkpoint.digest
    );
    assert!(legacy[&format!("{stem}.cbor")] == checkpoint.payload);
    assert!(legacy[&format!("{stem}.ed25519")] == checkpoint.signature);
    assert!(legacy[&format!("{stem}.json")] == serde_json::to_vec(checkpoint).unwrap());
    assert_eq!(
        legacy[&format!(
            "audit/{}/{:020}.checkpoint",
            archive.ledger_id, checkpoint.checkpoint.last_sequence
        )],
        checkpoint.digest.as_bytes()
    );

    let receipt = publish_checkpoint_archive(
        &fake,
        "audit",
        checkpoint,
        &archive,
        &keys,
        Some(&legacy_head),
    )
    .await
    .unwrap();
    assert_eq!(receipt.archive.parts.len(), 1);
    assert_eq!(receipt.archive.schema_version, 1);
    assert_eq!(receipt.archive.ledger_id, archive.ledger_id);
    assert_eq!(receipt.archive.checkpoint_digest, checkpoint.digest);
    assert_eq!(receipt.index_path, format!("{stem}/archive.json"));
    {
        let files = fake.files.lock().unwrap();
        assert_eq!(files.len(), 6);
        for (path, bytes) in &legacy {
            assert!(files.get(path) == Some(bytes), "V1 bytes changed at {path}");
        }
        let part = &files[&receipt.archive.parts[0].path];
        assert!(*part == serde_json::to_vec(&archive).unwrap());
        assert!(serde_json::from_slice::<Archive>(part).is_ok());
    }
    let restored = reconstruct(&fake, &receipt);
    restored
        .verify_with_key_history(&keys, Some(&checkpoint.digest))
        .unwrap();
    assert!(serde_json::to_vec(&restored).unwrap() == serde_json::to_vec(&archive).unwrap());
    let version_hash = &restored.refs.values().next().unwrap().0;
    let objects = &restored.rows.last().unwrap().objects;
    let version = objects
        .iter()
        .find(|object| &object.hash == version_hash)
        .unwrap();
    let content = objects
        .iter()
        .find(|object| object.hash == version.value["content_hash"])
        .unwrap();
    assert_eq!(
        content.value["tasks"][0]["task_id"],
        "native-archive-task-marker"
    );
    assert!(
        fake.read_heads
            .lock()
            .unwrap()
            .iter()
            .rev()
            .take(6)
            .all(|head| head == &receipt.commit)
    );

    let writes = *fake.writes.lock().unwrap();
    let replay = publish_checkpoint_archive(
        &fake,
        "audit",
        checkpoint,
        &archive,
        &keys,
        Some(&receipt.commit),
    )
    .await
    .unwrap();
    assert_eq!(*fake.writes.lock().unwrap(), writes);
    assert_eq!(receipt.archive, replay.archive);
    assert_eq!(receipt.index_git_blob_sha1, replay.index_git_blob_sha1);
    let serialized = serde_json::to_vec(&receipt).unwrap();
    assert_eq!(
        serde_json::from_slice::<PublishedArchive>(&serialized).unwrap(),
        receipt
    );
}

#[tokio::test]
async fn multipart_archive_is_deterministic_bounded_and_complete() {
    let (archive, keys) = archive_fixture(2, 90_000);
    let checkpoint = archive.checkpoints.last().unwrap();
    let fake = Fake::default();
    let receipt = publish_checkpoint_archive(&fake, "audit", checkpoint, &archive, &keys, None)
        .await
        .unwrap();
    assert!(receipt.archive.parts.len() > 1 && receipt.archive.parts.len() <= 128);
    for part in receipt.archive.parts.iter().rev().skip(1) {
        assert_eq!(part.byte_count, MAX_RECORD_BYTES as u64);
    }
    let restored = reconstruct(&fake, &receipt);
    assert!(serde_json::to_vec(&restored).unwrap() == serde_json::to_vec(&archive).unwrap());
    restored
        .verify_with_key_history(&keys, Some(&checkpoint.digest))
        .unwrap();
    let other = Fake::default();
    let second = publish_checkpoint_archive(&other, "audit", checkpoint, &archive, &keys, None)
        .await
        .unwrap();
    assert_eq!(receipt.archive, second.archive);
    assert_eq!(receipt.index_git_blob_sha1, second.index_git_blob_sha1);
    assert!(*fake.files.lock().unwrap() == *other.files.lock().unwrap());
}

#[tokio::test]
async fn archive_interruption_and_lost_response_retries_adopt_exact_bytes() {
    let (archive, keys) = archive_fixture(1, 0);
    let checkpoint = archive.checkpoints.last().unwrap();
    // After four checkpoint files, at the part, and after the index committed
    // but its success response was lost.
    for (failed_write, lost_response) in [(5, false), (6, false), (6, true)] {
        let fake = Fake::default();
        if lost_response {
            *fake.lose_response_at.lock().unwrap() = Some(failed_write);
        } else {
            *fake.fail_at.lock().unwrap() = Some(failed_write);
        }
        assert!(
            publish_checkpoint_archive(&fake, "audit", checkpoint, &archive, &keys, None)
                .await
                .is_err()
        );
        let retained = fake.files.lock().unwrap().clone();
        assert!(retained.len() >= 4);
        *fake.fail_at.lock().unwrap() = None;
        *fake.lose_response_at.lock().unwrap() = None;
        let writes = *fake.writes.lock().unwrap();
        let receipt = publish_checkpoint_archive(&fake, "audit", checkpoint, &archive, &keys, None)
            .await
            .unwrap();
        assert_eq!(*fake.writes.lock().unwrap() - writes, 6 - retained.len());
        for (path, bytes) in &retained {
            assert!(fake.files.lock().unwrap().get(path) == Some(bytes));
        }
        reconstruct(&fake, &receipt)
            .verify_with_key_history(&keys, Some(&checkpoint.digest))
            .unwrap();
    }
}

#[tokio::test]
async fn archive_missing_readback_conflicts_and_history_rewrite_fail_closed() {
    let (archive, keys) = archive_fixture(1, 0);
    let checkpoint = archive.checkpoints.last().unwrap();
    for discarded in [1, 5, 6] {
        let fake = Fake::default();
        *fake.discard_at.lock().unwrap() = Some(discarded);
        let error = publish_checkpoint_archive(&fake, "audit", checkpoint, &archive, &keys, None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("incomplete remote checkpoint"));
    }
    let fake = Fake::default();
    let receipt = publish_checkpoint_archive(&fake, "audit", checkpoint, &archive, &keys, None)
        .await
        .unwrap();
    for path in [&receipt.index_path, &receipt.archive.parts[0].path] {
        let original = fake.files.lock().unwrap()[path].clone();
        fake.files.lock().unwrap().get_mut(path).unwrap().push(b' ');
        let writes = *fake.writes.lock().unwrap();
        let error = publish_checkpoint_archive(
            &fake,
            "audit",
            checkpoint,
            &archive,
            &keys,
            Some(&receipt.commit),
        )
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("conflicting existing checkpoint")
        );
        assert_eq!(*fake.writes.lock().unwrap(), writes);
        fake.files.lock().unwrap().insert(path.clone(), original);
    }
    *fake.rewritten.lock().unwrap() = true;
    let writes = *fake.writes.lock().unwrap();
    assert!(
        publish_checkpoint_archive(
            &fake,
            "audit",
            checkpoint,
            &archive,
            &keys,
            Some(&receipt.commit)
        )
        .await
        .is_err()
    );
    assert!(
        publish_checkpoint_archive(&fake, "audit", checkpoint, &archive, &keys, None)
            .await
            .is_err()
    );
    assert_eq!(*fake.writes.lock().unwrap(), writes);
}

#[tokio::test]
async fn invalid_or_untrusted_archive_fails_before_remote_access() {
    let (archive, keys) = archive_fixture(2, 0);
    let checkpoint = archive.checkpoints.last().unwrap();
    for case in 0..9 {
        let mut invalid = archive.clone();
        let mut trusted = keys.clone();
        match case {
            0 => invalid.ledger_id = "foreign".into(),
            1 => {
                invalid.checkpoints.pop();
            }
            2 => {
                invalid.refs.clear();
            }
            3 => {
                invalid.rows[0].objects.remove(0);
            }
            4 => {
                invalid.checkpoints.remove(0);
            }
            5 => invalid.rows[0].decision.actor = "tampered".into(),
            6 => {
                trusted[0].public_key_hex =
                    hex::encode(SigningKey::from_bytes(&[8; 32]).verifying_key().as_bytes())
            }
            7 => invalid.checkpoints.last_mut().unwrap().signature[0] ^= 1,
            8 => invalid.rows = vec![invalid.rows[0].clone(); MAX_ARCHIVE_ROWS + 1],
            _ => unreachable!(),
        }
        let fake = Fake::default();
        assert!(
            publish_checkpoint_archive(&fake, "audit", checkpoint, &invalid, &trusted, None)
                .await
                .is_err(),
            "case {case}"
        );
        assert_eq!(*fake.head_calls.lock().unwrap(), 0);
        assert_eq!(*fake.writes.lock().unwrap(), 0);
    }
    for root in [
        "../escape".to_owned(),
        "x".repeat(101),
        format!("{}/{}", "a".repeat(100), "b".repeat(28)),
    ] {
        let fake = Fake::default();
        assert!(
            publish_checkpoint_archive(&fake, &root, checkpoint, &archive, &keys, None)
                .await
                .is_err()
        );
        assert_eq!(*fake.head_calls.lock().unwrap(), 0);
    }
}

#[tokio::test]
async fn oversized_valid_archive_fails_before_writes() {
    let (archive, keys) = archive_fixture(30, 230_000);
    let checkpoint = archive.checkpoints.last().unwrap();
    archive
        .verify_with_key_history(&keys, Some(&checkpoint.digest))
        .unwrap();
    assert!(serde_json::to_vec(&archive).unwrap().len() as u64 > MAX_ARCHIVE_BYTES);
    let fake = Fake::default();
    let error = publish_checkpoint_archive(&fake, "audit", checkpoint, &archive, &keys, None)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("archive exceeds publication bound")
    );
    assert_eq!(*fake.head_calls.lock().unwrap(), 0);
    assert_eq!(*fake.writes.lock().unwrap(), 0);
}
#[tokio::test]
async fn publication_interruption_adoption_conflict_and_rewrite() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let cp = SignedCheckpoint::sign(
        Checkpoint {
            protocol_version: 1,
            ledger_id: "00000000-0000-4000-8000-000000000001".into(),
            last_sequence: 1,
            last_row_hash: "11".repeat(32),
            previous_checkpoint_digest: None,
            key_id: "fixture".into(),
        },
        &key,
    )
    .unwrap();
    let fake = Fake::default();
    *fake.fail_at.lock().unwrap() = Some(2);
    assert!(publish_checkpoint(&fake, "audit", &cp, None).await.is_err());
    *fake.fail_at.lock().unwrap() = None;
    let head = publish_checkpoint(&fake, "audit", &cp, None).await.unwrap();
    let count = *fake.writes.lock().unwrap();
    publish_checkpoint(&fake, "audit", &cp, Some(&head))
        .await
        .unwrap();
    assert_eq!(count, *fake.writes.lock().unwrap());
    *fake.rewritten.lock().unwrap() = true;
    assert!(
        publish_checkpoint(&fake, "audit", &cp, Some(&head))
            .await
            .is_err()
    );
    *fake.rewritten.lock().unwrap() = false;
    fake.files
        .lock()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()
        .push(0);
    assert!(
        publish_checkpoint(&fake, "audit", &cp, Some(&head))
            .await
            .is_err()
    );
    assert!(
        publish_checkpoint(&fake, "../escape", &cp, None)
            .await
            .is_err()
    );
    let conflict = format!(
        "audit/{}/{:020}.checkpoint",
        cp.checkpoint.ledger_id, cp.checkpoint.last_sequence
    );
    fake.files
        .lock()
        .unwrap()
        .insert(conflict, "22".repeat(32).into_bytes());
    assert!(publish_checkpoint(&fake, "audit", &cp, None).await.is_err());
    let mut invalid = cp;
    invalid.digest = "../escape".into();
    assert!(
        publish_checkpoint(&Fake::default(), "audit", &invalid, None)
            .await
            .is_err()
    );
}
