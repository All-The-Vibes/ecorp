use crate::SignedCheckpoint;
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::future::BoxFuture;
use reqwest::{
    Client, StatusCode,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
};
use serde_json::{Value, json};

pub trait PublicationTransport: Send + Sync {
    fn head(&self) -> BoxFuture<'_, Result<String>>;
    fn descends_from<'a>(&'a self, old: &'a str, new: &'a str) -> BoxFuture<'a, Result<bool>>;
    fn read<'a>(&'a self, path: &'a str, head: &'a str) -> BoxFuture<'a, Result<Option<Vec<u8>>>>;
    fn create<'a>(&'a self, path: &'a str, body: &'a [u8]) -> BoxFuture<'a, Result<()>>;
}

pub fn validate_destination(repository: &str, branch: &str, path: &str) -> Result<()> {
    let pieces = repository.split('/').collect::<Vec<_>>();
    ensure!(
        pieces.len() == 2 && pieces.iter().all(|s| component(s)),
        "GitHub repository must be owner/repository"
    );
    ensure!(
        component(branch),
        "audit branch must be a single safe ref component"
    );
    ensure!(
        !path.is_empty() && path.len() <= 512 && path.split('/').all(component),
        "unsafe audit destination path"
    );
    Ok(())
}
fn component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.starts_with('.')
        && !s.ends_with('.')
        && !s.ends_with(".lock")
        && !s.contains("..")
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

pub async fn publish_checkpoint<T: PublicationTransport>(
    transport: &T,
    root: &str,
    checkpoint: &SignedCheckpoint,
    previous_commit: Option<&str>,
) -> Result<String> {
    validate_destination("audit/validation", "audit", root)?;
    ensure!(root.len() <= 128, "audit root exceeds bound");
    checkpoint.validate_envelope()?;
    let stem = format!(
        "{root}/{}/{:020}-{}",
        checkpoint.checkpoint.ledger_id, checkpoint.checkpoint.last_sequence, checkpoint.digest
    );
    let files = [
        (
            format!(
                "{root}/{}/{:020}.checkpoint",
                checkpoint.checkpoint.ledger_id, checkpoint.checkpoint.last_sequence
            ),
            checkpoint.digest.as_bytes().to_vec(),
        ),
        (format!("{stem}.cbor"), checkpoint.payload.clone()),
        (format!("{stem}.ed25519"), checkpoint.signature.clone()),
        (format!("{stem}.json"), serde_json::to_vec(checkpoint)?),
    ];
    let initial = transport.head().await?;
    if let Some(old) = previous_commit {
        ensure!(
            transport.descends_from(old, &initial).await?,
            "GitHub history rewrite detected"
        );
    }
    for (path, body) in &files {
        let head = transport.head().await?;
        ensure!(
            transport.descends_from(&initial, &head).await?,
            "GitHub branch changed ancestry"
        );
        if let Some(existing) = transport.read(path, &head).await? {
            ensure!(
                existing == *body,
                "conflicting existing checkpoint; never overwrite"
            );
        } else {
            transport.create(path, body).await?;
        }
    }
    let final_head = transport.head().await?;
    ensure!(
        transport.descends_from(&initial, &final_head).await?,
        "GitHub branch changed ancestry"
    );
    for (path, body) in &files {
        ensure!(
            transport.read(path, &final_head).await?.as_ref() == Some(body),
            "incomplete remote checkpoint"
        );
    }
    Ok(final_head)
}

