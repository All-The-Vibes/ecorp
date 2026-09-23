# PR #338 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrated current main without rewriting collaborator history. Retained the five optional-object receipt regressions and the original controlled Rust 1.94 diagnostic, including its expected baseline failure.

Current-main integration of the behavior-preserving Rust 1.94 strict-Clippy predicate fix. All nine source-bound checks were freshly executed. The earlier source-matching MSRV diagnostic is retained; no application-runtime acceptance is claimed for this predicate-only change.

The nine required commands passed on source head `aca8c3bf66b8790e91e9d24b501e90e3fa3fb5dd` with staged tree `b74739a6d8e0b855853415fb80adecefa8b6e4d8`, incorporating main `de12261d045ddfccf790bcfd04a7fa254563d456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

`prior-msrv-source-binding.json` confirms that all native build inputs and the exact receipt source bytes match the retained Rust 1.94 diagnostic in the preceding r2 packet. Its logs remain unchanged. Current-main web changes are covered by the fresh nine-command pass; no new production/runtime claim is made.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
