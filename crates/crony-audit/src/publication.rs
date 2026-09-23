use crate::{Archive, MAX_ARCHIVE_BYTES, MAX_RECORD_BYTES, SignedCheckpoint, TrustedSigningKey};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::future::BoxFuture;
use reqwest::{
    Client, StatusCode,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// An ordered raw-byte slice, not necessarily a standalone JSON document.
/// Hashes are lowercase hexadecimal; SHA-1 includes Git's `blob <len>\0` header.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArchivePublicationPart {
    pub path: String,
    pub byte_count: u64,
    pub sha256: String,
    pub git_blob_sha1: String,
}

/// Concatenating parts in order reproduces `serde_json::to_vec(Archive)` exactly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArchivePublicationIndex {
    pub schema_version: u32,
    pub ledger_id: String,
    pub checkpoint_digest: String,
    pub byte_count: u64,
    pub sha256: String,
    pub parts: Vec<ArchivePublicationPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PublishedArchive {
    pub commit: String,
    pub index_path: String,
    pub index_git_blob_sha1: String,
    pub index_sha256: String,
    pub archive: ArchivePublicationIndex,
}

impl PublishedArchive {
    /// Check the complete native readback witness without contacting the remote.
    /// Publication must read every byte at this commit before saving the witness.
    pub fn validate_for_checkpoint(&self, root: &str, checkpoint: &SignedCheckpoint) -> Result<()> {
        let (stem, _) = checkpoint_files(root, checkpoint)?;
        let archive = &self.archive;
        ensure!(
            archive.schema_version == 1
                && archive.ledger_id == checkpoint.checkpoint.ledger_id
                && archive.checkpoint_digest == checkpoint.digest
                && (1..=MAX_ARCHIVE_BYTES).contains(&archive.byte_count)
                && (1..=128).contains(&archive.parts.len())
                && self.index_path == format!("{stem}/archive.json")
                && !self.commit.is_empty()
                && self.commit.len() <= 256
                && self.commit.bytes().all(|b| b.is_ascii_graphic()),
            "incomplete or mismatched native archive witness"
        );
        let hex_digest = |value: &str, length: usize| {
            value.len() == length
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        ensure!(hex_digest(&archive.sha256, 64), "invalid archive digest");
        let mut byte_count = 0u64;
        for (number, part) in archive.parts.iter().enumerate() {
            ensure!(
                part.path == format!("{stem}/archive-{number:05}.json")
                    && (1..=MAX_RECORD_BYTES as u64).contains(&part.byte_count)
                    && (number + 1 == archive.parts.len()
                        || part.byte_count == MAX_RECORD_BYTES as u64)
                    && hex_digest(&part.sha256, 64)
                    && hex_digest(&part.git_blob_sha1, 40),
                "incomplete native archive part witness"
            );
            byte_count += part.byte_count;
        }
        let index_bytes = serde_json::to_vec(archive)?;
        ensure!(
            byte_count == archive.byte_count
                && self.index_git_blob_sha1 == git_blob_sha1(&index_bytes)
                && self.index_sha256 == hex::encode(Sha256::digest(&index_bytes)),
            "native archive index witness mismatch"
        );
        Ok(())
    }
}

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
    let (_, files) = checkpoint_files(root, checkpoint)?;
    publish_files(transport, &files, previous_commit).await
}

/// Publishes complete native history without changing the V1 checkpoint files.
/// `trusted_keys` must come from independent authoritative history, not from an
/// untrusted archive. A receipt proves exact readback at one immutable commit,
/// not retention, latest-head status, or independent chain inclusion/finality.
/// A legacy keyless export requires one independently supplied historical key.
pub async fn publish_checkpoint_archive<T: PublicationTransport>(
    transport: &T,
    root: &str,
    checkpoint: &SignedCheckpoint,
    archive: &Archive,
    trusted_keys: &[TrustedSigningKey],
    previous_commit: Option<&str>,
) -> Result<PublishedArchive> {
    let (stem, mut files) = checkpoint_files(root, checkpoint)?;
    ensure!(
        archive.ledger_id == checkpoint.checkpoint.ledger_id
            && archive.checkpoints.last() == Some(checkpoint),
        "archive does not end at the exact checkpoint"
    );
    if archive.signing_keys.is_empty() {
        ensure!(
            trusted_keys.len() == 1,
            "legacy archive requires one trusted key"
        );
        let trusted = &trusted_keys[0];
        ensure!(
            archive.checkpoints.iter().all(|checkpoint| {
                checkpoint.checkpoint.key_id == trusted.key_id
                    && checkpoint.checkpoint.last_sequence >= trusted.activated_sequence
                    && trusted
                        .retired_sequence
                        .is_none_or(|end| checkpoint.checkpoint.last_sequence <= end)
            }),
            "legacy checkpoint lies outside trusted key history"
        );
        archive.verify(&trusted.verifying_key()?, Some(&checkpoint.digest))?;
    } else {
        archive.verify_with_key_history(trusted_keys, Some(&checkpoint.digest))?;
    }
    let bytes = serde_json::to_vec(archive)?;
    ensure!(
        bytes.len() as u64 <= MAX_ARCHIVE_BYTES,
        "archive exceeds publication bound"
    );
    let mut parts = Vec::new();
    for (number, body) in bytes.chunks(MAX_RECORD_BYTES).enumerate() {
        let path = format!("{stem}/archive-{number:05}.json");
        parts.push(ArchivePublicationPart {
            path: path.clone(),
            byte_count: body.len() as u64,
            sha256: hex::encode(Sha256::digest(body)),
            git_blob_sha1: git_blob_sha1(body),
        });
        files.push((path, body.to_vec()));
    }
    ensure!(
        !parts.is_empty() && parts.len() <= 128,
        "archive part count exceeds bound"
    );
    let index = ArchivePublicationIndex {
        schema_version: 1,
        ledger_id: archive.ledger_id.clone(),
        checkpoint_digest: checkpoint.digest.clone(),
        byte_count: bytes.len() as u64,
        sha256: hex::encode(Sha256::digest(&bytes)),
        parts,
    };
    let index_path = format!("{stem}/archive.json");
    let index_bytes = serde_json::to_vec(&index)?;
    let index_git_blob_sha1 = git_blob_sha1(&index_bytes);
    let index_sha256 = hex::encode(Sha256::digest(&index_bytes));
    files.push((index_path.clone(), index_bytes));
    let commit = publish_files(transport, &files, previous_commit).await?;
    let publication = PublishedArchive {
        commit,
        index_path,
        index_git_blob_sha1,
        index_sha256,
        archive: index,
    };
    publication.validate_for_checkpoint(root, checkpoint)?;
    Ok(publication)
}

