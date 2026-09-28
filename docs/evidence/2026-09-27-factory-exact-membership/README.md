# Exact Factory Project membership: observed qualification

The controller could reject an explicitly selected issue when GitHub omitted its issue-to-Project backlink. Recovery also rejected an unchanged issue when stored repository casing differed from GitHub's URL. This scoped prerequisite for #232 fixes both lookup paths in `crates/crony-cli/src/factory.rs`.

## Behavior and review

The exact-backlink fast path remains. An absent requested-Project backlink uses the existing quota-aware discovery against only that Project, filters the exact issue and authorized repository, rejects ambiguity, and re-reads the exact selected item before eligibility. Missing, malformed, truncated, quota-blocked, archived and changed identities remain fenced. Recovery tolerates only repository casing and trailing slashes; HTTPS host, issue route/number and opaque Project/item/node identities remain exact. The existing bounded discovery, claims, budgets, durable approvals, verifier and native harness adapters remain authoritative. No dependency, migration, provider executor or permission mechanism was added.

Integration base: `078eb986352c8f219baeea5fddf4b8e9ff25e51e`. Tested head: `0d8d57c35c78b125e019caf37266222189386b14` with staged tree `88bb08f0e0da0c4637f0a4c6268c5fea49f7973f`. Both commit parents are preserved. [summary.json](summary.json) records the complete physical fingerprint, code hash and artifact transformations. [tested-code.patch](tested-code.patch) is the reviewed one-file product diff against the integration base.

## Validation

Locked offline dependencies and canonical `pnpm check` passed all 11 current gates, including state-audit compatibility, EVM and full Node discovery. Node: 3,097 total, 3,032 passed, 65 skipped, 0 failed/cancelled/todo. Rust workspace: 876 passed, 0 failed, 558 ignored, across 41 summaries. Separate EVM gate: 1 passed. Migrations, both docs gates, formatting, strict Clippy, web build and lint passed. [canonical-report.json](canonical-report.json) preserves every command and count; [canonical-pnpm-check.log](canonical-pnpm-check.log) preserves its transcript.

New focused regressions failed before the fix (4 passed, 7 failed), then passed 11/11; all 150 CLI tests passed. These retain their original source identities and matching product-file hashes. The first formatting wrapper failed without a known Cargo result; r2 passed. The current canonical run is the complete combined-source result.

The real read-only qualification evaluated only personal Project #3 item `PVTI_lAHOBwBdFs4Bh3Clzg6lo6w` for issue #231 despite its missing backlink. Its current CLOSED/Done state remained ineligible, with no mutation, no runner, an unchanged empty execution ledger and unchanged remote target. [live-readonly-driver.json](live-readonly-driver.json) records the explicitly configured source/policy and two binary hashes. It does not assert the historical policy or an eligible selection.

The separate synthetic browser fixture ran real Edge, native server/CLI/runner and fresh PostgreSQL with deterministic GitHub/Codex children. Both initial and recovery previews discovered the exact synthetic Project #50/issue #9050 item through the missing-backlink path, re-read it and preserved source/policy, execution and item state. The browser then exercised budget rejection and approval, requester-review denial, native restart/reconnect, exact source/session/workspace recovery, verifier evidence, synthetic independent review and idempotency. [synthetic-native-report.json](synthetic-native-report.json) and [synthetic-browser-report.json](synthetic-browser-report.json) retain the assertions, counters and screenshots. Every owned process was verified stopped. This is retrospective synthetic acceptance, separate from the original #231 workflow.

## Remaining issue acceptance

Issue #232 remains open. Its original September 11 eligible Project #3 preview/source-policy and read-only checkpoint discovery for the exact retained native lineage remain unavailable. Inspection of the preserved historical database copy found no matching Factory #231 record; this does not prove the original artifacts no longer exist. An original manifest/database snapshot carrying that lineage and the source/policy preview is still needed to demonstrate those criteria without creating a replacement mission. The synthetic evidence above does not substitute for them.

## Evidence boundaries

Publication files were added after code acceptance; final source equivalence and evidence-only validation are recorded separately. The source-binding corrections preserve earlier failures and hashes: tracked ignored logs must be included, and a fresh temporary index must retain staged modes and existing CRLF context before re-adding every physical file. Product bytes and the real index were unchanged. Native build r3 stopped in preflight before Cargo; r4 and the current browser build passed with the corrected helper.

Personal filesystem roots in published text are replaced with `<USERPROFILE>`; original and published hashes remain distinct. Database/GitHub credential delivery through process environment has reduced assurance. No real model inference, human decision, hosted mutation, deployment or OS sandbox guarantee is claimed. Skipped/ignored tests remain unexecuted. Existing Cargo advisory debt remains 12 advisories (2 high, 1 moderate, 9 low); no clean dependency audit is claimed.

The first publication whitespace check rejected a final blank line in two copied build scripts. Only the publication copies were trimmed to one final newline; their transforms and updated publication hashes are explicit in `summary.json`. Original scripts and all code-execution receipts are unchanged. The failed publication receipt and log remain included; the follow-up validation is recorded separately.

Publication validation r2 passed whitespace, then detected local profile paths in the summary's copied process restart metadata. Those summary fields now use `<USERPROFILE>`, as the receipt copies already did. Original process identities and restart receipts remain unchanged. The failed r2 receipt and its successful whitespace log are included; publication validation r3 is recorded separately.

Publication validation r3 passed whitespace, documentation and personal-path checks, then flagged four synthetic browser operation UUIDs in eight locations as generic API keys. Published text now uses consistent labels for these replay/decision identifiers. [publication-redactions.json](publication-redactions.json) records hashes, provenance, affected files and scanner findings. Original execution receipts and failed publication checks are preserved. The transform changes no product code, execution result or screenshot; scan rules and ignore policy are unchanged. Publication validation r4 is recorded separately.

## Final publication receipts

The successful [r4 publication receipt](final-receipts/publication-validation-r4.json), [both committed-source Gitleaks receipts](final-receipts/committed-secret-scans-r1.json), their actual logs and the inspection drivers are now retained in [final-receipts/manifest.json](final-receipts/manifest.json). This supplement addresses review finding ECORP-378-001. It records the original publication commit 91e24f50c7f003e8ff4ea1143bda6c59e4f3ceca and tree 9c59958acd96e6779ee638470e7dcbc2d1e75c05, with original and portable-copy hashes. Both committed-blob and merge-history scans returned exit 0 and zero findings. The failed r1-r3 receipts remain historical observations.

Those checks ran after the initial evidence packet was frozen. These are immutable receipts for their named source, published afterward; they do not assert that the supplement tested itself or that a later commit has passed. The PR's current-head checks and review record supply the later revision's validation. No product behavior or historical issue acceptance is changed by this publication, and #232 remains open.
