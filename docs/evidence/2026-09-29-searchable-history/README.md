# Searchable mission, task, run and event history

Issue #258 is locally implemented and accepted against main `878a1774774b0630c904cbaf4b05e1b346777817`. The tested tree is
`2224a7e35b549b801d18893b3365dd81ae78b830`. Required hosted CI, CodeQL, security and quality checks remain merge requirements.
This packet records no independent human approval, merge or issue completion. Parent #257 stays open.

## Result and acceptance

The console has a protected, server-paginated history for authorized missions, tasks, runs and events.
Each page rechecks the current human Read role and room membership. Corp-qualified joins and causal
links, a read-only repeatable-read transaction and a five-second SQL timeout bound the projection.
Page sizes are 1-100; the browser uses 25. Search is literal and limited to 160 Unicode characters.
Unsigned, query-bound cursors are positions, never authorization or authenticated expiry. Entities
use immutable created-at/id ordering; event BIGINT sequences stay textual. Separate pages are a live
history, not a frozen export. Late arrivals require an explicit refresh.

The console distinguishes draft and applied filters, declares scope and descending order, preserves
exact selections across navigation/reload/reconnect, and explains loading, missing, empty and partial
states. Missing or denied work remains unavailable. Atomic selection storage is scoped to server,
Corp and actor; stale callbacks and viewer changes cannot select substitute work. Readable event
summaries, actor/time attribution and authorized causal links never expose arbitrary event payloads.
Recent shortcuts remain explicitly bounded; they are no longer the end of history navigation.

| Issue requirement | Observed evidence |
| --- | --- |
| Authorized server pagination/search beyond old caps | 67 missions, 67 tasks and 67 runs across three pages each; 267 events across eleven pages, with exact IDs and no gaps/duplicates |
| Filters, ordering, scope, loading and partial history | Applied-vs-draft UI, immutable cursor/order regressions, late-event refresh, synthetic delay/503 and recovery |
| Exact mission/task/run selection | Old item navigation/reload, browser disconnect, task-only links clearing prior runs, missing run without substitution |
| Safe event details and causal links | Literal/payload search regressions and native safe-summary/actor/time/causal-link assertions |
| Room/Corp denial, keyboard and narrow screens | Real revoked-room 404, cross-Corp 403, cross-Corp-room/guest-room 404; restored membership; 390px keyboard pagination/reduced motion |

The fresh owned browser -> server -> isolated native runner fixture completed a real three-task
graph, persisted verifier evidence and retained artifact hashes. The runner continued during browser
disconnect. Two independent-review gates used the **development Bob persona**, not a real human
review. Cancelled seeded history supplies pagination data and is not runtime-completion evidence.
The fixture recorded zero GitHub effects and unchanged source, then stopped its exact owned services
and retained workspaces/data. Width/scroll width were both 372 pixels at a 390px viewport, with 61
controls checked and none clipped. Three original screenshots received assistant spot inspection.

## Validation and source binding

Canonical `pnpm check` passed all eleven named gates: migrations, state-audit compatibility, native
EVM, docs, repository docs, full Node discovery, format, clippy, workspace Rust tests, web build and
lint. Frozen installed dependencies were used. No gate, threshold or security protection was disabled.

- Node: **3135 total / 3070 passed / 65 skipped / 0 failed, cancelled or todo**.
- Rust: **881 passed / 576 ignored / 0 failed**, across 41 summaries. Native EVM separately passed one case.
- Focused SQL/API: **12 passed / 0 failed or ignored**, across three summaries, with nine store and three server tests. The earlier 7,152-file receipt is retained; all 270 backend/configuration files match the native source.
- Supplemental coupled frontend log: **150/150**. It has no dedicated pre/post source receipt; the final canonical discovery is the source-bound Node gate.
- Existing web-model coverage: **495/495** tests; lines **99.68%**, functions **97.40%**, branches **97.56%**, with unchanged **99/95/97** thresholds. Its 115-file manifest matches native source, covering 21 models and 33 test files; React hooks are explicitly outside the model-coverage denominator.

These test counts overlap and must not be added together. Native r5 and canonical r2 have identical
before/after physical inventories of **7,162 files**, bound in [source equivalence](source-equivalence.json).
A temporary index reconstructs the tested Git tree afterward. The evidence packet is added later
and checked separately for unchanged original bytes, exact code tree/patch, all eleven gate argv,
full Node discovery, documentation, personal paths, whitespace and native secret findings. The final
publication commit did not exist during the original execution.

## Chronology and limits

