//! Actual broker handlers and migrated SQLx databases. Provider replies are
//! signed by the isolated test authority; no human account is contacted.
use super::*;
use crony_store::DemoIds;
use delegated_provider::tests::Fixture as ProviderFixture;
use sqlx::ConnectOptions;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fixture {
    state: AppState,
    ids: DemoIds,
    provider: ProviderFixture,
    runner: String,
    epoch: Uuid,
    resource_reads: Arc<AtomicUsize>,
    resource_task: tokio::task::JoinHandle<()>,
}

struct Operation {
    id: Uuid,
    mission: Uuid,
    assignment: RunnerRead,
}

struct Flow {
    ticket: String,
    state: String,
    headers: HeaderMap,
    transaction: Uuid,
}

impl Flow {
    fn callback(&self) -> Callback {
        Callback {
            state: Some(self.state.clone()),
            code: Some("synthetic-code".into()),
            error: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.resource_task.abort();
    }
}

impl Fixture {
    async fn new(pool: sqlx::PgPool) -> Self {
        let store = PgStore::connect(pool.connect_options().to_url_lossy().as_str())
            .await
            .unwrap();
        let (ids, _) = store.bootstrap_demo().await.unwrap();
        let provider = ProviderFixture::new(ProviderKind::Entra).await;
        let expected = provider.expected();
        // Login's pairwise sub must survive mapping the same issuer's stable oid.
        store
            .link_human_identity(
                ids.alice_actor_id,
                &expected.issuer,
                "different-pairwise-login-sub",
                None,
            )
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO delegated_identities(corp_id,actor_id,issuer,subject) VALUES($1,$2,$3,$4)",
        )
        .bind(ids.corp_id)
        .bind(ids.alice_actor_id)
        .bind(&expected.issuer)
        .bind(&expected.subject)
        .execute(&pool)
        .await
        .unwrap();
        let runner = format!("delegated-handler-{}", Uuid::new_v4());
        let epoch = Uuid::new_v4();
        store
            .runner_connected(RunnerConnectInput {
                id: runner.clone(),
                corp_id: ids.corp_id,
                hostname: "synthetic-only".into(),
                os: "windows".into(),
                capabilities: json!([]),
                connection_epoch: epoch,
            })
            .await
            .unwrap();
        sqlx::query("INSERT INTO runner_credentials(id,runner_id,corp_id,token_hash,expires_at,enrolled_by) VALUES($1,$2,$3,$4,now()+interval '1 hour',$5)")
            .bind(Uuid::new_v4()).bind(&runner).bind(ids.corp_id).bind(hash(&random())).bind(ids.alice_actor_id).execute(&pool).await.unwrap();
        let resource_reads = Arc::new(AtomicUsize::new(0));
        let reads = resource_reads.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let resource_url = format!("http://{}/flag", listener.local_addr().unwrap());
        let resource_task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/flag",
                    get(move |headers: HeaderMap| async move {
                        assert!(headers.contains_key("authorization"));
                        reads.fetch_add(1, Ordering::SeqCst);
                        Json(json!({"flag":"synthetic-protected-value"}))
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let (audience, scope) = provider.audience_scope();
        let artifacts = ArtifactStore::initialize(
            "local",
            std::env::temp_dir().join(format!("ecorp-delegated-test-{}", Uuid::new_v4())),
            None,
            None,
            None,
            None,
            None,
            false,
            None,
            1024,
            false,
        )
        .unwrap();
        let (event_tx, _) = broadcast::channel(64);
        let state = AppState {
            store,
            event_tx,
            runners: Arc::new(DashMap::new()),
            strategies: StrategyRegistry::new(),
            runner_grace_secs: 10,
            runner_credential_ttl_secs: 300,
            publication_publisher_credential_ttl_secs: 300,
            auth: AuthService::initialize(ServerMode::Development, None, false)
                .await
                .unwrap(),
            secret_cipher: SecretCipher::initialize(ServerMode::Development, None).unwrap(),
            artifacts,
            artifact_retention_days: 1,
            workspace_sign_in: Arc::new(DashMap::new()),
            delegated: Some(Arc::new(Broker {
                provider: provider.adapter(),
                resource_url,
                expected_digest: hash("synthetic-protected-value"),
                audience,
                scope,
                browser_base: "http://127.0.0.1:1".into(),
                ui_url: "http://127.0.0.1:2".into(),
                client: reqwest::Client::builder().no_proxy().build().unwrap(),
            })),
        };
        Self {
            state,
            ids,
            provider,
            runner,
            epoch,
            resource_reads,
            resource_task,
        }
    }

    fn principal(&self) -> Principal {
        Principal::Oidc {
            issuer: self.provider.expected().issuer,
            subject: "different-pairwise-login-sub".into(),
            email: None,
        }
    }

    async fn operation(&self) -> Operation {
        let capability = RunnerCapability {
            name: "delegated-resource".into(),
            available: true,
            detail: None,
            models: vec![],
            source_repository: Some("fixture/delegated".into()),
            source_base_ref: Some("main".into()),
            source_base_commit: Some("a".repeat(40)),
            workspace_connection_id: None,
        };
        let expected = self.provider.expected();
        let (ids, _) = persist_job(
            &self.state.store,
            self.ids.corp_id,
            self.ids.alice_actor_id,
            self.ids.room_id,
            &expected.issuer,
            &expected.subject,
            &protected_plan(&capability),
        )
        .await
        .unwrap();
        let (launch, _) = self
            .state
            .store
            .create_task_run(
                self.ids.corp_id,
                ids.mission_id,
                ids.task_ids[0],
                Some(self.ids.alice_actor_id),
                &self.runner,
            )
            .await
            .unwrap();
        let id = sqlx::query_scalar("SELECT id FROM delegated_operations WHERE task_id=$1")
            .bind(launch.task_id)
            .fetch_one(self.state.store.pool())
            .await
            .unwrap();
        let op = Operation {
            id,
            mission: ids.mission_id,
            assignment: RunnerRead {
                run_id: launch.run_id,
                task_id: launch.task_id,
                runner_id: self.runner.clone(),
                connection_epoch: self.epoch,
                assignment_token: launch.assignment_token,
            },
        };
        assert_eq!(
            runner_read(State(self.state.clone()), Json(self.assignment(&op)))
                .await
                .unwrap()
                .0,
            StatusCode::ACCEPTED
        );
        op
    }

    fn assignment(&self, op: &Operation) -> RunnerRead {
        RunnerRead {
            run_id: op.assignment.run_id,
            task_id: op.assignment.task_id,
            runner_id: self.runner.clone(),
            connection_epoch: self.epoch,
            assignment_token: op.assignment.assignment_token,
        }
    }

    async fn authorize(&self, op: &Operation) -> Result<Json<serde_json::Value>, ApiError> {
        authorize(
            State(self.state.clone()),
            Extension(self.principal()),
            Path((self.ids.corp_id, op.id)),
            Json(ActorRequest {
                actor_id: self.ids.alice_actor_id,
            }),
        )
        .await
    }

    async fn flow(&self, op: &Operation) -> Flow {
        let answer = self.authorize(op).await.unwrap();
        let ticket = answer.0["browser_url"]
            .as_str()
            .unwrap()
            .rsplit('/')
            .next()
            .unwrap()
            .to_owned();
        let response = open_browser(State(self.state.clone()), Path(ticket.clone()))
            .await
            .unwrap();
        let location =
            reqwest::Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
        let state = location
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("cookie", HeaderValue::from_str(cookie).unwrap());
        let transaction =
            sqlx::query_scalar("SELECT authentication_id FROM delegated_operations WHERE id=$1")
                .bind(op.id)
                .fetch_one(self.state.store.pool())
                .await
                .unwrap();
        Flow {
            ticket,
            state,
            headers,
            transaction,
        }
    }

    async fn signed_replies(&self, flow: &Flow) {
        let nonce: String =
            sqlx::query_scalar("SELECT oidc_nonce FROM delegated_auth_transactions WHERE id=$1")
                .bind(flow.transaction)
                .fetch_one(self.state.store.pool())
                .await
                .unwrap();
        let (mut id, mut assertion) = self.provider.initial_claims();
        id["nonce"] = json!(nonce);
        assertion["nonce"] = id["nonce"].clone();
        self.provider.initial_reply(&id, &assertion);
        self.provider.downstream_reply(&self.provider.downstream());
    }

    async fn release(&self, op: &Operation) -> Result<Json<serde_json::Value>, ApiError> {
        release(
            State(self.state.clone()),
            Extension(self.principal()),
            Path((self.ids.corp_id, op.id)),
            Json(ActorRequest {
                actor_id: self.ids.alice_actor_id,
            }),
        )
        .await
    }

    async fn seed_token(&self, op: &Operation) {
        let (cipher, nonce) = self
            .state
            .secret_cipher
            .encrypt(
                self.ids.corp_id,
                op.id,
                "delegated-token",
                random().as_bytes(),
            )
            .unwrap();
        sqlx::query("UPDATE delegated_operations SET status='authorized',token_ciphertext=$2,token_nonce=$3,token_expires_at=now()+interval '5 minutes' WHERE id=$1")
            .bind(op.id).bind(cipher).bind(nonce).execute(self.state.store.pool()).await.unwrap();
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn delegated_separate_login_and_provider_identity_complete_real_handlers(pool: sqlx::PgPool) {
    let f = Fixture::new(pool.clone()).await;
    let op = f.operation().await;
    let flow = f.flow(&op).await;
    f.signed_replies(&flow).await;
    finish_callback(&f.state, flow.callback(), &flow.headers)
        .await
        .unwrap();
    assert_eq!(f.provider.request_count(), 2);
    assert_eq!(
        runner_read(State(f.state.clone()), Json(f.assignment(&op)))
            .await
            .unwrap()
            .0,
        StatusCode::ACCEPTED
    );
    assert_eq!(f.resource_reads.load(Ordering::SeqCst), 1);
    let _ = f.release(&op).await.unwrap();
    let (status, Json(result)) = runner_read(State(f.state.clone()), Json(f.assignment(&op)))
        .await
        .unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["receipt"]["run_id"], json!(op.assignment.run_id));
    assert_eq!(
        result["receipt"]["sha256"],
        hash("synthetic-protected-value")
    );
    assert!(!result.to_string().contains("synthetic-protected-value"));
    let identity:(String,String)=sqlx::query_as("SELECT h.subject,di.subject FROM human_identities h JOIN delegated_identities di ON di.actor_id=h.actor_id AND di.issuer=h.issuer WHERE h.actor_id=$1")
        .bind(f.ids.alice_actor_id).fetch_one(&pool).await.unwrap();
    assert_eq!(
        identity,
        (
            "different-pairwise-login-sub".into(),
            f.provider.expected().subject
        )
    );
    let erased:bool=sqlx::query_scalar("SELECT token_ciphertext IS NULL AND token_nonce IS NULL FROM delegated_operations WHERE id=$1")
        .bind(op.id).fetch_one(&pool).await.unwrap();
    assert!(erased);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn delegated_revoked_authority_denies_all_new_effects(pool: sqlx::PgPool) {
    let f = Fixture::new(pool.clone()).await;
    let op = f.operation().await;
    let cases = [
        (
            "UPDATE runs SET status='cancelled' WHERE id=$1",
            op.assignment.run_id,
            "UPDATE runs SET status='starting' WHERE id=$1",
        ),
        (
            "UPDATE runs SET breaker_stage='stop' WHERE id=$1",
            op.assignment.run_id,
            "UPDATE runs SET breaker_stage='healthy' WHERE id=$1",
        ),
        (
            "UPDATE tasks SET status='cancelled' WHERE id=$1",
            op.assignment.task_id,
            "UPDATE tasks SET status='claimed' WHERE id=$1",
        ),
        (
            "UPDATE missions SET status='cancelled' WHERE id=$1",
            op.mission,
            "UPDATE missions SET status='running' WHERE id=$1",
        ),
        (
            "UPDATE actors SET role='viewer' WHERE id=$1",
            f.ids.alice_actor_id,
            "UPDATE actors SET role='owner' WHERE id=$1",
        ),
        (
            "UPDATE delegated_identities SET subject='revoked' WHERE actor_id=$1",
            f.ids.alice_actor_id,
            "UPDATE delegated_identities SET subject='22222222-2222-4222-8222-222222222222' WHERE actor_id=$1",
        ),
        (
            "UPDATE runner_credentials SET revoked_at=now() WHERE corp_id=$1",
            f.ids.corp_id,
            "UPDATE runner_credentials SET revoked_at=NULL WHERE corp_id=$1",
        ),
        (
            "UPDATE runner_credentials SET expires_at=now()-interval '1 second' WHERE corp_id=$1",
            f.ids.corp_id,
            "UPDATE runner_credentials SET expires_at=now()+interval '1 hour' WHERE corp_id=$1",
        ),
    ];
    for (revoke, id, restore) in cases {
        let flow = f.flow(&op).await;
        sqlx::query(revoke).bind(id).execute(&pool).await.unwrap();
        assert!(
            f.authorize(&op).await.is_err(),
            "revoked authority created a new authorization"
        );
        assert!(
            open_browser(State(f.state.clone()), Path(flow.ticket.clone()))
                .await
                .is_err()
        );
        assert!(
            finish_callback(&f.state, flow.callback(), &flow.headers)
                .await
                .is_err()
        );
        assert!(
            runner_read(State(f.state.clone()), Json(f.assignment(&op)))
                .await
                .is_err()
        );
        assert!(f.release(&op).await.is_err());
        assert_eq!(f.provider.request_count(), 0);
        assert_eq!(f.resource_reads.load(Ordering::SeqCst), 0);
        sqlx::query(restore).bind(id).execute(&pool).await.unwrap();
    }
    sqlx::query("DELETE FROM room_memberships WHERE actor_id=$1")
        .bind(f.ids.alice_actor_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(f.authorize(&op).await.is_err());
    assert!(
        runner_read(State(f.state.clone()), Json(f.assignment(&op)))
            .await
            .is_err()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn delegated_original_assignment_survives_reconnect_and_refuses_rebinding(
    pool: sqlx::PgPool,
) {
    let f = Fixture::new(pool.clone()).await;
    let op = f.operation().await;
    sqlx::query("UPDATE runner_nodes SET connection_epoch=$2 WHERE id=$1")
        .bind(&f.runner)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();
    let mut altered = f.assignment(&op);
    altered.connection_epoch =
        sqlx::query_scalar("SELECT connection_epoch FROM runner_nodes WHERE id=$1")
            .bind(&f.runner)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        runner_read(State(f.state.clone()), Json(altered))
            .await
            .is_err()
    );
    assert!(f.authorize(&op).await.is_err());
    let retained: Uuid =
        sqlx::query_scalar("SELECT connection_epoch FROM delegated_operations WHERE id=$1")
            .bind(op.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(retained, f.epoch);
    expire(&pool).await.unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM delegated_operations WHERE id=$1")
        .bind(op.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "failed");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn delegated_callback_consumed_before_effect_and_concurrent_replay_denied(
    pool: sqlx::PgPool,
) {
    let f = Fixture::new(pool.clone()).await;
    let op = f.operation().await;
    let flow = f.flow(&op).await;
    f.signed_replies(&flow).await;
    let gate = f.provider.gate_next_request();
    let state = f.state.clone();
    let query = flow.callback();
    let headers = flow.headers.clone();
    let pending = tokio::spawn(async move { finish_callback(&state, query, &headers).await });
    tokio::time::timeout(StdDuration::from_secs(2), gate.entered.notified())
        .await
        .unwrap();
    let scrubbed:bool=sqlx::query_scalar("SELECT consumed AND octet_length(pkce_ciphertext)=0 AND octet_length(pkce_nonce)=0 AND cookie_hash IS NULL FROM delegated_auth_transactions WHERE id=$1")
        .bind(flow.transaction).fetch_one(&pool).await.unwrap();
    assert!(
        scrubbed,
        "PKCE consumption must commit before provider redemption"
    );
    assert!(
        finish_callback(&f.state, flow.callback(), &flow.headers)
            .await
            .is_err()
    );
    gate.release.add_permits(1);
    pending.await.unwrap().unwrap();
    assert_eq!(f.provider.request_count(), 2);
    assert!(
        finish_callback(&f.state, flow.callback(), &flow.headers)
            .await
            .is_err()
    );
    assert_eq!(f.provider.request_count(), 2);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn delegated_failed_redemption_cannot_replay_or_fail_a_new_attempt(pool: sqlx::PgPool) {
    let f = Fixture::new(pool.clone()).await;
    let op = f.operation().await;
    let old = f.flow(&op).await;
    let current = f.flow(&op).await;
    assert!(
        finish_callback(&f.state, old.callback(), &old.headers)
            .await
            .is_err()
    );
    let retained: Uuid =
        sqlx::query_scalar("SELECT authentication_id FROM delegated_operations WHERE id=$1")
            .bind(op.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(retained, current.transaction);
    f.provider.reply(
        StatusCode::BAD_GATEWAY,
        json!({"error":"synthetic-rejection"}),
    );
    assert!(
        finish_callback(&f.state, current.callback(), &current.headers)
            .await
            .is_err()
    );
    assert!(
        finish_callback(&f.state, current.callback(), &current.headers)
            .await
            .is_err()
    );
    assert_eq!(f.provider.request_count(), 1);
    let status: String = sqlx::query_scalar("SELECT status FROM delegated_operations WHERE id=$1")
        .bind(op.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "failed");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn delegated_release_serializes_with_credential_revocation(pool: sqlx::PgPool) {
    let f = Fixture::new(pool.clone()).await;
    let op = f.operation().await;
    f.seed_token(&op).await;
    let _ = runner_read(State(f.state.clone()), Json(f.assignment(&op)))
        .await
        .unwrap();
    let mut revocation = pool.begin().await.unwrap();
    sqlx::query("UPDATE runner_credentials SET revoked_at=now() WHERE runner_id=$1")
        .bind(&f.runner)
        .execute(&mut *revocation)
        .await
        .unwrap();
    let state = f.state.clone();
    let principal = f.principal();
    let corp = f.ids.corp_id;
    let id = op.id;
    let actor = f.ids.alice_actor_id;
    let pending = tokio::spawn(async move {
        release(
            State(state),
            Extension(principal),
            Path((corp, id)),
            Json(ActorRequest { actor_id: actor }),
        )
        .await
    });
    tokio::time::sleep(StdDuration::from_millis(80)).await;
    assert!(
        !pending.is_finished(),
        "release must not pass a concurrent revocation lock"
    );
    revocation.commit().await.unwrap();
    assert!(pending.await.unwrap().is_err());
    let released: bool =
        sqlx::query_scalar("SELECT released FROM delegated_operations WHERE id=$1")
            .bind(op.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!released);
    assert_eq!(f.resource_reads.load(Ordering::SeqCst), 1);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn delegated_cancel_waits_for_authorized_effect_and_scrubs_token(pool: sqlx::PgPool) {
    let f = Fixture::new(pool.clone()).await;
    let op = f.operation().await;
    let flow = f.flow(&op).await;
    f.signed_replies(&flow).await;
    let gate = f.provider.gate_next_request();
    let state = f.state.clone();
    let query = flow.callback();
    let headers = flow.headers.clone();
    let callback = tokio::spawn(async move { finish_callback(&state, query, &headers).await });
    tokio::time::timeout(StdDuration::from_secs(2), gate.entered.notified())
        .await
        .unwrap();
    let state = f.state.clone();
    let principal = f.principal();
    let corp = f.ids.corp_id;
    let id = op.id;
    let actor = f.ids.alice_actor_id;
    let cancel = tokio::spawn(async move {
        cancel(
            State(state),
            Extension(principal),
            Path((corp, id)),
            Json(ActorRequest { actor_id: actor }),
        )
        .await
    });
    tokio::time::sleep(StdDuration::from_millis(80)).await;
    assert!(!cancel.is_finished());
    gate.release.add_permits(1);
    callback.await.unwrap().unwrap();
    let _ = cancel.await.unwrap().unwrap();
    let terminal:bool=sqlx::query_scalar("SELECT status='cancelled' AND token_ciphertext IS NULL AND token_nonce IS NULL AND token_expires_at IS NULL FROM delegated_operations WHERE id=$1")
        .bind(op.id).fetch_one(&pool).await.unwrap();
    assert!(terminal);
    assert!(
        runner_read(State(f.state.clone()), Json(f.assignment(&op)))
            .await
            .is_err()
    );
    assert_eq!(f.resource_reads.load(Ordering::SeqCst), 0);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn delegated_independent_expiry_is_bounded_and_erases_abandoned_pkce(pool: sqlx::PgPool) {
    let f = Fixture::new(pool.clone()).await;
    let op = f.operation().await;
    // Populate >2 batches, sharing only this fixture's mission and actor. No
    // task launch or client request is needed to make expiry progress.
    sqlx::query("WITH new_tasks AS (INSERT INTO tasks(id,mission_id,corp_id,title,objective,status,plan_key,contract,verification_policy) SELECT gen_random_uuid(),$1,$2,'expiry','fixture','pending',gen_random_uuid()::text,t.contract,t.verification_policy FROM tasks t CROSS JOIN generate_series(1,260) WHERE t.id=$6 RETURNING id),
        new_ops AS (INSERT INTO delegated_operations(id,corp_id,actor_id,mission_id,task_id,issuer,subject,status,expires_at,token_ciphertext,token_nonce)
        SELECT gen_random_uuid(),$2,$3,$1,id,$4,$5,'authenticating',now()-interval '1 second','fixture'::bytea,'fixture'::bytea FROM new_tasks RETURNING id)
        INSERT INTO delegated_auth_transactions(id,operation_id,ticket_hash,state_hash,pkce_ciphertext,pkce_nonce,oidc_nonce,expires_at,cookie_hash)
        SELECT gen_random_uuid(),id,gen_random_uuid()::text,gen_random_uuid()::text,'fixture'::bytea,'fixture'::bytea,'fixture',now()-interval '1 second','fixture' FROM new_ops")
        .bind(op.mission)
        .bind(f.ids.corp_id)
        .bind(f.ids.alice_actor_id)
        .bind(f.provider.expected().issuer)
        .bind(f.provider.expected().subject)
        .bind(op.assignment.task_id)
        .execute(&pool).await.unwrap();
    expire(&pool).await.unwrap();
    let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM delegated_operations WHERE status='expired'),(SELECT count(*) FROM delegated_auth_transactions WHERE consumed)").fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (128, 128));
    expire(&pool).await.unwrap();
    expire(&pool).await.unwrap();
    let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM delegated_operations WHERE status='expired' AND token_ciphertext IS NULL AND token_nonce IS NULL),(SELECT count(*) FROM delegated_auth_transactions WHERE consumed AND octet_length(pkce_ciphertext)=0 AND cookie_hash IS NULL)").fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (260, 260));
    let flow = f.flow(&op).await;
    start_expiry_sweep(pool.clone()).await.unwrap();
    sqlx::query("UPDATE delegated_operations SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(op.id)
        .execute(&pool)
        .await
        .unwrap();
    tokio::time::timeout(StdDuration::from_secs(8),async {
        loop {
            let scrubbed:bool=sqlx::query_scalar("SELECT o.status='expired' AND t.consumed AND octet_length(t.pkce_ciphertext)=0 AND t.cookie_hash IS NULL FROM delegated_operations o JOIN delegated_auth_transactions t ON t.operation_id=o.id WHERE t.id=$1")
                .bind(flow.transaction).fetch_one(&pool).await.unwrap();
            if scrubbed {break}
            tokio::time::sleep(StdDuration::from_millis(100)).await;
        }
    }).await.unwrap();
    assert_eq!(f.provider.request_count(), 0);
}
