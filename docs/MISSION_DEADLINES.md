# Mission deadlines and declared stage reserves

Issue #298 adds one optional, immutable absolute deadline to a mission. A mission
without an explicit deadline keeps its existing untimed contract. There is no
default duration, token reset, provider retry, or inferred optimum stage split.

## Scope amendment and authority

The October 2, 2026 completion pass builds on PR #392 at
`ddc24c427c90773ee6a3c5d46d4a5a1becc9cf01`, based on main
`878a1774774b0630c904cbaf4b05e1b346777817`. It reuses that contribution's native
stop, retained workspace and committed completion receipt behavior. The user's
expanded issue-completion authorization covers the implementation below; this
document is the implementing agent's scope review, not an independent review or
a human Factory decision.

The original issue's file list needs these bounded additions: a new unapplied
database migration for immutable mission policy and audit capture; optional
creation/preview and runner wire fields; transactional dispatch/recovery and
contract-revision admission; authoritative browser readback; and regression and
owned-stack acceptance fixtures. Applied SQL, historical R4 attempts, budget
authority, and terminal recovery lineages are not rewritten. Independent
deadline/cancellation review remains a separate acceptance requirement.

## Declared contract

Creation and preview accept `deadline`, containing `deadline_at` (an absolute UTC
timestamp) and an optional `reserve` with `seconds` and `task_keys`. The requester
selects the implementation/finalization task keys from the preview. A reserve
must be positive, name existing tasks without duplicates, include every
descendant of a reserved task, and leave at least one earlier task. Every
protected task must depend, directly or transitively, on every unprotected task.
This forms a final suffix: a protected specialist cannot start alongside an
unprotected sibling. Parallel final tasks are allowed after all earlier work.
The planner does not invent a percentage or choose protected work for the requester.

Every task contract contains the same mission `deadline_at`. Tasks outside the
declared reserve must finish, including verification, by the mission deadline
minus the reserve. Reserved tasks use the original deadline. A prerequisite
that exceeds its allowance is cancelled and cannot satisfy a dependency. The
mission fails its declared time contract rather than inventing a handoff or
extending the deadline. Queueing, waiting for parents, suspension, restart,
resume, approval and verifier delay consume this same allowance.

The persisted mission policy is immutable. Contract and budget revisions cannot
erase or extend it. Deadline expiration is an automated policy event, never an
operator decision or independent acceptance.

## Enforcement boundaries

The store samples PostgreSQL `clock_timestamp()` after authority/row lock waits
for creation, dispatch and accepted progress/completion. Native enqueue receives
the current absolute task cutoff and remaining milliseconds from that same
transaction. An expired assignment cannot launch or accept late completion.
The existing lifecycle sweep reconciles expiration, including queued work and
disconnected runners, through existing durable stop commands. Its bounded pages
select only unfinished tasks whose derived cutoff is due. Migration58 backfills
and indexes that scheduling value; a trigger always derives it from immutable
mission policy. It does not replace the post-lock clock check or change applied
SQL. Completed, failed and cancelled missions retain their terminal cause.

Deadline assignments require the runner's explicit `mission-deadline-v1`
capability. The runner takes the smaller of the server's remaining allowance and
its local absolute-clock allowance, then uses a monotonic timer through native
execution and verification. It requests the existing hard stop boundary before
sending native stop. Worktree cleanup still requires the exact committed
completion receipt. A wall-clock difference can shorten or delay the physical
stop; authoritative acceptance uses database time and does not rely on clock
agreement. This is not a distributed real-time execution guarantee.

Cancellation records the first native hard-boundary cause. The store binds that
acknowledgement to the first scoped durable stop or suspension, preserving its
original bounded reason. A later acknowledgement cannot turn an earlier
operator stop into deadline expiry. A runner timer that fires ahead of database
time records `mission_deadline_elapsed`: the run and task are cancelled, but the
mission remains available to the database expiry sweep. Only a database-admitted
deadline stop records `mission_deadline_expired` as the cancellation cause.
The sweep can independently fail the mission after an earlier operator stop;
the run still retains the operator cause. Supplied timestamps or claimed
authority cannot override this provenance. Neither case grants a retry or
resets budgets, verifier verdicts or retained source identity.

