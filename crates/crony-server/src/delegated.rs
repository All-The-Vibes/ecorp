use super::*;
use axum::response::Redirect;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use crony_domain::{PlannedAgent, PlannedTask, TaskContract, VerifierCheck};
use delegated_provider::{DelegatedProvider, ExpectedIdentity, ProviderConfig, ProviderKind};
use sqlx::Row;

pub(super) struct Broker {
    provider: DelegatedProvider,
    resource_url: String,
    expected_digest: String,
    audience: String,
    scope: String,
    browser_base: String,
    ui_url: String,
    client: reqwest::Client,
}

impl Broker {
    pub async fn from_env(mode: ServerMode) -> anyhow::Result<Option<Arc<Self>>> {
        let Some(config) = ProviderConfig::from_env()? else {
            return Ok(None);
        };
        anyhow::ensure!(
            mode != ServerMode::Production || config.kind == ProviderKind::Entra,
            "test delegated provider is forbidden in production"
        );
        let read = |name| {
            std::env::var(name).map_err(|_| anyhow::anyhow!("delegated configuration missing"))
        };
        let resource_url = read("CRONY_DELEGATED_RESOURCE_URL")?;
        let expected_digest = read("CRONY_DELEGATED_EXPECTED_SHA256")?;
        let browser_base = read("CRONY_DELEGATED_BROWSER_BASE")?;
        let ui_url = read("CRONY_DELEGATED_UI_URL")?;
        anyhow::ensure!(
            expected_digest.len() == 64 && expected_digest.bytes().all(|b| b.is_ascii_hexdigit()),
            "delegated independent verifier digest is invalid"
        );
        for value in [&resource_url, &browser_base, &ui_url] {
            let url =
                reqwest::Url::parse(value).map_err(|_| anyhow::anyhow!("delegated URL invalid"))?;
            anyhow::ensure!(
                url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && (url.scheme() == "https"
                        || (mode == ServerMode::Development
                            && url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1"))),
                "delegated URL requires HTTPS or explicit development loopback"
            );
        }
        let audience = config.downstream_audience.clone();
        let scope = config.downstream_scope.clone();
        Ok(Some(Arc::new(Self {
            provider: DelegatedProvider::new(config).await?,
            resource_url,
            expected_digest,
            audience,
            scope,
            browser_base,
            ui_url,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(StdDuration::from_secs(10))
                .build()?,
        })))
    }
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/corps/{corp}/delegated", get(list))
        .route("/api/corps/{corp}/delegated/jobs", post(create_job))
        .route(
            "/api/corps/{corp}/delegated/{operation}/authorize",
            post(authorize),
        )
        .route(
            "/api/corps/{corp}/delegated/{operation}/cancel",
            post(cancel),
        )
        .route(
            "/api/corps/{corp}/delegated/{operation}/release",
            post(release),
        )
        .layer(middleware::from_fn(no_store))
}

// OAuth codes and one-use browser tickets MUST NOT pass through request-URI tracing.
pub(super) fn private_routes() -> Router<AppState> {
    Router::new()
        .route("/api/delegated/browser/{ticket}", get(open_browser))
        .route("/api/delegated/callback", get(callback))
        .route("/api/delegated/runner/read", post(runner_read))
        .layer(middleware::from_fn(no_store))
}

async fn no_store(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn deny() -> ApiError {
    ApiError::forbidden("Delegated operation denied")
}
fn db(_: sqlx::Error) -> ApiError {
    ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: "Delegated storage failed".into(),
    }
}
fn provider_error(_: impl std::fmt::Display) -> ApiError {
    ApiError {
        status: StatusCode::BAD_GATEWAY,
        message: "Delegated provider validation failed".into(),
    }
}
fn broker(state: &AppState) -> Result<&Broker, ApiError> {
    state.delegated.as_deref().ok_or(ApiError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        message: "Entra delegated connections are disabled until configured".into(),
    })
}
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
pub(super) fn random() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn credential_allowed(status: &str, expiry: i64, now: i64) -> bool {
    status == "authorized" && expiry > now
}
fn browser_cookie(header: &str) -> Option<&str> {
    header
        .split(';')
        .find_map(|part| part.trim().strip_prefix("delegated_flow="))
}
fn verified_receipt(value: &str, expected: &str) -> Result<serde_json::Value, ApiError> {
    if value.is_empty() || value.len() > 128 || hash(value) != expected {
        return Err(deny());
    }
    Ok(json!({"sha256": hash(value), "verified": true, "subject_preserved": true}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActorRequest {
    actor_id: Uuid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobRequest {
    actor_id: Uuid,
    room_id: Uuid,
}

async fn require_owner(
    state: &AppState,
    principal: &Principal,
    corp: Uuid,
    actor: Uuid,
    operation: Uuid,
) -> Result<(), ApiError> {
    authorize_actor(state, principal, corp, Some(actor), Permission::Operate).await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM delegated_operations o JOIN missions m ON m.id=o.mission_id
         JOIN room_memberships rm ON rm.room_id=m.room_id AND rm.actor_id=o.actor_id
         WHERE o.id=$1 AND o.corp_id=$2 AND o.actor_id=$3 AND m.corp_id=o.corp_id)",
    )
    .bind(operation)
    .bind(corp)
    .bind(actor)
    .fetch_one(state.store.pool())
    .await
    .map_err(db)?;
    if !exists {
        return Err(deny());
    }
    Ok(())
}

async fn expire(state: &AppState) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE delegated_operations o SET status=CASE WHEN r.status='completed' THEN 'completed'
        WHEN r.status='cancelled' THEN 'cancelled' ELSE 'failed' END,
        token_ciphertext=NULL,token_nonce=NULL,run_id=r.id FROM runs r
        WHERE o.task_id=r.task_id AND (o.run_id=r.id OR o.run_id IS NULL)
        AND r.status IN ('completed','cancelled','failed','lost')
        AND o.status NOT IN ('completed','cancelled','expired','failed')",
    )
    .execute(state.store.pool())
    .await
    .map_err(db)?;
    sqlx::query(
        "UPDATE delegated_operations SET status='expired',token_ciphertext=NULL,token_nonce=NULL
        WHERE status NOT IN ('cancelled','expired','failed','completed')
        AND (expires_at<=now() OR (token_expires_at<=now() AND preview IS NULL))",
    )
    .execute(state.store.pool())
    .await
    .map_err(db)?;
    Ok(())
}

async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(corp): Path<Uuid>,
    Query(request): Query<ActorRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = authorize_actor(
        &state,
        &principal,
        corp,
        Some(request.actor_id),
        Permission::Operate,
    )
    .await?;
    expire(&state).await?;
    let rows = sqlx::query(
        "SELECT o.*,r.status AS run_status FROM delegated_operations o
        JOIN missions m ON m.id=o.mission_id
        JOIN room_memberships rm ON rm.room_id=m.room_id AND rm.actor_id=o.actor_id
        LEFT JOIN runs r ON r.id=o.run_id
        WHERE o.corp_id=$1 AND o.actor_id=$2 ORDER BY o.created_at DESC LIMIT 50",
    )
    .bind(corp)
    .bind(actor)
    .fetch_all(state.store.pool())
    .await
    .map_err(db)?;
    let operations: Vec<_> = rows.iter().map(|r| {
        let mut status: String = r.get("status");
        if r.get::<Option<String>,_>("run_status").as_deref() == Some("completed") { status="completed".into() }
        json!({"id":r.get::<Uuid,_>("id"),"mission_id":r.get::<Uuid,_>("mission_id"),
            "task_id":r.get::<Uuid,_>("task_id"),"run_id":r.get::<Option<Uuid>,_>("run_id"),
            "status":status,"expires_at":r.get::<chrono::DateTime<Utc>,_>("expires_at"),
            "private_preview":r.get::<Option<serde_json::Value>,_>("preview"),"released":r.get::<bool,_>("released")})
    }).collect();
    let provider = state.delegated.as_ref().map(|b| b.provider.kind());
    Ok(Json(
        json!({"provider":if provider==Some(ProviderKind::KeycloakTest) {"keycloak-test"} else {"entra"},
        "enabled":provider.is_some(),"operations":operations}),
    ))
}

