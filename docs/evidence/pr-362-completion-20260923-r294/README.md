# PR #362 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Bound image metadata and README references before payload lookup, reject duplicate image names including case aliases, and require exactly 69 passing regressions. Preserve attribution and hashes for disclosed public privacy derivatives and retained historical evidence.

Fresh nine-gate validation and exact staged-byte replay of 69 public-verifier/driver regressions. The replay verifies 67 staged files, 87 archive members, 111 manifest rows and 14 capture logs. Existing native/browser evidence retains its original source and scope; this packet is not a new application-stack acceptance run.

The nine required commands passed on source head `3195fd7f15cb43946f9705640568551cdc6a57e3` with staged tree `0c0f615cf46c8851acd14e275ca5346f9e98a69c`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The exact staged replay is retained in `staged-replay/`. Its input receipt was derived solely to make gate-log paths relative; commands, source identities, result timestamps, all gate-log bytes and original hashes are unchanged. The initial absolute-path input was rejected before fixture allocation. `source-binding.json` binds the original and derivative receipts separately.

`privacy-verification.json` records 23 whole-file hashes, 29 derivative segments, and independent comparison of the two disclosed screenshot masks with originals retained in Git. Pixels outside the declared rectangles are unchanged. Private historical text originals were unavailable; that comparison is not claimed. The original screenshots, text hash claims and prior failed attempts remain attributed in their existing evidence history and r14 correction packet.

Current verifier reproduction uses `tools/verify_pr362_staged_evidence.py --repository <checkout> --validation <receipt-with-relative-log-paths> --output-directory <fresh-owned-directory>`. The input requires the exact canonical nine commands and actual matching logs; the replay materializes only admitted staged Git bytes and executes all 69 tests.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
