# Protocol capability review correction — October 1, 2026

Comment 4160606480 on adfc09642a6d40f29b168dded6f3b086005a5b77 identified a real labeling defect:
unscoped runner protocol capabilities were displayed as Base installation.
The existing mission runtime classification is now exported as isMissionRuntime.
Runner readiness uses that helper for provider installation labels and displays
Runner feature for unscoped protocol capabilities. A saved connection ID still
takes precedence. Every record, readiness status, model count and stable key
remains present. Execution, authorization, source selection, harness permissions
and native protocols are unchanged.

The implementing agent reviewed App.tsx, missionRuntime.ts, the actual-TS/JSX
regression and runner registration in crates/crony-runner/src/main.rs. This is
self-review, not independent approval. The helper preserves the existing
availableRunnerAdapters predicate; no new capability list or custom harness
mechanism was introduced.

The new prospective regression failed before the fix: five tests, four passed,
one failed because durable-control-v1 had the wrong scope label. The first green
run passed 19/19. The test fixture name was then corrected to the actual
verified-dependency-files-v1 capability; the final focused run also passed 19/19.
The original red and both green receipts remain, with their distinct source
hashes. These are new regression observations, not revised historical chronology.

Full canonical pnpm check passed all 11 named gates on 7,240 unchanged physical
inputs: 7,147 product inputs and 93 prior evidence files. Node: 3108
total, 3043 passed, 0 failed, 65 skipped,
0 cancelled, 0 todo. Rust workspace:
877 passed, 0 failed, 564 ignored across
41 summaries. Native EVM is recorded separately. Skipped and
ignored cases are not passes. The full JavaScript discovery lane was used.

The complete local browser/server/runner/private-PostgreSQL stack passed
60 assertions. Eight checkpoints compare all nine real protocol capabilities
from the server to browser labels and readiness. The earlier default synthetic
source, saved local source, sign-out/retest, selection, reload, narrow layout
and stable-key checks remain. Native account/catalog results are an explicit
fixture: this does not prove actual provider inference or the whole application
journey. All owned processes stopped without cleanup errors.

Both screenshots were visually inspected and copied byte-for-byte. Full saved
connection IDs wrap at 390px. The narrow screenshot retains a focused skip-link
overlay that obscures a row; it is a limitation of that capture, not evidence
that the obscured row was visually assessed.

The tested product tree is d62abf4e59887f84f3848ccf5c839fe487e51c30. Canonical and browser runs used
parent adfc09642a6d40f29b168dded6f3b086005a5b77 with these product changes in the working tree.
The physical manifest binds those exact bytes; publication adds only evidence.
Final documentation, whitespace, changed-blob and introduced-history checks
bind the final publication tree/head separately in the PR evidence comment.

The earlier source-claim and omitted-receipt corrections remain in
review-correction.md and publication-r3/. Additional passing receipts for
parent adfc096 are in protocol-correction-r1/parent-publication/. Their source
scope is explicit; none claims to validate a later child commit.

The first protocol publication preflight rejected one extra blank line at EOF
in the copied locked-install log. Only that unpublished copy was trimmed,
and its provenance hash was updated. The original log and failed R1
preflight receipts are preserved in the run records; product inputs and
validation/security policy were unchanged. R2 validates the corrected
publication tree separately.

Historical failed canonical/preflight/publication attempts remain. The original
F02 preparatory read-tree timeout cause is still unestablished; passing repeats
do not prove a repair. The original 8,385,017-byte native diagnostic stderr was
not retained in full, only its length/hash/prefix/tail observations. Historical
Cargo advisory debt is not a clean audit.

This remains partial issue #198 work. Full Connect/Test state coverage,
application/verifier/source/download/review acceptance, authority/idempotency/
retention, keyboard and error recovery, and parent Factory requirements remain.
Required hosted checks are unavailable while Actions is disabled. No independent
approval, merge, policy exception or issue closure is claimed.
