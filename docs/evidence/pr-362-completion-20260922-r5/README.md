# PR #362 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Require single-link regular evidence files before open, on the opened descriptor and after reading; retain inode, device, size, modification-time and canonical-path checks. Add actual hard-link regressions for the manifest and a delivered README.

All nine contributor gates and sixteen verifier regressions pass on Windows against exact staged Git bytes. The real hard-link baseline failures and prior macOS fixture correction are retained. Hosted platform checks must pass on the published head.

The nine required commands passed on source head `e55f51c9565d2febf4d7ca2a0aa9f875aacd5ca7` with staged tree `db32fff74cb296bff501af892c956516c240023c`, incorporating main `de12261d045ddfccf790bcfd04a7fa254563d456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The original verifier accepted two actual hard links into files outside the packet. hardlink-before.log retains both expected regression failures. The corrected verifier refuses both aliases, while the test verifies that each outside file retains its exact original bytes. All sixteen tests then pass with zero skips. The read boundary checks single-link status before opening, on the held descriptor, after reading and through the current path.

The prior macOS correction is included in the unpublished ancestry: only the trusted test-owned temporary root is canonicalized. Production alias rejection remains enforced. The preceding macOS workflow failure and all diagnostic attempts remain in the unchanged r4 packet, individually hashed by source-binding.json. No new hosted macOS success is claimed before the new workflow finishes.

Exact staged-byte verification covers 64 files, 87 archive members, 111 manifest rows, 14 capture logs and 38 corrected members. Historical PNG bytes and archive contents are preserved. The new validation image captures saved local results.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
