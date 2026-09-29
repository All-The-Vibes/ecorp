//! Two mission roles using the existing verified dependency-file handoff.
//! Both examine the same selected source; an agent review is not a human decision.

use super::*;

pub(super) struct TestReviewStrategy;

impl ManagerStrategy for TestReviewStrategy {
    fn id(&self) -> &'static str {
        "test-review"
    }

    fn plan(&self, request: &PlanningRequest<'_>, agents: &[Agent]) -> Result<TaskGraphPlan> {
        let candidates = ordered_candidates(agents);
        let choose = |role: &str| {
            candidates
                .iter()
                .copied()
                .find(|agent| {
                    agent.role == role
                        && request
                            .preferred_adapter
                            .is_none_or(|adapter| agent.adapter == adapter)
                })
                .with_context(|| {
                    format!("test-review requires a {role} with the requested adapter")
                })
        };
        let tester = choose("tester")?;
        let reviewer = choose("reviewer")?;
        if tester.id == reviewer.id {
            return Err(anyhow!(
                "test-review requires two distinct agent identities"
            ));
        }
        let budget_tokens = request.budget_tokens.unwrap_or(240_000);
        if !(2..=MAX_GRAPH_BUDGET_TOKENS).contains(&budget_tokens) {
            return Err(anyhow!(
                "test-review token budget must fund two tasks within the graph limit"
            ));
        }
        let test_tokens = budget_tokens / 2;
        let budget_cost_microusd = request.budget_cost_microusd.unwrap_or(2_000_000);
        let costs =
            strategy_cost_budgets(self.id(), budget_cost_microusd).map_err(anyhow::Error::msg)?;
        let (test_model, test_reasoning) = provider_settings(request, &tester.adapter);
        let (review_model, review_reasoning) = provider_settings(request, &reviewer.adapter);
        let mut test_contract = contract(
            format!(
                "Test the selected immutable source for this mission: {}.\n\
                 Identify and run relevant available checks. Record exact commands, observed \
                 results, failures, skipped checks, source identity and remaining limitations. \
                 Do not change the source under test or claim unexecuted checks passed.",
                request.mission_title
            ),
            "Verified test observations",
            test_tokens,
        );
        test_contract.budget_cost_microusd = costs[0];
        test_contract.model = test_model;
        test_contract.reasoning_effort = test_reasoning;
        let mut test = PlannedTask {
            key: "tester".to_owned(),
            title: "Test the selected source".to_owned(),
            contract: test_contract,
            assigned_agent_id: tester.id,
            required_adapter: tester.adapter.clone(),
            depends_on: Vec::new(),
            depth: 0,
            max_attempts: 2,
            verification_policy: artifact_policy(),
        };
        declare_research_handoff(&mut test, request.handoff_root.unwrap_or("handoffs"))?;

        let mut review_contract = contract(
            format!(
                "Review the selected immutable source and the tester's verified evidence for \
                 this mission: {}.\n\
                 Read every declared tester note and probe from its exact materialized path \
                 in your own workspace. Independently inspect the same source and assess the \
                 actual checks, findings and missing evidence. Produce a final review report \
                 with source references and remaining limitations. Missing or unusable handoff \
                 contents require escalation; never infer them from summaries or a sibling \
                 worktree. Do not modify the source under review. This agent report does not \
                 grant a human approval, authorize a merge or satisfy a required human decision.",
                request.mission_title
            ),
            "A source-backed review report assessing the tester's evidence and remaining findings",
            budget_tokens - test_tokens,
        );
        review_contract.budget_cost_microusd = costs[1];
        review_contract.model = review_model;
        review_contract.reasoning_effort = review_reasoning;
        review_contract.references = vec!["task:tester".to_owned()];
        review_contract.prohibited_actions.extend([
            "modify the source under review".to_owned(),
            "substitute an agent report for a required human decision".to_owned(),
        ]);
        review_contract.deliverable = request.deliverable.cloned();
        Ok(TaskGraphPlan {
            strategy: self.id().to_owned(),
            max_nodes: 2,
            max_depth: 1,
            budget_tokens,
            budget_cost_microusd,
            staffing: Vec::new(),
            tasks: vec![
                test,
                PlannedTask {
                    key: "reviewer".to_owned(),
                    title: "Review the source and test evidence".to_owned(),
                    contract: review_contract,
                    assigned_agent_id: reviewer.id,
                    required_adapter: reviewer.adapter.clone(),
                    depends_on: vec!["tester".to_owned()],
                    depth: 1,
                    max_attempts: 2,
                    verification_policy: artifact_policy(),
                },
            ],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn request() -> PlanningRequest<'static> {
        PlanningRequest {
            mission_title: "Check the selected revision",
            preferred_adapter: Some("github-copilot"),
            preferred_model: Some("fixture-model"),
            reasoning_effort: Some("high"),
            secret_refs: &[],
            budget_tokens: None,
            budget_cost_microusd: None,
            max_task_attempts: None,
            deliverable: None,
            handoff_root: Some("docs/handoffs"),
        }
    }

    fn roster() -> Vec<Agent> {
        crate::staffing::candidates(Uuid::new_v4(), "test-review", "github-copilot", &[])
            .unwrap()
            .0
    }

    #[test]
    fn roles_are_distinct_and_review_waits_for_exact_verified_test_files() {
        let agents = roster();
        let plan = StrategyRegistry::new()
            .plan("test-review", &request(), &agents)
            .unwrap();
        assert_eq!((plan.max_nodes, plan.max_depth), (2, 1));
        let test = &plan.tasks[0];
        let review = &plan.tasks[1];
        assert_ne!(test.assigned_agent_id, review.assigned_agent_id);
        assert!(test.depends_on.is_empty());
        assert_eq!(review.depends_on, ["tester"]);
        assert_eq!(review.contract.references, ["task:tester"]);
        let files = ["docs/handoffs/tester.md", "docs/handoffs/tester-probe.json"];
        assert_eq!(test.contract.write_scope, files);
        let deliverable = test.contract.deliverable.as_ref().unwrap();
        assert_eq!(deliverable.form, DeliverableForm::TypedArtifactSet);
        assert!(!deliverable.commit_after_verification);
        assert_eq!(deliverable.paths, files);
        assert_eq!(test.verification_policy.checks.len(), 4);
        assert!(
            review
                .contract
                .objective
                .contains("required human decision")
        );
        assert!(review.contract.deliverable.is_none());
        for task in &plan.tasks {
            assert_eq!(task.required_adapter, "github-copilot");
            assert_eq!(task.contract.model.as_deref(), Some("fixture-model"));
            assert_eq!(task.contract.reasoning_effort.as_deref(), Some("high"));
            assert!(task.verification_policy.manual_gate.is_none());
            assert_eq!(task.max_attempts, 2);
        }
    }

    #[test]
    fn missing_unavailable_reused_or_wrong_adapter_roles_fail_closed() {
        let registry = StrategyRegistry::new();
        for invalid in 0..6 {
            let mut agents = roster();
            match invalid {
                0 => {
                    agents.pop();
                }
                1 => agents[0].role = "engineer".to_owned(),
                2 => agents[1].adapter = "fake-process".to_owned(),
                3 => agents[1].retired_at = Some(chrono::Utc::now()),
                4 => agents[0].status = AgentStatus::Offline,
                5 => agents[1].id = agents[0].id,
                _ => unreachable!(),
            }
            assert!(
                registry.plan("test-review", &request(), &agents).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn bounded_budgets_and_retries_do_not_expand_the_requested_allowance() {
        let registry = StrategyRegistry::new();
        for total in [2, 3, 240_001, MAX_GRAPH_BUDGET_TOKENS] {
            let request = PlanningRequest {
                budget_tokens: Some(total),
                budget_cost_microusd: Some(total),
                max_task_attempts: Some(1),
                ..request()
            };
            let plan = registry.plan("test-review", &request, &roster()).unwrap();
            assert_eq!(
                plan.tasks
                    .iter()
                    .map(|t| t.contract.budget_tokens)
                    .sum::<i64>(),
                total
            );
            assert_eq!(
                plan.tasks
                    .iter()
                    .map(|t| t.contract.budget_cost_microusd)
                    .sum::<i64>(),
                total
            );
            assert!(plan.tasks.iter().all(|t| t.max_attempts == 1));
        }
        for total in [i64::MIN, -1, 0, 1, MAX_GRAPH_BUDGET_TOKENS + 1, i64::MAX] {
            let request = PlanningRequest {
                budget_tokens: Some(total),
                ..request()
            };
            assert!(registry.plan("test-review", &request, &roster()).is_err());
        }
    }

    #[test]
    fn declared_final_output_does_not_replace_the_tester_handoff() {
        let output = DeliverableSpec {
            form: DeliverableForm::Archive,
            commit_after_verification: false,
            paths: vec!["review.md".to_owned()],
        };
        let request = PlanningRequest {
            deliverable: Some(&output),
            ..request()
        };
        let plan = StrategyRegistry::new()
            .plan("test-review", &request, &roster())
            .unwrap();
        assert_eq!(plan.tasks[1].contract.deliverable.as_ref(), Some(&output));
        assert_eq!(
            plan.tasks[0].contract.deliverable.as_ref().unwrap().form,
            DeliverableForm::TypedArtifactSet
        );
        for root in ["../outside", ".git", "handoffs/NUL", "one\\two"] {
            let request = PlanningRequest {
                handoff_root: Some(root),
                ..request
            };
            assert!(
                StrategyRegistry::new()
                    .plan("test-review", &request, &roster())
                    .is_err()
            );
        }
    }

    #[test]
    fn mission_contract_keeps_exact_tester_scope_and_final_human_gate() {
        use crony_protocol::FactoryMissionContract;

        let agents = roster();
        let mut plan = StrategyRegistry::new()
            .plan("test-review", &request(), &agents)
            .unwrap();
        let tester = plan.tasks[0].clone();
        let contract = FactoryMissionContract {
            objective: "Review this source without modifying its implementation".to_owned(),
            expected_output: "A final review report".to_owned(),
            acceptance_tests: vec!["The report references actual test observations".to_owned()],
            write_scope: vec!["docs/**".to_owned()],
            ..FactoryMissionContract::default()
        };
        crate::apply_mission_contract(&mut plan, &contract).unwrap();
        assert_eq!(
            plan.tasks[0].contract.write_scope,
            tester.contract.write_scope
        );
        assert_eq!(
            plan.tasks[0].contract.deliverable,
            tester.contract.deliverable
        );
        assert_eq!(
            plan.tasks[0].contract.expected_output,
            tester.contract.expected_output
        );
        assert_eq!(
            plan.tasks[0].contract.acceptance_tests,
            tester.contract.acceptance_tests
        );
        assert_eq!(plan.tasks[1].contract.write_scope, contract.write_scope);
        assert!(
            plan.tasks[1]
                .contract
                .acceptance_tests
                .contains(&contract.acceptance_tests[0])
        );

        let policy = VerificationPolicy {
            checks: vec![VerifierCheck::File {
                path: "docs/review.md".to_owned(),
                min_bytes: 1,
            }],
            manual_gate: Some(ManualVerificationGate::HumanApproval {
                roles: vec!["owner".to_owned()],
            }),
        };
        crate::apply_verification_policy(&mut plan, &policy);
        assert_eq!(
            plan.tasks[0].verification_policy,
            tester.verification_policy
        );
        assert_eq!(plan.tasks[1].verification_policy, policy);
        crate::enforce_factory_manual_gate(&mut plan);
        assert_eq!(plan.tasks[1].verification_policy, policy);
        plan.tasks[1].verification_policy.manual_gate = None;
        crate::enforce_factory_manual_gate(&mut plan);
        assert!(matches!(
            plan.tasks[1].verification_policy.manual_gate,
            Some(ManualVerificationGate::IndependentReview {
                exclude_requester: true,
                ..
            })
        ));
        assert_eq!(
            plan.tasks[0].verification_policy,
            tester.verification_policy
        );

        let mut outside = StrategyRegistry::new()
            .plan("test-review", &request(), &agents)
            .unwrap();
        let denied = FactoryMissionContract {
            write_scope: vec!["reports/**".to_owned()],
            ..contract
        };
        assert!(crate::apply_mission_contract(&mut outside, &denied).is_err());
    }

    #[test]
    fn reviewer_requires_verified_dependency_delivery_for_the_same_selected_source() {
        use crony_protocol::MissionSource;

        let mut plan = StrategyRegistry::new()
            .plan("test-review", &request(), &roster())
            .unwrap();
        let source = MissionSource {
            repository: "fixture/review".to_owned(),
            base_ref: "main".to_owned(),
            base_commit: "a".repeat(40),
        };
        crate::apply_mission_source(&mut plan, &source);
        let test = crate::RunnerRequirements::for_planned_task(&plan.tasks[0], &plan);
        let review = crate::RunnerRequirements::for_planned_task(&plan.tasks[1], &plan);
        assert!(test.canonical_source);
        assert!(!test.dependency_files);
        assert!(review.dependency_files);
        for task in [&test, &review] {
            assert_eq!(task.source_repository, Some(source.repository.as_str()));
            assert_eq!(task.source_base_ref, Some("main"));
            assert_eq!(task.source_base_commit, Some(source.base_commit.as_str()));
            assert_eq!(task.model, Some("fixture-model"));
            assert_eq!(task.reasoning_effort, Some("high"));
        }
        assert!(crate::needs_factory_staffing_source(
            Some("test-review"),
            Some("fake-process")
        ));
        assert!(crate::needs_factory_staffing_source(
            Some("test-review"),
            Some("github-copilot")
        ));
    }
}
