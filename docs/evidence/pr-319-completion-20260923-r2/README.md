# PR #319 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Reject assume-unchanged, skip-worktree and malformed Git index records through a read-only NUL-delimited inventory before source attestation. Require an exact 40- or 64-character source revision and assign source_commit only after every source check passes.

All nine contributor gates and the native Windows preflight passed on the same staged source. Actual hidden tracked modifications under both Git index flags were rejected; restored clean source, distinct 8.3 aliases, volume aliases, foreign Git state and dirty-source controls passed.

The nine required commands passed on source head `c589ced5650e7dc9c852af95497db1d95bf4b718` with staged tree `e74b8674fb479d9c7a54365ff4ceef4b05a1c785`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The retrospective baseline actually accepted modified files hidden under both assume-unchanged and skip-worktree and failed the regression assertion. The corrected source rejects both before populating source_commit. The final complete native preflight passes. Baseline and final test-source hashes are recorded separately because the final harness also reflects the stricter no-attestation behavior for ordinary dirty source; no unchanged whole-test identity or original TDD chronology is claimed.

`focused-validation.json` binds the retained original and published log hashes.

Define multiplayer development gates and provide a read-only Windows U1 fixture preflight. Require the retained source-bound R1-R14/M01-M37 inventory, reviewed MP1 crosswalk and differences, and exact reviewed adoption bytes together for G0. Validate Windows path components, physical drive identity, reparse ancestors, protected roots, source identity, ports and prerequisites without creating runtime resources. Required native alias mode remains the default; hosted CI reports unavailable native coverage explicitly.

This preparation/specification contribution does not close #318 retained-original reconciliation, MP1 contract adoption, #242 independent browser-auth review, #240 U1 runtime acceptance or #249 release obligations. No new full-stack, production sign-in or physical-device acceptance is claimed.

Local Node was 24.21.0; the repository pin is 24.19.0. Hosted final-commit checks and independent eligible review remain required for the protected merge.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
