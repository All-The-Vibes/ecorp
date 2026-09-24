# PR #353 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Start each synthetic ownership-restriction scenario with fresh owned process roots and confirm they are alive. Bound the expanded Module suite at ten minutes while preserving individual waits, fixture lifetimes and the separate Source watchdog.

Nine contributor gates passed. All 79 focused synthetic Windows startup cases passed. The focused source differs from the gate tree only in the wrapper watchdog; production source is unchanged. The former five-minute timeout and its logs are retained. Existing native browser/server/runner acceptance remains bound to unchanged production source and is not presented as a new run.

The nine required commands passed on source head `69dc4afe9bdbc014499673842ce6e0b4e8970fd7` with staged tree `d9140deb2ff665b0cf93fac0feaf636530029084`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Validate local startup before lifecycle effects and preserve recoverable state during partial restart. Ownership replacement, authoritative saved-connection source selection and SHA-256 Git IDs are checked before effects. Startup no longer implicitly provisions a Corp or enrolls a runner; the separate setup steps are documented.

Refs #230; this completes the startup-validation portion without closing unrelated issue work.

Local execution is Windows x64, Node 24.21.0 (repository pin 24.19.0), pnpm 11.19.0 and Rust 1.98.1. The committed report images show actual saved results. Historical native and browser acceptance retains its source, date and limitations; synthetic identity evidence is not production identity or OS isolation. These results precede the next main integration; fresh hosted CI and security checks are required before merge.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
