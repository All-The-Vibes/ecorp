//! Explicit, fail-closed delegated OAuth adapters. Live Azure: NOT_EXECUTED.
//!
//! The caller owns one-use state/nonce/PKCE transactions and authenticates the human
//! before supplying `ExpectedIdentity`. Never derive that binding from the callback.
//! Neither provider grants task, run, runner, or resource authorization by itself.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use reqwest::{Client, Url};
use serde::Deserialize;
use uuid::Uuid;

const MAX_BODY: usize = 128 * 1024;
const MAX_TOKEN: usize = 32 * 1024;
const MAX_LIFETIME: u64 = 3600;
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    Entra,
    /// Explicit synthetic loopback fixture, never an Entra fallback.
    KeycloakTest,
}

/// Secret-bearing configuration deliberately has neither Debug nor Serialize.
/// Entra supports the public Microsoft cloud and a single explicit tenant.
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub issuer: String,
    pub tenant_id: Option<String>,
    pub interactive_client_id: String,
    pub broker_client_id: String,
    pub broker_client_secret: String,
    pub redirect_uri: String,
    pub initial_scopes: Vec<String>,
    pub downstream_scope: String,
    pub downstream_audience: String,
}

impl ProviderConfig {
    /// Entra is the production default, disabled until explicitly configured.
    /// No implicit secret-file discovery and no test-provider fallback.
    /// Environment names are CRONY_DELEGATED_{PROVIDER,ISSUER,TENANT_ID,
    /// INTERACTIVE_CLIENT_ID,BROKER_CLIENT_ID,BROKER_CLIENT_SECRET,REDIRECT_URI,
    /// INITIAL_SCOPES,DOWNSTREAM_SCOPE,DOWNSTREAM_AUDIENCE}.
    pub fn from_env() -> Result<Option<Self>, ProviderError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    fn from_lookup(
        mut get: impl FnMut(&str) -> Option<String>,
    ) -> Result<Option<Self>, ProviderError> {
        let kind = match get("CRONY_DELEGATED_PROVIDER").as_deref() {
            None | Some("disabled") => return Ok(None),
            Some("entra") => ProviderKind::Entra,
            Some("keycloak-test") => ProviderKind::KeycloakTest,
            _ => return Err(ProviderError::Configuration),
        };
        let tenant_id = get("CRONY_DELEGATED_TENANT_ID");
        let issuer = match kind {
            ProviderKind::Entra => {
                let tenant = tenant_id.as_deref().ok_or(ProviderError::Configuration)?;
                format!("https://login.microsoftonline.com/{tenant}/v2.0")
            }
            ProviderKind::KeycloakTest => {
                get("CRONY_DELEGATED_ISSUER").ok_or(ProviderError::Configuration)?
            }
        };
        let mut required = |key| {
            get(key)
                .filter(|v| !v.is_empty())
                .ok_or(ProviderError::Configuration)
        };
        let config = Self {
            kind,
            issuer,
            tenant_id,
            interactive_client_id: required("CRONY_DELEGATED_INTERACTIVE_CLIENT_ID")?,
            broker_client_id: required("CRONY_DELEGATED_BROKER_CLIENT_ID")?,
            broker_client_secret: required("CRONY_DELEGATED_BROKER_CLIENT_SECRET")?,
            redirect_uri: required("CRONY_DELEGATED_REDIRECT_URI")?,
            initial_scopes: required("CRONY_DELEGATED_INITIAL_SCOPES")?
                .split_whitespace()
                .map(str::to_owned)
                .collect(),
            downstream_scope: required("CRONY_DELEGATED_DOWNSTREAM_SCOPE")?,
            downstream_audience: required("CRONY_DELEGATED_DOWNSTREAM_AUDIENCE")?,
        };
        config.validate()?;
        Ok(Some(config))
    }

    fn validate(&self) -> Result<(), ProviderError> {
        let issuer = safe_url(&self.issuer)?;
        let redirect = safe_url(&self.redirect_uri)?;
        if issuer.query().is_some()
            || issuer.path().ends_with('/')
            || redirect.query().is_some()
            || !(redirect.scheme() == "https" || is_loopback(&redirect))
            || !valid_atom(&self.interactive_client_id, 256)
            || !valid_atom(&self.broker_client_id, 256)
            || self.broker_client_secret.is_empty()
            || self.broker_client_secret.len() > 4096
            || self.broker_client_secret.chars().any(char::is_control)
            || self.initial_scopes.is_empty()
            || self.initial_scopes.len() > 16
            || !self.initial_scopes.iter().all(|s| valid_atom(s, 512))
            || !self.initial_scopes.iter().any(|s| s == "openid")
            || self.initial_scopes.iter().any(|s| s == "offline_access")
            || !valid_atom(&self.downstream_scope, 1024)
            || !valid_atom(&self.downstream_audience, 1024)
        {
            return Err(ProviderError::Configuration);
        }
        match self.kind {
            ProviderKind::Entra => {
                let tenant = self
                    .tenant_id
                    .as_deref()
                    .ok_or(ProviderError::Configuration)?;
                if !canonical_uuid(tenant)
                    || !canonical_uuid(&self.interactive_client_id)
                    || !canonical_uuid(&self.broker_client_id)
                    || self.issuer != format!("https://login.microsoftonline.com/{tenant}/v2.0")
                    || self
                        .initial_scopes
                        .iter()
                        .all(|s| !s.starts_with(&format!("api://{}/", self.broker_client_id)))
                    || self.initial_scopes.iter().any(|s| {
                        !matches!(s.as_str(), "openid" | "profile" | "email")
                            && !s.starts_with(&format!("api://{}/", self.broker_client_id))
                    })
                    || !self.downstream_scope.contains('/')
                    || self.downstream_scope.ends_with('/')
                {
                    return Err(ProviderError::Configuration);
                }
            }
            ProviderKind::KeycloakTest => {
                if self.tenant_id.is_some()
                    || !is_loopback(&issuer)
                    || !issuer.path().starts_with("/realms/")
                    || issuer.path().trim_start_matches("/realms/").contains('/')
                    || issuer.path() == "/realms/"
                {
                    return Err(ProviderError::Configuration);
                }
            }
        }
        Ok(())
    }
}

/// A pre-existing authenticated-human binding, not a first-login identity.
/// For Entra, subject is the tenant-local object ID (oid), never an email or sub.
/// For Keycloak, subject is the provisioned realm sub.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedIdentity {
    pub issuer: String,
    pub subject: String,
}