async fn create_job(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(corp): Path<Uuid>,
    Json(request): Json<JobRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let b = broker(&state)?;
    let actor = authorize_actor(
        &state,
        &principal,
        corp,
        Some(request.actor_id),
        Permission::Operate,
    )
    .await?;
    let subject: Option<String> = sqlx::query_scalar(
        "SELECT hi.subject FROM human_identities hi JOIN actors a ON a.id=hi.actor_id
         JOIN room_memberships rm ON rm.actor_id=a.id JOIN rooms room ON room.id=rm.room_id
         WHERE hi.actor_id=$1 AND hi.issuer=$2 AND a.corp_id=$3 AND room.id=$4 AND room.corp_id=$3",
    )
    .bind(actor)
    .bind(b.provider.issuer())
    .bind(corp)
    .bind(request.room_id)
    .fetch_optional(state.store.pool())
    .await
    .map_err(db)?;
    let subject = subject.ok_or_else(deny)?;
    let source = state
        .runners
        .iter()
        .filter(|r| r.corp_id == corp && r.dispatch_ready)
        .flat_map(|r| r.capabilities.clone())
        .find(|c| c.name == "delegated-resource" && c.available)
        .ok_or_else(|| ApiError::conflict("No connected delegated-resource runner"))?;
    let plan = protected_plan(&source);
    let (ids, events) = persist_job(
        &state.store,
        corp,
        actor,
        request.room_id,
        b.provider.issuer(),
        &subject,
        &plan,
    )
    .await?;
    for event in events {
        publish(&state, event);
    }
    let outcome = schedule_ready_tasks(&state, corp, ids.mission_id, Some(actor))
        .await
        .map_err(ApiError::conflict)?;
    if !outcome.failures.is_empty() {
        return Err(ApiError::conflict(outcome.failure_message()));
    }
    Ok(Json(
        json!({"mission_id":ids.mission_id,"task_id":ids.task_ids[0]}),
    ))
}

