# Native operation observations and recovery evidence — September 17, 2026

The read-only observation exporter and consumer passed six initial native API checks and four fresh checks with final code, covering six distinct accepted, failed, cancelled and recorded-publication runs. Final code also passed 68 focused tests using the compiled native MCP gateway and controlled HTTP fixtures, followed by the full 964-test Node suite. Two deterministic native Factory recovery cases passed. The initial live exports preceded the final metadata-compatibility and HTTP-body-limit refinements; the four retained-run rechecks exercised those refinements. The CLI extraction experiment was fully reverted; final CLI sources match the recorded base.

The [machine-readable evidence](assets/codeblend-readiness/operation-observations.json) records exact run identities, receipt/source/binary hashes, outcomes, timing and the preserved attempt history. It excludes private snapshots, endpoint URLs, signature values, credentials and workspace paths. Usage and interpretation are in [operation observations](../OPERATION_OBSERVATIONS.md).

## Actual exports and online consumer checks

Each export read the selected native run through MCP, obtained exact mission/Factory context where applicable, downloaded its available artifacts, and compared selected state before and after collection. Each consumer then reread native state through trusted host configuration. The input byte hash identified the supplied receipt; it did not grant authority.

| Initial native selection | Run ID | Run / verifier | Check history complete | Verified artifacts | Consumer |
| --- | --- | --- | --- | --- | --- |
| Owned completed run | `1c5c7d53-7afd-4c69-be8a-dfc71487d8e3` | completed / passed | Yes | 2; 5,173 bytes | exit 0 |
| Owned failed run | `bef4a81c-d1a4-4a1c-b600-35072203f496` | failed / failed | Yes; failed check retained | 1; 2,190 bytes | exit 1 |
| Retained completed run | `44b2c3bd-bf10-435a-ac8d-12768f701e00` | completed / passed | Unknown/incomplete | 2; 1,931 bytes | exit 0 |
| Retained failed run | `23cebb8d-49d9-49d6-a8de-571476728885` | failed / failed | Yes; failed check retained | 1; 1,358 bytes | exit 1 |
| Retained cancelled run | `c9c179e7-7fe8-434d-8fc7-c5bb134f0c88` | cancelled / pending | Unknown/incomplete | 0 | exit 1 |
| Retained published result | `901ee3f2-1aa2-406e-905b-d5596c2289b5` | completed / passed | Yes | 2; 81,271 bytes | exit 0 |

All three negative consumers returned `native_acceptance_not_observed`. Export times were 302–814 ms; consumer times were 546–1,069 ms. The retained completed case demonstrates that native persisted acceptance and available individual-check history remain separate fields. The recorded publication selected its exact run/task/deliverable/artifact; no current GitHub PR read or publication effect occurred.

These six exports and six consumer checks were recorded against development identity before the final metadata and body-limit refinements. The owned API was subsequently stopped and was not restarted for the final observation checks.

At `2026-09-17T20:55:11.4366684Z`, final source and the bounded native MCP binary (`d62a24612fbb0c1e9cd208a5011bd2ddbf3dd1828754d339c24cb295748e8781`) repeated export and consumption against the separate retained development API. All four exports exited zero; completed and published-result consumption exited zero, while failed and cancelled consumption exited one with `native_acceptance_not_observed`. This adds four observations and four consumption checks to the original six: ten of each across six distinct runs. It preserves the original owned-phase evidence and makes no final owned-API rerun claim.

## Actual native control-plane recovery

A stopped, ownership-verified PostgreSQL cluster was reused with a new database. The retained prior database was preserved. A fresh tiny Git source, copied native CLI/server/runner binaries, the existing `fake-process` child and fake GitHub CLI boundary exercised real state transitions and worktrees. The native binary build passed in 42.18 seconds.

| Case | Fault and recovery | Run ID | Final evidence |
| --- | --- | --- | --- |
| Automatic status-write recovery, attempt 3 | One injected Project status-write failure left a blocked work item linked to a mission with zero runs. Native `factory-watch` retried on its next cycle without an operator reconcile request; replay preserved the same lineage. | `7faa9c9c-6303-44ef-8f22-b8df368b6c0c` | verified; completed/passed; 2/2 checks |
| Controller interruption/replay, attempt 2 | A proxy held materialization after durable claimed/v1 state and before Project mutation. The exact owned controller was stopped. Explicit native restart/replay reused the claim and created one mission/task/run. | `54255150-63c9-4bfd-a57e-f12782435893` | verified; completed/passed; 2/2 checks |

