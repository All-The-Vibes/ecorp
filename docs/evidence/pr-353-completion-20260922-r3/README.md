# PR #353 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Preserve recoverable local stack state across rejected preflight and partial restart. Check ownership-record replacement before lifecycle effects, retain the old configuration if a stop fails, support SHA-256 Git IDs, and resolve saved-connection Factory refs in their native connection context. Correct provisioning to use the seed_crew query parameter and the pinned toolchain, and integrate current main.

All nine contributor gates pass on the current staged tree. The expanded synthetic Windows startup suite passes 79/79 cases after reproducing nine failures against the earlier implementation. Fresh rebuilt native server/runner startup, recovery and actual Edge browser verifier acceptance pass on the same staged tree.

The nine required commands passed on source head `53092fef0c766a70d896ac7495b69a2a16ca497c` with staged tree `ae0d9fd0d6f82b17b5ba9f6000f5332f613bf958`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The synthetic startup regressions retain the nine original failures and all 79 candidate passes, with source-file hashes and cleanup records. All 132 candidate fixture processes were stopped; the fixtures remain retained. These process fixtures are distinct from fresh native r5: rebuilt server and runner, externally provisioned PostgreSQL 17.10, actual startup and repeated start, missing-web recovery, rejected restart preservation, successful explicit restart, enrollment continuity and source HEAD/index/worktree preservation. New refs are attributed to the observed isolated runs. The genuine application captures in browser/ show persisted passing and failing verifier policies through Edge, the server and the native deterministic runner.

Node v24.21.0 was used locally; the repository pin is v24.19.0. Hosted results on the final published head cover the configured hosted environment. The deterministic fake-process provider makes no paid or real-provider inference and establishes no production identity or OS isolation. The owned PostgreSQL fixture uses SCRAM and a random password outside source and runner workspaces; PGPASSFILE delivery is private, while server/SQLx environment delivery remains explicitly reduced assurance. Credentials and raw database contents are not published.

The preservation helper retained earlier outputs but then failed an incorrect assumption that output/playwright/.gitkeep was empty. Its original CRLF newline bytes were restored and checked against the index before the native run. The failed assumption, historical derivation wording and corrected receipt are all preserved rather than rewritten. Earlier evidence packets retain their original bytes and scope.

A blanket ancestor/descendant ban on source, runner workspace and provider home is not introduced. The supported default stores runtime output below the checkout while write-capable runs execute in separate per-run Git worktrees. The existing equal-source and redirected-path checks remain. This fixture uses an explicitly separate synthetic source and does not claim new validation of every nested layout.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
