//! Actual workload HTTP routes with real migrations and explicitly synthetic
//! source/verifier metadata. Requests use the native preview/request transactions.
//! This proves admission/read boundaries, not a verifier execution, human
//! decision, Git effect or browser test.
use super::*;
use anyhow::Result;
use crony_domain::PullRequestPublicationPlan;
use crony_store::{
    DemoIds, PreviewPullRequestPublicationInput, RequestPullRequestPublicationInput,
};
use serde_json::Value;
use sqlx::{ConnectOptions, PgPool};

#[path = "publication_repository_tests.rs"]
mod repository_grants;

const REPOSITORY: &str = "fixture/publication";
const PUBLISHER: &str = "issue219-handler-publisher";

struct Fixture {
    pool: PgPool,
    state: AppState,
    ids: DemoIds,
    publication_id: Uuid,
    work_item_id: Uuid,
    deliverable_id: Uuid,
    artifact_id: Uuid,
    mission_id: Uuid,
    task_id: Uuid,
    run_id: Uuid,
    credential: String,
    base: String,
    server: tokio::task::JoinHandle<()>,
    artifact_root: PathBuf,
}

impl Fixture {
    async fn new(pool: PgPool) -> Result<Self> {
        // Use only the SQLx-owned disposable database. Never print its URL.
        let database = pool.connect_options().to_url_lossy();
        let store = PgStore::connect(database.as_str()).await?;
        let (ids, _) = store.bootstrap_demo().await?;
        let mission_id = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let artifact_id = Uuid::new_v4();
        let deliverable_id = Uuid::new_v4();
        let work_item_id = Uuid::new_v4();
        let authorization_id = Uuid::new_v4();
        let credential = format!("fixture-{}", Uuid::new_v4());
        store
            .create_publication_publisher_credential(
                ids.corp_id,
                ids.alice_actor_id,
                PUBLISHER,
                &hash_secret(&credential),
                Some(REPOSITORY),
                Utc::now() + chrono::Duration::minutes(10),
            )
            .await?;
        store
            .runner_connected(RunnerConnectInput {
                id: PUBLISHER.into(),
                corp_id: ids.corp_id,
                hostname: "synthetic-metadata-only".into(),
                os: "windows".into(),
                capabilities: json!([]),
                connection_epoch: Uuid::new_v4(),
            })
            .await?;

        let fixture = json!({
            "corp": ids.corp_id, "room": ids.room_id, "actor": ids.alice_actor_id,
            "agent": ids.worker_agent_id, "mission": mission_id, "task": task_id,
            "run": run_id, "artifact": artifact_id, "deliverable": deliverable_id,
            "work_item": work_item_id,
            "policy": {
                "auto_merge": false, "source_base_commit": "a".repeat(40),
                "publication": {
                    "allowed": true, "repository_allowlist": [REPOSITORY],
                    "base_ref": "main", "branch_prefix": "ecorp/",
                    "status_before": "In Progress", "review_status": "In Review",
                },
            },
            "task_contract": {
                "objective": "Handler authorization only", "expected_output": "synthetic.bundle",
                "acceptance_tests": [], "allowed_tools": [], "prohibited_actions": [],
                "references": [], "write_scope": [], "budget_tokens": 100,
                "budget_cost_microusd": 1000000, "deadline_at": null,
                "escalation": "Synthetic metadata only",
            },
        });
        // Each inserted row depends on the previous CTE. All IDs and provenance
        // are confined to this one synthetic saved-request lineage.
        sqlx::query(
            r#"
            WITH f AS (SELECT $1::jsonb AS j),
            mission AS (
                INSERT INTO missions (id, corp_id, room_id, requested_by, title, status,
                    budget_tokens, original_budget_tokens, budget_cost_microusd,
                    original_budget_cost_microusd)
                SELECT (j->>'mission')::uuid, (j->>'corp')::uuid, (j->>'room')::uuid,
                       (j->>'actor')::uuid, 'Synthetic metadata', 'completed',
                       100, 100, 1000000, 1000000 FROM f RETURNING id
            ), task AS (
                INSERT INTO tasks (id, mission_id, corp_id, title, objective, status,
                    plan_key, contract, verification_policy, verification_status)
                SELECT (j->>'task')::uuid, mission.id, (j->>'corp')::uuid,
                       'Synthetic metadata', 'Handler authorization only', 'completed',
                       'synthetic-handler', j->'task_contract', '{"checks":[],"manual_gate":null}',
                       'passed'
                FROM f, mission RETURNING id
            ), run AS (
                INSERT INTO runs (id, corp_id, task_id, agent_id, runner_id, status,
                    assignment_token, workspace_run_id, verification_status,
                    verification_sha256, deliverable_sha256)
                SELECT (j->>'run')::uuid, (j->>'corp')::uuid, task.id, (j->>'agent')::uuid,
                       'issue219-handler-publisher', 'completed', gen_random_uuid(),
                       (j->>'run')::uuid, 'passed', repeat('d',64), repeat('c',64)
                FROM f, task RETURNING id
            ), evidence AS (
                INSERT INTO verification_evidence (id, corp_id, task_id, run_id,
                    check_index, kind, status, summary, payload)
                SELECT gen_random_uuid(), (j->>'corp')::uuid, (j->>'task')::uuid, run.id,
                       0, 'synthetic', 'passed', 'Synthetic metadata; no verifier executed',
                       '{"synthetic":true}'::jsonb
                FROM f, run RETURNING id
            ), artifact AS (
                INSERT INTO artifacts (id, corp_id, task_id, run_id, producer_agent_id,
                    producer_runner_id, verifier, object_key, uri, sha256, media_type,
                    bytes, retention_until, provenance_signature, finalized_at, artifact_role,
                    metadata)
                SELECT (j->>'artifact')::uuid, (j->>'corp')::uuid, (j->>'task')::uuid,
                       (j->>'run')::uuid,
                       (j->>'agent')::uuid, 'issue219-handler-publisher', 'synthetic',
                       'synthetic.bundle', 'artifact://synthetic', repeat('c',64),
                       'application/octet-stream', 0, now() + interval '1 day', repeat('f',64),
                       now(), 'source_deliverable',
                       jsonb_build_object('synthetic', true, 'publication_ready', true,
                           'git_bundle_sha256', repeat('f',64))
                FROM f, evidence RETURNING id
            ), deliverable AS (
                INSERT INTO source_deliverables (id, corp_id, task_id, run_id, artifact_id,
                    form, file_name, verification_sha256, base_commit, head_commit, branch,
                    integration_state)
                SELECT (j->>'deliverable')::uuid, (j->>'corp')::uuid, (j->>'task')::uuid,
                       (j->>'run')::uuid, artifact.id, 'commit_branch', 'synthetic.bundle',
                       repeat('d',64), repeat('a',40), repeat('b',40), 'ecorp/issue219-handler',
                       'ready_for_review'
                FROM f, artifact RETURNING id
            ), item AS (
                INSERT INTO factory_work_items (id, corp_id, source_kind, source_project_owner,
                    source_project_number, source_project_item_id, source_repository_owner,
                    source_repository_name, source_issue_number, source_issue_node_id,
                    source_issue_url, source_title, source_revision, state, claim_owner_id,
                    claim_token, lease_expires_at, mission_id, policy)
                SELECT (j->>'work_item')::uuid, (j->>'corp')::uuid, 'github_project_issue',
                       'fixture', 1, 'synthetic-item', 'fixture', 'publication', 219,
                       'synthetic-issue', 'https://github.com/fixture/publication/issues/219',
                       'Synthetic publication', 'synthetic', 'verified', (j->>'actor')::uuid,
                       gen_random_uuid(), now() + interval '10 minutes', (j->>'mission')::uuid,
                       j->'policy'
                FROM f, deliverable RETURNING id
            )
            SELECT id FROM item
            "#,
        )
        .bind(fixture)
        .execute(&pool)
        .await?;

        let preview = store
            .preview_pull_request_publication(PreviewPullRequestPublicationInput {
                corp_id: ids.corp_id,
                work_item_id,
                actor_id: ids.alice_actor_id,
                actor_role: "owner".into(),
                plan: PullRequestPublicationPlan {
                    source_deliverable_id: deliverable_id,
                    target_repository: REPOSITORY.into(),
                    base_ref: "main".into(),
                    branch: "ecorp/issue219-handler".into(),
                    title: "Synthetic publication".into(),
                    body:
                        "Synthetic metadata only: https://github.com/fixture/publication/issues/219"
                            .into(),
                },
            })
            .await?;
        let requested = store
            .request_pull_request_publication(RequestPullRequestPublicationInput {
                corp_id: ids.corp_id,
                work_item_id,
                actor_id: ids.alice_actor_id,
                actor_role: "owner".into(),
                preview,
                authorization_id,
                authorization_reason: "Synthetic saved-request metadata".into(),
                idempotency_key: "synthetic-request".into(),
            })
            .await?;
        assert!(requested.publisher_token.is_none());
        let publication_id = requested.publication.id;

        let artifact_root =
            std::env::temp_dir().join(format!("ecorp-issue219-handler-{}", Uuid::new_v4()));
        let artifacts = ArtifactStore::initialize(
            "local",
            artifact_root.clone(),
            None,
            None,
            None,
            None,
            None,
            false,
            None,
            1024,
            false,
        )?;
        let (event_tx, _) = broadcast::channel(64);
        let state = AppState {
            audit: None,
            base_audit: base_audit::Runtime::Unconfigured,
            store,
            event_tx,
            runners: Arc::new(DashMap::new()),
            strategies: StrategyRegistry::new(),
            runner_grace_secs: 10,
            runner_credential_ttl_secs: 300,
            publication_publisher_credential_ttl_secs: 300,
            auth: AuthService::initialize(ServerMode::Development, None, false).await?,
            secret_cipher: SecretCipher::initialize(ServerMode::Development, None)?,
            artifacts,
            artifact_retention_days: 1,
            workspace_sign_in: Arc::new(DashMap::new()),
            delegated: None,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let router = publication_requests::publisher_routes().with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Ok(Self {
            pool,
            state,
            ids,
            publication_id,
            work_item_id,
            deliverable_id,
            artifact_id,
            mission_id,
            task_id,
            run_id,
            credential,
            base,
            server,
            artifact_root,
        })
    }

    async fn read(
        &self,
        corp_id: Uuid,
        publication_id: Uuid,
        repository: &str,
        authenticated: bool,
    ) -> reqwest::Response {
        let request = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!(
                "{}/api/corps/{corp_id}/factory/publisher/publications/{publication_id}",
                self.base
            ))
            .query(&[("repository", repository)]);
        let request = if authenticated {
            request.header("x-crony-publication-publisher-credential", &self.credential)
        } else {
            request
        };
        request.send().await.unwrap()
    }

