# Combined AI-Readiness — All-The-Vibes/ecorp

## 79.1 / 100   ·   Q2 Verifiable-but-manual   ·   R4 Delegable   ·   AI-Ready: no

_AI-Ready requires both Substrate and Operation scores to be at least 80._

**Requested mode:** evaluator-observed-local; **evidence mode:** evaluator-observed-local; **verification:** verified.
**Assessment scope:** repository. **Verification scope:** Native qualification of main396 plus Unicode fix: 3 cases, 9 bounded calls, fixed oracles, independent agent reviews. Retain 17 historical calls and 87,753 Factory tokens; recovery used 0. Owner approved 3aff250c. PR pending tool-policy refusal; CLI URL-case defect required API recovery. Local development identity; no production, sustained throughput or learning-gain claim..
_Compare requested mode, evaluator policy and declared scope; verification availability is an outcome. Local observation is not hosted or production qualification._

| Axis | Score | Level / Tier |
|------|------:|--------------|
| Substrate (codeblend) | 87.4 | L5 |
| Operation (rubric) | 71.5 | Agent-Enabled |

## Configured scan exclusions

This assessment used a repository-qualified scan policy. Compare scores only with runs using the same policy and scope; a policy change is not a source-code improvement.

- **Policy SHA-256:** `3bb02c591009d8557365d3950208a43ef4b8bafda524044725609f1b5fe6015f`
- No repository rules selected any paths.
- **Repository:** All-The-Vibes/ecorp

## How this score was calculated

**Headline** — geometric mean: sqrt(substrate * operation), rounded to one decimal place

```
sqrt(87.4 substrate * 71.5 operation) = 79.1
```

The geometric mean collapses toward the weaker axis, which here is **operation**.

### Substrate derivation — 87.4

Each pillar contributes `(level / 5) * 100 * weight` points.

| Pillar | Level | Weight | Contributes | Max |
|--------|------:|-------:|------------:|----:|
| Testing | L4 | 23% | 18.40 | 23.00 |
| Code Quality | L3 | 20% | 12.00 | 20.00 |
| Build System | L5 | 15% | 15.00 | 15.00 |
| Dev Environment | L5 | 12% | 12.00 | 12.00 |
| Style & Validation | L5 | 12% | 12.00 | 12.00 |
| Documentation | L5 | 10% | 10.00 | 10.00 |
| Security & Governance | L5 | 8% | 8.00 | 8.00 |
| **Total** | | **100%** | **87.4** | **100.00** |

Pillar levels above already include the advanced adjustment of **+7.0**; before it the weighted pillar score was **80.4**.

Maturity **L5 Autonomous** — the L5 band starts at 81.

### Operation derivation — 71.50

Each dimension contributes `(rawScore / 4) * weight` points.

| Dimension | Raw | Weight | Contributes |
|-----------|----:|-------:|------------:|
| agent-interface-operability | 3/4 | 9 | 6.75 |
| automation-coverage | 3/4 | 13 | 9.75 |
| self-healing-cicd | 3/4 | 18 | 13.50 |
| continuous-improvement-loops | 2/4 | 13 | 6.50 |
| agent-execution-surfaces | 3/4 | 9 | 6.75 |
| policy-safety-guardrails | 3/4 | 10 | 7.50 |
| observability | 4/4 | 9 | 9.00 |
| human-on-the-loop | 3/4 | 9 | 6.75 |
| agentic-change-throughput | 2/4 | 10 | 5.00 |
| **Total** | | **100** | **71.50** |

Tier **Agent-Enabled** — that band starts at 60.

## Substrate detail — why each pillar scored what it did

### Code Quality — L3 (weight 20%, contributes 12.00)

Rule `code-quality/L3.structured` assigned L3 — organized structure with entry points and few oversized files.
Rule tested: ✓ `total_code_files >= 1`, ✓ `organized_structure`, ✓ `entry_points >= 1`, ✓ `files_over_large_threshold <= 3`

Satisfied: `good_modularity`, `modules_balanced`, `organized_structure`

Not satisfied: `low_coupling`

Observed: `avg_imports_per_file` = 10.4, `circular_dep_pairs` = 0, `cross_dir_import_pairs` = 2, `dirs_with_entry_point` = 3, `entry_points` = 14, `files_over_large_threshold` = 0, `high_import_files` = 41, `max_dir_concentration` = 37.5, `module_boundary_depth` = 1, `module_container` = _empty_, `module_count` = 6, `primary_language` = `.js`, `total_code_files` = 301, `total_lines` = 193283

- Codebase: 301 code files, ~193283 lines, primary language: .js
- Modules: 6 top dirs, largest has 38% of files
- Entry points: 14 (3/6 dirs have entry files)

**To reach the next level — L4** via `code-quality/L4.clean-modular` (organized structure with no oversized files, low coupling, and healthy modularity)

- `low_coupling` — currently false

Satisfying low_coupling raises Code Quality to L4.

### Testing — L4 (weight 23%, contributes 18.40)

Rule `testing/L4.suite+e2e+command` assigned L4 — a configured suite of at least five test files with end-to-end coverage and a discoverable test command; based only on recognized evidence: unassessed validation paths do not establish absence.
Rule tested: ✓ `test_files_count >= 5`, ✓ `test_config`, ✓ `e2e_tests`, ✓ `test_cmd_discoverable`, ✓ `testing_maturity_cap >= 4`

Satisfied: `e2e_tests`, `test_cmd_discoverable`, `test_config`

Observed: `inline_test_count` = 857, `test_code_files_count` = 64, `test_command_paths` = 1 item: `.github/workflows/ci.yml`, `test_files_count` = 135, `test_files_discovered_by_convention` = 65, `test_projects_count` = 7, `test_projects_runnable` = 7, `test_projects_with_execution` = 7, `testing_maturity_cap` = 4, `validation_discovery_limitations` = 17 items: `.github/workflows/ci-maintenance.yml: conditional PR reachability is not resolved`, `.github/workflows/ci-maintenance.yml: reusable actions, templates and non-POSIX commands are not followed`, `.github/workflows/ci-maintenance.yml: shell expansion is not resolved`, `.github/workflows/ci.yml: conditional PR reachability is not resolved`, `.github/workflows/ci.yml: non-POSIX workflow shell is not resolved`, `.github/workflows/ci.yml: non-default command execution context is not resolved`, `.github/workflows/ci.yml: reusable actions, templates and non-POSIX commands are not followed`, `.github/workflows/ci.yml: shell expansion is not resolved`, `.github/workflows/ci.yml: shell functions, control flow, expansions or redirections are not resolved`, `.github/workflows/repo-steward.yml: conditional PR reachability is not resolved`, `.github/workflows/repo-steward.yml: non-default command execution context is not resolved`, `.github/workflows/repository-checks.yml: conditional PR reachability is not resolved`, `.github/workflows/repository-checks.yml: non-default command execution context is not resolved`, `.github/workflows/repository-checks.yml: reusable actions, templates and non-POSIX commands are not followed`, `.github/workflows/security-scan.yml: reusable actions, templates and non-POSIX commands are not followed`, `.github/workflows/security-scan.yml: shell expansion is not resolved`, `.github/workflows/security-scan.yml: shell functions, control flow, expansions or redirections are not resolved`

