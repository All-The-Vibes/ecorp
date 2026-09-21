# ECorp CodeBlend benchmark — final report

**Operations: 71.5 / 100. Target: 80. Target not met (8.5 points short).**

| Result | Score / classification |
| --- | --- |
| Substrate | 87.4 / 100 · L5 |
| Operations | 71.5 / 100 · Agent-Enabled |
| Composite | 79.1 / 100 |
| Quadrant / rung | Q2 Verifiable-but-manual · R4 Delegable |
| AI-Ready | No — both axes must reach 80 |

The official evaluator-observed local run succeeded and verified its declared scope. The composite is the geometric mean of the two axes; it is not the operations score. Runtime: 11 minutes 23.909 seconds, 2026-09-21T03:09:35.7485408Z to 2026-09-21T03:20:59.5131496Z. Three judge models ran one uncached round: claude-opus-5, gpt-6-astra, grok-4.6.

[Official composite report](composite.md) · [Official composite JSON](composite.json) · [Structured summary](REPORT_DATA.json) · [Artifact manifest](MANIFEST.json)

## What was assessed

The assessment read base 39632b957819012721c90902925d8fa7a9c7e873 with the approved three-file Unicode correction in the working tree. The independently verified native export is commit 3aff250c118c1e24daebc39e7c8655049a344fb5. The run metadata therefore correctly reports a dirty working tree at the base, not a checkout of the exported commit. All 736 source files, previous receipts and historical runs were preserved.

## Operations result

| Dimension | Raw | Weight | Points | Evidence interpretation |
| --- | ---: | ---: | ---: | --- |
| Agent Interface & Operability | 3/4 | 9 | 6.75 | Integrated instructions, bootstrap and validation; a completed compliant agent PR path was not demonstrated. |
| Automation Coverage for Routine Maintenance | 3/4 | 13 | 9.75 | Machine-triggered workflow chaining and verified deduplication; unattended maintenance through accepted PR remains unproven. |
| Self-Healing CI/CD | 3/4 | 18 | 13.50 | Two repair classes and recovery were observed; the rubric still caps this at 3 because its static rollback-path signal is false. |
| Continuous Improvement Loops | 2/4 | 13 | 6.50 | Repeatable audits and proof of fix; the panel did not establish governed rule promotion or measurable learning gains. |
| Agent Execution Surfaces | 3/4 | 9 | 6.75 | Skills plus MCP configuration establish the deterministic floor of 3; no hosted or hostile-source isolation claim. |
| Policy, Safety, and Change Guardrails | 3/4 | 10 | 7.50 | Live rulesets, reviews, pinned actions and bounded execution; autonomous policy closure remains unproven. |
| Observability of Agentic Work | 4/4 | 9 | 9.00 | Verified local origin correlation, lifecycle outcomes, machine completion, consumption, stale and duplicate handling. |
| Human-on-the-Loop Integration | 3/4 | 9 | 6.75 | Enforced human review, owner approval and escalation; a compliant agent PR acceptance lifecycle remains unproven. |
| Agentic Change Throughput & Contributor Mix | 2/4 | 10 | 5.00 | The 90-day API window detected zero agent-authored merged PRs; co-authorship metadata alone did not prove material throughput. |

Observability received unanimous 4/4. Continuous improvement and agentic throughput remain the weakest dimensions at 2/4. The self-healing score stayed capped at 3 despite observed local restoration because the rubric's static rollback-path signal was false. These are the evaluator's findings; unrecognized evidence does not establish missing product capability.

## Practical follow-up

