---
title: Verified research handoffs
description: Exact specialist artifact delivery to isolated dependent task workspaces
---

## Research contracts

New source-selected `parallel-specialists` plans declare two outputs per specialist:
`handoffs/specialist-a.md` and `handoffs/specialist-a-probe.json`, with equivalent
paths for specialist B. A constrained mission selects its handoff directory from
an authorized directory write scope. If no such directory is authorized, planning
rejects the request instead of broadening its scope.

Each file must be nonempty UTF-8 and at most 6,144 bytes. The probe report must be
valid JSON and distinguish observations from proposed checks. Persisted file,
artifact and command checks gate parent completion. The roots export typed
artifact sets without creating commits. The final deliverable and any outcome
review remain the synthesis task's responsibility.

Legacy plans without a selected source retain their existing receipt-based
behavior. Previously persisted contracts are not rewritten. Existing typed studio
handoffs also use the file-materialization path.

## Delivery and authority

The store selects the latest completed, verified parent and its declared source
deliverable. A missing source artifact cannot fall back to a provider summary.
The server verifies artifact signatures, retention and bytes, then decodes the
existing typed source envelope against the immutable source tuple, verifier digest
and exact declared paths. Existing governed receipt-recovery lineage remains
separate from typed source selection.

Typed file data travels in the existing authenticated start/resume command.
The runner must advertise `verified-dependency-files-v1`. Planning and scheduling
exclude incompatible runners for typed handoffs; the current-epoch send gate
checks the capability again, including resumed and durable recovery commands.
Legacy commands omit the optional file list.

Durable replay validates the original dependency receipt without writing another
event, including after a run starts. A changed digest or artifact identity fails.
An incompatible recovery remains pending until a capable runner reconnects;
commands for other runs can still advance beyond a full blocked command page.

After isolated worktree preparation and any recovery fingerprint check, the runner
materializes files at their declared paths in the child's own worktree. It does
not read a parent directory, interpret prompt text as file-transfer instructions,
or start an additional execution loop. The child reads untrusted reference data,
not new permissions.

Materialization checks the complete file set before writing:

* At most eight files across all parents
* At most 12 KiB per decoded file and 64 KiB aggregate, with framing accounted for
* Safe literal paths, no hidden/secret/device names or case/path aliases
* Exact content digests and the child's persisted write scope
* Capability-relative filesystem access without symlinks, reparse points or hard links
* No replacement of existing different bytes; exact existing regular files support replay

The server also bounds the task prompt plus dependency context to 64 KiB. Oversize
or unsupported content fails explicitly; there is no partial or truncated handoff.
Files are not removed on failure. Materialization failure prevents provider startup
and preserves the workspace for inspection.

Imported files are visible source files, not an untracked shared cache. They remain
subject to ordinary workspace preservation and final deliverable path selection.
An explicit final output path list can exclude research inputs from the final export.
The exact bytes delivered are those in the signed typed source export, including
the exporter's existing Git source normalization, not a reread of the parent tree.

## Acceptance and reproducibility

The [draft validation record](evidence/issue297-research-handoff.md) separates
executed checks from outstanding acceptance. This candidate is not yet a verified
issue completion.

`tools/e2e_research_handoff.mjs` requires an explicitly owned loopback test stack
and a fresh evidence directory. It never resets an existing application database.
The native deterministic process creates unique research outputs; synthesis
performs filesystem reads and reports observed hashes in its signed receipt.
The driver compares those readbacks with authorized parent source downloads,
task contracts, verifier results, source identity, ordering and distinct worktrees.

Rust tests cover planner scope and legacy behavior, decoder rejection, typed
store selection, capability fencing and native filesystem materialization.
Fixture-provider self-tests are not full-stack acceptance. SQLx fixture metadata
tests are not evidence of signed physical bytes. A native deterministic run does
not establish vendor inference, browser acceptance, production identity or Factory
publication.

The contribution follows the user-approved local Copilot workflow rather than
issue #297's prescribed Codex Factory execution route. Implementation, validation,
independent review, publication and integration must be reported separately.
