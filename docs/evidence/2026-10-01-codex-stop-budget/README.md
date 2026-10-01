# Codex suspend and stop budget evidence

Issue #87 is locally implemented and validated against main `878a1774774b0630c904cbaf4b05e1b346777817`.
The exact tested source tree is `636ea213bd1df15e19ffe67fd0ccf1f7326f0693`; it contains
7,156 source files. [Physical hashes](source-manifest.json) and
[Git blob bindings](source-binding.json) identify the source shared by canonical
R4 and all four refreshed acceptance drivers. This packet is added afterward and
requires separate publication checks before its commit is published.

These are October 1, 2026 retrospective regressions. They do not reproduce the
September 3 incident. GitHub Actions is disabled, so required hosted CI,
CodeQL, code-quality/security and review gates are unavailable. The change
remains a draft; no merge, issue completion, independent approval or human
signoff is claimed. Historical Cargo advisory debt is not a clean audit.

## Acceptance criteria and observed evidence

| Issue criterion | Implementation and evidence |
| --- | --- |
| Separate control and usage clocks | Server socket-send observation, runner receipt, adapter receipt, interrupt queue/write/reply, native terminal, child termination and last usage observation are distinct persisted fields. Browser results retain both runner observations and server recording times. Authenticated receipt tests cover all three control stages and old callers without runner timestamps. |
| Bound suspend/stop termination | The adapter fixes a two-second interrupt deadline at first receipt, including startup and blocked writes; escalation cannot extend it. Windows reuses owned Job Object teardown with a 350 ms grace and a five-second verification attempt. Deterministic cases cover blocked stdin, delayed startup, ignored interrupts, EOF/live child, correlation races and owned descendants. Unverified teardown retains supervision and cannot claim termination. |
| Distinguish cumulative/buffered reports | Usage is scoped to the active native thread/turn; duplicate and regressing totals cannot re-charge. Cumulative/latest counters and receipt time remain distinct. Buffered observations retain their original receipt time and control state. Neither receipt nor cumulative advancement establishes provider generation time. |
| Bounded charging grace | The ledger applies five seconds from the first authoritative hard incident using database time after Corp/run locks. Late and terminal reports become idempotent noncharging observations. Native database tests cover lock waits, escalation, replay on both sides of cutoff, missing boundaries and scope spoofing. This rule does not cap provider invoices. |
| Durable constrain/suspend/stop acknowledgments | Receipt tests cover all stages, foreign Corp/runner, stale epochs and reconnect locking. Browser acceptance confirms constrain/suspend and stop dispatch/acknowledgment. Offline stop persists and reuses its original incident/command. Acknowledgment is separate from native process termination. |
| Deterministic and real-provider coverage | [Focused receipts](focused.json), [acceptance receipts](acceptance.json) and screenshots retain the actual outcomes below. One bounded real Codex operation completed the stop acceptance. Start/steer/two-resume/ordinary-interrupt coverage protects normal lifecycle behavior. |
| No artifact or accepted completion after hard stop | StopRun latches the existing runner boundary; late transcripts cannot reach artifact upload, verification or accepted completion. Native store coverage fences historical stops. Emergency and budget-stop lifecycle scenarios cancel, preserve their workspaces and retain no accepted artifact/completion. |

## Canonical validation

`pnpm install --frozen-lockfile` passed. Canonical `pnpm check` R4 passed
the complete current plan; no gate was omitted. Its original readiness and
process receipts are in [canonical.json](canonical.json),
[the command log](logs/canonical.log) and
[the observed process exit](canonical-session-exit.json).

| Gate | Result | Duration (ms) |
| --- | --- | ---: |
| migrations | Passed | 139 |
| state-audit-compatibility | Passed | 111 |
| state-audit-evm | Passed | 23277 |
| docs | Passed | 114 |
| repository-docs | Passed | 133 |
| node-tests | Passed | 2891060 |
| format | Passed | 3643 |
| clippy | Passed | 43297 |
| rust-tests | Passed | 1219374 |
| web-build | Passed | 9541 |
| web-lint | Passed | 3290 |

Node: **3,103 tests, 3,038 passed,
0 failed, 65 skipped,
0 cancelled and 0 todo**.
Rust workspace totals: **898 passed, 0
failed, 577 ignored across 41
reported summaries**. Ignored/skipped cases are not passes. The EVM compatibility
lane separately executed one test against the local anchor contract.

The first canonical run failed in Node on missing local prerequisites:
two Teams SDK tests lacked the standalone scenario's locked dependencies and
eleven native evidence/startup tests resolved Python to the Windows Store
launcher. The scenario was installed using its existing package-lock with
`npm ci --ignore-scripts --no-fund --workspaces=false` (117 packages added,
118 audited, zero npm vulnerabilities). A real Python 3.12.14 runtime was
selected through process-local environment settings. All 32 affected tests
then passed without skips and with unchanged source. Canonical R2, R3 and R4 used
that same environment. No dependency file was changed.

