# PR #305 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Merged current main without changing production or tool code. Preserve the 64 KiB aggregate dependency and resume prompt limits enforced before secrets or dispatch, verified research-file handoff, and explicit non-qualification of OS parent-tree isolation.

All nine contributor gates passed for the current-main documentation integration. Prior native and browser/server/runner receipts remain bound to identical production and tool bytes, retaining their original dates and limitations.

The nine required commands passed on source head `0a712d718fb2ae777a954c9646c7641732ff1dc2` with staged tree `637cbf116d7376e77c88591cb493a663ba1c4a12`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

`integration-binding.json` hashes the retained native and browser receipts and records the unchanged production/tool comparison. No fresh native or browser replay is claimed. Parent-tree-isolation remains unqualified; the retained native result stays `accepted: false`. This does not close #297 or #51 or claim production, full TF01/R4 or owner acceptance. Local Node was 24.21.0; the repository pin remains 24.19.0.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
