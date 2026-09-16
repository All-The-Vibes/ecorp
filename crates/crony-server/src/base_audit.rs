use super::*;
use anyhow::ensure;

#[derive(Clone)]
pub enum Runtime {
    Unconfigured,
    Unavailable,
    Ready(Arc<crate::base_worker::Service>),
}

impl Runtime {
    pub fn initialize(store: &PgStore) -> Self {
        let runtime = Self::from_result(crate::base_worker::Service::from_environment());
        if let Self::Ready(service) = &runtime {
            service.start(store.clone());
        }
        runtime
    }

    fn from_result(result: anyhow::Result<Option<Arc<crate::base_worker::Service>>>) -> Self {
        match result {
            Ok(Some(service)) => Self::Ready(service),
            Ok(None) => Self::Unconfigured,
            Err(_) => {
                warn!(
                    "Base worker configuration is invalid; Base is unavailable, V1 remains active"
                );
                Self::Unavailable
            }
        }
    }

    fn connection_state(&self) -> &'static str {
        match self {
            Self::Unconfigured => "not_configured",
            Self::Unavailable => "configuration_invalid",
            Self::Ready(_) => "configured",
        }
    }

    fn service(&self) -> Result<&crate::base_worker::Service, ApiError> {
        match self {
            Self::Ready(service) => Ok(service),
            Self::Unconfigured => Err(ApiError::conflict(
                "Base host connections are not configured; V1 operation is unaffected",
            )),
            Self::Unavailable => Err(ApiError::conflict(
                "Base host configuration is invalid; correct it and restart before enabling",
            )),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BaseAuditRequest {
    actor_id: Uuid,
    command: BaseAuditCommand,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum BaseAuditCommand {
    Configure {
        destination: serde_json::Value,
    },
    Validate {
        destination_id: Uuid,
    },
    Preview {
        destination_id: Uuid,
    },
    Enable {
        destination_id: Uuid,
        expected_version: i64,
    },
    Pause {
        destination_id: Uuid,
        expected_version: i64,
    },
    Request {
        destination_id: Uuid,
        idempotency_key: Uuid,
    },
    Status {},
    History {
        destination_id: Uuid,
        #[serde(default)]
        after: Option<i64>,
        #[serde(default = "default_page_size")]
        limit: u32,
    },
}

const fn default_page_size() -> u32 {
    50
}

fn parse_request(body: &[u8]) -> Result<BaseAuditRequest, ApiError> {
    if body.len() > crony_audit::MAX_RECORD_BYTES {
        return Err(ApiError::bad_request("Base audit request exceeds bound"));
    }
    let request: BaseAuditRequest = crony_audit::parse_json(body)
        .map_err(|_| ApiError::bad_request("invalid Base audit request JSON"))?;
    if request.actor_id.is_nil() {
        return Err(ApiError::bad_request("actor ID must be non-nil"));
    }
    request.command.validate().map_err(ApiError::bad_request)?;
    Ok(request)
}

impl BaseAuditCommand {
    fn permission(&self) -> Permission {
        match self {
            Self::Status {} | Self::History { .. } | Self::Preview { .. } => Permission::Read,
            Self::Request { .. } => Permission::PublishAnchor,
            Self::Configure { .. }
            | Self::Validate { .. }
            | Self::Enable { .. }
            | Self::Pause { .. } => Permission::Manage,
        }
    }

    fn validate(&self) -> anyhow::Result<()> {
        let destination = match self {
            Self::Configure { destination } => {
                ensure!(destination.is_object(), "expected a destination object");
                None
            }
            Self::Status {} => None,
            Self::Validate { destination_id } | Self::Preview { destination_id } => {
                Some(destination_id)
            }
            Self::Enable {
                destination_id,
                expected_version,
            }
            | Self::Pause {
                destination_id,
                expected_version,
            } => {
                ensure!(*expected_version > 0, "expected version must be positive");
                Some(destination_id)
            }
            Self::Request {
                destination_id,
                idempotency_key,
            } => {
                ensure!(!idempotency_key.is_nil(), "idempotency key must be non-nil");
                Some(destination_id)
            }
            Self::History {
                destination_id,
                after,
                limit,
            } => {
                ensure!(
                    (1..=100).contains(limit) && after.is_none_or(|cursor| cursor >= 0),
                    "history requires a nonnegative cursor and limit in 1..100"
                );
                Some(destination_id)
            }
        };
        ensure!(
            destination.is_none_or(|id| !id.is_nil()),
            "destination ID must be non-nil"
        );
        Ok(())
    }
}

// Underlying transport errors can contain credential-bearing provider URLs.
fn operation_error(error: impl std::fmt::Display) -> ApiError {
    let description = error.to_string();
    if description.starts_with("forbidden:") {
        ApiError::forbidden("Base operation requires authorized Corp-wide audit access")
    } else if description.starts_with("conflict:") {
        ApiError::conflict("Base state changed or is not eligible; refresh destination status")
    } else {
        warn!("Base operation failed; no assurance or successful publication is implied");
        ApiError::bad_request(
            "Base operation failed validation or connection checks; inspect host configuration and destination status",
        )
    }
}

pub async fn handle(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(corp): Path<Uuid>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let request = parse_request(&body)?;
    if corp.is_nil() {
        return Err(ApiError::bad_request("Corp ID must be non-nil"));
    }
    let actor = authorize_actor(
        &state,
        &principal,
        corp,
        Some(request.actor_id),
        request.command.permission(),
    )
    .await?;
    let result = match request.command {
        BaseAuditCommand::Configure { destination } => {
            let input: crony_store::base_audit::BaseDestinationInput =
                serde_json::from_value(destination)
                    .map_err(|_| ApiError::bad_request("invalid Base destination configuration"))?;
            serde_json::to_value(
                state
                    .store
                    .configure_base_destination(corp, actor, &input)
                    .await
                    .map_err(operation_error)?,
            )
            .map_err(operation_error)?
        }
        BaseAuditCommand::Validate { destination_id } => state
            .base_audit
            .service()?
            .validate(&state.store, corp, actor, destination_id)
            .await
            .map_err(operation_error)?,
        BaseAuditCommand::Preview { destination_id } => state
            .base_audit
            .service()?
            .preview(&state.store, corp, actor, destination_id)
            .await
            .map_err(operation_error)?,
        BaseAuditCommand::Enable {
            destination_id,
            expected_version,
        } => state
            .base_audit
            .service()?
            .enable(&state.store, corp, actor, destination_id, expected_version)
            .await
            .map_err(operation_error)?,
        BaseAuditCommand::Pause {
            destination_id,
            expected_version,
        } => serde_json::to_value(
            state
                .store
                .control_base_destination(corp, actor, destination_id, expected_version, false)
                .await
                .map_err(operation_error)?,
        )
        .map_err(operation_error)?,
        BaseAuditCommand::Request {
            destination_id,
            idempotency_key,
        } => {
            let intent = state
                .store
                .request_base_anchor(corp, actor, destination_id, idempotency_key)
                .await
                .map_err(operation_error)?;
            json!({"intent":intent})
        }
        BaseAuditCommand::Status {} => {
            json!({
                "connection_state": state.base_audit.connection_state(),
                "audit": state.store.base_status(corp, actor).await.map_err(operation_error)?,
            })
        }
        BaseAuditCommand::History {
            destination_id,
            after,
            limit,
        } => state
            .store
            .base_history(corp, actor, destination_id, after, limit)
            .await
            .map_err(operation_error)?,
    };
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Permission;
    use serde_json::json;

    fn parse(command: serde_json::Value) -> anyhow::Result<BaseAuditRequest> {
        crony_audit::parse_json(&serde_json::to_vec(&json!({
            "actor_id": "00000000-0000-4000-8000-000000000001",
            "command": command,
        }))?)
    }

    #[test]
    fn base_v2_api_has_no_arbitrary_signer_or_transaction_parameters() {
        let destination = "00000000-0000-4000-8000-000000000002";
        let key = "00000000-0000-4000-8000-000000000003";
        let valid = json!({
            "action": "request", "destination_id": destination, "idempotency_key": key,
        });
        assert!(parse(valid.clone()).is_ok());
        for field in [
            "private_key",
            "sender",
            "calldata",
            "value",
            "nonce",
            "max_fee_per_gas",
        ] {
            let mut invalid = valid.clone();
            invalid[field] = json!("operator must not control transaction fields");
            assert!(parse(invalid).is_err(), "accepted {field}");
        }
        assert!(parse(json!({"action":"request", "destination_id":destination})).is_err());
    }

    #[test]
    fn base_v2_api_never_accepts_caller_supplied_validation_evidence() {
        let destination = "00000000-0000-4000-8000-000000000002";
        assert!(
            parse(json!({
                "action":"enable", "destination_id":destination, "expected_version":1
            }))
            .is_ok()
        );
        assert!(
            parse(json!({
                "action":"enable", "destination_id":destination, "expected_version":1,
                "validated":true, "journal_reconciled":true
            }))
            .is_err()
        );
        assert!(
            parse(json!({
                "action":"enable", "destination_id":destination
            }))
            .is_err()
        );
    }

    #[test]
    fn base_v2_api_spending_and_administration_are_distinct_from_reads() {
        assert_eq!(BaseAuditCommand::Status {}.permission(), Permission::Read);
        let destination_id = Uuid::new_v4();
        assert_eq!(
            BaseAuditCommand::Request {
                destination_id,
                idempotency_key: Uuid::new_v4(),
            }
            .permission(),
            Permission::PublishAnchor
        );
        assert_eq!(
            BaseAuditCommand::Enable {
                destination_id,
                expected_version: 1,
            }
            .permission(),
            Permission::Manage
        );
    }

    #[test]
    fn base_v2_api_bounds_pages_and_versions_and_ids() {
        let destination_id = Uuid::new_v4();
        for limit in [0, 101, u32::MAX] {
            assert!(
                BaseAuditCommand::History {
                    destination_id,
                    after: None,
                    limit,
                }
                .validate()
                .is_err()
            );
        }
        assert!(
            BaseAuditCommand::History {
                destination_id,
                after: Some(-1),
                limit: 50,
            }
            .validate()
            .is_err()
        );
        assert!(
            BaseAuditCommand::Enable {
                destination_id,
                expected_version: 0,
            }
            .validate()
            .is_err()
        );
        assert!(
            BaseAuditCommand::Preview {
                destination_id: Uuid::nil(),
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn base_v2_api_rejects_invalid_envelopes_before_authorization_or_connections() {
        let valid = serde_json::to_vec(&json!({
            "actor_id": Uuid::new_v4(),
            "command": {"action": "status"}
        }))
        .unwrap();
        assert!(parse_request(&valid).is_ok());
        assert!(parse_request(&vec![b' '; crony_audit::MAX_RECORD_BYTES + 1]).is_err());
        assert!(parse_request(br#"{"actor_id":"00000000-0000-0000-0000-000000000000","command":{"action":"status"}}"#).is_err());
        assert!(parse_request(br#"{"actor_id":"00000000-0000-4000-8000-000000000001","command":{"action":"status","action":"request"}}"#).is_err());
        let malformed = serde_json::to_vec(&json!({
            "actor_id": Uuid::new_v4(),
            "command": {"action":"history", "destination_id":Uuid::new_v4(), "limit":101}
        }))
        .unwrap();
        assert!(parse_request(&malformed).is_err());
    }

    #[test]
    fn base_v2_api_connection_failure_is_distinct_from_disabled_and_redacted() {
        let disconnected = Runtime::from_result(Ok(None));
        assert_eq!(disconnected.connection_state(), "not_configured");
        assert!(disconnected.service().is_err());
        let invalid = Runtime::from_result(Err(anyhow::anyhow!(
            "invalid RPC https://fixture.invalid/?credential=private-fixture"
        )));
        assert_eq!(invalid.connection_state(), "configuration_invalid");
        assert!(invalid.service().is_err());
        let error = operation_error(anyhow::anyhow!(
            "request to https://fixture.invalid/?credential=private-fixture failed"
        ));
        assert!(!error.message.contains("private-fixture"));
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    #[ignore = "requires an isolated BASE_AUDIT_TEST_DATABASE_URL; creates demo application data"]
    async fn base_v2_api_http_disconnected_preserves_v1_and_authorization() -> anyhow::Result<()> {
        let database = std::env::var("BASE_AUDIT_TEST_DATABASE_URL")
            .context("set BASE_AUDIT_TEST_DATABASE_URL to a disposable test database")?;
        let store = PgStore::connect(&database).await?;
        store.migrate().await?;
        let (ids, _) = store.bootstrap_demo_with_crew(false).await?;
        let artifact_root = std::env::temp_dir().join(format!("base-api-{}", Uuid::new_v4()));
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
        let (event_tx, _) = broadcast::channel(16);
        let state = AppState {
            audit: None,
            base_audit: Runtime::Unconfigured,
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
        };
        let router = Router::new()
            .route("/api/corps/{corp_id}/base-audit", post(handle))
            .route(
                "/api/corps/{corp_id}/state-audit",
                post(state_audit::handle),
            )
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                authenticate_http,
            ))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let client = reqwest::Client::builder()
            .timeout(StdDuration::from_secs(10))
            .build()?;
        let base = format!("http://{address}/api/corps/{}/base-audit", ids.corp_id);
        let v1 = format!("http://{address}/api/corps/{}/state-audit", ids.corp_id);
        for url in [&base, &v1] {
            let response = client
                .post(url)
                .json(&json!({
                    "actor_id":ids.alice_actor_id, "command":{"action":"status"}
                }))
                .send()
                .await?;
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "{}",
                response.text().await?
            );
        }
        let status: serde_json::Value = client
            .post(&base)
            .json(&json!({
                "actor_id":ids.alice_actor_id, "command":{"action":"status"}
            }))
            .send()
            .await?
            .json()
            .await?;
        assert_eq!(status["connection_state"], "not_configured");
        for action in ["validate", "preview", "enable"] {
            let mut command = json!({"action":action, "destination_id":Uuid::new_v4()});
            if action == "enable" {
                command["expected_version"] = json!(1);
            }
            let response = client
                .post(&base)
                .json(&json!({
                    "actor_id":ids.alice_actor_id, "command":command
                }))
                .send()
                .await?;
            assert_eq!(
                response.status(),
                StatusCode::CONFLICT,
                "{}",
                response.text().await?
            );
        }
        let response = client
            .post(&base)
            .json(&json!({
                "actor_id":Uuid::new_v4(), "command":{"action":"status"}
            }))
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = client
            .post(&base)
            .json(&json!({
                "actor_id":ids.alice_actor_id,
                "command":{
                    "action":"request", "destination_id":Uuid::new_v4(),
                    "idempotency_key":Uuid::new_v4(), "nonce":1,
                }
            }))
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        server.abort();
        let _ = server.await;
        if artifact_root.exists() {
            std::fs::remove_dir_all(artifact_root)?;
        }
        Ok(())
    }
}