/// Errors contain fixed categories only: never provider bodies, URLs, or tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    #[error("delegated provider configuration is invalid")]
    Configuration,
    #[error("delegated provider transport failed")]
    Transport,
    #[error("delegated provider rejected the request")]
    Rejected,
    #[error("delegated provider response is invalid")]
    InvalidResponse,
    #[error("delegated provider identity validation failed")]
    Identity,
    #[error("delegated grant has expired")]
    Expired,
}

/// The initial middle-tier assertion. Only this module may construct it.
/// No Debug/Serialize/Clone implementation: not a response DTO or log field.
pub struct InitialGrant {
    token: String,
    identity: ExpectedIdentity,
    expires_at: u64,
    provider_instance: Uuid,
}

impl InitialGrant {
    pub fn identity(&self) -> &ExpectedIdentity {
        &self.identity
    }
    pub fn expires_at(&self) -> u64 {
        self.expires_at
    }
}

/// The separate, validated downstream credential. Pass only to the scoped broker.
pub struct DelegatedToken {
    token: String,
    identity: ExpectedIdentity,
    expires_at: u64,
    audience: String,
    scope: String,
}

impl DelegatedToken {
    pub fn expose_token(&self) -> &str {
        &self.token
    }
    pub fn identity(&self) -> &ExpectedIdentity {
        &self.identity
    }
    pub fn expires_at(&self) -> u64 {
        self.expires_at
    }
    pub fn audience(&self) -> &str {
        &self.audience
    }
    pub fn scope(&self) -> &str {
        &self.scope
    }
}

pub struct DelegatedProvider {
    config: ProviderConfig,
    client: Client,
    metadata: Metadata,
    instance: Uuid,
}

#[derive(Deserialize)]
struct Metadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    id_token: Option<String>,
    issued_token_type: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Claims {
    iss: String,
    sub: String,
    aud: serde_json::Value,
    exp: u64,
    iat: u64,
    nonce: Option<String>,
    tid: Option<String>,
    oid: Option<String>,
    azp: Option<String>,
    appid: Option<String>,
    ver: Option<String>,
    scp: Option<String>,
}

#[derive(Deserialize)]
struct KeySet {
    keys: Vec<SigningKey>,
}

#[derive(Deserialize)]
struct SigningKey {
    kid: String,
    kty: String,
    n: Option<String>,
    e: Option<String>,
    alg: Option<String>,
    #[serde(rename = "use")]
    usage: Option<String>,
    key_ops: Option<Vec<String>>,
    issuer: Option<String>,
}

