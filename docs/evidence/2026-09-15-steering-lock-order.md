# Issue 223: steering/run-status lock inversion

Date: 2026-09-15. Base: `All-The-Vibes/ecorp` main
`b2523964e7576cafc00e84a51e1044f55826dea7`.
Branch: `codex/issue-223-steering-deadlock`.

## Outcome and boundary

`queue_message` now locks the exact observed active run before the agent grant
lock. After acquiring the unchanged agent/lease locks it rechecks the destination.
A destination change returns a conflict and rolls back; it does not acquire a
replacement run lock in the old order or retry automatically. Existing committed
message replay still returns the original message and destination.

The scoped SQLx 0.8.6/PostgreSQL transaction is the native capability used here.
PostgreSQL row locks and the existing idempotency advisory lock suffice; there is
no provider retry engine, new permission mechanism, schema change, or lock weakening.
The exact run lock protects the subsequent command foreign-key check. Existing
dispatch/resume code publishes a run and updates the agent in the same transaction;
the retained agent SHARE lock prevents that update from committing during admission.
This report proves the identified steering/status cycle, not global deadlock freedom.
See [PostgreSQL row locks](https://www.postgresql.org/docs/17/explicit-locking.html).

## Baseline failure

The regression was added before any production change and run against the base
implementation, using actual migrations in an SQLx-created database in an owned
PostgreSQL 17 container. It failed with `deadlock detected`.

The observer held the **existing** `control-message:<corp>:<key>` advisory lock.
The real `queue_message` operation reached that lock while holding agents SHARE.
The real `apply_runner_event(run.status)` then held the run lock and waited at
`UPDATE agents SET status = $1, station = $2 WHERE id = $3`. Observed
`pg_blocking_pids` relationships identified both waiters before release of the
advisory gate. Releasing it produced the reported cycle. This is not a synthetic
SQL-only deadlock or a sleeps-only test.

The same interleaving passes with the fix: status waits at its run selection,
steering inserts one command, then status completes. Replay creates no second
command. Failure evidence is retained separately from passing results.

## Focused regression evidence

Ten opt-in real-migration store tests passed (none ignored in the explicit run):

- observed steering/status contention and duplicate replay;
- Corp/room/lease rejection, queued delivery, retired-agent rejection;
- a destination becoming terminal while admission waits;
- a new active run becoming visible after a no-run observation;
- retirement while waiting for the run lock;
- lease rotation while waiting for the lease row;
- room membership removal while authorization waits;
- an injected message insert failure rolling back the already-inserted command;
- stale assignment rejection with full ledger equality, plus usage/output preservation;
- committed replay retaining its original destination while replacement work changes.

Negative assertions require the intended error reason and exclude PostgreSQL
`40P01`; an arbitrary database failure is not a passing authorization rejection.
The accounting test is sequential store coverage. Concurrent lifecycle evidence
comes from the observed-lock test and the separate real runner exercise below.

Run against an explicitly owned PostgreSQL maintenance database, never the
operator application database. SQLx creates the individual test databases and
applies the repository migrations. Example (replace the owned-port placeholder):

```sh
DATABASE_URL='postgres://fixture@127.0.0.1:<owned-port>/fixture_admin' \
  cargo test -p crony-store issue223_ --locked --offline -- \
  --ignored --test-threads=1 --nocapture
```

The recorded run used a unique `postgres:17-alpine` Docker container with a
random loopback port, tmpfs data, generated ownership label, and test-only trust
authentication. The launcher checked exact container ownership before cleanup.
No fixed operator port, retained database, or existing credentials were used.

## Real server, runner, and browser

The exact modified server/store and real runner were built locally. The runner's
Codex command pointed at Node plus `scripts/fake-codex-app-server.mjs`; this is a
synthetic native protocol fixture, not paid Codex or Copilot execution.
The explicit `[steering-contention]` fixture emits native status frames while an
owned observer holds the message gate. Its timer is bounded and cleared on finish.

The HTTP exercise used ordinary lease, create-mission, launch, and message APIs:

1. Start the synthetic Codex mission and wait for its persisted running/session state.
2. Hold the exact message idempotency advisory key in the owned database.
3. Submit a steering POST with that key; observe it waiting on the gate.
4. Observe an actual runner status handler waiting on the message transaction's run lock.
5. Release the gate. Require immediate delivery and replay with one command.
6. In the actual browser, inspect Cody, claim live control, and submit the same
   test direction using **Steer**. Verify both acknowledgments and delivered timestamps.
7. Require persisted completion, a single run, nonzero synthetic
   input/output usage, and the exact expected contents of `steered.txt`.

| Receipt | Value |
|---|---|
| Mission | `739895b9-597c-4c73-b0dc-4686fb7eab4e` |
| Run | `be87c477-e76b-47be-8036-e9c0c70063fa` |
| Gate / message / runner-status backend PIDs | `213` / `108` / `103` |
| HTTP delivery / replay | immediate / true |
| Commands after browser steering | 2, both acknowledged (`dispatched` in the store schema) |
| Delivered message timestamps | 2 present |
| Final UI | Completed; 1/1 tasks; 1/1 checks passed |
| Synthetic usage | 10 input / 2 output tokens |
| Recorded artifact SHA-256 | `549e0f50a682359f68185e5a9c429ca066efe29796b8f9c8ccc01ce8be804dac` |

The browser screenshot, DOM snapshot, machine-readable result, baseline/fixed
logs, and local fixture driver are retained in the contribution's ignored
`output/issue223/` directory. The dirty runner worktree was moved intact into
persistent local QA storage before stopping the owned stack and deleting its
container. The original operator runtime, credentials, worktrees, and history
were not changed. New saved-connection setup emitted an existing temporary-path
boundary warning; that feature was not exercised or claimed ready.

## Repository validation and independent review

The required migration-integrity, format, all-target Clippy, workspace tests,
web build, and web lint gates passed. Workspace tests: **517 passed, 0 failed, 333 ignored**.
Ignored database tests are not counted as passed by ordinary workspace tests.
The ten tests above were run explicitly against the disposable database.

GitHub Copilot `gpt-6-astra`, high effort, completed a focused design assessment
and independent implementation review. The first broader design request timed
out without a result. The completed review found no confirmed production blocker;
its requests for exact rejection reasons, full stale-callback ledger checks,
replacement-work replay coverage, and bounded lock-order claims were addressed
and independently checked. Relevant dispatch/resume and lease bodies were
inspected; no claim of exhaustive lock-order safety is made.

No new hosted-CI result, real provider sign-in/inference, Windows runtime
acceptance, PR publication, merge, deployment, or automatic Factory intake is
claimed by this evidence.

## Source fingerprints

| File | SHA-256 |
|---|---|
| `crates/crony-store/src/lib.rs` | `b756206c1a06c03834dda03d35224d63a3a154a540a959128580d7ffceab2daa` |
| `crates/crony-store/src/steering_lock_tests.rs` | `ca40d0c4dcd831e7cba3eae8f10285537a48fba6d2f21ce84fb8a8e85340d8c5` |
| `scripts/fake-codex-app-server.mjs` | `367f83d32b8640f8923bf166b2e5ff8751ed58209ff622b5aaa412f5b813fb8b` |
| `crates/crony-store/Cargo.toml` | `98cc894061776f01a6e7c97f82efa37399a9ad7bfea672b9b0ae7f6006bcfbf2` |
| `Cargo.lock` | `09910f43d0a3439f13b2de79c6c4b6ee45b5b613e45dc32c5b59e269e2a61848` |
