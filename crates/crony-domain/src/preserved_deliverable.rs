//! Runner evidence for the complete retained source delta, not permission to resume it.
//! Consumers bind this proof to the latest authenticated preservation event and
//! recheck the native worktree and index before starting a provider.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DeliverableSpec, repository_relative_path_is_valid, write_scope_allows_path};

pub const PRESERVED_DELIVERABLE_CAPABILITY: &str = "preserved-deliverable-checkpoint-v1";
pub const MAX_PRESERVED_DELIVERABLE_PATHS: usize = 10_000;
pub const MAX_PRESERVED_PROVIDER_ARTIFACTS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreservedProviderArtifact {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreservedDeliverableCheckpoint {
    pub schema_version: u32,
    pub run_id: Uuid,
    pub workspace_run_id: Uuid,
    pub workspace_base_commit: String,
    pub head_commit: String,
    pub workspace_fingerprint: String,
    /// Semantic native index entries, including staged-only blobs and modes.
    pub index_sha256: String,
    pub deliverable: Option<DeliverableSpec>,
    /// Sorted complete union of physical and native index changes against base.
    /// Provider artifacts remain in this inventory; exclusions are separate.
    pub changed_paths: Vec<String>,
    pub provider_artifacts: Vec<PreservedProviderArtifact>,
}

fn hex_digest(value: &str, lengths: &[usize]) -> bool {
    lengths.contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Native deliverable paths are literal relative files or directory prefixes.
pub fn deliverable_selects_path(spec: &DeliverableSpec, path: &str) -> bool {
    spec.paths.is_empty()
        || spec.paths.iter().any(|selected| {
            path == selected
                || path
                    .strip_prefix(selected)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
}

impl PreservedProviderArtifact {
    pub fn is_valid(&self) -> bool {
        repository_relative_path_is_valid(&self.path)
            && hex_digest(&self.sha256, &[64])
            && self.bytes <= 16_777_216
            && !self.media_type.is_empty()
            && self.media_type.len() <= 256
    }
}

impl PreservedDeliverableCheckpoint {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && !self.run_id.is_nil()
            && !self.workspace_run_id.is_nil()
            && hex_digest(&self.workspace_base_commit, &[40, 64])
            && hex_digest(&self.head_commit, &[40, 64])
            && hex_digest(&self.workspace_fingerprint, &[64])
            && hex_digest(&self.index_sha256, &[64])
            && self.changed_paths.len() <= MAX_PRESERVED_DELIVERABLE_PATHS
            && self
                .changed_paths
                .iter()
                .all(|path| repository_relative_path_is_valid(path))
            && self
                .changed_paths
                .windows(2)
                .all(|paths| paths[0] < paths[1])
            && self.deliverable.as_ref().is_none_or(|spec| {
                spec.paths
                    .iter()
                    .all(|path| repository_relative_path_is_valid(path))
            })
            && self.provider_artifacts.len() <= MAX_PRESERVED_PROVIDER_ARTIFACTS
            && self
                .provider_artifacts
                .iter()
                .all(PreservedProviderArtifact::is_valid)
            && self
                .provider_artifacts
                .windows(2)
                .all(|artifacts| artifacts[0].path < artifacts[1].path)
    }

    /// Call only after validating and binding the checkpoint and its exclusions.
    pub fn excluded_deliverable_path(&self, write_scope: &[String]) -> Option<&str> {
        let spec = self.deliverable.as_ref()?;
        self.changed_paths.iter().find_map(|path| {
            (deliverable_selects_path(spec, path)
                && !self
                    .provider_artifacts
                    .iter()
                    .any(|artifact| artifact.path == *path)
                && !write_scope
                    .iter()
                    .any(|scope| write_scope_allows_path(scope, path)))
            .then_some(path.as_str())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DeliverableForm;

    fn proof() -> PreservedDeliverableCheckpoint {
        PreservedDeliverableCheckpoint {
            schema_version: 1,
            run_id: Uuid::new_v4(),
            workspace_run_id: Uuid::new_v4(),
            workspace_base_commit: "a".repeat(40),
            head_commit: "b".repeat(40),
            workspace_fingerprint: "c".repeat(64),
            index_sha256: "d".repeat(64),
            deliverable: Some(DeliverableSpec {
                form: DeliverableForm::CommitBranch,
                commit_after_verification: true,
                paths: vec!["scenario".to_owned()],
            }),
            changed_paths: vec![
                "provider.md".to_owned(),
                "scenario/.gitignore".to_owned(),
                "scenario/EVIDENCE.md".to_owned(),
                "scenario/staged-only.js".to_owned(),
                "unselected/private.txt".to_owned(),
            ],
            provider_artifacts: Vec::new(),
        }
    }

    #[test]
    fn correction_scope_must_keep_full_selected_parent_delta() {
        let mut proof = proof();
        assert!(proof.is_valid());
        assert_eq!(
            proof.excluded_deliverable_path(&["scenario/EVIDENCE.md".to_owned()]),
            Some("scenario/.gitignore")
        );
        assert_eq!(
            proof.excluded_deliverable_path(&["scenario/**".to_owned()]),
            None
        );
        // A literal file is never authority for its apparent child subtree.
        proof.deliverable.as_mut().unwrap().paths = vec!["scenario/staged-only.js".to_owned()];
        assert_eq!(
            proof.excluded_deliverable_path(&["scenario/EVIDENCE.md".to_owned()]),
            Some("scenario/staged-only.js")
        );
    }

    #[test]
    fn exclusions_are_exact_and_cannot_exclude_a_subtree() {
        let mut proof = proof();
        proof.deliverable.as_mut().unwrap().paths.clear();
        proof.provider_artifacts.push(PreservedProviderArtifact {
            path: "provider.md".to_owned(),
            sha256: "e".repeat(64),
            bytes: 42,
            media_type: "text/markdown".to_owned(),
        });
        assert!(proof.is_valid());
        assert_eq!(
            proof.excluded_deliverable_path(&["scenario/**".to_owned()]),
            Some("unselected/private.txt")
        );
        proof.provider_artifacts[0].path = "scenario".to_owned();
        assert_eq!(
            proof.excluded_deliverable_path(&["provider.md".to_owned()]),
            Some("scenario/.gitignore")
        );
    }

    #[test]
    fn malformed_or_incomplete_inventory_is_not_a_checkpoint() {
        let mut proof = proof();
        proof.changed_paths.push(proof.changed_paths[0].clone());
        assert!(!proof.is_valid());
        proof.changed_paths.pop();
        proof.changed_paths[0] = "../escape".to_owned();
        assert!(!proof.is_valid());
        proof = self::proof();
        proof.provider_artifacts.push(PreservedProviderArtifact {
            path: "provider.md".to_owned(),
            sha256: "bad".to_owned(),
            bytes: 1,
            media_type: "text/plain".to_owned(),
        });
        assert!(!proof.is_valid());
    }
}
