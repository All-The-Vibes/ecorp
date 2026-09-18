---
title: Factory strategy cost admission for issue 79
description: Native regression results, audited legacy handling, and remaining validation gates
---

## Scope and implementation

Implemented in the existing isolated `afateen/issue-79-factory-cost-preflight` worktree,
based on `b2523964e7576cafc00e84a51e1044f55826dea7`. The implementation and validation
phase did not commit, push, edit remotes/excludes, mutate GitHub, change database
migrations/dependencies, or change another checkout. Publication is tracked separately.

The existing full Factory preflight already prevented new orphaned claims in ordinary controller
intake. It did not validate the CLI cost before GitHub discovery or protect direct claim clients.
The change adds only the missing cost-specific boundaries:

- `crony-domain::strategy_cost_budgets` is used by CLI admission and actual planner allocation.
  `validate_factory_cost_policy` applies it to every allowed strategy at new claim admission
  and prospective preflight/materialization.
- The existing 10,000,000 microusd/task and 50,000,000 microusd/graph ceilings are unchanged.
  Parallel specialists retain the `2/7, 2/7, remainder` allocation; studio retains
  `15%, 15%, 15%, remainder`, with existing integer rounding and minimums. A single-task
  $20 budget is rejected, while a parallel-specialists $20 budget remains valid.
- CLI cost validation runs before even local Git branch-syntax validation, GitHub quota queries,
  Project discovery, or server calls. Dry-run and execution use the same guard.
- Historical JSON normalization remains separate from prospective admission. The existing
  exact-source/policy claim boundary reconciles an impossible, unmaterialized `claimed`/`blocked`
  legacy item to `failed`, using the existing state-change writer and operation journal.
  It checks current owner/lease and operator/connection authorization, releases the lease, returns
  no token, and preserves source, policy and old operations. Failure and audit commit atomically.
- Broad CLI polling skips such legacy items with actionable guidance. An exact `--issue`
  dry-run previews terminal reconciliation; execution requests it without source pinning,
  materialization, provider dispatch or GitHub mutation. Original invalid claim replay cannot
  regain a token; a fresh reconciliation key is required. Materialized historical work and
  materialization replays retain their existing behavior.

No harness execution loop, approval surface, scheduler, financial ledger or API endpoint was added.
Existing attempts, token limits, small explicit budgets, authorization, and financial authority
remain unchanged. The #282 token-limit work was not implemented.

## Native Windows verification

Used the authorized portable Rust **1.94.0** GNU toolchain and registry cache under
`C:\Repos\ecorp-issue-297\.qa-issue-297`. All new target files, binaries, fixtures and logs were
written under `C:\Repos\ecorp-issue-79\.qa-issue-79`, not the #297 evidence directory.
The actual targets were linked with the bundled Rust LLD, not replaced with proxy tests:

```powershell
. .qa-issue-79\environment.ps1
cargo rustc --locked --offline -j2 -p crony-domain --tests -- `
  -C "linker=$Issue79Lld" -C linker-flavor=ld.lld
cargo rustc --locked --offline -j2 -p crony-cli --tests -- `
  -C "linker=$Issue79Lld" -C linker-flavor=ld.lld
cargo rustc --locked --offline -j2 -p crony-store --tests -- `
  -C "linker=$Issue79Lld" -C linker-flavor=ld.lld
cargo rustc --locked --offline -j2 -p crony-server --tests -- `
  -C "linker=$Issue79Lld" -C linker-flavor=ld.lld
```

The same linker arguments built the actual `crony-cli` and `crony-server` application binaries
with `--bin crony-cli` and `--bin crony-server`. CLI test-artifact selection was subsequently
made explicit through Cargo's `--message-format=json` / `profile.test` output, because the
application executable also appears under `deps`.

Final executed test commands and results (all paths relative to this worktree):