async fn persist_job(
    store: &PgStore,
    corp: Uuid,
    actor: Uuid,
    room_id: Uuid,
    issuer: &str,
    subject: &str,
    plan: &TaskGraphPlan,
) -> Result<(crony_store::MissionPlanIds, Vec<crony_domain::DomainEvent>), ApiError> {
    let mut tx = store.pool().begin().await.map_err(db)?;
    let (ids,events)=store.create_mission_in_transaction(&mut tx,corp,actor,"Read protected resource with human delegation",
        "Trusted delegated read. Authenticate in the browser; inspect and explicitly release only the verified receipt. No credential enters the worker context.",plan)
        .await.map_err(map_store_error)?;
    // Rejection rolls back staffing, tasks and events together with the mission.
    let room: Uuid = sqlx::query_scalar("SELECT room_id FROM missions WHERE id=$1")
        .bind(ids.mission_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    if room != room_id {
        return Err(ApiError::conflict("Select the canonical mission room"));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO delegated_operations(id,corp_id,actor_id,mission_id,task_id,issuer,subject,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'waiting_for_authentication',now()+interval '15 minutes')")
        .bind(id).bind(corp).bind(actor).bind(ids.mission_id).bind(ids.task_ids[0])
        .bind(issuer).bind(subject).execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok((ids, events))
}

fn protected_plan(source: &RunnerCapability) -> TaskGraphPlan {
    let agent_id = Uuid::new_v4();
    TaskGraphPlan {
        strategy:"single".into(),max_nodes:1,max_depth:0,budget_tokens:1000,budget_cost_microusd:1000,
        staffing:vec![PlannedAgent{id:agent_id,name:"Delegated resource reader".into(),role:"worker".into(),
            adapter:"delegated-resource".into(),accent:"#b11f4b".into()}],
        tasks:vec![PlannedTask{key:"protected-read".into(),title:"Read protected resource and verify receipt".into(),
            assigned_agent_id:agent_id,required_adapter:"delegated-resource".into(),depends_on:vec![],depth:0,max_attempts:1,
            contract:TaskContract{
                objective:"Read the configured protected resource through the trusted delegated broker; await the exact human's private receipt release.".into(),
                expected_output:"A broker-verified, human-released digest receipt, never raw protected data or credentials.".into(),
                source_repository:source.source_repository.clone(),source_base_ref:source.source_base_ref.clone(),
                source_base_commit:source.source_base_commit.clone(),workspace_connection_id:None,
                acceptance_tests:vec!["Independent configured resource digest matches actual protected read".into()],
                allowed_tools:vec!["delegated.read".into()],prohibited_actions:vec!["credential export".into(),"remote publication".into()],
                references:vec![],write_scope:vec!["delegated-result.json".into()],budget_tokens:1000,budget_cost_microusd:1000,
                deadline_at:None,escalation:"Cancel on denied, expired, mismatched, or revoked delegation".into(),
                secret_refs:vec![],model:None,reasoning_effort:None,deliverable:None},
            verification_policy:VerificationPolicy{checks:vec![VerifierCheck::Artifact{min_bytes:100},
                VerifierCheck::JsonSchema{path:"delegated-result.json".into(),
                    required_keys:vec!["operation_id","run_id","task_id","sha256","verified","subject_preserved"]
                        .into_iter().map(str::to_owned).collect()}],manual_gate:None}}]
    }
}

async fn authorize(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp, id)): Path<(Uuid, Uuid)>,
    Json(request): Json<ActorRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let b = broker(&state)?;
    require_owner(&state, &principal, corp, request.actor_id, id).await?;
    let mut tx = state.store.pool().begin().await.map_err(db)?;
    let active: Option<Uuid>=sqlx::query_scalar("SELECT o.id FROM delegated_operations o JOIN runs r ON r.id=o.run_id
        WHERE o.id=$1 AND o.expires_at>now() AND o.status IN ('waiting_for_authentication','authenticating')
        AND r.status IN ('starting','running','waiting_for_input') AND r.breaker_stage NOT IN ('stop','suspend') FOR UPDATE OF o")
        .bind(id).fetch_optional(&mut *tx).await.map_err(db)?;
    if active.is_none() {
        return Err(deny());
    }
    sqlx::query("UPDATE delegated_auth_transactions SET consumed=true WHERE operation_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let ticket = random();
    // High-entropy CSRF state, not a human password; SHA-256 is its lookup digest.
    let csrf_state = random();
    let verifier = random();
    let nonce = random();
    let transaction = Uuid::new_v4();
    // State is carried only in the encrypted transaction, not a browser DTO.
    let (encrypted, iv) = state
        .secret_cipher
        .encrypt(
            corp,
            transaction,
            "delegated-pkce",
            json!({"verifier":verifier,"state":csrf_state})
                .to_string()
                .as_bytes(),
        )
        .map_err(provider_error)?;
    sqlx::query("INSERT INTO delegated_auth_transactions(id,operation_id,ticket_hash,state_hash,pkce_ciphertext,pkce_nonce,oidc_nonce,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')")
        .bind(transaction).bind(id).bind(hash(&ticket)).bind(hash(&csrf_state)).bind(encrypted).bind(iv).bind(nonce)
        .execute(&mut *tx).await.map_err(db)?;
    sqlx::query("UPDATE delegated_operations SET status='authenticating' WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(
        json!({"browser_url":format!("{}/api/delegated/browser/{ticket}",b.browser_base.trim_end_matches('/'))}),
    ))
}

async fn open_browser(
    State(state): State<AppState>,
    Path(ticket): Path<String>,
) -> Result<Response, ApiError> {
    let b = broker(&state)?;
    let cookie = random();
    let row=sqlx::query("UPDATE delegated_auth_transactions t SET opened=true,cookie_hash=$2
        FROM delegated_operations o WHERE t.ticket_hash=$1 AND t.operation_id=o.id AND NOT t.opened AND NOT t.consumed
        AND t.expires_at>now() AND o.expires_at>now() AND o.status='authenticating'
        RETURNING t.*,o.corp_id")
        .bind(hash(&ticket)).bind(hash(&cookie)).fetch_optional(state.store.pool()).await.map_err(db)?.ok_or_else(deny)?;
    let bytes = state
        .secret_cipher
        .decrypt(
            row.get("corp_id"),
            row.get("id"),
            "delegated-pkce",
            &row.get::<Vec<u8>, _>("pkce_ciphertext"),
            &row.get::<Vec<u8>, _>("pkce_nonce"),
        )
        .map_err(provider_error)?;
    let secrets: serde_json::Value = serde_json::from_slice(&bytes).map_err(provider_error)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(
        secrets["verifier"].as_str().ok_or_else(deny)?.as_bytes(),
    ));
    let url = b
        .provider
        .authorization_url(
            secrets["state"].as_str().ok_or_else(deny)?,
            &challenge,
            row.get::<String, _>("oidc_nonce").as_str(),
        )
        .map_err(provider_error)?;
    let secure = if b.browser_base.starts_with("https:") {
        "; Secure"
    } else {
        ""
    };
    let mut response = Redirect::to(&url).into_response();
    response.headers_mut().insert("set-cookie",HeaderValue::from_str(&format!(
        "delegated_flow={cookie}; HttpOnly; SameSite=Lax; Path=/api/delegated; Max-Age=600{secure}")).map_err(provider_error)?);
    Ok(response)
}

#[derive(Deserialize)]
struct Callback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}

