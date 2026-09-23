# PR #362 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Constrain all nine gate-log names to normalized receipt-relative paths before any log read, require every staged source/discovery input before fixture creation, and require exactly 63 successful regressions.

All nine contributor gates and an exact staged-byte replay of 63 verifier/driver regressions passed on the same source. The replay verified 67 staged files, 87 archive members, 111 manifest rows and 14 capture logs.

The nine required commands passed on source head `aae28181c1bc64e3220928cd7b4664a031bcd943` with staged tree `b3117f33e29d4cb9369eab98aaf08624d4aa6f19`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

A new receipt derives only relative gate-log names from the preserved raw nine-gate receipt; the nine original log payloads and hashes are unchanged. The exact staged replay passes all 63 tests. The earlier failed focused attempt and its passing follow-up are retained as history, with no original TDD chronology claimed.

`focused-validation.json` binds the retained original and published log hashes.

Harden the public evidence verifier and staged replay driver with bounded inventories, archive admission, fixed canonical gate commands and source-bound receipts. The latest correction admits every gate-log name lexically before reading any log, rejects traversal, absolute paths, Windows drive/UNC/stream spellings and reserved names, then resolves each through the retained reader under the receipt directory. All five source/discovery inputs must exist before allocating a fixture. The complete expected suite is now 63 tests, including the three new regressions; skipped, duplicate or partial summaries cannot pass. LF and CRLF summaries are accepted. To reproduce on a checkout, run the nine canonical commands there and provide a fresh raw receipt for that exact staged tree with log names relative to the receipt directory, then invoke tools/verify_pr362_staged_evidence.py with --repository, --validation and a new --output-directory. The path-normalized records in this packet are historical evidence with separately recorded original hashes; they are not fresh validation of a later tree.

Node 24.21.0 was used locally; the repository pin is 24.19.0. Hosted checks on the final commit and independent eligible latest-push/CODEOWNER approvals remain protected-merge requirements.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
