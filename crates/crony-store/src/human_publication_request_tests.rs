//! Real-migration store tests. These synthetic records grant no GitHub effect
//! authority and do not establish browser or native publisher acceptance.
use super::*;

async fn queued_request(
    pool: PgPool,
) -> (
    PgStore,
    StartPullRequestPublicationInput,
    PullRequestPublicationOutcome,
) {
    let (store, _, _, mut input) = publication_fixture(pool).await;
    let request = human_publication_request(&store, &input).await;
    let queued = store
        .request_pull_request_publication(request)
        .await
        .unwrap();
    input.effect_key = queued.publication.effect_key.clone();
    (store, input, queued)
}

fn publisher_scope(input: &StartPullRequestPublicationInput) -> PublicationPublisherScope {
    PublicationPublisherScope {
        corp_id: input.corp_id,
        repository: input.target_repository.clone(),
        publisher_id: input.publisher_id.clone(),
        credential_hash: input.publisher_credential_hash.clone(),
    }
}

fn assert_only_publisher_use_audited(
    before: &Value,
    after: &Value,
    scope: &PublicationPublisherScope,
) {
    let mut expected = before.clone();
    let credential = expected["publication"]["credentials"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|credential| {
            credential["corp_id"] == scope.corp_id.to_string()
                && credential["publisher_id"] == scope.publisher_id
                && credential["credential_hash"] == scope.credential_hash
        })
        .expect("fixture must contain the exact workload credential");
    let updated = after["publication"]["credentials"]
        .as_array()
        .unwrap()
        .iter()
        .find(|updated| updated["id"] == credential["id"])
        .expect("successful access must preserve the workload credential");
    let used = updated["last_used_at"]
        .as_str()
        .expect("successful access must audit credential use")
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    if let Some(previous) = credential["last_used_at"].as_str() {
        assert!(
            used >= previous.parse::<chrono::DateTime<Utc>>().unwrap(),
            "credential use audit must not move backwards"
        );
    }
    credential["last_used_at"] = updated["last_used_at"].clone();
    // Boolean comparison avoids printing publication fencing tokens on failure.
    assert!(
        *after == expected,
        "authorized reads may only audit the exact workload credential"
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_scopes_queue_and_readback(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    let id = queued.publication.id;
    store
        .create_publication_publisher_credential(
            CORP,
            OWNER,
            "unrelated-publication-worker",
            &digest(&"unrelated SQLx-only publisher credential"),
            Utc::now() + Duration::hours(1),
        )
        .await
        .unwrap();
    let before = publication_state(&store).await;
    assert_eq!(
        store
            .requested_publications_for_publisher(&scope, None, 1)
            .await
            .unwrap(),
        [id]
    );
    assert!(
        store
            .requested_publications_for_publisher(&scope, Some(id), 1)
            .await
            .unwrap()
            .is_empty()
    );
    assert_only_publisher_use_audited(&before, &publication_state(&store).await, &scope);
    let before = publication_state(&store).await;
    for limit in [0, 101] {
        assert!(
            store
                .requested_publications_for_publisher(&scope, None, limit)
                .await
                .is_err()
        );
        assert!(publication_state(&store).await == before);
    }
    for alteration in ["corp", "repository", "credential"] {
        let before = publication_state(&store).await;
        let mut other = scope.clone();
        match alteration {
            "corp" => other.corp_id = Uuid::new_v4(),
            "repository" => other.repository = "other/repository".into(),
            "credential" => other.credential_hash = digest(&"invalid publisher credential"),
            _ => unreachable!(),
        }
        let page = store
            .requested_publications_for_publisher(&other, None, 25)
            .await;
        if alteration == "repository" {
            assert!(page.unwrap().is_empty());
            assert_only_publisher_use_audited(&before, &publication_state(&store).await, &scope);
        } else {
            assert!(page.is_err());
            assert!(publication_state(&store).await == before);
        }
        // An authorized empty queue still audits credential use. Denied
        // readback and adoption must roll back against that fresh baseline.
        let before = publication_state(&store).await;
        assert!(
            store
                .human_requested_publication_for_publisher(&other, id, None)
                .await
                .is_err()
        );
        assert!(
            store
                .claim_human_requested_publication(&other, id, Uuid::new_v4().to_string(), 300)
                .await
                .is_err()
        );
        assert!(publication_state(&store).await == before);
    }
    let before = publication_state(&store).await;
    let read = store
        .human_requested_publication_for_publisher(&scope, id, None)
        .await
        .unwrap();
    assert_eq!(read.publication.id, id);
    assert_eq!(
        read.publication.authorization_snapshot,
        queued.publication.authorization_snapshot
    );
    assert_only_publisher_use_audited(&before, &publication_state(&store).await, &scope);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_reuses_claim_and_fences_artifact(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    let id = queued.publication.id;
    assert!(
        store
            .human_requested_publication_for_publisher(
                &scope,
                id,
                Some(PublicationLeaseControl {
                    publisher_token: Uuid::new_v4(),
                    expected_version: queued.publication.version,
                })
            )
            .await
            .is_err()
    );
    let started = store
        .claim_human_requested_publication(&scope, id, "worker-claim".into(), 300)
        .await
        .unwrap();
    assert_eq!(started.publication.id, id);
    assert_eq!(started.publication.attempt_count, 1);
    assert_eq!(
        started.publication.authorization_snapshot,
        queued.publication.authorization_snapshot
    );
    let control = PublicationLeaseControl {
        publisher_token: started.publisher_token.unwrap(),
        expected_version: started.publication.version,
    };
    assert!(
        store
            .human_requested_publication_for_publisher(&scope, id, Some(control))
            .await
            .is_ok()
    );
    assert!(
        store
            .requested_publications_for_publisher(&scope, None, 25)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .human_requested_publication_for_publisher(
                &scope,
                id,
                Some(PublicationLeaseControl {
                    expected_version: control.expected_version - 1,
                    ..control
                })
            )
            .await
            .is_err()
    );
    sqlx::query("UPDATE actors SET role='member' WHERE id=$1")
        .bind(OWNER)
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(
        store
            .human_requested_publication_for_publisher(&scope, id, Some(control))
            .await
            .is_err()
    );
    assert!(
        store
            .claim_human_requested_publication(&scope, id, "after-revocation".into(), 300)
            .await
            .is_err()
    );
    // Non-authorizing readback still supports the native failure-only path.
    assert!(
        store
            .human_requested_publication_for_publisher(&scope, id, None)
            .await
            .is_ok()
    );
    let mut failure = branch_checkpoint(&input, &started);
    failure.checkpoint = PullRequestPublicationCheckpointInput::Failed {
        failure_detail: "Human authority revoked".into(),
    };
    store
        .record_pull_request_publication_checkpoint(failure)
        .await
        .unwrap();
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
async fn issue219_native_publication_worker_cannot_adopt_direct_cli_intent(pool: PgPool) {
    let (store, _, _, input) = publication_fixture(pool).await;
    let scope = publisher_scope(&input);
    let direct = store.start_pull_request_publication(input).await.unwrap();
    let before = publication_state(&store).await;
    assert!(
        store
            .requested_publications_for_publisher(&scope, None, 25)
            .await
            .unwrap()
            .is_empty()
    );
    assert_only_publisher_use_audited(&before, &publication_state(&store).await, &scope);
    let before = publication_state(&store).await;
    assert!(
        store
            .human_requested_publication_for_publisher(&scope, direct.publication.id, None)
            .await
            .is_err()
    );
    assert!(
        store
            .claim_human_requested_publication(
                &scope,
                direct.publication.id,
                "not-human-intent".into(),
                300
            )
            .await
            .is_err()
    );
    assert!(publication_state(&store).await == before);
}

fn branch_checkpoint(
    input: &StartPullRequestPublicationInput,
    started: &PullRequestPublicationOutcome,
) -> RecordPullRequestPublicationCheckpointInput {
    RecordPullRequestPublicationCheckpointInput {
        corp_id: input.corp_id,
        publication_id: started.publication.id,
        actor_id: input.actor_id,
        publisher_id: input.publisher_id.clone(),
        publisher_credential_hash: input.publisher_credential_hash.clone(),
        publisher_token: started.publisher_token.unwrap(),
        expected_version: started.publication.version,
        idempotency_key: Uuid::new_v4().to_string(),
        checkpoint: PullRequestPublicationCheckpointInput::BranchPushed {
            commit_sha: started.publication.commit_sha.clone(),
        },
    }
}

async fn reject_effect_authority(
    store: &PgStore,
    input: &StartPullRequestPublicationInput,
    started: &PullRequestPublicationOutcome,
) {
    let before = publication_state(store).await;
    for (operation, result) in [
        (
            "start replay",
            store.start_pull_request_publication(input.clone()).await,
        ),
        (
            "renewal",
            store
                .renew_pull_request_publication(publication_renewal(input, started))
                .await,
        ),
        (
            "effect checkpoint",
            store
                .record_pull_request_publication_checkpoint(branch_checkpoint(input, started))
                .await,
        ),
    ] {
        assert!(
            result.is_err(),
            "{operation} must reject stale human intent"
        );
        assert_eq!(
            publication_state(store).await,
            before,
            "{operation} must roll back"
        );
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_claim_preserves_intent_and_factory_state(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let mut competitor = input.clone();
    competitor.publisher_id = "issue219-second-publisher".into();
    competitor.publisher_credential_hash = digest(&"issue219 SQLx second publisher");
    competitor.idempotency_key = Uuid::new_v4().to_string();
    store
        .create_publication_publisher_credential(
            CORP,
            OWNER,
            &competitor.publisher_id,
            &competitor.publisher_credential_hash,
            Utc::now() + Duration::hours(1),
        )
        .await
        .unwrap();
    let before = publication_state(&store).await;
    let (first, second) = tokio::join!(
        store.start_pull_request_publication(input.clone()),
        store.start_pull_request_publication(competitor.clone())
    );
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_eq!(first.publication.id, queued.publication.id);
    assert_eq!(second.publication.id, queued.publication.id);
    assert_ne!(
        first.publisher_token.is_some(),
        second.publisher_token.is_some()
    );
    assert_ne!(first.busy, second.busy);
    let after = publication_state(&store).await;
    assert_eq!(
        after["item"]["state"], "publishing",
        "the first claim must advance Factory atomically"
    );
    let attempts = after["publication"]["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(
        attempts[0]["authorization_snapshot"], queued.publication.authorization_snapshot,
        "delivery must preserve the original human decision and timestamp"
    );
    assert_eq!(
        attempts[0]["authorization_id"],
        json!(queued.publication.authorization_id)
    );
    assert_publication_preserves_models(&before, &after);
    let (owner, started) = if first.publisher_token.is_some() {
        (input, first)
    } else {
        (competitor, second)
    };
    let replay = store.start_pull_request_publication(owner).await.unwrap();
    assert_eq!(replay.publisher_token, started.publisher_token);
    assert_eq!(replay.publication.attempt_count, 1);
    assert!(replay.replayed);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_claim_rejects_substituted_human_authority(pool: PgPool) {
    let (store, input, _) = queued_request(pool).await;
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO actors(id,corp_id,name,kind,role) VALUES($1,$2,'Other publisher authorizer','human','admin')")
        .bind(other).bind(CORP).execute(&store.pool).await.unwrap();
    sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
        .bind(ROOM)
        .bind(other)
        .execute(&store.pool)
        .await
        .unwrap();
    let before = publication_state(&store).await;
    for altered in ["authorization", "reason", "actor"] {
        let mut candidate = input.clone();
        match altered {
            "authorization" => candidate.authorization_id = Uuid::new_v4(),
            "reason" => candidate.authorization_reason = "Another unrecorded decision".into(),
            "actor" => {
                candidate.actor_id = other;
                candidate.actor_role = "admin".into();
            }
            _ => unreachable!(),
        }
        let result = store.start_pull_request_publication(candidate).await;
        assert!(
            result.is_err(),
            "a publisher must not replace the saved human {altered}"
        );
        assert_eq!(publication_state(&store).await, before);
    }
    assert!(
        store
            .start_pull_request_publication(input)
            .await
            .unwrap()
            .publisher_token
            .is_some()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_claim_rechecks_exact_saved_policy(pool: PgPool) {
    let (store, input, _) = queued_request(pool).await;
    sqlx::query("UPDATE factory_work_items SET policy=policy || '{\"human_request_revision\":2}'::jsonb WHERE id=$1 AND corp_id=$2")
        .bind(ITEM).bind(CORP).execute(&store.pool).await.unwrap();
    let before = publication_state(&store).await;
    let result = store.start_pull_request_publication(input).await;
    assert!(
        result.is_err(),
        "a newly allowed policy still requires a fresh matching human intent"
    );
    assert_eq!(publication_state(&store).await, before);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_live_authority_revocation_allows_only_failure_cleanup(
    pool: PgPool,
) {
    let (store, input, _) = queued_request(pool).await;
    let started = store
        .start_pull_request_publication(input.clone())
        .await
        .unwrap();
    sqlx::query("UPDATE factory_work_items SET policy=policy || '{\"human_request_revision\":2}'::jsonb WHERE id=$1 AND corp_id=$2")
        .bind(ITEM).bind(CORP).execute(&store.pool).await.unwrap();
    reject_effect_authority(&store, &input, &started).await;
    let before = publication_state(&store).await;
    let mut failure = branch_checkpoint(&input, &started);
    failure.checkpoint = PullRequestPublicationCheckpointInput::Failed {
        failure_detail: "Saved human intent no longer matches current policy".into(),
    };
    let recorded = store
        .record_pull_request_publication_checkpoint(failure.clone())
        .await
        .unwrap();
    assert!(recorded.publisher_token.is_none());
    let after = publication_state(&store).await;
    assert_eq!(after["item"], before["item"]);
    assert_eq!(after["publication"]["attempts"][0]["state"], "failed");
    let replay = store
        .record_pull_request_publication_checkpoint(failure)
        .await
        .unwrap();
    assert!(replay.replayed && replay.publisher_token.is_none());
    let readback = store.start_pull_request_publication(input).await.unwrap();
    assert!(
        readback.replayed && readback.publisher_token.is_none(),
        "tokenless readback grants no effects"
    );
    assert_publication_preserves_models(&before, &after);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_rejects_missing_or_malformed_human_provenance(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    for live in [false, true] {
        let started = if live {
            Some(
                store
                    .start_pull_request_publication(input.clone())
                    .await
                    .unwrap(),
            )
        } else {
            None
        };
        for alteration in [
            "missing",
            "malformed",
            "wrong_kind",
            "wrong_actor",
            "missing_operation",
            "missing_both",
        ] {
            let original_operation: Value = sqlx::query_scalar("SELECT to_jsonb(o) FROM pull_request_publication_operations o WHERE corp_id=$1 AND idempotency_key=$2")
                .bind(CORP).bind(&queued.publication.idempotency_key).fetch_one(&store.pool).await.unwrap();
            let mut provenance = queued.publication.provenance.clone();
            match alteration {
                "missing" => {
                    provenance.as_object_mut().unwrap().remove("intent");
                }
                "malformed" => provenance["intent"] = json!("invalid"),
                "wrong_kind" => provenance["intent"]["kind"] = json!("machine_accepted"),
                "wrong_actor" => provenance["intent"]["actor_id"] = json!(REVIEWER),
                "missing_operation" | "missing_both" => {
                    if alteration == "missing_both" {
                        provenance.as_object_mut().unwrap().remove("intent");
                    }
                    sqlx::query("DELETE FROM pull_request_publication_operations WHERE corp_id=$1 AND idempotency_key=$2")
                        .bind(CORP).bind(&queued.publication.idempotency_key).execute(&store.pool).await.unwrap();
                }
                _ => unreachable!(),
            }
            sqlx::query(
                "UPDATE pull_request_publications SET provenance=$1 WHERE id=$2 AND corp_id=$3",
            )
            .bind(provenance)
            .bind(queued.publication.id)
            .bind(CORP)
            .execute(&store.pool)
            .await
            .unwrap();
            if let Some(started) = &started {
                reject_effect_authority(&store, &input, started).await;
            } else {
                let before = publication_state(&store).await;
                let result = store.start_pull_request_publication(input.clone()).await;
                assert!(
                    result.is_err(),
                    "claim must reject {alteration} human provenance"
                );
                assert_eq!(publication_state(&store).await, before);
            }
            sqlx::query(
                "UPDATE pull_request_publications SET provenance=$1 WHERE id=$2 AND corp_id=$3",
            )
            .bind(&queued.publication.provenance)
            .bind(queued.publication.id)
            .bind(CORP)
            .execute(&store.pool)
            .await
            .unwrap();
            if matches!(alteration, "missing_operation" | "missing_both") {
                sqlx::query("INSERT INTO pull_request_publication_operations SELECT * FROM jsonb_populate_record(NULL::pull_request_publication_operations,$1)")
                    .bind(original_operation).execute(&store.pool).await.unwrap();
            }
        }
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_rejects_replaced_attempt_authorization(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let started = store
        .start_pull_request_publication(input.clone())
        .await
        .unwrap();
    for altered in ["authorization", "snapshot"] {
        let mut snapshot = queued.publication.authorization_snapshot.clone();
        let authorization_id = if altered == "authorization" {
            Uuid::new_v4()
        } else {
            queued.publication.authorization_id
        };
        if altered == "snapshot" {
            snapshot["reason"] = json!("Unrecorded replacement approval");
        }
        sqlx::query("UPDATE pull_request_publication_attempts SET authorization_id=$1,authorization_snapshot=$2 WHERE publication_id=$3 AND corp_id=$4")
            .bind(authorization_id).bind(snapshot).bind(queued.publication.id).bind(CORP).execute(&store.pool).await.unwrap();
        reject_effect_authority(&store, &input, &started).await;
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_human_revocation_fences_claim_and_replay(pool: PgPool) {
    let (store, input, _) = queued_request(pool).await;
    for live in [false, true] {
        let started = if live {
            Some(
                store
                    .start_pull_request_publication(input.clone())
                    .await
                    .unwrap(),
            )
        } else {
            None
        };
        for (changed, restored) in [
            (
                "UPDATE actors SET role='member' WHERE id=$1",
                "UPDATE actors SET role='owner' WHERE id=$1",
            ),
            (
                "DELETE FROM room_memberships WHERE actor_id=$1",
                "INSERT INTO room_memberships(room_id,actor_id) VALUES('00000000-0000-0000-0000-000000000006',$1)",
            ),
        ] {
            sqlx::query(changed)
                .bind(OWNER)
                .execute(&store.pool)
                .await
                .unwrap();
            if let Some(started) = &started {
                reject_effect_authority(&store, &input, started).await;
            } else {
                let before = publication_state(&store).await;
                assert!(
                    store
                        .start_pull_request_publication(input.clone())
                        .await
                        .is_err()
                );
                assert_eq!(publication_state(&store).await, before);
            }
            sqlx::query(restored)
                .bind(OWNER)
                .execute(&store.pool)
                .await
                .unwrap();
        }
    }
}
