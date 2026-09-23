# PR #362 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Use the vetted bounded evidence reader for replay input, validation receipts and logs; reject linked ancestors, hard links and oversized staged blobs before materialization. Suppress bytecode during verifier imports and run both verifier and driver regression suites in every relevant CI job. Historical evidence remains unchanged.

All nine contributor gates and 44 verifier/driver regressions pass on the exact staged source. Replay verifies 66 staged files, 87 archive members, 111 manifest rows and 14 capture logs.

The nine required commands passed on source head `b7f90ac78180662e314e39d9592ae8e5c7217976` with staged tree `b57e88ef68c40489157a302b1d42bde2b3450e9d`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The replay driver imports the vetted reader next to its own source, rather than executing a reader selected by the supplied repository path. It admits lexical input ancestors before resolving aliases, retains descriptor identity and file-size bounds, and hashes the admitted buffers. Staged enumeration uses NUL records, accepts ordinary file modes, and checks each immutable blob size before reading its contents. Existing ZIP limits and optimized-Python refusal remain in effect.

The eight controlled baseline cases fail. Seven reach later missing packet-content checks rather than rejecting the linked/oversized input at admission. The oversized staged-blob case reaches output-directory allocation and then fails because its deliberately minimal fixture lacks HEAD. This proves missing early admission; it does not prove successful replay or completed oversized materialization. The candidate rejects all eight at their intended boundary.

The retained hosted failure predates this correction. Importing the verifier had created __pycache__ inside an exact-inventory fixture and failed cross-platform jobs. The verifier tests and in-process replay now suppress bytecode, including when the parent environment does not request suppression. Both CI discovery commands quote test_*evidence*.py and collect the verifier and driver tests. This local packet does not claim the newly published hosted run has passed.

The current reproduction entry point is tools/verify_pr362_staged_evidence.py; it requires an explicit repository, a successful nine-gate validation receipt, and a fresh output directory. Earlier recorded drivers, receipts, failures, and screenshots are historical evidence and retain their bytes. The pinned url 2.5.8 IPv6 loopback behavior remains unchanged.

These changes affect validation tooling. No new native full-stack or provider acceptance is claimed. Local Node is 24.21.0; the repository pin is 24.19.0. The new validation image is a rendered log report.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
