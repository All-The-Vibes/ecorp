# Issue 161 QA handoff — September 13, 2026

This preserves the pre-runtime checkpoint. The subsequently approved owned QA run,
actual database results, helper correction, cleanup and remaining gates are in
[runtime-acceptance.md](runtime-acceptance.md).

## Source and status

- Branch: `codex/issue-161-shared-authority`.
- Base: `b2523964e7576cafc00e84a51e1044f55826dea7`.
- Worktree: `C:\Users\aabdelsalam\.ecorp\contributions\issue-161-shared-authority`.
- Implementation is an uncommitted working-tree candidate, not a published or
  accepted commit. Existing contribution changes were retained and extended.
- No Factory item was dispatched, no service stack was started, and no migration
  was applied to a retained database during this continuation.
- No commit, PR, GitHub mutation, merge, auto-merge or deployment was performed.

## What was built

The candidate supplies a persistent immutable Corp claim-authority ID, authenticated
uncached inspection, CLI inspection/comparison and controller policy pins, server/store
mismatch rejection, legacy-policy preservation, and visible UI authority diagnostics.
It reuses the current claim/fencing/idempotency machinery and existing SQLx/handler
fixtures. The full contract and limitations are in
[Factory claim authority](../../FACTORY_CLAIM_AUTHORITY.md).

The continuation added canonical policy normalization, redirect/response-size and
response-diagnostic protections, the database immutability trigger, concurrent
handler and store regression coverage, the setup preview and this handoff. It did
not replace PR #237's shared QA supervisor or the operator's existing runner identity.

## Observed local validation

Runtime: Windows ARM64; Rust/Cargo 1.98.1, Node 24.19.0, pnpm 11.19.0.
Dependencies came from caches. `pnpm install --offline --frozen-lockfile --ignore-scripts`
reused 27 packages, downloaded zero, and did not change the root lockfiles.

| Check | Result |
| --- | --- |
| `node tools/check_migrations.mjs` | Passed: 42 append-only migrations and immutable checksums |
| `cargo fmt --check` | Passed |
| `cargo check --workspace --all-targets --locked --offline` | Passed |
| `cargo clippy --workspace --all-targets --locked --offline -- -D warnings` | Passed |
| `cargo test --workspace --locked --offline --quiet` | Passed: 554 executed, zero failures; 332 explicitly ignored |
| `pnpm build:web` | Passed |
| `pnpm lint:web` | Passed |
| `node --test apps/web/src/factoryAuthority.test.mjs apps/web/src/factoryControllerSelection.test.mjs tools/issue161/qa-plan.test.mjs` | Passed: 20 tests |
| `git diff --check` | Passed |
| `node tools/issue161/qa-plan.mjs --dry-run ...` | Passed setup preview, `mutations: []`; no resources created |

Ambient `DATABASE_URL` was removed in the Rust gate subprocess. Of the ignored
tests, 331 are database-dependent (324 store, seven server), and one is the opt-in
stopped-provider evidence probe. Ignored tests are not passes.

The seven non-database `issue161_` Rust cases cover parsing/normalization, endpoint
report validation, policy/recovery binding, bounded/redirected/malformed responses,
and stopping the public controller before GitHub or claims on a mismatch.
An intermediate test-authoring compile failed because `ApiError` does not convert
to `anyhow::Error` through `?`; the test assertions were corrected before the final
workspace checks. That was not a reported production runtime failure.

## Compiled, but not yet executed against a database

Six new store cases reuse `workspace_connections_tests::factory_connections`:

- scoped, stable, read-only authority inspection and snapshot projection;
- unique, non-nil, immutable migration identity;
- required/malformed/mismatched production pins with unchanged ledgers on denial;
- mutation-free preflight and exact materialization replay;
- legacy replay/reclaim without adding or rebinding authority policy;
- actor/Corp/source restrictions with immutable source materialization.

Three new real-handler cases reuse `factory_connection_tests`:

- racing two controller actors yields one winning claim and one held mission,
  with keyed concurrent materialization and no claim-token disclosure;
- authority inspection is uncached and rejects foreign Corp scope;
- a bad pin is rejected before claims, events or materialization.

After provisioning a separately approved owned maintenance database, the focused
commands are:

```powershell
cargo test -p crony-store issue161_ --locked --offline -- --ignored --test-threads=1
cargo test -p crony-server issue161_ --locked --offline -- --ignored --test-threads=1
```

Supply the database connection only through the approved supervisor's private
process environment. Do not use the retained office database, print its connection
string, or put credentials in command arguments or files accessible to agents.

## Setup dry-run preview and next approval boundary

The executed preview command was:

```powershell
node tools/issue161/qa-plan.mjs --dry-run `
  --qa-root C:\Users\aabdelsalam\.ecorp\qa\issue-161-shared-authority `
  --pg-bin C:\Users\aabdelsalam\.ecorp\pg\pgsql\bin `
  --worktree C:\Users\aabdelsalam\.ecorp\contributions\issue-161-shared-authority `
  --source-checkout C:\dev\ecorp
```

It checked unused QA-root and canonical-parent boundaries plus required executable
presence. It proposes PostgreSQL port 55461, APIs 18971/18972, web 15471, three new
QA databases, an independent synthetic source, two runner roots and two controllers.
Ports are not reserved and must be rechecked before startup. This is a setup plan,
not an ECorp mission-preflight response or executable lifecycle supervisor.

Continue only after approval of that fixture footprint. Reuse or coordinate the
hardened helpers in PR #237; the current base's Windows `owned_test_stack.mjs`
contains the earlier PID-only restart path and must not be used for this drill.
Do not silently copy the whole budget-recovery PR into this contribution or start
a competing fixture supervisor. Retain all QA evidence and stop only verified
receipt-owned processes at completion or failure.

## Explicitly unproven

- Application of migration 0042 and the nine new SQLx cases against real databases.
- Two native controllers/two native runners, reconnect and source-drift acceptance.
- Independent ledgers with identical Corp IDs through live endpoints.
- Rendered browser-to-server-to-runner acceptance of the new UI.
- Two physical hosts, production human/provider identities, real GitHub effects,
  hosted CI, publication or release acceptance.

Do not close #161 or claim coordinated multi-host execution from this handoff.
