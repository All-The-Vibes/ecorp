//! Native transaction regressions for credential-bound repository grants.
//! Synthetic SQLx metadata proves no GitHub effect or browser acceptance.
use super::*;

async fn enroll(
    store: &PgStore,
    input: &StartPullRequestPublicationInput,
    label: &str,
    repository: Option<&str>,
) -> (String, PublicationPublisherCredentialOutcome) {
    let hash = digest(&label);
    let outcome = store
        .create_publication_publisher_credential(
            input.corp_id,
            input.actor_id,
            &input.publisher_id,
            &hash,
            repository,
            Utc::now() + Duration::hours(1),
        )
        .await
        .unwrap();
    (hash, outcome)
}

async fn assert_denied<T>(store: &PgStore, before: &Value, result: Result<T>) {
    let error = result
        .err()
        .expect("repository grant must deny this operation");
    assert!(error.to_string().contains("forbidden"));
    // Never print persisted publication fencing tokens on a failed assertion.
    assert!(
        publication_state(store).await == *before,
        "denial must roll back"
    );
}

async fn assert_workload_denied(
    store: &PgStore,
    scope: &PublicationPublisherScope,
    id: Uuid,
    control: PublicationLeaseControl,
) {
    let before = publication_state(store).await;
    for operation in 0..5 {
        let result = match operation {
            0 => store
                .requested_publications_for_publisher(scope, None, 25)
                .await
                .map(|_| ()),
            1 => store
                .human_requested_publication_for_publisher(scope, id, None)
                .await
                .map(|_| ()),
            2 => store
                .human_requested_publication_context_for_publisher(scope, id)
                .await
                .map(|_| ()),
            3 => store
                .claim_human_requested_publication(scope, id, "denied-grant".into(), 300)
                .await
                .map(|_| ()),
            4 => store
                .human_requested_publication_for_publisher(scope, id, Some(control))
                .await
                .map(|_| ()),
            _ => unreachable!(),
        };
        assert_denied(store, &before, result).await;
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_repository_grant_is_enrolled_and_normalized(pool: PgPool) {
    let (store, _, _, input) = publication_fixture(pool).await;
    let (hash, grant) = enroll(
        &store,
        &input,
        "normalized repository grant",
        Some(" Fixture/Source "),
    )
    .await;
    assert_eq!(grant.repository.as_deref(), Some("fixture/source"));
    assert_eq!(grant.event.payload["repository"], "fixture/source");
    let identity = store
        .authenticate_publication_publisher(input.corp_id, &hash)
        .await
        .unwrap();
    assert_eq!(identity.publisher_id, input.publisher_id);
    assert_eq!(identity.repository.as_deref(), Some("fixture/source"));
    let persisted: Option<String> =
        sqlx::query_scalar("SELECT repository FROM publication_publisher_credentials WHERE id=$1")
            .bind(grant.credential_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(persisted, grant.repository);

    for repository in [
        "",
        "owner",
        "owner/repo/extra",
        "owner/*",
        "owner/repo?x",
        "owner/\u{00e9}",
    ] {
        let before = publication_state(&store).await;
        assert!(
            store
                .create_publication_publisher_credential(
                    input.corp_id,
                    input.actor_id,
                    &input.publisher_id,
                    &digest(&repository),
                    Some(repository),
                    Utc::now() + Duration::hours(1),
                )
                .await
                .is_err()
        );
        assert!(publication_state(&store).await == before);
    }
    let before = publication_state(&store).await;
    let result = store
        .create_publication_publisher_credential(
            input.corp_id,
            REVIEWER,
            &input.publisher_id,
            &digest(&"unprivileged repository enrollment"),
            Some("other/repository"),
            Utc::now() + Duration::hours(1),
        )
        .await;
    assert_denied(&store, &before, result).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_binds_repository_to_exact_credential(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    let (other_hash, _) = enroll(
        &store,
        &input,
        "same publisher other repository",
        Some("other/repository"),
    )
    .await;
    let (legacy_hash, _) = enroll(&store, &input, "same publisher legacy credential", None).await;
    let mut other = scope.clone();
    other.credential_hash = other_hash;
    let mut legacy = scope.clone();
    legacy.credential_hash = legacy_hash;
    let mut changed_selection = scope.clone();
    changed_selection.repository = "other/repository".into();
    let denied = [other.clone(), legacy, changed_selection];
    let before_claim = PublicationLeaseControl {
        publisher_token: Uuid::new_v4(),
        expected_version: queued.publication.version,
    };
    for selected in &denied {
        assert_workload_denied(&store, selected, queued.publication.id, before_claim).await;
    }

    // A legitimate grant for another repository has an empty queue and cannot
    // use a known ID to cross into this publication's repository.
    other.repository = "other/repository".into();
    assert!(
        store
            .requested_publications_for_publisher(&other, None, 25)
            .await
            .unwrap()
            .is_empty()
    );
    let before = publication_state(&store).await;
    assert!(
        store
            .human_requested_publication_context_for_publisher(&other, queued.publication.id)
            .await
            .is_err()
    );
    assert!(publication_state(&store).await == before);

    let mut normalized = scope.clone();
    normalized.repository = " FIXTURE/SOURCE ".into();
    assert_eq!(
        store
            .requested_publications_for_publisher(&normalized, None, 25)
            .await
            .unwrap(),
        [queued.publication.id]
    );
    assert!(
        store
            .human_requested_publication_context_for_publisher(&normalized, queued.publication.id)
            .await
            .is_ok()
    );
    let started = store
        .claim_human_requested_publication(
            &normalized,
            queued.publication.id,
            "granted-claim".into(),
            300,
        )
        .await
        .unwrap();
    let control = PublicationLeaseControl {
        publisher_token: started.publisher_token.unwrap(),
        expected_version: started.publication.version,
    };
    assert!(
        store
            .human_requested_publication_for_publisher(
                &normalized,
                queued.publication.id,
                Some(control)
            )
            .await
            .is_ok()
    );
    // Knowing the live token does not turn another credential into this grant.
    for selected in &denied {
        assert_workload_denied(&store, selected, queued.publication.id, control).await;
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_repository_grant_fences_effects_and_replays(pool: PgPool) {
    let (store, input, _) = queued_request(pool).await;
    let (other_hash, _) = enroll(
        &store,
        &input,
        "same publisher wrong grant for effects",
        Some("other/repository"),
    )
    .await;
    let mut other = input.clone();
    other.publisher_credential_hash = other_hash.clone();
    let before = publication_state(&store).await;
    assert_denied(
        &store,
        &before,
        store.start_pull_request_publication(other.clone()).await,
    )
    .await;
    let started = store
        .start_pull_request_publication(input.clone())
        .await
        .unwrap();
    let before = publication_state(&store).await;
    assert_denied(
        &store,
        &before,
        store.start_pull_request_publication(other.clone()).await,
    )
    .await;
    other.idempotency_key = "different-key-same-wrong-grant".into();
    assert_denied(
        &store,
        &before,
        store.start_pull_request_publication(other.clone()).await,
    )
    .await;

    let renewal = publication_renewal(&input, &started);
    let mut other_renewal = renewal.clone();
    other_renewal.publisher_credential_hash = other_hash.clone();
    assert_denied(
        &store,
        &before,
        store
            .renew_pull_request_publication(other_renewal.clone())
            .await,
    )
    .await;
    let renewed = store.renew_pull_request_publication(renewal).await.unwrap();
    let before = publication_state(&store).await;
    assert_denied(
        &store,
        &before,
        store.renew_pull_request_publication(other_renewal).await,
    )
    .await;

    let checkpoint = branch_checkpoint(&input, &renewed);
    let mut other_checkpoint = checkpoint.clone();
    other_checkpoint.publisher_credential_hash = other_hash;
    assert_denied(
        &store,
        &before,
        store
            .record_pull_request_publication_checkpoint(other_checkpoint.clone())
            .await,
    )
    .await;
    let pushed = store
        .record_pull_request_publication_checkpoint(checkpoint)
        .await
        .unwrap();
    let before = publication_state(&store).await;
    assert_denied(
        &store,
        &before,
        store
            .record_pull_request_publication_checkpoint(other_checkpoint)
            .await,
    )
    .await;

    let mut failure = branch_checkpoint(&input, &pushed);
    failure.checkpoint = PullRequestPublicationCheckpointInput::Failed {
        failure_detail: "Synthetic cleanup".into(),
    };
    let mut other_failure = failure.clone();
    other_failure.publisher_credential_hash = other.publisher_credential_hash.clone();
    assert_denied(
        &store,
        &before,
        store
            .record_pull_request_publication_checkpoint(other_failure.clone())
            .await,
    )
    .await;
    let failed = store
        .record_pull_request_publication_checkpoint(failure)
        .await
        .unwrap();
    assert!(failed.publisher_token.is_none());
    let before = publication_state(&store).await;
    assert_denied(
        &store,
        &before,
        store
            .record_pull_request_publication_checkpoint(other_failure)
            .await,
    )
    .await;
    other.idempotency_key = input.idempotency_key;
    assert_denied(
        &store,
        &before,
        store.start_pull_request_publication(other).await,
    )
    .await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_legacy_credential_requires_direct_human_path(pool: PgPool) {
    let (store, _, _, input) = publication_fixture(pool).await;
    let identity = store
        .authenticate_publication_publisher(input.corp_id, &input.publisher_credential_hash)
        .await
        .unwrap();
    assert!(identity.repository.is_none());
    let started = store
        .start_pull_request_publication(input.clone())
        .await
        .unwrap();
    let control = PublicationLeaseControl {
        publisher_token: started.publisher_token.unwrap(),
        expected_version: started.publication.version,
    };
    assert_workload_denied(
        &store,
        &publisher_scope(&input),
        started.publication.id,
        control,
    )
    .await;
    let renewed = store
        .renew_pull_request_publication(publication_renewal(&input, &started))
        .await
        .unwrap();
    let pushed = store
        .record_pull_request_publication_checkpoint(branch_checkpoint(&input, &renewed))
        .await
        .unwrap();
    assert_eq!(
        pushed.publication.state,
        PullRequestPublicationState::BranchPushed
    );
    assert!(pushed.publisher_token.is_some());
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_repository_grant_rechecks_revocation_and_expiry(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let started = store
        .start_pull_request_publication(input.clone())
        .await
        .unwrap();
    let control = PublicationLeaseControl {
        publisher_token: started.publisher_token.unwrap(),
        expected_version: started.publication.version,
    };
    for lifecycle in ["revoked", "expired"] {
        let (hash, grant) = enroll(&store, &input, lifecycle, Some(&input.target_repository)).await;
        // This authentication succeeds before the lifecycle change. Each later
        // native transaction must reject the now-stale identity independently.
        assert!(
            store
                .authenticate_publication_publisher(input.corp_id, &hash)
                .await
                .is_ok()
        );
        if lifecycle == "revoked" {
            store
                .revoke_publication_publisher_credential(
                    input.corp_id,
                    input.actor_id,
                    grant.credential_id,
                    "Synthetic repository grant revocation",
                )
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE publication_publisher_credentials SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' WHERE id=$1")
                .bind(grant.credential_id).execute(&store.pool).await.unwrap();
        }
        let mut changed = input.clone();
        changed.publisher_credential_hash = hash;
        assert_workload_denied(
            &store,
            &publisher_scope(&changed),
            queued.publication.id,
            control,
        )
        .await;
        let before = publication_state(&store).await;
        assert_denied(
            &store,
            &before,
            store.start_pull_request_publication(changed.clone()).await,
        )
        .await;
        assert_denied(
            &store,
            &before,
            store
                .renew_pull_request_publication(publication_renewal(&changed, &started))
                .await,
        )
        .await;
        assert_denied(
            &store,
            &before,
            store
                .record_pull_request_publication_checkpoint(branch_checkpoint(&changed, &started))
                .await,
        )
        .await;
    }
}
