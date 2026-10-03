//! Focused source verification for a draft checkpoint. This is never completion authority.

use crate::{
    PublicationEvidenceComment, PublicationEvidenceKind, VerificationPolicy, VerifierCheck,
    publication_evidence_body,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const ACTIVE_CHECKPOINT_CAPABILITY: &str = "active-source-checkpoint-v1";
pub const MAX_CHECKPOINT_CHECKS: usize = 8;
pub const MAX_CHECKPOINT_COMMAND_MS: u64 = 120_000;

/// A storage ACK is deliberately not a remote publication receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveCheckpointReceipt {
    pub publication_id: Uuid,
    pub artifact_id: Uuid,
    pub run_id: Uuid,
    pub sha256: String,
    pub commit_sha: String,
    pub pull_request_url: String,
}

/// A source-bound draft publication, deliberately separate from final publication.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveCheckpointPublication {
    pub id: Uuid,
    pub corp_id: Uuid,
    pub work_item_id: Uuid,
    pub mission_id: Uuid,
    pub task_id: Uuid,
    pub run_id: Uuid,
    pub artifact_id: Uuid,
    pub artifact_sha256: String,
    pub metadata: Value,
    pub target_repository: String,
    pub base_ref: String,
    /// Explicit native remote branch resolved from the immutable policy base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_base_ref: Option<String>,
    pub branch: String,
    pub commit_sha: String,
    pub previous_commit_sha: Option<String>,
    pub previous_pull_request: Option<Value>,
    pub title: String,
    pub body: String,
    pub phase: String,
    pub version: i64,
    pub actor_id: Uuid,
    pub publisher_id: String,
    pub lease_expires_at: DateTime<Utc>,
    pub failure_detail: Option<String>,
    pub pull_request: Option<Value>,
    pub created_at: DateTime<Utc>,
}

impl ActiveCheckpointPublication {
    /// Stable creation text survives gate changes and a lost create response.
    /// Current gate evidence is published separately without editing shared text.
    pub fn initial_pull_request_body(&self) -> String {
        format!(
            "Draft source checkpoint for `{}`.\n\nInitial source commit: `{}`\nCheckpoint: `{}`\n\nCurrent verification and review evidence is recorded in source-bound comments. This draft is not an accepted final publication.\n",
            self.target_repository, self.commit_sha, self.id
        )
    }

    pub fn gates_synchronized(&self) -> bool {
        self.phase == "project_synchronized"
            && self.pull_request.as_ref().is_some_and(|remote| {
                if let Some(comment) = remote.get("evidence_comment").filter(|v| !v.is_null()) {
                    serde_json::from_value::<PublicationEvidenceComment>(comment.clone()).is_ok_and(
                        |comment| {
                            comment
                                .validate(
                                    &self.target_repository,
                                    remote["number"].as_i64().unwrap_or_default(),
                                    &self.evidence_body(),
                                )
                                .is_ok()
                        },
                    )
                } else {
                    // Retained legacy receipts still require their exact PR text.
                    remote["body"].as_str() == Some(self.body.as_str())
                        && remote["title"].as_str() == Some(self.title.as_str())
                }
            })
    }

    pub fn evidence_body(&self) -> String {
        publication_evidence_body(
            PublicationEvidenceKind::Checkpoint,
            self.id,
            &self.target_repository,
            &self.commit_sha,
            &self.title,
            &self.body,
        )
    }

