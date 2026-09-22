# PR #341 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate current main without rewriting contributor history. Preserve selected-head confidentiality, complete-history checks, native failure semantics and workflow-identity isolation.

All nine current-main contributor gates passed. Scanner source and native fixture code are byte-identical to the previously reviewed head; the separate 66-case native acceptance is retained in the r4 packet under its original execution scope, and was not rerun for this integration.

The nine required commands passed on source head `0c54fd8fe417e9c0f699398492a90993098391dc` with staged tree `1d4ed99e48f19109ad08a2f53646ff731ae5d9f6`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The scanner workflow, metadata tests and native fixtures are byte-identical to reviewed head `14556ed8d661686b7073f8cc18753589f41f28b2`; `scanner-source-binding.json` records canonical Git hashes and current checkout hashes. The earlier 66-case native acceptance (including nine real native histories) and retrospective RED remain in the r4 packet under their original source scope. The current nine-gate run is fresh; those native fixtures were not rerun for this integration. Local Node 24.21.0 differs from the repository pin 24.19.0. No UI, provider or production acceptance is inferred.
