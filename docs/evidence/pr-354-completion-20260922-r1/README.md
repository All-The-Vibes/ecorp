# PR #354 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate current main and validate the explicit distinction between a valid factory plan and dispatch readiness. Execution intent rejects an unavailable immutable source before claims or dispatch.

Nine contributor checks, owned PostgreSQL issue256 regressions, real HTTP readiness/authorization checks, and actual browser-to-server-to-runner verification-policy acceptance pass. Deterministic native fixtures are used; no vendor inference or external publication is claimed.

The nine required commands passed on source head `c00889313fe48267070747c609937e9c83d93337` with staged tree `a297fa835f365102d921be44eb5538f9662b4613`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Retry provenance: Initial matching-source Rust checks passed. The private validation helper then requested a nonexistent Cargo package, crony-mcp. The correct package is crony-gateways with binary crony-mcp. The initial checks are retained byte-for-byte; the auxiliary binary is rebuilt from the unchanged source after refreshing workspace artifacts, then the four remaining checks run.

The first failed receipt and failed-command logs are preserved under `prior-attempts/`; normalization and separate original/published hashes are recorded in `validation.json`. Successful command logs were retained byte-for-byte before publication normalization.

The new owned fixture proves HTTP 200 plus not_ready for a valid plan with a missing immutable source, HTTP 409 for execution intent before claim or dispatch, HTTP 200 plus ready with the matching native runner, and HTTP 403 for the observer. Hashes of eight ledger tables remain identical throughout the read-only checks. Crew fixture setup precedes both measurements. Native issue256 SQLx regressions run on an owned PostgreSQL server.

The separate real Edge browser flow saves verifier policies, launches deterministic native runs, observes one accepted completion and one verifier-rejected completion, and captures desktop/mobile application screens. This supplements readiness HTTP acceptance; it does not claim that plan syntax validation itself launches work. The source tree and native binaries are bound in source-binding.json and native-lifecycle.json. PostgreSQL, source, workspaces, credentials and logs were preserved after stopping only owned processes.

Reproduce from the recorded source using the retained reproduce-native.ps1 with a new owned QA root and the retained reproduce-readiness.mjs. Its original supervisor is tools/qa_factory_run_activity.ps1, and the browser entrypoint is tools/e2e_verification_policy_browser.mjs. Build the exact server and runner first; run cargo test -p crony-server issue256_ -- --ignored --test-threads=1 against the isolated PostgreSQL server. Replace local path placeholders with explicit owned directories. External providers and publication remain disabled.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