- test_files_count counts dedicated test files plus production files containing inline tests; inline_test_count reports executable inline Rust test functions separately
- .github/workflows/ci-maintenance.yml: conditional PR reachability is not resolved
- .github/workflows/ci-maintenance.yml: reusable actions, templates and non-POSIX commands are not followed
- .github/workflows/ci-maintenance.yml: shell expansion is not resolved
- .github/workflows/ci.yml: conditional PR reachability is not resolved
- .github/workflows/ci.yml: non-POSIX workflow shell is not resolved
- .github/workflows/ci.yml: non-default command execution context is not resolved
- .github/workflows/ci.yml: reusable actions, templates and non-POSIX commands are not followed
- .github/workflows/ci.yml: shell expansion is not resolved
- .github/workflows/ci.yml: shell functions, control flow, expansions or redirections are not resolved
- .github/workflows/repo-steward.yml: conditional PR reachability is not resolved
- .github/workflows/repo-steward.yml: non-default command execution context is not resolved
- .github/workflows/repository-checks.yml: conditional PR reachability is not resolved
- .github/workflows/repository-checks.yml: non-default command execution context is not resolved
- .github/workflows/repository-checks.yml: reusable actions, templates and non-POSIX commands are not followed
- .github/workflows/security-scan.yml: reusable actions, templates and non-POSIX commands are not followed
- .github/workflows/security-scan.yml: shell expansion is not resolved
- .github/workflows/security-scan.yml: shell functions, control flow, expansions or redirections are not resolved

**To reach the next level:** no rule defines a level above L4 for Testing; this pillar is at its highest defined level

### Build System — L5 (weight 15%, contributes 15.00)

Rule `build-system/L4.ci+lock` assigned L4 — CI runs against committed dependency lock files.
Rule tested: ✓ `ci_cd`, ✓ `dependency_lock`
The advanced analyses then moved this pillar from L4 to L5.

Satisfied: `build_config`, `ci_cd`, `dependency_lock`

**To reach the next level:** no rule defines a level above L4 for Build System; this pillar is at its highest defined level

### Dev Environment — L5 (weight 12%, contributes 12.00)

Rule `dev-environment/L5.automated` assigned L5 — a dev container, setup scripts, an environment template, and at least four configured signals.
Rule tested: ✓ `dev_container`, ✓ `setup_scripts`, ✓ `env_example`, ✓ `configured_indicators >= 4`

Satisfied: `dev_container`, `env_example`, `ide_config`, `setup_scripts`, `version_management`

Observed: `configured_indicators` = 5

**To reach the next level:** no rule defines a level above L5 for Dev Environment; this pillar is at its highest defined level

### Documentation — L5 (weight 10%, contributes 10.00)

Rule `documentation/L5.spec-driven` assigned L5 — agent documentation plus harness or tool configuration and versioned specs.
Rule tested: ✓ `readme`, ✓ `readme_lines >= 20`, ✓ `architecture_docs`, ✓ `agent_docs`, ✓ `agent_harness_config`, ✓ `agent_tools_config`, ✓ `versioned_specs`

Satisfied: `agent_docs`, `agent_harness_config`, `agent_tools_config`, `architecture_docs`, `readme`, `versioned_specs`

Not satisfied: `api_docs`

Observed: `agent_doc_quality` = 1, `agent_harness_quality` = 0, `readme_lines` = 307, `subdirectory_agent_docs` = 2

- Harness config exists but is minimal

**To reach the next level:** no rule defines a level above L5 for Documentation; this pillar is at its highest defined level

### Security & Governance — L5 (weight 8%, contributes 8.00)

Rule `security-governance/L4.secret-detection` assigned L4 — secrets ignored and secret detection configured.
Rule tested: ✓ `gitignore`, ✓ `ignores_secrets`, ✓ `secret_detection`
The advanced analyses then moved this pillar from L4 to L5.

Satisfied: `gitignore`, `ignores_secrets`, `secret_detection`

Not satisfied: `component_governance`, `ms_security_tools`, `sast`

**To hold this level on rules alone — L5** via `security-governance/L5.scanning+sast` (secrets ignored, secret detection configured, and static analysis in place)

- `sast` — currently false

Satisfying sast raises Security & Governance to L5.

### Style & Validation — L5 (weight 12%, contributes 12.00)

Rule `style-validation/L4.lint+format+hooks+types` assigned L4 — linting, formatting, local hooks, and type checking are all enforced; based only on recognized evidence: unassessed validation paths do not establish absence.
Rule tested: ✓ `linter`, ✓ `formatter`, ✓ `pre_commit_hooks`, ✓ `type_checking`
The advanced analyses then moved this pillar from L4 to L5.

Satisfied: `formatter`, `linter`, `pre_commit_hooks`, `type_checking`

Not satisfied: `csharp_analyzer_packages`, `stylecop_configured`

Observed: `formatter_command_paths` = 1 item: `.github/workflows/ci.yml`, `linter_command_paths` = 1 item: `.github/workflows/ci.yml`, `type_checking_command_paths` = 1 item: `.github/workflows/ci.yml`, `validation_discovery_limitations` = 17 items: `.github/workflows/ci-maintenance.yml: conditional PR reachability is not resolved`, `.github/workflows/ci-maintenance.yml: reusable actions, templates and non-POSIX commands are not followed`, `.github/workflows/ci-maintenance.yml: shell expansion is not resolved`, `.github/workflows/ci.yml: conditional PR reachability is not resolved`, `.github/workflows/ci.yml: non-POSIX workflow shell is not resolved`, `.github/workflows/ci.yml: non-default command execution context is not resolved`, `.github/workflows/ci.yml: reusable actions, templates and non-POSIX commands are not followed`, `.github/workflows/ci.yml: shell expansion is not resolved`, `.github/workflows/ci.yml: shell functions, control flow, expansions or redirections are not resolved`, `.github/workflows/repo-steward.yml: conditional PR reachability is not resolved`, `.github/workflows/repo-steward.yml: non-default command execution context is not resolved`, `.github/workflows/repository-checks.yml: conditional PR reachability is not resolved`, `.github/workflows/repository-checks.yml: non-default command execution context is not resolved`, `.github/workflows/repository-checks.yml: reusable actions, templates and non-POSIX commands are not followed`, `.github/workflows/security-scan.yml: reusable actions, templates and non-POSIX commands are not followed`, `.github/workflows/security-scan.yml: shell expansion is not resolved`, `.github/workflows/security-scan.yml: shell functions, control flow, expansions or redirections are not resolved`

- .github/workflows/ci-maintenance.yml: conditional PR reachability is not resolved
- .github/workflows/ci-maintenance.yml: reusable actions, templates and non-POSIX commands are not followed
- .github/workflows/ci-maintenance.yml: shell expansion is not resolved
- .github/workflows/ci.yml: conditional PR reachability is not resolved
- .github/workflows/ci.yml: non-POSIX workflow shell is not resolved
- .github/workflows/ci.yml: non-default command execution context is not resolved
- .github/workflows/ci.yml: reusable actions, templates and non-POSIX commands are not followed
- .github/workflows/ci.yml: shell expansion is not resolved
- .github/workflows/ci.yml: shell functions, control flow, expansions or redirections are not resolved
- .github/workflows/repo-steward.yml: conditional PR reachability is not resolved
- .github/workflows/repo-steward.yml: non-default command execution context is not resolved
- .github/workflows/repository-checks.yml: conditional PR reachability is not resolved
- .github/workflows/repository-checks.yml: non-default command execution context is not resolved
- .github/workflows/repository-checks.yml: reusable actions, templates and non-POSIX commands are not followed
- .github/workflows/security-scan.yml: reusable actions, templates and non-POSIX commands are not followed
- .github/workflows/security-scan.yml: shell expansion is not resolved
- .github/workflows/security-scan.yml: shell functions, control flow, expansions or redirections are not resolved

**To reach the next level:** no rule defines a level above L4 for Style & Validation; this pillar is at its highest defined level

## Operation detail — why each dimension scored what it did

### Agent Interface & Operability — 3/4 (weight 9, contributes 6.75) · Strength

Effective score set by the **model panel**.

