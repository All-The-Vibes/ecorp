# PR #319 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Before source attestation, isolate system/global Git configuration and attributes, reject repository/included filters and info/attributes overrides, and reject inherited GIT_ATTR selection. Read-only Git commands restore the caller environment and suppress optional index writes. The regression exercises actual local, included, explicit-global and default-global clean filters; each formerly executed and hid changed bytes, while the candidate blocks attestation without executing the filter and preserves source, index, configuration and environment.

All nine contributor gates passed. The native Windows preflight suite reproduced the clean-filter finding against the prior source, then passed on the candidate with the same test bytes. This is retrospective regression evidence, not original TDD chronology or multiplayer browser/runtime acceptance.

The nine required commands passed on source head `288e273f5686e02e261446222794b08652f1dbf5` with staged tree `e80a40cf6260b11904b9583ed00dc345c9ef47ca`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

All nine contributor gates passed. The native Windows preflight suite reproduced the clean-filter finding against the prior source, then passed on the candidate with the same test bytes. This is retrospective regression evidence, not original TDD chronology or multiplayer browser/runtime acceptance.

`native-clean-filters.json` binds the retained original and published log hashes.

Issue #318 remains open; this preflight correction does not adopt the proposed MP1 contract or establish U1 runtime acceptance. Local Node was 24.21.0; the repository pin remains 24.19.0.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