- **Documentation drift:** The official scan reports partial coverage and requests fail-on-stale validation. Source inspection already confirms nonzero failure for stale marked validation-command and Copilot-version contracts, tested and run by repository-checks CI. Broader semantic prose drift remains outside that targeted enforcement. Preserve those controls and measure the remaining coverage gap before extending them.
- **Recurring cleanup:** The scan rated capability 70/100, score-neutral, with enrollment unverified. Establish a concrete bounded scheduler enrollment and retain repeat-run, no-op, failure and recovery evidence. Capability/driver discovery alone does not prove it is scheduled.
- **Governed improvement:** The source already implements a bounded advisory candidate, active and retired rule corpus. It explicitly refuses native-behavior activation without separate authenticated promotion authority. Close that integration gap with governed promotion and real consumption evidence; controlled repairs and selected-rule retirement do not establish measurable learning gains.
- **Recovery and publication:** CI maintenance currently emits a read-only handoff, not product remediation and rollback. Implement and verify that actual recovery path while preserving authorization. Resolve the separate CLI URL case-comparison defect with focused tests. Native review-PR publication remains blocked externally; this report performs no publication.
- **Attributable throughput:** Collect API-verifiable agent-authored accepted PRs and measured sustained outcomes under enforced review. Seven co-authored commits and controlled local runs do not establish production velocity.

Documentation drift coverage was rated partial, but the source review verifies targeted enforcement that the scan did not recognize. Cleanup's 70/100 capability rating is score-neutral. The scan reported UnicodeError for the Dockerfile, LICENSE and NOTICE even though all three passed an independent strict UTF-8 read; retain this as a scanner limitation, not a demonstrated encoding defect. Raw tests, documentation, coverage or MCP configuration alone do not guarantee operations 80. No prospective score is promised.

## Native qualification evidence

The authorized qualification executed 15 stages across three case roles, with three independent agent reviews and nine fresh native provider-mode runs. Reported native usage was **964,114 tokens**, excluding judge usage. A native run count is not an internal model-turn or HTTP-request count, and reported cost is not billing evidence.

| Case | Baseline / candidate | Accepted repair / outcome |
| --- | --- | --- |
| Recurring-audit deduplication | 15/18 fixed-oracle checks | 18/18 repaired and exported; review approved |
| Feedback expiry | 20/22 fixed-oracle checks | 22/22 repaired and exported; review approved |
| Negative expiry control | 19/22 candidate; review rejected | Interrupted edit cancelled; original faulty baseline restored to 20/22 and escalated |

Both positive cases validated actual consumption, same-fingerprint duplicate read-only behavior, launch replay no-op with unchanged events, and stale receipt refusal. The negative control refused consumption. No functional verifier pass is claimed for the cancelled run.

Native terminal outcomes were **4 completed, 4 intentional failures and 1 cancelled**, with zero automatic retries and zero unexpected current-runtime runs. All three case roles fulfilled their required outcomes; intentional failures and cancellation were retained as such.

The audit rechecked retained receipts and live snapshots. Its author also performed the expiry-positive review; the audit is not independent of that particular review. Reviews are agent reviews, not human approvals. The separate human owner approval described below accepted the maintenance source change.

Two evaluator metadata attempts were refused before model execution: unsupported profile byte fields, then a profile scope-summary bound. Additive profile corrections preserved old inputs and receipts. Both attempts created zero native runs, consumed zero additional native provider tokens and produced no qualified score.

The prior 17 provider-mode calls (1,518,170 reported tokens) and separate maintenance provider run (87,753 tokens) remain separate from this fresh qualification. Across these retained scopes there are 27 provider-mode runs and 2,570,037 reported tokens, excluding judge usage; the verification-only recovery used zero provider tokens.

## Accepted maintenance and verification

Steward collected a valid Unicode body and then rejected the same snapshot because the collector counted UTF-16 units while the validator counted UTF-8 bytes. The observed body had 65,535 units and 65,795 bytes. The correction aligns the validator with the existing 65,536-unit body limit, adds seven regressions and clarifies the README. The independent 16 MiB aggregate snapshot and response bounds remain in force.

Exactly three paths changed: scenarios/repo-steward/lib/common.mjs, scenarios/repo-steward/steward.test.mjs and scenarios/repo-steward/README.md. The exported tree has 736 entries; 733 and all modes are unchanged. Provider evidence is excluded from the source tree. Canonical Git blobs match the reviewed correction, although the review and native patch serializations differ.

Native checks passed 2/2 and focused regressions passed 7/7. The actual owner approved commit 3aff250c118c1e24daebc39e7c8655049a344fb5 at 2026-09-21T02:46:14.923758Z. The recovery run completed and Factory is verified; the original failed provider run and its evidence remain unchanged.

