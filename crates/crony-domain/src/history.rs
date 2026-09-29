//! Safe, bounded history projections. None of these records grants authority.
use crate::{MissionStatus, RunStatus, TaskStatus};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryKind {
    Mission,
    Task,
    Run,
    #[default]
    Event,
}

impl HistoryKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Mission => "mission",
            Self::Task => "task",
            Self::Run => "run",
            Self::Event => "event",
        }
    }

    pub const fn known_statuses(self) -> &'static [&'static str] {
        const MISSIONS: &[&str] = &[
            MissionStatus::Draft.as_str(),
            MissionStatus::Ready.as_str(),
            MissionStatus::Running.as_str(),
            MissionStatus::Completed.as_str(),
            MissionStatus::Failed.as_str(),
            MissionStatus::Cancelled.as_str(),
        ];
        const TASKS: &[&str] = &[
            TaskStatus::Pending.as_str(),
            TaskStatus::Ready.as_str(),
            TaskStatus::Claimed.as_str(),
            TaskStatus::Running.as_str(),
            TaskStatus::Blocked.as_str(),
            TaskStatus::AwaitingApproval.as_str(),
            TaskStatus::VerificationFailed.as_str(),
            TaskStatus::Review.as_str(),
            TaskStatus::Completed.as_str(),
            TaskStatus::Failed.as_str(),
            TaskStatus::Cancelled.as_str(),
        ];
        const RUNS: &[&str] = &[
            RunStatus::Provisioning.as_str(),
            RunStatus::Starting.as_str(),
            RunStatus::Running.as_str(),
            RunStatus::WaitingForInput.as_str(),
            RunStatus::WaitingForApproval.as_str(),
            RunStatus::Verifying.as_str(),
            RunStatus::Completed.as_str(),
            RunStatus::Failed.as_str(),
            RunStatus::Cancelled.as_str(),
            RunStatus::Lost.as_str(),
        ];
        match self {
            Self::Mission => MISSIONS,
            Self::Task => TASKS,
            Self::Run => RUNS,
            Self::Event => HISTORY_EVENT_TYPES,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryFilters {
    pub kind: HistoryKind,
    pub room_id: Option<Uuid>,
    pub mission_id: Option<Uuid>,
    pub attributed_actor_id: Option<Uuid>,
    pub record_id: Option<Uuid>,
    pub status: Option<String>,
    pub search: String,
}

impl HistoryFilters {
    pub fn normalize(mut self) -> Option<Self> {
        self.search = self.search.trim().to_owned();
        if self.search.chars().count() > 160
            || self.search.chars().any(unsafe_label_char)
            || [
                self.room_id,
                self.mission_id,
                self.attributed_actor_id,
                self.record_id,
            ]
            .into_iter()
            .flatten()
            .any(|id| id.is_nil())
        {
            return None;
        }
        if let Some(status) = self.status.as_deref() {
            let fallback = if self.kind == HistoryKind::Event {
                "other"
            } else {
                "unknown"
            };
            let supported = status == fallback || self.kind.known_statuses().contains(&status);
            if !supported {
                return None;
            }
        }
        Some(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: Uuid,
    pub kind: HistoryKind,
    pub room_id: Option<Uuid>,
    pub title: String,
    pub status: String,
    pub summary: String,
    pub actor_id: Option<Uuid>,
    pub actor_name: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Decimal string so JavaScript never rounds BIGINT journal positions.
    pub seq: Option<String>,
    pub mission_id: Option<Uuid>,
    pub task_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    /// Only a currently visible causal event may be linked.
    pub cause_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryPage {
    pub corp_id: Uuid,
    pub actor_id: Uuid,
    pub filters: HistoryFilters,
    pub page_size: u32,
    pub entries: Vec<HistoryEntry>,
    pub next_cursor: Option<String>,
    pub observed_at: DateTime<Utc>,
}

// An allowlist, not provider text or a payload redactor. Unknown event kinds
// remain searchable as "other"; even search must not reveal hidden payloads.
pub const HISTORY_EVENT_TYPES: &[&str] = &[
    "corp.demo_bootstrapped",
    "room.message_posted",
    "mission.created",
    "mission.planned",
    "mission.budget_revision_approved",
    "mission.budget_revision_proposed",
    "mission.budget_revision_rejected",
    "mission.contract_revised",
    "task.created",
    "run.requested",
    "run.started",
    "run.status",
    "run.output",
    "run.tool_activity",
    "run.usage",
    "run.completed",
    "run.failed",
    "run.cancelled",
    "run.lost",
    "run.interrupt_requested",
    "run.resume_requested",
    "run.stop_requested",
    "run.reconciled",
    "run.artifact",
    "run.deliverable",
    "run.dependency_context",
    "run.session",
    "run.session_terminated",
    "run.teardown_uncertain",
    "run.workspace_preserved",
    "run.workspace_removed",
    "run.breaker_transition",
    "run.approval_requested",
    "run.approval_expired",
    "run.verification_started",
    "run.verification_evidence",
    "run.verification_passed",
    "run.verification_failed",
    "run.verification_requested",
    "run.verification_waiting",
    "verification.approved",
    "verification.rejected",
    "agent.pinned",
    "agent.unpinned",
    "agent.retired",
    "agent.reactivated",
    "agent.staffed",
    "agent.policy_changed",
    "runner.enrolled",
    "runner.revoked",
    "runner.grace_started",
    "runner.capabilities_updated",
    "runner.command_acknowledged",
    "runner.command_failed",
    "runner.credential_rotated",
    "runner.enrollment_created",
    "control.lease_acquired",
    "control.lease_released",
    "control.lease_transferred",
    "control.message_accepted",
    "control.message_queued",
    "control.message_requeued",
    "budget.policy_updated",
    "factory.work_item_claimed",
    "factory.work_item_reclaimed",
    "factory.claim_renewed",
    "factory.mission_linked",
    "factory.state_changed",
    "factory.materialization_rejected",
    "factory.controller_configured",
    "factory.controller_status_changed",
    "factory.policy_changed",
    "factory.source_commit_pinned",
    "factory.verification_recovery_authorized",
    "factory.verification_recovery_started",
    "factory.workspace_checkpoint_requested",
    "factory.checkpoint_cancellation_reconciled",
    "factory.publication_requested",
    "factory.publication_attempt_started",
    "factory.publication_branch_pushed",
    "factory.publication_completed",
    "factory.publication_failed",
    "factory.publication_lease_renewed",
    "factory.publication_publisher_enrolled",
    "factory.publication_publisher_revoked",
    "factory.pull_request_created",
];

pub fn history_event_summary(event_type: &str) -> &'static str {
    match event_type {
        "run.started" => "Runner started this execution.",
        "run.completed" => {
            "The run recorded a completed outcome. Inspect the exact run's persisted evidence."
        }
        "run.failed" => "The run recorded a failed outcome. Inspect the exact work for evidence.",
        "run.verification_passed" => "The run's persisted verification checks passed.",
        "run.verification_failed" => "The run did not pass its persisted verification policy.",
        "run.artifact" => {
            "The run recorded an artifact. Inspect the exact run for authorized evidence."
        }
        "run.output" | "run.status" => {
            "The run reported activity. Provider text is excluded from history."
        }
        "run.tool_activity" => "The run reported tool activity. Arguments and output are excluded.",
        "run.usage" => "The run reported usage. Inspect the exact run for accounting.",
        "mission.created" => "A mission and its explicit task graph were recorded.",
        "run.requested" => {
            "An execution was requested. This event alone does not prove the runner started."
        }
        "room.message_posted" => {
            "A room message was recorded. Message contents are excluded from history."
        }
        "other" => "An audit event was recorded. No raw payload is exposed.",
        _ => {
            "An operational state change was recorded. Use the authorized links to inspect its context."
        }
    }
}

/// Names/titles are intentional shared labels, never descriptions or diagnostics.
pub fn history_label(value: &str) -> String {
    value
        .chars()
        .filter(|c| !unsafe_label_char(*c))
        .take(240)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn unsafe_label_char(c: char) -> bool {
    c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_filters_are_bounded_and_kind_specific() {
        let base = HistoryFilters::default();
        assert_eq!(
            HistoryFilters {
                search: "  literal %_  ".into(),
                ..base.clone()
            }
            .normalize()
            .unwrap()
            .search,
            "literal %_"
        );
        for search in [
            "x".repeat(161),
            "hidden\ntext".into(),
            "hidden\u{202e}text".into(),
        ] {
            assert!(
                HistoryFilters {
                    search,
                    ..base.clone()
                }
                .normalize()
                .is_none()
            );
        }
        assert!(
            HistoryFilters {
                kind: HistoryKind::Mission,
                status: Some("waiting_for_input".into()),
                ..base.clone()
            }
            .normalize()
            .is_none()
        );
        assert!(
            HistoryFilters {
                record_id: Some(Uuid::nil()),
                ..base
            }
            .normalize()
            .is_none()
        );
    }

    #[test]
    fn history_labels_remove_controls_and_bound_unicode() {
        assert_eq!(history_label("\nA\u{202e}B\0"), "AB");
        assert_eq!(history_label(&"界".repeat(500)).chars().count(), 240);
        let unique = HISTORY_EVENT_TYPES
            .iter()
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), HISTORY_EVENT_TYPES.len());
    }

    #[test]
    fn history_summaries_distinguish_recorded_outcomes_from_verification() {
        assert_eq!(
            history_event_summary("run.completed"),
            "The run recorded a completed outcome. Inspect the exact run's persisted evidence."
        );
        assert_eq!(
            history_event_summary("run.verification_passed"),
            "The run's persisted verification checks passed."
        );
        assert_ne!(
            history_event_summary("run.requested"),
            history_event_summary("run.started")
        );
        assert_eq!(
            history_event_summary("private-provider-error-canary"),
            "An operational state change was recorded. Use the authorized links to inspect its context."
        );
        for kind in [HistoryKind::Mission, HistoryKind::Task, HistoryKind::Run] {
            assert!(
                HistoryFilters {
                    kind,
                    status: Some("unknown".into()),
                    ..Default::default()
                }
                .normalize()
                .is_some()
            );
            assert!(
                HistoryFilters {
                    kind,
                    status: Some("private-provider-error-canary".into()),
                    ..Default::default()
                }
                .normalize()
                .is_none()
            );
        }
    }
}
