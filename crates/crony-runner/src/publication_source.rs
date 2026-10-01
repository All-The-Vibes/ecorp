//! Bounded decoding and native Git reads shared by publication reconstruction.
use std::path::Path;

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use crony_protocol::VerificationArtifactReference;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{decode_verification_artifact, deliverable::verification::private_git};

pub(crate) struct PublishedSource<'a> {
    pub artifact: &'a VerificationArtifactReference,
    pub base_commit: &'a str,
    pub head_commit: &'a str,
    pub branch: &'a str,
    pub verification_sha256: &'a str,
    pub git_bundle_sha256: &'a str,
}

pub(crate) fn object_id(value: &str) -> Result<()> {
    if !matches!(value.len(), 40 | 64)
        || !value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        bail!("publication source requires a full lowercase immutable Git object ID");
    }
    Ok(())
}

pub(crate) fn source_bundle(source: PublishedSource<'_>) -> Result<(Vec<u8>, String)> {
    object_id(source.base_commit)?;
    object_id(source.head_commit)?;
    let bytes = decode_verification_artifact(source.artifact)?;
    let document: Value = serde_json::from_slice(&bytes).context("decode source deliverable")?;
    if document["schema_version"] != 1 || document["form"] != "commit_branch" {
        bail!("publication reconstruction requires a portable commit/branch source deliverable");
    }
    for (field, expected) in [
        ("base_commit", source.base_commit),
        ("head_commit", source.head_commit),
        ("branch", source.branch),
        ("verification_sha256", source.verification_sha256),
        ("git_bundle_sha256", source.git_bundle_sha256),
    ] {
        if document[field].as_str() != Some(expected) {
            bail!("source deliverable {field} does not match stored publication authority");
        }
    }
    let tree = document["verified_tree"]
        .as_str()
        .context("source omitted verified tree")?;
    object_id(tree)?;
    let bundle = BASE64
        .decode(
            document["git_bundle_base64"]
                .as_str()
                .context("source deliverable omitted portable bundle")?,
        )
        .context("decode source Git bundle")?;
    if bundle.is_empty() || hex::encode(Sha256::digest(&bundle)) != source.git_bundle_sha256 {
        bail!("source Git bundle digest mismatch");
    }
    Ok((bundle, tree.to_owned()))
}

pub(crate) async fn git(root: &Path, args: &[&str]) -> Result<String> {
    String::from_utf8(
        private_git(
            root,
            &args.iter().map(|arg| (*arg).into()).collect::<Vec<_>>(),
            &[],
        )
        .await?,
    )
    .context("native Git returned non-UTF-8 output")
    .map(|output| output.trim().to_owned())
}
