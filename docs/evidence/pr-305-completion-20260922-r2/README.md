# PR #305 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Enforce the 64 KiB total dependency prompt for legacy-only inputs and the complete resume prompt before secrets or dispatch. Preserve boundary, plus-one, multibyte, and original handoff acceptance evidence; exercise the native fixture through the corrected revision-specific driver.

All nine contributor gates, fresh current-source native adversarial coverage, and an actual Edge/server/native-runner deterministic research handoff. The native suite retains 22 observed cases and an unqualified parent-tree-isolation case; this is a bounded, non-closing contribution to issue 297.

The nine required commands passed on source head `bafe6e88c84444213f461292997cf0413191c2d0` with staged tree `a60a4e0c141e77d2dac758bf4c0d688340b40118`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

## Current prompt-bound correction and evidence

Legacy dependency summaries cannot bypass the combined 64 KiB prompt budget. Resume admission also validates the fully assembled resume prompt, including recovery text, before resolving secrets or dispatching the run. Rust regressions cover the exact limit, plus one byte, and multibyte inputs; the fresh native catalog exercises the corrected limits. All nine r6 gates passed. The failed r5 clippy receipt is retained under `prior-attempts/` rather than rewritten.

The fresh r7 Edge run exercised mission `f43fbce9-d8ba-4feb-b928-03967245b4c9` from the actual App through two specialist runs and dependent synthesis `25bdbfd8-df8d-4fe3-ae61-0cc7472db648`. Both parents completed before synthesis, three distinct worktrees were retained, and signed authorized source downloads supplied the declared content. The UI selected the synthesis task, displayed accepted verifier evidence, and downloaded the artifact with matching SHA-256 `5c121cdbc04a8dca47055ecd8768173f8b9b6bb376e0262dac1a291067369939`. `browser/browser-consumption.png` is a product capture. `validation.png` separately captures the saved test report.

Native r2 was freshly compiled from the same passing source and observed 22 rejection/control cases. Its actual child process could still read the owned sibling/parent sentinel. `native/result.json` therefore remains `accepted: false` with `parent-tree-isolation` unqualified. A Git worktree is not an OS filesystem boundary. This change does not close #297 or #51, establish production isolation, live vendor inference, full TF01/R4 acceptance, or owner acceptance. The browser result is deterministic development-identity coverage.

The original r2 launch script selected the r1 manifest helper; the exact original and its hash are preserved under `prior-attempts/`. The executed corrected driver explicitly selects the r2 helper/build receipt. The correction provenance records both hashes. The previous r1 packet and all its earlier browser/native attempts remain unchanged; its acceptance is historical, not evidence for the changed native source.

## Reproduction

Use an isolated Windows checkout, PostgreSQL 17.10, Rust 1.98.1, PowerShell 7.4+, Playwright, and Edge. The repo pins Node 24.19.0; this local run used **Node 24.21.0** and pnpm 11.19.0. Install with `pnpm install --frozen-lockfile`, run the nine commands in `validation.json`, and retain their exact source tree, command exits and raw log hashes. Build the source-matching `crony-mcp` for the native unit lane.

Exact executed acceptance drivers are under `drivers/`. They preserve their historical host paths and refuse reuse of output roots. For another host, derive a new driver outside this packet, mapping repository, shared Cargo target, Node/PostgreSQL/Playwright paths and a fresh QA root. Bind the new driver to a fresh passing validation receipt. The native driver builds the real server/runner test binaries, constructs the matching manifest, and runs `node tools/research_handoff_native.mjs <manifest> <fresh-output>`. Its deliberate non-acceptance exit must be interpreted through recorded case coverage, not converted to a pass.

The browser driver uses the owned stack helper and `tools/e2e_research_handoff.mjs`; stop only resources verified in that fixture's ownership record. The recorded browser stack stopped successfully while preserving database, worktrees and all evidence. Never substitute a previous binary or an unrelated listener for the owned fixture.
