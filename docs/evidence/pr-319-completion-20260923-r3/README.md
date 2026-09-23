# PR #319 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Disable Git replacement-object lookup consistently for source identity, index inventory and clean-status checks before assigning source_commit. Retain the read-only protections against hidden index modifications, foreign Git state, dirty source and aliased Windows roots.

All nine contributor gates passed on the same staged source. The unchanged native Windows regression demonstrates that the baseline accepts modified source through both commit and tree replacement refs, while the correction rejects both. Clean controls and the complete native preflight pass; the original HEAD, index and replacement refs are preserved.

The nine required commands passed on source head `5fc94979862dc7f2d0c051e3ac4515f0c9ed5a79` with staged tree `c7addc5c7ad71a5b7928de21460175e8eebff15c`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

All nine contributor gates passed on the same staged source. The unchanged native Windows regression demonstrates that the baseline accepts modified source through both commit and tree replacement refs, while the correction rejects both. Clean controls and the complete native preflight pass; the original HEAD, index and replacement refs are preserved. This preparation/specification contribution does not close #318 retained-original reconciliation, MP1 adoption, #242 independent browser-auth review, #240 U1 runtime acceptance or #249 release obligations. No new full-stack or production identity acceptance is claimed. The baseline/candidate evidence is a retrospective regression on unchanged test bytes, not original TDD chronology.

`replacement-ref-regression.json` binds the retained original and published log hashes.

Define multiplayer development gates and an isolated, read-only Windows U1 preflight. Require the retained R1-R14/M01-M37 inventory, reviewed MP1 crosswalk and differences, and exact reviewed adoption bytes together for G0. Validate physical path and Git source identity before attesting source or creating runtime resources.

This preparation/specification contribution does not close #318 retained-original reconciliation, MP1 adoption, #242 independent browser-auth review, #240 U1 runtime acceptance or #249 release obligations. No new full-stack or production identity acceptance is claimed. The baseline/candidate evidence is a retrospective regression on unchanged test bytes, not original TDD chronology.

Local Node was 24.21.0; the repository pin is 24.19.0. Fresh hosted checks and the required eligible independent review remain necessary for the protected merge.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