Codex 0.154.0 was observed locally and its generated native schemas were read.
`turn/start` has no absolute mission deadline field; `turn/interrupt` targets the
native thread and turn. This implementation adds only ECorp's missing shared
deadline policy and calls the existing adapter stop path. No second provider
execution loop is introduced. The repository does not enforce that Codex
version as a pin, and this observation does not qualify another installed
version.

## Browser workflow

In a new mission, open **Model, limits and output** and optionally enter a
deadline in the displayed local timezone. Leave the fields blank for untimed
work. A reserve needs a whole number of seconds and exact protected task keys,
one per line. Use the allocation preview to find keys, return to setup to add
the reserve, then review again. For `parallel-specialists`, protecting
`synthesis` reserves the final stage and shortens the two specialist allowances.

**Review and build** obtains the server's current allocation and deadline echo.
A timed mission cannot be submitted while that echo is missing or obsolete.
**Save without starting** still consumes the declared time; starting later does
not restart its allowance. The saved mission and each task show the original
cutoff and any earlier task cutoff. Those readbacks come from persisted state.

## Owned acceptance driver

`tools/e2e_mission_deadline.mjs` is an opt-in driver, outside automatic test
discovery. It requires `ECORP_MISSION_DEADLINE_TEST=1` and an absolute
`ECORP_MISSION_DEADLINE_SETUP` JSON receipt. Importing it is inert; the companion
`*.test.mjs` executes only safe configuration and evidence negative controls.

Create a fresh owned stack through `tools/local_stack.psm1` using matching-source
server/runner binaries, an independent synthetic Git source, a new database and
`scripts/fake-codex-app-server.mjs`. The setup receipt supplies `test_owned`,
`provider_fixture: "deadline-complete-after-stop"`, absolute `repository`,
`qa_root` and `source` paths, `source_repository`, `source_commit`,
`source_binding.source_fingerprint`, `server_url`, `web_url`, `runner_id`,
`demo.corp_id`, `demo.alice_actor_id` and the exact `processes.server` and
`processes.web` identities (`pid`, `executable`, `started_utc`). This driver
uses the existing planned-attempts supervisor convention: a fresh
`qa/issue224-planned-attempts-...issue298...` root, the
`ecorp-fixture/planned-attempts-fixture` source and `issue224-planned-qa` runner.
Point `CRONY_PLAYWRIGHT_MODULE` at the installed Playwright module if necessary.

The driver resolves the actual module checkout, QA root and source to canonical
nonlink identities, verifies their separation in both directions, and requires
a new evidence destination. False repository receipts, aliases and existing
linked output destinations are rejected before mutations. It independently
verifies live server/web identity and listener ownership, then creates only two
new missions through an actual Edge browser.
A saved solo plan expires in the queue. A parallel plan waits before launch,
then expires at its specialist cutoff before the reserved synthesis stage.
The explicit `[deadline-complete-after-stop]` transport reports native success
after interruption, exercising rejection of that late result. Acceptance
requires cancelled durable runs, retained dirty workspaces, separate native
termination receipts and no synthesis launch. A local runner timer can win
before the lifecycle sweep requests a durable Stop; absence of that duplicate
command is not a fabricated dispatch receipt.

Reports, snapshots and 1440/390-pixel screenshots stay under the fresh root's
`evidence/mission-deadline`. Failures retain their evidence and stop only new
fixture runs whose current agent lease still matches. The owning supervisor
must stop its exact recorded processes in a `finally` block and retain the
database and worktrees. The driver never resets or adopts an existing stack.

## Required evidence

Pure fake-clock cases cover queue/parent delay, exhausted admission and explicit
reserves. Owned PostgreSQL cases cover lock-wait expiry, immutability, tenant
scope, late completion, stopped parents and recovery. Runner cases cover the
monotonic timer, prelaunch expiration, verification cancellation and retained
source. Complete local-stack/browser evidence must agree with durable task/run
state. Source hashes, failed attempts, exact command results, skips and ignored
cases remain distinct. No historical R4 reproduction, independent acceptance,
real-provider qualification or required hosted success is claimed by unit tests.