Each case ended with exactly one work item, mission, task and run, a `commit_branch` deliverable in `ready_for_review`, and zero publications. The negative fixture applied a 10,000,000-byte artifact floor to the real child output: run `bef4a81c-d1a4-4a1c-b600-35072203f496` remained failed with one failed verifier and zero `run.completed` events.

The original tiny source remained clean at commit `f44ce30f1a1836cd5cacac300f0516cfdb23c9ad`; its README SHA-256 remained `2e1acec1881b51f5d22344dbfd338a8db705fd6067f0fe6a4768fd50ff8827ac`.

All three harness attempts are retained. Attempt 1 exposed a missing fixture crew and an incorrect expectation that a status-write failure would carry quota backoff. Attempt 2 proved interruption/replay and the negative verifier, but missed the brief blocked-state observation while awaiting process launch. Attempt 3 began observation concurrently with launch and proved the status-write case in 27.705 seconds. Its combined report incorporates the original attempt-2 results; it does not represent another execution of those cases. The complete attempt window was 291.233 seconds, within the ten-minute fixture deadline. Native counters, failed records and worktrees were not reset to retry.

The recovery cases use the copied binary hashes in the machine evidence. The later CLI extraction experiment was neutral and fully reverted: the final CLI source tree matches `a86822071790c271974919b341b9a5bbf47d0346`, with no CLI production changes remaining. Recovery evidence does not establish provider inference, source-code repair, an unattended process supervisor or a human review decision.

## Native Codex project registration

Codex 0.152.0 loaded the trusted project's `.codex/config.toml` in an isolated Codex home. Native strict-config startup, `config/read` and `mcpServerStatus/list` confirmed the configured `crony-mcp --read-only` process initialized and advertised exactly `crony_snapshot`. Registration forwarded the four named host-routing/credential variables, used native 10-second startup and 30-second tool timeouts, and introduced no approval overrides or embedded identity values. Configuration SHA-256: `047e4f019980e0e6c856124475acf364b6aee91ad3f0288165bc1a89838bce10`.

The successful check took 1.303 seconds with the bounded gateway identified below. It sent no model turn, supplied no credentials and changed no existing personal configuration. Initial trust/configuration failures remain retained separately; the successful linked-worktree check followed the actual underlying repository root named by Codex's trust diagnostics. The returned `authStatus: unsupported` describes MCP OAuth support, not ECorp authorization. Initialization and catalog discovery do not prove an authenticated snapshot read; the separate API observations above cover that path only for their recorded development scope.

## Read-only HTTP body boundary

The native read-only client now checks a declared `Content-Length` before reading and counts streamed bytes before JSON decoding, for successful and unsuccessful responses. The raw HTTP-body ceiling is 16 MiB; the JS probe separately caps stdio output. Oversize errors use a fixed diagnostic without response content. Existing unrestricted transport retains its behavior.

Four regression cases kept oversized bodies open: declared length and chunked overflow, each with HTTP 200 and 403. The retained baseline failed all four by reaching the five-second fixture timeout. The fixed binary rejected them in 53–89 ms. Boundary cases accepted exactly 16,777,216 raw bytes in read-only mode and 16,777,217 bytes in unrestricted mode; small success/error behavior and the probe's diagnostic redaction remained compatible.

The fixed native MCP SHA-256 is `d62a24612fbb0c1e9cd208a5011bd2ddbf3dd1828754d339c24cb295748e8781`. The complete compiled probe suite passed 14/14 in 3.678 seconds. Gateway package tests passed 14/14, with formatting and Clippy clean.

## Native Rust unit coverage baseline

The instrumented Windows/MSVC workspace run measured **45.8057% line coverage** (34,128/74,506) and **58.1902% function coverage** (2,643/4,542), using cargo-llvm-cov 0.9.1, Rust 1.98.1/LLVM 22.1.8 and Node 22.23.2. It passed 555 tests with 333 ignored prerequisites in 500.179 seconds, with source hashes unchanged. Native JSON and LCOV reports cover 69 reported files under the tool's default semantics; no code exclusions were requested. The machine evidence retains their byte hashes and selected native tool hashes.