| Judge model | Score | Rationale |
|-------------|------:|-----------|
| claude-opus-5 | 3/4 | Three AGENTS.md files, devcontainer, MCP config, skill and PR-reachable cargo fmt/clippy/test give a bootstrap-validate path, but agentAuthoredMergedCount=0 shows no demonstrated compliant agent PR, so not verified autonomous. |
| gpt-6-astra | 3/4 | Agent instructions, a reproducible development environment and PR-reachable validation support integrated operability. A completed, accepted agent PR path is not demonstrated. |
| grok-4.6 | 3/4 | AGENTS.md (root and nested), devcontainer bootstrap, MCP config, skills, and PR-reachable cargo fmt/clippy/test form an integrated agent path. No shipped MCP servers or merged agent PRs for closed-loop credit. |

Panel spread 0.

Floor **3** via `agent-interface-operability/L3.docs+machine-surface` — agent instructions plus a machine-operable surface establish integrated operability.
Satisfied by: `agentSurfaces.agentsMdPaths`, `agentSurfaces.mcpConfigPaths`, `agentSurfaces.skillFiles`

Evidence cited: `agentSurfaces.agentsMdPaths`, `files.devcontainer`, `agentSurfaces.devcontainerPaths`, `validationCommands`

Rubric constraint: For D1, MCP servers or skills alone do not establish integrated operability. When agent instructions and a reproducible bootstrap-validation-compliant-PR path are absent, cap D1 at 2. Lifted by `a reproducible bootstrap, validation, and compliant-PR path alongside agent instructions`.

**To raise this dimension:** no deterministic floor establishes a higher score for this dimension; the remaining distance is a panel judgement, and score 4 is reserved for a verified closed loop

### Automation Coverage for Routine Maintenance — 3/4 (weight 13, contributes 9.75) · Strength

Effective score set by the **model panel**.

| Judge model | Score | Rationale |
|-------------|------:|-----------|
| claude-opus-5 | 3/4 | Workflow chaining via workflow_run, manual dispatch, steward/maintenance pipelines and ADR-0022 idempotent PR publication with recurring-audit evidence; no scheduled workflow (hasScheduledWorkflow=false) limits unattended maintenance. |
| gpt-6-astra | 3/4 | Machine-triggerable workflows and chaining integrate maintenance automation. Verified recurring-audit deduplication and repeat no-op behavior strengthen reliability, but do not establish closure of the complete maintenance-to-accepted-PR lifecycle. |
| grok-4.6 | 3/4 | Workflow chaining, machine-triggerable surfaces, PR validation, and repo-steward/ci-maintenance pipelines show integrated maintenance. No scheduled workflow or verified unattended closed loop. |

Panel spread 0.

Floor **3** via `automation-coverage/L3.chaining` — workflow chaining across at least two pipelines.
Satisfied by: `ci.effectivePipelineCount`, `ci.hasWorkflowChaining`

Evidence cited: `ci.hasWorkflowChaining`, `ci.pipelineFiles`, `agentSurfaces.machineTriggerable`, `executionVerification.observations`

**To raise this dimension:** no deterministic floor establishes a higher score for this dimension; the remaining distance is a panel judgement, and score 4 is reserved for a verified closed loop

### Self-Healing CI/CD — 3/4 (weight 18, contributes 13.50) · Strength

Effective score set by the **model panel**.

| Judge model | Score | Rationale |
|-------------|------:|-----------|
| claude-opus-5 | 3/4 | Evaluator-observed native runs show two failure classes with 1,0,0 repair/validation pairs, escalation and repeat no-op handling, but selfHealing.hasRollbackPath=false caps this dimension at 3. |
| gpt-6-astra | 3/4 | Authorized evaluator-observed execution verifies multiple failure classes, repair/validation pairs, rollback, escalation and connected handoffs. Nevertheless, the explicit rubric cap limits D3 to 3 because selfHealing.hasRollbackPath is false. |
| grok-4.6 | 3/4 | Evaluator-observed verification covers multiple failure classes, repair/validation pairs, CI intake, and rollback. selfHealing.hasRollbackPath is false, so D3 is capped at 3. |

Panel spread 0.

Floor **1** via `self-healing-cicd/L1.pr-detection` — meaningful PR validation establishes automated failure detection.
Satisfied by: `ci.effectivePrValidation`

Evidence cited: `selfHealing.hasRollbackPath`, `executionVerification.facts`, `executionVerification.observations`, `executionVerification.recovery`, `executionVerification.facts.multipleFailureClassesVerified`, `executionVerification.facts.automaticRollbackVerified`

Rubric constraint: D3 is capped at 3 when selfHealing.hasRollbackPath is false. Lifted by `selfHealing.hasRollbackPath`.

**To raise this dimension:** no deterministic floor establishes a higher score for this dimension; the remaining distance is a panel judgement, and score 4 is reserved for a verified closed loop

### Continuous Improvement Loops — 2/4 (weight 13, contributes 6.50) · On track

Effective score set by the **model panel**.

| Judge model | Score | Rationale |
|-------------|------:|-----------|
| claude-opus-5 | 3/4 | Recurring-audit dedupe and feedback-expiry cases with proof-of-fix pairs, evidence reports and evidence-gated ADRs show governed loops, but no bounded active learned-rule corpus with candidate/active/retired promotion is evidenced. |
| gpt-6-astra | 2/4 | Recurring audits, feedback handling and verified proof-of-fix support repeatable improvement. No governed learned-rule corpus, repeated-evidence promotion or candidate-active-retired rule lifecycle is established. |
| grok-4.6 | 2/4 | Recurring-audit and feedback scenarios with proof-style artifacts show repeatable review/fix loops. No governed learned-rule corpus or candidate-active-retired promotion; pack disclaims learning-gain. |

Panel spread 1.

Floor: none — no floor rule satisfied; no deterministic minimum established.

Evidence cited: `observability.reportArtifactPaths`, `executionVerification.observations`, `executionVerification.facts.repairValidationPairsVerified`

**To raise this dimension — L3** via `continuous-improvement-loops/L3.scheduled-review` (scheduled workflows feeding agent review or agentic workflows)

- `ci.effectiveScheduledWorkflow` — currently false
- `governance.agentReviewConfigFiles >= 1` — currently 0

Satisfying ci.effectiveScheduledWorkflow and governance.agentReviewConfigFiles >= 1 guarantees at least 3/4 regardless of what the model panel returns.

### Agent Execution Surfaces — 3/4 (weight 9, contributes 6.75) · Strength

Effective score set by the **deterministic floor**.

| Judge model | Score | Rationale |
|-------------|------:|-----------|
| claude-opus-5 | 2/4 | Machine-triggerable workflows and one curated skill exist, but mcpServersShipped is empty (config-only .mcp.json/.codex), no prompt files and no agentic workflow files, so surfaces stay repeatable not integrated. |
| gpt-6-astra | 3/4 | Machine-triggerable execution, a repository-specific operations skill and verified isolated local execution provide integrated surfaces. No shipped MCP server or hostile-source sandbox is evidenced; configuration alone does not establish autonomous closure. |
| grok-4.6 | 2/4 | Machine-triggerable workflows, one operations skill, and MCP/devcontainer configs are repeatable execution surfaces. No shipped MCP servers, agentic workflows, or PR-lifecycle skills for integration. |

Panel spread 1.

Floor **3** via `agent-execution-surfaces/L3.skills+mcp-config` — curated skills combined with MCP configuration. This floor, not the model panel, set the effective score.
Satisfied by: `agentSurfaces.mcpConfigPaths`, `agentSurfaces.skillFiles`

Evidence cited: `agentSurfaces.mcpServersShipped`, `agentSurfaces.skillFiles`, `agentSurfaces.machineTriggerable`, `executionVerification.environment`, `agentSurfaces.mcpConfigPaths`

