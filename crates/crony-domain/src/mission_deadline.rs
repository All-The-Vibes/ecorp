//! One immutable mission clock; a declared reserve narrows earlier task windows.
use std::collections::HashSet;

use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};

use crate::TaskGraphPlan;

pub const MISSION_DEADLINE_CAPABILITY: &str = "mission-deadline-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MissionDeadlinePolicy {
    pub deadline_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserve: Option<MissionDeadlineReserve>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MissionDeadlineReserve {
    pub seconds: u64,
    pub task_keys: Vec<String>,
}

/// Database-clock allowance sampled at final native dispatch, not plan creation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunDeadline {
    pub mission_deadline_at: DateTime<Utc>,
    pub task_deadline_at: DateTime<Utc>,
    pub dispatched_at: DateTime<Utc>,
    pub remaining_ms: u64,
}

impl MissionDeadlinePolicy {
    pub fn task_deadline_at(&self, task_key: &str) -> Result<DateTime<Utc>, &'static str> {
        let Some(reserve) = &self.reserve else {
            return Ok(self.deadline_at);
        };
        let seconds = i64::try_from(reserve.seconds)
            .ok()
            .filter(|seconds| *seconds > 0)
            .and_then(TimeDelta::try_seconds)
            .ok_or("mission deadline reserve must be a positive representable duration")?;
        let earlier = self
            .deadline_at
            .checked_sub_signed(seconds)
            .ok_or("mission deadline reserve exceeds the timestamp range")?;
        Ok(if reserve.task_keys.iter().any(|key| key == task_key) {
            self.deadline_at
        } else {
            earlier
        })
    }

    pub fn allowance_at(
        &self,
        task_key: &str,
        now: DateTime<Utc>,
    ) -> Result<RunDeadline, &'static str> {
        let task_deadline_at = self.task_deadline_at(task_key)?;
        let remaining_ms = u64::try_from((task_deadline_at - now).num_milliseconds())
            .ok()
            .filter(|remaining| *remaining > 0)
            .ok_or("mission deadline or declared stage allowance has expired")?;
        Ok(RunDeadline {
            mission_deadline_at: self.deadline_at,
            task_deadline_at,
            dispatched_at: now,
            remaining_ms,
        })
    }
}

impl RunDeadline {
    /// Local clocks may shorten an allowance, but cannot grant more than the
    /// database sampled. The runner converts this once to a monotonic deadline.
    pub fn remaining_at(&self, now: DateTime<Utc>) -> Result<u64, &'static str> {
        let sampled_ms = (self.task_deadline_at - self.dispatched_at).num_milliseconds();
        if self.task_deadline_at > self.mission_deadline_at
            || sampled_ms <= 0
            || u64::try_from(sampled_ms).ok() != Some(self.remaining_ms)
        {
            return Err("invalid native mission deadline allowance");
        }
        let local_ms = u64::try_from((self.task_deadline_at - now).num_milliseconds()).unwrap_or(0);
        let remaining = self.remaining_ms.min(local_ms);
        if remaining == 0 {
            return Err("mission deadline or declared stage allowance has expired");
        }
        Ok(remaining)
    }
}

