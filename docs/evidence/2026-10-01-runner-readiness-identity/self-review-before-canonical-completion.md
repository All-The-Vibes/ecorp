# Issue 198 readiness identity self-review — October 1, 2026

This is the implementing agent's review, not independent approval or a human
decision. Scope is the duplicate-key and ambiguous-label finding in issue 198
comment 5710390211, not completion of the whole issue.

Base: `878a1774774b0630c904cbaf4b05e1b346777817`.
Branch: `codex/issue198-readiness-identity`.

Reviewed physical product bytes:

- `apps/web/src/App.tsx`:
  `e5d76b3f25996b3f2755febb5d9713dc8247b28dc24e8d9dcbb1ce827fdf5eea`.
- `apps/web/src/runnerReadiness.test.mjs`:
  `32c665aae8141dfe6f77de6db5556d06eb3244d6c2255b1b15567612d80a28f8`.

## Finding and correction

The old readiness list used the provider name as its React key and displayed the
same provider label for an unavailable base installation and ready saved
connections. `App.tsx:6151` now uses a JSON-encoded pair of provider name and
connection ID, with null for the base installation. The new label identifies
the base or the saved connection without dropping either record. JSON encoding
avoids delimiter collisions; React escapes the displayed text. Omitted and null
IDs share base identity. Protocol IDs are optional UUIDs, so empty string IDs
are not a supported alternate scope.

Every readiness status, native-detail string, model count, source pin and
workspace-isolation filtering rule remains unchanged. Keys remain stable across
reorder/reload/retest and status/catalog/source-pin changes. The correction
does not deduplicate records by provider or infer execution authority from Ready.

## Surrounding contracts examined

- `crates/crony-protocol/src/lib.rs:16` declares the optional connection UUID.
- `crates/crony-runner/src/adapter/mod.rs:319` stores base adapters in a map by
  provider name; `:371` returns those unique adapters.
- `crates/crony-runner/src/main.rs:700` constructs base capabilities with no
  saved connection; `:864` retains them and appends saved capabilities. The
  acknowledgment path at `:1020` reconstructs the same two sources of truth.
- `crates/crony-runner/src/connections.rs:442` iterates persisted connections.
  Its source-only capability is named workspace-isolation and is already
  excluded from this list. `:1383` produces the provider capability with its
  exact connection ID, immutable source identity and native model catalog.
- `apps/web/src/missionRuntime.ts:60` and `:80` distinguish base and exact
  saved-connection selection; this patch does not modify dispatch filtering.

No new execution, tools, sessions, retries, permissions or workspace mechanism
is introduced. Existing native account/catalog setup and existing process
ownership are reused for acceptance. No change is made to authorization,
tenant/Corp scope, server shell admission, durable approvals, task state,
budgets, loop breakers, migrations or applied SQL. The reported finding did not
establish wrong-source execution or an authentication bypass, and this review
does not claim either defect.

## Regression and acceptance evidence

Four tests parse and execute the actual production JSX and adapterLabel through
TypeScript/React. They assert the distinct keys and corresponding rendered
status/identity/model labels for multiple saved connections, reordered retests,
null/omitted base identity and distinct providers on one connection. Tests do
not extract a new production helper or substitute a duplicate implementation.
Observed retrospective red: 4 tests, 1 pass, 3 failures. Observed green: the
same 4 tests pass with no skips, cancellations or todo. These tests are also
included in the full Node discovery lane.

Acceptance R2 passed 31 assertions through a real browser, server, runner and
fresh owned PostgreSQL database with a disposable non-ECorp source. It exercises
two saved Codex connections, an unavailable base, reload/retest, sign-out and
restoration, selected-connection retention and 390-pixel wrapping, with zero
page/console/duplicate-key errors. Account/catalog responses come from an
explicit native fixture; no actual model inference, whole-issue application
journey or production human authentication is claimed. Both native binaries
and all 7,147 physical source files are bound to the retained receipts. Owned
services stopped successfully with no cleanup errors.

R1 acceptance failed because its version fixture incorrectly allowed the base
probe to succeed while the assertion required an unavailable base. R2 changed
only the external fixture wrapper for that probe; no product source changed.
The failed attempt, original screenshot and subsequent passing screenshots are
retained. Images are not redrawn or edited. The narrow capture includes a
focused skip-link overlay; it is not evidence of a separate product defect.

## Validation status at this review checkpoint

Canonical R2 is still active in session 6464. Its completion is not claimed in
this checkpoint; use the eventual canonical report and observed process-exit
receipt to determine the result. Do not commit or publish on this checkpoint
alone.

Original canonical R1 failed after five successful gates: Node 3,107 total,
3,039 passed, 3 failed, 65 skipped. The remaining five gates did not run. Two
failures lacked the standalone Teams scenario's locked SDK; its documented
locked install and all 18 focused SDK tests subsequently passed without source
changes. The third was an F02 preparatory read-tree timeout before the expected
clean-filter failure classification. Three exact repetitions passed with
unchanged assertions/deadlines and retained diagnostics. The original timeout
cause remains unestablished. The original large native stderr was not persisted;
only its length/hash/prefix/tail observations are available. Do not claim it was
fixed or that its missing raw stream was recovered.

## Remaining limitations

All-provider native inference, complete application/verifier/export acceptance,
multiplayer and parent Factory publication acceptance remain outside this
correction. Required hosted CI, CodeQL and quality/security gates are
unavailable while GitHub Actions is disabled. No eligible independent approval,
merge or issue closure has occurred. Historical Cargo advisory debt remains.
Existing open UI contributions require integration review after any base change.
