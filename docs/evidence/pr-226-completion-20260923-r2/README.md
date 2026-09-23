# PR #226 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Bind enumerated files and directories to the identity of the subsequently opened handle; re-enumerate each directory and the discovery parent before accepting results. Enforce scan-wide 256 MiB read and 1 MiB escaped-JSON output budgets. Compile the scanner into a unique private executable and verify its digest before invocation, so an intact Cargo fingerprint cannot bless a replaced executable. Provision pinned Rust 1.98.1 in both Node-regression CI jobs and build scanner dependencies before tests.

All nine contributor gates passed on the bound staged source. The native Rust suite executed 21 cases, including pre-open file/directory replacement, concurrent packet discovery and cumulative budgets. The real cached-artifact poison regression confirms ordinary Cargo fingerprinting retains a substituted executable, while the wrapper recompiles from source and rejects subsequent private-executable tampering. These tests also run in the passing workspace/Node gates.

The nine required commands passed on source head `4e1b0f46e672e8f7b27ce9aa1cf9dfedbbee6f37` with staged tree `0ba8fe4a7eed6ac9a9b1d331cd09b4cfd615334b`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Retained focused scanner and executable-integrity runs. The source-bound nine-gate receipt independently executes both suites; these logs expose the individual regression results.

`native-integrity-regressions.json` binds the retained original and published log hashes.

Preserve the Factory canary's literal Git bytes and verify retained evidence through bounded native capability I/O. The canary behavior and byte-contract tests remain wired into CI; the historical native Factory acceptance for #225 remains separately tracked.

Local execution was Windows x64, Node 24.21.0 (repository pin 24.19.0), Rust 1.98.1 and pnpm 11.19.0. The Unix implementation uses the pinned rustix/cap-std enumeration inode API; no local Linux execution is claimed. This evidence-tool correction does not claim new application, provider, watcher-restart or native Factory acceptance. Earlier evidence and failed local attempts retain their historical scope. Fresh hosted checks and eligible independent review remain required for merge.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
