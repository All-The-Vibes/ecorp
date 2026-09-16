//! Isolated customer signing gateway host.
#[cfg(test)]
mod tests;
use crony_base::{
    Address, B256,
    fees::SpendingPolicy,
    gateway::{GatewayAccess, router},
    kms::AwsKmsSigner,
    manifest::{ManifestTrust, SignedManifest, TrustPin},
    signing::{PolicyGateway, PostgresSigningJournal, SigningJournal},
};
use serde::{Deserialize, de::DeserializeOwned};
use sqlx::postgres::PgPoolOptions;
use std::{
    collections::BTreeSet,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::AsyncReadExt;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct HostError(&'static str);
pub type Result<T> = std::result::Result<T, HostError>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayConfig {
    pub listen: SocketAddr,
    pub tls_ingress_confirmed: bool,
    pub allowed_corps: BTreeSet<Uuid>,
    pub manifest_chain_file: PathBuf,
    pub trust_pin_file: PathBuf,
    pub accepted_manifest_version: u64,
    pub accepted_manifest_digest: B256,
    pub spending_policy: SpendingPolicy,
    pub app_database_secret_file: PathBuf,
    pub journal_database_secret_file: PathBuf,
    pub workload_token_file: PathBuf,
    pub aws_region: String,
    pub kms_key_arn: String,
    pub publisher: Address,
}

impl GatewayConfig {
    pub fn validate(&self) -> Result<()> {
        if !self.listen.ip().is_loopback() || self.listen.port() == 0 || !self.tls_ingress_confirmed
        {
            return Err(HostError(
                "gateway requires explicit loopback listener behind authenticated TLS ingress",
            ));
        }
        if self.allowed_corps.is_empty()
            || self.allowed_corps.len() > 128
            || self.allowed_corps.contains(&Uuid::nil())
            || self.accepted_manifest_version == 0
            || self.accepted_manifest_digest.is_zero()
            || self.publisher.is_zero()
        {
            return Err(HostError(
                "gateway Corp, manifest rollback pin, and publisher must be explicit",
            ));
        }
        let region_parts: Vec<_> = self.aws_region.split('-').collect();
        if region_parts.len() != 3
            || !matches!(
                region_parts[0],
                "us" | "eu" | "ap" | "sa" | "ca" | "me" | "af" | "il" | "mx"
            )
            || region_parts[1].is_empty()
            || !region_parts[1].bytes().all(|b| b.is_ascii_lowercase())
            || region_parts[2].len() != 1
            || !region_parts[2].bytes().all(|b| b.is_ascii_digit())
        {
            return Err(HostError(
                "explicit supported commercial AWS region required",
            ));
        }
        let arn: Vec<_> = self.kms_key_arn.split(':').collect();
        if arn.len() != 6
            || arn[0] != "arn"
            || arn[1] != "aws"
            || arn[2] != "kms"
            || arn[3] != self.aws_region
            || arn[4].len() != 12
            || !arn[4].bytes().all(|b| b.is_ascii_digit())
            || !arn[5].starts_with("key/")
            || Uuid::parse_str(arn[5].strip_prefix("key/").unwrap_or("")).is_err()
        {
            return Err(HostError(
                "immutable KMS key ARN in configured region required",
            ));
        }
        for path in [
            &self.manifest_chain_file,
            &self.trust_pin_file,
            &self.app_database_secret_file,
            &self.journal_database_secret_file,
            &self.workload_token_file,
        ] {
            if path.as_os_str().is_empty() {
                return Err(HostError("configuration file path missing"));
            }
        }
        if self.manifest_chain_file == self.trust_pin_file
            || self.app_database_secret_file == self.journal_database_secret_file
        {
            return Err(HostError(
                "independent trust and database credential files required",
            ));
        }
        self.spending_policy
            .validate()
            .map_err(|_| HostError("invalid gateway spending policy"))?;
        Ok(())
    }
}

fn database_identity(value: &str) -> Result<(String, String)> {
    let url =
        url::Url::parse(value).map_err(|_| HostError("invalid database credential document"))?;
    let host = url
        .host_str()
        .ok_or(HostError("database host missing"))?
        .trim_end_matches('.');
    if !matches!(url.scheme(), "postgres" | "postgresql")
        || url.username().is_empty()
        || !url
            .username()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        || url.path().len() < 2
        || host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.parse::<std::net::IpAddr>().is_ok()
        || url.fragment().is_some()
        || url
            .query_pairs()
            .filter(|(k, _)| k == "sslmode")
            .map(|(_, v)| v.to_string())
            .collect::<Vec<_>>()
            != ["verify-full"]
        || url
            .query_pairs()
            .any(|(k, _)| matches!(k.as_ref(), "host" | "hostaddr" | "user" | "dbname" | "port"))
    {
        return Err(HostError(
            "database requires named external host, explicit role/database and verified TLS",
        ));
    }
    Ok((host.to_ascii_lowercase(), url.username().to_string()))
}

pub fn validate_database_pair(app: &str, journal: &str) -> Result<()> {
    let (app_host, app_user) = database_identity(app)?;
    let (journal_host, journal_user) = database_identity(journal)?;
    if app_host == journal_host || app_user == journal_user {
        return Err(HostError(
            "intent database and journal require distinct external hosts and roles",
        ));
    }
    Ok(())
}

async fn bounded_file(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| HostError("required configuration or credential file unavailable"))?;
    if !file
        .metadata()
        .await
        .map_err(|_| HostError("file metadata unavailable"))?
        .is_file()
    {
        return Err(HostError(
            "configuration and credential inputs must be regular files",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| HostError("configuration or credential file read failed"))?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err(HostError("configuration or credential file exceeds bounds"));
    }
    Ok(bytes)
}

async fn json_file<T: DeserializeOwned>(path: &Path, limit: u64) -> Result<T> {
    crony_audit::parse_json(&bounded_file(path, limit).await?)
        .map_err(|_| HostError("invalid or duplicate configuration JSON fields"))
}

async fn secret_file(path: &Path) -> Result<String> {
    let bytes = bounded_file(path, 16 * 1024).await?;
    let value = String::from_utf8(bytes).map_err(|_| HostError("credential file must be UTF-8"))?;
    let value = value.trim_end_matches(['\r', '\n']);
    if value.is_empty() || value.contains(['\r', '\n', '\0']) {
        return Err(HostError("credential file must contain one nonempty line"));
    }
    Ok(value.to_string())
}

pub async fn load_configuration(path: &Path) -> Result<(GatewayConfig, ManifestTrust)> {
    let mut config: GatewayConfig = json_file(path, 128 * 1024).await?;
    config.validate()?;
    let directory = path.parent().unwrap_or(Path::new("."));
    for file in [
        &mut config.manifest_chain_file,
        &mut config.trust_pin_file,
        &mut config.app_database_secret_file,
        &mut config.journal_database_secret_file,
        &mut config.workload_token_file,
    ] {
        if file.is_relative() {
            *file = directory.join(&*file);
        }
    }
    let pin: TrustPin = json_file(&config.trust_pin_file, 16 * 1024).await?;
    let chain: Vec<SignedManifest> =
        json_file(&config.manifest_chain_file, 4 * 1024 * 1024).await?;
    if chain.is_empty() || chain.len() > 256 {
        return Err(HostError("manifest chain count outside bounds"));
    }
    let mut trust = ManifestTrust::bootstrap(&pin, &chain[0])
        .map_err(|_| HostError("manifest trust bootstrap rejected"))?;
    for next in &chain[1..] {
        trust
            .advance(next)
            .map_err(|_| HostError("manifest trust advancement rejected"))?;
    }
    trust
        .require_current(
            config.accepted_manifest_version,
            config.accepted_manifest_digest,
        )
        .map_err(|_| HostError("manifest rollback pin mismatch"))?;
    if trust.current().manifest.assurance_policy
        != crony_base::config::Assurance::ProviderObservedFinalized
    {
        return Err(HostError(
            "requested assurance tier is not qualified; no fallback",
        ));
    }
    Ok((config, trust))
}

fn connection_url(value: &str, readonly: bool) -> Result<String> {
    let mut url =
        url::Url::parse(value).map_err(|_| HostError("invalid database credential document"))?;
    let pairs: Vec<_> = url
        .query_pairs()
        .filter(|(k, _)| k != "options")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.set_query(None);
    let options = if readonly {
        "-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=5000"
    } else {
        "-c synchronous_commit=on -c statement_timeout=15000 -c lock_timeout=5000"
    };
    url.query_pairs_mut()
        .extend_pairs(pairs)
        .append_pair("options", options);
    Ok(url.to_string())
}

async fn qualify_role(pool: &sqlx::PgPool, readonly: bool) -> Result<()> {
    let privileged: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AND pg_has_role(current_user, oid, 'MEMBER'))")
        .fetch_one(pool).await.map_err(|_| HostError("database role qualification unavailable"))?;
    let ddl: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' AND (has_schema_privilege(current_user, oid, 'CREATE') OR pg_has_role(current_user,nspowner,'MEMBER'))) OR EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role(current_user,datdba,'MEMBER'))")
        .fetch_one(pool).await.map_err(|_| HostError("database DDL qualification unavailable"))?;
    let unsafe_tables: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND (pg_has_role(current_user,c.relowner,'MEMBER') OR has_table_privilege(current_user,c.oid,$1)))")
        .bind(if readonly { "INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER" } else { "UPDATE,DELETE,TRUNCATE,TRIGGER" })
        .fetch_one(pool).await.map_err(|_| HostError("database table privilege qualification unavailable"))?;
    if privileged || ddl || unsafe_tables {
        return Err(HostError(
            "database runtime role has forbidden write, ownership, or administrative privileges",
        ));
    }
    if readonly {
        let setting: String = sqlx::query_scalar("SHOW default_transaction_read_only")
            .fetch_one(pool)
            .await
            .map_err(|_| HostError("intent database read-only qualification unavailable"))?;
        if setting != "on" {
            return Err(HostError(
                "intent connection must default to read-only transactions",
            ));
        }
    }
    Ok(())
}

