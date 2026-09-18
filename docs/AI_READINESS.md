# AI-readiness improvement ledger

Branch: `codex/ai-readiness-improvements`. Source base: `0b1ad59da398e3dbd6a696d0264bcb6ebd620219`.
This is local engineering/measurement work, not approval to push, merge, deploy or alter
GitHub policy. Hourly main synchronization is held during active changes and measurement.

**Latest verified benchmark: 67.1 composite, 87.0 foundations, 51.75 operations.**
The fresh baseline was 54.2 / 66.8 / 44.0. AI-Ready remains **no**: both axes must be >=80.
All three judges returned valid reports in the final run. This is the best observed local
candidate in this pass, not a claim that the global maximum has been achieved.

## Measurement protocol

Use the installed `codeblend-ai-composite` skill against this local worktree, including
uncommitted changes when explicitly recorded. Preserve the evaluator's original artifacts.
Never adjust its score using our independent Rust/Node cross-checks.
The composite is the geometric mean of foundations and operations; AI-Ready requires both >=80.

Pinned evaluator SHA-256: `8acdb9d786842516acd395b74263502285fe8232bb71addd62fe81e94a890633`.
Distribution: CodeBlend v0.1.24; its embedded `--version` prints 0.1.1, so identify it by hash.
Host: Windows ARM64, using the previously approved x64 compatibility exception.
Panel: `claude-opus-5`, `gpt-6-astra`, `claude-sonnet-5`; one round, 90-day API window,
fresh runs with API evidence required. The CLI's own stages generate all scores.

The installed Copilot CLI 1.0.84-5 renamed `--effort` to `--reasoning-effort`; the evaluator
incorrectly describes the resulting failure as an old CLI. The benchmark uses an isolated
copy of the existing 1.0.80-0 binary, with documented `COPILOT_AUTO_UPDATE=false` and a
process-local PATH. The installed/default CLI and ECorp SDK/runtime configuration are unchanged.
Historical evaluations used 1.0.79, so disclose this runtime difference in comparisons.

| Run (UTC+8 ID) | Source | Composite | Foundations | Operations | Status |
| --- | --- | ---: | ---: | ---: | --- |
| 20260918-121938+0800 | clean base | — | 66.8 | — | Failed: no judge consensus due to CLI flag incompatibility |
| 20260918-122201+0800 | clean base | 54.2 | 66.8 | 44.0 | Complete, three valid judges |
| iteration-1 substrate only | uncommitted local changes | — | 77.8 | — | Deterministic native scanner only, not a composite benchmark |
| 20260918-124151+0800 | uncommitted iteration 1 | 60.0 | 77.8 | 46.25 | Complete, three valid judges; files configured locally, hosted operation unproven |
| 20260918-124753+0800 | uncommitted iteration 2 | 67.1 | 87.0 | 51.75 | Complete, three valid judges; Q2 Verifiable-but-manual, not AI-Ready |
| 20260918-125756+0800 | validated candidate plus receipts | 67.1 | 87.0 | 51.75 | Final complete run, all seven stages executed, three valid judges |

Original run artifacts live beneath the evaluator's per-repository `runs/` directory.
Local validation receipts live in ignored `output/readiness/`; share only reviewed, redacted
evidence, not raw credentials or arbitrary logs. A HEAD alone does not identify a dirty tree:
the driver records tracked-diff and untracked-file digests and rejects a changed source snapshot.

## Implemented locally

- Discoverable native Node/Cargo test entry points and a reviewed test-discovery configuration;
  the existing suites are retained, not renamed or replaced with synthetic score fixtures.
- Migration, docs, Node, Rust formatting, Clippy, Rust tests and web build/lint form one gate;
  failures stop it, with remaining checks explicitly not run.
- Node 24.19.0/Rust 1.98.1 pinning, optional local pre-commit checks and module guidance.
- A generated validation-command contract with a deterministic check and narrow explicit repair;
  regression cases prove drift detection, prose preservation and ambiguous-marker rejection.
- Immutable CI Action references and structured validation artifacts.
- Gitleaks snapshot scanning with checksum-pinned CLI, redacted reports and a seeded negative
  canary. A proposed JavaScript-only CodeQL job was removed in the publication review:
  GitHub's existing native default setup already covers Actions, JavaScript/TypeScript,
  Python and Rust. Its passing current-main checks were verified without changing that setup.
- Removed the fixed master-key value from `.env.example`; no deployed key or retained database
  was changed. Three exact fixture/replay fields have reviewed secret-scan exceptions.
