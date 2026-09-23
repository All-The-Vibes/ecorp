# PR #293 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Retain the six Base V2 review corrections and 17-step local native qualification; classify only individually verified public receipt hashes, idempotency identifiers and literal fixture handles with exact commit/path/rule/line scanner fingerprints.

All nine contributor gates and both branch-specific commands passed after the exact-fingerprint scanner metadata update. The prior complete native acceptance, database regressions and exact product receipts remain unchanged and are hash-bound here.

The nine required commands passed on source head `dc67b3ce8e8eeb6e46e65da3b6207ef2e240d51d` with staged tree `c2b657dc8d9a543b797aff1fd279982642829a85`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

This final metadata change adds 35 exact scanner fingerprints. Three history findings were literal fixture handles. The explicit first-parent merge patch covered 548 changed files, including all 105 prior packet files, and its 32 findings were independently classified. No broad path, rule, expression or value exclusion was added. Initial non-passing scan counts and the complete per-finding classification are retained under `secret-scan/`. The passing final commit scan is run separately after this packet is committed, and is not invented inside this pre-commit packet.

`source-binding.json` hashes all 105 unchanged files of the prior r1 packet and proves that the final product/test/tool source remains that of the native qualification. This new run changes only scanner metadata and adds evidence. The previous 17-step browser/server/runner and local-chain native acceptance remains at its original execution date; no new full native run is claimed. Its exact JSON, CRLF restart receipts and three product screenshots have not been regenerated or normalized.

The additional commands `node tools/check_state_audit_compatibility.mjs` and `cargo test --locked -p crony-audit --test ethereum_local_chain` both passed on the same final metadata tree. Their command receipts and logs are in `additional/`. The Ethereum test is an in-memory revm lane, separate from the recorded Anvil qualification.

Local qualification uses developmental identity/runner actors, a memory signer, a local GitHub/fee-oracle fixture and two RPC endpoints backed by one Anvil instance. It does not qualify public Base, production identity, real GitHub, external KMS or independent provider infrastructure. Full qualification used loopback trust authentication, explicitly reduced assurance. Factory remains disabled. Windows Node was 24.21.0 while the repository pin remains 24.19.0. The earlier worker/database receipt has its explicitly documented six-file source delta; it is not described as a whole-tree-identical rerun.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