| Actual command | Result |
| --- | --- |
| `& .qa-issue-79\target\debug\deps\crony_domain-18cf3603bf2cd126.exe --test-threads=2` | **19 passed** |
| `& .qa-issue-79\target\debug\deps\crony_cli-aa5996a6f5995df7.exe --test-threads=2` | **118 passed** |
| `& .qa-issue-79\target\debug\deps\crony_server-90d4bd3fdbb5b5d5.exe planning::tests --test-threads=2` | **24 passed** |
| `& .qa-issue-79\target\debug\deps\crony_store-05c45a5e41a9b9a4.exe factory_connections --ignored --test-threads=2` | **22 passed**, real SQLx databases |
| `& .qa-issue-79\target\debug\deps\crony_store-05c45a5e41a9b9a4.exe tests::factory --test-threads=2` | **7 passed**; 22 SQLx cases ignored here and executed separately above |
| `& .qa-issue-79\target\debug\deps\crony_server-90d4bd3fdbb5b5d5.exe factory_connection_tests --ignored --test-threads=2` | **5 passed**, actual handlers with real SQLx databases |

These results include all **12 new `issue79` Rust tests**. The five new store tests also passed
in an initial focused `issue79 --ignored --test-threads=2` run; those are not double-counted above.
Existing connection authorization, attempt-policy, materialization replay and planner tests passed.
An initial CLI source-order regression was corrected by preserving attempt congruence before the
new legacy dry-run path; the final complete CLI suite passed.

## Native CLI, HTTP server and PostgreSQL canary

Initialized a **new** owned PostgreSQL **17.11** cluster under
`.qa-issue-79\postgresql\data`, listening only at `127.0.0.1:55479`. SQLx tests used their own
disposable databases. A separate fresh `issue79_e2e` database served the actual application at
`127.0.0.1:55480`. Development bootstrap created fixture actors; no reset endpoint was used.
No runner, real provider or real GitHub API participated.

Ran the checked-in script with explicit owned-fixture environment settings:

```powershell
# .qa-issue-79\run-e2e.ps1 sets the explicit owned server, psql, actor/Corp,
# application binary and worktree-contained output paths.
. .qa-issue-79\run-e2e.ps1
# Invokes: node tools\e2e_factory_cost_preflight.mjs
```

Observed:

- **14 invalid native CLI invocations**, split across dry-run/execution: no GitHub fixture
  read/counter change and byte-for-byte equivalent durable item/operation/graph/event ledgers.
- **4 direct HTTP claim denials**, each `400`, with unchanged durable ledgers.
- **2 valid single-strategy boundary invocations** (`1` and `10,000,000` microusd) passed local
  cost admission and reached discovery; the deliberately unconfigured fixture source/runner
  prevented normal execution later. Accepted materialization at these costs is separately
  proven by the real-store tests.
- An owned historical fixture retained an impossible `20,000,000` single-strategy policy
  and the legacy source-upgrade marker. Exact dry-run was read-only; broad polling skipped it.
  Exact execution produced **one audited terminal failure**, with no policy rewrite or source pin.
- Final GitHub Project status remained **Todo**, with **zero Project edits/effects**.
  Final database inspection found **one preserved failed legacy item, one state-change audit,
  zero missions, zero tasks and zero runs**.

The initial canary exposed Git branch-syntax validation preceding cost admission when the supplied
checkout was unavailable. Cost admission was moved ahead of that local Git call and the final
native CLI suite and canary were rerun successfully.

An additional final native invocation, after shutting down the server and with nonexistent
checkout/GitHub executable paths, exited `1` with:

```text
Error: strategy single cost budget 20000000 microusd allocates 20000000 microusd to a task; per-task limit is 10000000 microusd
```

Local evidence includes `final-test-crony-cli.log`, `test-store-factory.log`,
`test-server-factory.log`, `test-server-planning.log`, `test-http-e2e.log`,
`http-e2e\result.json`, `http-e2e\persisted-summary.json`, and
`exact-invalid-invocation.log` under `.qa-issue-79`.

## Cleanup and remaining gates

The task-owned application process was stopped and its PID absence verified. PostgreSQL was
gracefully stopped using `pg_ctl -m fast -w stop` after verifying its binary, PID, start time and
owned data directory. Both loopback listeners were absent afterward. The stopped cluster and
evidence are retained; the #297 cluster/data were never started or changed.
Cleanup was verified at `2026-09-17T00:16:24Z` (September 16 local time).

