# PR #283 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Validate the fixture credential header without logging certificate/key data. Reject a missing checkpoint signing key when any retained key history exists. Defer failed transport construction and postpone an empty checkpoint for sixty seconds so other ledgers can progress. Preserve migration history and collaborator commits.

Nine contributor gates plus canonical-format compatibility and the in-process EVM contract checks passed. All 48 native PostgreSQL regressions (10 server, 38 store), real-binary startup assertions, a real native GitHub-SHA TLS test, and the Edge/server/runner audit acceptance passed on the identical source tree. No live chain, live GitHub publication, production identity, or live Azure acceptance is claimed.

The nine required commands passed on source head `63fc5edb8350aedd865b50d588bf70b41f154326` with staged tree `ef84c5fbaabc1afd00faab784ce3f5fca7f15933`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Implement the V1 state-audit foundation for covered mission governance: canonical hash-linked decisions, retained signing-key history, signed checkpoints, offline verification, and governed GitHub/EVM publication. Canonical Factory replay uses immutable aliases; checkpoint discovery and bounded publication make progress independently. Refs #281.

The browser acceptance saves a mission, verifies accepted and refused governance replay, denies non-owner coverage, completes the original run through its artifact verifier, exports three audit rows, verifies their checkpoint using the independently retained public key, rejects an unrelated key, and proves the configured source checkout is unchanged. Actual application screenshots are in browser/. Private keys, credentials, and ownership credentials are excluded. Native fixture secrets delivered only through environment variables have reduced assurance. Existing applied migrations and earlier failed evidence remain unchanged; the independent migration allocations in other open PRs require coordinated integration. Historical canonical replay limitations remain documented in the prior packets.

Windows x64, Node 24.21.0 (repository pin 24.19.0), pnpm 11.19.0 and Rust 1.98.1 were used. Report images are Edge captures of actual saved results. Existing historical evidence retains its original scope and source. The source here incorporates the main commit recorded in validation.json; subsequent main integration and hosted CI/security checks remain necessary before merge. Maintainer self-review is distinct from an independent review.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
