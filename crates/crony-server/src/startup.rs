//! Configuration preparation must finish before migrations or activation.
//! OIDC discovery is a bounded read-only network operation, not a storage effect.
use anyhow::{Result, anyhow};
use axum::http::{
    HeaderName, HeaderValue, Method,
    header::{AUTHORIZATION, CONTENT_TYPE},
};
use tower_http::cors::{Any, CorsLayer};

use crate::{
    Args,
    artifacts::{ArtifactStore, PreparedArtifactStore},
    auth::{AuthService, ServerMode},
    secrets::SecretCipher,
};

pub struct PreparedStartup {
    pub auth: AuthService,
    pub secret_cipher: SecretCipher,
    pub artifacts: PreparedArtifactStore,
    pub cors: CorsLayer,
}

impl PreparedStartup {
    pub async fn prepare(args: &Args) -> Result<Self> {
        let cors = prepare_cors(args.mode, &args.cors_origins)?;
        let secret_cipher = SecretCipher::initialize(
            args.mode,
            args.secret_master_key_hex.as_deref(),
        )
        .map_err(|_| {
            anyhow!("invalid CRONY_SECRET_MASTER_KEY_HEX: expected a 32-byte hexadecimal key")
        })?;
        let artifacts = ArtifactStore::prepare(
            &args.object_store_backend,
            args.object_store_local_root.clone(),
            args.object_store_endpoint.as_deref(),
            args.object_store_bucket.as_deref(),
            Some(&args.object_store_region),
            args.object_store_access_key.as_deref(),
            args.object_store_secret_key.as_deref(),
            args.object_store_allow_http,
            args.artifact_signing_key_hex.as_deref(),
            args.artifact_max_bytes,
            args.mode == ServerMode::Production,
        )?;
        // Drop the underlying error chain: discovery errors may include URLs,
        // credentials, or response values. Keep #270's discovery behavior intact.
        let auth = AuthService::initialize(args.mode, args.oidc_issuer.clone(), args.allow_insecure_oidc)
            .await.map_err(|_| anyhow!("invalid OIDC configuration or discovery: check CRONY_OIDC_ISSUER and issuer metadata"))?;
        Ok(Self {
            auth,
            secret_cipher,
            artifacts,
            cors,
        })
    }
}

fn prepare_cors(mode: ServerMode, values: &[String]) -> Result<CorsLayer> {
    if mode == ServerMode::Development {
        return Ok(CorsLayer::new()
            .allow_origin(Any)
            .allow_headers(Any)
            .allow_methods(Any));
    }
    let origins = values
        .iter()
        .map(|value| {
            let origin = HeaderValue::from_str(value)
                .map_err(|_| anyhow!("invalid CRONY_CORS_ORIGINS entry"))?;
            // tower-http rejects wildcard entries in an explicit origin list.
            if origin.as_bytes() == b"*" {
                return Err(anyhow!(
                    "CRONY_CORS_ORIGINS must not contain a wildcard in production"
                ));
            }
            Ok(origin)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([
            AUTHORIZATION,
            CONTENT_TYPE,
            HeaderName::from_static("x-crony-request-id"),
            HeaderName::from_static("x-crony-publication-publisher-credential"),
        ]);
    if !origins.is_empty() {
        cors = cors.allow_origin(origins).allow_credentials(true);
    }
    Ok(cors)
}
