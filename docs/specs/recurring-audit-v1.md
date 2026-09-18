# Local recurring audit and feedback contract, version 1

Repo Steward's local maintenance commands reuse its existing snapshot validator
and auditor. They add repeatable invocation, durable finding deduplication and
reviewed advisory guidance. ECorp's runner, task graph, durable approvals,
verification, Factory claims and publisher retain execution authority.

## Persistent audit state

Each state directory binds its repository source commit, input origin, policy
and implementation hashes. Source or implementation drift refuses reuse; an
operator must preserve the old directory and choose a new scope explicitly.
An audit admits only a complete bounded snapshot within the existing freshness
window. A supplied snapshot retains that provenance. The existing live collector
retains its pinned account, repository and Project checks.

Private content-addressed artifacts contain the original report, non-executable
handoff, cycle receipt and checkpoint. New, changed and resolved findings have
explicit identities. Capture timestamps and transport counters alone do not
create a new handoff; each no-op still records its fresh input observation and
consumes one of the directory's 100 admitted attempts. Each record retains zero
remote mutations and no execution authority.

One exclusive writer lock protects a state directory. Reads check digests and
implementation identity. Redirected directories, changed artifacts, unknown files,
concurrent access and ambiguous interrupted writes fail closed. Failed audit
attempts remain recorded. The process never removes a stale lock automatically
or retries an ambiguous checkpoint. Preserve that directory for inspection and
use a new one after resolving the cause.

Pause and resume are durable versioned controls; stop is terminal. They control
only this audit intake. They do not interrupt, approve or launch a native mission.
The CLI checks controls before collection and the coordinator checks them again
under its writer lock.

`watch` admits at most 100 cycles with explicit interval and duration bounds. It
uses Node's native timer within the foreground process; no scheduler, background
service, remote workflow or account configuration is installed. The duration
limit stops new cycles after the deadline. An in-flight read retains the existing
collector's native request/time bounds. Interrupting the wait stops further
admission and preserves completed receipts.

## Advisory feedback

Corpus records have candidate, active and retired states. A retired record's
disposition distinguishes rejection, operator retirement and supersession. The
corpus is limited to eight active rules, 64 total records, bounded evidence/text
and a 30-day maximum rule lifetime. It binds the repository and Project scope.

Evidence is derived through the existing auditor and binds the exact source,
snapshot, finding ID, finding revision and content digests. Timestamp-only replay
does not create a distinct evidence identity. Activation requires at least two
distinct identities, an unexpired candidate, its exact digest and a recorded
local review decision. The CLI hashes the supplied review file itself.

These files are trusted local operator data. A digest checks consistency; it does
not authenticate a reviewer or prove independence, human approval, GitHub access
or native ECorp authorization. Those facts require their own evidence. The
corpus explicitly retains that limitation and has no execution effect.

Active guidance adds one of three advisory routes (`inspect-evidence`,
`clarify-requirements`, `manual-review`) and bounded text to matching finding
rules. Admission limits the result to 512 annotations and one MiB of serialized
advisory output before expanding matches; excess fails without truncation.
It preserves original findings, severity and proposals. It cannot add
executable code, suppress findings, grant permissions or assert completion.
Expiry, rejection, retirement and supersession prevent later application.
Audit handoffs record the exact corpus and active-rule digests, so changing the
corpus or reaching an expiry produces a newly inspectable observation.

The feedback CLI writes a new file for every transition, refuses overwrite and
never replaces its inputs. Historical versions remain available for review.
The local file boundary is not a multi-user authenticated organizational memory
store.

## Acceptance

The dependency-free core suite runs through `pnpm test:steward` and the repository
checks workflow. It covers restart/no-op, changed and resolved findings, stale or
partial snapshots, exact source bindings, pause/stop, concurrent writers,
tampering, finite bounds, review conflicts, evidence replay, rejected rules,
expiry and supersession. CLI acceptance must separately execute the real entry
points and inspect their persisted artifacts.

Synthetic input proves these local contracts. It does not establish recurring
GitHub collection, a human-authenticated review, agent-produced delivery,
unattended Factory operation or a new benchmark score. Native execution work in
issues #280, #95 and #269 retains its separate contracts and acceptance gates.
