//! Broken persisted intent must not consume every watcher poll. These native
//! transactions prove rejection and rollback; they perform no remote effects.
use super::*;

const MALFORM_INTENT: &str =
    "UPDATE pull_request_publications SET provenance=provenance #- '{intent,preview}'";

async fn assert_saved_intent_retired(
    store: &PgStore,
    input: &StartPullRequestPublicationInput,
    previous: &PullRequestPublicationOutcome,
) -> String {
    let scope = publisher_scope(input);
    let id = previous.publication.id;
    for alteration in ["repository", "credential", "corp"] {
        let mut other = scope.clone();
        match alteration {
            "repository" => other.repository = "other/repository".into(),
            "credential" => other.credential_hash = digest(&"wrong saved-intent credential"),
            "corp" => other.corp_id = Uuid::new_v4(),
            _ => unreachable!(),
        }
        let before = publication_state(store).await;
        assert!(
            store
                .claim_human_requested_publication(&other, id, "invalid-intent".into(), 300)
                .await
                .is_err()
        );
        assert!(publication_state(store).await == before);
    }
    let before = publication_state(store).await;
    let rejected = store
        .claim_human_requested_publication(&scope, id, "invalid-intent".into(), 300)
        .await
        .expect("invalid saved intent must become one durable, tokenless rejection");
    assert!(rejected.publisher_token.is_none() && !rejected.busy && !rejected.replayed);
    assert_eq!(
        rejected.publication.version,
        previous.publication.version + 1
    );
    assert_eq!(rejected.publication.state, previous.publication.state);
    assert_eq!(
        rejected.publication.attempt_count,
        previous.publication.attempt_count
    );
    assert!(
        rejected.publication.publisher_id.is_none()
            && rejected.publication.publisher_lease_expires_at.is_none()
    );
    assert_eq!(rejected.events.len(), 1);
    let after = publication_state(store).await;
    assert_eq!(
        after["publication"]["rows"][0]["provenance"],
        before["publication"]["rows"][0]["provenance"],
        "rejection must preserve the actual invalid evidence"
    );
    assert_eq!(
        after["publication"]["rows"][0]["authorization_snapshot"],
        before["publication"]["rows"][0]["authorization_snapshot"]
    );
    assert!(
        after["publication"]["operations"] == before["publication"]["operations"],
        "invalid intent cannot manufacture a valid start operation"
    );
    assert_publication_preserves_models(&before, &after);
    for key in ["invalid-intent", "later-invalid-intent-poll"] {
        let before = publication_state(store).await;
        let replay = store
            .claim_human_requested_publication(&scope, id, key.into(), 300)
            .await
            .unwrap();
        assert!(replay.replayed && !replay.busy && replay.publisher_token.is_none());
        assert_eq!(replay.publication.version, rejected.publication.version);
        assert!(replay.events.is_empty());
        assert_only_publisher_use_audited(&before, &publication_state(store).await, &scope);
    }
    assert!(
        store
            .requested_publications_for_publisher(&scope, None, 25)
            .await
            .unwrap()
            .is_empty()
    );
    rejected.publication.failure_detail.unwrap()
}

macro_rules! saved_intent_denial {
    ($name:ident, $detail:literal, $($change:expr),+ $(,)?) => {
        #[sqlx::test(migrations = "../../db/migrations")]
        #[ignore = "requires explicitly owned disposable PostgreSQL"]
        async fn $name(pool: PgPool) {
            let (store, input, queued) = queued_request(pool).await;
            for change in [$($change),+] {
                sqlx::query(change).execute(&store.pool).await.unwrap();
            }
            let detail = assert_saved_intent_retired(&store, &input, &queued).await;
            assert!(detail.contains($detail), "{detail}");
        }
    };
}

