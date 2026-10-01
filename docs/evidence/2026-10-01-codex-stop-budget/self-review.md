# Implementation self-review for issue 87

This is the implementing Codex agent's review on October 1, 2026, against main
`878a1774774b0630c904cbaf4b05e1b346777817`. It is not an independent review, a
human decision, a GitHub approval, or evidence about the original September 3
incident. The source manifest and Git tree binding identify the reviewed bytes.
The final canonical and focused receipts determine validation status; this
review does not substitute for them or for required hosted checks.

The review covered the product/architecture/security/evaluation guides at the
base, the changed protocol/adapter/runner/server/store paths and their callers,
dedicated deterministic and database tests, and the full-stack fixture drivers.
`docs/PROJECT_MEMORY.md` does not exist at this main revision. The configured
source checkout has an untracked local copy; it was preserved and was not
silently treated as an upstream contract.

## Native adapter and process ownership

`crates/crony-runner/src/adapter/codex_runtime.rs:33` keeps a bounded outbox with
a cursor outside the cancelled write future. A stop clears pending directions;
a partially written frame closes the transport. This avoids continuing a
work-starting request merely to make its write complete. Startup responses must
correspond to requests that were actually written, and only the correlated
`turn/start` response establishes the active turn. Early notifications retain
their receipt times in a bounded buffer. Foreign/duplicate startup or turn
notifications cannot establish a different active operation.

At `codex_runtime.rs:157`, control receipt fixes the two-second interrupt
deadline. Suspend-to-stop escalation strengthens the outcome without changing
that time. The protocol calls native `turn/interrupt`; its reply records request
acknowledgment, never process death. At `codex_runtime.rs:302`, every protocol
result, error, EOF, and timeout enters the existing owned-process teardown.
Cleanup futures remain pinned while controls are received. Unverified teardown
retains supervision and marks uncertainty rather than claiming completion.
The Windows implementation reuses the repository's Job Object primitive;
Unix explicitly records root-only termination, without descendant assurance.

The selected native harness was the installed Codex 0.154.0, identified by its
executable hash in the acceptance receipt. The inspected native schema and
existing official reference support `turn/interrupt`, `thread/resume`, native
sandbox policy and structured usage notifications. No repository-enforced Codex
pin or native termination-latency guarantee was established. The ECorp additions
are transport cancellation, owned cleanup and authoritative accounting around
those native operations; they do not add a custom execution or permission
engine. The empty retained message-processor download is not source evidence.

## Usage and durable control authority

`crates/crony-runner/src/adapter/codex.rs:409` restricts reports to the active
thread/turn. Its usage parser accepts advancing cumulative totals and charges
the native `last` delta once; duplicate or regressing totals do not charge
again. `codex_runtime.rs:360` records raw cumulative/latest counters, whether
the total advanced, receipt time and whether adapter control had already been
observed. Buffered arrival does not establish token generation after stop.

`crates/crony-store/src/control_accounting.rs:75` applies the five-second grace
inside the existing Corp and exact-run locks. `clock_timestamp()` is sampled
after the locks, and the first suspend/stop incident sets the cutoff. Terminal
runs and hard states lacking a boundary cannot open a new charging window.
Late reports retain their event identity as noncharging `run.usage_observed`
events. The existing append-event result controls projection updates, preserving
idempotency when an event is replayed on either side of the cutoff. This is an
ECorp ledger rule, not a claim about provider billing.

Emergency stop now persists a monotonic hard incident and an idempotent runner
command before dispatch. Repeated requests reuse both, including when the
runner is offline. The transition time is sampled after the run lock; the
legacy stop-event fallback is limited to records without a durable command.
The server no longer turns an offline dispatch into loss of the stop intent.

`crates/crony-store/src/control_receipts.rs:21` locks the exact Corp/runner/live
connection epoch against reconnect or revocation before accepting a receipt.
Command joins retain Corp scope. Runner timestamps remain optional diagnostic
values; malformed/absent clocks are explicit. Detail length is bounded and the
server no longer logs the supplied detail verbatim. Wire compatibility is
covered for old acknowledgments omitting the added field.