**To raise this dimension:** no deterministic floor establishes a higher score for this dimension; the remaining distance is a panel judgement, and score 4 is reserved for a verified closed loop

### Policy, Safety, and Change Guardrails — 3/4 (weight 10, contributes 7.50) · Strength

Effective score set by the **model panel**.

| Judge model | Score | Rationale |
|-------------|------:|-----------|
| claude-opus-5 | 3/4 | Three rulesets enforce PR review, code-owner review, thread resolution, CodeQL scanning, code quality and six required checks; actions fully pinned and outputs bounded. No CODEOWNERS file and non-OS sandbox limits keep it below 4. |
| gpt-6-astra | 3/4 | Effective rules enforce reviews, owner approval, status checks and security gates; actions are pinned and execution bounds verified. The classic protection endpoint limitation does not negate observed rulesets. End-to-end autonomous policy closure is not established. |
| grok-4.6 | 3/4 | Rulesets enforce reviews, team reviewers, last-push approval, strict status checks, CodeQL, and Copilot review; actions are pinned. Classic CODEOWNERS file is absent; not a verified closed-loop. |

Panel spread 0.

Floor **2** via `policy-safety-guardrails/L2.partial` — a partial guardrail is present.
Satisfied by: `governance.actionsPinned`

Evidence cited: `governance.actionsPinned`, `apiEvidence.branchProtection.effectiveRules`, `executionVerification.limits`, `executionVerification.facts.policyBoundsVerified`, `apiEvidence.branchProtection.requiresStatusChecks`

**To raise this dimension:** no deterministic floor establishes a higher score for this dimension; the remaining distance is a panel judgement, and score 4 is reserved for a verified closed loop

### Observability of Agentic Work — 4/4 (weight 9, contributes 9.00) · Strength

Effective score set by the **model panel**.

| Judge model | Score | Rationale |
|-------------|------:|-----------|
| claude-opus-5 | 4/4 | Evaluator-observed, controller-authorized verification confirms agent-origin correlation, lifecycle traces, machine completion signals, consumer actions plus stale/duplicate and failure/recovery handling, meeting local-closed-loop L4 for observability. |
| gpt-6-astra | 4/4 | Authorized evaluator-observed local execution verifies agent-origin correlation, inspectable lifecycle outcomes, completion signals and consumer actions, including recovery and stale/duplicate handling. This meets local closed-loop criteria without hosted observation or signatures. |
| grok-4.6 | 4/4 | Evaluator-observed local closure verifies agent-origin correlation, inspectable lifecycle, machine completion signals, consumer actions, and stale/duplicate handling. Hosting and attestation are not required for local L4. |

Panel spread 0.

Floor **3** via `observability/L3.machine-consumable` — machine-consumable CI signals combined with labels or reporting.
Satisfied by: `ci.effectiveMachineConsumableSignals`, `observability.reportArtifactPaths`

Evidence cited: `executionVerification.facts`, `executionVerification.producerAuthorization`, `ci.machineConsumableSignals`, `executionVerification.origin`, `executionVerification.facts.machineCompletionSignalsVerified`, `executionVerification.facts.agentOriginCorrelated`, `executionVerification.facts.staleDuplicateHandlingVerified`

**To raise this dimension:** no deterministic floor establishes a higher score for this dimension; the remaining distance is a panel judgement, and score 4 is reserved for a verified closed loop

### Human-on-the-Loop Integration — 3/4 (weight 9, contributes 6.75) · Strength

Effective score set by the **model panel**.

| Judge model | Score | Rationale |
|-------------|------:|-----------|
| claude-opus-5 | 3/4 | Enforced approvals, team reviewer routing, last-push approval, Copilot code review on push, 36 structured labels and PR/issue templates support supervision; no compliant agent PRs merged and no CODEOWNERS file limits routing proof. |
| gpt-6-astra | 3/4 | Enforced human and owner reviews, automated agent review, structured routing labels and verified escalation integrate human supervision. A completed compliant agent PR and closed exception-to-acceptance lifecycle are not demonstrated. |
| grok-4.6 | 3/4 | Enforced human review, team routing, Copilot review, structured labels, and PR/issue templates provide integrated supervision. CODEOWNERS file missing; agent merged PRs not demonstrated. |

Panel spread 0.

Floor **3** via `human-on-the-loop/L3.agent-review-enforced` — agent code review is enforced at the runtime boundary.
Satisfied by: `apiEvidence.available`, `apiEvidence.branchProtection.agentCodeReviewEnforced`

Evidence cited: `apiEvidence.branchProtection.requiresCodeOwnerReview`, `apiEvidence.labels.count`, `governance.prTemplatePaths`, `apiEvidence.branchProtection.effectiveRules`, `apiEvidence.labels.names`, `executionVerification.facts.escalationVerified`, `apiEvidence.branchProtection.requiredApprovingReviewCount`

**To raise this dimension:** no deterministic floor establishes a higher score for this dimension; the remaining distance is a panel judgement, and score 4 is reserved for a verified closed loop

### Agentic Change Throughput & Contributor Mix — 2/4 (weight 10, contributes 5.00) · On track

Effective score set by the **model panel**.

| Judge model | Score | Rationale |
|-------------|------:|-----------|
| claude-opus-5 | 2/4 | Zero agent-authored merged PRs over 90 days and 0% agent authorship share; only 7 of 295 commits carry agent Co-authored-by trailers, so attributable agentic throughput is limited metadata-only despite enforced review. |
| gpt-6-astra | 2/4 | Seven agent-coauthored commits provide recurring but limited attribution alongside enforced review. Zero agent-authored merged PRs are observed in the window; material agentic throughput or measurable velocity impact is not established. |
| grok-4.6 | 2/4 | Seven agent co-authored commits with enforced review show limited repeatable attribution; zero agent-authored merged PRs and no throughput claim. Not material guarded volume. |

Panel spread 0.

Floor **2** via `agentic-change-throughput/L2.coauthored` — recurring agent co-authorship without enforced-review corroboration is metadata-only.
Satisfied by: `authorship.aiAgentCoauthored`

Ceiling **2** via `agentic-change-throughput/ceiling.unverified-authorship` — no API-confirmed agent-authored merged pull request; capped at 2 for metadata-only attribution.
Satisfied by: `apiEvidence.available`, `apiEvidence.mergedPRs.agentAuthoredMergedCount`

Evidence cited: `apiEvidence.mergedPRs.agentAuthoredMergedShare`, `authorship.aiAgentCoauthored`, `authorship.shares.aiAgent`, `apiEvidence.mergedPRs`, `apiEvidence.branchProtection.effectiveRules`, `apiEvidence.mergedPRs.agentAuthoredMergedCount`, `apiEvidence.branchProtection.requiredApprovingReviewCount`

Rubric constraint: D9 is capped at 2 for metadata-only attribution without enforced-review corroboration; recurring co-authorship with enforced human review can reach 3 but not 4. Lifted by `apiEvidence.mergedPRs.agentAuthoredMergedCount`.

**To raise this dimension — L3** via `agentic-change-throughput/L3.merged-3` (API evidence confirms at least three agent-authored merged pull requests)

- `apiEvidence.mergedPRs.agentAuthoredMergedCount >= 3` — currently 0

Satisfying apiEvidence.mergedPRs.agentAuthoredMergedCount >= 3 guarantees at least 3/4 regardless of what the model panel returns.
Alternative paths to L3: `agentic-change-throughput/L3.coauthored+enforced-review`

## Continuous cleanup automation

**Enrollment unverified** · 70/100

- Cleanup capability: detected with 135 executable or configured evidence file(s).
- Bounded repeatable driver: detected with 12 executable or configured evidence file(s).
- Concrete scheduler enrollment: not detected.
- Observed behavior: mutating.
- **Gap:** The cleanup driver is designed for repeated invocation, but concrete scheduler enrollment was not found.

