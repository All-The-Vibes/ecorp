use std::{
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use axum::http::{HeaderMap, header::AUTHORIZATION};
use dashmap::DashMap;
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum ServerMode {
    Development,
    Production,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Read,
    PostMessage,
    Operate,
    Approve,
    EmergencyStop,
    ControlFactory,
    Recover,
    Publish,
    PublishAnchor,
    Manage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorpRole {
    Owner,
    Admin,
    Manager,
    Member,
    Guest,
    Spectator,
}

impl CorpRole {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "owner" => Ok(Self::Owner),
            "admin" => Ok(Self::Admin),
            "manager" => Ok(Self::Manager),
            "member" => Ok(Self::Member),
            "guest" => Ok(Self::Guest),
            "spectator" => Ok(Self::Spectator),
            _ => Err(anyhow!("unsupported human Corp role {value}")),
        }
    }

    pub const fn allows(self, permission: Permission) -> bool {
        match permission {
            Permission::Read => true,
            Permission::PostMessage => !matches!(self, Self::Spectator),
            Permission::Operate | Permission::Approve => {
                matches!(
                    self,
                    Self::Owner | Self::Admin | Self::Manager | Self::Member
                )
            }
            Permission::EmergencyStop => {
                matches!(self, Self::Owner | Self::Admin | Self::Manager)
            }
            Permission::Recover => {
                matches!(self, Self::Owner | Self::Admin | Self::Manager)
            }
            Permission::ControlFactory | Permission::Publish => {
                matches!(self, Self::Owner | Self::Admin | Self::Manager)
            }
            Permission::Manage | Permission::PublishAnchor => {
                matches!(self, Self::Owner | Self::Admin)
            }
        }
    }
}

#[derive(Debug, Clone)]
pub enum Principal {
    Development,
    Oidc {
        issuer: String,
        subject: String,
        email: Option<String>,
    },
}

#[derive(Debug, Clone)]
struct CachedPrincipal {
    principal: Principal,
    valid_until: Instant,
}

#[derive(Debug, Clone)]
struct WebSocketTicket {
    corp_id: Uuid,
    actor_id: Uuid,
    valid_until: Instant,
}

#[derive(Clone)]
pub struct AuthService {
    mode: ServerMode,
    issuer: Option<String>,
    userinfo_endpoint: Option<Url>,
    client: reqwest::Client,
    cache: Arc<DashMap<String, CachedPrincipal>>,
    websocket_tickets: Arc<DashMap<String, WebSocketTicket>>,
}

#[derive(Debug, Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    userinfo_endpoint: String,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    sub: String,
    email: Option<String>,
}

impl AuthService {
    pub async fn initialize(
        mode: ServerMode,
        issuer: Option<String>,
        allow_insecure_oidc: bool,
    ) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .context("build OIDC HTTP client")?;
        if mode == ServerMode::Development {
            return Ok(Self {
                mode,
                issuer: None,
                userinfo_endpoint: None,
                client,
                cache: Arc::new(DashMap::new()),
                websocket_tickets: Arc::new(DashMap::new()),
            });
        }

        let issuer = issuer
            .map(|value| value.trim_end_matches('/').to_owned())
            .filter(|value| !value.is_empty())
            .context("CRONY_OIDC_ISSUER is required in production mode")?;
        let issuer_url = Url::from_str(&issuer).context("parse OIDC issuer URL")?;
        if issuer_url.scheme() != "https" && !allow_insecure_oidc {
            return Err(anyhow!(
                "production OIDC issuer must use https; use --allow-insecure-oidc only for isolated tests"
            ));
        }
        // OIDC appends discovery to the full issuer path. A relative URL join
        // would replace the last segment (for example Entra's `v2.0`).
        let mut discovery_url = issuer_url;
        discovery_url
            .path_segments_mut()
            .map_err(|_| anyhow!("construct OIDC discovery URL: issuer cannot be a base URL"))?
            .pop_if_empty()
            .extend([".well-known", "openid-configuration"]);
        // Preserve the prior relative join's query/fragment clearing behavior.
        discovery_url.set_query(None);
        discovery_url.set_fragment(None);
        let discovery = client
            .get(discovery_url)
            .send()
            .await
            .context("fetch OIDC discovery document")?
            .error_for_status()
            .context("OIDC discovery returned an error")?
            .json::<DiscoveryDocument>()
            .await
            .context("decode OIDC discovery document")?;
        if discovery.issuer.trim_end_matches('/') != issuer {
            return Err(anyhow!(
                "OIDC discovery issuer mismatch: expected {issuer}, received {}",
                discovery.issuer
            ));
        }
        let userinfo_endpoint =
            Url::from_str(&discovery.userinfo_endpoint).context("parse OIDC userinfo endpoint")?;
        if userinfo_endpoint.scheme() != "https" && !allow_insecure_oidc {
            return Err(anyhow!("OIDC userinfo endpoint must use https"));
        }

