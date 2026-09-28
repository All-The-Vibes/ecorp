//! A queued authorization can be rejected by native budget/checkpoint gates.
//! These real-transaction fixtures prove durable retirement, not GitHub effects.
use super::*;

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_stopped_run(pool: PgPool) {
    let detail = assert_stale_worker_request_rejected(
        pool,
        "UPDATE runs SET breaker_stage='stop' WHERE status='completed'",
    )
    .await;
    assert!(detail.contains("circuit breaker stage stop"), "{detail}");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_suspended_run(pool: PgPool) {
    let detail = assert_stale_worker_request_rejected(
        pool,
        "UPDATE runs SET breaker_stage='suspend' WHERE status='completed'",
    )
    .await;
    assert!(detail.contains("circuit breaker stage suspend"), "{detail}");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_current_loop_breaker(pool: PgPool) {
    let detail = assert_stale_worker_request_rejected(
        pool,
        "UPDATE runs SET no_progress_events=8 WHERE status='completed'",
    )
    .await;
    assert!(
        detail.contains("current budget or loop metrics"),
        "{detail}"
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_origin_loop_breaker(pool: PgPool) {
    let detail = assert_stale_worker_request_rejected(
        pool,
        "UPDATE runs SET repeated_tool_count=5 WHERE execution_mode='provider'",
    )
    .await;
    assert!(detail.contains("cannot waive a loop breaker"), "{detail}");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_withdrawn_budget_incident(pool: PgPool) {
    let detail =
        assert_stale_worker_request_rejected(pool, "DELETE FROM circuit_breaker_incidents").await;
    assert!(detail.contains("no native budget incident"), "{detail}");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_withdrawn_checkpoint(pool: PgPool) {
    let detail = assert_stale_worker_request_rejected(
        pool,
        "UPDATE events SET type='fixture.withdrawn' WHERE type='run.workspace_preserved'
         AND aggregate_id IN (SELECT id FROM runs WHERE execution_mode='provider')",
    )
    .await;
    assert!(detail.contains("no native preservation event"), "{detail}");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_withdrawn_termination(pool: PgPool) {
    let detail = assert_stale_worker_request_rejected(
        pool,
        "UPDATE events SET type='fixture.withdrawn' WHERE type='run.session_terminated'
         AND aggregate_id IN (SELECT id FROM runs WHERE execution_mode='provider')",
    )
    .await;
    assert!(
        detail.contains("provider termination is not proven"),
        "{detail}"
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_invalid_termination(pool: PgPool) {
    let detail = assert_stale_worker_request_rejected(
        pool,
        r#"UPDATE events SET payload=jsonb_set(payload,'{outcome}','"unsupported"')
           WHERE type='run.session_terminated'
             AND aggregate_id IN (SELECT id FROM runs WHERE execution_mode='provider')"#,
    )
    .await;
    assert!(
        detail.contains("invalid native provider-termination evidence"),
        "{detail}"
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_changed_checkpoint_proof(pool: PgPool) {
    let detail = assert_stale_worker_request_rejected(
        pool,
        "UPDATE events SET payload=jsonb_set(payload,'{source_checkpoint,head_commit}',to_jsonb(repeat('e',40)))
         WHERE type='run.workspace_preserved'
           AND aggregate_id IN (SELECT id FROM runs WHERE execution_mode='provider')",
    )
    .await;
    assert!(
        detail.contains("disagrees with its native preservation event"),
        "{detail}"
    );
}

async fn assert_pending(
    store: &PgStore,
    scope: &PublicationPublisherScope,
    queued: &PullRequestPublicationOutcome,
) {
    let saved = store
        .human_requested_publication_for_publisher(scope, queued.publication.id, None)
        .await
        .unwrap()
        .publication;
    assert_eq!(saved.version, queued.publication.version);
    assert_eq!(saved.attempt_count, 0);
    assert!(saved.failure_detail.is_none() && saved.publisher_lease_expires_at.is_none());
    assert_eq!(
        store
            .requested_publications_for_publisher(scope, None, 25)
            .await
            .unwrap(),
        [queued.publication.id]
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_keeps_checkpoint_database_failure_retryable(
    pool: PgPool,
) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    sqlx::query(
        "ALTER TABLE circuit_breaker_incidents RENAME TO temporarily_unavailable_incidents",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    let failed = store
        .claim_human_requested_publication(
            &scope,
            queued.publication.id,
            "checkpoint-unavailable".into(),
            300,
        )
        .await;
    sqlx::query(
        "ALTER TABLE temporarily_unavailable_incidents RENAME TO circuit_breaker_incidents",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(failed.unwrap_err().downcast_ref::<sqlx::Error>().is_some());
    assert_pending(&store, &scope, &queued).await;
    let recovered = store
        .claim_human_requested_publication(
            &scope,
            queued.publication.id,
            "checkpoint-unavailable".into(),
            300,
        )
        .await
        .unwrap();
    assert!(recovered.publisher_token.is_some());
}

async fn queued_corrected_request(
    pool: PgPool,
) -> (
    PgStore,
    StartPullRequestPublicationInput,
    PullRequestPublicationOutcome,
) {
    let (store, input) = correction_publication::human_request_fixture(pool).await;
    queue_request(store, input).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_invalid_correction_ancestry(pool: PgPool) {
    let (store, input, queued) = queued_corrected_request(pool).await;
    let detail = assert_request_retired(
        store,
        input,
        queued,
        "UPDATE mission_contract_revisions
         SET request=jsonb_set(request,'{expected_contract_version}','0')",
    )
    .await;
    assert!(detail.contains("invalid version ancestry"), "{detail}");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_retires_withdrawn_correction_event(pool: PgPool) {
    let (store, input, queued) = queued_corrected_request(pool).await;
    let detail = assert_request_retired(
        store,
        input,
        queued,
        "UPDATE events SET type='fixture.withdrawn' WHERE type='mission.contract_revised'",
    )
    .await;
    assert!(
        detail.contains("revision omitted its native event"),
        "{detail}"
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_keeps_correction_database_failure_retryable(
    pool: PgPool,
) {
    let (store, input, queued) = queued_corrected_request(pool).await;
    let scope = publisher_scope(&input);
    sqlx::query(
        "ALTER TABLE mission_contract_revisions RENAME TO temporarily_unavailable_revisions",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    let failed = store
        .claim_human_requested_publication(
            &scope,
            queued.publication.id,
            "correction-unavailable".into(),
            300,
        )
        .await;
    sqlx::query(
        "ALTER TABLE temporarily_unavailable_revisions RENAME TO mission_contract_revisions",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    let error = failed.unwrap_err();
    assert!(error.downcast_ref::<sqlx::Error>().is_some());
    assert!(error.downcast_ref::<admission::Denied>().is_none());
    assert_pending(&store, &scope, &queued).await;
    let recovered = store
        .claim_human_requested_publication(
            &scope,
            queued.publication.id,
            "correction-unavailable".into(),
            300,
        )
        .await
        .unwrap();
    assert!(recovered.publisher_token.is_some());
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_native_publication_worker_keeps_pending_audit_retryable(pool: PgPool) {
    let (store, input, queued) = queued_request(pool).await;
    let scope = publisher_scope(&input);
    sqlx::query("INSERT INTO state_audit_ledgers(corp_id,ledger_id,last_sequence) VALUES($1,$2,1)")
        .bind(input.corp_id)
        .bind(Uuid::new_v4())
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO state_audit_destinations(id,corp_id,kind,config,interval_seconds,workflow_gate)
                 VALUES($1,$2,'github','{}',60,'published')")
        .bind(Uuid::new_v4()).bind(input.corp_id).execute(&store.pool).await.unwrap();
    for key in ["audit-pending", "later-audit-poll"] {
        let error = store
            .claim_human_requested_publication(&scope, queued.publication.id, key.into(), 300)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("audit assurance workflow gate"));
        assert_pending(&store, &scope, &queued).await;
    }
    sqlx::query("UPDATE state_audit_destinations SET last_published_sequence=1 WHERE corp_id=$1")
        .bind(input.corp_id)
        .execute(&store.pool)
        .await
        .unwrap();
    let recovered = store
        .claim_human_requested_publication(
            &scope,
            queued.publication.id,
            "audit-pending".into(),
            300,
        )
        .await
        .unwrap();
    assert!(recovered.publisher_token.is_some());
}
