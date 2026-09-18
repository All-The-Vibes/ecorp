# Native coverage and Copilot settings correction — September 18, 2026 UTC

A fresh deterministic CodeBlend substrate scan measured **92.0/100 structure** at
`38507abc96b9282689a810e0e3c074fe0a8c8de5`, using the current native Rust coverage
report. This is a structural diagnostic, not a new complete operational assessment.
The latest completed full benchmark remains **87.4 structure / 43.5 operations /
61.7 composite**, run `20260918-053207+0800`. The 90/90 objective remains incomplete.

## Native Linux coverage

The new CI lane executes the existing Rust workspace unit tests and the ignored
store/server SQLx tests against a fresh owned PostgreSQL 17 service. It generates
standard `coverage/lcov.info`, native JSON, test logs and source/tool receipts.
It refuses a retained SQLx database or schema before executing tests; both negative
controls passed without changing their catalog or sentinel bytes.

| Measured stage | Passed | Failed | Scope |
| --- | ---: | ---: | --- |
| Linux workspace unit tests | 524 | 0 | 333 prerequisite-dependent tests initially ignored |
| Store SQLx tests | 328 | 0 | Existing ignored database tests, executed serially |
| Server SQLx tests | 4 | 0 | Existing ignored database tests, executed serially |
| Total | 856 | 0 | Runner stopped-session probe remains unexecuted |

Native JSON and LCOV agree on **49,407 / 72,899 lines (67.7746%)** across 69
compiled source files. Functions are 3,004 / 4,387 (68.4750%); regions are
63,028 / 93,180 (67.6411%). The run completed in 1,206.332 seconds. All 99 Rust
source/manifest identities remained unchanged. This measures the compiled Linux
Rust workspace; it is not whole-repository, web, provider or application E2E coverage.

The original measurement used a provisional 60% floor. Native report-only checks
against its retained profiles passed at 65% and 67%, and correctly failed at 100%.
No tests were repeated and no source, raw profile, instrumented binary or original
report changed. Follow-up commit `ac32e02fb323f0a79a86a97115911b26d772f2ce` sets the
CI floor to 67%, approximately 0.775 percentage points below the observed baseline.
Seven owned containers were stopped; databases, profiles and reports were retained.
Hosted CI execution remains unverified.

The earlier failed Linux attempt is also preserved: 525 unit tests passed, but
an unsupported `--no-report`/`--no-clean` combination prevented any SQLx execution.
Its profiles were not reused for this measurement. In cargo-llvm-cov 0.9.1,
`--no-report` already preserves accumulated profiles.

## Structural score comparison

The pinned native evaluator (`0a9accccd36446c381c118b783e2e9f623643efa`) scanned the
same complete, byte-identical 646-file source snapshot before and after attaching
the newly generated coverage directory. Both scans were uncached and used the
unchanged exclusion policy, with zero selected excluded paths.

| Native diagnostic | Structure | Testing | Test Quality analysis |
| --- | ---: | --- | ---: |
| Source without generated coverage | 87.4 | L4 | 45 |
| Same source with current native LCOV | 92.0 | L5 | 65 |

The evaluator applied its existing 20-point measured-coverage bonus to Test Quality;
the resulting advanced adjustment raised Testing to L5. Code Quality remains L3;
the other pillars remain L5. No historical report was renamed, scoring rule changed,
or operational score inferred from this diagnostic. The credited coverage remains
explicitly Rust-only.

## Shared Copilot settings bug

The adapter previously wrote each run's worktree-specific policy into shared
Copilot user settings, then reloaded and read it back. A later benchmark's judges
were denied access to their prompt files after those settings retained the native
run's policy. Commit `38507abc` removes that account-wide mutation and its unused
helper, while preserving native home/history, startup flags, scoped filesystem
capabilities, managed permissions, durable approvals and verifier policy. Existing
account settings are not automatically reset.

A zero-inference probe used the byte-identical production filesystem module,
Windows session filesystem configuration, existing session configuration and
directory tool with SDK 1.0.11 / CLI 1.0.79. A stricter deny-all permission callback
received zero requests. The probe made no model call, model-tool execution, settings
write/reload or session-options update. Native status reported **command sandboxing
disabled**, and native policy reported that no command policy was in force. Only
one `session.start` event was recorded; shared settings matched at every observed
checkpoint. This is configuration evidence, not proof of OS isolation or a
replacement for real-provider acceptance of the changed runner.

The changed source passed required local migrations, formatting, Clippy with
`-D warnings`, workspace tests, web build and lint. Windows Rust recorded 554
passed / 0 failed / 333 ignored. Node recorded 947 passed / 0 failed / 19
prerequisite-dependent skips. Actionlint, ShellCheck and Bash syntax checks passed.
The changed runner built successfully into a new versioned location; the previous
binary was retained.

## Operational evidence and remaining work

The earlier V1 qualification failed its exact-byte stale-source control because
the producer inserted an extra CRLF. V2, run `20260918-071738+0800`, passed the native
controller's execution verification: two positive repair pipelines, independent
physical/export verification, duplicate/stale controls, and a negative
rejection/interruption/exact-restoration control. Its nine real-provider invocations
used 621,229 tokens; earlier experiments retain another 863,661, or 1,484,890 total.

V2's subsequent judge reports failed on sandbox-denied prompt reads, producing no
numeric score. That execution used the preceding source and does not validate the
new runner. Fresh acceptance of the changed binary and a complete judge assessment
remain pending. These controlled local Direct experiments use development identity;
they do not establish unattended production automation or Factory-publication
provenance.

The [machine-readable summary](assets/codeblend-readiness/coverage-and-copilot-correction.json)
records native totals, source/tool/report hashes, local checks, original/full-score
scope and the separate structural diagnostic. See [EVALS](../EVALS.md) for the
reproducible coverage lane and [SECURITY](../SECURITY.md) for the corrected boundary.

Subsequent evidence: [the completed V3 assessment](2026-09-18-codeblend-v3.md)
records acceptance of the changed runner and successful judging on `9a6ebace`,
with 92.0 structure / 68.25 operations / 79.2 composite. This dated report's earlier
attempts, source-bound coverage and pending-at-the-time statements remain historical.