    async fn assert_context(&self) -> Value {
        let response = self
            .read(self.ids.corp_id, self.publication_id, REPOSITORY, true)
            .await;
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let text = response.text().await.unwrap();
        assert!(!text.contains(&self.credential));
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["publisher_id"], PUBLISHER);
        assert_eq!(body["work_item"]["id"], self.work_item_id.to_string());
        assert_eq!(body["publication"]["id"], self.publication_id.to_string());
        assert_eq!(body["source_deliverables"].as_array().unwrap().len(), 1);
        assert_eq!(
            body["source_deliverables"][0]["id"],
            self.deliverable_id.to_string()
        );
        assert!(body.get("publisher_token").is_none());
        assert!(body["publication"].get("publisher_token").is_none());
        body
    }

    async fn assert_context_not_found(&self) {
        let response = self
            .read(self.ids.corp_id, self.publication_id, REPOSITORY, true)
            .await;
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }

    async fn claim(&self, key: &str) -> Value {
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!(
                "{}/api/corps/{}/factory/publisher/publications/{}/claim",
                self.base, self.ids.corp_id, self.publication_id
            ))
            .header("x-crony-publication-publisher-credential", &self.credential)
            .json(&json!({
                "repository": REPOSITORY, "idempotency_key": key, "lease_seconds": 60,
            }))
            .send()
            .await
            .unwrap();
        let status = response.status();
        assert_eq!(response.headers()["cache-control"], "no-store");
        let text = response.text().await.unwrap();
        assert!(!text.contains(&self.credential));
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(status, reqwest::StatusCode::OK, "{}", body["error"]);
        body
    }

    async fn queue(&self) -> Value {
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!(
                "{}/api/corps/{}/factory/publisher/queue",
                self.base, self.ids.corp_id
            ))
            .header("x-crony-publication-publisher-credential", &self.credential)
            .query(&[("repository", REPOSITORY)])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["publisher_id"], PUBLISHER);
        body["publication_ids"].clone()
    }

    async fn assert_durable_rejection(&self, reason: &str) -> Value {
        let rejected = self.claim("rejected-request").await;
        assert!(rejected["publisher_token"].is_null());
        assert_eq!(rejected["replayed"], false);
        assert_eq!(rejected["busy"], false);
        let publication = &rejected["publication"];
        assert_eq!(publication["id"], self.publication_id.to_string());
        assert_eq!(publication["state"], "requested");
        assert_eq!(publication["attempt_count"], 0);
        assert_eq!(
            publication["failure_detail"],
            format!("Saved human publication request rejected: {reason}")
        );
        assert!(publication["publisher_id"].is_null());
        assert!(publication["publisher_lease_expires_at"].is_null());
        for key in ["rejected-request", "later-worker-poll"] {
            let replay = self.claim(key).await;
            assert_eq!(replay["replayed"], true);
            assert!(replay["publisher_token"].is_null());
            assert_eq!(&replay["publication"], publication);
        }
        assert_eq!(self.queue().await, json!([]));
        let (tokenless, attempts, failures): (bool, i64, i64) = sqlx::query_as(
            "SELECT publication.publisher_token IS NULL,
                (SELECT count(*) FROM pull_request_publication_attempts WHERE publication_id=$1),
                (SELECT count(*) FROM events WHERE aggregate_id=$1 AND type='factory.publication_failed')
             FROM pull_request_publications publication WHERE id=$1",
        )
        .bind(self.publication_id)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        assert!(tokenless);
        assert_eq!((attempts, failures), (0, 1));
        rejected
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        // This random root was created exclusively by this fixture.
        let _ = std::fs::remove_dir_all(&self.artifact_root);
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_handler_tokenless_context_survives_human_revocation(pool: PgPool) {
    let fixture = Fixture::new(pool).await.unwrap();
    fixture.assert_context().await;
    assert_eq!(fixture.queue().await, json!([fixture.publication_id]));
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(fixture.ids.room_id)
        .bind(fixture.ids.alice_actor_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(
        fixture
            .state
            .store
            .factory_publication_context(
                fixture.ids.corp_id,
                fixture.ids.alice_actor_id,
                fixture.work_item_id,
            )
            .await
            .unwrap()
            .is_none()
    );
    fixture.assert_context().await;
    sqlx::query("UPDATE actors SET role='guest' WHERE id=$1")
        .bind(fixture.ids.alice_actor_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    fixture.assert_context().await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let rejected = fixture
        .assert_durable_rejection(
            "forbidden: current human room membership and Publish permission are required",
        )
        .await;
    let artifact = client
        .post(format!(
            "{}/api/corps/{}/factory/publisher/publications/{}/artifact",
            fixture.base, fixture.ids.corp_id, fixture.publication_id
        ))
        .header(
            "x-crony-publication-publisher-credential",
            &fixture.credential,
        )
        .json(&json!({
            "repository": REPOSITORY, "publisher_token": Uuid::new_v4(),
            "expected_version": rejected["publication"]["version"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(artifact.status(), reqwest::StatusCode::CONFLICT);
    let saved = fixture.assert_context().await;
    assert_eq!(saved["publication"], rejected["publication"]);
    // Synthetic completed-state readback only; this is not a native Git effect
    // or a transition that a failed request is permitted to perform itself.
    sqlx::query(
        "UPDATE pull_request_publications SET state='published', attempt_count=1, failure_detail=NULL,
        pull_request_number=219, pull_request_node_id='synthetic-pr',
        pull_request_url='https://github.com/fixture/publication/pull/219',
        pull_request_state='OPEN', pull_request_draft=true,
        pull_request_head_sha=commit_sha, pull_request_head_repository_owner='fixture',
        pull_request_is_cross_repository=false, pull_request_base_ref='main' WHERE id=$1",
    )
    .bind(fixture.publication_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let completed = fixture.assert_context().await;
    assert_eq!(completed["publication"]["state"], "published");
    assert!(completed["publication"]["publisher_id"].is_null());
    assert_eq!(
        completed["publication"]["pull_request_url"],
        "https://github.com/fixture/publication/pull/219"
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_handler_claim_uses_native_admission(pool: PgPool) {
    let fixture = Fixture::new(pool).await.unwrap();
    assert_eq!(fixture.queue().await, json!([fixture.publication_id]));
    let claim = fixture.claim("current-request").await;
    assert!(claim["publisher_token"].as_str().is_some());
    assert_eq!(claim["publication"]["attempt_count"], 1);
    assert_eq!(claim["publication"]["publisher_id"], PUBLISHER);
    assert!(claim["publication"]["failure_detail"].is_null());
    assert_eq!(fixture.queue().await, json!([]));
    let replay = fixture.claim("current-request").await;
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["publisher_token"], claim["publisher_token"]);
    assert_eq!(replay["publication"], claim["publication"]);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_handler_rejects_withdrawn_verification(pool: PgPool) {
    let fixture = Fixture::new(pool).await.unwrap();
    sqlx::query("UPDATE tasks SET verification_status='failed' WHERE id=$1")
        .bind(fixture.task_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    fixture
        .assert_durable_rejection(
            "conflict: factory work item cannot enter verified before its mission and task verification pass",
        )
        .await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_handler_rejects_other_scope_and_malformed_intent(pool: PgPool) {
    let fixture = Fixture::new(pool).await.unwrap();
    for (corp, publication, repository, authenticated, status) in [
        (
            Uuid::new_v4(),
            fixture.publication_id,
            REPOSITORY,
            true,
            403,
        ),
        (fixture.ids.corp_id, Uuid::new_v4(), REPOSITORY, true, 404),
        (
            fixture.ids.corp_id,
            fixture.publication_id,
            "fixture/other",
            true,
            403,
        ),
        (
            fixture.ids.corp_id,
            fixture.publication_id,
            REPOSITORY,
            false,
            403,
        ),
    ] {
        let response = fixture
            .read(corp, publication, repository, authenticated)
            .await;
        assert_eq!(response.status().as_u16(), status);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    sqlx::query(
        "UPDATE pull_request_publications SET provenance = provenance - 'intent' WHERE id=$1",
    )
    .bind(fixture.publication_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        fixture
            .read(
                fixture.ids.corp_id,
                fixture.publication_id,
                REPOSITORY,
                true
            )
            .await
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_handler_rejects_artifact_from_another_corp(pool: PgPool) {
    let fixture = Fixture::new(pool).await.unwrap();
    fixture.assert_context().await;
    let other_corp = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO corps (id,slug,name) VALUES ($1,'other-publication-corp','Other fixture')",
    )
    .bind(other_corp)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE artifacts SET corp_id=$1 WHERE id=$2")
        .bind(other_corp)
        .bind(fixture.artifact_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    fixture.assert_context_not_found().await;
    let human_context = fixture
        .state
        .store
        .factory_publication_context(
            fixture.ids.corp_id,
            fixture.ids.alice_actor_id,
            fixture.work_item_id,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(human_context.source_deliverables.is_empty());
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_handler_rejects_source_scope_drift(pool: PgPool) {
    let fixture = Fixture::new(pool).await.unwrap();
    let other_corp = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO corps (id,slug,name) VALUES ($1,'other-source-corp','Other source fixture')",
    )
    .bind(other_corp)
    .execute(&fixture.pool)
    .await
    .unwrap();
    // Deliberately corrupt one stored object's scope at a time. Every object
    // in the exact selected lineage must independently remain Corp-bound.
    for (table, id) in [
        ("source_deliverables", fixture.deliverable_id),
        ("runs", fixture.run_id),
        ("tasks", fixture.task_id),
        ("missions", fixture.mission_id),
        ("factory_work_items", fixture.work_item_id),
    ] {
        fixture.assert_context().await;
        let statement = format!("UPDATE {table} SET corp_id=$1 WHERE id=$2");
        sqlx::query(&statement)
            .bind(other_corp)
            .bind(id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        fixture.assert_context_not_found().await;
        sqlx::query(&statement)
            .bind(fixture.ids.corp_id)
            .bind(id)
            .execute(&fixture.pool)
            .await
            .unwrap();
    }
    fixture.assert_context().await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue219_publication_handler_rejects_changed_saved_source(pool: PgPool) {
    let fixture = Fixture::new(pool).await.unwrap();
    for (statement, id, replacement, original) in [
        (
            "UPDATE artifacts SET sha256=$1 WHERE id=$2",
            fixture.artifact_id,
            "a".repeat(64),
            "c".repeat(64),
        ),
        (
            "UPDATE source_deliverables SET verification_sha256=$1 WHERE id=$2",
            fixture.deliverable_id,
            "a".repeat(64),
            "d".repeat(64),
        ),
        (
            "UPDATE source_deliverables SET head_commit=$1 WHERE id=$2",
            fixture.deliverable_id,
            "a".repeat(40),
            "b".repeat(40),
        ),
        (
            "UPDATE factory_work_items SET source_repository_name=$1 WHERE id=$2",
            fixture.work_item_id,
            "other".into(),
            "publication".into(),
        ),
    ] {
        fixture.assert_context().await;
        sqlx::query(statement)
            .bind(replacement)
            .bind(id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        fixture.assert_context_not_found().await;
        sqlx::query(statement)
            .bind(original)
            .bind(id)
            .execute(&fixture.pool)
            .await
            .unwrap();
    }
    fixture.assert_context().await;
}
