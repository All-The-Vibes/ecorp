# PR #226 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrated main 5f65e536; normalized personal user paths in 29 historical text records with original and published hashes; preserved all 12 capture images and 287 other evidence files; aligned the canary test subprocess with Windows hidden-window behavior.

Current-main validation of the bounded nonclosing Factory canary byte-preservation repair. Issue 225 native Factory acceptance remains separate and open.

The nine required commands passed on source head `756c989db4c910c0affafacd392adceefbd38952` with staged tree `86c3104f2dc3bd65a519201d860561e1eddfecd8`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Retry provenance: Initial matching-source Rust checks passed. The private validation helper then requested a nonexistent Cargo package, crony-mcp. The correct package is crony-gateways with binary crony-mcp. The initial checks are retained byte-for-byte; the auxiliary binary is rebuilt from the unchanged source after refreshing workspace artifacts, then the four remaining checks run.

The first failed receipt and failed-command logs are preserved under `prior-attempts/`; normalization and separate original/published hashes are recorded in `validation.json`. Successful command logs were retained byte-for-byte before publication normalization.

The two Factory canary suites passed all 10 focused tests after the Windows subprocess option change. This verifies the bounded byte repair and does not establish issue 225 native Factory acceptance.

`canary-regression.json` binds the retained original and published log hashes.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.

The path-normalization receipt retains CRLF bytes under the historical packet byte-preservation attribute. Final whitespace verification recognizes CR-at-EOL through process-only Git configuration while still checking trailing spaces, blank EOF lines and space-before-tab.
