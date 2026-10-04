# Active factory source checkpoints

Factory intake can opt into remote draft durability before its complete verifier runs.
Without this option, the existing final-verification and publication workflow is unchanged.

Pass one or more `--checkpoint-check-index` arguments to `crony-cli factory`, alongside
the existing `--verification-policy-file`. Indices are zero-based, distinct and increasing,
and refer to the immutable full policy. Select between one and eight focused static or
test checks; their declared command timeouts must total at most 120 seconds. Artifact-only
checks cannot establish a source checkpoint. Recovery retains the selected checks at their
original indices; replacement final gates must also satisfy the existing recovery constraints.
The assigned runner must advertise `active-source-checkpoint-v1`.

The native runner prepares an isolated source candidate, runs the selected checks and
exports a signed checkpoint artifact. A failed check preserves the working source and
does not create a checkpoint commit. An unchanged nonempty source commit is reused.
Before retaining ancestry, native Git checks every commit since the authorized base,
including merged side histories. Each retained tree must obey the deliverable selection,
task write scope and excluded-path and file-mode rules. Deleted provider evidence and
reverted excluded files still block export. This check requires complete Git history and
allows at most 256 retained commits, 16 MiB of native command output and 30 seconds of
validation. Rejection preserves existing commits, the index and working source; it never
rewrites history to remove unsafe contents.
The configured source checkout is never a write target. The runner then waits at most
180 seconds for an authenticated remote draft receipt. An object-store acknowledgement
alone does not release full verification. A timeout preserves the source for recovery.

Run the trusted publisher concurrently with the factory work, using its existing enrolled
publisher credential file outside all agent workspaces:

```text
crony-cli factory-checkpoint CORP_ID ACTOR_ID FACTORY_WORK_ITEM_ID --publisher-id PUBLISHER_ID --publisher-credential-file PRIVATE_FILE --wait-seconds 900
```

This bounded watcher uses native Git and the configured GitHub CLI. It pushes without
force to the stable factory branch, creates or recovers one draft PR, and records the
remote source identity before synchronizing Project evidence. It retains the intake
Project status (normally In Progress). Its 120-second publisher lease serializes ECorp
publishers; it cannot fence collaborator changes at GitHub. Successful synchronization
and recorded failures release the lease; a crashed
publisher can be restarted after natural lease expiry to reconcile the exact partial
effect. The watcher never treats its own deadline as proof that a draft was published.

Before pushing, both checkpoint and final publication revalidate the resolved branch
and its verified commit. If a policy uses `HEAD`, switching the remote default branch
at the same commit fails that attempt before the push. A retry resolves the current
policy base and still respects any previously persisted branch identity. This native
Git check is a pre-push observation, not an atomic lock on remote branch configuration.

Read `/api/corps/CORP_ID/factory/work-items/FACTORY_WORK_ITEM_ID/active-checkpoint?actor_id=ACTOR_ID`
for the authenticated checkpoint artifact, publication phase, current gate body and
whether final publication has taken ownership. Source-bound comments distinguish focused
passes, full-policy results, manual-gate status and run state. The initial draft body stays
stable. Re-running the watcher appends current evidence, including verification failure,
without granting review, merge or deployment authority. It reads all comment pages and
reuses an exact matching comment only from its authenticated GitHub actor. Existing PR
titles, bodies and comments are never edited by the checkpoint publisher. Collaborator
changes during append remain intact and block synchronization if the observed PR no
longer matches. A lost append response can leave another matching evidence comment;
GitHub does not provide an idempotency key for that mutation. It does not create another
branch, commit or PR. Legacy receipts retain their original exact-text requirements.

After full verification and any persisted manual gate pass, reconcile the factory item
with the same factory command. The separately authorized `factory-publish` flow can
adopt and promote the same draft and commit using its existing prerequisites. Only this
final flow moves the Project into review. Auto-merge remains disabled. Starting final
publication fences further active-checkpoint mutations. Final evidence is another
append-only source-bound comment; promotion preserves the observed shared PR text.