saved_intent_denial!(
    issue219_native_publication_saved_intent_malformed,
    "malformed human publication request provenance",
    MALFORM_INTENT,
);
saved_intent_denial!(
    issue219_native_publication_saved_intent_missing_operation,
    "human publication request operation is missing",
    "DELETE FROM pull_request_publication_operations WHERE operation='request'",
);
saved_intent_denial!(
    issue219_native_publication_saved_intent_operation_mismatch,
    "idempotency key was reused for a different operation",
    r#"UPDATE pull_request_publication_operations
       SET request=jsonb_set(request,'{actor_role}','"admin"') WHERE operation='request'"#,
);
saved_intent_denial!(
    issue219_native_publication_saved_intent_actor_mismatch,
    "does not match its durable authority and plan",
    "UPDATE pull_request_publications
     SET provenance=jsonb_set(provenance,'{intent,actor_id}',to_jsonb(gen_random_uuid()::text))",
    "UPDATE pull_request_publication_operations operation
     SET request=publication.provenance->'intent' FROM pull_request_publications publication
     WHERE operation.publication_id=publication.id AND operation.operation='request'",
);
saved_intent_denial!(
    issue219_native_publication_saved_intent_plan_mismatch,
    "does not match its durable authority and plan",
    r#"UPDATE pull_request_publications
       SET provenance=jsonb_set(provenance,'{intent,preview,plan,title}','"Unreviewed replacement"')"#,
    "UPDATE pull_request_publication_operations operation
     SET request=publication.provenance->'intent' FROM pull_request_publications publication
     WHERE operation.publication_id=publication.id AND operation.operation='request'",
);
saved_intent_denial!(
    issue219_native_publication_saved_intent_invalid_authorization_timestamp,
    "authorization omitted its timestamp",
    "UPDATE pull_request_publications
     SET authorization_snapshot=authorization_snapshot - 'authorized_at'",
);

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_saved_intent_preserves_live_lease(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    let started = store
        .claim_human_requested_publication(
            &scope,
            queued.publication.id,
            "live-before-corruption".into(),
            300,
        )
        .await
        .unwrap();
    sqlx::query(MALFORM_INTENT)
        .execute(&store.pool)
        .await
        .unwrap();
    let before = publication_state(&store).await;
    assert!(
        store
            .claim_human_requested_publication(
                &scope,
                queued.publication.id,
                "live-after-corruption".into(),
                300,
            )
            .await
            .is_err()
    );
    assert!(publication_state(&store).await == before);
    sqlx::query(
        "UPDATE pull_request_publications
         SET publisher_lease_expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(queued.publication.id)
    .execute(&store.pool)
    .await
    .unwrap();
    assert_saved_intent_retired(&store, &input, &started).await;
    let attempt: String = sqlx::query_scalar(
        "SELECT state FROM pull_request_publication_attempts WHERE publication_id=$1",
    )
    .bind(queued.publication.id)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(attempt, "failed");
    assert!(
        store
            .record_pull_request_publication_checkpoint(branch_checkpoint(&input, &started))
            .await
            .is_err()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_saved_intent_operation_database_failure(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    let before = publication_state(&store).await;
    sqlx::query("ALTER TABLE pull_request_publication_operations RENAME TO unavailable_operations")
        .execute(&store.pool)
        .await
        .unwrap();
    let failed = store
        .claim_human_requested_publication(
            &scope,
            queued.publication.id,
            "unavailable-intent".into(),
            300,
        )
        .await
        .unwrap_err();
    sqlx::query("ALTER TABLE unavailable_operations RENAME TO pull_request_publication_operations")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(failed.downcast_ref::<sqlx::Error>().is_some());
    assert!(failed.downcast_ref::<admission::Denied>().is_none());
    assert!(publication_state(&store).await == before);
    assert!(
        store
            .claim_human_requested_publication(
                &scope,
                queued.publication.id,
                "unavailable-intent".into(),
                300,
            )
            .await
            .unwrap()
            .publisher_token
            .is_some()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_saved_intent_event_failure_rolls_back(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    sqlx::query(MALFORM_INTENT)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE FUNCTION reject_fixture_failure_event() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.type='factory.publication_failed' THEN
         RAISE EXCEPTION 'fixture event storage unavailable'; END IF; RETURN NEW; END $$",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_fixture_failure_event BEFORE INSERT ON events
         FOR EACH ROW EXECUTE FUNCTION reject_fixture_failure_event()",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    let before = publication_state(&store).await;
    let failed = store
        .claim_human_requested_publication(
            &scope,
            queued.publication.id,
            "unavailable-event".into(),
            300,
        )
        .await
        .unwrap_err();
    assert!(
        failed.downcast_ref::<sqlx::Error>().is_some(),
        "the genuine failure-event write must be attempted"
    );
    assert!(publication_state(&store).await == before);
    sqlx::query("DROP TRIGGER reject_fixture_failure_event ON events")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_saved_intent_retired(&store, &input, &queued).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_saved_intent_respects_operation_collision(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    sqlx::query(MALFORM_INTENT)
        .execute(&store.pool)
        .await
        .unwrap();
    let before = publication_state(&store).await;
    assert!(
        store
            .claim_human_requested_publication(
                &scope,
                queued.publication.id,
                queued.publication.idempotency_key.clone(),
                300,
            )
            .await
            .is_err(),
        "a claim cannot reuse the original human request operation key"
    );
    assert!(publication_state(&store).await == before);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_saved_intent_retires_existing_watcher_key(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    let id = queued.publication.id;
    let key = "same-watcher-before-corruption";
    let started = store
        .claim_human_requested_publication(&scope, id, key.into(), 300)
        .await
        .unwrap();
    sqlx::query(MALFORM_INTENT)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE pull_request_publications
         SET publisher_lease_expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&store.pool)
    .await
    .unwrap();
    let before = publication_state(&store).await;
    assert!(
        store
            .claim_human_requested_publication(&scope, id, key.into(), 301)
            .await
            .is_err(),
        "an existing claim key still binds its caller's lease request"
    );
    assert!(publication_state(&store).await == before);
    let rejected = store
        .claim_human_requested_publication(&scope, id, key.into(), 300)
        .await
        .unwrap();
    assert!(rejected.publisher_token.is_none() && !rejected.busy && !rejected.replayed);
    assert!(rejected.publication.failure_detail.is_some());
    assert_eq!(
        rejected.publication.version,
        started.publication.version + 1
    );
    assert_eq!(rejected.events.len(), 1);
    let after = publication_state(&store).await;
    assert!(before["publication"]["operations"] == after["publication"]["operations"]);
    let replay = store
        .claim_human_requested_publication(&scope, id, key.into(), 300)
        .await
        .unwrap();
    assert!(replay.publisher_token.is_none() && replay.replayed && replay.events.is_empty());
    assert_eq!(replay.publication.version, rejected.publication.version);
    assert_only_publisher_use_audited(&after, &publication_state(&store).await, &scope);
    assert!(
        store
            .requested_publications_for_publisher(&scope, None, 25)
            .await
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_saved_intent_rechecks_after_native_lock(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    let worker_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(
            store
                .pool
                .connect_options()
                .as_ref()
                .clone()
                .application_name("issue219-saved-intent-race"),
        )
        .await
        .unwrap();
    let mut blocker = store.pool.begin().await.unwrap();
    lock_factory_keys_tx(
        &mut blocker,
        &[format!(
            "publication:branch:{}:{}:{}",
            input.corp_id, input.target_repository, input.branch
        )],
    )
    .await
    .unwrap();
    let worker = PgStore {
        pool: worker_pool.clone(),
    };
    let id = queued.publication.id;
    let claim = tokio::spawn(async move {
        worker
            .claim_human_requested_publication(&scope, id, "intent-lock-race".into(), 300)
            .await
    });
    wait_for_publication_lock(&store.pool, "issue219-saved-intent-race").await;
    sqlx::query(MALFORM_INTENT)
        .execute(&mut *blocker)
        .await
        .unwrap();
    blocker.commit().await.unwrap();
    let rejected = tokio::time::timeout(std::time::Duration::from_secs(20), claim)
        .await
        .unwrap()
        .unwrap()
        .expect("the locked reread must durably reject replaced provenance");
    assert!(rejected.publisher_token.is_none());
    assert!(rejected.publication.failure_detail.is_some());
    assert_eq!(rejected.publication.attempt_count, 0);
    assert_eq!(rejected.events.len(), 1);
    assert!(
        store
            .requested_publications_for_publisher(&publisher_scope(&input), None, 25)
            .await
            .unwrap()
            .is_empty()
    );
    worker_pool.close().await;
}