impl DelegatedProvider {
    pub async fn new(config: ProviderConfig) -> Result<Self, ProviderError> {
        config.validate()?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| ProviderError::Transport)?;
        let discovery = format!("{}/.well-known/openid-configuration", config.issuer);
        let metadata: Metadata = read_json(client.get(discovery)).await?;
        let expected_issuer = match config.kind {
            // Microsoft's tenant discovery may return this placeholder.
            ProviderKind::Entra => metadata.issuer.replace(
                "{tenantid}",
                config
                    .tenant_id
                    .as_deref()
                    .ok_or(ProviderError::Configuration)?,
            ),
            ProviderKind::KeycloakTest => metadata.issuer.clone(),
        };
        if expected_issuer != config.issuer {
            return Err(ProviderError::Identity);
        }
        for (endpoint, suffix) in [
            (
                &metadata.authorization_endpoint,
                if config.kind == ProviderKind::Entra {
                    "/oauth2/v2.0/authorize"
                } else {
                    "/protocol/openid-connect/auth"
                },
            ),
            (
                &metadata.token_endpoint,
                if config.kind == ProviderKind::Entra {
                    "/oauth2/v2.0/token"
                } else {
                    "/protocol/openid-connect/token"
                },
            ),
            (
                &metadata.jwks_uri,
                if config.kind == ProviderKind::Entra {
                    "/discovery/v2.0/keys"
                } else {
                    "/protocol/openid-connect/certs"
                },
            ),
        ] {
            validate_endpoint(&config, endpoint)?;
            let url = safe_url(endpoint)?;
            let prefix = if config.kind == ProviderKind::Entra {
                format!(
                    "/{}",
                    config
                        .tenant_id
                        .as_deref()
                        .ok_or(ProviderError::Configuration)?
                )
            } else {
                safe_url(&config.issuer)?.path().to_owned()
            };
            if url.path() != format!("{prefix}{suffix}")
                && !(config.kind == ProviderKind::Entra
                    && suffix == "/discovery/v2.0/keys"
                    && url.path() == "/common/discovery/v2.0/keys")
            {
                return Err(ProviderError::Identity);
            }
        }
        Ok(Self {
            config,
            client,
            metadata,
            instance: Uuid::new_v4(),
        })
    }

    pub fn kind(&self) -> ProviderKind {
        self.config.kind
    }
    pub fn issuer(&self) -> &str {
        &self.config.issuer
    }

    /// The caller must persist a short-lived, single-use state binding before redirect.
    pub fn authorization_url(
        &self,
        state: &str,
        challenge: &str,
        nonce: &str,
    ) -> Result<String, ProviderError> {
        if !valid_atom(state, 256)
            || state.len() < 32
            || !valid_atom(nonce, 256)
            || nonce.len() < 32
            || challenge.len() != 43
            || !challenge
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(ProviderError::Configuration);
        }
        let mut url = safe_url(&self.metadata.authorization_endpoint)?;
        url.query_pairs_mut().extend_pairs([
            ("client_id", self.config.interactive_client_id.as_str()),
            ("redirect_uri", self.config.redirect_uri.as_str()),
            ("response_type", "code"),
            ("response_mode", "query"),
            ("scope", self.config.initial_scopes.join(" ").as_str()),
            ("state", state),
            ("nonce", nonce),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("prompt", "login"),
        ]);
        Ok(url.into())
    }

    /// Initial public-client authorization-code + PKCE redemption, not OBO.
    /// Caller must have atomically consumed and checked callback state first.
    pub async fn redeem_code(
        &self,
        code: &str,
        verifier: &str,
        nonce: &str,
        expected: &ExpectedIdentity,
    ) -> Result<InitialGrant, ProviderError> {
        if !valid_atom(code, MAX_TOKEN)
            || !(43..=128).contains(&verifier.len())
            || !verifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
            || !valid_atom(nonce, 256)
            || nonce.len() < 32
            || expected.issuer != self.config.issuer
            || !valid_atom(&expected.subject, 256)
        {
            return Err(ProviderError::Identity);
        }
        let response: TokenResponse =
            read_json(self.client.post(&self.metadata.token_endpoint).form(&[
                ("grant_type", "authorization_code"),
                ("client_id", self.config.interactive_client_id.as_str()),
                ("redirect_uri", self.config.redirect_uri.as_str()),
                ("code", code),
                ("code_verifier", verifier),
                ("scope", self.config.initial_scopes.join(" ").as_str()),
            ]))
            .await?;
        validate_token_response(&response)?;
        let id_token = response
            .id_token
            .as_deref()
            .ok_or(ProviderError::Identity)?;
        let keys = self.keys().await?;
        let identity = self.validate_jwt(
            id_token,
            &self.config.interactive_client_id,
            None,
            &keys,
            true,
        )?;
        if identity.nonce.as_deref() != Some(nonce) {
            return Err(ProviderError::Identity);
        }
        let assertion = self.validate_jwt(
            &response.access_token,
            &self.config.broker_client_id,
            Some(&self.config.interactive_client_id),
            &keys,
            false,
        )?;
        if self.config.kind == ProviderKind::Entra {
            for scope in &self.config.initial_scopes {
                if scope.starts_with("api://") {
                    require_permission(&assertion, scope)?;
                }
            }
        }
        if self.subject(&identity)? != expected.subject
            || self.subject(&assertion)? != expected.subject
        {
            return Err(ProviderError::Identity);
        }
        let expires_at = expiry(response.expires_in, assertion.exp.min(identity.exp))?;
        Ok(InitialGrant {
            token: response.access_token,
            identity: expected.clone(),
            expires_at,
            provider_instance: self.instance,
        })
    }

    /// Actual downstream grant: Entra OBO or explicit Keycloak RFC 8693.
    pub async fn exchange(&self, initial: &InitialGrant) -> Result<DelegatedToken, ProviderError> {
        if initial.provider_instance != self.instance
            || initial.identity.issuer != self.config.issuer
        {
            return Err(ProviderError::Identity);
        }
        if initial.expires_at <= now()? {
            return Err(ProviderError::Expired);
        }
        let mut request = self.client.post(&self.metadata.token_endpoint);
        let form = match self.config.kind {
            ProviderKind::Entra => vec![
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("requested_token_use", "on_behalf_of"),
                ("assertion", initial.token.as_str()),
                ("client_id", self.config.broker_client_id.as_str()),
                ("client_secret", self.config.broker_client_secret.as_str()),
                ("scope", self.config.downstream_scope.as_str()),
            ],
            ProviderKind::KeycloakTest => {
                // OAuth client_secret_basic percent-encodes each credential component.
                request = request.basic_auth(
                    oauth_component(&self.config.broker_client_id),
                    Some(oauth_component(&self.config.broker_client_secret)),
                );
                vec![
                    (
                        "grant_type",
                        "urn:ietf:params:oauth:grant-type:token-exchange",
                    ),
                    ("subject_token", initial.token.as_str()),
                    ("subject_token_type", ACCESS_TOKEN_TYPE),
                    ("requested_token_type", ACCESS_TOKEN_TYPE),
                    ("audience", self.config.downstream_audience.as_str()),
                    ("scope", self.config.downstream_scope.as_str()),
                ]
            }
        };
        let response: TokenResponse = read_json(request.form(&form)).await?;
        validate_token_response(&response)?;
        if self.config.kind == ProviderKind::KeycloakTest
            && response.issued_token_type.as_deref() != Some(ACCESS_TOKEN_TYPE)
        {
            return Err(ProviderError::InvalidResponse);
        }
        let keys = self.keys().await?;
        let claims = self.validate_jwt(
            &response.access_token,
            &self.config.downstream_audience,
            Some(&self.config.broker_client_id),
            &keys,
            false,
        )?;
        if self.config.kind == ProviderKind::Entra {
            require_permission(&claims, &self.config.downstream_scope)?;
        }
        if self.subject(&claims)? != initial.identity.subject
            || response.access_token == initial.token
        {
            return Err(ProviderError::Identity);
        }
        let expires_at = expiry(response.expires_in, claims.exp)?.min(initial.expires_at);
        Ok(DelegatedToken {
            token: response.access_token,
            identity: initial.identity.clone(),
            expires_at,
            audience: self.config.downstream_audience.clone(),
            scope: self.config.downstream_scope.clone(),
        })
    }

    async fn keys(&self) -> Result<KeySet, ProviderError> {
        let keys: KeySet = read_json(self.client.get(&self.metadata.jwks_uri)).await?;
        if keys.keys.is_empty() || keys.keys.len() > 64 {
            return Err(ProviderError::Identity);
        }
        Ok(keys)
    }

    fn subject<'a>(&self, claims: &'a Claims) -> Result<&'a str, ProviderError> {
        match self.config.kind {
            ProviderKind::Entra => claims
                .oid
                .as_deref()
                .filter(|oid| canonical_uuid(oid))
                .ok_or(ProviderError::Identity),
            ProviderKind::KeycloakTest => Ok(&claims.sub),
        }
    }

    fn validate_jwt(
        &self,
        token: &str,
        audience: &str,
        party: Option<&str>,
        keys: &KeySet,
        id_token: bool,
    ) -> Result<Claims, ProviderError> {
        if !valid_atom(token, MAX_TOKEN) {
            return Err(ProviderError::Identity);
        }
        let header = decode_header(token).map_err(|_| ProviderError::Identity)?;
        if header.alg != Algorithm::RS256 {
            return Err(ProviderError::Identity);
        }
        let kid = header
            .kid
            .as_deref()
            .filter(|k| valid_atom(k, 256))
            .ok_or(ProviderError::Identity)?;
        let mut matching = keys.keys.iter().filter(|key| key.kid == kid);
        let key = matching.next().ok_or(ProviderError::Identity)?;
        if matching.next().is_some()
            || key.kty != "RSA"
            || key.alg.as_deref().is_some_and(|a| a != "RS256")
            || key.usage.as_deref().is_some_and(|u| u != "sig")
            || key
                .key_ops
                .as_ref()
                .is_some_and(|ops| !ops.iter().any(|o| o == "verify"))
        {
            return Err(ProviderError::Identity);
        }
        let n = key.n.as_deref().ok_or(ProviderError::Identity)?;
        let e = key.e.as_deref().ok_or(ProviderError::Identity)?;
        use base64::Engine;
        let modulus = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(n)
            .map_err(|_| ProviderError::Identity)?;
        if !(256..=1024).contains(&modulus.len()) {
            return Err(ProviderError::Identity);
        }
        let decoding_key =
            DecodingKey::from_rsa_components(n, e).map_err(|_| ProviderError::Identity)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.set_audience(&[audience]);
        validation.set_required_spec_claims(&["exp", "iat", "iss", "aud", "sub"]);
        let mut issuers = vec![self.config.issuer.clone()];
        if self.config.kind == ProviderKind::Entra && !id_token {
            issuers.push(format!(
                "https://sts.windows.net/{}/",
                self.config
                    .tenant_id
                    .as_deref()
                    .ok_or(ProviderError::Identity)?
            ));
        }
        validation.set_issuer(&issuers);
        let claims = decode::<Claims>(token, &decoding_key, &validation)
            .map_err(|_| ProviderError::Identity)?
            .claims;
        let exact_audience = claims.aud.as_str() == Some(audience)
            || claims
                .aud
                .as_array()
                .is_some_and(|a| a.len() == 1 && a[0].as_str() == Some(audience));
        if !exact_audience
            || !valid_atom(&claims.sub, 256)
            || claims.iat > now()?
            || claims.iat >= claims.exp
            || claims.exp <= now()?
        {
            return Err(ProviderError::Identity);
        }
        if let Some(key_issuer) = &key.issuer {
            let expected =
                key_issuer.replace("{tenantid}", self.config.tenant_id.as_deref().unwrap_or(""));
            // Microsoft keys advertise the v2 issuer even for tenant's v1 access tokens.
            if expected != self.config.issuer {
                return Err(ProviderError::Identity);
            }
        }
        match self.config.kind {
            ProviderKind::Entra => {
                if claims.tid != self.config.tenant_id {
                    return Err(ProviderError::Identity);
                }
                self.subject(&claims)?;
                let authorized_party = match claims.ver.as_deref() {
                    Some("2.0") if claims.iss == self.config.issuer => claims.azp.as_deref(),
                    Some("1.0") if !id_token && claims.iss == issuers[1] => claims.appid.as_deref(),
                    _ => return Err(ProviderError::Identity),
                };
                if party.is_some_and(|p| authorized_party != Some(p))
                    || (!id_token && claims.scp.as_deref().is_none_or(|s| s.trim().is_empty()))
                {
                    return Err(ProviderError::Identity);
                }
            }
            ProviderKind::KeycloakTest => {
                if party.is_some_and(|p| claims.azp.as_deref() != Some(p)) {
                    return Err(ProviderError::Identity);
                }
            }
        }
        Ok(claims)
    }
}

