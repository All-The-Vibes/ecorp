# Issue 87: committed completion and retained stop authority

The follow-up to PR #392 corrects a completion/stop race reported in Copilot
review `5381674279`. The runner now keeps hard stop actionable until the server
commits and acknowledges the exact completion event. Only that scoped receipt
permits ordinary Git-safe cleanup. Verification retains the active run reference
so an operator can still use Emergency stop after artifact finalization.

These October 1, 2026 observations are retrospective. They do not reproduce the
September 3 incident. No independent approval, merge or issue completion is
claimed. Required hosted gates remain unavailable while Actions is disabled.

## Source and reproducibility

- Main base: `878a1774774b0630c904cbaf4b05e1b346777817`.
- Published parent: `9c981ac020f5ba39b652fcaf531c80b5f3cd8a4d`.
- Tested product tree before this new evidence: `4394bf3a912d5c7ab166f6cb25d843e7c3a03a87`.
- Canonical R1, native build R3 and all eight final acceptance drivers used the
  same unchanged 7,312 physical source files.
- The focused runner, protocol and native database receipts identify 273 source
  files and match their subset of that complete manifest.
- [source-manifest.json](source-manifest.json) records physical SHA256 values;
  [source-binding.json](source-binding.json) binds them to Git blobs, accepting
  only identical bytes or CRLF-to-LF normalization. No code changed when this
  evidence was added. Separate publication validation checks the final evidence,
  exact blobs, documentation and unchanged canonical command/test discovery.

Original local records remain immutable outside the checkout. The artifact
manifest in [summary.json](summary.json) maps each original hash to its public
copy and transformation. Repeated source arrays are projected to counts and
hashes, capability keys are redacted with the repository helper, and machine
paths/ANSI/trailing whitespace are normalized. Screenshots retain original
bytes. Failed and superseded attempts remain in [history](history/summary.json).
The earlier [stop-budget packet](../2026-10-01-codex-stop-budget/README.md) is
preserved as history. Its local-finalization sufficiency claim is corrected by
the current [self-review](SELF_REVIEW.md).

## Validation observed on this source

The complete `pnpm check` passed with locked dependencies and all eleven named
gates: migrations, state-audit compatibility, native EVM, documentation,
repository documentation, full Node discovery, Rust formatting, clippy,
workspace tests, web build and web lint. The process exit was observed; logs
and gate-level counts are in [canonical.json](canonical.json) and
[canonical.log](logs/canonical.log).

- Node counts: `{"cancelled": 0, "failed": 0, "passed": 3038, "skipped": 65, "tests": 3103, "todo": 0}`.
- Rust workspace counts: `{"failed": 0, "ignored": 582, "passed": 905, "summaries": 41}`.
- Native EVM: one passed, zero failed or ignored.
- Migrations: 56, immutable checksums accepted.
- Focused runner: 25 passed, zero failed/ignored, 285 filtered; its helper binary
  reported zero selected tests and 25 filtered.
- Focused protocol: two passed, zero failed/ignored, 11 filtered.
- Fresh PostgreSQL: 18 passed, zero failed/ignored, 553 filtered; verified shutdown.

Skipped, filtered and ignored cases are not passes. Focused suites overlap the
canonical suites and their totals are not added. Rust checks use process-local
`RUST_TEST_THREADS=1`, two build jobs, no incremental build and debug level zero.
Inherited database URLs were cleared. Locked pnpm installation and the final
native server/runner build receipts are retained under `environment`.

| Complete local stack lane | Observed result |
| --- | --- |
| Completion held, browser stop commits first | 7 assertions passed; applied acknowledgment; run/task cancelled; clean source retained; no accepted completion or retry |
| Completion accepted | 6 assertions passed; real matching server receipt; clean-worktree removal |
| Committed receipt withheld | 7 assertions passed; bounded wait; retained source; authoritative state still completed; no retry |
| Receipt request omitted | 7 assertions passed; no unsolicited receipt; retained source; no late failure or retry accepted |
| Deterministic suspend | 14 assertions passed; adapter receipt to termination 2,455 ms |
| Deterministic stop | 15 assertions passed; adapter receipt to termination 2,456 ms |
| One bounded real Codex stop | 15 assertions passed; adapter receipt to termination 742 ms; 21,832 input and 174 output tokens observed |
| Normal and hard-stop lifecycle | Four passing scenarios: start/steer/two resumes, ordinary interrupt, emergency stop and budget stop |

