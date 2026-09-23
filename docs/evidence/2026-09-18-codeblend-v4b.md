# CodeBlend V4b assessment — September 18, 2026 UTC

The full assessment of ECorp commit `69598e095c78611b3b487c67854d4146b4561fbd` completed at **92.0 structure / 68.25 operations / 79.2 composite**. It is **verified evaluator-observed-local**, **Q2 Verifiable-but-manual**, **R4 Delegable**, with `aiReady:false`. Scores are unchanged from the previous completed V3 assessment. The 90-point operations objective remains unmet.

All three judges succeeded in one round: `claude-opus-5`, `gpt-6-astra`, and `grok-4.6`. Total runtime was **554.891 seconds**, including 447.835 seconds of native observation and 94.709 seconds of judge evaluation. Native case pipelines and judge calls ran in parallel.

## What the committed change proves

Commit 69598e0 adopts verified advisory feedback through existing native contract revisions. It binds exact raw or selected typed corpus bytes, appends only reviewed references, preserves execution authority and verifier policy, and keeps launch separate. Post-request errors remain uncertain until reconciled.

The [native feedback acceptance](2026-09-18-native-feedback.md) passed **15/15 assertions in 62.38 seconds** and **9/9 persisted verifier checks** across three executions, with browser follow-up. That acceptance used synthetic inputs and the deterministic `fake-process` provider; it proves transport, adoption and consumption, not learned decision quality. Required validation passed 1,110 web/tool tests, 195 Steward tests and 561 Windows Rust tests, with 343 Rust cases ignored. Migration, documentation, formatting, Clippy, build and lint gates passed.

## Operations dimensions

Scores below are the final rubric values after the panel median and deterministic adjustments. Reasons summarize what the evaluator credited; missing detected evidence is not proof that product code is absent.

| Dimension | Score | Weight | Evaluator basis |
|---|---:|---:|---|
| D1 Agent Interface & Operability | 3/4 | 9% | Agent instructions, development setup and PR-reachable validation support integrated operation; accepted agent-authored PRs were not demonstrated. |
| D2 Automation Coverage for Routine Maintenance | 2/4 | 13% | Maintenance is machine-triggerable and repeatable, but the pack did not establish effective scheduled delivery or workflow chaining; panel median remained 2. |
| D3 Self-Healing CI/CD | 3/4 | 18% | Local repairs and recovery were verified. All judges retained 3 while citing selfHealing.hasRollbackPath=false; this field does not negate the observed controlled restoration. |
| D4 Continuous Improvement Loops | 2/4 | 13% | Repair observations and deterministic advisory adoption do not establish repeated-evidence learned-rule promotion and later-run behavior; panel median remained 2. |
| D5 Agent Execution Surfaces | 3/4 | 9% | Machine-triggerable execution surfaces receive a deterministic floor of 3. The pack did not corroborate a shipped repo-specific MCP server or hostile-source sandbox. |
| D6 Policy, Safety, and Change Guardrails | 3/4 | 10% | Runtime rulesets, review, checks and bounded execution support guardrails; comprehensive autonomous safety closure and ownership coverage were not established. |
| D7 Observability of Agentic Work | 4/4 | 9% | The authorized local observations verified origin correlation, lifecycle traces, machine completion, consumer actions, recovery and stale/duplicate handling; all judges awarded 4. |
| D8 Human-on-the-Loop Integration | 3/4 | 9% | Enforced review, routing and inspectable escalation support supervision; a complete human-exception-to-shipping lifecycle was not demonstrated. |
| D9 Agentic Change Throughput & Contributor Mix | 2/4 | 10% | The 90-day API window found 0 agent-authored merged PRs among 90; 4 of 269 commits had agent co-authorship. Metadata-only attribution is floored and capped at 2. |

D2 votes were 2/3/2 and D4 votes 3/2/2 in the judge order listed above, so both medians stayed 2.

The main remaining gaps are governed recurring delivery, repeated feedback that demonstrates later behavior, and corroborated agent-produced merged contributions. These local defect-repair cases do not supply those broader outcomes. In particular, the pack reports `automaticRollbackVerified:true` for observed local restoration while `selfHealing.hasRollbackPath:false` remained the static signal cited by judges; no claim of production self-healing follows.

Raising D2 and D4 alone to 4 would reach only 81.25. With the current D3 limit of 3 and D9 limit of 2, reaching 90 requires every other dimension to reach 4, producing 90.5. These are arithmetic bounds, not predicted scores.