## Remediation queue

### Substrate gaps (deterministic scaffolders)
- **Code Quality** (L3) → `code-level transform (Phase 3)`

### Operation gaps (RFC prompts, heaviest first)
- **continuous-improvement-loops** (2/4, w13) → `RFC-03`
- **agentic-change-throughput** (2/4, w10) → `RFC-05`

## Documentation drift controls

**Coverage:** Partial (based on executable behavior, not file presence or prose claims)

| Control | Scope | Trigger | Effect | Notes | Count |
|---------|-------|---------|--------|-------|------:|
| deterministic validation | targeted | PR | advisory report | no failure semantics | 1 |
| deterministic validation | targeted | manual | advisory report | no failure semantics | 1 |
| deterministic validation | targeted | manual | advisory report | unit tested, no failure semantics | 1 |
| deterministic validation | targeted | post-merge | advisory report | no failure semantics | 1 |

**Residual action:** Add checked-diff or fail-on-stale semantics to the existing documentation generation, then wire it into affected PR validation.

## Evidence appendix

<details>
<summary>Everything both axes were scored against</summary>

### Evidence pack

**agentSurfaces**

- `agentsMdPaths` = 3 items: `AGENTS.md`, `apps/web/AGENTS.md`, `tools/AGENTS.md`
- `copilotInstructionPaths` — _empty_
- `devcontainerPaths` = 2 items: `.devcontainer/Dockerfile`, `.devcontainer/devcontainer.json`
- `machineTriggerable` = true
- `mcpConfigPaths` = 2 items: `.codex/config.toml`, `.mcp.json`
- `mcpServersShipped` — _empty_
- `promptFiles` — _empty_
- `skillFiles` = 1 item: `.github/skills/ecorp-operations/SKILL.md`

**ci**

- `agenticWorkflowFiles` — _empty_
- `azurePipelineFiles` — _empty_
- `hasManualDispatch` = true
- `hasPrValidation` = true
- `hasScheduledWorkflow` = false
- `hasWorkflowChaining` = true
- `machineConsumableSignals` = 1 item: `workflow_run`
- `pipelineFiles` = 5 items: `.github/workflows/ci-maintenance.yml`, `.github/workflows/ci.yml`, `.github/workflows/repo-steward.yml`, `.github/workflows/repository-checks.yml`, `.github/workflows/security-scan.yml`
- `prWorkflowHasExplicitTestCommand` = true
- `workflowFiles` = 5 items: `.github/workflows/ci-maintenance.yml`, `.github/workflows/ci.yml`, `.github/workflows/repo-steward.yml`, `.github/workflows/repository-checks.yml`, `.github/workflows/security-scan.yml`

**governance**

- `actionsPinned` = true
- `agentReviewConfigFiles` — _empty_
- `branchPolicyFiles` — _empty_
- `codeownersPath` — _empty_
- `contributingPath` = `CONTRIBUTING.md`
- `issueTemplatePaths` = 3 items: `.github/ISSUE_TEMPLATE/bug.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/ISSUE_TEMPLATE/feature.yml`
- `labelConfigPaths` — _empty_
- `prTemplatePaths` = 1 item: `.github/pull_request_template.md`
- `unpinnedActions` — _empty_

**selfHealing**

- `hasRollbackPath` = false
- `signalFiles` — _empty_
- `signalsFound` — _empty_

**observability**

- `dashboardPaths` — _empty_
- `reportArtifactPaths` = 4 items: `docs/evidence/2026-09-18-recurring-audit.md`, `docs/evidence/assets/codeblend-readiness/local-recurring-audit.json`, `docs/reports/README.md`, `docs/reports/ecorp-codeblend-readiness-2026-09-18.html`

**docs**

- `adrPaths` = 24 items: `docs/adr/0001-greenfield-modular-monolith.md`, `docs/adr/0002-three-plane-architecture.md`, `docs/adr/0003-event-and-state-model.md`, `docs/adr/0004-agent-runner-boundary.md`, `docs/adr/0005-identity-and-secret-broker.md`, `docs/adr/0006-protocol-boundaries.md`, `docs/adr/0007-office-is-a-projection.md`, `docs/adr/0008-license-and-provenance.md`, `docs/adr/0009-worktree-isolation-and-preservation.md`, `docs/adr/0010-bounded-task-graph-strategies.md`, `docs/adr/0011-evidence-gated-completion.md`, `docs/adr/0012-oidc-authentication-and-corp-rbac.md`, `docs/adr/0013-runner-enrollment-and-rotating-identity.md`, `docs/adr/0014-scoped-secret-broker.md`, `docs/adr/0015-durable-action-approvals.md`, `docs/adr/0016-budget-circuit-breaker.md`, `docs/adr/0017-thin-tauri-desktop-shell.md`, `docs/adr/0018-normalized-external-cli-adapters.md`, `docs/adr/0019-external-protocol-gateways.md`, `docs/adr/0020-governed-factory-claims.md`, `docs/adr/0021-portable-source-deliverables.md`, `docs/adr/0022-idempotent-pull-request-publication.md`, `docs/adr/0023-authorized-mission-budget-recovery.md`, `docs/adr/0024-versioned-mission-contracts.md`
- `architectureDocPaths` = 1 item: `docs/ARCHITECTURE.md`
- `threatModelPaths` = 1 item: `docs/THREAT_MODEL.md`

**apiEvidence**

