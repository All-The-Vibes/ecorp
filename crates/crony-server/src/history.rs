use super::*;
use axum::extract::rejection::{PathRejection, QueryRejection};
use crony_protocol::history::HistoryQuery;
use crony_store::HistoryReadError;

pub async fn read(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    path: Result<Path<Uuid>, PathRejection>,
    query: Result<Query<HistoryQuery>, QueryRejection>,
) -> Response {
    let result = match (path, query) {
        (Ok(Path(corp_id)), Ok(Query(query))) => {
            read_page(&state, &principal, corp_id, query).await
        }
        // Extractor diagnostics can echo malformed input; they are not history.
        _ => Err(ApiError::bad_request("Invalid history scope or query.")),
    };
    let mut response = match result {
        Ok(page) => Json(page).into_response(),
        Err(error) => error.into_response(),
    };
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

async fn read_page(
    state: &AppState,
    principal: &Principal,
    corp_id: Uuid,
    query: HistoryQuery,
) -> Result<crony_domain::HistoryPage, ApiError> {
    let actor_id = authorize_actor(
        state,
        principal,
        corp_id,
        Some(query.actor_id),
        Permission::Read,
    )
    .await
    .map_err(|error| ApiError {
        status: error.status,
        message: if error.status.is_client_error() {
            "History is unavailable for this identity."
        } else {
            "History is temporarily unavailable. Retry the search."
        }
        .to_owned(),
    })?;
    state
        .store
        .history_page(
            corp_id,
            actor_id,
            query.filters(),
            query.page_size,
            query.cursor.as_deref(),
        )
        .await
        .map_err(store_error)
}

fn store_error(error: anyhow::Error) -> ApiError {
    match error.downcast_ref::<HistoryReadError>() {
        Some(HistoryReadError::Unavailable) => ApiError::not_found(HistoryReadError::Unavailable),
        Some(kind) => ApiError::bad_request(kind),
        None => {
            // Database diagnostics can include user input or secrets. Retain
            // only the static failure category, never the error or query.
            error!("history query unavailable");
            ApiError {
                status: StatusCode::SERVICE_UNAVAILABLE,
                message: "History is temporarily unavailable. Retry the search.".to_owned(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use crony_store::DemoIds;
    use serde_json::Value;
    use sqlx::{ConnectOptions, PgPool};

    #[test]
    fn history_store_failures_log_only_a_static_category() {
        #[derive(Clone)]
        struct LogWriter(Arc<std::sync::Mutex<Vec<u8>>>);

        impl std::io::Write for LogWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let logs = Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = LogWriter(logs.clone());
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_target(false)
            .with_max_level(tracing::Level::ERROR)
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            for kind in [
                HistoryReadError::InvalidQuery,
                HistoryReadError::InvalidCursor,
                HistoryReadError::Unavailable,
            ] {
                assert!(store_error(kind.into()).status.is_client_error());
            }
            assert!(logs.lock().unwrap().is_empty());

            let failure = store_error(anyhow::anyhow!(
                "database diagnostic includes private-canary query and credential"
            ));
            assert_eq!(failure.status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                failure.message,
                "History is temporarily unavailable. Retry the search."
            );
        });
        let output = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
        assert_eq!(output.trim(), "ERROR history query unavailable");
    }

    async fn fixture(pool: &PgPool) -> Result<(AppState, DemoIds)> {
        let store = PgStore::connect(pool.connect_options().to_url_lossy().as_str()).await?;
        let (ids, _) = store.bootstrap_demo().await?;
        let (event_tx, _) = broadcast::channel(64);
        Ok((
            AppState {
                audit: None,
                base_audit: base_audit::Runtime::Unconfigured,
                delegated: None,
                store,
                event_tx,
                runners: Arc::new(DashMap::new()),
                strategies: StrategyRegistry::new(),
                runner_grace_secs: 10,
                runner_credential_ttl_secs: 300,
                publication_publisher_credential_ttl_secs: 300,
                auth: AuthService::initialize(ServerMode::Development, None, false).await?,
                secret_cipher: SecretCipher::initialize(ServerMode::Development, None)?,
                artifacts: ArtifactStore::initialize(
                    "local",
                    PathBuf::from("output/issue258-unused-artifacts"),
                    None,
                    None,
                    None,
                    None,
                    None,
                    false,
                    None,
                    1024,
                    false,
                )?,
                artifact_retention_days: 1,
                workspace_sign_in: Arc::new(DashMap::new()),
            },
            ids,
        ))
    }

    fn query(actor: Uuid) -> Query<HistoryQuery> {
        Query(HistoryQuery {
            actor_id: actor,
            kind: Default::default(),
            room_id: None,
            mission_id: None,
            attributed_actor_id: None,
            record_id: None,
            status: None,
            search: String::new(),
            cursor: None,
            page_size: 25,
        })
    }

    async fn response_json(response: Response, expected: StatusCode) -> Result<Value> {
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        let bytes = axum::body::to_bytes(response.into_body(), 100_000).await?;
        assert!(!String::from_utf8_lossy(&bytes).contains("private-canary"));
        Ok(serde_json::from_slice(&bytes)?)
    }

    #[sqlx::test(migrations = "../../db/migrations")]
    #[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
    async fn issue258_http_extractors_sanitize_failures_and_success_is_scoped(
        pool: PgPool,
    ) -> Result<()> {
        let (state, ids) = fixture(&pool).await?;
        let router = Router::new()
            .route("/api/corps/{corp_id}/history", get(read))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                authenticate_http,
            ))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        let path = format!(
            "{base}/api/corps/{}/history?actor_id={}",
            ids.corp_id, ids.alice_actor_id
        );
        let response = client.get(&path).send().await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        let page: crony_domain::HistoryPage = response.json().await?;
        assert_eq!(
            (page.corp_id, page.actor_id),
            (ids.corp_id, ids.alice_actor_id)
        );
        assert!(page.entries.len() <= 25);
        for url in [
            format!("{path}&kind=private-canary"),
            format!("{path}&room_id=private-canary"),
            format!("{path}&page_size=private-canary"),
            format!("{path}&unknown=private-canary"),
            format!("{path}&kind=event&kind=private-canary"),
            format!(
                "{base}/api/corps/private-canary/history?actor_id={}",
                ids.alice_actor_id
            ),
        ] {
            let response = client.get(url).send().await?;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
            assert_eq!(
                response.json::<Value>().await?,
                json!({"error":"Invalid history scope or query."})
            );
        }
        let response = client
            .get(format!("{path}&cursor=private-canary"))
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!response.text().await?.contains("private-canary"));
        server.abort();
        Ok(())
    }

    #[sqlx::test(migrations = "../../db/migrations")]
    #[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
    async fn issue258_oidc_identity_current_membership_and_no_substitute(
        pool: PgPool,
    ) -> Result<()> {
        let (state, ids) = fixture(&pool).await?;
        sqlx::query("INSERT INTO human_identities(issuer,subject,actor_id) VALUES('https://history-fixture.invalid','alice',$1)")
            .bind(ids.alice_actor_id).execute(&pool).await?;
        let principal = Principal::Oidc {
            issuer: "https://history-fixture.invalid".into(),
            subject: "alice".into(),
            email: None,
        };
        let page = response_json(
            read(
                State(state.clone()),
                Extension(principal.clone()),
                Ok(Path(ids.corp_id)),
                Ok(query(ids.alice_actor_id)),
            )
            .await,
            StatusCode::OK,
        )
        .await?;
        assert_eq!(page["actor_id"], json!(ids.alice_actor_id));
        for (corp, actor) in [
            (ids.corp_id, ids.bob_actor_id),
            (Uuid::new_v4(), ids.alice_actor_id),
        ] {
            response_json(
                read(
                    State(state.clone()),
                    Extension(principal.clone()),
                    Ok(Path(corp)),
                    Ok(query(actor)),
                )
                .await,
                StatusCode::FORBIDDEN,
            )
            .await?;
        }
        let mut exact = query(ids.alice_actor_id);
        exact.room_id = Some(Uuid::new_v4());
        response_json(
            read(
                State(state.clone()),
                Extension(principal.clone()),
                Ok(Path(ids.corp_id)),
                Ok(exact),
            )
            .await,
            StatusCode::NOT_FOUND,
        )
        .await?;
        sqlx::query("UPDATE actors SET role='private-canary-revoked' WHERE id=$1")
            .bind(ids.alice_actor_id)
            .execute(&pool)
            .await?;
        response_json(
            read(
                State(state),
                Extension(principal),
                Ok(Path(ids.corp_id)),
                Ok(query(ids.alice_actor_id)),
            )
            .await,
            StatusCode::FORBIDDEN,
        )
        .await?;
        Ok(())
    }

    #[sqlx::test(migrations = "../../db/migrations")]
    #[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
    async fn issue258_database_unavailability_returns_static_retryable_error(
        pool: PgPool,
    ) -> Result<()> {
        let (state, ids) = fixture(&pool).await?;
        state.store.pool().close().await;
        let body = response_json(
            read(
                State(state),
                Extension(Principal::Development),
                Ok(Path(ids.corp_id)),
                Ok(query(ids.alice_actor_id)),
            )
            .await,
            StatusCode::SERVICE_UNAVAILABLE,
        )
        .await?;
        assert_eq!(
            body,
            json!({"error":"History is temporarily unavailable. Retry the search."})
        );
        Ok(())
    }
}
