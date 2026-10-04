//! Evidence comments and the compensation journal for native draft promotion.
//!
//! GitHub's native ready/draft mutations do not accept an expected head. A
//! successful command receipt and a fresh source observation are both needed;
//! a timeout is not proof that an already submitted mutation was cancelled.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub enum PublicationEvidenceKind {
    Checkpoint,
    Final,
}

pub fn publication_evidence_body(
    kind: PublicationEvidenceKind,
    publication_id: Uuid,
    repository: &str,
    head: &str,
    title: &str,
    body: &str,
) -> String {
    let kind = match kind {
        PublicationEvidenceKind::Checkpoint => "checkpoint",
        PublicationEvidenceKind::Final => "final",
    };
    format!(
        "<!-- ecorp-publication-evidence-v1:{kind}:{publication_id} -->\nRepository: `{repository}`\nSource commit: `{head}`\n\n# {title}\n\n{body}"
    )
}

/// An append-only observation. The publisher checks the authenticated GitHub
/// actor and all comment pages; the store binds these bytes to the source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationEvidenceComment {
    pub id: i64,
    pub node_id: String,
    pub url: String,
    pub author_id: i64,
    pub author_login: String,
    pub body: String,
}

impl PublicationEvidenceComment {
    pub fn validate(&self, repository: &str, number: i64, expected: &str) -> Result<(), String> {
        let url = format!(
            "https://github.com/{repository}/pull/{number}#issuecomment-{}",
            self.id
        );
        if number <= 0
            || self.id <= 0
            || self.node_id.is_empty()
            || self.author_id <= 0
            || self.author_login.is_empty()
            || !self.url.eq_ignore_ascii_case(&url)
            || self.body != expected
        {
            return Err(
                "publication comment does not bind the expected PR, actor and source evidence"
                    .into(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationPullRequestSnapshot {
    pub number: i64,
    pub node_id: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub title: String,
    pub body: String,
    pub head_ref: String,
    pub base_ref: String,
    pub head_sha: String,
    pub head_repository_owner: String,
    pub is_cross_repository: bool,
    pub auto_merge: bool,
}

impl PublicationPullRequestSnapshot {
    pub fn same_identity(&self, other: &Self) -> bool {
        self.number == other.number && self.node_id == other.node_id && self.url == other.url
    }

    pub fn matches_ready(&self, other: &Self) -> bool {
        let mut expected = self.clone();
        expected.draft = false;
        &expected == other
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicationReadinessState {
    Prepared,
    Recovering,
    Compensated,
    Accepted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicationReadinessRecovery {
    pub acquisition_id: Uuid,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicationReadinessUndo {
    pub dispatch_id: Uuid,
    pub acquisition_id: Uuid,
    pub succeeded: bool,
}

/// Public journal metadata. Capabilities are stored only in the existing
/// private publication-operation token column, never in this provenance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicationReadiness {
    pub intent_id: Uuid,
    pub actor_id: Uuid,
    pub publisher_id: String,
    pub state: PublicationReadinessState,
    pub pull_request: PublicationPullRequestSnapshot,
    pub evidence_comment: PublicationEvidenceComment,
    pub ready_succeeded: bool,
    pub undo: Vec<PublicationReadinessUndo>,
    pub recovery: Option<PublicationReadinessRecovery>,
    pub draft_observed: Option<PublicationPullRequestSnapshot>,
    pub created_at: DateTime<Utc>,
}

impl PublicationReadiness {
    pub fn pending(&self) -> bool {
        matches!(
            self.state,
            PublicationReadinessState::Prepared | PublicationReadinessState::Recovering
        )
    }

    pub fn effects_acknowledged(&self) -> bool {
        self.ready_succeeded && self.undo.iter().all(|undo| undo.succeeded)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationReadinessRequest {
    pub actor_id: Uuid,
    pub intent_id: Uuid,
    pub action: PublicationReadinessAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PublicationReadinessAction {
    Prepare {
        publisher_token: Uuid,
        expected_version: i64,
        pull_request: PublicationPullRequestSnapshot,
        evidence_comment: PublicationEvidenceComment,
    },
    /// Record-only acknowledgement; it never restores forward authority.
    ReadySucceeded { publisher_token: Uuid },
    Recover {
        publisher_token: Option<Uuid>,
        expected_version: i64,
        acquisition_id: Uuid,
    },
    UndoPrepared {
        recovery_token: Uuid,
        expected_version: i64,
        dispatch_id: Uuid,
    },
    /// Record-only acknowledgement of the exact compensation dispatch.
    UndoSucceeded {
        recovery_token: Uuid,
        dispatch_id: Uuid,
    },
    DraftObserved {
        recovery_token: Uuid,
        expected_version: i64,
        pull_request: PublicationPullRequestSnapshot,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft() -> PublicationPullRequestSnapshot {
        PublicationPullRequestSnapshot {
            number: 72,
            node_id: "PR_fixture72".into(),
            url: "https://github.com/fixture/source/pull/72".into(),
            state: "OPEN".into(),
            draft: true,
            title: "Reviewed title".into(),
            body: "Preserved review notes\r\nRésumé 🚀\n".into(),
            head_ref: "codex/checkpoint-72".into(),
            base_ref: "main".into(),
            head_sha: "a".repeat(40),
            head_repository_owner: "fixture".into(),
            is_cross_repository: false,
            auto_merge: false,
        }
    }

    fn comment() -> PublicationEvidenceComment {
        PublicationEvidenceComment {
            id: 72001,
            node_id: "IC_fixture72001".into(),
            url: "https://github.com/fixture/source/pull/72#issuecomment-72001".into(),
            author_id: 73,
            author_login: "publisher".into(),
            body: "Exact source evidence\n".into(),
        }
    }

    #[test]
    fn readiness_acceptance_binds_every_observed_field_and_exact_text_bytes() {
        let expected = draft();
        let mut ready = expected.clone();
        ready.draft = false;
        assert!(expected.matches_ready(&ready));
        assert!(!expected.matches_ready(&expected));
        for (field, value) in [
            ("number", serde_json::json!(73)),
            ("node_id", serde_json::json!("different")),
            (
                "url",
                serde_json::json!("https://github.com/other/source/pull/72"),
            ),
            ("state", serde_json::json!("CLOSED")),
            ("head_sha", serde_json::json!("b".repeat(40))),
            ("head_ref", serde_json::json!("someone-else")),
            ("base_ref", serde_json::json!("release")),
            ("head_repository_owner", serde_json::json!("other")),
            ("title", serde_json::json!("Reviewed title ")),
            ("body", serde_json::json!(ready.body.replace("\r\n", "\n"))),
            ("body", serde_json::json!(ready.body.trim_end())),
            ("is_cross_repository", serde_json::json!(true)),
            ("auto_merge", serde_json::json!(true)),
        ] {
            let mut changed = serde_json::to_value(&ready).unwrap();
            changed[field] = value;
            let changed = serde_json::from_value(changed).unwrap();
            assert!(!expected.matches_ready(&changed), "{field}");
            if !["number", "node_id", "url"].contains(&field) {
                assert!(
                    expected.same_identity(&changed),
                    "compensation must retain mutable {field}"
                );
            } else {
                assert!(!expected.same_identity(&changed), "{field}");
            }
        }
    }

    #[test]
    fn evidence_comments_bind_exact_content_and_the_retained_pr_identity() {
        let expected = comment();
        assert!(
            expected
                .validate("fixture/source", 72, &expected.body)
                .is_ok()
        );
        for (field, value) in [
            ("id", serde_json::json!(0)),
            ("author_id", serde_json::json!(0)),
            ("author_login", serde_json::json!("")),
            ("node_id", serde_json::json!("")),
            (
                "url",
                serde_json::json!("https://github.com/fixture/source/pull/73#issuecomment-72001"),
            ),
            (
                "url",
                serde_json::json!(
                    "https://example.invalid/fixture/source/pull/72#issuecomment-72001"
                ),
            ),
            ("body", serde_json::json!(expected.body.trim_end())),
        ] {
            let mut bad = serde_json::to_value(&expected).unwrap();
            bad[field] = value;
            let bad: PublicationEvidenceComment = serde_json::from_value(bad).unwrap();
            assert!(
                bad.validate("fixture/source", 72, &expected.body).is_err(),
                "{field}"
            );
        }
        assert!(
            expected
                .validate("other/source", 72, &expected.body)
                .is_err()
        );
    }

    #[test]
    fn observing_draft_does_not_acknowledge_an_unknown_ready_or_undo() {
        let mut journal = PublicationReadiness {
            intent_id: Uuid::new_v4(),
            actor_id: Uuid::new_v4(),
            publisher_id: "fixture".into(),
            state: PublicationReadinessState::Recovering,
            pull_request: draft(),
            evidence_comment: comment(),
            ready_succeeded: false,
            undo: vec![],
            recovery: None,
            draft_observed: Some(draft()),
            created_at: Utc::now(),
        };
        assert!(journal.pending());
        assert!(!journal.effects_acknowledged());
        journal.ready_succeeded = true;
        journal.undo.push(PublicationReadinessUndo {
            dispatch_id: Uuid::new_v4(),
            acquisition_id: Uuid::new_v4(),
            succeeded: false,
        });
        assert!(!journal.effects_acknowledged());
        journal.undo[0].succeeded = true;
        assert!(journal.effects_acknowledged());
        // Acknowledgements alone do not settle the journal; a fresh scoped draft
        // observation is still required by the store transition.
        assert!(journal.pending());
    }
}