async fn callback(
    State(state): State<AppState>,
    Query(query): Query<Callback>,
    headers: HeaderMap,
) -> Response {
    let result = finish_callback(&state, query, &headers).await;
    let Some(b) = state.delegated.as_ref() else {
        return deny().into_response();
    };
    let label = if result.is_ok() { "returned" } else { "denied" };
    let mut response = Redirect::to(&format!(
        "{}?delegated_auth={label}",
        b.ui_url.trim_end_matches('/')
    ))
    .into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_static(
            "delegated_flow=; HttpOnly; SameSite=Lax; Path=/api/delegated; Max-Age=0",
        ),
    );
    response
}

async fn finish_callback(
    state: &AppState,
    query: Callback,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    let b = broker(state)?;
    let cookie = headers
        .get("cookie")
        .and_then(|h| h.to_str().ok())
        .and_then(browser_cookie)
        .ok_or_else(deny)?;
    // Consume BEFORE network requests: replay and concurrent callbacks cannot redeem twice.
    let row=sqlx::query("UPDATE delegated_auth_transactions t SET consumed=true FROM delegated_operations o
        WHERE t.operation_id=o.id AND t.state_hash=$1 AND t.cookie_hash=$2 AND t.opened AND NOT t.consumed
        AND t.expires_at>now() AND o.expires_at>now() AND o.status='authenticating'
        RETURNING t.*,o.corp_id,o.actor_id,o.issuer,o.subject,o.run_id")
        .bind(hash(query.state.as_deref().ok_or_else(deny)?)).bind(hash(cookie))
        .fetch_optional(state.store.pool()).await.map_err(db)?.ok_or_else(deny)?;
    let id: Uuid = row.get("operation_id");
    let corp: Uuid = row.get("corp_id");
    let work=async {
        if query.error.is_some(){return Err(deny())}
        let bytes=state.secret_cipher.decrypt(corp,row.get("id"),"delegated-pkce",
            &row.get::<Vec<u8>,_>("pkce_ciphertext"),&row.get::<Vec<u8>,_>("pkce_nonce")).map_err(provider_error)?;
        let secrets:serde_json::Value=serde_json::from_slice(&bytes).map_err(provider_error)?;
        let expected=ExpectedIdentity{issuer:row.get("issuer"),subject:row.get("subject")};
        let initial=b.provider.redeem_code(query.code.as_deref().ok_or_else(deny)?,
            secrets["verifier"].as_str().ok_or_else(deny)?,&row.get::<String,_>("oidc_nonce"),&expected).await.map_err(provider_error)?;
        let token=b.provider.exchange(&initial).await.map_err(provider_error)?;
        if initial.identity()!=&expected || initial.expires_at()<=Utc::now().timestamp() as u64
            || token.identity()!=&expected || token.audience()!=b.audience || token.scope()!=b.scope {
            return Err(deny())
        }
        let token_expiry=chrono::DateTime::<Utc>::from_timestamp(token.expires_at() as i64,0).ok_or_else(deny)?;
        let (encrypted,iv)=state.secret_cipher.encrypt(corp,id,"delegated-token",token.expose_token().as_bytes()).map_err(provider_error)?;
        let changed=sqlx::query("UPDATE delegated_operations o SET status='authorized',token_ciphertext=$2,token_nonce=$3,token_expires_at=$4
            WHERE o.id=$1 AND o.status='authenticating' AND o.expires_at>now()
            AND EXISTS(SELECT 1 FROM runs r JOIN tasks t ON t.id=r.task_id JOIN missions m ON m.id=t.mission_id
                JOIN room_memberships rm ON rm.room_id=m.room_id AND rm.actor_id=o.actor_id
                JOIN human_identities hi ON hi.actor_id=o.actor_id AND hi.issuer=o.issuer AND hi.subject=o.subject
                WHERE r.id=o.run_id AND r.status IN ('starting','running','waiting_for_input')
                AND r.breaker_stage NOT IN ('stop','suspend') AND m.requested_by=o.actor_id)")
            .bind(id).bind(encrypted).bind(iv).bind(token_expiry).execute(state.store.pool()).await.map_err(db)?;
        if changed.rows_affected()!=1{return Err(deny())}
        Ok(())
    }.await;
    if work.is_err() {
        sqlx::query(
            "UPDATE delegated_operations SET status='failed',token_ciphertext=NULL,token_nonce=NULL
            WHERE id=$1 AND status='authenticating'",
        )
        .bind(id)
        .execute(state.store.pool())
        .await
        .map_err(db)?;
    }
    work
}

async fn cancel(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp, id)): Path<(Uuid, Uuid)>,
    Json(request): Json<ActorRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_owner(&state, &principal, corp, request.actor_id, id).await?;
    sqlx::query("UPDATE delegated_operations SET status='cancelled',token_ciphertext=NULL,token_nonce=NULL,preview=NULL
        WHERE id=$1 AND status NOT IN ('completed','cancelled','expired','failed') AND NOT released")
        .bind(id).execute(state.store.pool()).await.map_err(db)?;
    let assignment=sqlx::query("SELECT r.id,r.runner_id FROM runs r JOIN delegated_operations o ON o.run_id=r.id
        WHERE o.id=$1 AND o.status='cancelled' AND r.status IN ('starting','running','waiting_for_input')")
        .bind(id).fetch_optional(state.store.pool()).await.map_err(db)?;
    if let Some(assignment) = assignment {
        let runner_id: String = assignment.get("runner_id");
        if let Some(runner) = state.runners.get(&runner_id) {
            // The persisted revocation remains authoritative if this best-effort wakeup is lost.
            let _ = runner.tx.send(ServerToRunner::InterruptRun {
                run_id: assignment.get("id"),
                reason: "Delegated operation cancelled by its human owner".into(),
            });
        }
    }
    Ok(Json(json!({"cancelled":true})))
}

async fn release(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((corp, id)): Path<(Uuid, Uuid)>,
    Json(request): Json<ActorRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_owner(&state, &principal, corp, request.actor_id, id).await?;
    let count=sqlx::query("UPDATE delegated_operations SET released=true,released_at=COALESCE(released_at,now())
        WHERE id=$1 AND actor_id=$2 AND status='authorized' AND expires_at>now() AND preview IS NOT NULL")
        .bind(id).bind(request.actor_id).execute(state.store.pool()).await.map_err(db)?;
    if count.rows_affected() != 1 {
        return Err(deny());
    }
    Ok(Json(json!({"released":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunnerRead {
    run_id: Uuid,
    task_id: Uuid,
    runner_id: String,
    connection_epoch: Uuid,
    assignment_token: Uuid,
}

async fn runner_read(
    State(state): State<AppState>,
    Json(request): Json<RunnerRead>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let b = broker(&state)?;
    expire(&state).await?;
    // Operation and original assignment are locked for the bounded read. Cancellation
    // serializes with the effect, not just a preflight check. No arbitrary target URL.
    let mut tx = state.store.pool().begin().await.map_err(db)?;
    let row=sqlx::query("SELECT o.*,r.corp_id AS run_corp FROM runs r
        JOIN tasks t ON t.id=r.task_id AND t.corp_id=r.corp_id
        JOIN missions m ON m.id=t.mission_id AND m.corp_id=r.corp_id
        JOIN delegated_operations o ON o.task_id=t.id AND o.corp_id=r.corp_id AND o.actor_id=m.requested_by
        JOIN room_memberships rm ON rm.room_id=m.room_id AND rm.actor_id=o.actor_id
        JOIN actors a ON a.id=o.actor_id AND a.kind='human' AND a.role IN ('owner','admin','manager','member')
        JOIN human_identities hi ON hi.actor_id=o.actor_id AND hi.issuer=o.issuer AND hi.subject=o.subject
        JOIN runner_nodes n ON n.id=r.runner_id AND n.corp_id=r.corp_id
        JOIN runner_credentials rc ON rc.runner_id=n.id AND rc.corp_id=n.corp_id
        WHERE r.id=$1 AND t.id=$2 AND r.runner_id=$3 AND n.connection_epoch=$4 AND r.assignment_token=$5
        AND n.status='connected' AND rc.revoked_at IS NULL AND rc.expires_at>now()
        AND r.status IN ('starting','running','waiting_for_input') AND r.breaker_stage NOT IN ('stop','suspend')
        AND t.required_adapter='delegated-resource' AND t.contract->'allowed_tools' ? 'delegated.read'
        AND t.status NOT IN ('cancelled','failed','completed') AND m.status NOT IN ('cancelled','failed','completed')
        AND (o.run_id IS NULL OR o.run_id=r.id) FOR UPDATE OF o,r")
        .bind(request.run_id).bind(request.task_id).bind(&request.runner_id).bind(request.connection_epoch).bind(request.assignment_token)
        .fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(deny)?;
    let id: Uuid = row.get("id");
    let corp: Uuid = row.get("corp_id");
    let status: String = row.get("status");
    let expiry: chrono::DateTime<Utc> = row.get("expires_at");
    if expiry <= Utc::now() || matches!(status.as_str(), "cancelled" | "expired" | "failed") {
        return Err(deny());
    }
    sqlx::query("UPDATE delegated_operations SET run_id=$2 WHERE id=$1")
        .bind(id)
        .bind(request.run_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    if matches!(
        status.as_str(),
        "waiting_for_authentication" | "authenticating"
    ) {
        tx.commit().await.map_err(db)?;
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({"status":"waiting_for_authentication"})),
        ));
    }
    let mut preview: Option<serde_json::Value> = row.get("preview");
    if preview.is_none() {
        let token_expiry: Option<chrono::DateTime<Utc>> = row.get("token_expires_at");
        if !credential_allowed(
            &status,
            token_expiry.ok_or_else(deny)?.timestamp(),
            Utc::now().timestamp(),
        ) {
            return Err(deny());
        }
        let token = state
            .secret_cipher
            .decrypt(
                corp,
                id,
                "delegated-token",
                &row.get::<Option<Vec<u8>>, _>("token_ciphertext")
                    .ok_or_else(deny)?,
                &row.get::<Option<Vec<u8>>, _>("token_nonce")
                    .ok_or_else(deny)?,
            )
            .map_err(provider_error)?;
        let token = String::from_utf8(token).map_err(provider_error)?;
        let mut response = b
            .client
            .get(&b.resource_url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(provider_error)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(deny());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(provider_error)? {
            if bytes.len() + chunk.len() > 4096 {
                return Err(deny());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(provider_error)?;
        let result =
            verified_receipt(value["flag"].as_str().ok_or_else(deny)?, &b.expected_digest)?;
        sqlx::query("UPDATE delegated_operations SET preview=$2,token_ciphertext=NULL,token_nonce=NULL WHERE id=$1")
            .bind(id).bind(&result).execute(&mut *tx).await.map_err(db)?;
        preview = Some(result);
    }
    if !row.get::<bool, _>("released") {
        tx.commit().await.map_err(db)?;
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({"status":"waiting_for_authentication"})),
        ));
    }
    let mut receipt = preview.ok_or_else(deny)?;
    let object = receipt.as_object_mut().ok_or_else(deny)?;
    object.insert("schema_version".into(), json!(1));
    object.insert("operation_id".into(), json!(id));
    object.insert("run_id".into(), json!(request.run_id));
    object.insert("task_id".into(), json!(request.task_id));
    object.insert("resource".into(), json!("protected-flag"));
    tx.commit().await.map_err(db)?;
    Ok((
        StatusCode::OK,
        Json(json!({"status":"ready","receipt":receipt})),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = "../../db/migrations")]
    #[ignore = "requires explicitly owned SQLx maintenance database"]
    async fn delegated_job_room_rejection_rolls_back_all_admission(pool: sqlx::PgPool) {
        use sqlx::ConnectOptions;
        let store = PgStore::connect(pool.connect_options().to_url_lossy().as_str())
            .await
            .unwrap();
        let (ids, _) = store.bootstrap_demo().await.unwrap();
        let other_room = Uuid::new_v4();
        sqlx::query("INSERT INTO rooms(id,corp_id,name,purpose,created_at) VALUES($1,$2,'delegated-other','regression',now()+interval '1 day')")
            .bind(other_room).bind(ids.corp_id).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
            .bind(other_room)
            .bind(ids.alice_actor_id)
            .execute(&pool)
            .await
            .unwrap();
        let counts = || async {
            sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64)>(
                "SELECT (SELECT count(*) FROM missions),(SELECT count(*) FROM tasks),
                (SELECT count(*) FROM agents),(SELECT count(*) FROM actors),
                (SELECT count(*) FROM events),(SELECT count(*) FROM delegated_operations)",
            )
            .fetch_one(&pool)
            .await
            .unwrap()
        };
        let baseline = counts().await;
        let source = RunnerCapability {
            name: "delegated-resource".into(),
            available: true,
            detail: None,
            models: vec![],
            source_repository: Some("fixture/delegated".into()),
            source_base_ref: Some("main".into()),
            source_base_commit: Some("a".repeat(40)),
            workspace_connection_id: None,
        };
        let plan = protected_plan(&source);
        let rejected = persist_job(
            &store,
            ids.corp_id,
            ids.alice_actor_id,
            other_room,
            "http://127.0.0.1:18880/realms/local-obo",
            "synthetic-subject",
            &plan,
        )
        .await;
        assert!(rejected.is_err());
        assert_eq!(counts().await, baseline);
        let (created, _) = persist_job(
            &store,
            ids.corp_id,
            ids.alice_actor_id,
            ids.room_id,
            "http://127.0.0.1:18880/realms/local-obo",
            "synthetic-subject",
            &plan,
        )
        .await
        .unwrap();
        let actual: (Uuid, Uuid) = sqlx::query_as(
            "SELECT m.room_id,o.task_id FROM missions m JOIN delegated_operations o ON o.mission_id=m.id WHERE m.id=$1")
            .bind(created.mission_id).fetch_one(&pool).await.unwrap();
        assert_eq!(actual, (ids.room_id, created.task_ids[0]));
        assert_eq!(counts().await.5, baseline.5 + 1);
    }

    #[test]
    fn delegated_scope_denies_before_auth_and_after_cancel_or_expiry() {
        assert!(!credential_allowed("waiting_for_authentication", 200, 100));
        assert!(!credential_allowed("cancelled", 200, 100));
        assert!(!credential_allowed("authorized", 100, 100));
        assert!(credential_allowed("authorized", 200, 100));
    }

    #[test]
    fn delegated_browser_cookie_is_exact_not_prefix() {
        assert_eq!(browser_cookie("other=x; delegated_flow=abc"), Some("abc"));
        assert_eq!(browser_cookie("not_delegated_flow=abc"), None);
    }

    #[test]
    fn delegated_receipt_never_contains_protected_value() {
        let receipt = verified_receipt("protected", &hex::encode(Sha256::digest(b"protected")));
        assert!(receipt.is_ok());
        assert!(verified_receipt("changed", &hex::encode(Sha256::digest(b"protected"))).is_err());
        assert!(!receipt.unwrap().to_string().contains("protected"));
    }
}
