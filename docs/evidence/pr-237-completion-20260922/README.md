# PR #237 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Retain non-authorizing provisional launch evidence and the exact child handle through identity and manifest publication, roll back handled launch failures with verified cleanup, preserve timeout stdout/stderr, reserve PostgreSQL port 5432, and integrate current main without losing CI/security or safe database environment handling.

Nine contributor gates, four new current-source native recovery/adapter scenarios, and an actual Edge-to-server-to-native-runner verifier-policy run passed. Deterministic adapter fixtures do not establish real-provider or production-identity acceptance.

The nine required commands passed on source head `0a2eed4c8f1486f051c99b2fd2a440978c86e714` with staged tree `2f3b7774e249da21d9393e35b0cd8c1b2d07a2a8`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Four new explicitly owned native scenarios ran on the same staged source as all nine gates: Windows external adapters, bounded recovery, revised-budget hard stop, and missing-checkpoint recovery. Each command exited zero and retained its source/executable/command/runtime and cleanup records. Deterministic protocol fixtures were used; no real provider account was exercised.

The scenario `.running.png` captures were taken in Edge while each recorded command child was alive, and `.completed.png` after its exit. These are live browser views of that child's command log, not application UI. `browser/` separately contains actual ECorp application captures from the complete native stack. Earlier report-summary graphics remain historical report graphics; any earlier “actual local-log capture” wording must not be read as a runtime application screenshot or an original run capture. No missing historical screenshot was recreated.

The retained controlled baseline failures reproduce launch-publication and command-timeout defects against d0f6711c37ba7758884d52770c70d076aafd0a51. The earlier focused correction run passed 71 tests. The current full unit gate reruns the applicable regressions on the bound current-main source. These are retrospective checks, not original TDD history. Earlier failed native attempts and their failed-command logs remain under prior-attempts/; the successful r8 records are new, not relabeled historical records.

Reproduce with the repository commands captured in native-scenarios.json, fresh owned output paths, the recorded native binaries/toolchain and isolated PostgreSQL. The retained drivers show the actual orchestration; adapt machine paths without publishing credentials. Issue #50/#236 and production identity/provider acceptance are not claimed complete by these fixtures.

`source-binding.json` binds every retained original/public artifact hash and the changed current-source blobs. Historical receipts are preserved. Full native stack cleanup verified exact owned process identities; retained databases, credentials and workspaces are not published in this packet.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