Further work should coordinate with the separate [draft PR #323](https://github.com/All-The-Vibes/ecorp/pull/323), which addresses readiness, CODEOWNERS and security CI, plus the existing [#280](https://github.com/All-The-Vibes/ecorp/issues/280)/[#95](https://github.com/All-The-Vibes/ecorp/issues/95) work and dependent [#269](https://github.com/All-The-Vibes/ecorp/issues/269). Further implementation needs coordination with these existing work items. No scoring or authorship rules were changed.

## Native V4b proof and accounting

All three case pipelines fulfilled their contracts. Recurrence repair passed **18/18** and expiry repair **22/22** in native, physical and exported verification. Both stale controls preserved every original byte and used the prospectively permitted single separator CRLF; old receipts were refused and current receipts accepted. Duplicate consumption was read-only and completed-launch replay created no extra run.

The negative pipeline retained **failed → cancelled → failed** lineage: the deliberately wrong candidate scored 19/22, the interrupted run has **no oracle result**, and restoration reproduced the exact original faulty bytes at 20/22 with retained escalation evidence. Expected failed/cancelled controls are successful qualification evidence, not accepted product repairs.

Nine new real-provider invocations used **909,114 native-reported tokens**: 278,481 recurrence-positive, 243,583 expiry-positive and 387,050 expiry-negative. The original nine V4 runs and 856,755 tokens remained intact; cumulative usage is 1,765,869 tokens. Every new mission retained its 600,000-token cap and 3,000,000 cost microusd cap, within aggregate authority of 1,800,000 tokens and 9,000,000 cost microusd. Native reported cost was zero; it is not billing proof.

An independent terminal audit passed **1,509 assertions** and hashed **367 files**, confirming all 47 original protected rows unchanged. It performed no provider, oracle or test rerun. Browser follow-up showed both latest positive runs completed with 3/3 checks, the restored negative run failed without an accepted deliverable, and the interrupted run cancelled without verified completion. The owned stack was stopped at `2026-09-18T08:23:43.5190755Z`; all three owned listeners were absent, all evidence/worktrees were retained, and the older V3 stack was untouched.

## Retained attempts

| Attempt | Preserved outcome |
|---|---|
| V4 profile schema | Stopped before inference on an unsupported `version` field. Pins were corrected to exact `path`/`sha256` pairs. |
| V4 protected-owner map | Stopped before inference on the native profile contract. Replacement used 64 protected paths disjoint from two targets, retaining all 114 source bindings. |
| Original V4 native attempt | **Incomplete**, after 9 runs and 856,755 tokens: an extra separator CRLF violated its strict expiry append contract. Successful recurrence, expiry repair and negative-control subsets remain separately evidenced; expiry stale-receipt consumption was not observed. |
| Initial V4b source setup | Stopped before inference outside the existing source allowlist. Failed setup/clones were retained. Fresh separate cases used the existing allowed root, without allowlist expansion or runner restart. |
| Fresh V4b | Completed against a new challenge, cases and independent proposal reviews. The broader zero/one separator-newline intent and lower cost caps were explicit before inference. Original V4 was not regraded. |

The 22 fixed oracle artifacts remained byte-identical. Preflight passed all three cases and independent prospective checks passed 44/44. The final profile protects 64 owner paths and independently checks all 114 source bindings. Exact retained artifact hashes are in the [public JSON summary](assets/codeblend-readiness/codeblend-v4b.json).

## Current auxiliary findings

The cleanup-automation analysis reports **70/100, Enrollment unverified** as a score-neutral auxiliary result. It detected cleanup capability and a bounded repeatable driver, classified behavior as mutating, but found no concrete scheduler enrollment. It also reported three read errors. This is a static capability/enrollment finding, not evidence of hosted operation or a statement about the completed QA stack shutdown.

Documentation-drift coverage is **partial**. Four targeted deterministic controls are reported across PR, post-merge and manual triggers; all are advisory and unenforceable, none has fail-on-stale mode, and one is marked tested. The evaluator recommends checked-diff or fail-on-stale generation wired into affected PR validation. These are evaluator findings; the report does not infer missing implementations from them.

## Method and limits

The assessment used pinned CodeBlend revision `0a9accccd36446c381c118b783e2e9f623643efa`, a full uncached scan, live API evidence and three successful judges. No scan exclusions or missing-API-evidence override were added. Real native inference used Copilot SDK 1.0.11/CLI 1.0.79 with automatic updates disabled, `gpt-6-astra` at medium reasoning, isolated worktrees, bounded seeded defects in actual modules and fixed oracles. Agent reviews were not human approvals.

This is controlled local development evidence. It does not establish production identity/isolation, learned decision quality, unattended hosted cadence, arbitrary-repository recovery or agent-attributable merged throughput. No publication, merge or deployment was performed by the qualification. Private paths, account identity and credentials are omitted.