Native GitHub ready/draft operations do not accept an expected head or content fence.
Before invoking native ready, the final publisher persists the adopted PR identity,
exact head and text, and evidence comment in the existing publication ledger. It records
a successful command acknowledgement separately, then rechecks the branch, complete PR
snapshot, comments and current authorization before atomically accepting final publication.
This closes the local acceptance race; it does not make GitHub mutations conditional.

If those checks fail, or a publisher restarts with an unresolved intent, reconciliation
runs before forward source and argument validation. A separate short-lived capability
can only restore that same open PR to draft. Changed head, base or text is preserved.
The original scoped human actor and publisher credential are still required, but revoked
forward publish permission does not prevent compensation. Compensation abandons forward
authority and cannot be replayed through start, renew or final publication checkpoints.
An accepted publication is never reverted by this recovery path. The ledger retains
every dispatch and permits at most 32 undo dispatches, one per recovery lease.

A timeout or process crash before a durable native-success acknowledgement is an unknown
remote outcome. Observing draft once, terminating the child, or waiting for the local
lease cannot prove a submitted GitHub request was cancelled. Such an intent blocks new
forward promotion even after draft is observed. A subsequent invocation rechecks and
restores any late ready effect. Only acknowledgements of all original dispatched effects
and a fresh draft observation settle that intent; otherwise it remains unresolved for
operator reconciliation. Unavailable or revoked publisher credentials likewise leave
explicit unresolved evidence. No fallback grants account permissions or bypasses gates.

The additional ECorp state is needed for Corp and actor authorization, immutable
source/gate binding, fenced restart receipts and Project synchronization. It reuses the
existing runner adapter, verifier, Git bundle export, native Git commits/refs/push and
GitHub draft lifecycle. It adds no agent tool permission system or provider session
implementation. Repository credentials belong to the trusted publisher, not the
producing agent. Environment separation alone is not operating-system isolation.

## Local deterministic acceptance

`tools/e2e_active_checkpoints.mjs` is import-inert and runs only with
`ECORP_ACTIVE_CHECKPOINT_TEST=1` and an absolute `ECORP_ACTIVE_CHECKPOINT_SETUP` receipt.
It requires a fresh owned `qa/issue72-active-checkpoints-*` directory outside the product,
an independent synthetic source, private PostgreSQL, matching-source native server,
runner and CLI, and a real Edge browser. The supervisor must bind binary hashes to the
tested physical source, verify native process ownership and stop only its owned services.
Never reset an existing database or reuse a retained fixture directory.

The driver passes command and browser children only explicit executable-lookup and
required OS variables, plus its synthetic fixture settings. Home, configuration and
temporary paths point to freshly created empty directories under the owned QA root;
SSH agent sockets, tool credentials, caller configuration and interpreter injection
variables are not inherited. Native Git uses an empty global config, disables system
config and prompting, and permits only the local fixture transport. Existing or aliased
environment directories are rejected and preserved. Windows application-data paths use
the native `USERPROFILE/AppData/Local` and `Roaming` layout so native lookup agrees with
the explicit environment. The supervisor must likewise give
the driver and native services explicit environments and owned home/configuration paths.
This boundary prevents ambient environment delivery; it does not prevent same-user
processes from reading other files or using operating-system credential services. The
Windows token still identifies its original registered profile.

The driver uses the existing deterministic `fake-process` adapter, a local bare Git
remote and fake GitHub. It exercises branch-push and draft-create crashes, natural
lease expiry, idempotent restart, pending/passed/failed gates, final draft adoption and
preservation of uncommittable work. Readiness recovery tests also cover retained shared
text, changed source, uncertain remote effects and compensation authority. A native
Git hook also switches the default branch at the same commit during bundle
import; the publisher must reject the stale resolution before pushing and safely
retry against the currently resolved branch. The hook touches only the owned local
remote and is supplied only to that fixture publisher. A fixture
owner clicks Accept evidence through the
actual browser; that is a synthetic test decision, never evidence of a human or an
independent review. A boolean-only credential probe checks the producer environment.
Reports retain actual commands, exit codes, source identity, screenshots and failures.
This lane is distinct from provider inference, hosted GitHub/CI and production acceptance.

Safe admission and fake-GitHub unit tests remain in full Node discovery. Run the
repository's locked canonical `pnpm check` separately before committing; local acceptance
does not replace required CI, CodeQL, security or review gates.