/// No migration, deployment, funding, chain broadcast, or raw-key signing path.
pub async fn serve(config: GatewayConfig, trust: ManifestTrust) -> Result<()> {
    config.validate()?;
    if trust.current().manifest.assurance_policy
        != crony_base::config::Assurance::ProviderObservedFinalized
    {
        return Err(HostError(
            "requested assurance tier is not qualified; no fallback",
        ));
    }
    trust
        .require_current(
            config.accepted_manifest_version,
            config.accepted_manifest_digest,
        )
        .map_err(|_| HostError("manifest rollback pin mismatch"))?;
    let app_secret = secret_file(&config.app_database_secret_file).await?;
    let journal_secret = secret_file(&config.journal_database_secret_file).await?;
    validate_database_pair(&app_secret, &journal_secret)?;
    let token = secret_file(&config.workload_token_file).await?;
    let access = GatewayAccess::new(token.as_bytes(), config.allowed_corps.clone())
        .map_err(|_| HostError("workload credential or Corp scope invalid"))?;
    let authorizer = tokio::time::timeout(
        Duration::from_secs(30),
        crony_store::PgStore::connect(&connection_url(&app_secret, true)?),
    )
    .await
    .map_err(|_| HostError("intent database connection timed out"))?
    .map_err(|_| HostError("intent database connection failed"))?;
    qualify_role(authorizer.pool(), true).await?;
    let journal_pool = PgPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(15))
        .connect(&connection_url(&journal_secret, false)?)
        .await
        .map_err(|_| HostError("independent journal connection failed"))?;
    qualify_role(&journal_pool, false).await?;
    let chain_id = trust.current().manifest.chain_id;
    let journal = PostgresSigningJournal::new(journal_pool);
    let snapshot = journal
        .snapshot(chain_id, config.publisher)
        .await
        .map_err(|_| HostError("independent journal startup snapshot unavailable"))?;
    if !snapshot.complete
        || snapshot
            .requests
            .iter()
            .any(|request| !config.allowed_corps.contains(&request.corp_id))
    {
        return Err(HostError(
            "journal snapshot incomplete or outside configured Corp scope",
        ));
    }
    let shared = tokio::time::timeout(
        Duration::from_secs(30),
        aws_config::defaults(aws_config::BehaviorVersion::v2025_01_17())
            .region(aws_sdk_kms::config::Region::new(config.aws_region.clone()))
            .load(),
    )
    .await
    .map_err(|_| HostError("AWS workload identity initialization timed out"))?;
    let kms_config = aws_sdk_kms::config::Builder::from(&shared)
        .endpoint_url(format!("https://kms.{}.amazonaws.com", config.aws_region))
        .build();
    let signer = AwsKmsSigner::connect(
        aws_sdk_kms::Client::from_conf(kms_config),
        config.kms_key_arn,
        chain_id,
        config.publisher,
    )
    .await
    .map_err(|_| HostError("AWS KMS immutable signing identity qualification failed"))?;
    let gateway = PolicyGateway::new(journal, authorizer, signer, trust, config.spending_policy)
        .map_err(|_| HostError("gateway policy qualification failed"))?;
    let app = router(Arc::new(gateway), access);
    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .map_err(|_| HostError("private gateway listener unavailable"))?;
    println!("Base signing gateway ready behind configured TLS ingress");
    axum::serve(listener, app)
        .await
        .map_err(|_| HostError("gateway listener failed"))
}