- `available` = true
- `branchProtection.activeRulesets` = 3
- `branchProtection.agentCodeReviewEnforced` = true
- `branchProtection.branch` = `main`
- `branchProtection.effectiveRules` = 1 item: 13 items: map[ruleset_id:2.3348877e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:deletion], map[ruleset_id:2.3348877e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:non_fast_forward], map[parameters:map[review_draft_pull_requests:true review_on_push:true] ruleset_id:2.3348877e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:copilot_code_review], map[ruleset_id:2.2420664e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:deletion], map[ruleset_id:2.2420664e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:non_fast_forward], map[ruleset_id:2.2420664e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:update], map[ruleset_id:2.2420664e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:creation], map[ruleset_id:2.3565201e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:non_fast_forward], map[parameters:map[allowed_merge_methods:[merge squash rebase] dismiss_stale_reviews_on_push:true dismissal_restriction:map[allowed_actors:[] enabled:false] require_code_owner_review:true require_extra_approval_for_unattributed_changes:true require_last_push_approval:true required_approving_review_count:1 required_review_thread_resolution:true required_reviewers:[map[file_patterns:[*] minimum_approvals:1 reviewer:map[id:1.9536566e+07 type:Team]]]] ruleset_id:2.3565201e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:pull_request], map[parameters:map[code_scanning_tools:[map[alerts_threshold:errors security_alerts_threshold:high_or_higher tool:CodeQL]]] ruleset_id:2.3565201e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:code_scanning], map[parameters:map[severity:errors] ruleset_id:2.3565201e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:code_quality], map[parameters:map[review_draft_pull_requests:false review_on_push:false] ruleset_id:2.3565201e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:copilot_code_review], map[parameters:map[do_not_enforce_on_create:false required_status_checks:[map[context:quality integration_id:15368] map[context:integration integration_id:15368] map[context:runner-platforms (ubuntu-latest) integration_id:15368] map[context:runner-platforms (windows-latest) integration_id:15368] map[context:runner-platforms (macos-latest) integration_id:15368] map[context:desktop-windows integration_id:15368]] strict_required_status_checks_policy:true] ruleset_id:2.3565201e+07 ruleset_source:All-The-Vibes/ecorp ruleset_source_type:Repository type:required_status_checks]
- `branchProtection.observable` = false
- `branchProtection.requiredApprovingReviewCount` = 1
- `branchProtection.requiresCodeOwnerReview` = true
- `branchProtection.requiresStatusChecks` = true
- `labels.count` = 36
- `labels.names` = 36 items: `accessibility`, `agent-runtime`, `area:docs`, `area:infra`, `area:protocol`, `area:runner`, `area:server`, `area:web`, `bug`, `dark-factory`, `dark-mode`, `dependencies`, `documentation`, `duplicate`, `enhancement`, `evals`, `executive-view`, `factory:ready`, `github_actions`, `good first issue`, `help wanted`, `invalid`, `javascript`, `multiplayer`, `priority:p0`, `priority:p1`, `priority:p2`, `question`, `rust`, `status:blocked`, `type:bug`, `type:feature`, `type:research`, `type:security`, `ui-ux`, `wontfix`
- `labels.namesDigest` = `371cf965cfdb9f08ed484c06a7502a036bc012d1aa2439ed528e729c5bdce7b7`
- `labels.observable` = true
- `limitations` = 1 item: `branchProtectionUnobservable`
- `mergedPRs.agentAuthoredMergedCount` = 0
- `mergedPRs.agentAuthoredMergedShare` = 0
- `mergedPRs.byAuthorType.agent` = 0
- `mergedPRs.byAuthorType.dependency` = 6
- `mergedPRs.byAuthorType.human` = 96
- `mergedPRs.byAuthorType.otherBot` = 0
- `mergedPRs.merged` = 102
- `mergedPRs.observable` = true
- `mergedPRs.windowDays` = 90
- `ownerRepo` = `All-The-Vibes/ecorp`
- `retrieval.endpoints` = 7 items: `GET /repos/{owner}/{repo}`, `GET /repos/{owner}/{repo}/branches/{branch}`, `GET /repos/{owner}/{repo}/rules/branches/{branch}`, `GET /repos/{owner}/{repo}/branches/{branch}/protection`, `GET /repos/{owner}/{repo}/labels`, `GET /repos/{owner}/{repo}/pulls`, `GET /repos/{owner}/{repo}/pulls`
- `retrieval.outcomes` = 7 items: map[availability:available endpoint:GET /repos/{owner}/{repo} retrievalMode:provider retrievedAt:2026-09-21T03:09:44Z status:200], map[availability:available endpoint:GET /repos/{owner}/{repo}/branches/{branch} retrievalMode:provider retrievedAt:2026-09-21T03:09:44Z status:200], map[availability:available endpoint:GET /repos/{owner}/{repo}/rules/branches/{branch} retrievalMode:provider retrievedAt:2026-09-21T03:09:44Z status:200], map[availability:not_found_or_hidden endpoint:GET /repos/{owner}/{repo}/branches/{branch}/protection retrievalMode:provider retrievedAt:2026-09-21T03:09:44Z status:404], map[availability:available endpoint:GET /repos/{owner}/{repo}/labels retrievalMode:provider retrievedAt:2026-09-21T03:09:44Z status:200], map[availability:available endpoint:GET /repos/{owner}/{repo}/pulls retrievalMode:provider retrievedAt:2026-09-21T03:09:44Z status:200], map[availability:available endpoint:GET /repos/{owner}/{repo}/pulls retrievalMode:provider retrievedAt:2026-09-21T03:09:44Z status:200]
- `retrieval.provenanceVersion` = 1
- `retrieval.retrievedAt` = `2026-09-21T03:09:44Z`
- `source` = `github`

**files**

- `agentsMd` = true
- `codeowners` = false
- `contributing` = true
- `copilotInstructions` = false
- `devcontainer` = true
- `mcpConfig` = true
- `skillsDir` = true

**authorship**

- `aiAgentCoauthored` = 7
- `byAuthorType.aiAgent` = 0
- `byAuthorType.ciAutomation` = 0
- `byAuthorType.dependencyAutomation` = 6
- `byAuthorType.human` = 289
- `byAuthorType.otherBot` = 0
- `note` = `Aggregate automation signal only - not per-person. Dependency/CI bots are generic automation, not agentic throughput. aiAgentCoauthored counts human-authored commits that credit an agent via Co-authored-by (overlaps byAuthorType, excluded from shares).`
- `shares.aiAgent` = 0
- `shares.ciAutomation` = 0
- `shares.dependencyAutomation` = 0.0203
- `shares.human` = 0.9797
- `shares.otherBot` = 0
- `totalCommits` = 295

**git**

- `shallow` = false
- `totalCommitsAllTime` = 426

**assessmentContext**

- `assessedScope` = `repository`
- `evidenceMode` = `evaluator-observed-local`
- `observationSHA256` = `8c061b2415089b77a338a88bd40ed4bcc43eb551775459968b3365adc5c4d5c9`
- `profileSHA256` = `c5ea84a171b0131aac0787e04f8bbe561e5a3ae00e51c79ebf22ac8c984c6718`
- `requestedMode` = `evaluator-observed-local`
- `verificationScope` = `Native qualification of main396 plus Unicode fix: 3 cases, 9 bounded calls, fixed oracles, independent agent reviews. Retain 17 historical calls and 87,753 Factory tokens; recovery used 0. Owner approved 3aff250c. PR pending tool-policy refusal; CLI URL-case defect required API recovery. Local development identity; no production, sustained throughput or learning-gain claim.`
- `verificationStatus` = `verified`
- `verifierSHA256` = `6f93505424fe3bd58433e8296446de1da5f0e27f2f47da2551db79709747ade7`
- `version` = 1

**executionVerification**

- `cryptographicAttestation` = `not-provided`
- `environment` = `isolated-local-workspaces`
- `facts.agentOriginCorrelated` = true
- `facts.automaticRollbackVerified` = true
- `facts.ciFailureIntakeObserved` = true
- `facts.closedHandoffsVerified` = true
- `facts.consumerActionsVerified` = true
- `facts.escalationVerified` = true
- `facts.executionVerified` = true
- `facts.humanInspectableOutcomesVerified` = true
- `facts.lifecycleTraceVerified` = true
- `facts.machineCompletionSignalsVerified` = true
- `facts.multipleFailureClassesVerified` = true
- `facts.policyBoundsVerified` = true
- `facts.repairValidationPairsVerified` = true
- `facts.repeatNoOpVerified` = true
- `facts.scopeCoverageVerified` = true
- `facts.sourceOracleBindingVerified` = true
- `facts.staleDuplicateHandlingVerified` = true
- `facts.terminalOutcomesVerified` = true
- `hostedObservation` = false
- `limits` = `Operator-approved trusted local code; not an OS sandbox for hostile source. Fixed commands, pinned tools/inputs, bounded output/time and unchanged primary source.`
- `method` = `fresh-native-execution`
- `observationSHA256` = `8c061b2415089b77a338a88bd40ed4bcc43eb551775459968b3365adc5c4d5c9`
- `observations` = 2 items: map[assessedSourceCheck:0 assessedTargetSHA256:83121f604ebb40ad4a2e2c091a4718f05e6021b3c4803a721ffad1d0a533ff45 completionConsumer:validated-current-no-op duplicateConsumer:validated-current-no-op failureClass:recurring-audit-dedupe independentNativeExitCodes:[1 0 0] nativeExitCodes:[1 0 0] oracleIdentity:e95f87bff75312a0b0153a2c4b02e513592a706d92c7b87f9d4db0887c30d89c provenance:<nil> repeatOwnerOutcome:no-op staleConsumer:review-new-source target:scenarios/repo-steward/lib/recurring-audit.mjs], map[assessedSourceCheck:0 assessedTargetSHA256:3c24b80c276a6aef9f284980b8c3be8bcb35c34dc7bc7307c8ae80047b3cdcba completionConsumer:validated-current-no-op duplicateConsumer:validated-current-no-op failureClass:feedback-expiry independentNativeExitCodes:[1 0 0] nativeExitCodes:[1 0 0] oracleIdentity:9dbbdce1deac314de02771336fb2bd39ff17f2db3ded964e41e15245fedbcde5 provenance:<nil> repeatOwnerOutcome:no-op staleConsumer:review-new-source target:scenarios/repo-steward/lib/feedback.mjs]
- `origin` = `evaluator-observed`
- `producerAuthorization` = `verified-by-assessment-controller-outside-candidate-control`
- `profileSHA256` = `c5ea84a171b0131aac0787e04f8bbe561e5a3ae00e51c79ebf22ac8c984c6718`
- `recovery` = `Actual rejected-proposal rollback and post-application process interruption/restoration, followed by escalation; explicit fault-injection controls.`
- `scope` = `Native qualification of main396 plus Unicode fix: 3 cases, 9 bounded calls, fixed oracles, independent agent reviews. Retain 17 historical calls and 87,753 Factory tokens; recovery used 0. Owner approved 3aff250c. PR pending tool-policy refusal; CLI URL-case defect required API recovery. Local development identity; no production, sustained throughput or learning-gain claim.`
- `status` = `verified`
- `timeoutSeconds` = 3600
- `verifierSHA256` = `6f93505424fe3bd58433e8296446de1da5f0e27f2f47da2551db79709747ade7`

