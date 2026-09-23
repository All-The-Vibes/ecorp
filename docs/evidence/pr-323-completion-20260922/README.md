# PR #323 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Merged main 08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce without rewriting collaborator history. Reconciled the validation entry point with existing repository documentation checks, steward tests, native platform/owned-fixture checks, dependency pins and Actions hardening. The security snapshot configuration is now explicitly selected from tools/gitleaks-snapshot.toml; snapshot-only exclusions do not become the default history/staged secret-scanner configuration. Historical readiness reports retain their original scope and limitations.

Maintainer integration with current main. Repository validation and security tooling changed; the nine required validation gates passed, including the native MCP unit path. The readiness CLI regression suite, real fast-group CLI invocation, and synthetic secret-detection canary passed separately on the same staged source. This packet does not claim a new readiness benchmark score, live provider acceptance, or a production/browser runtime run.

The nine required commands passed on source head `74c78857b8e0ac6536f875532176e3e4074d2319` with staged tree `48f9e29e2e65fdcacd3f1c2d879db6e87cf2d96d`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The direct readiness fast group and native CLI regression suite ran against the same tested staged tree. Gitleaks 8.30.1 was bound by SHA-256, scanned the intended snapshot configuration, and rejected the synthetic secret canary including inside evidence exclusions. These are local tooling checks; full selected-ancestry scanning is performed separately on the final publication commit.

`readiness-and-security.json` binds the retained original and published log hashes.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