fn git_blob_sha1(body: &[u8]) -> String {
    use sha1::Digest as _;

    let mut digest = sha1::Sha1::new();
    digest.update(format!("blob {}\0", body.len()));
    digest.update(body);
    hex::encode(digest.finalize())
}

type PublicationFiles = Vec<(String, Vec<u8>)>;

fn checkpoint_files(
    root: &str,
    checkpoint: &SignedCheckpoint,
) -> Result<(String, PublicationFiles)> {
    validate_destination("audit/validation", "audit", root)?;
    ensure!(root.len() <= 128, "audit root exceeds bound");
    checkpoint.validate_envelope()?;
    let stem = format!(
        "{root}/{}/{:020}-{}",
        checkpoint.checkpoint.ledger_id, checkpoint.checkpoint.last_sequence, checkpoint.digest
    );
    let files = vec![
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
    Ok((stem, files))
}

async fn publish_files<T: PublicationTransport>(
    transport: &T,
    files: &[(String, Vec<u8>)],
    previous_commit: Option<&str>,
) -> Result<String> {
    // Validate the entire set before any remote effect, including transports
    // that do not enforce GitHub's own per-file and safe-path constraints.
    for (path, body) in files {
        validate_destination("audit/validation", "audit", path)?;
        ensure!(
            body.len() <= MAX_RECORD_BYTES,
            "publication file exceeds bound"
        );
    }
    let initial = transport.head().await?;
    if let Some(old) = previous_commit {
        ensure!(
            transport.descends_from(old, &initial).await?,
            "GitHub history rewrite detected"
        );
    }
    for (path, body) in files {
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
    for (path, body) in files {
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
    origin: String,
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
            origin: "https://api.github.com".into(),
        })
    }
    /// Exercises the same publication protocol against an exact local fixture.
    #[cfg(all(feature = "test-support", debug_assertions))]
    pub fn new_test_loopback(
        repository: &str,
        branch: &str,
        address: std::net::SocketAddr,
    ) -> Result<Self> {
        validate_destination(repository, branch, "audit")?;
        ensure!(
            address.ip().is_loopback() && address.port() != 0,
            "GitHub fixture must use exact nonzero loopback"
        );
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(15))
                .build()?,
            repository: repository.into(),
            branch: branch.into(),
            origin: format!("http://{address}"),
        })
    }
    fn url(&self, suffix: &str) -> String {
        format!("{}/repos/{}/{suffix}", self.origin, self.repository)
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
            ensure!(
                value["sha"].as_str() == Some(git_blob_sha1(&bytes).as_str()),
                "GitHub blob identity disagrees with returned bytes"
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

#[cfg(test)]
mod transport_tests {
    use super::*;

    #[test]
    fn production_transport_retains_fixed_origin() {
        let transport = GitHubTransport::new("audit/validation", "audit", "inert-test-fixture")
            .expect("valid non-network constructor");
        assert_eq!(
            transport.url("branches/audit"),
            "https://api.github.com/repos/audit/validation/branches/audit"
        );
    }

    #[cfg(all(feature = "test-support", debug_assertions))]
    #[test]
    fn fixture_transport_requires_exact_nonzero_loopback() {
        for address in ["0.0.0.0:18548", "192.0.2.1:18548", "127.0.0.1:0"] {
            assert!(
                GitHubTransport::new_test_loopback(
                    "audit/validation",
                    "audit",
                    address.parse().unwrap()
                )
                .is_err()
            );
        }
        let transport = GitHubTransport::new_test_loopback(
            "audit/validation",
            "audit",
            "127.0.0.1:18548".parse().unwrap(),
        )
        .unwrap();
        assert_eq!(
            transport.url("branches/audit"),
            "http://127.0.0.1:18548/repos/audit/validation/branches/audit"
        );
    }
}