Canonical R2 then exposed a deterministic test-fixture framing defect: with
serial libtest execution, the default formatter prefixed the native EOF child's
first JSON response. Initialization never completed, so the adapter never
reached the intended EOF. R2's Node lane passed 3,038 cases with 65 skips; the
runner lane passed 299, failed this one case, and ignored five. Remaining
workspace and web gates did not finish. A direct formatter comparison confirmed
that terse mode preserves a standalone JSON frame. The test-only correction
also pins the child to serial mode; the isolated regression passed in 0.58
seconds. R3, R4 and all final acceptance lanes ran on the corrected
7,156-file source. The first R3 wrapper invocation preceded its source snapshot
and exited before starting any test; its separate startup receipt is retained.

Canonical R3 failed the existing F02 hostile-filter cleanup case: 3,037 Node
tests passed, one failed and 65 were skipped. The CLI left a scratch directory,
but the original fixture removed its diagnostics. The underlying cause is
unconfirmed. Three subsequent exact repetitions each passed with preserved
native diagnostics: Git emitted 8,385,109 stderr bytes in 294–324 ms, and the
CLI rejected the filter in 869–963 ms with empty scratch contents. The test
sets a 1,000 ms whole-check budget and a 5,000 ms external watchdog; timing
sensitivity is a hypothesis, not an established cause. R4 retained all of this
test file's native fixtures through a process-local diagnostic setting and
passed without changing source, assertions, timeouts or cleanup safeguards.
The R4 pass does not establish that the unexplained R3 failure was fixed.

The ten optional native Gitleaks/reporting fixture tests were also executed
separately before the EOF-only test correction with the verified Gitleaks 8.30.1
binary: 10 passed, no failures or skips. Those scanner paths are unchanged.
This is reporter coverage, separate from the publication secret scans
and from required hosted security gates. The package-lock pins Teams SDK
2.1.0; older scenario README prose saying 2.0.16 is preexisting drift.

## Focused validation and product acceptance

Final focused runs matched the canonical source and exited successfully.

| Lane | Native test summaries |
| --- | --- |
| adapter | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 25 filtered out; finished in 0.00s; test result: ok. 27 passed; 0 failed; 0 ignored; 0 measured; 278 filtered out; finished in 42.88s |
| boundary | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 25 filtered out; finished in 0.00s; test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 287 filtered out; finished in 52.30s |
| receipt-clock | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 564 filtered out; finished in 0.00s |
| protocol-receipt | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 11 filtered out; finished in 0.00s |
| native database | test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 552 filtered out; finished in 42.78s |

The database lane used a fresh owned PostgreSQL instance and verified shutdown.
Each full-stack lane used its own database/runtime fixtures, real server,
runner and web UI, and confirmed source preservation and all owned process
shutdowns. Browser assertion counts and adapter-receipt-to-termination
observations were:

| Lane | Passed / failed | Observed latency |
| --- | ---: | ---: |
| acceptance-fixture-suspend-r3 | 14 / 0 | 2471 ms |
| acceptance-fixture-stop-r5 | 15 / 0 | 2454 ms |
| acceptance-provider-stop-r3 | 15 / 0 | 753 ms |

The lifecycle lane separately passed four scenarios: start/steer/two resumes
with artifacts, ordinary interrupt with existing artifact retention, emergency
stop, and budget stop. The last two preserved workspaces with no accepted
artifact or completion. [Screenshots](screenshots/) were visually inspected;
the packet retains their original bytes.

These latencies are observations from the recorded Windows runs, not service
level guarantees. Installed Codex 0.154.0 was used; no repository-enforced
Codex pin or native termination-latency guarantee was established. Unix retains
explicit root-only termination assurance and was not exercised here. Provider
generation/billing timestamps are not observable from these receipts.

## Review, failed attempts and publication boundary

[Implementation self-review](self-review.md) covers authority, isolation,
idempotency, process ownership, hard boundaries and integration risks. It is
the implementing agent's review, not an independent approval. Nearby unmerged
PRs #380, #381 and #390/#391 are outside this tested tree and need separate
integration review; their histories remain preserved.

[Failure history](history/interpretation.json) retains the compile, adapter,
database and prerequisite failures and preliminary passes. Fixture staffing
races and the first provider probe's missing usage baseline were orchestration
defects; they are not historical incident reproduction or a measured failed
termination. Original receipts and logs remain unchanged in the run directory.
The failed Python wrapper guard ran no tests; its receipt is retained under
[environment](environment/).

Public receipt copies redact capability-bearing keys and remove personal
machine prefixes. Full source manifests in historical receipts are projected
with hashes and explicit comparisons; [summary.json](summary.json) maps each
original artifact to its public copy. Evidence-only publication changes are
checked separately for identical canonical command arguments and full Node
discovery, documentation validity, paths, secrets and the exact Git tree.
`docs/PROJECT_MEMORY.md` was absent from current main; the local untracked
copy was preserved and not treated as an upstream contract.