    pub fn receipt(&self) -> Option<ActiveCheckpointReceipt> {
        if !matches!(
            self.phase.as_str(),
            "draft_published" | "project_synchronized"
        ) {
            return None;
        }
        Some(ActiveCheckpointReceipt {
            publication_id: self.id,
            artifact_id: self.artifact_id,
            run_id: self.run_id,
            sha256: self.artifact_sha256.clone(),
            commit_sha: self.commit_sha.clone(),
            pull_request_url: self.pull_request.as_ref()?.get("url")?.as_str()?.to_owned(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveCheckpointOutcome {
    pub publication: ActiveCheckpointPublication,
    pub publisher_token: Option<Uuid>,
    pub replayed: bool,
    pub busy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActiveCheckpointRequest {
    pub actor_id: Uuid,
    pub artifact_id: Uuid,
    pub publisher_id: String,
    pub idempotency_key: Uuid,
    pub expected_version: Option<i64>,
    pub publisher_token: Option<Uuid>,
    pub action: ActiveCheckpointAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ActiveCheckpointAction {
    Acquire,
    Renew,
    BranchPushed {
        commit_sha: String,
        base_ref: String,
    },
    DraftPublished {
        number: i64,
        node_id: String,
        url: String,
        head_sha: String,
        head_ref: String,
        base_ref: String,
        head_repository_owner: String,
        is_cross_repository: bool,
        draft: bool,
        state: String,
        auto_merge_enabled: bool,
        title: String,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        evidence_comment: Option<Box<PublicationEvidenceComment>>,
    },
    ProjectSynchronized {
        status: String,
        field_id: String,
        option_id: String,
    },
    Failed {
        reason: ActiveCheckpointFailureReason,
    },
}

/// Fixed classifications keep child-process output and credentials out of durable history.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActiveCheckpointFailureReason {
    SourcePreparation,
    BranchPublication,
    DraftPublication,
    ProjectSynchronization,
}

impl ActiveCheckpointFailureReason {
    pub fn message(self) -> &'static str {
        match self {
            Self::SourcePreparation => {
                "Checkpoint source preparation failed; preserve the source and retry the trusted publisher."
            }
            Self::BranchPublication => {
                "Checkpoint branch publication failed; reconcile the exact remote branch before retrying."
            }
            Self::DraftPublication => {
                "Checkpoint draft publication failed; reconcile the existing draft before retrying."
            }
            Self::ProjectSynchronization => {
                "Checkpoint Project synchronization failed; the remote draft must be retained."
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActiveCheckpointPolicy {
    /// Zero-based positions in the immutable task verifier policy. No new commands or authority.
    pub check_indices: Vec<usize>,
}

impl ActiveCheckpointPolicy {
    pub fn validate_factory_policy(policy: &Value) -> Result<Option<Self>, String> {
        let Some(checkpoint) = Self::from_factory_policy(policy)? else {
            return Ok(None);
        };
        if policy["strategy_allowlist"] != serde_json::json!(["single"])
            || policy["deliverable_form"] != "commit_branch"
            || policy["auto_merge"] != false
            || policy["publication"]["allowed"] != true
            || policy["publication"]["auto_merge"] != false
            || policy["publication"]["merge"] != false
            || policy["publication"]["deploy"] != false
        {
            return Err("active checkpoints require a single-source commit/branch mission with draft-only publication authority".into());
        }
        let full: VerificationPolicy = serde_json::from_value(
            policy["verification_policy"].clone(),
        )
        .map_err(|_| "active checkpoints require the immutable final verification policy")?;
        checkpoint.focused_policy(&full)?;
        Ok(Some(checkpoint))
    }

    pub fn focused_policy(&self, full: &VerificationPolicy) -> Result<VerificationPolicy, String> {
        if self.check_indices.is_empty() || self.check_indices.len() > MAX_CHECKPOINT_CHECKS {
            return Err("checkpoint requires between one and eight focused checks".into());
        }
        let mut checks = Vec::new();
        let mut previous = None;
        let mut command_ms = 0_u64;
        for &index in &self.check_indices {
            if previous.is_some_and(|previous| index <= previous) {
                return Err("checkpoint check indices must be unique and increasing".into());
            }
            previous = Some(index);
            let check = full
                .checks
                .get(index)
                .ok_or("checkpoint check index is out of range")?;
            match check {
                VerifierCheck::Command { timeout_ms, .. }
                | VerifierCheck::Test { timeout_ms, .. } => {
                    if *timeout_ms == 0 {
                        return Err("checkpoint command must have a positive timeout".into());
                    }
                    command_ms = command_ms
                        .checked_add(*timeout_ms)
                        .ok_or("checkpoint command timeout overflow")?;
                    if command_ms > MAX_CHECKPOINT_COMMAND_MS {
                        return Err(
                            "checkpoint command timeouts exceed two minutes in total".into()
                        );
                    }
                }
                VerifierCheck::File { .. } | VerifierCheck::JsonSchema { .. } => {}
                _ => {
                    return Err(
                        "checkpoint permits focused commands, tests, files and JSON checks only"
                            .into(),
                    );
                }
            }
            checks.push(check.clone());
        }
        Ok(VerificationPolicy {
            checks,
            manual_gate: None,
        })
    }

    pub fn from_factory_policy(policy: &Value) -> Result<Option<Self>, String> {
        match policy.get("active_checkpoint") {
            None | Some(Value::Null) => Ok(None),
            Some(value) => serde_json::from_value(value.clone())
                .map(Some)
                .map_err(|_| "invalid active checkpoint policy".into()),
        }
    }

    /// A recovery may replace final gates, but cannot silently retarget the
    /// bounded checks that authorized draft publication at intake.
    pub fn validate_verification_replacement(
        &self,
        previous: &VerificationPolicy,
        replacement: &VerificationPolicy,
    ) -> Result<(), String> {
        if self.focused_policy(previous)? != self.focused_policy(replacement)? {
            return Err("verification recovery must retain the authorized focused checkpoint checks at their recorded indices".into());
        }
        Ok(())
    }

    /// Report positions are local to the focused invocation. Required final gates remain pending.
    pub fn validate_report(&self, full: &VerificationPolicy, report: &Value) -> Result<(), String> {
        let focused = self.focused_policy(full)?;
        if report.get("passed") != Some(&Value::Bool(true))
            || report
                .get("manual_gate")
                .is_some_and(|gate| !gate.is_null())
        {
            return Err(
                "checkpoint requires a passing focused report without a manual gate".into(),
            );
        }
        let checks = report
            .get("checks")
            .and_then(Value::as_array)
            .ok_or("checkpoint report omitted checks")?;
        if checks.len() != focused.checks.len() {
            return Err("checkpoint report does not contain every focused check".into());
        }
        for (index, (check, expected)) in checks.iter().zip(&focused.checks).enumerate() {
            if check.get("check_index").and_then(Value::as_u64) != Some(index as u64)
                || check.get("passed") != Some(&Value::Bool(true))
                || check.get("kind").and_then(Value::as_str) != Some(expected.kind())
            {
                return Err(
                    "checkpoint report check identity or result does not match policy".into(),
                );
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ManualVerificationGate;
    use serde_json::json;

    fn full() -> VerificationPolicy {
        VerificationPolicy {
            checks: vec![
                VerifierCheck::File {
                    path: "result.rs".into(),
                    min_bytes: 1,
                },
                VerifierCheck::Command {
                    program: "cargo".into(),
                    args: vec!["fmt".into(), "--check".into()],
                    timeout_ms: 30_000,
                    cache_suppression: None,
                },
                VerifierCheck::Test {
                    program: "cargo".into(),
                    args: vec!["test".into()],
                    timeout_ms: 600_000,
                    cache_suppression: None,
                },
            ],
            manual_gate: Some(ManualVerificationGate::IndependentReview {
                roles: vec!["manager".into()],
                exclude_requester: true,
            }),
        }
    }

    #[test]
    fn focused_checkpoint_reuses_exact_native_checks_without_final_authority() {
        let full = full();
        let saved = full.clone();
        let focused = ActiveCheckpointPolicy {
            check_indices: vec![0, 1],
        }
        .focused_policy(&full)
        .unwrap();
        assert_eq!(focused.checks, full.checks[..2]);
        assert!(focused.manual_gate.is_none());
        assert_eq!(full, saved);
    }

    #[test]
    fn empty_duplicate_reordered_unbounded_and_unknown_checkpoint_checks_fail() {
        for indices in [
            vec![],
            vec![0, 0],
            vec![1, 0],
            vec![2],
            vec![3],
            vec![usize::MAX],
        ] {
            assert!(
                ActiveCheckpointPolicy {
                    check_indices: indices
                }
                .focused_policy(&full())
                .is_err()
            );
        }
        assert!(
            ActiveCheckpointPolicy::from_factory_policy(&json!({
                "active_checkpoint": {"check_indices": [0], "merge": true}
            }))
            .is_err()
        );
        assert_eq!(
            ActiveCheckpointPolicy::from_factory_policy(&json!({})).unwrap(),
            None
        );
    }

    #[test]
    fn focused_report_rejects_missing_failed_duplicate_or_misidentified_evidence() {
        let policy = ActiveCheckpointPolicy {
            check_indices: vec![0, 1],
        };
        let report = json!({"passed": true, "manual_gate": null, "checks": [
            {"check_index": 0, "kind": "file", "passed": true},
            {"check_index": 1, "kind": "command", "passed": true}
        ]});
        policy.validate_report(&full(), &report).unwrap();
        for (path, value) in [
            ("/passed", json!(false)),
            ("/checks/1/passed", json!(false)),
            ("/checks/1/check_index", json!(0)),
            ("/checks/1/kind", json!("test")),
            ("/manual_gate", json!({"status":"approved"})),
        ] {
            let mut invalid = report.clone();
            *invalid.pointer_mut(path).unwrap() = value;
            assert!(policy.validate_report(&full(), &invalid).is_err(), "{path}");
        }
        let mut missing = report;
        missing["checks"].as_array_mut().unwrap().pop();
        assert!(policy.validate_report(&full(), &missing).is_err());
    }
}
