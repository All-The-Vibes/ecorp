# Aggregate budgets and repeated correction acceptance

These September 27, 2026 observations complete the native and browser acceptance
for issues #56, #221 and #224 on tested tree
9ddca9d6bbf522827f53a3a5d11554a10c96337a. The implementation PRs were already
merged into main; their identities and observed states are recorded in summary.json.
The publication's separate source-equivalence manifest binds this evidence to the
reviewed candidate. This is retrospective evidence, not a clean final-commit rerun.

| Issue | Acceptance evidence |
| --- | --- |
| #56 | 35 actual-migration SQL regressions passed. Three native concurrent-run scenarios exercised mission, requester-24h and Corp-24h scopes. No late artifact or completion was accepted. Edge authored and started a parallel mission; both native children were fenced, dependent synthesis never dispatched, and the next launch returned HTTP 409 with zero new runs. |
| #221 | 11 actual-store regressions passed, including exact history, current authority, revocation, stopped/quarantined/looped lineages, spend exhaustion, replay and transactional rollback. The native public flow selected the latest failed preserved provider correction and admitted the next explicitly requested correction. |
| #224 | 6 actual-store regressions passed. All 31 public-driver checks passed, covering preview, bounded policy, exact replay and mutation-free invalid changes. The policy was set to three before execution. One mission/task retained four histories with attempt counters 1, 1, 2, 3, no remaining attempts and unchanged original history. |

The public correction flow spent 6,024 of its original 10,000 mission tokens,
leaving 3,976. The first provider correction genuinely failed verification; the
second passed the same persisted policy. Edge displayed the retained failure and
the final verified result, four histories and 3/3 attempt use. The guest view hid
the private history, and the browser's history hashes remained equal.

The raw driver uses the label independent_bob_approval. Bob is a deterministic
development principal, not an independent human reviewer. These fixtures do not
establish live vendor inference, production authentication, deployment or OS
isolation. Environment-only database delivery remains reduced assurance.

Current reviewed implementation references include
crates/crony-store/src/aggregate_breaker.rs:243,
crates/crony-store/src/aggregate_breaker_tests.rs:530,
crates/crony-store/src/checkpoint_correction_history.rs:351,
crates/crony-store/src/checkpoint_correction_retry_tests.rs:56,
crates/crony-store/src/factory_attempt_policy.rs:7 and
crates/crony-server/src/planning.rs:1475. The summary lists every executed SQL
regression and each observed public boundary check.

Original and published hashes, profile-path normalization and capability-key
redaction are recorded for each copied artifact. Private databases and capability
files are excluded. The earlier failed checks and denied startup attempts remain
preserved history. Issue closure requires final merge and state verification.
