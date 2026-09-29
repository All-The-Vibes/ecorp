//! Real HTTP and SQLx regressions; synthetic metadata grants no remote effect.
use super::*;

async fn publication_state(fixture: &Fixture) -> Value {
    // Authentication audits last use even when repository selection is denied.
    // Every other credential field, publication effect and event must remain.
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
          'rows',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM pull_request_publications p),
          'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM pull_request_publication_attempts a),
          'operations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY idempotency_key),'[]') FROM pull_request_publication_operations o),
          'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') FROM factory_work_items i),
          'credentials',(SELECT coalesce(jsonb_agg(to_jsonb(c)-'last_used_at' ORDER BY id),'[]') FROM publication_publisher_credentials c),
          'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY seq),'[]') FROM events e))",
    ).fetch_one(&fixture.pool).await.unwrap()
}

async fn enroll(fixture: &Fixture, repository: Option<&str>) -> (String, Uuid) {
    let credential = format!("fixture-{}", Uuid::new_v4());
    let grant = fixture
        .state
        .store
        .create_publication_publisher_credential(
            fixture.ids.corp_id,
            fixture.ids.alice_actor_id,
            PUBLISHER,
            &hash_secret(&credential),
            repository,
            Utc::now() + chrono::Duration::minutes(10),
        )
        .await
        .unwrap();
    (credential, grant.credential_id)
}

async fn assert_workload_forbidden(
    fixture: &Fixture,
    credential: &str,
    repository: &str,
    token: &Value,
    version: &Value,
) {
    let before = publication_state(fixture).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let prefix = format!(
        "{}/api/corps/{}/factory/publisher",
        fixture.base, fixture.ids.corp_id
    );
    let publication = format!("{prefix}/publications/{}", fixture.publication_id);
    for operation in [
        "queue", "context", "claim", "renew", "effect", "failure", "artifact",
    ] {
        let request = match operation {
            "queue" => client.get(format!("{prefix}/queue")).query(&[("repository", repository)]),
            "context" => client.get(&publication).query(&[("repository", repository)]),
            "claim" => client.post(format!("{publication}/claim")).json(&json!({
                "repository": repository, "idempotency_key": "denied-repository-claim", "lease_seconds": 60,
            })),
            "renew" => client.post(format!("{publication}/renew")).json(&json!({
                "repository": repository, "publisher_token": token, "expected_version": version,
                "idempotency_key": "denied-repository-renewal", "lease_seconds": 60,
            })),
            "effect" | "failure" => {
                let checkpoint = if operation == "effect" {
                    PullRequestPublicationCheckpoint::BranchPushed { commit_sha: "b".repeat(40) }
                } else {
                    PullRequestPublicationCheckpoint::Failed { failure_detail: "Unauthorized cleanup".into() }
                };
                client.post(format!("{publication}/checkpoint")).json(&json!({
                    "repository": repository, "publisher_token": token, "expected_version": version,
                    "idempotency_key": "denied-repository-checkpoint", "checkpoint": checkpoint,
                }))
            }
            "artifact" => client.post(format!("{publication}/artifact")).json(&json!({
                "repository": repository, "publisher_token": token, "expected_version": version,
            })),
            _ => unreachable!(),
        };
        let response = request
            .header("x-crony-publication-publisher-credential", credential)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::FORBIDDEN,
            "{operation}"
        );
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body = response.text().await.unwrap();
        assert!(!body.contains(credential) && !body.contains(token.as_str().unwrap()));
        // Boolean comparison prevents an assertion from printing fencing tokens.
        assert!(
            publication_state(fixture).await == before,
            "{operation} mutated publication state"
        );
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_handler_enforces_repository_on_every_workload_route(pool: PgPool) {
    let fixture = Fixture::new(pool).await.unwrap();
    let (other, _) = enroll(&fixture, Some("other/repository")).await;
    let (legacy, _) = enroll(&fixture, None).await;
    let token = json!(Uuid::new_v4());
    let context = fixture.assert_context().await;
    let selections = [
        (other.as_str(), REPOSITORY),
        (legacy.as_str(), REPOSITORY),
        (fixture.credential.as_str(), "other/repository"),
    ];
    for (credential, repository) in selections {
        assert_workload_forbidden(
            &fixture,
            credential,
            repository,
            &token,
            &context["publication"]["version"],
        )
        .await;
    }
    assert_eq!(fixture.queue().await, json!([fixture.publication_id]));
    let response = fixture
        .read(
            fixture.ids.corp_id,
            fixture.publication_id,
            " FIXTURE/PUBLICATION ",
            true,
        )
        .await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let started = fixture.claim("correct-repository-grant").await;
    assert!(started["publisher_token"].is_string());
    for (credential, repository) in selections {
        assert_workload_forbidden(
            &fixture,
            credential,
            repository,
            &started["publisher_token"],
            &started["publication"]["version"],
        )
        .await;
    }
    fixture.assert_context().await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_handler_rechecks_repository_credential_lifecycle(pool: PgPool) {
    let fixture = Fixture::new(pool).await.unwrap();
    let started = fixture.claim("repository-lifecycle").await;
    for lifecycle in ["revoked", "expired"] {
        let (credential, id) = enroll(&fixture, Some(REPOSITORY)).await;
        if lifecycle == "revoked" {
            fixture
                .state
                .store
                .revoke_publication_publisher_credential(
                    fixture.ids.corp_id,
                    fixture.ids.alice_actor_id,
                    id,
                    "Synthetic HTTP grant revocation",
                )
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE publication_publisher_credentials SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' WHERE id=$1")
                .bind(id).execute(&fixture.pool).await.unwrap();
        }
        assert_workload_forbidden(
            &fixture,
            &credential,
            REPOSITORY,
            &started["publisher_token"],
            &started["publication"]["version"],
        )
        .await;
    }
    fixture.assert_context().await;
}