The corrected maintenance CLI completed its first fresh read-only collection: 36 collector reads, 4,096,718 metadata bytes and two main-head GETs. Two matching reads covered 216 issues, 140 PRs and 208 Project items; this was not an atomic snapshot. An identical supplied-input repeat returned no-op. The selected retired rule had nine matching findings and zero annotations while unexpired; this does not establish global revocation or improved model learning.

## Required contributor checks

| Exact command | Actual result | Wall time |
| --- | --- | ---: |
| `node tools/check_migrations.mjs` | Pass | 0.876 s |
| `pnpm check:docs` | Pass | 5.590 s |
| `pnpm test:unit` | 1,204 passed · 44 skipped · 0 failed | 73.971 s |
| `pnpm test:steward` | 234 passed · 0 skipped · 0 failed | 56.707 s |
| `cargo fmt --check` | Pass | 6.958 s |
| `cargo clippy --workspace --all-targets -- -D warnings` | Pass | 163.600 s |
| `cargo test --workspace` | 565 passed · 343 ignored · 0 failed | 276.147 s |
| `pnpm build:web` | Pass | 27.384 s |
| `pnpm lint:web` | Pass | 5.221 s |

Primary pins: Node 24.19.0, pnpm 11.19.0, Rust 1.98.1 and Windows x64 MSVC 14.51.36231. Node 22 was separate compatibility evidence and is the external adapter's own pin. The 44 JavaScript skips and 343 ignored Rust tests were not counted as passes. These retained checks were not rerun merely to generate the report.

## Recovery issues and comparison limits

The first checker rejected a legitimate 492-byte provider artifact. Native verifier-only snapshots are Git-less and include that retained artifact. An additive checker packet handled the exact physical manifest and switched six realpath calls to Node's native API for the Windows namespaced working directory; 22 local controls passed. A separate CLI recovery preview rejected a mixed-case GitHub URL against the stored lowercase identity. Supported native API recovery retained source/eligibility checks, claim/renew fencing, the versioned contract and manual gate. No runtime bypass was used; the CLI casing defect is not fixed by the three-file Unicode patch.

A separate artifact comparison found the prior 74.75 operations result and this 71.5 result differ only in the effective continuous-improvement dimension (3/4 to 2/4, a 3.25-point change). The underlying 18 typed local-verification facts and limits remained the same; one judge changed its score while the panel still cited missing evidence for governed rule promotion. Prior substrate 92.0 versus current 87.4 is a detected coverage-bonus difference that moved adjusted Testing from L5 to L4, with the base testing conditions unchanged. The assessed source/evidence snapshots differ, so these are explanations of score composition, not proof of a product regression or improvement.

## Evidence and publication

The official Markdown and JSON are byte-identical copies after sensitive-content screening. Raw provider logs, private bodies, credentials and absolute local paths are excluded from this shareable packet. Full run, telemetry, qualification and preservation receipts remain in the retained local evidence; their hashes are recorded in the structured summary.

- Official composite JSON SHA-256: 2753e01b3718d871344db43bb578a1aa4c5d3dbe09ef34df44912292e6be42da
- Qualification audit SHA-256: 90fa2052505ad9ebc9724ee298d4b23bdf4e57456975e0ac02f320853b7d7cfe
- Observed-loop SHA-256: 8c061b2415089b77a338a88bd40ed4bcc43eb551775459968b3365adc5c4d5c9
- Native source artifact SHA-256: 20d42b17fd0f5f5f7a5f411008390d85e33c932c0687cf3290df8d98c1890aeb

This is a bounded local development qualification with controlled derived fixtures. It does not establish production authentication, OS isolation, sustained throughput or measurable learning gains. No GitHub review PR, merge or deployment resulted from the blocked publication attempt. Earlier reports remain preserved; creating this report did not publish it.

Automatic approval review rejected the publication command before execution with “blocked by policy.” It supplied no more specific reason. No publisher credential or PR was created, and publication has not been retried.
