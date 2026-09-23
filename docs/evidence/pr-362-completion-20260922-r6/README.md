# PR #362 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Bound evidence file reads and ZIP expansion before decompression. Require explicit validated source and intact gate logs in the current staged-evidence replay driver, reject optimized Python, and preserve all earlier recorded drivers and receipts. Integrate current main; retain the correct pinned url 2.5.8 IPv6 loopback behavior.

All nine contributor gates and 35 verifier/driver regressions pass on the exact staged source. Replay verifies 66 staged files, 87 archive members, 111 manifest rows and 14 capture logs, with unchanged historical screenshots.

The nine required commands passed on source head `77278c4cad5cdcd1c19ad586b4dd002e4ec630dd` with staged tree `89dbe98cd3136d973aa3671ffe8d5c93f5f5520b`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

File reads enforce an absolute 8 MiB budget before reading and retain regular-file, single-link, descriptor identity and mutation guards. ZIP handling enforces 4 MiB compressed bytes, 1 MiB per member, 16 MiB total expansion and 512 members before decompression, then streams bounded reads with CRC validation. Duplicate archive manifest names remain rejected. The controlled baseline had six failures and two errors among 25 tests; the candidate passed all 25. The current driver adds ten guard regressions, and all 35 pass in exact staged-byte replay.

The current reproduction entry point is tools/verify_pr362_staged_evidence.py. It rejects optimized Python before work, requires explicit repository, validation directory and fresh output arguments, verifies nine successful gates and their log hashes, then executes the staged bytes and confirms source preservation. Historical recorded drivers remain unchanged records of earlier execution, not the supported replay entry point. Use --help for the current invocation contract.

The CLI and gateway IPv6 review findings were withdrawn after checking pinned url 2.5.8; its host_str() returns [::1]. The existing bracketed match and native tests are retained. No new native full-stack acceptance was required for these verification-tool changes. Earlier native/provider evidence retains its original source and limitations. Local Node is 24.21.0; the repository pin is 24.19.0. The new validation image is a rendered log report. Earlier application screenshots retain their exact bytes.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
