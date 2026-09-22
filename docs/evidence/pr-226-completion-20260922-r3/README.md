# PR #226 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Reject linked/reparse-point roots and ancestors, dangling or nonregular paths before evidence enumeration; retain canonical containment and ordinary Windows short-path support. Correct the previous receipt filenames and distinguish original from actual published digests without discarding prior evidence.

Nine contributor gates on the current-main integrated source, six focused personal-path scanner cases and retained receipt-reference verification. Issue #225 native Factory acceptance remains open; this bounded correction adds no new application behavior or provider acceptance.

The nine required commands passed on source head `87216fa319e03ce0626805d4f6c530ed6e7f4ad9` with staged tree `7bdeb42dbda78174e96e54932797681a1fbcafc6`, incorporating main `de12261d045ddfccf790bcfd04a7fa254563d456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The focused regression failed before the correction. An intermediate correction rejected the Windows short spelling used by temporary directories; that failed attempt is retained. The final six-case suite passes. `correction-provenance.json` binds all three logs and the receipt-reference check separately. The original r2 receipt is retained under its `prior-attempts/` directory.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