fn validate_token_response(response: &TokenResponse) -> Result<(), ProviderError> {
    if !response.token_type.eq_ignore_ascii_case("Bearer")
        || !valid_atom(&response.access_token, MAX_TOKEN)
        || response.expires_in == 0
        || response.expires_in > 86400
    {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(())
}

fn require_permission(claims: &Claims, scope: &str) -> Result<(), ProviderError> {
    let permission = scope
        .rsplit('/')
        .next()
        .filter(|p| !p.is_empty())
        .ok_or(ProviderError::Identity)?;
    // .default names the operator-configured resource's consented delegated grants.
    // App-only role tokens still fail the mandatory signed scp check above.
    if permission != ".default"
        && !claims
            .scp
            .as_deref()
            .is_some_and(|scp| scp.split_whitespace().any(|s| s == permission))
    {
        return Err(ProviderError::Identity);
    }
    Ok(())
}

fn now() -> Result<u64, ProviderError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| ProviderError::Expired)
}

fn expiry(expires_in: u64, jwt_exp: u64) -> Result<u64, ProviderError> {
    let now = now()?;
    let expiry = now
        .checked_add(expires_in.min(MAX_LIFETIME))
        .ok_or(ProviderError::Expired)?
        .min(jwt_exp);
    if expiry <= now {
        return Err(ProviderError::Expired);
    }
    Ok(expiry)
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}

fn valid_atom(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn safe_url(value: &str) -> Result<Url, ProviderError> {
    let url = Url::parse(value).map_err(|_| ProviderError::Configuration)?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ProviderError::Configuration);
    }
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1") | Some("[::1]"))
}

fn validate_endpoint(config: &ProviderConfig, endpoint: &str) -> Result<(), ProviderError> {
    let endpoint = safe_url(endpoint)?;
    let issuer = safe_url(&config.issuer)?;
    if endpoint.query().is_some() || endpoint.origin() != issuer.origin() {
        return Err(ProviderError::Identity);
    }
    let valid_path = match config.kind {
        ProviderKind::Entra => {
            let tenant = config
                .tenant_id
                .as_deref()
                .ok_or(ProviderError::Configuration)?;
            [
                format!("/{tenant}/oauth2/v2.0/authorize"),
                format!("/{tenant}/oauth2/v2.0/token"),
                format!("/{tenant}/discovery/v2.0/keys"),
                "/common/discovery/v2.0/keys".to_owned(),
            ]
            .contains(&endpoint.path().to_owned())
        }
        ProviderKind::KeycloakTest => endpoint
            .path()
            .starts_with(&format!("{}/protocol/openid-connect/", issuer.path())),
    };
    if !valid_path {
        return Err(ProviderError::Identity);
    }
    Ok(())
}

fn oauth_component(value: &str) -> String {
    let mut url = Url::parse("https://oauth.invalid").expect("static URL");
    url.query_pairs_mut().append_pair("v", value);
    url.query().expect("query was set")[2..].to_owned()
}

