# PR #324 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate current main without rewriting collaborator history. The sole non-evidence delta since r5 is main retained-provider upload-binding validation and its tests; deliverable checker/exporter inputs remain unchanged.

Nine fresh contributor gates after integration of current main. Prior checker/exporter and browser acceptance stays bound to its original tested source; no native stack rerun is claimed.

The nine required commands passed on source head `ebfb4fc5d2491b178a2b147f0c85b4114667ef06` with staged tree `d78c15fd573db529d7ff2b187512752c20f67934`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The new source delta is exactly crates/crony-store/src/retained_provider_receipt.rs from current main. It preserves malformed-upload rejection while using the supported Option predicate and adds boundary/shape regressions. The current Rust gates execute these regressions. All deliverable exporter/checker code, tracing-parity tests, dependencies and relevant helper inputs are unchanged. The earlier native evidence is retained with its original source identity, not represented as a fresh full-stack run.

Node v24.21.0 was used locally; the repository pin is v24.19.0. Hosted checks on the published head remain authoritative for the pinned environment. The validation image is a saved-results report. Ignored tests are not counted as executed acceptance.
