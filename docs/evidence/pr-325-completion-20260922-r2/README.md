# PR #325 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Preserve collaborator updates, integrate current main, reject unsafe browser-policy files before open, remove dynamic fixture-code interpolation, and retain complete failure evidence. Windows path expectations use native realpath.

Nine contributor checks pass on the final integration tree. A separate actual Edge module/CLI browser-selection run exercises desktop/mobile command verification; only README and documentation differ between that run and the final tree. No ECorp full-stack or production-provider acceptance is claimed.

The nine required commands passed on source head `54b6d006901fa3ef2dc2a6a5daf0c8c423e6588c` with staged tree `3c2fc975ff3c03dd00219722a62fcf5e269b0bcc`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The native Edge run used the final browser implementation: comparison of its tested tree with the final nine-gate tree contains only README and documentation. The complete path list is recorded in source-binding.json. Four unmodified captures cover module and CLI-selected desktop/mobile verification. Wrong host, wrong executable hash and missing executable all refused launch without evidence writes; the source fixture remained unchanged. The focused browser suite records 75 passes and two native Unix FIFO cases skipped on Windows. The full Node gate records 1,323 passes and the same two skips. Existing failed attempts and original packets remain preserved.

The CodeQL finding at comment 4072228585 is removed by supplying the fixture executable through F02_EXECUTABLE and fixed module text; no runtime filesystem path is interpolated into generated JavaScript. Fixture environment and module contents are explicit in the retained test source.

Reproduce the native browser pass with the retained reproduce-native-browser.ps1 after replacing its documented local path placeholders with a new owned checkout, fixture directory and approved installed-browser policy. The original host/executable SHA pin is specific to the recorded machine and is not a portable authorization. Run node --test tools/verifier_browser.test.mjs tools/e2e_verifier_browser_retention.test.mjs for the focused policy and retention regressions; the complete gate and source receipts identify the additional tests and their exact execution.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