The server's socket observer has capacity 64 and a five-second persistence
timeout; slow storage does not delay the control writer. An exhausted observer
logs a missing observation rather than inventing successful evidence. A send
observation retains the epoch captured at the actual send even if a later
reconnect happens before persistence. Runner events cannot impersonate
server-owned stop/accounting/send/acknowledgment records. The tests cover
foreign Corp, foreign runner, stale epoch, reconnect races and scope spoofing.

## Hard-stop completion fence and compatibility

`crates/crony-runner/src/main.rs:285` routes ordinary StopRun through the same
latched hard boundary as suspend/stop breakers. The existing finalization path
then blocks verifier execution, artifact uploads and accepted completion, even
if the provider already produced a local transcript or races with completion.
The store additionally rejects effect-advancing events after a historical stop
request. Local evidence and source worktrees remain retained when required;
retention is not an accepted artifact upload.

The start/steer/two-resume acceptance lane confirms the normal lifecycle remains
available. Its ordinary interrupt retains the existing transcript behavior;
emergency and budget hard stops preserve workspaces with no accepted artifacts
or completion. No migrations, applied SQL, dependencies or source-checkout
configuration are changed. The change uses the existing run/task/verifier
state machines and does not introduce a task graph or irreversible effect.

Unmerged PRs #380, #381 and #390/#391 touch nearby accounting, finalization or
acknowledgment logic. They are not part of this tested main-based source. Their
contributions remain preserved and require integration review and validation
before any subsequent merge. The existing Windows serial-testing work also
remains separate.

## Findings resolved and remaining limits

The retained failed regressions caught an adapter error-conversion compile
failure, EOF/live-child and steering defects, early/foreign turn correlation,
and a stop timestamp taken before a database lock wait. The final source fixes
these with scoped changes; final refreshed lanes supersede preliminary passes.
Fixture staffing races and the first provider lane's missing usage baseline
were test-orchestration failures. The latter did not prove a production
accounting defect or a failed termination. Failed receipts remain available.

Canonical R2 additionally exposed a test-fixture framing defect in
`crates/crony-runner/src/adapter/codex_stop_tests.rs`. The EOF fixture executes
the native test binary as a protocol child. With serial libtest execution,
the default formatter placed its test-name prefix on the first JSON response,
preventing adapter initialization. A direct comparison of default and terse
formatting with the same binary and input reproduced that difference. The test
now passes `--format=terse` and explicitly gives its child
`RUST_TEST_THREADS=1`, so focused runs also exercise the canonical environment.
The isolated regression passed in 0.58 seconds. This is a test-only correction
under `#[cfg(test)]`; it changes no production behavior or dependency. Final
canonical R4 and refreshed acceptance receipts, rather than the earlier passes,
determine readiness for the corrected complete source.

Canonical R3 subsequently failed the preexisting F02 native hostile-filter test
because a scratch directory remained. It reported 3,037 Node tests passed, one
failed and 65 skipped; later validation gates did not run. The original test
removed the fixture and did not preserve its CLI diagnostics. Three exact
repetitions passed on unchanged source, with native Git probes of 294–324 ms,
8,385,109 stderr bytes, correct filter rejection in 869–963 ms, and empty scratch
roots. The 1,000 ms whole-check budget may be timing-sensitive, but the original
cause is unconfirmed. No production/test source, assertion, timeout or cleanup
safeguard was changed for these observations. Canonical R4 retains native
deliverable-diff fixtures for diagnosis. A subsequent pass does not establish a
root cause or a fix for the R3 failure; the failed receipt remains material
validation history.

No unresolved concrete defect was found in this implementation self-review.
Acceptance is limited to its recorded Windows fixture and one bounded native
provider operation. It does not reproduce the September incident, establish
production latency guarantees, verify Unix descendant cleanup, or measure the
provider's internal generation/billing time. Socket-observation loss remains
explicit under backpressure. Historical Cargo advisory debt is not a clean
security audit. Required hosted CI, CodeQL, code-quality/security and review
gates remain unavailable while GitHub Actions is disabled. Publish as a draft;
do not merge, close issue 87, or alter those gates on the strength of local
validation alone.
