# PR #358 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Revalidate runner dispatch outcomes under the Corp, run/runner and command locks; bind identity, command kind and payload to active lifecycle and hard budget policy; retire obsolete commands idempotently. Complete the actual SQLx fixture TaskContract without weakening regression assertions and integrate current main.

Nine contributor gates, 21 store and two server PostgreSQL regressions, three concurrent-child aggregate budget scenarios, and an actual Edge-to-server-to-native-runner verifier-policy run passed. These are explicitly owned deterministic fixtures, not production-provider acceptance.

The nine required commands passed on source head `aa66c2ec14df9210a6576f2a709515e5f081c08f` with staged tree `cd19528739717712dc275495b2c8490f718a1dc7`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The owned PostgreSQL lane executed all 21 issue56 store tests and both issue56 server tests, including tests marked ignored in ordinary cargo test output. The first native attempt exposed an incomplete server fixture TaskContract and failed two assertions before exercising the intended path. That failed receipt/log is retained. The fixture now serializes and deserializes the complete contract; the intended lifecycle and payload assertions remain unchanged and both tests pass.

Three actual concurrent-child runs exercised mission, requester rolling-24h and Corp rolling-24h aggregate budgets. Each started three children; respectively two, two and three were fenced. Late artifact and completion submissions were rejected. The final aggregate database, source and run workspaces remain preserved locally. The subsequent generic verifier-policy lane used that same owned stack after all aggregate runs terminated and its fixture budget was explicitly raised; it is not counted as another aggregate scenario.

`browser/` contains genuine ECorp application captures from the Edge-to-server-to-native-runner policy lane. `validation.png` is only the saved command-report capture. Reproduce aggregate and SQLx lanes with fresh owned PostgreSQL and the retained drivers, matching the recorded source and executable hashes. Deterministic fixtures do not establish production identity or paid-provider acceptance.

`source-binding.json` binds every retained original/public artifact hash and the changed current-source blobs. Historical receipts are preserved. Full native stack cleanup verified exact owned process identities; retained databases, credentials and workspaces are not published in this packet.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
