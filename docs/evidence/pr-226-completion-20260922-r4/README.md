# PR #226 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Reject absolute cross-drive and UNC relative results; read bounded single-link regular evidence from one identity-checked descriptor; reject replacement, mutation, growth and oversize input; prove actual Windows 8.3 spelling while rejecting linked ancestors.

Nine required gates and 16 focused evidence-reader cases on the staged current-main integration. This correction adds no application behavior or new provider/native Factory acceptance; issue #225 remains independently tracked.

The nine required commands passed on source head `e2bc71d9f673ec069e6f3b9dc84a13d5e366793d` with staged tree `b653abbd09def85606f1517396db26ef33cc0eb8`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The source-bound nine gates passed, and the focused reader suite passed all 16 cases without skips. The actual Windows test obtains a real short alias and also rejects a linked ancestor. Cross-drive and UNC containment controls use Windows path semantics. Four injected replacement controls confirm that no outside bytes are read through either regular-file or symlink swaps. A sparse oversized file is refused before content access; the suite also covers the size limit, empty files, hard links and growth during a descriptor read.

The retrospective baseline ran these current tests against the prior implementation: eight passed and eight failed, including four observed outside-byte reads. Earlier failed attempts remain under prior-attempts; those outcomes are not rewritten. Windows file identity is bound before reading, with ctime tracked after descriptor acquisition because NTFS may finalize a fresh file's change time at open. This tooling result is not new issue #225 native Factory acceptance.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
