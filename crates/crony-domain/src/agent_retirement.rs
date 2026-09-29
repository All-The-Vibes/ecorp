use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// An explicit roster snapshot, never a selector for future or hidden workers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentRetirementTarget {
    pub agent_id: Uuid,
    pub expected_pin_version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRetirementMode {
    Retire,
    Clear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRetirementStatus {
    Retired,
    AlreadyRetired,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRetirementBlocker {
    RetentionChanged,
    Pinned,
    CurrentRun,
    ActiveStatus,
    AssignedWork,
    ActiveRun,
    ControlLease,
    QueuedMessage,
    PendingApproval,
    PendingVerification,
    RunnerCommand,
    ProviderTeardown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRetirementResult {
    pub agent_id: Uuid,
    pub status: AgentRetirementStatus,
    pub blockers: Vec<AgentRetirementBlocker>,
    pub retired_at: Option<DateTime<Utc>>,
    pub pinned: bool,
    pub pin_version: i64,
}

pub const MAX_CLEAR_CREW_TARGETS: usize = 100;
