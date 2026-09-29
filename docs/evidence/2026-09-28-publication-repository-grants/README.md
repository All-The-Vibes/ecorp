# Publication publisher repository grants

PR #380 now binds workload repository selection to the exact enrolled publisher credential. Enrollment normalizes and persists the grant and includes it in the audit event. Workload HTTP routes reject missing or mismatched grants. Queue, context, claim, renewal, checkpoint and artifact transactions independently recheck the credential and repository. Two credentials with the same publisher identifier cannot borrow each other's grant.

Scoped credentials also constrain direct-CLI effects, replay, tokenless readback and failure cleanup. Legacy unscoped credentials retain only the separately human-authenticated direct CLI path; workload access requires explicit enrollment for a repository. Grant changes require enrollment/revocation. Credential-before-publication lock ordering and the existing native publisher remain in place. Migration 0058 is additive; earlier applied SQL and manifest entries are unchanged.

The original [implementation](../2026-09-28-human-publication-request/README.md), [watcher correction](../2026-09-28-human-publication-corrections/README.md) and [admission correction](../2026-09-28-human-publication-admission/README.md) packets remain unchanged. The repository-grant tests are retrospective regression evidence; no pre-fix red run is asserted.

## Source and validation

Main base: `878a1774774b0630c904cbaf4b05e1b346777817`. Parent: `a953c6e0c15ab523bf6f124068b7a6a1c96146f2`. Tested staged tree: `5c3871a05a2b320ed9d2dc5c7608f6ec59ba6f14`. All 7,351 physical source files match the native build, r12 browser acceptance and canonical run. [source-equivalence.json](source-equivalence.json) binds that inventory. [review-corrections.patch](review-corrections.patch) contains the 20 corrected paths; [tested-code.patch](tested-code.patch) contains all 42 implementation paths against main.

Locked dependencies and canonical `pnpm check` passed all 11 gates, including immutable migrations, state-audit compatibility, native EVM and full Node discovery. Node: 3,127 total, 3,062 passed, 0 failed, 65 skipped, 0 cancelled and 0 todo. Rust workspace: 884 passed, 0 failed and 600 ignored across 41 summaries. The separate EVM gate passed one test. See [canonical-report.json](canonical-report.json) and [canonical-pnpm-check.log](canonical-pnpm-check.log).

Focused native store execution passed 27 cases, HTTP authorization passed nine and watcher/routing passed seven, all with zero failures or ignored cases. They include invalid and unprivileged enrollment, normalization, cross-repository selection, same-publisher distinct credentials, revoked/expired credentials, effects and replays, failure cleanup, unscoped direct-CLI compatibility, stale-intent rejection and PostgreSQL lock contention. Counts overlap the full suite. Store/handler prerequisites are synthetic; the assertions exercise real migrations and native transactions. Environment-only database credentials remain reduced assurance.

## Controlled browser-to-runner acceptance

Real Edge, server, runner, CLI publisher, SCRAM PostgreSQL and private Git executed two native verified results and two durable tokenless human requests. Development authentication, deterministic providers and simulated GitHub produced zero real provider calls and zero real GitHub mutations. A surviving watcher encountered a busy lease, server restart and actual expiry, then adopted the PR created before another publisher crashed. Two recovery attempts converged without competing/repeated effects or duplicate PRs.

An injected Project-update failure retained the second PR link and a visible durable failure without automatic retry. Caller disconnection did not cancel intent. There were no extra coding runs, browser publisher credentials or remote-main changes. All owned native processes stopped; fixture data remains preserved. Ten screenshots at 390px and 1440px were inspected. Publication controls and state text are readable without horizontal overflow; the existing focused skip link remains visible. See [controlled-browser-report.json](controlled-browser-report.json) and [screenshot-review.json](screenshot-review.json).

The earlier r11 acceptance genuinely failed when the recovering publisher's local Git fetch exceeded the unchanged 30-second cap. Its original logs, fixture and diagnostic screenshots remain preserved. Two diagnostic fetches passed in 3.438 and 6.547 seconds without changing the retained remote. The root cause is unconfirmed. Fresh r12 acceptance passed using the same source, binaries, timeout and assertions. [correction-history.json](correction-history.json) preserves that distinction; the failed result is not reclassified.

## Remaining gates and limits

Final-head hosted CI, CodeQL, security, quality, integration and coverage remain merge gates. Existing local web coverage inputs are unchanged, so the earlier receipt is reused honestly; no new local coverage run is claimed. An exact reviewed-head merge and verified issue state are required before #219 is complete. Parent #145 and machine-intent #348 remain open.

Evidence additions are checked separately for physical-source and Git-tree equivalence, complete plan and Node discovery, documentation, paths, whitespace and secrets. Evidence was added after execution. Controlled acceptance does not establish production OIDC, real inference, live GitHub mutation, OS isolation or independent human approval. Docker's dedicated lock fixture remains unavailable because its engine pipe is absent; the native production lock regression passed. Serial Rust does not resolve Windows concurrency issue #213. Skipped/ignored cases are not passes. Historical Cargo debt remains 12 advisories (2 high, 1 moderate, 9 low); no clean audit is claimed.
