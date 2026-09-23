# PR #324 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate the current security transport and scanner changes, preserving the Windows short-alias fix, native exporter parity, source read-only behavior, and contributor history.

All nine contributor gates passed after integrating current main and the reviewed scanner change in PR #341. The current Node lane passed 1,372 tests with no failures; 10 platform-dependent tests were explicitly skipped. Historical native exporter, browser, and retrospective short-alias evidence retains its original scope and dates.

The nine required commands passed on source head `94d18d518fb1bb05060bf3fb85ab9d1f4599909a` with staged tree `de532015d7bb28f7cd06aff55cf6c50448d05bb8`, with target main observed as `33e4e47a9dea589a8165c19d9a5ff3d493b85c50` (ancestry is recorded separately). `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Current main is an ancestor of the integrated PR #341 head. `integration-binding.json` records those exact commits, the current source delta, and the unchanged checker files and prior evidence. The prior 52-case corrected short-alias suite follows a retained three-failure native baseline. This packet adds fresh integrated contributor validation; it does not claim a new browser acceptance.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.

PR #341 subsequently merged as `ed24c0ecb37276869df1b6a407e90d3bda830ec3`. Its tree is byte-identical to the tested dependency head, so advancing the pending merge parent introduces no source change. The nine-gate test tree and original execution records remain unchanged.