impl TaskGraphPlan {
    pub fn validate_deadline(&self) -> Result<(), &'static str> {
        let mission_deadline = self.deadline.as_ref().map(|policy| policy.deadline_at);
        if self
            .tasks
            .iter()
            .any(|task| task.contract.deadline_at != mission_deadline)
        {
            return Err("every task must retain the same immutable mission deadline");
        }
        let Some(policy) = &self.deadline else {
            return Ok(());
        };
        let Some(reserve) = &policy.reserve else {
            return Ok(());
        };
        // Validate arithmetic even when every supplied key appears protected.
        policy.task_deadline_at("")?;
        let keys: HashSet<_> = reserve.task_keys.iter().map(String::as_str).collect();
        if keys.is_empty() || keys.len() != reserve.task_keys.len() {
            return Err("mission deadline reserve must name distinct protected tasks");
        }
        if keys.len() >= self.tasks.len()
            || keys
                .iter()
                .any(|key| !self.tasks.iter().any(|task| task.key == *key))
        {
            return Err("mission deadline reserve must name existing tasks and leave earlier work");
        }
        if self.tasks.iter().any(|task| {
            !keys.contains(task.key.as_str())
                && task
                    .depends_on
                    .iter()
                    .any(|parent| keys.contains(parent.as_str()))
        }) {
            return Err("mission deadline reserve must include every descendant of protected work");
        }
        // A reserve is a final stage, not an arbitrary branch that may run
        // alongside earlier work. Each protected task must wait for every
        // unprotected task, either directly or through a dependency chain.
        for task in self
            .tasks
            .iter()
            .filter(|task| keys.contains(task.key.as_str()))
        {
            let mut ancestors = HashSet::new();
            let mut pending: Vec<_> = task.depends_on.iter().map(String::as_str).collect();
            while let Some(key) = pending.pop() {
                if ancestors.insert(key)
                    && let Some(parent) = self.tasks.iter().find(|parent| parent.key == key)
                {
                    pending.extend(parent.depends_on.iter().map(String::as_str));
                }
            }
            if self.tasks.iter().any(|earlier| {
                !keys.contains(earlier.key.as_str()) && !ancestors.contains(earlier.key.as_str())
            }) {
                return Err("every protected task must depend on all earlier unreserved work");
            }
        }
        Ok(())
    }

    pub fn admit_deadline_at(&self, now: DateTime<Utc>) -> Result<(), &'static str> {
        self.validate_deadline()?;
        if let Some(policy) = &self.deadline {
            for task in &self.tasks {
                policy.allowance_at(&task.key, now)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PlannedTask, TaskContract, VerificationPolicy};
    use chrono::TimeZone;

    fn start() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 2, 12, 0, 0).unwrap()
    }

    fn policy() -> MissionDeadlinePolicy {
        MissionDeadlinePolicy {
            deadline_at: start() + TimeDelta::seconds(600),
            reserve: Some(MissionDeadlineReserve {
                seconds: 120,
                task_keys: vec!["implementation".into(), "review".into()],
            }),
        }
    }

    fn plan() -> TaskGraphPlan {
        let policy = policy();
        TaskGraphPlan {
            deadline: Some(policy.clone()),
            strategy: "pipeline".into(),
            max_nodes: 3,
            max_depth: 2,
            budget_tokens: 900,
            budget_cost_microusd: 900_000,
            staffing: Vec::new(),
            tasks: ["research", "implementation", "review"]
                .into_iter()
                .enumerate()
                .map(|(depth, key)| PlannedTask {
                    key: key.into(),
                    title: key.into(),
                    assigned_agent_id: uuid::Uuid::new_v4(),
                    required_adapter: "fake-process".into(),
                    depends_on: match depth {
                        1 => vec!["research".into()],
                        2 => vec!["implementation".into()],
                        _ => vec![],
                    },
                    depth: depth as i32,
                    max_attempts: 1,
                    verification_policy: VerificationPolicy {
                        checks: vec![],
                        manual_gate: None,
                    },
                    contract: TaskContract {
                        objective: key.into(),
                        expected_output: "result.md".into(),
                        source_repository: None,
                        source_base_ref: None,
                        source_base_commit: None,
                        workspace_connection_id: None,
                        acceptance_tests: vec![],
                        allowed_tools: vec![],
                        prohibited_actions: vec![],
                        references: vec![],
                        write_scope: vec!["result.md".into()],
                        budget_tokens: 300,
                        budget_cost_microusd: 300_000,
                        deadline_at: Some(policy.deadline_at),
                        escalation: "fail the contract".into(),
                        secret_refs: vec![],
                        model: None,
                        reasoning_effort: None,
                        deliverable: None,
                    },
                })
                .collect(),
        }
    }

    #[test]
    fn reserve_requires_a_declared_descendant_closed_suffix() {
        assert!(plan().validate_deadline().is_ok());
        for keys in [
            vec![],
            vec!["implementation"],
            vec!["research", "review"],
            vec!["review", "review"],
            vec!["unknown"],
            vec!["research", "implementation", "review"],
        ] {
            let mut plan = plan();
            plan.deadline
                .as_mut()
                .unwrap()
                .reserve
                .as_mut()
                .unwrap()
                .task_keys = keys.into_iter().map(str::to_owned).collect();
            assert!(plan.validate_deadline().is_err());
        }
        let mut final_only = plan();
        final_only
            .deadline
            .as_mut()
            .unwrap()
            .reserve
            .as_mut()
            .unwrap()
            .task_keys = vec!["review".into()];
        assert!(final_only.validate_deadline().is_ok());
    }

    #[test]
    fn reserve_cannot_protect_one_parallel_specialist_before_its_sibling_finishes() {
        let mut plan = plan();
        for (task, key) in plan
            .tasks
            .iter_mut()
            .zip(["specialist-a", "specialist-b", "synthesis"])
        {
            task.key = key.into();
        }
        plan.tasks[1].depends_on.clear();
        plan.tasks[1].depth = 0;
        plan.tasks[2].depends_on = vec!["specialist-a".into(), "specialist-b".into()];
        plan.tasks[2].depth = 1;
        plan.deadline
            .as_mut()
            .unwrap()
            .reserve
            .as_mut()
            .unwrap()
            .task_keys = vec!["specialist-a".into(), "synthesis".into()];
        assert!(plan.validate_deadline().is_err());
        plan.deadline
            .as_mut()
            .unwrap()
            .reserve
            .as_mut()
            .unwrap()
            .task_keys = vec!["synthesis".into()];
        assert!(plan.validate_deadline().is_ok());
    }

    #[test]
    fn reserve_accepts_parallel_final_tasks_after_all_earlier_work() {
        let mut plan = plan();
        let mut second_review = plan.tasks[2].clone();
        second_review.key = "second-review".into();
        plan.tasks.push(second_review);
        plan.max_nodes = 4;
        plan.deadline
            .as_mut()
            .unwrap()
            .reserve
            .as_mut()
            .unwrap()
            .task_keys = vec!["review".into(), "second-review".into()];
        assert!(plan.validate_deadline().is_ok());
    }

    #[test]
    fn task_contracts_cannot_drop_or_extend_the_shared_deadline() {
        for changed in [None, Some(policy().deadline_at + TimeDelta::seconds(1))] {
            let mut plan = plan();
            plan.tasks[1].contract.deadline_at = changed;
            assert!(plan.admit_deadline_at(start()).is_err());
        }
        let mut untimed = plan();
        untimed.deadline = None;
        assert!(untimed.validate_deadline().is_err());
        for task in &mut untimed.tasks {
            task.contract.deadline_at = None;
        }
        assert!(
            untimed
                .admit_deadline_at(start() + TimeDelta::days(365))
                .is_ok()
        );
        assert!(
            !serde_json::to_value(&untimed)
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("deadline")
        );
    }

    #[test]
    fn exhausted_stage_rejects_creation_without_resetting_budget_or_fabricating_handoff() {
        let plan = plan();
        let before = serde_json::to_value(&plan).unwrap();
        assert!(
            plan.admit_deadline_at(start() + TimeDelta::seconds(479))
                .is_ok()
        );
        assert!(
            plan.admit_deadline_at(start() + TimeDelta::seconds(480))
                .is_err()
        );
        assert!(
            plan.admit_deadline_at(start() + TimeDelta::seconds(600))
                .is_err()
        );
        assert_eq!(serde_json::to_value(&plan).unwrap(), before);
    }

    #[test]
    fn no_reserve_shares_the_exact_deadline_without_an_inferred_split() {
        let mut plan = plan();
        plan.deadline.as_mut().unwrap().reserve = None;
        assert!(
            plan.admit_deadline_at(start() + TimeDelta::seconds(599))
                .is_ok()
        );
        for task in &plan.tasks {
            let allowance = plan
                .deadline
                .as_ref()
                .unwrap()
                .allowance_at(&task.key, start() + TimeDelta::seconds(599))
                .unwrap();
            assert_eq!(allowance.remaining_ms, 1_000);
            assert_eq!(allowance.task_deadline_at, allowance.mission_deadline_at);
        }
        assert!(
            plan.admit_deadline_at(start() + TimeDelta::seconds(600))
                .is_err()
        );
    }

    #[test]
    fn queue_parent_restart_and_verifier_delays_consume_one_clock() {
        let policy = policy();
        for (stage, task, elapsed_seconds, expected_ms) in [
            ("created", "research", 0, 480_000),
            ("queue_delay", "research", 300, 180_000),
            ("parent_delay", "implementation", 470, 130_000),
            ("restart_resume_delay", "implementation", 550, 50_000),
            ("verifier_delay", "review", 599, 1_000),
        ] {
            let now = start() + TimeDelta::seconds(elapsed_seconds);
            let allowance = policy.allowance_at(task, now).unwrap();
            eprintln!(
                "ISSUE298_FAKE_CLOCK {}",
                serde_json::json!({
                    "stage": stage, "task_key": task, "elapsed_seconds": elapsed_seconds,
                    "clock": "supplied-test-time", "observed_allowance": allowance,
                })
            );
            assert_eq!(allowance.remaining_ms, expected_ms);
            assert_eq!(allowance.mission_deadline_at, policy.deadline_at);
        }
        let expired_at = start() + TimeDelta::seconds(600);
        let expired = policy.allowance_at("review", expired_at).unwrap_err();
        eprintln!(
            "ISSUE298_FAKE_CLOCK {}",
            serde_json::json!({
                "stage": "expired_dispatch", "task_key": "review", "elapsed_seconds": 600,
                "clock": "supplied-test-time", "sampled_at": expired_at,
                "mission_deadline_at": policy.deadline_at, "observed_error": expired,
            })
        );
        assert_eq!(policy.deadline_at, start() + TimeDelta::seconds(600));
    }

    #[test]
    fn reserve_expiration_denies_parent_without_extending_or_completing_it() {
        assert!(
            policy()
                .allowance_at("research", start() + TimeDelta::seconds(480))
                .is_err()
        );
        assert!(
            policy()
                .allowance_at("research", start() + TimeDelta::seconds(900))
                .is_err()
        );
        assert_eq!(
            policy()
                .allowance_at("implementation", start() + TimeDelta::seconds(480))
                .unwrap()
                .remaining_ms,
            120_000
        );
    }

    #[test]
    fn transit_and_local_clock_cannot_increase_dispatch_allowance() {
        let deadline = policy()
            .allowance_at("research", start() + TimeDelta::seconds(300))
            .unwrap();
        assert_eq!(
            deadline
                .remaining_at(start() + TimeDelta::seconds(330))
                .unwrap(),
            150_000
        );
        assert_eq!(
            deadline
                .remaining_at(start() - TimeDelta::seconds(60))
                .unwrap(),
            180_000
        );
        assert!(
            deadline
                .remaining_at(start() + TimeDelta::seconds(480))
                .is_err()
        );
    }

    #[test]
    fn invalid_native_allowance_and_duration_overflow_fail_closed() {
        let mut deadline = policy().allowance_at("research", start()).unwrap();
        deadline.remaining_ms += 1;
        assert!(deadline.remaining_at(start()).is_err());
        let mut invalid = policy();
        invalid.reserve.as_mut().unwrap().seconds = u64::MAX;
        assert!(invalid.allowance_at("implementation", start()).is_err());
        invalid.reserve.as_mut().unwrap().seconds = 0;
        assert!(invalid.allowance_at("implementation", start()).is_err());
    }
}