Canonical r1 failed after its first five gates passed: full Node discovery recorded **3,135 total,
3,068 passed, 2 failed, 65 skipped, 0 cancelled/todo**. Both failures were `ERR_MODULE_NOT_FOUND`
for the scenario-local locked `@microsoft/teams.apps` package. Format, clippy, workspace Rust tests,
web build and web lint did not run in that attempt. The failed receipt and provenance-bound failure
excerpts remain in `history/`; the complete original failed log remains retained locally.

The existing repo-steward lockfile was installed with `npm ci --ignore-scripts --no-fund --workspaces=false`.
Its lock and all 7,162 source files remained unchanged. All **18 Teams-host tests passed**, with no
failed, skipped, cancelled or todo cases, before canonical r2. npm reported 117 packages added and
118 audited, with zero vulnerabilities **for that scenario only**; no repository-wide or Cargo audit
claim follows. The original attempt remains a failure; the complete unchanged-source r2 run above
supplies the passing canonical result.

These are new retrospective regressions, not reconstructed original development evidence. Earlier
SQL compilation failed with no executed tests; SQL red-r4 recorded five passed/two failed. The
initial-selection pin regression recorded two passed/two failed, and the initial coupled frontend
run recorded 115 passed/eight failed. Their actual logs remain in `history/`. Native r1-r4 failed
fixture/driver acceptance and remain failures. In r4, a page reload re-ran the development bootstrap
and restored revoked demo membership; that observation was not a backend authorization defect.
r5 avoids re-bootstrap during revocation, verifies actual missing membership and absent authorized
snapshot objects, checks denial, and restores the original membership in a finally block.

The native fixture uses development authentication, fake-process execution and local PostgreSQL
trust authentication. It does not validate production OIDC or live vendor inference. The separate
SQL regression fixture used SCRAM-SHA-256 and verified authenticated access and wrong-password
rejection; SQLx environment-only secret delivery remains reduced assurance. Native server and runner
SHA256 hashes were recorded after their locked build and before launch in [native driver](native-driver.json).
This supplies prelaunch file identity, not operating-system attestation.

Loading-delay/503 assertions are synthetic browser faults. Three tall captures were spot inspected;
this is not exhaustive screen-reader/accessibility certification. `RUST_TEST_THREADS=1` was explicit;
issue #213 parallel qualification remains separate. Skipped/ignored cases remain unexecuted. Existing
bundle-size warnings and historical Cargo advisory debt remain; no clean audit is claimed.
`docs/PROJECT_MEMORY.md` is absent from current main. Required hosted checks remain mandatory while
Actions is disabled; issue #258 remains open until verified merge and completion.

## Reproduction and retained evidence

Use a clean isolated checkout with pinned tools and frozen dependencies. On Windows select an actual
Python interpreter through `PYTHON` and PATH, and record `RUST_TEST_THREADS=1` before `pnpm check`.
Run `pnpm coverage:web-models` for the model lane and the scoped SQLx tests against a freshly owned,
authenticated database. Build `cargo build --locked --bin crony-server --bin crony-runner` and use a
new owned database/runtime fixture for native acceptance.

The sanitized historical launchers, browser driver and existing native supervisor are in `drivers/`.
The shared acceptance driver is the unchanged [tracked native driver](../../../tools/e2e_factory_run_activity.py)
at this revision. Its SHA256 is retained in `summary.json` and the native/canonical source manifest.
A redundant sanitized copy triggered a generic-key finding on its public fixture idempotency prefix
plus a generated UUID, not an authentication credential. The original copy and failed scan are
retained locally; this packet references the existing source without duplicating it or changing
the driver or secret-scanning policy. Earlier publication whitespace failures are also retained;
four copied files had only an extra terminal blank line removed, with updated hashes.
They require local paths, unused ports, exact source guards and fresh owned fixtures; they are not
zero-configuration commands. Do not reuse the retained manual stack or configured source checkout
for write-capable runs. Stop only verified owned processes in a finally block. Node 24.21.0 and
PostgreSQL 17.10 were used. Hardware metadata was not collected.

- [Canonical report](canonical-report.json), [log](canonical-pnpm-check.log), [reviewed code patch](reviewed-code.patch.json).
- [SQL receipt](focused-sql.json), [focused source binding](focused-source-binding.json), [model coverage](coverage/summary.json).
- [Native browser report](native/issue258-browser.json), [screenshot inspection](screenshot-review.json), [implementation self-review](implementation-self-review.json).
- [Artifact hashes, redactions and qualifications](summary.json). Original private artifacts and original hashes remain retained; published text removes personal paths and discovered sensitive values and normalizes whitespace.
