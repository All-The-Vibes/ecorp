# PR #358 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Keep exact Corp, run, runner, command ID, kind and payload validation under ordered locks. Permit only durable rejected or expired approval cleanup to reach its matching runner after terminal or budget fencing; positive commands retain the fences. This fixes the hosted expired-approval ACK failure without fabricating acknowledgements or reviving work.

All nine contributor gates, 23 store and two server PostgreSQL tests, three aggregate-budget scenarios, actual approval/rejection/expiry with runner ACK, and genuine Edge/server/native-runner policy acceptance passed. The server-restart option was explicitly skipped and no restart recovery is claimed.

The nine required commands passed on source head `8160f5e02ee6d32df06d56bca4bb73b41a0ae4c0` with staged tree `a0b065028f4acc50b36a074e86946edc6ebd0273`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Hosted integration run 35785747239/job 106942001555 failed at the expired-approval runner-ACK assertion. The previous local packet remains unchanged; the newly retained hosted failure explains why this correction was needed. The ordinary aggregate guard had retired negative cleanup after expiry cancelled the run. The new exception admits a boolean false approval_decision only when its exact durable approval is rejected or expired and all ID, Corp, run, runner, kind and payload checks still match. It cannot authorize positive effects, revive a run, or write an ACK on the runner's behalf.

The actual PostgreSQL suite now executes 23 store and two server issue56 tests. New regressions cover disconnected expiry, pending-until-actual-ACK delivery, replay, scope/status/identity mismatches, positive decisions, string false and missing booleans. Three actual aggregate scenarios still reject late artifacts and completions. The checked-in e2e_approvals driver then passes positive approval, duplicate-effect suppression, rejection, expiry, and actual runner ACK. CRONY_SKIP_SERVER_RESTART=1 was explicit: this packet does not claim restart recovery. The subsequent browser policy lane passes on the same owned stack and source.

The six browser PNGs show the actual ECorp application. Deterministic provider fixtures and development principals do not establish production provider/identity acceptance.

Public text uses normalized local paths and separate original/published SHA-256 values. Credential files and database/workspace contents are preserved locally and excluded. The current packet does not change previous evidence.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