The Windows job in [Repository checks](../../.github/workflows/repository-checks.yml) preserves future native JSON, LCOV, test logs and Rust/Cargo source identities. Its initial 45.0% line floor allows 0.8057 percentage points below this measured baseline for platform and test-branch variation; function counts remain visible without another floor. This is unit-only coverage: the 332 opt-in database cases and explicit stopped-session probe remain ignored. Native actionlint 1.7.12 and both PowerShell blocks passed validation. Executing the exact workflow snapshot captured all 99 expected Rust/Cargo files with matching hashes; an empty repository was rejected without creating a manifest. No hosted execution is claimed.

The separate owned-database stage passed all **332/332 SQLx cases**, without retries, in 1,490.663 seconds and accumulated their native profiles with the preserved unit baseline. Combined coverage is **72.2586% of lines** (53,837/74,506), **75.1211% of functions** (3,412/4,542) and **72.4212% of regions** (69,050/95,345). The 69 reported files and line/function/region denominators are unchanged; no exclusions were requested and source hashes remained unchanged. This represents 887 passed tests across both stages, with only the explicit stopped-session probe unexecuted. It is separate from the unit-only CI job and establishes no provider-inference coverage.

Native report-only threshold checks on those combined profiles returned exit 0 for a 45.0% line floor and exit 1 for 100%, preserving all 12 raw profiles and source hashes. The owned PostgreSQL process was stopped through verified native shutdown at `2026-09-17T21:28:15.5597140Z`; its process and listener were absent, database files were preserved, and other stacks were untouched. Native report and cleanup hashes are retained in the machine evidence.

## Final validation and cleanup

With Node 22.23.2 and the fixed native MCP binary configured through `CRONY_MCP_TEST_BINARY`:

```powershell
node --test tools/operation_receipt.test.mjs tools/probe_mcp.test.mjs tools/consume_operation_receipt.test.mjs
```

The final result was 68 passed, zero failed and zero skipped in 3.474 seconds. Coverage includes native-valid bounded metadata, exact scope and publication linkage, changed-state rejection, failed outcomes, input integrity, artifact bytes/headers, redirects, timeouts, HTTP body limits and private-field omission. The earlier 57-test result belongs to the initial live-observation phase and remains retained separately.

The complete Node suite then passed 964 tests with zero failures, cancellations or skips in 56.057 seconds (56.223 seconds wall time), using Node 24.19.0 and the compiled MCP fixture binary:

```powershell
node --test --test-concurrency=2 --test-timeout=180000 apps/web/src/**/*.test.mjs tools/*.test.mjs
```

Fresh workspace Rust validation also passed on Rust 1.98.1 with two build jobs and two test threads:

| Check | Outcome | Wall time |
| --- | --- | --- |
| `cargo fmt --check` | Passed | 3.649 s |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | Passed | 60.145 s |
| `cargo test --locked --workspace -- --test-threads=2` | 555 passed; zero failed; 333 ignored | 277.943 s |

All 99 Rust source and manifest hashes remained unchanged across these checks. The first test attempt failed because the managed PATH lacked a real `npm.cmd` for the existing Windows npm-verifier test. Adding the installed Node 22.23.2/npm 10.9.8 directory to the clean test process PATH fixed that prerequisite: the targeted regression passed, then the full workspace retry passed. The original failure and retry logs are both retained; no source or assertion changed to obtain the pass. The 333 ignored cases comprise 332 opt-in database fixtures and one explicit stopped-session provider probe; this ordinary Rust run does not claim those prerequisites were exercised.

Owned recovery cleanup passed at `2026-09-17T20:20:02.2296049Z`: controllers, runner, server and PostgreSQL stopped; the runner was revoked and its ephemeral identity files removed; no owned listeners remained. Both databases, the cluster, source, all five terminal-run worktrees, artifact objects and logs were preserved. The unrelated retained stack was not controlled by the recovery fixture.

This report adds no offline authenticity, production-identity proof, live GitHub effect, benchmark local-loop qualification or CodeBlend score-gain claim. Accepted observations remain read-only evidence; later effects require current native authority.
