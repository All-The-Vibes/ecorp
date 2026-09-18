# Factory claim authority

This is the #161 implementation contract. It does not establish multi-host acceptance.
Use one authenticated control plane, one Corp, and the same canonical GitHub Project
owner/number/item namespace for contributors consuming the same backlog.

## Native boundary and remaining gap

ECorp already serializes claims with PostgreSQL transaction-scoped advisory locks,
the existing composite work-item uniqueness constraint, private fencing tokens,
expected versions, and operation replay. The checked-in SQLx version is 0.8.6.
Runner enrollment, reconciliation, isolated worktrees, provider adapters and persisted
verification remain unchanged. The SDK/runtime compatibility contract still applies;
this contribution adds no agent harness, execution loop, lock service or tool approval.

The missing behavior was an inspectable, independently pinned identity for the
selected claim ledger. An authority UUID identifies that ledger; it is not a
credential, proof of authentication, operating-system isolation or distributed lock.

## Inspect and pin

Migration 0042 assigns each Corp a non-nil, unique `claim_authority_id`. A trigger
prevents runtime updates from rotating it. Ordinary restart and metadata changes
retain it. The authenticated `GET /api/corps/{corp_id}/factory/authority` response
is `no-store` and contains the Corp/authority IDs, authentication mode and whether
new claims require a pin. It provisions nothing and never returns a claim token.

Use the approved endpoint and your own actor identity:

```text
crony --server <approved-endpoint> factory-authority <corp-id> <actor-id>
crony --server <approved-endpoint> factory-authority <corp-id> <actor-id> --claim-authority-id <approved-authority-id>
```

Confirm the expected ID through the team's independently approved configuration.
Do not automatically trust each newly contacted server by copying its returned ID
into the next command. The second command is a read-only comparison and fails on a
different ledger even when the Corp IDs are equal.

For `factory` and `factory-watch`, pass `--claim-authority-id` or supply the non-secret
`ECORP_FACTORY_CLAIM_AUTHORITY_ID` through trusted host configuration. Keep that
configuration available on every controller restart. Endpoint, Corp, Project,
repository and immutable source selection must also agree. Provider credentials
and runner workspaces remain separate for each contributor.

`factory --dry-run` includes `claim_authority`, `pin_verified` and the existing
Project/source/policy preview. It creates no claims, missions or runs. CLI authority
reads reject malformed reports, nil IDs, unexpected Corp/mode, redirects and reports
over 16 KiB. The CLI never follows control-plane HTTP redirects for subsequent
authenticated operations either.

Plan validity is not a promise of current dispatch readiness. In the recorded
unbound `fake-process` source-drift case, preflight accepted the deterministic
plan, but dispatch rejected the unmatched immutable commit after a claim and
mission had been persisted. The blocked item/mission and zero-run result are
retained; this is not mutation-free rejection before claim/materialization.
See [the measured runtime verdict](evidence/issue161/runtime-acceptance.md).

## Enforcement and compatibility

- New production claims and production controller registration require a matching
  authority pin. Pin omission, malformed values and mismatches fail before new
  claims are persisted. The server never derives a missing pin from the current
  endpoint and silently adds it to the request.
- Store preflight validates a supplied pin. New policy stores the canonical UUID;
  existing work-item operations revalidate the stored pin through the native
  work-item lookup. Existing claim leases, source/policy equality, roles, rooms,
  budgets, verifiers and idempotency rules still apply.
- A production preflight without a pin is not execution readiness: the authority
  report explicitly says a pin is required, and new claim admission rejects it.
- Legacy policies remain unbound, without adding a field or changing operation
  snapshots. They can replay/reclaim through existing rules; they cannot be rebound
  by removing, injecting or replacing a policy pin. An operator may verify the
  current endpoint with a pin while recovering legacy work, but this does not
  rewrite the historical policy or turn it into multi-host evidence.
- Development-mode unpinned execution remains available for isolated labs or
  explicitly disjoint backlogs. It is not authenticated shared-team execution.

The Factory UI displays the sanitized endpoint, authentication mode, Corp, authority
ID and selected Project namespace. It distinguishes unavailable authority, legacy
unbound policy and a mismatched pin; mismatches are also visible in the collapsed
summary. These labels are diagnostics, not an authorization decision.

## Independent ledgers and restored databases

Independent databases with newly created Corps receive different authority IDs,
even if the demo Corp IDs are equal. An approved pin from ledger A must fail at B.
Disconnected ledgers do not share claim locks, and GitHub Project status is never
an atomic execution lock.

A full database copy also copies its authority IDs and history. Equal copied IDs
do not establish a shared ledger. Running two writable restorations against the
same backlog is unsupported split-brain operation. Keep restored labs isolated
from shared intake; do not rotate IDs or re-key historical items to bypass this
boundary. Production restore/failover requires separate operator coordination.

The current organization Project #5 and historical personal Project #3 are different
claim namespaces. Do not migrate old claims, missions, recoveries or publications
to reconcile documentation references.

## Recorded local acceptance and remaining gates

Start with the September 13, 2026
[runtime verdict](evidence/issue161/runtime-acceptance.md) and
[machine-readable result](evidence/issue161/runtime-result.json). The earlier
[QA handoff](evidence/issue161/qa-handoff.md) remains a historical pre-runtime
checkpoint, not the latest list of unexecuted checks.

The approved one-host Windows fixture passed six actual-migration store tests
and three actual-handler database tests. Two native controllers competing on the
shared ledger produced one winner, one HTTP 409 and exactly one item/mission/task/run.
An independent ledger with the same Corp ID rejected the other ledger's pin
without state changes. A separately identified successful API-restart case
preserved the mission/run and both runner processes. Both native runners produced
verified work across the bounded cases; browser-created work passed its 2/2 checks,
and five provider artifacts plus five source bundles were independently downloaded
and matched their recorded lengths and hashes. These are recorded prior results,
not a new run or production acceptance.

The deterministic source-drift case retained one blocked item/mission and zero
runs, with prior projections unchanged and no wrong-source workspace or write.
Its preflight/readiness distinction needs an explicit follow-up verdict; the
authority implementation does not change that existing planner behavior.

The recorded QA uses the pinned PR #237 helper plus the narrowly retained
native-timestamp precision patch. Seven helper lifecycle tests passed, including
native Windows restart and stop. Integration/review of that patch remains separate;
do not replace or copy the broader shared supervisor contribution.

Full #161 acceptance still requires actual physical multi-host execution with
independent human/runner/provider identities and the supported production-auth
topology. Real-provider/GitHub effects and hosted CI are not established by this
local deterministic fixture. Coordinate with #248/#249 without taking over their
deployment or three-device scopes. Retained QA databases, worktrees, credentials,
receipts and failed attempts must be preserved; do not implicitly restart them.
No issue closure, publication, merge, deployment or retained-office mutation is
authorized by this document.
