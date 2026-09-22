---
name: ecorp-operations
description: Inspect ECorp mission, run, runner, approval and verification state through its native MCP gateway, or diagnose a blocked operation using authoritative evidence. Use for ECorp operational questions, not ordinary code review or unrelated repository edits.
---

# Inspect ECorp operations

Use the configured `ecorp` MCP server and its `crony_snapshot` tool. For a selected Factory work
item, use `crony_factory_recovery_context` with its exact `work_item_id` UUID. The repository configuration
starts the native gateway with `--read-only`: it exposes these inspection tools and rejects write
tools before making a server request. If the installed gateway lacks this mode, build the current
gateway; do not silently remove the flag.

The operator must select the server, Corp and actor through trusted host configuration. Do not
substitute demo identities, another Corp, a localhost default or another signed-in account when
the requested identity is unavailable. The server remains responsible for membership and role
authorization. A native tool permission is not tenant authorization.

For setup and the non-mutating stdio probe, read
[the MCP operations guide](../../../docs/MCP_OPERATIONS.md). The probe emits connection metadata
and counts; the snapshot itself can contain private operational content and should stay within
the requesting user's authorized context. Do not copy full snapshots into public issues or logs.

## Trace an outcome

Find the exact mission/run requested by the user and correlate its task status, runner presence,
verification result, outstanding approval and budget state. Prefer persisted IDs and source or
artifact digests over display names. A missing object may be outside the actor's scope; it is not
proof that no such object exists.

Distinguish these states in the answer:

- planned or held work versus launched work;
- a provider's completion claim versus accepted verifier completion;
- a retained checkpoint versus a verified deliverable;
- a published review PR versus an integrated or deployed result.

When source or artifact evidence is needed, use the existing authorized download/verification
path documented in [Architecture](../../../docs/ARCHITECTURE.md). Do not infer successful tests
from an artifact name or substitute a historical receipt for the current run's verifier policy.
For a run-specific observation, follow [operation observations](../../../docs/OPERATION_OBSERVATIONS.md).
Recheck a received observation against fresh native state before using its outcome. An input-file
hash is not a signature, and an accepted run with incomplete check history is not full check evidence.

## When the user requests a change

Read the relevant contract and current routing in
[the contributor guide](../../../CONTRIBUTING.md) and
[the Factory guide](../../../docs/DARK_FACTORY_CONTRIBUTOR_GUIDE.md). Reuse the native mission,
recovery, budget-revision or publication operation appropriate to the persisted state. The
read-only MCP connection does not grant those effects. Do not turn a room message into a task,
auto-submit a human review decision, reopen a terminal budget stop, or execute in a configured
source checkout.

Report the observed state, its supporting IDs, the specific unresolved condition and the next
supported operation. Keep unavailable hosted, production, provider and end-to-end evidence
explicit. Never present an inspection or a configuration file as proof that an operating loop ran.

## Inspect recovery eligibility

Prefer the selected item's native recovery context over inferring eligibility from a broad
snapshot. Correlate its work-item version, source run, remaining attempts and budget, retained
recovery records and checkpoint capabilities. Missing flags remain unknown. A permission error
or hidden item does not authorize another identity, broader scope or a fallback write operation.
The server's existing `Operate` permission and human-role/room checks still apply to this GET.

Do not send recovery modes, actor IDs or authority claims as tool arguments. The inspection does
not create a checkpoint, resume a provider, clear a breaker, reset spending or approve a recovery.
Revalidate current native authority through the existing action path before any separately
requested change. Keep private context fields within the requesting user's authorized scope;
use the probe's metadata report when full policy/source/failure data is unnecessary.
