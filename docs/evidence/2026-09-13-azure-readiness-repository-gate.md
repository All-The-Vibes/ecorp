# Azure readiness contribution: full repository gate

Date: September 13, 2026. Source base: `b2523964e7576cafc00e84a51e1044f55826dea7`.
Branch: `codex/azure-production-readiness`; Entra discovery changes remained uncommitted during validation.

## Scope

This follows the [isolated discovery regression/fix](2026-09-13-oidc-discovery-issuer-path.md). It records the full repository gate against that contribution, not a production deployment or real Entra sign-in.

Toolchain: Windows ARM64, Node 24.19.0, pnpm 11.19.0, cargo 1.98.1, rustc 1.98.1. Rust build artifacts remained in the contribution's own `target` directory with two compilation jobs. No dependency manifest or lockfile changed.

## Commands and results

| Check | Actual command | Result |
| --- | --- | --- |
| Migration integrity | `node tools/check_migrations.mjs` | Exit 0; 41 migrations, latest 41, immutable checksums true |
| Rust formatting | `cargo fmt --check` | Exit 0 |
| Workspace/all-target lint | `cargo clippy --offline --locked --workspace --all-targets -- -D warnings` | Exit 0; completed in 3m 39s |
| Workspace tests | `cargo test --offline --locked --workspace --quiet` | Exit 0; 554 passed, 0 failed, 323 ignored |
| Web build | `pnpm build:web` | Exit 0; TypeScript and Vite build passed |
| Web lint | `pnpm lint:web` | Exit 0 |
| Diff whitespace | `git diff --check` | Exit 0 |

Before the web checks, `pnpm install --frozen-lockfile` reused 27 packages and downloaded none. Rust dependency resolution was offline and locked. Test execution used the normal default concurrency; it was not replaced by a serial-only run. `DATABASE_URL`, `CRONY_ACCESS_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` were removed from the workspace-test process environment. Ignored opt-in tests were not activated.

Nonempty test-suite summaries (passed / failed / ignored):

```text
116 / 0 / 0
 16 / 0 / 0
  6 / 0 / 0
  2 / 0 / 0
  2 / 0 / 0
 10 / 0 / 0
213 / 0 / 1    runner
128 / 0 / 4    server
 61 / 0 / 318  store
--------------------
554 / 0 / 323  total
```

Zero-test binary/doc-test targets also exited successfully.

## Preservation checks

The configured source checkout remained clean at `971445e1cbf9388c51803e2adf28b11bd98b1ffa`. The retained API continued to report `status: ok`, development mode, and one connected runner. Its recorded server, runner, and web process IDs were unchanged. Existing runner credentials, the retained database, source selection, factory history, and budget authority were not changed.

## Limits

- This is a local repository gate on the stated toolchain, not an MSRV or cross-platform matrix result.
- The 323 ignored tests are not passes; opt-in database, provider, and platform qualifications remain separate.
- Real Entra browser sign-in, production principal provisioning, private deployment, backup/restore, and browser/server/runner/provider acceptance have not been established by this run.
- #241 reports separate immutable-principal-link groundwork; the baseline's development-only link endpoint must not be promoted to production or used to bypass that reviewed work.
- #242 remains behind its existing browser-auth review gate. #248's storage and lifecycle work retains its own integration/acceptance requirements.
- No Azure resources, providers, app registrations, tenant roles, or consent grants were created or modified. No GitHub write, commit, push, merge, or deployment occurred.

Local, Git-ignored planning files contain the tenant-specific sign-in preview and subscription context. They are not part of a public review payload. This report does not close #241, #242, or #248.
