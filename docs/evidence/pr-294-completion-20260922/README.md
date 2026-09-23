# PR #294 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate current main while preserving explicit verifier cache policy, exact final-dispatch capability and epoch checks, recovery admission, invalid-policy sibling isolation, transactional grant expiry, and visible policy summaries.

All nine contributor gates passed. Twelve actual-migration PostgreSQL regressions and genuine Edge/server/native-runner acceptance passed, including explicit command/test cache policy and desktop/mobile summaries. Deterministic provider fixtures and development identity were used.

The nine required commands passed on source head `be187e5072223e3bd7dbc147293bfc18ecdac822` with staged tree `29c59aa86469db2e21880c140fc1ca119cc3276b`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The r2 source-built server and runner, their exact SHA-256 values, and the 12 passing SQLx tests were admitted again before the fresh r3 stack started. Product source was unchanged; only private browser navigation was corrected. The failed r1/r2 receipts remain retained: r1 did not select the newly API-created work item, and r2 did not open its genuine enclosing task details. R3 selected the work item and clicked the actual Task graph/task summaries. There were no DOM injections, mocked responses or direct database setup for the scenario.

The browser authored and launched an ordinary six-verifier passing mission and an artifact-floor failing mission. The supported HTTP API then created an explicit command/test cache policy; the real browser reviewed it at 1440 and 390 CSS pixels and launched it. Both native children asserted NODE_DISABLE_COMPILE_CACHE=1 and returned exit 0. Persisted evidence retained verifier_child scope, the requested environment, zero_cache_writes_verified=false and cleanup_authorized=false. The source stayed clean and each run workspace was preserved. This proves requested child configuration, not zero cache writes or permission to clean user data.

The nine retained PNGs are genuine application captures. Development principals and deterministic fake-process output are disclosed; no real-provider or production identity qualification is asserted.

Public text uses normalized local paths and separate original/published SHA-256 values. Credential files and database/workspace contents are preserved locally and excluded. The current packet does not change previous evidence.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