- `node tools\check_migrations.mjs`: passed; 41 migrations with immutable checksums.
- `cargo fmt --check`, `git diff --check`, and `node --check tools\e2e_factory_cost_preflight.mjs`:
  passed.
- `cargo check --locked --offline -j2 -p crony-domain -p crony-cli -p crony-store
  -p crony-server --all-targets`: passed on the final sources (`final-cargo-check.log`).
- **Canonical Clippy remains blocked**: `cargo clippy --locked --offline -j2 --workspace
  --all-targets -- -D warnings` fails in unchanged
  `crates\crony-store\src\retained_provider_receipt.rs:50` (`clippy::nonminimal_bool`).
  This was neither fixed nor suppressed.
- A separate **non-gating diagnostic** run, `cargo clippy --locked --offline -j2
  -p crony-domain -p crony-cli -p crony-store -p crony-server --all-targets`, completed and
  reported only that same existing warning (duplicated for the store test target).
  No warning suppression was supplied, and this does not turn the canonical gate green.
- At the implementation phase above, full workspace tests and browser/web build/lint gates
  were **not claimed**. The subsequent pre-follow-up workspace result is recorded below. Web dependencies
  are unavailable and npm URLs are blocked by the supplied IT policy; no npm download, registry
  substitution or bypass was attempted. The verified product surface here is Factory CLI/API
  admission and explicit legacy reconciliation, not a new browser or live-provider run.

## Pre-follow-up full workspace gate

Before the selector fix below, the actual bundled-LLD workspace command completed:

```powershell
cargo test --locked --offline --workspace --no-fail-fast -j2 -- --test-threads=2
```

Result: **exit 101; 517 passed, 36 failed, 329 ignored**. All failures were in unchanged runner
code: 24 Git worktree path-length errors (`$GIT_DIR` too big), three unavailable Windows symlink
privileges (1314), two native connection-state fixtures rejected because their retained paths were
inside this checkout, and seven assertions. The seven assertions are not claimed as diagnosed
environment failures. Runner totals were 177/36/1; all other targets had zero failures, and all four
doc-test targets completed with zero tests. Per-target counts and full failure details are retained
in `.qa-issue-79\workspace-tests.log` and `workspace-summary.json`.

That command predates the following source change; it is **not a passing or post-fix workspace
gate**. No unrelated runner fix, privilege change, warning suppression, or test exclusion was made.
The original 27 focused SQLx passes remain separately evidenced above; ignored workspace database
tests were not silently enabled.

## Review follow-up: exact legacy selectors

Independent review identified that the early legacy-cost return preserved task-attempt congruence
but bypassed the normal recovery checks for the requested connection binding and source ref.
The CLI now extracts the existing pure selector checks from source-commit resolution, runs them
before either a legacy dry-run preview or reconciliation, and repeats them on the refreshed item
immediately before the claim POST. A different or omitted bound connection, or a different source
ref, is rejected rather than being hidden by sending the persisted policy. The checks do not read
a checkout, resolve a commit, or upgrade a legacy source pin. Normal recovery reuses the same checks.

Post-fix commands used the process-local bundled LLD configuration and the issue79-owned
`.qa-issue-79\target-workspace-lld` directory, with no dependency installs:

| Command | Post-fix result |
| --- | --- |
| `cargo test --locked --offline -j2 -p crony-cli -- --test-threads=2` | **119 passed, 0 failed, 0 ignored** |
| `cargo build --locked --offline -j2 -p crony-cli --bin crony-cli` | Passed; actual native CLI application |
| `.qa-issue-79\run-selector-e2e.ps1` → `node tools\e2e_factory_cost_preflight.mjs` | Passed against the actual HTTP server and fresh PostgreSQL fixture |
| `cargo fmt --check`, `node tools\check_migrations.mjs`, `node --check tools\e2e_factory_cost_preflight.mjs`, `git diff --check` | Passed |

