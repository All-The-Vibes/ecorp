# PR255-QA-IDENTITY / A-001 — scoped correction

Date: September 21, 2026.
Worktree: `C:/Users/sschofield/repos/ecorp-pr255-review-fixes`.
Starting and verified final HEAD: `690ee80e692d848c4c3a371ddb31388a78b9ddf3`.
Status: implemented and locally verified; **not full PR acceptance or independent approval**.

## Own changed paths

- `tools/local_stack.psm1:26-48,72-100`: reuse the exact
  `Get-LocalProcessIdentity` and `Stop-LocalOwnedProcess` function bodies from
  `ecorp-pr237-progress-correction`. Only the precisely identified native
  missing-PID error or a confirmed exit represents absence. Access/query/getter
  uncertainty throws. Native getter calls prevent PowerShell's property adapter
  from hiding inspection failures. Termination retains the original verified
  process handle, executable/workspace checks, exact native creation ticks, and
  successful native wait requirement.
- `tools/issue161/qa-host.ps1:171-172`: document the now-unambiguous shared
  contract at cleanup. No new supervisor or result protocol: existing errors
  escape before `stopped_verified` or `Save-State`.
- `tools/local_stack_identity.test.ps1:1-181`: reuse PR237's focused identity
  regression and add execution of qa-host's actual AST-extracted Stop clause.
  Cover unavailable inspection, byte-preserved receipts, no false success,
  mismatch, verified owned stop, and repeated confirmed absence.

No other repository files were edited by this worker. Other workers' changes
were left untouched. No commit, push, GitHub call, executor-state mutation,
round allocation, or agent allocation was performed.

## Caller trace before changing the contract

The complete search is retained in `identity-callers.txt`.

- `Test-LocalOwnedProcess`: null remains false; uncertainty now propagates.
- `qa-host.ps1`: Assert-Pg, StopRunnerA, Inspect, and both Stop identity checks
  propagate exceptions under the script's Stop error policy. The non-Postgres
  Stop body is exercised with real shared functions and only an owned inert child.
- `stop_local.ps1`: verified stop records success; false stop queries identity
  for mismatch versus confirmed absence. Unknown inspection now aborts before
  persisting an absence claim.
- `local_stack_start.ps1`: Role-Live feeds port/configuration guards, Launch,
  readiness, and existing-live detection. Uncertainty aborts instead of becoming
  permission to launch/replace. Launch rollback catches errors only to retain
  them on the original persistence failure with unverified cleanup.
- `qa_factory_run_activity.ps1`: Status and Stop identity checks propagate
  uncertainty before the final stopped-state write. Existing mismatch behavior
  is unchanged and outside this correction.
- `local_stack_lifecycle.test.ps1`: identity, malformed/mismatched record,
  retained-handle stop, absent retry, launcher rollback, state round-trip, and
  legacy-record call sites retain the existing bool/null contract on known
  outcomes. Module and Source suites were both executed.

## Real chronological TDD

| Execution | Passed | Failed | Exit |
| --- | ---: | ---: | ---: |
| RED, unchanged production files at starting HEAD | 19 | 27 | 1 |
| GREEN, after minimal fix | 46 | 0 | 0 |
| Final GREEN, after restoring consistent CRLF only | 46 | 0 | 0 |
| Existing lifecycle Module suite | 20 | 0 | 0 |
| Existing lifecycle Source suite | 10 | 0 | 0 |

There are **46 distinct focused regression cases and 30 existing cases**:
76 distinct passing checks, not 122 tests from counting repeated GREEN twice.
RED was behavioral, not a setup failure: six qa-host unavailable-identity cases
silently succeeded on the original code, and the shared identity checks
suppressed inspection errors. Two additional preservation checks caught attempted
termination under hidden getter uncertainty; the mock Kill prevented any effect.
All RED/GREEN runs verified cleanup of their own inert child.

Exact commands, raw output, exits, and pre-run SHA-256 hashes:

- `red-command.txt`, `red.log`, `red-exit.json`, `red-input-hashes.json`
- `green-command.txt`, `green.log`, `green-exit.json`, `green-input-hashes.json`
- `green-final-command.txt`, `green-final.log`, `green-final-exit.json`,
  `green-final-input-hashes.json`
- `lifecycle-module-command.txt`, `lifecycle-module.log`,
  `lifecycle-module-exit.json`, `lifecycle-module-input-hashes.json`
- `lifecycle-source-command.txt`, `lifecycle-source.log`,
  `lifecycle-source-exit.json`, `lifecycle-source-input-hashes.json`

The focused test file's RED/GREEN contents were identical; `red-green-test.ps1`
retains those bytes. Final changes to that test and qa-host after first GREEN
only restored the checkout's CRLF convention; final GREEN binds the delivered
bytes. `before-*`, `tested-*`, `input-hashes.json`, `final-input-hashes.json`,
and `scoped.patch` retain source evidence. Each focused run also retains its
owned workspace, ownership receipt, and structured report under its phase folder.

## Diagnostics and safety

- PowerShell 7.6.5; Node v24.16.0.
- Seven affected/caller/test PowerShell files parsed with zero errors; delivered
  three files rechecked after newline normalization (`powershell-parse.json`,
  `final-diagnostics.json`).
- Scoped `git diff --check`: exit 0, final output empty
  (`final-diff-check.log`). Initial mixed-newline Git warnings were retained in
  `final-validation.log` and resolved without semantic changes.
- Both copied function bodies matched the donor exactly (`reuse-proof.json`).
- Module tests created 14 inert, lease/TTL-bounded children and verified zero
  remaining; each focused run created one inert 60-second child and verified its
  exit using its retained creation handle. The Source suite created none.
- No existing/manual process was inspected or stopped. No API, browser, database,
  runner-local, provider, or service fixture was used. Protected API 8791, web
  5187, and DB 54329 were not contacted. No dependencies were installed.

## Limits / stop condition

Unavailable-access/getter cases are controlled native-boundary injections against
our own inert child, not tests against privileged or unrelated OS processes.
qa-host's Stop body was exercised without executing its top-level fixture setup
or its PostgreSQL branch. This is not full service cleanup or browser/server/runner
acceptance. PowerShell parsing, module import, and execution are the applicable
build checks; Rust/web builds, DB tests, hosted CI, screenshots, and independent
full-PR review were not run or claimed.

A-001's bounded local correction is verified. Remaining PR findings, integration,
publication, and acceptance gates belong to the leader and their assigned owners.
