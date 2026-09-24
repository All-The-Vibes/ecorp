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
    delegated::Broker,
    secrets::SecretCipher,
    state_audit,
};

pub struct PreparedStartup {
    pub auth: AuthService,
    pub secret_cipher: SecretCipher,
    pub artifacts: PreparedArtifactStore,
    pub cors: CorsLayer,
    pub audit: Option<std::sync::Arc<state_audit::Service>>,
    pub delegated: Option<std::sync::Arc<Broker>>,
}

impl PreparedStartup {
    pub async fn prepare(args: &Args) -> Result<Self> {
        let cors = prepare_cors(args.mode, &args.cors_origins)?;
        let secret_cipher =
            SecretCipher::initialize(args.mode, args.secret_master_key_hex.as_deref())?;
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
        let audit = state_audit::Service::from_environment().map_err(|_| {
            anyhow!("invalid state audit configuration: check CRONY_STATE_AUDIT settings")
        })?;
        // Drop the underlying error chain: discovery errors may include URLs,
        // credentials, or response values. Keep #270's discovery behavior intact.
        let auth = AuthService::initialize(args.mode, args.oidc_issuer.clone(), args.allow_insecure_oidc)
            .await.map_err(|_| anyhow!("invalid OIDC configuration or discovery: check CRONY_OIDC_ISSUER and issuer metadata"))?;
        let delegated = Broker::from_env(args.mode)
            .await
            .map_err(|_| anyhow!("invalid delegated configuration or provider discovery"))?;
        Ok(Self {
            auth,
            secret_cipher,
            artifacts,
            cors,
            audit,
            delegated,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn production_args(key: Option<&str>) -> Args {
        Args {
            database_url: "postgres://unused@127.0.0.1:1/unused".into(),
            bind: "127.0.0.1:0".parse().unwrap(),
            runner_grace_secs: 5,
            runner_startup_recovery: false,
            mode: ServerMode::Production,
            oidc_issuer: None,
            allow_insecure_oidc: false,
            cors_origins: vec![],
            runner_credential_ttl_secs: 60,
            publication_publisher_credential_ttl_secs: 60,
            secret_master_key_hex: key.map(str::to_owned),
            object_store_backend: "invalid-next-preparation-stage".into(),
            object_store_local_root: "unused".into(),
            object_store_endpoint: None,
            object_store_bucket: None,
            object_store_region: "us-east-1".into(),
            object_store_access_key: None,
            object_store_secret_key: None,
            object_store_allow_http: false,
            artifact_signing_key_hex: None,
            artifact_max_bytes: 1024,
            artifact_retention_days: 1,
            artifact_recovery_grace_secs: 0,
            artifact_recovery_interval_secs: 60,
        }
    }

    async fn diagnostic(key: Option<&str>) -> String {
        let error = PreparedStartup::prepare(&production_args(key))
            .await
            .err()
            .expect("fixture must stop before storage or OIDC activation");
        assert_eq!(
            error.chain().count(),
            1,
            "no decoder or input-bearing cause"
        );
        let message = format!("{error:#}");
        assert!(message.len() < 128);
        if let Some(value) = key.filter(|value| !value.trim().is_empty()) {
            assert!(
                !message
                    .to_ascii_lowercase()
                    .contains(&value.trim().to_ascii_lowercase())
            );
        }
        message
    }

    #[tokio::test]
    async fn production_development_key_diagnostic_keeps_the_safe_rejection_reason() {
        let public_fixture = "a5c3f1458279dfb241239378dbefa6b8d2ab32703cba1768343712fd37ac1f04";
        for configured in [
            public_fixture.to_owned(),
            public_fixture.to_ascii_uppercase(),
            format!("\u{00a0}{}\u{2003}", public_fixture.to_ascii_uppercase()),
        ] {
            assert_eq!(
                diagnostic(Some(&configured)).await,
                "CRONY_SECRET_MASTER_KEY_HEX must use a deployment-specific key in production mode"
            );
        }
    }

    #[tokio::test]
    async fn production_missing_and_malformed_key_diagnostics_are_bounded_and_secret_safe() {
        for configured in [None, Some(""), Some(" \t\r\n")] {
            assert_eq!(
                diagnostic(configured).await,
                "CRONY_SECRET_MASTER_KEY_HEX is required in production mode"
            );
        }
        for configured in [
            "DO_NOT_DISCLOSE_MASTER_KEY".to_owned(),
            "ab".repeat(31),
            "ab".repeat(33),
        ] {
            assert_eq!(
                diagnostic(Some(&configured)).await,
                "invalid CRONY_SECRET_MASTER_KEY_HEX: expected a 32-byte hexadecimal key"
            );
        }
    }

    #[tokio::test]
    async fn production_deployment_key_advances_to_the_next_preparation_stage() {
        assert_eq!(
            diagnostic(Some(&format!(" \t{}\r\n", "5A".repeat(32)))).await,
            "CRONY_ARTIFACT_SIGNING_KEY_HEX is required"
        );
    }
}
