# PR #255 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate current main while preserving its pinned actions, credential restrictions, validation lanes and this contribution's authority regressions. Complete the bounded native acceptance and replace the unresolved historical web-input mapping with a fresh exact-source full-web run. Preserve historical receipts, original migration 0042, and the retained helper patch.

Current-main integration: nine contributor gates, six real PostgreSQL store cases, four real-handler cases, two APIs and two native runners, independent-ledger rejection, controller preview/race, API reconnect and credential rotation, runner handoff, actual desktop/mobile authority UI, and browser-authored verified mission with independent artifact download hashes. Same-host development identity and deterministic providers; partial, non-closing issue 161 scope.

The nine required commands passed on source head `4bb17b5e9191d48f571ba6de15738dcc1cf55855` with staged tree `96e4da4451f9aecd6a0978bc85e93bcbd1126bca`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

## Current native acceptance

The fresh r4 native run and the nine gates both tested `96e4da4451f9aecd6a0978bc85e93bcbd1126bca`. Six store and four server PostgreSQL cases passed with zero ignored cases in those selected lanes. Native acceptance used two APIs, two enrolled Rust runners, deterministic providers and development principals on one Windows host. It verified independent-ledger rejection, controller preview and competing claims, reconnect after an API restart with the same run/mission and rotated credentials, then runner B completion with runner A stopped. Both runners produced verifiable artifacts.

The actual Edge UI displayed the same authority fields at 1440px desktop and 390px mobile widths. A user action through the App created mission `ba4c366d-1d1d-412a-9be5-41bde3309863` and run `e210296a-2cc6-4910-9921-7d9b7dc6a84e`; its authored artifact and file verifier checks passed. Independently downloaded artifact bytes matched the recorded hashes. Six genuine product captures are under `browser/`; `validation.png` remains explicitly a saved-test-report capture. Native IDs, download hashes, binary hashes and exact executed driver hashes are retained.

`source-binding.json` separately records canonical Git-blob and executed checkout hashes, including `apps/web/src/App.tsx`. The new full build/lint results are bound to the current source; this does not reinterpret the unresolved old App digest or rewrite any historical receipt. The `source_commit` inside the browser/reconnect report is the small fixture repository supplied to the agent, not the App/native binary source; the latter is the staged tree above.

## Dependency and migration handoff

The exact minimal #237 composition was base `b31a38a62330aacba80c3953142e1da957a63ecd`, its Git bytes for `tools/owned_test_stack.mjs`, and the unchanged `tools/issue161/pr237-native-time.patch` applied with LF/no BOM. Only that helper is dirty in its isolated dependency checkout. The result SHA-256 is `6d0bc7975f68c578a77ac3ebf54b7ee64e99871cfe964d5b9bf6afa2dd58cb1e`. The reconstruction script, exact reconstructed helper and separately hashed derivation are retained. No `aa0d…` historical helper identity is claimed and `qa-finish-evidence.mjs` was not used in this acceptance. The original unified-diff blank context is preserved; no broad source-whitespace exclusion was added.

Current main ends at migration 0041. This PR preserves `0042_factory_claim_authority.sql` and its checksum. Unmerged #283 also currently allocates 0042 and must append/renumber its unapplied migrations when integrating after this PR. Neither PR's already-applied migrations may be rewritten. The collision does not require #283 to land first, and this packet does not claim the follow-up has already occurred.

## Reproduction and limits

Use a fresh Windows review checkout with repository-pinned Node 24.19.0/pnpm 11.19.0, Rust, PostgreSQL 17.10, PowerShell 7.4+, Python 3.12, Playwright and Edge. The recorded run used Node **24.21.0**, Rust 1.98.1 and PostgreSQL 17.10; local Node therefore differed from the repository pin. Install dependencies with `pnpm install --frozen-lockfile` and run the nine named commands in `validation.json` against the exact staged candidate, recording a fresh raw receipt with `staged_tree`, the nine exit codes and each log's `sha256`.

The exact executed `drivers/run-pr255-native-r4.ps1` is retained as provenance, with its adjacent `prepare-pr255-dependency-r1.py` and the `qa-*.mjs`/`qa-host.ps1` files. It performs the first native build, helper reconstruction, private SCRAM fixture initialization, SQLx tests, all acceptance actions and identity-checked cleanup; it does not require an earlier reuse receipt. Its defaults are the recorded host's paths. For a different host, copy the driver outside this evidence packet and map its Node/Python/Playwright constants and explicit Repository, Target, PgBin, QaRoot, ValidationPath, DriverDirectory and EvidenceRoot parameters to that host. Use a never-used `issue-161-*` fixture under a sibling `qa` directory and a fresh Label. Pass the **fresh raw** gate receipt: the historical driver expects `checks[].sha256`, not the published normalized receipt's `published_log_sha256`. When testing the published evidence-only addition, also pass `-EvidencePacket docs/evidence/pr-255-completion-20260922-r1`. Fetch the pinned helper commit if absent before its detached-worktree reconstruction. Preserve all prior resources and receipts.

Server/SQLx database delivery is environment-only and explicitly reduced assurance; browser/runner children exclude the database credential. ACL-restricted fixture data remains private. Cleanup stopped only receipt-owned APIs and processes; workspaces, databases and evidence remain intact. This is a complete handoff for the bounded partial #161 contribution, with no physical multi-host, production identity/provider, copied-ledger distributed locking or full issue closure claim.

Maintainer self-review covered tenant/Corp scope, immutable authority pinning, controller admission before persistence, current-main planning-cost checks, one authoritative ledger, API-independent runner lifetime, verified completion and owned cleanup. The scope is now submitted as merge-ready under the maintainer's authorization, subject to ordinary hosted CI and independent protected review.
