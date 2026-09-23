# PR #332 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate current main. Make the retained helper fail closed on a missing executable, preserve native nonzero exits, and retain actual three-case execution receipts and browser captures without changing historical helper or result bytes.

Compatible JavaScript dependency updates and a corrected saved command-capture helper. New helper regressions are separate from historical application acceptance.

The nine required commands passed on source head `ec2539cac305d715a5135c39ddbcb263f55e5767` with staged tree `f10b8765019f78a8dce84df8a17af5c1fbc48d3e`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Update the seven compatible JavaScript dependencies while retaining the native TypeScript compiler, TypeScript 6 compiler-API alias and frozen lockfile.

The current replay helper now fails when an executable cannot be launched and preserves native failure status. Actual helper/browser controls observed missing executable -> exit 1, native failure -> exit 7, and native success -> exit 0. The corrected helper, regression driver, child receipts, full logs and six genuine helper-result images are in docs/evidence/pr-332-completion-20260922-r4/. The earlier helper and all historical result bytes remain unchanged; use the corrected helper for future replay.

All nine contributor gates pass on tree f10b8765019f78a8dce84df8a17af5c1fbc48d3e, targeting current main 08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce. The new packet binds logs and saved-report capture. Historical live test-runner and application images retain their original scope and source; this correction does not claim new application acceptance.

Authorized maintainer review checked dependency compatibility, command failure handling, current-main integration and evidence provenance against ECorp contracts. Local Node 24.21.0 differs from the repository 24.19.0 pin; ignored Rust integration tests remain distinguished from executed coverage.

The supplementary completion-binding.json identifies retained artifacts, actual executed helper/native scope and original/published hashes.
