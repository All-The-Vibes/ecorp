# Reproducible repository validation

Run from an isolated contribution worktree, not the configured source checkout.
Use `pnpm install --frozen-lockfile`; do not change the lockfile to hide an installation failure.
Install the steward's native SDK test dependency separately with
`npm ci --prefix scenarios/repo-steward --ignore-scripts --no-audit --no-fund`.
This installs test code only; it does not configure Teams credentials or send messages.
Node's native test runner is already the repository's JavaScript test harness. No alternate
framework or renamed tests are needed to make its existing regression suite discoverable.

`pnpm check:preview` lists the exact checks without running them or writing artifacts.
`pnpm check:fast` checks migrations, documentation contracts and Rust formatting.
`pnpm test:js` runs the configured Node suites, including the web's TypeScript regressions.
`pnpm test` adds the Cargo workspace suite. `pnpm check` also runs Clippy, web build and lint.
The Node test runner uses one file worker to avoid competing ownership fixtures.
Install local hooks with `pre-commit install` only if you want them; CI does not rely on this.

<!-- BEGIN GENERATED VALIDATION CONTRACT -->
Node: **24.19.0**. Rust: **1.98.1**. Package manager: **pnpm@11.19.0**.

| Entry point | Implementation |
| --- | --- |
| `pnpm check:migrations` | `node tools/check_migrations.mjs` |
| `pnpm check:docs` | `node tools/check_documentation.mjs && node tools/check_docs.mjs` |
| `pnpm check:observation` | `node tools/consume_operation_receipt.mjs` |
| `pnpm test:unit` | `node --test --test-concurrency=2 --test-timeout=180000 "apps/web/src/**/*.test.mjs" "tools/*.test.mjs"` |
| `pnpm test:steward` | `node --test --test-concurrency=2 --test-timeout=180000 scenarios/repo-steward/steward.test.mjs scenarios/repo-steward/actions.test.mjs scenarios/repo-steward/recurring-audit.test.mjs scenarios/repo-steward/feedback.test.mjs scenarios/repo-steward/maintenance.test.mjs scenarios/repo-steward/feedback-cli.test.mjs` |
| `pnpm check` | `node tools/run_checks.mjs --group full` |
| `pnpm test` | `node tools/run_checks.mjs --group test` |
| `pnpm test:js` | `node tools/run_checks.mjs --group node` |
| `pnpm check:fast` | `node tools/run_checks.mjs --group fast` |
| `pnpm check:preview` | `node tools/run_checks.mjs --group full --dry-run` |
| `pnpm check:docs:preview` | `node tools/check_docs.mjs --dry-run` |
| `pnpm check:docs:write` | `node tools/check_docs.mjs --write` |

Node test roots: `tools/`, `apps/web/src/`, `scenarios/repo-steward/`, `tests/readiness/`, `.github/skills/`.
Rust suite: `cargo test --workspace --locked`.

Opt-in SQLx/native probes are not passes. Use only explicitly owned fixtures; never supply a retained application database.
<!-- END GENERATED VALIDATION CONTRACT -->

## Evidence and limits

The check driver emits a unique `output/readiness/*-{group}.json` receipt with command exit
codes, durations, source HEAD, dirty state, tracked-diff digest and untracked-file digests.
It stops after the first failing check and lists the remaining checks as not run.
After initial source capture, an incomplete receipt is atomically saved before execution
and checkpointed before and after each gate. `runningCheck` distinguishes an in-flight
gate from `notRun`; completed results remain available if the process is interrupted.
Each attempt has its own receipt. Only successful final source verification can produce
`passed`; an evidence-read error yields `source_unknown`, a null
`sourceChangedDuringValidation`, and `sourceEvidenceError`, retaining counts and pending gates.
Receipt-write errors stop execution; the last published checkpoint remains incomplete.
Missing test output is unknown, never zero failures. Ignored/skipped tests are not passes.
Receipts exclude raw logs and environment values; inspect the terminal for a failing command.
The receipt is local evidence, not a signed attestation or proof of hosted CI or a browser journey.

`test.config.json` controls native Node discovery and records the ordinary Cargo command.
Cargo compiles inline and macro-generated Rust tests; source annotation counts and filename
heuristics do not measure passing tests. Platform matrix totals overlap and must not be added.
Owned database/native probes remain separately opted in; never blanket-enable ignored tests.

## Documentation drift

The blocking local/CI gate compares the generated validation block with actual package scripts,
toolchain versions and test configuration. To repair a changed contract, preview with
`pnpm check:docs:preview`, review the generated block, run `pnpm check:docs:write`, then re-check.
Only the marked derived block can change. Missing or duplicate markers fail closed; authored
prose and historical evidence remain untouched. This deterministic contract coverage does not
claim repository-wide semantic drift coverage; architectural prose still requires review.