/// Fixed GitHub API origin, bounded reads, no redirects, no shell or ref updates.
pub struct GitHubTransport {
    client: Client,
    repository: String,
    branch: String,
}
impl GitHubTransport {
    pub fn new(repository: &str, branch: &str, token: &str) -> Result<Self> {
        validate_destination(repository, branch, "audit")?;
        ensure!(
            !token.trim().is_empty() && token.len() <= 4096,
            "invalid GitHub token length"
        );
        let mut headers = HeaderMap::new();
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", token.trim()))
            .context("invalid GitHub credential encoding")?;
        auth.set_sensitive(true);
        headers.insert(AUTHORIZATION, auth);
        headers.insert(
            "x-github-api-version",
            HeaderValue::from_static("2022-11-28"),
        );
        let client = Client::builder()
            .default_headers(headers)
            .user_agent("ECorp-State-Audit-V1")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .https_only(true)
            .build()?;
        Ok(Self {
            client,
            repository: repository.into(),
            branch: branch.into(),
        })
    }
    fn url(&self, suffix: &str) -> String {
        format!("https://api.github.com/repos/{}/{suffix}", self.repository)
    }
    async fn decode(mut response: reqwest::Response) -> Result<Value> {
        let status = response.status();
        ensure!(
            status.is_success(),
            "GitHub API returned HTTP {}",
            status.as_u16()
        );
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                body.len() + chunk.len() <= 2 * 1024 * 1024,
                "GitHub response exceeds bound"
            );
            body.extend_from_slice(&chunk);
        }
        Ok(serde_json::from_slice(&body)?)
    }
}
fn sha(value: &str) -> Result<()> {
    ensure!(
        value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid GitHub commit SHA"
    );
    Ok(())
}
impl PublicationTransport for GitHubTransport {
    fn head(&self) -> BoxFuture<'_, Result<String>> {
        Box::pin(async move {
            let value = Self::decode(
                self.client
                    .get(self.url(&format!("branches/{}", self.branch)))
                    .send()
                    .await?,
            )
            .await?;
            let hash = value["commit"]["sha"]
                .as_str()
                .context("missing branch commit")?;
            sha(hash)?;
            Ok(hash.into())
        })
    }
    fn descends_from<'a>(&'a self, old: &'a str, new: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async move {
            sha(old)?;
            sha(new)?;
            if old == new {
                return Ok(true);
            }
            let value = Self::decode(
                self.client
                    .get(self.url(&format!("compare/{old}...{new}")))
                    .query(&[("per_page", "1")])
                    .send()
                    .await?,
            )
            .await?;
            Ok(
                matches!(value["status"].as_str(), Some("ahead" | "identical"))
                    && value["merge_base_commit"]["sha"] == old,
            )
        })
    }
    fn read<'a>(&'a self, path: &'a str, head: &'a str) -> BoxFuture<'a, Result<Option<Vec<u8>>>> {
        Box::pin(async move {
            validate_destination(&self.repository, &self.branch, path)?;
            sha(head)?;
            let response = self
                .client
                .get(self.url(&format!("contents/{path}")))
                .query(&[("ref", head)])
                .send()
                .await?;
            if response.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            let value = Self::decode(response).await?;
            ensure!(
                value["type"] == "file" && value["encoding"] == "base64" && value["path"] == path,
                "GitHub returned unexpected content type/path"
            );
            let content = value["content"]
                .as_str()
                .context("missing GitHub content")?
                .replace('\n', "");
            let bytes = STANDARD.decode(content)?;
            ensure!(
                bytes.len() <= 262144,
                "GitHub file exceeds checkpoint bound"
            );
            Ok(Some(bytes))
        })
    }
    fn create<'a>(&'a self, path: &'a str, body: &'a [u8]) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            validate_destination(&self.repository, &self.branch, path)?;
            ensure!(body.len() <= 262144, "GitHub checkpoint file exceeds bound");
            // Deliberately omit SHA: the Contents API must refuse existing paths.
            let response=self.client.put(self.url(&format!("contents/{path}"))).json(&json!({
            "message":"Add immutable ECorp audit checkpoint","branch":self.branch,"content":STANDARD.encode(body)
        })).send().await?;
            ensure!(
                response.status() == StatusCode::CREATED,
                "GitHub additive create refused (HTTP {})",
                response.status().as_u16()
            );
            Self::decode(response).await?;
            Ok(())
        })
    }
}
