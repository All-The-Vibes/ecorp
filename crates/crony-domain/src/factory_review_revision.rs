use super::*;

pub const REVIEW_REVISION_CAPABILITY: &str = "publication-review-revision-v1";
pub const MAX_REVIEW_REVISIONS: usize = 3;

/// One stable, distinct publication branch for each authorized correction.
pub fn review_revision_branch(prefix: &str, issue: i64, revision: Uuid) -> String {
    format!("{prefix}issue-{issue}-review-{}", revision.simple())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewFindingKind {
    Correctness,
    Security,
    Verification,
    ProductContract,
}

/// A finding is attributed to the authenticated submitter, never to a claimed
/// remote reviewer. External links are supporting evidence, not authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewFinding {
    pub kind: ReviewFindingKind,
    pub summary: String,
    pub source_url: Option<String>,
    pub path: Option<String>,
    pub line: Option<u32>,
}

pub fn validate_review_findings(findings: &[ReviewFinding]) -> Result<(), &'static str> {
    if findings.is_empty() || findings.len() > 20 {
        return Err("a revision requires between one and twenty findings");
    }
    for finding in findings {
        if finding.summary.trim().is_empty()
            || finding.summary.len() > 2_000
            || finding.summary.contains('\0')
        {
            return Err("finding summary must contain between one and 2000 bytes");
        }
        if finding.source_url.as_ref().is_some_and(|value| {
            !value.starts_with("https://")
                || value.trim() != value
                || value.len() > 2_000
                || value.chars().any(char::is_control)
                || url::Url::parse(value).map_or(true, |url| {
                    url.scheme() != "https"
                        || !url.has_host()
                        || !url.username().is_empty()
                        || url.password().is_some()
                })
        }) {
            return Err("finding evidence must be a bounded HTTPS URL without credentials");
        }
        if finding
            .path
            .as_ref()
            .is_some_and(|path| !repository_relative_path_is_valid(path))
            || finding
                .line
                .is_some_and(|line| line == 0 || finding.path.is_none())
        {
            return Err("finding location must identify a repository path and positive line");
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizeFactoryReviewRevision {
    pub actor_id: Uuid,
    pub expected_version: i64,
    pub idempotency_key: Uuid,
    pub publication_id: Uuid,
    pub published_head_commit: String,
    pub observed_source_revision: String,
    pub findings: Vec<ReviewFinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettleFactoryReviewRevision {
    pub actor_id: Uuid,
    pub expected_version: i64,
    pub idempotency_key: Uuid,
    pub observed_source_revision: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactoryReviewRevision {
    pub id: Uuid,
    pub corp_id: Uuid,
    pub factory_work_item_id: Uuid,
    pub publication_id: Uuid,
    pub source_mission_id: Uuid,
    pub source_task_id: Uuid,
    pub source_run_id: Uuid,
    pub source_deliverable_id: Uuid,
    pub source_head_commit: String,
    pub mission_id: Uuid,
    pub task_id: Uuid,
    pub authorized_by: Uuid,
    pub findings: Vec<ReviewFinding>,
    pub state: String,
    pub result_run_id: Option<Uuid>,
    pub result_deliverable_id: Option<Uuid>,
    pub result_commit: Option<String>,
    pub review_decision_id: Option<Uuid>,
    pub settled_by: Option<Uuid>,
    pub settlement_key: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactoryReviewRevisionResponse {
    pub revision: FactoryReviewRevision,
    pub work_item: FactoryWorkItem,
    pub events: Vec<DomainEvent>,
    pub replayed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RevisionAllocation {
    pub tokens: i64,
    pub cost_microusd: i64,
    pub attempts: i32,
}

/// Both task and mission allocations are residual authority. New mission IDs
/// must never replenish either budget or the original task's attempt limit.
pub fn review_revision_allocation(
    task_remaining: (i64, i64),
    mission_remaining: (i64, i64),
    attempts_remaining: i32,
) -> Result<RevisionAllocation, &'static str> {
    let tokens = task_remaining.0.min(mission_remaining.0);
    let cost_microusd = task_remaining.1.min(mission_remaining.1);
    if tokens <= 0 || cost_microusd <= 0 || attempts_remaining <= 0 {
        return Err("published work has no remaining correction budget or attempts");
    }
    Ok(RevisionAllocation {
        tokens,
        cost_microusd,
        attempts: attempts_remaining,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn residual_authority_intersects_task_and_mission_limits() {
        let allocation = review_revision_allocation((12, 80), (40, 50), 2).unwrap();
        assert_eq!(
            allocation,
            RevisionAllocation {
                tokens: 12,
                cost_microusd: 50,
                attempts: 2
            }
        );
        for (task, mission, attempts) in [
            ((0, 5), (5, 5), 1),
            ((5, 5), (5, -1), 1),
            ((5, 5), (5, 5), 0),
        ] {
            assert!(review_revision_allocation(task, mission, attempts).is_err());
        }
    }

    #[test]
    fn findings_cannot_claim_authority_or_escape_repository_locations() {
        assert!(validate_review_findings(&[]).is_err());
        let mut finding = ReviewFinding {
            kind: ReviewFindingKind::Security,
            summary: "Cross-Corp lookup".into(),
            source_url: None,
            path: Some("src/auth.rs".into()),
            line: Some(12),
        };
        assert!(validate_review_findings(&[finding.clone()]).is_ok());
        finding.path = Some("../other-repo/auth.rs".into());
        assert!(validate_review_findings(&[finding.clone()]).is_err());
        finding.path = None;
        assert!(validate_review_findings(&[finding]).is_err());
        assert!(serde_json::from_value::<ReviewFinding>(serde_json::json!({"kind":"security", "summary":"finding", "source_url":null, "path":null, "line":null, "reviewer_id":Uuid::new_v4()})).is_err());
    }

    #[test]
    fn finding_links_require_valid_bounded_https_without_credentials() {
        let mut finding = ReviewFinding {
            kind: ReviewFindingKind::Correctness,
            summary: "Verify the reported defect".into(),
            source_url: None,
            path: None,
            line: None,
        };
        for value in [
            "https://github.com/owner/repo/pull/17#discussion_r1",
            "https://example.org/review?part=2",
        ] {
            finding.source_url = Some(value.into());
            assert!(validate_review_findings(&[finding.clone()]).is_ok());
        }
        for value in [
            "https://",
            "http://example.org",
            "https://example.org:invalid",
            "https://user:password@example.org/review",
            "https://user@example.org/review",
            "https://:password@example.org/review",
            "https://example.org/review\n",
            "https://example.org/review ",
            "https://example.org/\u{0085}",
        ] {
            finding.source_url = Some(value.into());
            assert!(validate_review_findings(&[finding.clone()]).is_err());
        }
        finding.source_url = Some(format!("https://example.org/{}", "a".repeat(2_000)));
        assert!(validate_review_findings(&[finding]).is_err());
    }
}
