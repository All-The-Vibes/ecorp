use anyhow::{Result, bail};
use crony_audit::*;
use futures_util::future::BoxFuture;
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Default)]
struct Fake {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
    writes: Mutex<usize>,
    fail_at: Mutex<Option<usize>>,
    rewritten: Mutex<bool>,
}
impl PublicationTransport for Fake {
    fn head(&self) -> BoxFuture<'_, Result<String>> {
        Box::pin(async { Ok("head".into()) })
    }
    fn descends_from<'a>(&'a self, _old: &'a str, _new: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async { Ok(!*self.rewritten.lock().unwrap()) })
    }
    fn read<'a>(&'a self, path: &'a str, _head: &'a str) -> BoxFuture<'a, Result<Option<Vec<u8>>>> {
        Box::pin(async move { Ok(self.files.lock().unwrap().get(path).cloned()) })
    }
    fn create<'a>(&'a self, path: &'a str, body: &'a [u8]) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut count = self.writes.lock().unwrap();
            *count += 1;
            if *self.fail_at.lock().unwrap() == Some(*count) {
                bail!("interrupted transport")
            }
            let mut files = self.files.lock().unwrap();
            if files.contains_key(path) {
                bail!("conflict; never overwrite");
            }
            files.insert(path.into(), body.into());
            Ok(())
        })
    }
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