Every lane has native exit zero, unchanged source, matching final native
binaries and verified cleanup of its owned web/server/runner/database and
acceptance processes. Completion lanes also stopped their owned message gate.
These are observed local timings, not production guarantees. The legacy lane
only omits the receipt request; it does not run an old server or runner binary.

The stop-first gate held real completion at `16:34:20.624Z`, forwarded the
browser stop at `16:34:21.904Z`, observed the applied acknowledgment at
`16:34:21.905Z`, and released completion at `16:34:22.110Z` on October 1, 2026.
The run was `75c77194-6aa3-44e6-af48-5bf8f7e81503` and held event was
`7db214a9-971c-4888-8786-c86d17aa7967`. The runner's locally queued event did
not override the committed stop. Native database tests separately forced both
transaction orders through actual lock contention.

[acceptance.json](acceptance.json) contains the observed assertions and
scenario results. Each lane's original driver, browser/lifecycle and process
logs are under `acceptance`. Three inspected screenshots are under
`screenshots`: the held mission, cancelled settlement, and accepted settlement.
The held mission screenshot does not show Emergency stop; that action is
exercised subsequently in Control floor and recorded in the browser receipt.

## Issue acceptance mapping

| Issue #87 criterion | Implementation and current evidence |
| --- | --- |
| Separate directive dispatch, runner receipt, adapter interrupt, termination and final usage clocks | Durable socket/control observations and Codex adapter diagnostics; fresh suspend, stop and real-provider browser receipts retain distinct timestamps |
| Bound suspend/stop termination | Native `turn/interrupt`, a deadline fixed at first control receipt and existing owned-process teardown; fresh fixture/provider lanes above and canonical adapter regressions |
| Distinguish buffered/cumulative usage | Native thread/turn correlation, monotonic cumulative counters and once-only latest deltas; raw usage observations remain distinct from charging and cannot prove provider generation time |
| Bound charging grace | Five-second authoritative ledger grace sampled after Corp/run locks; terminal/late reports are noncharging observations; fresh native database regressions |
| Durable constrain/suspend/stop acknowledgments | Existing commands with Corp/runner/live-epoch authorization, replay handling and receipt times; canonical protocol/control tests and real stop-first applied receipt |
| Deterministic and real-provider regression | Fresh delayed-output suspend/stop, four completion lanes and one real Codex operation through the complete local stack |
| No artifact or accepted completion after hard stop | Existing hard boundary and persisted verifier policy plus exact committed completion receipt; stop-first native database and browser cases, active-run retention during verification and cancelled lifecycle lanes |

An artifact accepted before a stop is distinct from one accepted after it.
Matching completion receipts authorize cleanup only after the server's commit;
they do not weaken verifier policy or authorize new effects. Missing receipts,
pending approval, cancellation, failure and recovery retain source. A typed
`completion_unconfirmed` failure cannot trigger execution in a fresh workspace.

## Failed attempts and limits

The new regression on the published implementation failed as expected: zero
passed, one failed, zero ignored, 304 filtered, native exit 101. It demonstrates
the code race retrospectively. Build R1 failed on an unqualified `Value::Bool`;
that compile error was corrected before later builds. The first completion
acceptance waited on transport observation before persisted verification; the
second found an owned-fixture CRLF/LF mismatch. The third found the real missing
active-run-reference defect after two passing assertions. Product and fixture
corrections preceded the final R4 stop-first acceptance. Their receipts and
diagnostics are preserved instead of being relabeled as passes.

The prior packet's F02 hostile-filter failure remains unexplained; subsequent
passes do not establish a root cause or fix. Historical Cargo advisory debt
remains. This packet is not a clean historical dependency audit. Installed
Codex 0.154.0 was observed, but no repository-enforced harness pin was found.
Unix descendant termination was not proven and retains root-only assurance.
Mixed-version convergence, provider internal timing/billing and production
latency guarantees are not established. Scope is the recorded Windows fixtures
and one bounded real-provider run.

GitHub Actions remains disabled and the required hosted CI, CodeQL, code-quality
and security checks have not run. The existing Copilot review identified the
race addressed here; its successful check status does not satisfy those missing
checks. The implementing agent cannot independently approve its own PR. PR
#392 stays draft and issue #87 stays open until the required gates and verified
merge establish completion. Repository policies and account permissions were
not changed.