- Native Dependabot configuration and CODEOWNERS review routing. Neither is proof of hosted
  execution or enforced required review on this unpushed branch.
- Declared the previously ambient `ws` test dependency. All other lockfile versions remain
  at the source base. The separate optional Teams SDK uses its existing committed npm lock.

## Validation findings retained

The initial broad Node run found five failures: the native Teams test SDK and the `ws`
transport dependency were unavailable. A subsequent run with dependencies resolved passed
1026 cases but cancelled one 15-second cold-start Teams test while compilation was active;
it was not called a passing suite. That exact native Teams test then passed alone in about
one second, without timeout changes or weaker authentication. Final full-gate status is
recorded below only after a complete fresh run.

Gitleaks initially reported four findings. The example master key was removed, not allowlisted.
Three non-secret fixture/idempotency fields received path-and-rule-scoped exceptions. The
follow-up snapshot scan passed, and an independent high-entropy synthetic credential canary
still caused rejection inside an otherwise allowlisted artifact, with report bytes redacted.

## Blocked or deliberately deferred changes

| Item | Why it is not silently changed | Required follow-up |
| --- | --- | --- |
| Rust and `.test.mjs` discovery | The evaluator still detects only a small subset despite native execution. Its CLI has no documented external-result import. | Provide an upstream Cargo/Node reproduction; use an officially supported evaluator update, not fake/renamed tests. |
| Required CI/security checks and code-owner review | Files do not establish native ruleset enforcement. | An authorized owner must review current check producers and apply the exact policy after hosted validation. |
| Hosted secret scan and dependency updates | New source configuration has not yet produced hosted receipts. Native CodeQL default setup is already configured and passing. | Publish the draft and retain new hosted receipts; preserve native CodeQL rather than adding a conflicting advanced job. |
| Automatic agent repair / recurring maintenance | Repo Steward is intentionally read-only. A schedule alone is not a verified closed loop. | Approve one bounded native-harness pilot with independent validation, budgets, cancellation, rollback and real recurring receipts. No auto-merge. |
| SQLx and native-session ignored tests | Need explicitly owned fixtures, not the user's retained office/database. | Run separately scoped acceptance; keep ignored counts separate. |
| Example key exposure in old history | Removing a sample from the current tree does not revoke any deployed use. | If anyone used it outside disposable development, owner must rotate through the secret-management process. Do not rewrite Git history automatically. |
| Clean dependency bootstrap on this host | npmjs.org TLS handshakes fail. The existing Microsoft public package mirror can serve dependencies, but strict pnpm tarball-URL checks reject mixing registry identities with the original lock. | Restore approved registry connectivity or agree a separately reviewed mirror/lock policy; never disable TLS or supply-chain checks. Current installed-dependency checks are not clean-install proof. |
| Real-provider/production acceptance | Local fixtures and unit suites cannot certify these boundaries. | Run separately authorized browser/server/runner and provider acceptance with genuine identities. |
| Runnable devcontainer | Docker CLI exists, but the Docker Desktop Linux engine pipe is unavailable on this host. A config-only addition is not a proven bootstrap. | Validate a scoped Linux development lane on an available daemon; preserve the Windows-only native-provider boundary. |
| Harness/MCP bootstrap configuration | No project-scoped authorized endpoint/identity was selected for automatic agent-tool startup. | Review native harness capabilities and exact endpoints; do not add placeholder tool grants solely for a documentation score. |

The honest optimization target is the best validated result within the authorized scope, not
an invented global maximum. Do not remove working security or review boundaries for points.

## Validated iteration 1 and further hardening

The complete `pnpm check` receipt at `2026-09-18T04-41-42-248Z-full.json` passed all eight
checks with no source changes during validation: 1027 Node cases passed; 554 Rust cases
passed, zero failed and 343 were explicitly ignored. Migration validation covered 41
migrations; formatting, Clippy, web build and web lint passed. The portable receipt is
[retained here](reports/ai-readiness-validation-iteration-1.json), with its exact earlier
source fingerprint. Later tooling/ledger edits are not retroactively covered by that receipt.

Iteration 2 adds black-box tests of the actual CLI: mutation-free preview, argument rejection,
failure short-circuiting, observed result counts, and invalidation after a passing test edits
source. A nested-test environment failure was retained and fixed in the test fixture; the
driver now also rejects a zero-exit test command with no observed test summary. Windows
CRLF checkouts and native pnpm argument vectors have explicit regressions. These are new
functional tests of the new tooling, not renamed legacy tests or synthetic product evidence.

