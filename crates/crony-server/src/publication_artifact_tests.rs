//! Exercise the real HTTP artifact route while PostgreSQL stalls its artifact
//! lookup. Source metadata is synthetic and the object is deliberately absent:
//! reaching object verification returns 500, never a successful source export.
use super::*;
use std::time::Duration;

fn artifact_request(fixture: &Fixture, claim: &Value) -> reqwest::RequestBuilder {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap()
        .post(format!(
            "{}/api/corps/{}/factory/publisher/publications/{}/artifact",
            fixture.base, fixture.ids.corp_id, fixture.publication_id
        ))
        .header(
            "x-crony-publication-publisher-credential",
            &fixture.credential,
        )
        .json(&json!({
            "repository": REPOSITORY,
            "publisher_token": claim["publisher_token"],
            "expected_version": claim["publication"]["version"],
        }))
}

async fn wait_for_artifact_lookup(pool: &PgPool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                 WHERE datname = current_database() AND wait_event_type = 'Lock'
                   AND query LIKE '%FROM artifacts artifact%'
                   AND query LIKE '%JOIN room_memberships membership%')",
            )
            .fetch_one(pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("HTTP request did not reach the controlled artifact lookup");
}

async fn assert_authority_change_serialized(pool: PgPool, change: &str) {
    let fixture = Fixture::new(pool).await.unwrap();
    let claim = fixture.claim("artifact-serialization").await;
    let (query, id) = match change {
        "credential" => (
            "UPDATE publication_publisher_credentials SET revoked_at=clock_timestamp()
             WHERE corp_id=$1",
            fixture.ids.corp_id,
        ),
        "version" => (
            "UPDATE pull_request_publications SET version=version+1 WHERE id=$1",
            fixture.publication_id,
        ),
        "role" => (
            "UPDATE actors SET role='member' WHERE id=$1",
            fixture.ids.alice_actor_id,
        ),
        "membership" => (
            "DELETE FROM room_memberships WHERE actor_id=$1",
            fixture.ids.alice_actor_id,
        ),
        _ => unreachable!(),
    };
    let mut blocker = fixture.pool.begin().await.unwrap();
    // Only the final download query uses this table, including for legacy
    // source metadata. The preceding publication checks can finish normally.
    sqlx::query("LOCK TABLE verification_requests IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let request = artifact_request(&fixture, &claim);
    let download = tokio::spawn(async move { request.send().await.unwrap() });
    wait_for_artifact_lookup(&fixture.pool).await;

    let mut mutation = fixture.pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout = '250ms'")
        .execute(&mut *mutation)
        .await
        .unwrap();
    let result = sqlx::query(query).bind(id).execute(&mut *mutation).await;
    let serialized = result
        .as_ref()
        .err()
        .and_then(sqlx::Error::as_database_error)
        .and_then(|error| error.code())
        .is_some_and(|code| code == "55P03");
    // Retain the actual race on the old implementation: an unblocked change
    // commits before lookup resumes. A correctly blocked write is rolled back.
    if result.is_ok() {
        mutation.commit().await.unwrap();
    } else {
        mutation.rollback().await.unwrap();
    }
    blocker.commit().await.unwrap();
    let response = download.await.unwrap();
    assert!(
        serialized,
        "{change} changed authority before the artifact lookup completed"
    );
    assert_eq!(
        response.status(),
        reqwest::StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(response.headers()["cache-control"], "no-store");
    // The request was authorized before the mutation; deliberately invalid
    // fixture object provenance prevents confusing it with artifact acceptance.
    sqlx::query(query)
        .bind(id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let denied = artifact_request(&fixture, &claim).send().await.unwrap();
    let expected = if change == "version" {
        reqwest::StatusCode::CONFLICT
    } else {
        reqwest::StatusCode::FORBIDDEN
    };
    assert_eq!(denied.status(), expected, "authority change: {change}");
    assert!(!denied.text().await.unwrap().contains(&fixture.credential));
}

async fn assert_expiry_after_artifact_wait(pool: PgPool, credential: bool) {
    let fixture = Fixture::new(pool).await.unwrap();
    let claim = fixture.claim("artifact-expiry").await;
    let query = if credential {
        "UPDATE publication_publisher_credentials
         SET expires_at=clock_timestamp()+interval '3 seconds' WHERE corp_id=$1
         RETURNING expires_at"
    } else {
        "UPDATE pull_request_publications
         SET publisher_lease_expires_at=clock_timestamp()+interval '3 seconds' WHERE corp_id=$1
         RETURNING publisher_lease_expires_at"
    };
    let expiry: chrono::DateTime<Utc> = sqlx::query_scalar(query)
        .bind(fixture.ids.corp_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    let mut blocker = fixture.pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE verification_requests IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let request = artifact_request(&fixture, &claim);
    let download = tokio::spawn(async move { request.send().await.unwrap() });
    wait_for_artifact_lookup(&fixture.pool).await;
    sqlx::query("SELECT pg_sleep_until($1::timestamptz + interval '50 milliseconds')")
        .bind(expiry)
        .execute(&fixture.pool)
        .await
        .unwrap();
    blocker.commit().await.unwrap();
    let response = download.await.unwrap();
    let expected = if credential {
        reqwest::StatusCode::FORBIDDEN
    } else {
        reqwest::StatusCode::CONFLICT
    };
    assert_eq!(response.status(), expected);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(!response.text().await.unwrap().contains(&fixture.credential));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_artifact_serializes_credential_revocation(pool: PgPool) {
    assert_authority_change_serialized(pool, "credential").await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_artifact_serializes_publication_version(pool: PgPool) {
    assert_authority_change_serialized(pool, "version").await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_artifact_serializes_human_role_revocation(pool: PgPool) {
    assert_authority_change_serialized(pool, "role").await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_artifact_serializes_room_membership_revocation(pool: PgPool) {
    assert_authority_change_serialized(pool, "membership").await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_artifact_rejects_lease_expiry_during_lookup(pool: PgPool) {
    assert_expiry_after_artifact_wait(pool, false).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_artifact_rejects_credential_expiry_during_lookup(pool: PgPool) {
    assert_expiry_after_artifact_wait(pool, true).await;
}
