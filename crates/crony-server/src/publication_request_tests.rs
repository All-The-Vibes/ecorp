//! Actual workload HTTP routes with real migrations and explicitly synthetic
//! saved publication metadata. This fixture proves read/authority boundaries;
//! it does not claim a verifier run, human decision, Git effect or browser test.
use super::*;
use anyhow::Result;
use crony_store::DemoIds;
use serde_json::Value;
use sqlx::{ConnectOptions, PgPool};

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
        let publication_id = Uuid::new_v4();
        let authorization_id = Uuid::new_v4();
        let credential = format!("fixture-{}", Uuid::new_v4());
        store
            .create_publication_publisher_credential(
                ids.corp_id,
                ids.alice_actor_id,
                PUBLISHER,
                &hash_secret(&credential),
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

        let authorization = json!({
            "id": authorization_id, "kind": "explicit_human",
            "permission": "publish_pull_request", "actor_id": ids.alice_actor_id,
            "actor_role": "owner", "reason": "Synthetic saved-request metadata",
            "authorized_at": Utc::now(), "auto_merge": false, "merge": false, "deploy": false,
        });
        let intent = json!({
            "schema_version": 1, "kind": "human_requested", "corp_id": ids.corp_id,
            "work_item_id": work_item_id, "actor_id": ids.alice_actor_id,
            "actor_role": "owner", "authorization_id": authorization_id,
            "authorization_reason": "Synthetic saved-request metadata",
            "preview": {
                "plan": {
                    "source_deliverable_id": deliverable_id, "target_repository": REPOSITORY,
                    "base_ref": "main", "branch": "ecorp/issue219-handler",
                    "title": "Synthetic publication", "body": "Synthetic metadata only",
                },
                "commit_sha": "b".repeat(40), "artifact_sha256": "c".repeat(64),
                "verification_sha256": "d".repeat(64), "source_revision": "synthetic",
                "fingerprint": "e".repeat(64),
            },
        });
        let fixture = json!({
            "corp": ids.corp_id, "room": ids.room_id, "actor": ids.alice_actor_id,
            "agent": ids.worker_agent_id, "mission": mission_id, "task": task_id,
            "run": run_id, "artifact": artifact_id, "deliverable": deliverable_id,
            "work_item": work_item_id, "publication": publication_id,
            "authorization": authorization, "intent": intent,
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
                    plan_key, contract, verification_policy)
                SELECT (j->>'task')::uuid, mission.id, (j->>'corp')::uuid,
                       'Synthetic metadata', 'Handler authorization only', 'completed',
                       'synthetic-handler', j->'task_contract', '{"checks":[],"manual_gate":null}'
                FROM f, mission RETURNING id
            ), run AS (
                INSERT INTO runs (id, corp_id, task_id, agent_id, runner_id, status,
                    assignment_token, workspace_run_id)
                SELECT (j->>'run')::uuid, (j->>'corp')::uuid, task.id, (j->>'agent')::uuid,
                       'issue219-handler-publisher', 'completed', gen_random_uuid(),
                       (j->>'run')::uuid
                FROM f, task RETURNING id
            ), artifact AS (
                INSERT INTO artifacts (id, corp_id, task_id, run_id, producer_agent_id,
                    producer_runner_id, verifier, object_key, uri, sha256, media_type,
                    bytes, retention_until, provenance_signature, finalized_at, artifact_role)
                SELECT (j->>'artifact')::uuid, (j->>'corp')::uuid, (j->>'task')::uuid, run.id,
                       (j->>'agent')::uuid, 'issue219-handler-publisher', 'synthetic',
                       'synthetic.bundle', 'artifact://synthetic', repeat('c',64),
                       'application/octet-stream', 0, now() + interval '1 day', repeat('f',64),
                       now(), 'source_deliverable'
                FROM f, run RETURNING id
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
                    claim_token, lease_expires_at, mission_id)
                SELECT (j->>'work_item')::uuid, (j->>'corp')::uuid, 'github_project_issue',
                       'fixture', 1, 'synthetic-item', 'fixture', 'publication', 219,
                       'synthetic-issue', 'https://github.com/fixture/publication/issues/219',
                       'Synthetic publication', 'synthetic', 'verified', (j->>'actor')::uuid,
                       gen_random_uuid(), now() + interval '10 minutes', (j->>'mission')::uuid
                FROM f, deliverable RETURNING id
            ), publication AS (
                INSERT INTO pull_request_publications (id, corp_id, factory_work_item_id,
                    mission_id, source_deliverable_id, artifact_id, task_id, run_id,
                    source_issue_number, source_issue_url, target_repository, base_ref, branch,
                    commit_sha, title, body, actor_id, authorization_id, authorization_snapshot,
                    effect_key, idempotency_key, state, project_owner, project_number,
                    project_item_id, project_status_before, provenance)
                SELECT (j->>'publication')::uuid, (j->>'corp')::uuid, item.id,
                       (j->>'mission')::uuid, (j->>'deliverable')::uuid, (j->>'artifact')::uuid,
                       (j->>'task')::uuid, (j->>'run')::uuid, 219,
                       'https://github.com/fixture/publication/issues/219', 'fixture/publication',
                       'main', 'ecorp/issue219-handler', repeat('b',40), 'Synthetic publication',
                       'Synthetic metadata only', (j->>'actor')::uuid,
                       (j->'authorization'->>'id')::uuid, j->'authorization',
                       'github-pr:' || item.id || ':' || repeat('e',64), 'synthetic-request',
                       'requested', 'fixture', 1, 'synthetic-item', 'In Progress',
                       jsonb_build_object('intent', j->'intent', 'authorization_snapshot', j->'authorization')
                FROM f, item RETURNING id
            )
            INSERT INTO pull_request_publication_operations
                (corp_id, idempotency_key, publication_id, actor_id, operation, resulting_version, request)
            SELECT (j->>'corp')::uuid, 'synthetic-request', publication.id,
                   (j->>'actor')::uuid, 'request', 1, j->'intent'
            FROM f, publication
            "#,
        )
        .bind(fixture)
        .execute(&pool)
        .await?;

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
    let claim = client
        .post(format!(
            "{}/api/corps/{}/factory/publisher/publications/{}/claim",
            fixture.base, fixture.ids.corp_id, fixture.publication_id
        ))
        .header(
            "x-crony-publication-publisher-credential",
            &fixture.credential,
        )
        .json(&json!({
            "repository": REPOSITORY,
            "idempotency_key": "revoked-authorizer-must-not-claim",
            "lease_seconds": 60,
        }))
        .send()
        .await
        .unwrap();
    // Preserve the native start gate's existing error contract for a changed
    // saved role, and prove that this is the gate rejecting the claim.
    assert_eq!(claim.status(), reqwest::StatusCode::BAD_REQUEST);
    let claim_error: Value = claim.json().await.unwrap();
    assert_eq!(
        claim_error["error"],
        "publication authorization role changed from owner to guest"
    );
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
            "repository": REPOSITORY, "publisher_token": Uuid::new_v4(), "expected_version": 1,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(artifact.status(), reqwest::StatusCode::CONFLICT);
    let unchanged = fixture.assert_context().await;
    assert_eq!(unchanged["publication"]["attempt_count"], 0);
    sqlx::query(
        "UPDATE pull_request_publications SET state='published', attempt_count=1,
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
            404,
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