        Ok(Self {
            mode,
            issuer: Some(issuer),
            userinfo_endpoint: Some(userinfo_endpoint),
            client,
            cache: Arc::new(DashMap::new()),
            websocket_tickets: Arc::new(DashMap::new()),
        })
    }

    pub const fn mode(&self) -> ServerMode {
        self.mode
    }

    pub async fn authenticate_headers(&self, headers: &HeaderMap) -> Result<Principal> {
        if self.mode == ServerMode::Development {
            return Ok(Principal::Development);
        }
        let value = headers
            .get(AUTHORIZATION)
            .context("missing Authorization bearer token")?
            .to_str()
            .context("Authorization header is not valid UTF-8")?;
        let token = value
            .strip_prefix("Bearer ")
            .filter(|value| !value.trim().is_empty())
            .context("Authorization must use a Bearer token")?;
        self.authenticate_bearer(token).await
    }

    pub async fn authenticate_bearer(&self, token: &str) -> Result<Principal> {
        if self.mode == ServerMode::Development {
            return Ok(Principal::Development);
        }
        let digest = hex::encode(Sha256::digest(token.as_bytes()));
        if let Some(cached) = self.cache.get(&digest)
            && cached.valid_until > Instant::now()
        {
            return Ok(cached.principal.clone());
        }

        let userinfo = self
            .client
            .get(
                self.userinfo_endpoint
                    .as_ref()
                    .context("OIDC userinfo endpoint is not configured")?
                    .clone(),
            )
            .bearer_auth(token)
            .send()
            .await
            .context("request OIDC userinfo")?
            .error_for_status()
            .context("OIDC bearer token was rejected")?
            .json::<UserInfo>()
            .await
            .context("decode OIDC userinfo response")?;
        if userinfo.sub.trim().is_empty() {
            return Err(anyhow!("OIDC userinfo response omitted sub"));
        }
        let principal = Principal::Oidc {
            issuer: self
                .issuer
                .clone()
                .context("OIDC issuer is not configured")?,
            subject: userinfo.sub,
            email: userinfo.email,
        };
        self.cache.insert(
            digest,
            CachedPrincipal {
                principal: principal.clone(),
                valid_until: Instant::now() + Duration::from_secs(30),
            },
        );
        Ok(principal)
    }

    pub fn issue_websocket_ticket(&self, corp_id: Uuid, actor_id: Uuid) -> (String, u64) {
        let ttl_seconds = 30;
        let ticket = format!(
            "crony_ws_{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        self.websocket_tickets.insert(
            hex::encode(Sha256::digest(ticket.as_bytes())),
            WebSocketTicket {
                corp_id,
                actor_id,
                valid_until: Instant::now() + Duration::from_secs(ttl_seconds),
            },
        );
        (ticket, ttl_seconds)
    }

    pub fn consume_websocket_ticket(&self, corp_id: Uuid, ticket: &str) -> Result<Uuid> {
        let digest = hex::encode(Sha256::digest(ticket.as_bytes()));
        let (_, ticket) = self
            .websocket_tickets
            .remove(&digest)
            .context("unknown or already-consumed WebSocket ticket")?;
        if ticket.valid_until <= Instant::now() {
            return Err(anyhow!("WebSocket ticket expired"));
        }
        if ticket.corp_id != corp_id {
            return Err(anyhow!("WebSocket ticket belongs to a different Corp"));
        }
        Ok(ticket.actor_id)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn base_v2_spending_has_dedicated_owner_admin_permission() {
        for role in [CorpRole::Owner, CorpRole::Admin] {
            assert!(role.allows(Permission::PublishAnchor));
        }
        for role in [
            CorpRole::Manager,
            CorpRole::Member,
            CorpRole::Guest,
            CorpRole::Spectator,
        ] {
            assert!(!role.allows(Permission::PublishAnchor));
        }
        assert_ne!(Permission::PublishAnchor, Permission::Publish);
    }

    use super::*;
    use axum::{Json, Router, routing::get};
    use serde_json::json;

    struct DiscoveryFixture {
        issuer: String,
        server: tokio::task::JoinHandle<()>,
    }

    impl Drop for DiscoveryFixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    async fn discovery_fixture(path: &str, mismatched_issuer: bool) -> DiscoveryFixture {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test-owned discovery endpoint");
        let issuer = format!("http://{}{path}", listener.local_addr().unwrap());
        let discovered_issuer = if mismatched_issuer {
            format!("{issuer}/different-issuer")
        } else {
            issuer.clone()
        };
        let document_path = format!("{path}/.well-known/openid-configuration");
        let app = Router::new().route(
            &document_path,
            get(move || {
                let discovered_issuer = discovered_issuer.clone();
                async move {
                    Json(json!({
                        "issuer": discovered_issuer,
                        "userinfo_endpoint": "https://identity.example.test/userinfo"
                    }))
                }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        DiscoveryFixture { issuer, server }
    }

    async fn assert_discovery_at_issuer_path(path: &str) {
        let fixture = discovery_fixture(path, false).await;
        for suffix in ["", "/"] {
            let auth = AuthService::initialize(
                ServerMode::Production,
                Some(format!("{}{suffix}", fixture.issuer)),
                true,
            )
            .await
            .unwrap_or_else(|error| panic!("discovery for {path:?}{suffix} failed: {error:#}"));
            assert_eq!(auth.mode(), ServerMode::Production);
            assert_eq!(auth.issuer.as_deref(), Some(fixture.issuer.as_str()));
            assert_eq!(
                auth.userinfo_endpoint.unwrap().as_str(),
                "https://identity.example.test/userinfo"
            );
        }
    }

    #[tokio::test]
    async fn discovery_supports_root_issuer_with_or_without_trailing_slash() {
        assert_discovery_at_issuer_path("").await;
    }

    #[tokio::test]
    async fn discovery_preserves_nested_issuer_path() {
        assert_discovery_at_issuer_path("/realms/ecorp").await;
    }

    #[tokio::test]
    async fn discovery_preserves_entra_v2_issuer_path() {
        assert_discovery_at_issuer_path("/00000000-0000-4000-8000-000000000001/v2.0").await;
    }

    #[tokio::test]
    async fn discovery_preserves_percent_encoded_issuer_path() {
        assert_discovery_at_issuer_path("/realms/ecorp%20test").await;
    }

    #[tokio::test]
    async fn discovery_still_rejects_mismatched_issuer() {
        let fixture = discovery_fixture("", true).await;
        let result =
            AuthService::initialize(ServerMode::Production, Some(fixture.issuer.clone()), true)
                .await;
        let error = result.err().expect("a foreign issuer must be rejected");
        assert!(error.to_string().contains("OIDC discovery issuer mismatch"));
    }

    #[tokio::test]
    async fn production_still_requires_https_without_test_override() {
        let result = AuthService::initialize(
            ServerMode::Production,
            Some("http://127.0.0.1:1/tenant/v2.0".to_owned()),
            false,
        )
        .await;
        let error = result
            .err()
            .expect("plaintext production issuer must be rejected");
        assert!(
            error
                .to_string()
                .contains("production OIDC issuer must use https")
        );
    }

    #[tokio::test]
    async fn development_does_not_require_discovery() {
        let auth = AuthService::initialize(ServerMode::Development, None, false)
            .await
            .unwrap();
        assert_eq!(auth.mode(), ServerMode::Development);
        assert!(auth.issuer.is_none());
        assert!(auth.userinfo_endpoint.is_none());
    }

    #[tokio::test]
    async fn discovery_drops_query_and_fragment_from_metadata_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test-owned discovery endpoint");
        let issuer = format!(
            "http://{}/realms/ecorp?query=preserved#fragment",
            listener.local_addr().unwrap()
        );
        let discovered_issuer = issuer.clone();
        let document_path = "/realms/ecorp/.well-known/openid-configuration";
        let app = Router::new().route(
            document_path,
            get(move |uri: axum::http::Uri| {
                let discovered_issuer = discovered_issuer.clone();
                async move {
                    assert_eq!(uri.path_and_query().unwrap().as_str(), document_path);
                    Json(json!({
                        "issuer": discovered_issuer,
                        "userinfo_endpoint": "https://identity.example.test/userinfo"
                    }))
                }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let fixture = DiscoveryFixture { issuer, server };
        let auth =
            AuthService::initialize(ServerMode::Production, Some(fixture.issuer.clone()), true)
                .await
                .unwrap();
        assert_eq!(auth.issuer.as_deref(), Some(fixture.issuer.as_str()));
    }

    #[test]
    fn role_matrix_is_fail_closed() {
        assert!(CorpRole::Manager.allows(Permission::EmergencyStop));
        assert!(CorpRole::Manager.allows(Permission::Recover));
        assert!(!CorpRole::Member.allows(Permission::Recover));
        assert!(CorpRole::Owner.allows(Permission::Manage));
        assert!(CorpRole::Manager.allows(Permission::ControlFactory));
        assert!(!CorpRole::Member.allows(Permission::ControlFactory));
        assert!(CorpRole::Manager.allows(Permission::Publish));
        assert!(!CorpRole::Member.allows(Permission::Publish));
        assert!(CorpRole::Member.allows(Permission::Operate));
        assert!(CorpRole::Guest.allows(Permission::PostMessage));
        assert!(!CorpRole::Guest.allows(Permission::Operate));
        assert!(CorpRole::Spectator.allows(Permission::Read));
        assert!(!CorpRole::Spectator.allows(Permission::PostMessage));
        assert!(CorpRole::parse("reviewer").is_err());
    }
}
