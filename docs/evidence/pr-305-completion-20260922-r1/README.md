# PR #305 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrate current main; enforce the complete dependency prompt byte bound; normalize repository namespaces while preserving exact ref/commit identity; correct desktop/mobile navigation and synthesis evidence selection; retain full-stack launch, native verification and independently hashed artifact download evidence.

Nine contributor gates and actual Edge-to-API-to-native-runner deterministic research handoff. The original native adversarial fixture retains 22 observed rejection/control cases and one unqualified parent-tree isolation case. This is a bounded, non-closing contribution to issue 297; issue 51 isolation and full TF01/production provider acceptance remain open.

The nine required commands passed on source head `155dc9cc4df91f2d9a5372de0c2cc9446c58c89c` with staged tree `1100bb8329b761269271402ed9a23dca56985c9b`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

## Actual browser and native scope

The fresh r6 Edge run exercised mission `c966fe81-41b0-40d9-9186-cdb626690ef9` through one real App launch, two parallel specialist runs, and the dependent synthesis run `2f7d6111-6877-4564-a0ca-2ccc83ede789`. Both parents completed before synthesis; the three runs used distinct preserved worktrees. Signed authorized source downloads supplied the actual declared note/probe bytes. The UI explicitly selected the synthesis task and displayed its accepted verifier evidence. Its downloaded artifact matched SHA-256 `288b3afa12f493adeccfbf81527291df3360041f89a8229b11f58fc2f764ae76`. `browser/browser-consumption.png` is an actual product capture. `validation.png` is a separate saved-test-report capture.

The preserved r6 lifecycle labels itself diagnostic because the final gate run had not finished when the browser executed. `source-binding.json` proves that all nine r4 gates subsequently passed on precisely the same tree. No earlier receipt has been rewritten to imply a different chronology. Only the two recorded browser driver files differ from native r1's tree; native production and test bytes are identical.

## Known isolation limitation

The native r1 suite observed 22 adversarial rejection or positive-control cases. Its actual child process could read the owned sibling/parent sentinel. Accordingly `native/result.json` remains `accepted: false`, with `parent-tree-isolation` unqualified. A Git worktree is not an operating-system filesystem boundary. This contribution does not close issue 297 or issue 51, claim production isolation, full TF01/R4 acceptance, live vendor inference, or owner acceptance. The browser success is a separate deterministic development-identity result. Earlier browser failures, including r5's stale evidence selection, remain under `prior-attempts/`.

## First-run reproduction

Use an isolated Windows checkout, PostgreSQL 17.10, Rust, PowerShell 7.4+, Playwright and Edge. The repository pins Node 24.19.0/pnpm 11.19.0; the actual local run used Node **24.21.0**, pnpm 11.19.0 and Rust 1.98.1. Install dependencies with `pnpm install --frozen-lockfile`, build `crony-server` and `crony-runner` with `cargo build --locked -p crony-server -p crony-runner --bins`, and build `crony-mcp` for the native Node tests. Run the nine commands in `validation.json`; keep fresh raw receipts with the tested tree and each command's exit code/log SHA-256.

The exact executed drivers are retained under `drivers/`. Their historical host constants and fresh-root checks are intentional provenance. For another machine or a clean first run, derive a new driver outside this immutable packet, map the repository, shared target, Node/PostgreSQL/Playwright paths and unused QA root, and pass or create a fresh raw gate receipt for that source. Browser r6 refers to the earlier r3 receipt only to admit its two-file diagnostic delta; a fresh run should instead bind its current tree directly to its own nine passing gates. Start the owned stack with `qa-pr305-stack-r1.ps1`, create its owned static-App context with `prepare-pr305-browser-context-r2.mjs`, and invoke the repository's `tools/e2e_research_handoff.mjs` exactly as the retained r6 driver does. Stop only the identities in that fixture's ownership record. Preserve database, worktrees and evidence.

For adversarial native coverage, `run-pr305-native-r1.ps1` shows the exact `cargo test --no-run --message-format=json`, production build, manifest construction, and `node tools/research_handoff_native.mjs <manifest> <fresh-output>` commands. Map its historical r1 receipt to a fresh matching raw receipt. The offline tool deliberately returns a non-acceptance exit and must be assessed through its explicit case coverage/failures; it is not a blanket pass gate.
