use super::*;

pub const BASE_REFRESH_CAPABILITY: &str = "publication-base-refresh-v1";
pub const MAX_BASE_REFRESH_ATTEMPTS: i64 = 3;

/// The caller selects immutable source IDs, never a replacement verifier policy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthorizeFactoryBaseRefresh {
    pub actor_id: Uuid,
    pub claim_token: Uuid,
    pub expected_version: i64,
    pub idempotency_key: Uuid,
    pub source_deliverable_id: Uuid,
    pub new_base_commit: String,
    pub observed_source_revision: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SettleFactoryBaseRefresh {
    pub actor_id: Uuid,
    pub claim_token: Uuid,
    pub expected_version: i64,
    pub idempotency_key: Uuid,
    pub observed_source_revision: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactoryBaseRefresh {
    pub id: Uuid,
    pub corp_id: Uuid,
    pub factory_work_item_id: Uuid,
    pub source_mission_id: Uuid,
    pub source_task_id: Uuid,
    pub source_run_id: Uuid,
    pub source_deliverable_id: Uuid,
    pub mission_id: Uuid,
    pub task_id: Uuid,
    pub run_id: Uuid,
    pub authorized_by: Uuid,
    pub idempotency_key: Uuid,
    pub original_base_commit: String,
    pub refreshed_base_commit: String,
    pub source_head_commit: String,
    pub state: String,
    pub result_deliverable_id: Option<Uuid>,
    pub result_commit: Option<String>,
    pub review_decision_id: Option<Uuid>,
    pub settled_by: Option<Uuid>,
    pub settlement_key: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactoryBaseRefreshResponse {
    pub refresh: FactoryBaseRefresh,
    pub work_item: FactoryWorkItem,
    pub events: Vec<DomainEvent>,
    pub replayed: bool,
}

/// Reuse every saved check and scope. A changed base always requires an
/// independent decision, even if the original policy needed no manual gate.
pub fn base_refresh_policy(policy: &VerificationPolicy) -> VerificationPolicy {
    let roles = match &policy.manual_gate {
        Some(ManualVerificationGate::HumanApproval { roles })
        | Some(ManualVerificationGate::IndependentReview { roles, .. }) => roles.clone(),
        None => ["owner", "admin", "manager", "member"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
    };
    VerificationPolicy {
        checks: policy.checks.clone(),
        manual_gate: Some(ManualVerificationGate::IndependentReview {
            roles,
            exclude_requester: true,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_preserves_checks_and_restricts_existing_review_roles() {
        let original = VerificationPolicy {
            checks: vec![VerifierCheck::Artifact { min_bytes: 12 }],
            manual_gate: Some(ManualVerificationGate::HumanApproval {
                roles: vec!["owner".into()],
            }),
        };
        let refreshed = base_refresh_policy(&original);
        assert_eq!(refreshed.checks, original.checks);
        assert_eq!(
            refreshed.manual_gate,
            Some(ManualVerificationGate::IndependentReview {
                roles: vec!["owner".into()],
                exclude_requester: true,
            })
        );
        assert_eq!(base_refresh_policy(&refreshed), refreshed);
    }

    #[test]
    fn refresh_requires_independent_review_even_without_an_original_gate() {
        let policy = base_refresh_policy(&VerificationPolicy {
            checks: vec![],
            manual_gate: None,
        });
        assert!(matches!(
            policy.manual_gate,
            Some(ManualVerificationGate::IndependentReview {
                exclude_requester: true,
                ..
            })
        ));
    }
}