**repo**

- `name` = `ecorp`
- `nameWithOwner` = `All-The-Vibes/ecorp`

**scanExclusions**

- `configurationSHA256` = `3bb02c591009d8557365d3950208a43ef4b8bafda524044725609f1b5fe6015f`
- `paths` — _empty_
- `repository` = `All-The-Vibes/ecorp`
- `repositoryIdentity` = `remote|github|github.com|all-the-vibes|ecorp`
- `schemaVersion` = 1

### Derived signals

Classifications the deterministic rules test that no single evidence-pack field expresses.

- `ci.effectivePrValidation` = true — meaningful PR validation from repository-native semantics or verified Azure DevOps runtime policy and execution. Derived from `ci.hasPrValidation`, `apiEvidence.source`, `apiEvidence.azurePipelines.prValidation.meaningful`.
- `ci.effectiveScheduledWorkflow` = false — scheduled automation is present in repository configuration or verified Azure DevOps runtime evidence. Derived from `ci.hasScheduledWorkflow`, `apiEvidence.azurePipelines.scheduledAutomation`.
- `ci.effectiveMachineConsumableSignals` = 1 — count of machine-consumable completion signals from repository or Azure DevOps runtime evidence. Derived from `ci.machineConsumableSignals`, `apiEvidence.azurePipelines.machineConsumableSignals`.
- `ci.effectivePipelineCount` = 5 — conservative pipeline breadth using the larger confirmed repository-file or enabled runtime-definition count. Derived from `ci.pipelineFiles`, `apiEvidence.azurePipelines.definitions.enabled`.
- `selfHealing.remediation` = false — a self-healing signal describes repair rather than containment, or signal files exist with no classified signals. Derived from `selfHealing.signalsFound`, `selfHealing.signalFiles`.
- `selfHealing.containment` = false — a self-healing signal describes containing a failure, such as quarantine, retry, or rerun. Derived from `selfHealing.signalsFound`.

### Repository-local LLM PR auditor

**Insufficient correlated evidence** for an LLM PR auditor.
**Detected platforms:** github_copilot.
**Evidence:** `.github/skills/ecorp-operations/SKILL.md`
- Warning: Missing evidence: llm evaluation, automatic PR trigger or manual invocation
- Limitation: Static repository evidence cannot prove that configured jobs currently run successfully.
- Limitation: Unreferenced configuration is supporting evidence only. Provider activation outside root GitHub workflows and their literal local invocation chains is unknown; Azure DevOps registration requires provider evidence.
- Limitation: Signals must share explicit file references, distinctive identifiers, or review-invocation semantics.
- Limitation: Merge gating is reported only when an explicit required status, policy, vote, or blocking rule is present.
- Limitation: Author coverage is inferred from trigger definitions; runtime policy APIs may provide stronger evidence.
- Limitation: .github/workflows/ci.yml: command execution is unknown: shell expansion is not resolved
- Limitation: .github/workflows/ci.yml: command execution is unknown: shell functions, control flow, expansions or redirections are not resolved
- Limitation: .github/workflows/ci.yml: conditional invocation is unknown
- Limitation: .github/workflows/ci.yml: interpreter invocation is not a supported literal script operand
- Limitation: .github/workflows/ci.yml: non-default execution context is unknown
- Limitation: .github/workflows/ci.yml: non-local or dynamic uses invocation is unknown
- Limitation: .github/workflows/repo-steward.yml: conditional invocation is unknown
- Limitation: .github/workflows/repo-steward.yml: non-default execution context is unknown
- Limitation: .github/workflows/repository-checks.yml: conditional invocation is unknown
- Limitation: .github/workflows/repository-checks.yml: interpreter invocation is not a supported literal script operand
- Limitation: .github/workflows/repository-checks.yml: non-default execution context is unknown
- Limitation: .github/workflows/repository-checks.yml: non-local or dynamic uses invocation is unknown
- Limitation: .github/workflows/security-scan.yml: command execution is unknown: shell expansion is not resolved
- Limitation: .github/workflows/security-scan.yml: command execution is unknown: shell functions, control flow, expansions or redirections are not resolved
- Limitation: .github/workflows/security-scan.yml: non-local or dynamic uses invocation is unknown
- Limitation: tools/check_migrations.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/coverage_web_models.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_approvals.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_artifact_staging.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_artifacts.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_budgets.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_chaos_report.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_codex.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_copilot.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_demo_lifecycle.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_external_adapters.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_factory_claims.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_factory_controller.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_factory_publication.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_gateways.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_idempotency.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_identity.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_idle_cleanup.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_leases.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_portable_deliverables.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_replay.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_rooms.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_runner_reconnect.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_secrets.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_task_graph.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_verification.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/e2e_worktrees.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/platform_runner_contract.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only
- Limitation: tools/run_evals.mjs: model invocation in this implementation language is unknown; source text is supporting evidence only

### Advanced analyses

**API Surface Clarity** — 50/100 (N/A (binary app))

- API surface analysis skipped — binary apps don't expose a library API

**Continuous cleanup automation** — 70/100 capability coverage (Enrollment unverified; score-neutral)

- Cleanup capability: detected with 135 executable or configured evidence file(s).
- Bounded repeatable driver: detected with 12 executable or configured evidence file(s).
- Concrete scheduler enrollment: not detected.
- Observed behavior: mutating.
- ⚠ The cleanup driver is designed for repeated invocation, but concrete scheduler enrollment was not found.

**Code-Level Quality (Deep Analysis)** — 33/100 (Needs attention)

**Context Efficiency** — 5/100 (Inefficient)

- Total codebase: ~2044322 tokens across 301 files (avg 6791 tokens/file)
- ⚠ Module 'apps' is ~217021 tokens (59 files) — too large for agent context
- ⚠ Module 'crates' is ~1122893 tokens (92 files) — too large for agent context
- ⚠ Module 'scenarios' is ~130844 tokens (31 files) — too large for agent context
- ⚠ Module 'tools' is ~560353 tokens (113 files) — too large for agent context

**Coupling & Change Amplification** — 50/100 (Moderate coupling)

- Git history (last 100 commits): median 3.0 files/commit
- Low coupling: changes are well-scoped (median)
- ⚠ High avg imports (10.4/file) — deep dependency chains

**Error Handling Patterns** — 90/100 (Consistent)

**Feedback Speed** — 90/100 (Good)

