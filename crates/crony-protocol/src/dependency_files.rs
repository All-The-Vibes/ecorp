use crony_domain::repository_relative_path_is_valid;
use serde::{Deserialize, Serialize};

pub const DEPENDENCY_FILES_CAPABILITY: &str = "verified-dependency-files-v1";
pub const MAX_DEPENDENCY_FILES: usize = 8;
pub const MAX_DEPENDENCY_FILE_BYTES: usize = 12 * 1024;
pub const MAX_DEPENDENCY_BYTES: usize = 64 * 1024;

/// Exact text selected from signed, verified parent artifacts by the control plane.
/// This is assignment data, never a provider-generated instruction or path grant.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VerifiedDependencyFile {
    pub path: String,
    pub sha256: String,
    pub content: String,
}

pub fn dependency_path_is_safe(path: &str) -> bool {
    if !repository_relative_path_is_valid(path)
        || !path.is_ascii()
        || path.bytes().any(|byte| {
            matches!(
                byte,
                b'*' | b'?' | b'[' | b']' | b'<' | b'>' | b'"' | b'|' | b'~' | b'%'
            )
        })
    {
        return false;
    }
    path.split('/').all(|component| {
        if component.starts_with('.') || component.ends_with('.') || component.trim() != component {
            return false;
        }
        let lower = component.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or_default();
        let device = matches!(stem, "con" | "prn" | "aux" | "nul" | "conin$" | "conout$")
            || (stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && stem.as_bytes()[3].is_ascii_digit());
        let secret = matches!(
            lower.as_str(),
            "_netrc"
                | "npmrc"
                | "terraform.rc"
                | "kubeconfig"
                | "accesstokens.json"
                | "application_default_credentials.json"
        ) || [
            "credentials",
            "secrets",
            "id_rsa",
            "id_dsa",
            "id_ecdsa",
            "id_ed25519",
        ]
        .iter()
        .any(|name| {
            lower == *name
                || lower
                    .strip_prefix(*name)
                    .is_some_and(|rest| rest.starts_with('.'))
        }) || [
            ".pem",
            ".key",
            ".p12",
            ".pfx",
            ".p8",
            ".ppk",
            ".jks",
            ".keystore",
        ]
        .iter()
        .any(|suffix| lower.ends_with(*suffix));
        !device && !secret
    })
}
