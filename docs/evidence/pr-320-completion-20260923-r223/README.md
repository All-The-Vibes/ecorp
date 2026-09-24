# PR #320 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Require TLS for delegated assignments outside literal IP loopback; make cancellation report only a persisted same-actor/Corp transition; resolve and compare physical QA-root boundaries before effects and ownership reads; stop PostgreSQL through the retained exact-process handle.

Nine contributor gates, 11 actual PostgreSQL delegated authorization tests, 11 native runner transport tests and 14 owned Keycloak browser/server/runner acceptance checks passed on the same final source tree. The node-unit gate includes physical QA-root and lifecycle regressions.

The nine required commands passed on source head `f2171dcba68f5572a6a0443cb437244fb250672a` with staged tree `598a6edf5af2848da248b040b9e169d3a164fbd3`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Automated synthetic Keycloak 26.7.4 acceptance with development principals and an owned local PostgreSQL database. Live Azure/Entra and production identity acceptance were NOT_EXECUTED; operating-system isolation is not established, and broader issue #285 remains open. SQLx environment-only credential delivery is explicitly reduced assurance. Local Node was 24.21.0; the repository pin remains 24.19.0.

All three successful execution lanes share the same tested Git tree. `source-binding.json` binds the implementation/test files, native binary receipts, logs and exact product captures. Prior startup acceptance and failed attempts remain unchanged in the previous packet with their original dates; no fresh startup-negative run is claimed.

The database lane executes `cargo test --locked -p crony-server delegated:: -- --ignored --test-threads=1 --nocapture` against newly owned PostgreSQL. The transport lane executes `cargo test --locked -p crony-runner adapter::delegated::tests -- --nocapture`. The contributor node-unit gate includes `tools/delegated_qa_root.test.mjs` and lifecycle regressions. For full-stack replay, use `tools/qa_delegated.ps1` with fresh owned QA roots/ports and explicit runtime paths, then `node --test tools/e2e_delegated.mjs` under its ownership contract. The path-normalized recorded supervisors preserve the exact commands and limits; do not point them at retained shared state.

Cancellation regressions include all terminal/released/expired outcomes, repeated cancellation, cross-actor scope and a release winning while cancellation waits for the row. Transport rejection is checked before HTTP or a Started event. Native path regressions exercise junction ancestors, short names, substituted drives, file ancestors and exact PostgreSQL process identity. The final full-stack run verified private preview, explicit release, persisted verifier completion, callback replay rejection, expiry and delayed-browser cancellation. All owned processes were stopped; original fixtures remain preserved.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
