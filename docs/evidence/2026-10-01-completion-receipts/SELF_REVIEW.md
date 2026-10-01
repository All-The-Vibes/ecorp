# Completion receipt implementation self-review

This is the implementing agent's October 1, 2026 review of the follow-up to PR
#392, based on main `878a1774774b0630c904cbaf4b05e1b346777817` and published parent
`9c981ac020f5ba39b652fcaf531c80b5f3cd8a4d`. The adjacent source manifest and Git
tree binding identify the reviewed bytes. This record is not independent
approval, a human decision, or evidence about the original September 3 incident.
The executable validation receipts, rather than this narrative, establish which
checks ran and passed.

The current-main contributor, product, architecture, security and evaluation
guides were read. `docs/PROJECT_MEMORY.md` is absent from that main revision;
the configured checkout's untracked copy and other local work were preserved.
The prior packet's review is historical. Its claim that the local finalization
fence resolved completion ordering was incomplete and is superseded here.

## Substantive feedback and reproduced defect

Copilot review `5381674279` identified that local FINALIZING could reject a
server-committed hard stop before the queued completion had been accepted.
The runner could then remove a clean worktree while authoritative run state
remained active. The finding appears in the review body; there is no inline
thread whose absence would establish resolution.

The retrospective `issue87-finalization-before-r1` regression failed on the
published implementation: zero passed, one failed, zero ignored, 304 filtered,
native exit 101. The expected applied stop acknowledgment was `(true, false)`;
the observed result was `(false, false)`. This reproduces the code ordering
defect, not the original provider incident. The corrected regression requires
the stop to remain applicable until committed completion is acknowledged.

## Committed authority before cleanup

`crates/crony-protocol/src/lib.rs:104` defines a receipt bound to Corp, live
connection epoch, run, assignment token and exact completion event. The server
at `crates/crony-server/src/main.rs:7084` emits it only after
`apply_runner_event` returns a newly committed `run.completed` event. A queued,
rejected or duplicate event grants no cleanup authority. The existing store
transaction and Corp lock serialize completion with emergency stop; the
persisted verifier policy remains required. No new approval or task state
machine replaces those contracts.

The runner registers the expected event before enqueuing it. Receipt validation
at `crates/crony-runner/src/main.rs:293` rejects unsolicited receipts and foreign
Corp, connection, run, assignment or event scope. The bounded wait at
`main.rs:3219` gives cancellation priority and atomically enters finalization
only after the matching receipt. Existing Git cleanup safeguards then still
preserve dirty, committed or unverifiable worktrees. The source checkout is
never used for write-capable execution.

All other outcomes retain source: a hard directive, failed verification,
pending manual approval, provider recovery or uncertain delivery. The
30-second timeout emits `CompletionUnconfirmed`; the store's typed failure
handling forbids automatic execution in a fresh workspace. When completion
already committed and only its receipt was lost, a late failure cannot undo
completed state. Verifier-only recovery distinguishes completed verification
from completion acceptance, so a missing receipt does not rerun fallible
snapshot cleanup after the success event batch. There is no replay-derived
permission to remove a retained source.

The new server sends this message only when the completion payload contains
`completion_receipt_requested: true` (`crony-server/src/main.rs:7028`). That
keeps an older runner from receiving an unfamiliar message. The legacy
acceptance lane strips this request flag from real traffic; it is not an
old-binary compatibility test. A new runner against an old server retains its
workspace on timeout, but the old server may also reject the new failure kind.
Mixed-version authoritative convergence has not been established.

## Active controls throughout verification

The first two acceptance attempts exposed fixture ordering and line-ending
errors. The third exposed a separate product defect: artifact finalization
cleared `agents.current_run_id` before verification ended, hiding Emergency
stop. `crates/crony-store/src/lib.rs:7827` now keeps that reference while moving
the agent to reviewing status. Existing terminal transitions clear it.

Native PostgreSQL regressions cover artifact finalization, idempotent artifact
replay, subsequent cancellation and accepted completion. Separate database
tests force stop-first and completion-first ordering through observed lock
contention, and exercise unconfirmed failure without a fresh-workspace retry.
The successful full-stack stop lane exercises the browser control after the
artifact is stored, then verifies authoritative cancellation, an applied
durable acknowledgment, retained source and no accepted completion or retry.
An artifact stored before the stop is not evidence of an artifact accepted
after it.

## Evidence and scope

The final focused lanes observed 25 passing runner tests, two passing protocol
tests, and 18 passing tests against a fresh native PostgreSQL fixture, with
zero failures or ignored cases in those selected suites. Filtered counts are
retained in their logs. Their 273-file manifests match the relevant subset of
the complete 7,312-file canonical and acceptance source. Unit tests use an
explicit simulated receipt helper; they do not claim server persistence.

Four full-stack completion lanes use an opt-in owned loopback WebSocket gate
that holds or withholds real messages without manufacturing receipts. Stop
before completion, accepted completion, lost receipt and omitted request flag
passed 7, 6, 7 and 7 assertions respectively. All run real web, server, runner
and database processes. Fresh suspend, stop and real-provider stop lanes
passed 14, 15 and 15 assertions; the lifecycle lane covers start/steer/two
resumes, ordinary interrupt, emergency stop and budget stop in four scenarios.
The acceptance binaries match the final native build hashes. All owned
processes and databases were stopped and their receipts retained.

The gate reuses pinned `ws` 8.21.3, has a loopback-only control endpoint and
keeps credentials and assignment capabilities in memory. Its output is
bounded event metadata and scope-match booleans. It is a test fixture, not a
product execution or permission mechanism. The product continues to use
native Codex `turn/interrupt` and the existing process ownership adapter.
ECorp's persisted verifier decision and workspace cleanup authority are
outside that harness capability. Installed Codex 0.154.0 was observed; a
repository-enforced Codex pin was not established.

Three screenshots were visually inspected. The held screenshot shows a
verifying mission with "Live control unavailable" on that surface. Emergency
stop is subsequently exercised in Control floor; the screenshot is not
described as showing that button. The settled screenshots corroborate the
cancelled and accepted states; event/database and filesystem assertions carry
the acceptance claims.

No migrations, applied SQL, lockfiles, repository security policy, test
discovery or hosted-check settings are changed. Nearby PRs remain separate
and require review against updated main before integration. The configured
source checkout, existing worktrees, prior evidence and unsuccessful attempts
are preserved. Current evidence is appended in a new packet and separately
checked against the exact publication tree.

No additional concrete defect was found in this follow-up self-review. This
is not a claim of complete independent review or unrestricted portability.
Windows acceptance and one real-provider operation do not establish service
latency guarantees, provider generation time or billing. Unix descendant
termination remains unproven with root-only assurance. The prior F02
hostile-filter failure remains unexplained; a later pass is not its fix.
Historical Cargo advisory debt remains. Required hosted CI, CodeQL, code
quality and security checks have not run while Actions is disabled. The
existing Copilot review identified the race addressed here; its successful
check status does not satisfy those missing checks. Independent approval is
not claimed. Local results do not authorize bypassing required gates. PR #392
remains draft and issue #87 remains open pending verified gates and merge.
