# PR #304 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Use a constant diagnostic for malformed JSON from command input or the saved journal. Retain the existing state, malformed journal and lock ownership without printing input bytes.

All nine contributor checks and both focused JSON-diagnostic regressions passed on the same staged source. The earlier complete executor suite remains historical evidence; a new complete dedicated executor-suite run is not claimed.

The nine required commands passed on source head `cde7b8e6c5a4df6644a244a6d4a55bfc0d45553b` with staged tree `4e1d4fd48aaf37b3e845eab1151475e2699875c6`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The retained retrospective baseline fails both sentinel controls. Both current-source regressions pass, covering malformed stdin with and without an existing journal and malformed saved journals. No original TDD chronology is claimed.

`json-diagnostics.json` binds the retained original and published log hashes.

This is local review-tooling validation, not product or provider acceptance. Candidate skill content has not been activated as instructions for this completion pass. Local Node was 24.21.0; the repository pin is unchanged. The rendered image records saved test results. Independent eligible latest-push/CODEOWNER approval and hosted checks remain separate merge requirements.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