The 14 focused helper/CLI tests and all four YAML configuration parses passed. At that
checkpoint the complete validation and benchmark were still pending; their final results
are recorded below. No user-facing application code or deployed policy was changed.

The native scanner now recognizes five test files and scores Testing L4: the existing
native command/configuration plus the new black-box CLI suite satisfy its configured-suite
rule. This does not resolve the underlying undercount of inline Rust or `.test.mjs` cases.
Foundations reached 87.0, but operations remain 51.75. The original score is retained.

The broad iteration-2 test invocation, run concurrently with the judge benchmark, again
cancelled the same 15-second Teams SDK startup case (1034 passed, zero failed, one cancelled).
This is a retained load-sensitive failure, not a green run. Final validation is serialized
without our benchmark processes; neither authentication checks nor timeouts are weakened.

The remaining operation gap is explicit in the judges' findings: source files and a local
report do not establish recurring hosted repair, learned-rule promotion, accepted autonomous
changes or production evidence. Cleanup capability remains 70/100 with scheduler enrollment
unverified. Documentation drift coverage is the generated command/version contract only,
not complete semantic coverage of the repository.

## Final local gate

The serialized `pnpm check` at `2026-09-18T04-54-51-203Z-full.json` passed all eight gates
with `sourceChangedDuringValidation=false` and no unexecuted checks:

- Node: **1035 passed, 0 failed, 0 cancelled, 0 skipped**.
- Rust: **554 passed, 0 failed, 343 ignored**; this is one Windows workspace invocation,
  not a sum of overlapping hosted matrices.
- All 41 migration checks, documentation contract, formatting, Clippy, web build and lint passed.
- Gitleaks snapshot scan and the independent redacted synthetic-secret rejection control passed.
- Four YAML configurations parsed successfully; hosted execution remains unproven.

The [portable final validation receipt](reports/ai-readiness-validation-iteration-2.json)
records the exact validated source fingerprint. Receipt/ledger additions after that run
are reporting-only changes, not retroactive changes to what the run verified.

An intervening validation attempt exposed the helper rejecting pnpm's native `.mjs` entry
point after Node/Rust checks passed. The accepted entry points now include `.js`, `.cjs`,
`.mjs` and `.exe`, use explicit argument vectors without a shell, and tool-resolution
failures are recorded instead of escaping before the receipt is saved. Regression tests
and the complete final gate passed; the earlier attempt is not reclassified as successful.

The branch remains a local candidate: no commit, push, PR, ruleset update, hosted dispatch,
live secret rotation, Teams activation or deployment has been performed. The next external
step needs its own exact preview/approval, including any protected-environment configuration.

This paragraph describes the end of the local optimization pass. On September 18 the user
subsequently authorized draft PR publication and review of relevant open work. Publication
links and current CI belong in the PR; old benchmark rows remain historical observations,
not a new score for a later publication head. Repository-settings changes still receive an
exact preview and separate confirmation before application.

The final benchmark retained 67.1 rather than reporting an assumed increase. Its operation
breakdown moved maintenance automation from 2 to 1 and continuous improvement from 1 to 2,
leaving the same total; keep this judge variance visible rather than choosing only favorable
dimensions. Further identical re-runs are not engineering progress. The remaining large
gains need the scoped operational proofs in the blocker table. Hourly synchronization is
restored after this pass, but its existing guard skips this worktree while changes remain
uncommitted; it never discards them or silently publishes the candidate.

Publication review also enrolls `.github/skills/` native package tests so PR #304's integrity
gate is not lost when both contributions land. This does not import or approve that draft's
review policy. The new PR is a partial, non-closing contribution to existing issue #317;
its JUnit, broader version-contract and hosted Windows criteria remain separately tracked.

The publication follow-up passed 15 focused helper/CLI tests and all six required repository
gates (41 migrations; format/Clippy; 554 Rust passed, 343 ignored; web build/lint). The fresh
broad Node invocation at `2026-09-18T05-24-29-620Z-full.json` passed 1035 cases and cancelled
one existing 15-second Teams SDK case; it is not recorded as a green full gate. This known
intermittent failure, clean-bootstrap limitation and independent review keep publication draft.
The earlier 67.1 result remains a historical candidate score, not a fresh published-head score.

After the exact settings preview was approved, native GitHub security and main-branch
controls were enabled and verified. The scoped #323 checkpoint-test portability repair,
regressions, retained Teams timeout and separate required-gate results are recorded in the
[September 18 follow-up](reports/ai-readiness-portability-followup-2026-09-18.md).
This supersedes the earlier not-yet-applied settings status, not the historical benchmark.