- Pre-commit hooks found: .pre-commit-config.yaml
- .pre-commit-config.yaml: 4 hook entries detected
- CI pipeline found: .github/workflows/ci-maintenance.yml
- .github/workflows/ci-maintenance.yml: uses caching
- CI timeout: 5 min (good for agents)
- .github/workflows/ci.yml: uses fast-fail flags
- .github/workflows/ci.yml: uses matrix/parallel jobs
- Staged-file validation unknown: inspection limits, invalid or unsupported lint-staged configuration, dynamic wiring, functions, arbitrary control flow and finding filters cannot establish the configured capability; this is not evidence of absence

**Harness Engineering** — 25/100 (Poor)

- AGENTS.md found (2592 chars — Agents agent guidance)
- Agent doc is 61 lines (≤120 — within length discipline target)
- docs/SECURITY.md found (security policy defined)
- ⚠ Add explore + plan sub-agents to .claude/agents/*.md or .github/agents/*.agent.md — the Explore sub-agent is the single highest-leverage context firewall for legacy repos
- ⚠ Add ≥3 silent-on-success-verbose-on-failure wrappers to scripts/agent/ (currently 0)
- ⚠ Add scripts/agent/eval/ with at minimum keep-rate.sh — owner needs an honest production metric (Cursor's framing)
- ⚠ Add MEMORY.md or a .agent/ directory to persist agent state across sessions
- ⚠ .pre-commit-config.yaml found but no lint-only tools detected (add ruff, eslint, golangci-lint, etc.)
- ⚠ Add a CODEOWNERS file to define review ownership for agent-generated PRs
- ⚠ Subdirectory AGENTS.md coverage is 22% — add more to cover >30% of modules

**Review Workflow** — 65/100 (Good)

- PR template found — agents get structured review guidance
- Issue templates configured
- Dependabot configured — dependency PRs automated
- CONTRIBUTING.md found — contribution workflow documented
- ⚠ Add security scanning (CodeQL, gosec for Go, bandit for Python, cargo-audit for Rust)

**Code Smell Density** — 35/100 (High)

- ⚠ 5.4 smells per 1000 lines — consider architectural cleanup

**Test Quality** — 50/100 (Moderate)

- Test/source ratios are code-volume heuristics, not measured coverage or executable test-case counts; .NET test-project helpers count as test code, linked paths count once, shared production/test files count once as source, and conventional generated C# files are excluded
- Base test_files_count additionally includes source files with detected inline Rust tests; inline_test_count counts those detected cases without treating the entire source file as test code

**Agent Workflow Safeguards** — 22/100 capability coverage (Partial; score-neutral)

- Detected 2/9 workflow safeguard capabilities from implementation and test evidence.
- ⚠ Add a numeric orchestration-iteration cap with explicit cancellation, stop, or handoff exits

### Code smells

1041 detected in total.

- `god_class`: 83
- `high_coupling`: 53
- `high_instability`: 53
- `oversized_function`: 852

| Category | File | Severity | Metric |
|----------|------|----------|--------|
| god_class | `apps/web/src/App.tsx` | high | tokens=78230, methods=151 |
| god_class | `apps/web/src/factoryCheckpointRecovery.test.mjs` | high | tokens=11662, methods=29 |
| god_class | `apps/web/src/workResultCard.test.mjs` | high | tokens=12176, methods=49 |
| god_class | `crates/crony-cli/src/factory.rs` | high | tokens=67399, methods=182 |
| god_class | `crates/crony-cli/src/factory/quota.rs` | high | tokens=11329, methods=54 |
| god_class | `crates/crony-cli/src/publish.rs` | high | tokens=18808, methods=68 |
| god_class | `crates/crony-protocol/src/lib.rs` | high | tokens=12432, methods=23 |
| god_class | `crates/crony-runner/src/adapter/codex.rs` | high | tokens=15194, methods=44 |
| god_class | `crates/crony-runner/src/adapter/copilot.rs` | high | tokens=19097, methods=53 |
| god_class | `crates/crony-runner/src/adapter/copilot_fs.rs` | high | tokens=10801, methods=39 |
| god_class | `crates/crony-runner/src/adapter/external.rs` | high | tokens=25821, methods=72 |
| god_class | `crates/crony-runner/src/connections.rs` | high | tokens=19082, methods=40 |
| god_class | `crates/crony-runner/src/deliverable.rs` | high | tokens=15902, methods=37 |
| god_class | `crates/crony-runner/src/main.rs` | high | tokens=53895, methods=92 |
| god_class | `crates/crony-runner/src/verifier.rs` | high | tokens=12763, methods=45 |
| god_class | `crates/crony-runner/src/workspace.rs` | high | tokens=26046, methods=96 |
| god_class | `crates/crony-server/src/artifacts.rs` | high | tokens=12238, methods=43 |
| god_class | `crates/crony-server/src/dependency_source.rs` | high | tokens=12908, methods=52 |
| god_class | `crates/crony-server/src/main.rs` | high | tokens=86036, methods=199 |
| god_class | `crates/crony-server/src/planning.rs` | high | tokens=22050, methods=62 |

Showing 20 of 1041 (display bound 20). The complete set is available in: cb.json, csv/CodeBlend_AgenticReadiness_EvidenceItem.csv, findings.jsonl.gz (only when --full-findings was requested).

### Opportunities

1041 detected in total.

- `god_class`: 83
- `high_coupling`: 53
- `high_instability`: 53
- `oversized_function`: 852

| Category | File | Severity | Metric |
|----------|------|----------|--------|
| god_class | `apps/web/src/App.tsx` | high | tokens=78230, methods=151 |
| god_class | `apps/web/src/factoryCheckpointRecovery.test.mjs` | high | tokens=11662, methods=29 |
| god_class | `apps/web/src/workResultCard.test.mjs` | high | tokens=12176, methods=49 |
| god_class | `crates/crony-cli/src/factory.rs` | high | tokens=67399, methods=182 |
| god_class | `crates/crony-cli/src/factory/quota.rs` | high | tokens=11329, methods=54 |
| god_class | `crates/crony-cli/src/publish.rs` | high | tokens=18808, methods=68 |
| god_class | `crates/crony-protocol/src/lib.rs` | high | tokens=12432, methods=23 |
| god_class | `crates/crony-runner/src/adapter/codex.rs` | high | tokens=15194, methods=44 |
| god_class | `crates/crony-runner/src/adapter/copilot.rs` | high | tokens=19097, methods=53 |
| god_class | `crates/crony-runner/src/adapter/copilot_fs.rs` | high | tokens=10801, methods=39 |
| god_class | `crates/crony-runner/src/adapter/external.rs` | high | tokens=25821, methods=72 |
| god_class | `crates/crony-runner/src/connections.rs` | high | tokens=19082, methods=40 |
| god_class | `crates/crony-runner/src/deliverable.rs` | high | tokens=15902, methods=37 |
| god_class | `crates/crony-runner/src/main.rs` | high | tokens=53895, methods=92 |
| god_class | `crates/crony-runner/src/verifier.rs` | high | tokens=12763, methods=45 |
| god_class | `crates/crony-runner/src/workspace.rs` | high | tokens=26046, methods=96 |
| god_class | `crates/crony-server/src/artifacts.rs` | high | tokens=12238, methods=43 |
| god_class | `crates/crony-server/src/dependency_source.rs` | high | tokens=12908, methods=52 |
| god_class | `crates/crony-server/src/main.rs` | high | tokens=86036, methods=199 |
| god_class | `crates/crony-server/src/planning.rs` | high | tokens=22050, methods=62 |

Showing 20 of 1041 (display bound 20). The complete set is available in: cb.json, csv/CodeBlend_AgenticReadiness_EvidenceItem.csv, findings.jsonl.gz (only when --full-findings was requested).

</details>
