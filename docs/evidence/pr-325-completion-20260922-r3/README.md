# PR #325 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Reject invalid Windows policy paths before filesystem access and read policy files through a bounded short-read loop to EOF or the size limit.

All nine contributor checks and a fresh installed-Edge module/CLI verifier acceptance pass on the same staged source. No application-server or production-provider acceptance is claimed.

The nine required commands passed on source head `b284e929d273137bc348d0d8505dc95d669aa4a4` with staged tree `c517ef226ab2ebf1287114f0cb02a96e950c8a77`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The failing baseline and passing policy regression logs are retained. The corrected suite has 93 cases: 91 pass and two native Unix FIFO cases are skipped on Windows. Fifteen unsafe Windows path inputs are rejected before any filesystem call, including raw and canonical paths. A real file wrapper limited to seven bytes per read proves that the complete policy is read and hashed; the total remains bounded to 8,193 bytes for the 8,192-byte limit.

The fresh Edge module and CLI run uses exactly the same staged source as all nine checks. Desktop/mobile captures are unchanged original PNGs. Wrong host, wrong executable hash and missing executable refuse launch without writing verification evidence; the synthetic source remains clean. Historical packets and failed attempts remain preserved.

Reproduce the policy suite with node --test tools/verifier_browser.test.mjs. For installed-browser acceptance, use tools/e2e_verifier_browser.mjs with a new owned source fixture and output directory, a locally approved host/executable/hash policy, and the installed Playwright module. recorded-native-browser-driver.ps1 records the executed structure; its normalized path placeholders and original machine-specific pin require explicit local configuration and are not runnable unchanged. This packet proves verifier-browser selection, not a browser-to-ECorp-server flow or real provider acceptance.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
