# Repo Steward contribution evidence - September 13, 2026

## Source and scope

- Repository: `All-The-Vibes/ecorp`; approved new-work Project: organization #5.
- Tracking issue: [#250](https://github.com/All-The-Vibes/ecorp/issues/250).
- Contribution branch: `codex/repo-steward`, in its own linked worktree.
- Source base: `main` at `b2523964e7576cafc00e84a51e1044f55826dea7`.
- Write scope: `scenarios/repo-steward/**` and
  `.github/workflows/repo-steward.yml`.
- The review PR records the exact published head. No existing Rust, web,
  migration, CI, Factory, database or runner implementation was edited.

This is a read-only GitHub collector, deterministic auditor, bounded Q&A and
native-harness tool/role boundary. It is not a running model session, autonomous
watcher, accepted Factory mission, or deployed service. The previously authored
optional Teams adapter is retained disabled; Teams rollout is deferred.

## Verification completed before publication

| Check | Observed result |
| --- | --- |
| `node tools/check_migrations.mjs` | Passed: 41 migrations; immutable checksums valid |
| `cargo fmt --check` | Passed |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `cargo test --workspace` | Passed, exit 0; opt-in SQLx/native-session tests remained ignored |
| `pnpm build:web` | Passed |
| `pnpm lint:web` | Passed |
| `npm test --workspaces=false` in this scenario | Final unchanged rerun: 148 passed; 0 failed/skipped/cancelled; 810 ms |
| JavaScript syntax | All 12 source/test modules passed `node --check` |
| Authored-file hygiene | 20 authored files; no trailing whitespace or conflict markers |
| Scenario manifest/lock | Package identity, dependencies and engine requirements agree |
| Workflow structure | Parsed with unique YAML keys; manual-only trigger, read-only native token, approved environment and immutable action pins verified |

The web prerequisites were installed using
`pnpm install --frozen-lockfile --ignore-scripts`; no lockfile change or dependency
upgrade was made. Rust checks used a worktree-local `target/` directory. Runtime
database/factory/provider credential environment variables were removed only
from the Rust test process; no persistent user configuration was altered.
Tool versions: Node 24.19.0, pnpm 11.19.0, cargo 1.98.1.

The actual GitHub-only entry point was also exercised:

- `node actions.mjs --dry-run`: no live reads or summary write.
- `node actions.mjs --fixture`: successful synthetic audit without hosted secrets
  or Teams SDK access.
- `node actions.mjs --live` on the desktop: expected exit 1 / `ACTION_EVENT`,
  before collection; live hosted mode requires its approved Actions context.
- Local collector and snapshot Q&A: scoped authenticated reads succeeded, answers
  included timestamped references, mutation requests were refused, and the
  executed-actions list remained empty. No live findings are reproduced here.

## Tests and native capability checks

The original core suite passed 94 tests. Adding the Actions boundary increased
the core suite to 130 tests. The combined suite additionally covers the retained
Teams transport with synthetic, uniquely owned ephemeral loopback fixtures.
These tests are not real-tenant login, registration, signed message delivery or
production acceptance. They close their own listeners and leave other listeners
untouched.

An initial core/Actions run passed 129 tests and failed the temporary-file test
because the read-only sandbox rejected `mkdtemp` with `EPERM`. The unchanged suite
passed 130/130 with approved owner-context access; the complete acceptance run
passed 148/148. An earlier transport run reached its deadline; that failure
remains in the private local evidence. The SDK's `port || 3978` behavior and
internally caught startup failures motivated the supported loopback adapter and
explicit listener verification. No authentication checks were bypassed.

During the publication checks, a concurrent Rust/Node run passed 147 tests and
cancelled the native Teams transport test at its unchanged 15-second deadline.
SDK initialization took 13,844 ms in that attempt. After the Rust suite finished,
one unchanged complete rerun passed all 148 tests in 810 ms; SDK initialization
took 428 ms. The observed timing difference is consistent with workload or cold
startup sensitivity, but does not independently establish its precise cause.
The timed-out attempt is retained as a limitation; no timeout was extended and
no assertion was removed. The GitHub workflow runs only the dependency-free core
and Actions suite, not this deferred transport.

The existing Rust runner readiness fixture took 75 seconds and passed. No Rust
tests were modified, selectively rerun, or converted from failures to ignores.
Default workspace selection is not proof of the opt-in PostgreSQL or real
stopped-provider-session tests, which require separately owned fixtures.

GitHub already supplies dispatch, protected environments, concurrency, timeouts
and job summaries. The missing behavior is the bounded cross-object audit and
limited report formatting, implemented as a thin wrapper around the same local
collector/auditor. Official action release metadata was checked and pins are:

- checkout v7.0.1: `3d3c42e5aac5ba805825da76410c181273ba90b1`;
- setup-node v7.0.0: `820762786026740c76f36085b0efc47a31fe5020`.

Both actions use native `node24`. Hosted Node is pinned to 24.19.0, with no npm
install or package cache in this workflow. The optional Teams transport uses
`@microsoft/teams.apps` 2.0.16 and its native JWT/routing behavior; the GitHub-only
path does not import it.

## Privacy and remaining gates

The previous full local evidence was preserved under ignored `output/` before
preparing this publication-safe version. Raw snapshots, live finding counts,
finding descriptions, local reports, credentials, and private chat bindings are
not part of this contribution. Ignored output and dependency directories must
not be force-added.

The workflow has been locally validated, not run on GitHub. Public live-summary
release, hosted credentials, environment setup, scheduler activation and repo
maintenance writes remain separately unauthorized. A native environment name
and script variable checks do not establish authorization or isolation. The
README requires native protection/review and a separately approved restricted
Project-readable credential before live hosted activation.

No browser/server/runner product E2E was run for this standalone CLI/package;
no ECorp UI or shared runtime behavior was changed. Do not claim full-stack,
real-model, Teams, or hosted acceptance from these local results. Independent
review and normal integration remain pending. Merge and auto-merge are disabled.