async fn read_json<T: serde::de::DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, ProviderError> {
    let mut response = request.send().await.map_err(|_| ProviderError::Transport)?;
    if !response.status().is_success() {
        return Err(ProviderError::Rejected);
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err(ProviderError::InvalidResponse);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ProviderError::Transport)?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(ProviderError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| ProviderError::InvalidResponse)?;
    if !value.is_object() || value.get("error").is_some() {
        return Err(ProviderError::InvalidResponse);
    }
    serde_json::from_slice(&body).map_err(|_| ProviderError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        extract::State,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post},
    };
    use rsa::{RsaPrivateKey, pkcs1::EncodeRsaPrivateKey, traits::PublicKeyParts};
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex, OnceLock};

    const TENANT: &str = "11111111-1111-4111-8111-111111111111";
    const HUMAN: &str = "22222222-2222-4222-8222-222222222222";
    const INTERACTIVE: &str = "33333333-3333-4333-8333-333333333333";
    const BROKER: &str = "44444444-4444-4444-8444-444444444444";
    const DOWNSTREAM: &str = "55555555-5555-4555-8555-555555555555";
    const NONCE: &str = "nonce-abcdefghijklmnopqrstuvwxyz-012345";
    const VERIFIER: &str = "verifier-abcdefghijklmnopqrstuvwxyz-0123456789012345";

    fn signing_material() -> &'static (jsonwebtoken::EncodingKey, Value) {
        static KEY: OnceLock<(jsonwebtoken::EncodingKey, Value)> = OnceLock::new();
        KEY.get_or_init(|| {
            use base64::Engine;
            let key = RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048).unwrap();
            let encoding =
                jsonwebtoken::EncodingKey::from_rsa_der(key.to_pkcs1_der().unwrap().as_bytes());
            let jwk = json!({
                "kid":"offline-test", "kty":"RSA", "alg":"RS256", "use":"sig",
                "n":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),
                "e":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.e().to_bytes_be())
            });
            (encoding, jwk)
        })
    }

    fn sign(value: &Value) -> String {
        let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
        header.kid = Some("offline-test".to_owned());
        jsonwebtoken::encode(&header, value, &signing_material().0).unwrap()
    }

    fn config(kind: ProviderKind) -> ProviderConfig {
        ProviderConfig {
            kind,
            issuer: format!("https://login.microsoftonline.com/{TENANT}/v2.0"),
            tenant_id: Some(TENANT.to_owned()),
            interactive_client_id: INTERACTIVE.to_owned(),
            broker_client_id: BROKER.to_owned(),
            broker_client_secret: "synthetic-only-test-secret".to_owned(),
            redirect_uri: "http://127.0.0.1:18881/callback".to_owned(),
            initial_scopes: vec![
                "openid".to_owned(),
                format!("api://{BROKER}/access_as_user"),
            ],
            downstream_scope: format!("api://{DOWNSTREAM}/.default"),
            downstream_audience: DOWNSTREAM.to_owned(),
        }
    }

    fn claims(config: &ProviderConfig, aud: &str, party: &str) -> Value {
        json!({
            "iss":config.issuer,"sub":"pairwise-human", "oid":HUMAN, "tid":TENANT,
            "aud":aud, "exp":now().unwrap()+300, "iat":now().unwrap()-10,
            "nonce":NONCE, "azp":party, "ver":"2.0", "scp":"access_as_user"
        })
    }

    #[derive(Default)]
    struct MockState {
        replies: Mutex<std::collections::VecDeque<(StatusCode, Value)>>,
        requests: Mutex<Vec<(HeaderMap, std::collections::HashMap<String, String>)>>,
        keys: Mutex<Value>,
        metadata: Mutex<Value>,
    }

    struct Fixture {
        provider: DelegatedProvider,
        state: Arc<MockState>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl Fixture {
        async fn new(kind: ProviderKind) -> Self {
            async fn token(
                State(state): State<Arc<MockState>>,
                headers: HeaderMap,
                axum::Form(form): axum::Form<std::collections::HashMap<String, String>>,
            ) -> impl IntoResponse {
                state.requests.lock().unwrap().push((headers, form));
                let reply = state.replies.lock().unwrap().pop_front().unwrap_or((
                    StatusCode::BAD_REQUEST,
                    json!({"error":"unexpected_request"}),
                ));
                (reply.0, Json(reply.1))
            }
            async fn keys(State(state): State<Arc<MockState>>) -> Json<Value> {
                Json(state.keys.lock().unwrap().clone())
            }
            async fn metadata(State(state): State<Arc<MockState>>) -> Json<Value> {
                Json(state.metadata.lock().unwrap().clone())
            }
            let state = Arc::new(MockState::default());
            *state.keys.lock().unwrap() = json!({"keys":[signing_material().1.clone()]});
            let app = Router::new()
                .route("/token", post(token))
                .route(
                    "/redirect",
                    post(|| async {
                        (
                            StatusCode::TEMPORARY_REDIRECT,
                            [(axum::http::header::LOCATION, "/token")],
                        )
                    }),
                )
                .route("/keys", get(keys))
                .route(
                    "/realms/local-obo/.well-known/openid-configuration",
                    get(metadata),
                )
                .route(
                    "/realms/local-obo/protocol/openid-connect/token",
                    post(token),
                )
                .route("/realms/local-obo/protocol/openid-connect/certs", get(keys))
                .with_state(state.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let mut config = config(kind);
            if kind == ProviderKind::KeycloakTest {
                config.issuer = format!("{base}/realms/local-obo");
                config.tenant_id = None;
                config.interactive_client_id = "interactive".to_owned();
                config.broker_client_id = "connector".to_owned();
                config.downstream_audience = "flag-api".to_owned();
                config.downstream_scope = "openid".to_owned();
                config.initial_scopes = vec!["openid".to_owned()];
            }
            let metadata = Metadata {
                issuer: config.issuer.clone(),
                authorization_endpoint: format!("{base}/authorize"),
                token_endpoint: format!("{base}/token"),
                jwks_uri: format!("{base}/keys"),
            };
            *state.metadata.lock().unwrap() = json!({
                "issuer": config.issuer,
                "authorization_endpoint":format!("{}/protocol/openid-connect/auth",config.issuer),
                "token_endpoint":format!("{}/protocol/openid-connect/token",config.issuer),
                "jwks_uri":format!("{}/protocol/openid-connect/certs",config.issuer)
            });
            // The only HTTP override for Entra is inside this private test fixture.
            // Production construction validates pinned HTTPS Microsoft endpoints.
            let provider = DelegatedProvider {
                config,
                client: Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .no_proxy()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap(),
                metadata,
                instance: Uuid::new_v4(),
            };
            Self {
                provider,
                state,
                task,
            }
        }

        fn expected(&self) -> ExpectedIdentity {
            ExpectedIdentity {
                issuer: self.provider.config.issuer.clone(),
                subject: if self.provider.config.kind == ProviderKind::Entra {
                    HUMAN
                } else {
                    "pairwise-human"
                }
                .to_owned(),
            }
        }

        fn initial_claims(&self) -> (Value, Value) {
            let config = &self.provider.config;
            (
                claims(
                    config,
                    &config.interactive_client_id,
                    &config.interactive_client_id,
                ),
                claims(
                    config,
                    &config.broker_client_id,
                    &config.interactive_client_id,
                ),
            )
        }

        fn initial_reply(&self, id: &Value, assertion: &Value) {
            self.reply(StatusCode::OK, json!({
                "access_token":sign(assertion),"id_token":sign(id),"token_type":"Bearer","expires_in":300
            }));
        }

        fn reply(&self, status: StatusCode, body: Value) {
            self.state.replies.lock().unwrap().push_back((status, body));
        }

        async fn redeem(&self) -> Result<InitialGrant, ProviderError> {
            self.provider
                .redeem_code("synthetic-code", VERIFIER, NONCE, &self.expected())
                .await
        }

        fn downstream(&self) -> Value {
            claims(
                &self.provider.config,
                &self.provider.config.downstream_audience,
                &self.provider.config.broker_client_id,
            )
        }

        fn downstream_reply(&self, claims: &Value) {
            self.reply(StatusCode::OK, json!({
                "access_token":sign(claims),"token_type":"Bearer","expires_in":300,"issued_token_type":ACCESS_TOKEN_TYPE
            }));
        }
    }

    #[test]
    fn unconfigured_provider_is_disabled() {
        assert!(
            super::ProviderConfig::from_lookup(|_| None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn environment_selection_is_explicit_and_never_falls_back() {
        for value in ["", "keycloak", "auto", "ENTRA"] {
            let result = ProviderConfig::from_lookup(|name| {
                (name == "CRONY_DELEGATED_PROVIDER").then(|| value.to_owned())
            });
            assert!(matches!(result, Err(ProviderError::Configuration)));
        }
        let result = ProviderConfig::from_lookup(|name| {
            (name == "CRONY_DELEGATED_PROVIDER").then(|| "entra".to_owned())
        });
        assert!(matches!(result, Err(ProviderError::Configuration)));
    }

    #[test]
    fn configuration_denies_untrusted_authorities_and_refresh_scope() {
        assert!(config(ProviderKind::Entra).validate().is_ok());
        for issuer in [
            "http://login.microsoftonline.com/tenant/v2.0",
            "https://evil.invalid/tenant/v2.0",
            "https://login.microsoftonline.com/common/v2.0",
        ] {
            let mut value = config(ProviderKind::Entra);
            value.issuer = issuer.to_owned();
            assert!(value.validate().is_err());
        }
        let mut value = config(ProviderKind::Entra);
        value.initial_scopes.push("offline_access".to_owned());
        assert!(value.validate().is_err());
        value = config(ProviderKind::KeycloakTest);
        value.tenant_id = None;
        value.issuer = "http://192.168.1.1/realms/local-obo".to_owned();
        assert!(value.validate().is_err());
    }

    #[tokio::test]
    async fn authorization_request_is_pkce_state_nonce_bound_without_credentials() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        let challenge = "A".repeat(43);
        let url = fixture
            .provider
            .authorization_url(NONCE, &challenge, NONCE)
            .unwrap();
        let url = Url::parse(&url).unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params["response_type"], "code");
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["code_challenge"], challenge);
        assert_eq!(params["state"], NONCE);
        assert_eq!(params["nonce"], NONCE);
        assert!(!params.contains_key("client_secret"));
        assert!(
            fixture
                .provider
                .authorization_url("", &challenge, NONCE)
                .is_err()
        );
        assert!(
            fixture
                .provider
                .authorization_url(NONCE, "short", NONCE)
                .is_err()
        );
    }

    #[tokio::test]
    async fn entra_real_functions_send_distinct_code_and_obo_contracts() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        let (mut id, assertion) = fixture.initial_claims();
        // Entra sub is pairwise per application; oid+tid binds the human.
        id["sub"] = json!("different-pairwise-id-sub");
        fixture.initial_reply(&id, &assertion);
        let initial = fixture.redeem().await.unwrap();
        fixture.downstream_reply(&fixture.downstream());
        let downstream = fixture.provider.exchange(&initial).await.unwrap();
        assert_eq!(downstream.identity(), &fixture.expected());
        assert_eq!(downstream.audience(), DOWNSTREAM);
        assert!(downstream.expires_at() <= initial.expires_at());
        assert_ne!(downstream.expose_token(), initial.token);
        let requests = fixture.state.requests.lock().unwrap();
        let first = &requests[0].1;
        assert_eq!(first["grant_type"], "authorization_code");
        assert_eq!(first["code_verifier"], VERIFIER);
        assert_eq!(first["client_id"], INTERACTIVE);
        assert!(!first.contains_key("client_secret"));
        let second = &requests[1].1;
        assert_eq!(
            second["grant_type"],
            "urn:ietf:params:oauth:grant-type:jwt-bearer"
        );
        assert_eq!(second["requested_token_use"], "on_behalf_of");
        assert_eq!(second["assertion"], initial.token);
        assert_eq!(second["client_id"], BROKER);
        assert_eq!(second["scope"], fixture.provider.config.downstream_scope);
        assert!(second.contains_key("client_secret"));
        assert!(!second.contains_key("subject_token"));
        assert!(!second.contains_key("audience"));
    }

    #[tokio::test]
    async fn keycloak_is_explicit_rfc8693_and_checks_preserved_subject() {
        let fixture = Fixture::new(ProviderKind::KeycloakTest).await;
        let (id, assertion) = fixture.initial_claims();
        fixture.initial_reply(&id, &assertion);
        let initial = fixture.redeem().await.unwrap();
        fixture.downstream_reply(&fixture.downstream());
        assert!(fixture.provider.exchange(&initial).await.is_ok());
        {
            let requests = fixture.state.requests.lock().unwrap();
            let (headers, form) = &requests[1];
            assert!(
                headers["authorization"]
                    .to_str()
                    .unwrap()
                    .starts_with("Basic ")
            );
            assert_eq!(
                form["grant_type"],
                "urn:ietf:params:oauth:grant-type:token-exchange"
            );
            assert_eq!(form["subject_token_type"], ACCESS_TOKEN_TYPE);
            assert_eq!(form["requested_token_type"], ACCESS_TOKEN_TYPE);
            assert_eq!(form["audience"], "flag-api");
            assert!(!form.contains_key("assertion"));
            assert!(!form.contains_key("requested_token_use"));
        }
        let mut changed = fixture.downstream();
        changed["sub"] = json!("another-user");
        fixture.downstream_reply(&changed);
        assert!(matches!(
            fixture.provider.exchange(&initial).await,
            Err(ProviderError::Identity)
        ));
    }

    #[tokio::test]
    async fn initial_identity_and_assertion_validation_fail_closed() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        for field in ["iss", "aud", "nonce", "tid", "oid", "exp", "iat"] {
            let (mut id, assertion) = fixture.initial_claims();
            id[field] = match field {
                "exp" => json!(now().unwrap() - 1),
                "iat" => json!(now().unwrap() + 60),
                _ => json!("wrong"),
            };
            fixture.initial_reply(&id, &assertion);
            assert!(
                matches!(fixture.redeem().await, Err(ProviderError::Identity)),
                "{field}"
            );
        }
        for field in ["iss", "aud", "tid", "oid", "azp", "scp"] {
            let (id, mut assertion) = fixture.initial_claims();
            assertion[field] = if field == "scp" {
                json!("")
            } else {
                json!("wrong")
            };
            fixture.initial_reply(&id, &assertion);
            assert!(
                matches!(fixture.redeem().await, Err(ProviderError::Identity)),
                "{field}"
            );
        }
        let (id, mut assertion) = fixture.initial_claims();
        assertion["aud"] = json!([BROKER, DOWNSTREAM]);
        fixture.initial_reply(&id, &assertion);
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::Identity)
        ));
    }

    #[tokio::test]
    async fn expected_human_is_not_replaced_by_first_successful_login() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        let (id, assertion) = fixture.initial_claims();
        fixture.initial_reply(&id, &assertion);
        let mut expected = fixture.expected();
        expected.subject = "99999999-9999-4999-8999-999999999999".to_owned();
        assert!(matches!(
            fixture
                .provider
                .redeem_code("code", VERIFIER, NONCE, &expected)
                .await,
            Err(ProviderError::Identity)
        ));
    }

    #[tokio::test]
    async fn malformed_signature_unknown_key_and_duplicate_key_are_rejected() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        let (id, assertion) = fixture.initial_claims();
        let mut bad = sign(&id);
        let position = bad.rfind('.').unwrap() + 1;
        let replacement = if &bad[position..position + 1] == "A" {
            "B"
        } else {
            "A"
        };
        bad.replace_range(position..position + 1, replacement);
        fixture.reply(StatusCode::OK, json!({"access_token":sign(&assertion),"id_token":bad,"token_type":"Bearer","expires_in":300}));
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::Identity)
        ));
        let mut unknown = signing_material().1.clone();
        unknown["kid"] = json!("unknown");
        *fixture.state.keys.lock().unwrap() = json!({"keys":[unknown]});
        fixture.initial_reply(&id, &assertion);
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::Identity)
        ));
        *fixture.state.keys.lock().unwrap() =
            json!({"keys":[signing_material().1.clone(),signing_material().1.clone()]});
        fixture.initial_reply(&id, &assertion);
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::Identity)
        ));
    }

    #[tokio::test]
    async fn downstream_validation_rejects_wrong_audience_tenant_actor_and_app_only() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        let (id, assertion) = fixture.initial_claims();
        fixture.initial_reply(&id, &assertion);
        let initial = fixture.redeem().await.unwrap();
        for field in ["iss", "aud", "tid", "oid", "azp", "scp", "exp"] {
            let mut changed = fixture.downstream();
            changed[field] = match field {
                "exp" => json!(now().unwrap() - 1),
                "scp" => json!(""),
                _ => json!("wrong"),
            };
            fixture.downstream_reply(&changed);
            assert!(
                matches!(
                    fixture.provider.exchange(&initial).await,
                    Err(ProviderError::Identity)
                ),
                "{field}"
            );
        }
    }

    #[tokio::test]
    async fn entra_v1_resource_token_still_requires_exact_tenant_audience_and_appid() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        let (id, assertion) = fixture.initial_claims();
        fixture.initial_reply(&id, &assertion);
        let initial = fixture.redeem().await.unwrap();
        let mut downstream = fixture.downstream();
        downstream["ver"] = json!("1.0");
        downstream["iss"] = json!(format!("https://sts.windows.net/{TENANT}/"));
        downstream["appid"] = json!(BROKER);
        downstream.as_object_mut().unwrap().remove("azp");
        fixture.downstream_reply(&downstream);
        assert!(fixture.provider.exchange(&initial).await.is_ok());
        downstream["appid"] = json!("wrong");
        fixture.downstream_reply(&downstream);
        assert!(matches!(
            fixture.provider.exchange(&initial).await,
            Err(ProviderError::Identity)
        ));
    }

    #[tokio::test]
    async fn provider_errors_are_redacted_and_never_retried_as_another_grant() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FOUND,
        ] {
            fixture.reply(
                status,
                json!({"error":"invalid_grant","error_description":"SECRET-MARKER"}),
            );
            let error = fixture.redeem().await.err().unwrap();
            assert_eq!(error, ProviderError::Rejected);
            assert!(!format!("{error:?} {error}").contains("SECRET-MARKER"));
        }
        assert_eq!(fixture.state.requests.lock().unwrap().len(), 3);
        fixture.reply(
            StatusCode::OK,
            json!({"access_token":"SECRET-MARKER","token_type":"mac","expires_in":300}),
        );
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::InvalidResponse)
        ));
        fixture.reply(StatusCode::OK, json!({"padding":"x".repeat(MAX_BODY+1)}));
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::InvalidResponse)
        ));
    }

    #[tokio::test]
    async fn expiry_and_provider_instance_binding_prevent_reuse() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        let (id, assertion) = fixture.initial_claims();
        fixture.initial_reply(&id, &assertion);
        let mut initial = fixture.redeem().await.unwrap();
        initial.provider_instance = Uuid::new_v4();
        assert!(matches!(
            fixture.provider.exchange(&initial).await,
            Err(ProviderError::Identity)
        ));
        initial.provider_instance = fixture.provider.instance;
        initial.expires_at = now().unwrap() - 1;
        assert!(matches!(
            fixture.provider.exchange(&initial).await,
            Err(ProviderError::Expired)
        ));
        assert_eq!(fixture.state.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn discovery_validates_issuer_and_endpoint_authority() {
        let mut fixture = Fixture::new(ProviderKind::KeycloakTest).await;
        let placeholder = config(ProviderKind::Entra);
        let actual = std::mem::replace(&mut fixture.provider.config, placeholder);
        assert!(DelegatedProvider::new(actual).await.is_ok());
        for endpoint in [
            "http://evil.invalid/realms/local-obo/protocol/openid-connect/token",
            "http://127.0.0.1:9/wrong",
        ] {
            let value = config(ProviderKind::Entra);
            assert!(validate_endpoint(&value, endpoint).is_err());
        }
        assert!(
            validate_endpoint(
                &config(ProviderKind::Entra),
                &format!("https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token")
            )
            .is_ok()
        );
    }

    #[tokio::test]
    async fn requested_delegated_permissions_must_be_present_in_signed_scope() {
        let mut fixture = Fixture::new(ProviderKind::Entra).await;
        let (id, mut assertion) = fixture.initial_claims();
        assertion["scp"] = json!("unrelated_permission");
        fixture.initial_reply(&id, &assertion);
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::Identity)
        ));
        let (id, assertion) = fixture.initial_claims();
        fixture.initial_reply(&id, &assertion);
        let initial = fixture.redeem().await.unwrap();
        fixture.provider.config.downstream_scope = format!("api://{DOWNSTREAM}/flag.read");
        fixture.downstream_reply(&fixture.downstream());
        assert!(matches!(
            fixture.provider.exchange(&initial).await,
            Err(ProviderError::Identity)
        ));
        let mut downstream = fixture.downstream();
        downstream["scp"] = json!("flag.read");
        fixture.downstream_reply(&downstream);
        assert!(fixture.provider.exchange(&initial).await.is_ok());
    }

    #[tokio::test]
    async fn success_status_with_oauth_error_is_not_a_success() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        let (id, assertion) = fixture.initial_claims();
        fixture.reply(
            StatusCode::OK,
            json!({
                "access_token":sign(&assertion),"id_token":sign(&id),"token_type":"Bearer",
                "expires_in":300,"error":"invalid_grant"
            }),
        );
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::InvalidResponse)
        ));
    }

    #[tokio::test]
    async fn discovery_endpoint_roles_cannot_be_swapped() {
        let mut fixture = Fixture::new(ProviderKind::KeycloakTest).await;
        {
            let mut metadata = fixture.state.metadata.lock().unwrap();
            metadata["token_endpoint"] = metadata["jwks_uri"].clone();
        }
        let actual = std::mem::replace(&mut fixture.provider.config, config(ProviderKind::Entra));
        assert!(matches!(
            DelegatedProvider::new(actual).await,
            Err(ProviderError::Identity)
        ));
    }

    #[tokio::test]
    async fn token_redirects_are_not_followed_and_transport_failures_are_sanitized() {
        let mut fixture = Fixture::new(ProviderKind::Entra).await;
        fixture.provider.metadata.token_endpoint = fixture
            .provider
            .metadata
            .token_endpoint
            .replace("/token", "/redirect");
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::Rejected)
        ));
        assert!(fixture.state.requests.lock().unwrap().is_empty());
        fixture.task.abort();
        let _ = (&mut fixture.task).await;
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::Transport)
        ));
    }

    #[tokio::test]
    async fn missing_required_claims_and_not_yet_valid_tokens_fail_closed() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        for field in ["iss", "sub", "aud", "exp", "iat", "oid", "tid", "nonce"] {
            let (mut id, assertion) = fixture.initial_claims();
            id.as_object_mut().unwrap().remove(field);
            fixture.initial_reply(&id, &assertion);
            assert!(
                matches!(fixture.redeem().await, Err(ProviderError::Identity)),
                "{field}"
            );
        }
        let (mut id, assertion) = fixture.initial_claims();
        id["nbf"] = json!(now().unwrap() + 60);
        fixture.initial_reply(&id, &assertion);
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::Identity)
        ));
    }

    #[tokio::test]
    async fn token_response_and_exchange_type_are_not_trusted() {
        let fixture = Fixture::new(ProviderKind::KeycloakTest).await;
        let (id, assertion) = fixture.initial_claims();
        for expires_in in [0, 86401] {
            fixture.reply(
                StatusCode::OK,
                json!({
                    "access_token":sign(&assertion),"id_token":sign(&id),
                    "token_type":"Bearer","expires_in":expires_in
                }),
            );
            assert!(matches!(
                fixture.redeem().await,
                Err(ProviderError::InvalidResponse)
            ));
        }
        fixture.initial_reply(&id, &assertion);
        let initial = fixture.redeem().await.unwrap();
        fixture.reply(
            StatusCode::OK,
            json!({
                "access_token":sign(&fixture.downstream()),"token_type":"Bearer",
                "expires_in":300,"issued_token_type":"urn:ietf:params:oauth:token-type:id_token"
            }),
        );
        assert!(matches!(
            fixture.provider.exchange(&initial).await,
            Err(ProviderError::InvalidResponse)
        ));
    }

    #[tokio::test]
    async fn unsupported_algorithm_and_nonsigning_jwks_are_rejected() {
        let fixture = Fixture::new(ProviderKind::Entra).await;
        let (id, assertion) = fixture.initial_claims();
        let mut header = jsonwebtoken::Header::new(Algorithm::HS256);
        header.kid = Some("offline-test".to_owned());
        let token = jsonwebtoken::encode(
            &header,
            &id,
            &jsonwebtoken::EncodingKey::from_secret(b"synthetic-test-only"),
        )
        .unwrap();
        fixture.reply(StatusCode::OK, json!({
            "access_token":sign(&assertion),"id_token":token,"token_type":"Bearer","expires_in":300
        }));
        assert!(matches!(
            fixture.redeem().await,
            Err(ProviderError::Identity)
        ));
        for (field, value) in [
            ("use", json!("enc")),
            ("alg", json!("RS512")),
            ("key_ops", json!(["encrypt"])),
        ] {
            let mut key = signing_material().1.clone();
            key[field] = value;
            *fixture.state.keys.lock().unwrap() = json!({"keys":[key]});
            fixture.initial_reply(&id, &assertion);
            assert!(
                matches!(fixture.redeem().await, Err(ProviderError::Identity)),
                "{field}"
            );
        }
    }
}
