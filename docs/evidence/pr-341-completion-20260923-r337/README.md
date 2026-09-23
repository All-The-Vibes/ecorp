# PR #341 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Preserve metadata-only, complete-history secret-scan diagnostics, native failure propagation, path-only finding support and immutable workflow identity while incorporating the merged authenticated transport changes.

Nine fresh contributor gates on the ordinary merge with security main. The reporter and native fixtures are unchanged from the previously reviewed head. The 76-case native/reporting acceptance, ten native histories, and failing baseline remain in the r7 packet with their original source and execution date; they were not rerun for this integration.

The nine required commands passed on source head `e8152cc033b8402434f030a3d603ec47be09692b` with staged tree `f85e894ff10b95849b459812cc66640528358738`, incorporating main `33e4e47a9dea589a8165c19d9a5ff3d493b85c50`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Nine fresh contributor gates on the ordinary merge with security main. The reporter and native fixtures are unchanged from the previously reviewed head. The 76-case native/reporting acceptance, ten native histories, and failing baseline remain in the r7 packet with their original source and execution date; they were not rerun for this integration.

Local execution used Windows x64, Node 24.21.0 (repository pin 24.19.0), pnpm 11.19.0 and Rust 1.98.1. The committed validation image renders actual saved command results; it is not an application or live-provider screenshot. Historical failed evidence is preserved. Hosted CI and security checks must pass on the published head before merge.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
