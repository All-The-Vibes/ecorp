---
name: ecorp-operations
description: Inspect ECorp mission, run, runner, approval and verification state through its native MCP gateway, or diagnose a blocked operation using authoritative evidence. Use for ECorp operational questions, not ordinary code review or unrelated repository edits.
---

# Inspect ECorp operations

Use the configured `ecorp` MCP server and its `crony_snapshot` tool. The repository configuration
starts the native gateway with `--read-only`: it exposes snapshot inspection and rejects write
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
