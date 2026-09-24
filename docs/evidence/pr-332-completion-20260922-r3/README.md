# PR #332 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrated current main de12261d045ddfccf790bcfd04a7fa254563d456 without rewriting collaborator history. Revalidated all nine contributor gates and preserved prior review corrections and evidence bytes.

Fresh nine-command validation after current-main integration. Earlier acceptance evidence is retained with explicit original source identities; the new image is a saved-results report.

The nine required commands passed on source head `b8c62233cd0b4cde530e0322867e5665222cf953` with staged tree `20910a40ec596f3f41312640bf0a4a7cbcf09f7e`, incorporating main `de12261d045ddfccf790bcfd04a7fa254563d456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

All eighteen original live test-runner images, child-process receipts and the complete reconstructed browser setup recipe remain unchanged. The six older application captures retain their original source binding. This integration has fresh command logs and a saved-report image; it does not claim new live test-runner captures or new application acceptance.

acceptance-binding.json records every non-evidence path changed since the previous tested tree and hashes every file in the retained packet. Native build and dependency inputs are unchanged between those trees. The current-main web change is covered by the fresh web, Node and Rust checks; earlier application acceptance retains its historical scope.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
