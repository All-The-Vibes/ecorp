//! Observe real PostgreSQL waiters while exercising the public refresh APIs.
use super::*;
use std::{future::Future, time::Duration};

async fn ledger_before_corp(
    store: &PgStore,
    operation: impl Future<Output = anyhow::Result<FactoryBaseRefreshResponse>> + Send + 'static,
) -> FactoryBaseRefreshResponse {
    // Represent an ordinary audited transaction that already owns the ledger
    // and is about to acquire the native Corp budget lock.
    let mut gate = store.pool.begin().await.unwrap();
    let gate_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await
        .unwrap();
    let _: Uuid =
        sqlx::query_scalar("SELECT ledger_id FROM state_audit_ledgers WHERE corp_id=$1 FOR UPDATE")
            .bind(CORP)
            .fetch_one(&mut *gate)
            .await
            .unwrap();
    let refresh = tokio::spawn(operation);
    let (refresh_pid, waiting_query): (i32, String) =
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(waiter) = sqlx::query_as(
                    "SELECT pid,query FROM pg_stat_activity WHERE datname=current_database()
                     AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
                )
                .bind(gate_pid)
                .fetch_optional(&store.pool)
                .await
                .unwrap()
                {
                    break waiter;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("refresh must reach the held audit ledger");
    eprintln!(
        "Observed refresh PID {refresh_pid} waiting behind ledger holder {gate_pid}: {waiting_query}"
    );

    // With the inverted order, refresh owns the Corp lock while waiting on our
    // ledger, producing a real PostgreSQL deadlock here. Release the gate and
    // join the operation before checking either result so both paths clean up.
    let corp_lock = tokio::time::timeout(
        Duration::from_secs(10),
        aggregate_breaker::lock_corp_tx(&mut gate, CORP),
    )
    .await;
    eprintln!("Audit ledger holder's native Corp lock result: {corp_lock:?}");
    gate.rollback().await.unwrap();
    let response = tokio::time::timeout(Duration::from_secs(10), refresh)
        .await
        .expect("refresh must finish after the ledger holder releases its locks")
        .expect("refresh task must not panic");
    eprintln!(
        "Refresh result after release: {:?}",
        response
            .as_ref()
            .map(|result| (&result.refresh.state, result.replayed))
    );
    assert!(waiting_query.contains("FROM state_audit_ledgers"));
    corp_lock
        .expect("audit ledger holder must not time out on the native Corp lock")
        .expect("audit ledger holder must not deadlock with refresh");
    response.expect("refresh must complete without becoming a deadlock victim")
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_authorization_locks_ledger_before_corp(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    f.store
        .initialize_state_audit(CORP, OWNER, Uuid::new_v4())
        .await
        .unwrap();
    f.store.cover_mission(CORP, OWNER, MISSION).await.unwrap();
    advance_connection(&f).await;
    let request = request_refresh(&f).await;
    let store = f.store.clone();
    let response = ledger_before_corp(&f.store, async move {
        store
            .authorize_factory_base_refresh(CORP, ITEM, request)
            .await
    })
    .await;
    assert_eq!(response.refresh.state, "pending");
    let covered: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM state_audit_coverage WHERE corp_id=$1 AND mission_id=ANY($2)",
    )
    .bind(CORP)
    .bind(vec![MISSION, response.refresh.mission_id])
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(covered, 2);
}

async fn secondary_coverage_settlement(pool: PgPool, adopt: bool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    if adopt {
        verify_refresh(&f, &refresh).await;
        approve_refresh(&f, &refresh).await;
    } else {
        let command = refresh_command(&f, &refresh).await;
        f.store
            .fail_base_refresh_before_dispatch(
                &command,
                "SQLx fixture: native transport never started",
            )
            .await
            .unwrap();
    }
    // The original mission is deliberately not covered. The replacement's
    // independently enabled ledger still has to precede all native locks.
    f.store
        .initialize_state_audit(CORP, OWNER, Uuid::new_v4())
        .await
        .unwrap();
    f.store
        .cover_mission(CORP, OWNER, refresh.refresh.mission_id)
        .await
        .unwrap();
    let original_covered: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM state_audit_coverage WHERE corp_id=$1 AND mission_id=$2)",
    )
    .bind(CORP)
    .bind(MISSION)
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert!(!original_covered);
    let request = settlement(&f).await;
    let store = f.store.clone();
    let response = ledger_before_corp(&f.store, async move {
        store
            .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, request, adopt)
            .await
    })
    .await;
    assert_eq!(
        response.refresh.state,
        if adopt { "adopted" } else { "abandoned" }
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_adoption_locks_secondary_ledger_before_corp(pool: PgPool) {
    secondary_coverage_settlement(pool, true).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_abandonment_locks_secondary_ledger_before_corp(pool: PgPool) {
    secondary_coverage_settlement(pool, false).await;
}