The new Rust regression rejects missing/substituted connections and a changed source ref without
any HTTP request or policy change. The matching reconciliation test uses a missing checkout path,
a bound connection and an unpinned legacy policy. The native canary independently exercises all
three mismatches in **both dry-run and execution: six denials**, each with byte-identical durable
ledgers and no GitHub Project effects. Matching `A/main` selectors still produce a read-only preview
and one audited terminal reconciliation despite a nonexistent checkout. The original 14 cost
denials, four direct HTTP claim denials, two cost boundaries and broad-poll skip also pass.

This follow-up used a **new** PostgreSQL 17.11 cluster at
`.qa-issue-79\selector-postgresql\data`, database `issue79_selector_e2e`, on `127.0.0.1:55481`,
and the unchanged actual server binary on `127.0.0.1:55482`. The two saved connections are owned
offline fixture metadata, not running providers. An initial fixture setup omitted the runner's
required Corp field and failed before creating a claim; it was corrected, and that failed attempt
is retained separately as `selector-http-e2e-fixture-failure.log` and its fixture directory.
No database reset or historical-row deletion was used.

Final SQL inspection confirmed the original connection and `main` ref, unchanged 20,000,000 cost,
no source pin, retained legacy-upgrade marker, one failed item, two operations (original claim and
reconciliation), one state-change audit, and zero missions/tasks/runs. The server was stopped and
PostgreSQL shut down with `pg_ctl -m fast -w stop`; cleanup at **2026-09-17T01:05:26Z** confirmed
no owned process or listener remained and both old and new PostgreSQL PID files were absent.
Both clusters and evidence remain retained; the issue297 data and binaries were not modified.

Post-fix evidence: `.qa-issue-79\selector-cli-tests.log`, `selector-cli-build.log`,
`selector-http-e2e.log`, `selector-http-e2e\result.json`, `selector-http-e2e\persisted-summary.json`,
and `selector-cleanup.json`. The prior workspace failure and unavailable canonical Clippy/web gates
remain separate; they were not rerun or represented as passing after this fix.

## Final review and environment follow-up

Independent follow-up review of the connection/source-ref fix and its regressions
reported no significant issues. No implementation changes followed that review.

The 33 non-privilege-dependent runner failures were rerun serially with a new,
short, owned `TEMP`/`TMP` outside any configured source checkout. The actual runner
test binary was used: **31 passed, 2 failed, 0 ignored, 181 filtered out**. All
24 previous path-length failures and all seven previous assertion failures passed.
This isolates those observations to the earlier test layout/execution conditions;
it does not replace the failed full-workspace gate.

The two remaining cases were:

- `connections::integration_tests::native_fixture_personal_github_profiles_and_login_replay_survive_restart`
- `connections::integration_tests::native_fixture_ready_ack_refresh_rejection_and_old_run_pins_survive_restart`

Both now stopped with `private connection directory permissions could not be
established`. The three earlier Windows symlink-privilege failures were not
rerun. These five cases remain unverified on this host. No elevation, Developer
Mode, permission repair, global Git setting, OS protection change or test-source
modification was attempted.

Exact selected names and results are retained in
`.qa-issue-79\runner-layout-followup\results.json`. The short temporary fixture
directory is retained because it contains failed fixtures and preserved
worktrees. No owned processes or database/API listeners remained after the run.

Publication readiness is therefore limited to a review draft: issue-specific
CLI/API/database behavior and the selector correction have passing evidence,
but full-workspace, canonical Clippy and web gates are not green. The issue must
remain open pending the required verification and owner review.

## Changed files

- `crates/crony-domain/src/planning_cost.rs`, `crates/crony-domain/src/lib.rs`
- `crates/crony-cli/src/factory.rs`
- `crates/crony-server/src/planning.rs`, `crates/crony-server/src/factory_connection_tests.rs`
- `crates/crony-store/src/lib.rs`, `crates/crony-store/src/factory_connection_tests.rs`,
  `crates/crony-store/src/factory_cost_policy_tests.rs`
- `tools/e2e_factory_cost_preflight.mjs`
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DARK_FACTORY_CONTRIBUTOR_GUIDE.md`,
  `docs/EVALS.md`, and this report
