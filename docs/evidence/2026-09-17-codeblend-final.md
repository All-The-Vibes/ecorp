# ECorp readiness benchmark — September 17, 2026

The final uncached native benchmark measured **87.4/100 structure**, **43.5/100 operations**, and **61.7/100 composite**: Q2 Verifiable-but-manual, R3 Verifiable, AI-ready **no**. Operations remains Bot-Assisted; the latest coverage and developer-environment work did not raise that axis.

The assessment covers the complete repository at implementation commit `14e5b4fe9d853f67b2f74d01c0de7f3671bd07e6` (tree `982e69ae42c07e5341f4b785ba6d851964fa151e`). A separate clean source snapshot contained all 643 tracked/nonignored files, with identical bytes and manifest SHA-256 `0c0b07bd33db598f5ea34813ca1b8e452b9b5164838b5f889d900e41f2b342d2`. Ignored generated validation output remained preserved outside the assessed snapshot. The later report commit adds evidence only.

The native CodeBlend evaluator is pinned to `0a9accccd36446c381c118b783e2e9f623643efa`, executable SHA-256 `4229e93d77dce70e4e3493cab6bc5311c2d02551d024de33319c27ae6a323290`. The final invocation uses `--no-cache`, required GitHub API evidence, and concurrent `claude-opus-5,gpt-6-astra,grok-4.6` judges. The unchanged repository scan policy selects no excluded paths. Evaluation uses reported evidence; it does not establish independently observed closed-loop qualification.

## Measured results

| Native full run | Structure | Operations | Composite |
| --- | ---: | ---: | ---: |
| Fresh baseline, `20260918-033415+0800` | 72.0 | 44.75 | 56.8 |
| Tooling and MCP hardening, `20260918-033802+0800` | 83.0 | 49.25 | 63.9 |
| Native observations, `20260918-044056+0800` | 85.0 | 43.5 | 60.8 |
| Final source, `20260918-053207+0800` | 87.4 | 43.5 | 61.7 |

Operations depends on live API evidence and model judgments. These are separate measured runs; no score was assembled from axes belonging to different runs or selected because it was the highest. The requested 90/90 outcome remains incomplete.

## Why the remaining scores are low

| Operational dimension | Native score |
| --- | ---: |
| Agent Interface & Operability | 3/4 |
| Automation Coverage for Routine Maintenance | 1/4 |
| Self-Healing CI/CD | 1/4 |
| Continuous Improvement Loops | 1/4 |
| Agent Execution Surfaces | 3/4 |
| Policy, Safety, and Change Guardrails | 2/4 |
| Observability of Agentic Work | 1/4 |
| Human-on-the-Loop Integration | 3/4 |
| Agentic Change Throughput & Contributor Mix | 2/4 |

The executed ECorp recovery cases demonstrate status-write retry, interruption/restart, and verifier rejection. They do not demonstrate a generated and reviewed repair proposal, independent replay bound to that proposal, rejected-repair restoration and escalation, or duplicate/stale-source consumption of a complete repaired result. The new observation exporter and consumer independently check native state and artifact bytes, but do not invent these missing actions.

The inspected upstream repair/autonomy work remains with [#280](https://github.com/All-The-Vibes/ecorp/issues/280), [#269](https://github.com/All-The-Vibes/ecorp/issues/269), and its [#95](https://github.com/All-The-Vibes/ecorp/issues/95) dependency. At the September 17 inspection, no ready immutable native repair implementation was available to integrate. [Draft #304](https://github.com/All-The-Vibes/ecorp/pull/304) provides review instructions and review evidence, not the missing Factory execution loop. Availability must be rechecked before integration.

Structure remains limited by Code Quality L3 and Testing L4. The scan reports substantial coupling in the existing server, store, CLI and runner modules. A safe publication-router/state extraction needs its own security and native publication verification; moving imports alone would not establish better boundaries. The current native testing rules recognize existing validation at L4 and retain workflow-discovery limitations despite actual coverage evidence.

Documentation drift coverage is **partial**. The evaluator recommends checked-diff or fail-on-stale semantics for existing documentation generation, wired into affected PR validation. The current explicit command/runtime contracts cover their declared scope, not every prose claim. Continuous cleanup is **70/100, Enrollment unverified**: repeatable capability is detected, but concrete scheduler enrollment is not. Some validation paths remain outside the evaluator's execution analysis; missing recognition is not proof that a feature is absent.

## Fixes and validation

The contribution discovers the existing Node regression suites, adds narrow documentation contracts and coverage checks, pins contributor tools and CI, scans secrets, and supplies a tested Linux Dev Container with portable registry resolution. It also adds native read-only MCP inspection with bounded HTTP bodies, real Codex MCP registration, scoped observation export/consumption, a production development-key rejection, and an extracted verification-policy UI/model. The existing Copilot SDK 1.0.11 / CLI 1.0.79 pair is preserved.

| Executed validation | Result |
| --- | --- |
| Final Windows `pnpm check` | Passed in 244.441 seconds: 966 Node tests, 555 Rust tests, migrations, docs, rustfmt, Clippy, web build and lint |
| Separate owned SQLx coverage stage | 332/332 passed without retries; 887 Rust tests passed across both stages; one stopped-session probe unexecuted |
| Native Rust coverage | 72.2586% lines, 75.1211% functions, 72.4212% regions; unchanged 69-file scope and line/function/region denominators |
| New native Rust coverage CI gate | Unit baseline 45.8057% lines; initial floor 45.0%; actionlint and PowerShell validation passed; hosted execution unverified |
| Native threshold enforcement | On retained combined profiles: 45% accepted, 100% rejected; source and raw profiles unchanged |
| Linux Dev Container | Frozen install and toolchain doctor passed; 931 Node tests passed with five Windows-only skips; 525 Rust tests passed with 333 ignored |
| Portable package lock | Fresh approved-registry Windows install: 28 downloaded, zero reused; fresh public-registry Linux install/build/lint passed; package graph and integrity pins unchanged |
| Native MCP/observations | 68 focused tests; actual native export/consumption and Codex configuration/catalog evidence retained |
| Browser/server/runner policy acceptance | Six UI-authored checks passed with one accepted completion; negative artifact floor produced no accepted completion |
| Final native secret scan | 254 branch-ancestry commits scanned; no findings beyond the existing exact historical exceptions |

The [developer-environment report](2026-09-17-developer-environment.md), [native observation/coverage report](2026-09-17-operation-observations.md), and [hardening report](2026-09-17-codeblend-hardening.md) retain commands, source/tool hashes, counts, timings, failures and scope. Database processes and three task-owned containers were stopped with ownership checks; databases, worktrees and reports were preserved. Runtime acceptance used development identity and deterministic provider fixtures. It does not establish real-provider inference, production isolation, hosted CI success, or native Factory publication provenance.

The [machine-readable final assessment](assets/codeblend-readiness/final-assessment.json) preserves native scores, dimensions, scope, source identity and output hashes. Raw native JSON, Markdown and CSV artifacts remain under run ID `20260918-053207+0800`. The native run completed in 106.831 seconds, with all three judge models successful.
