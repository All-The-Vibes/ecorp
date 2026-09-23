# PR #362 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Reject lexical parent traversal and linked/reparse output ancestors before allocating any output, including when intermediate parent directories do not yet exist. Preserve existing paths with lexists and require exactly 64 successful verifier/driver regressions.

All nine contributor gates and an exact staged-byte replay of all 64 verifier/driver regressions passed on the same source. The replay verified 67 staged files, 87 archive members, 111 manifest rows and 14 capture logs. The workspace run also passed the real on-wire CLI bearer/proxy regression.

The nine required commands passed on source head `a2c8a0603b4fc15abb1755dcb5583abc833e9f07` with staged tree `69e922ce6e5c8bbefe033dd829e65c2b3a546c15`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The real Windows junction regression covers a direct nonexistent child and missing intermediate parents; both are rejected before output creation and preserve the destination sentinel. The exact staged-byte replay passed all 64 tests. Its relative gate receipt changes only log names beside the unchanged hashed payloads; the raw receipt is preserved. Retrospective baseline failure is retained without claiming original TDD chronology.

`focused-validation.json` binds the retained original and published log hashes.

Harden the public evidence verifier and staged replay driver with bounded inventories, archive admission, canonical gate commands and source-bound receipts. Validate every gate-log name before reads and require every staged source/discovery input before fixture creation. The output admission fix rejects existing aliases before materializing the fixture, including missing-parent paths; real Windows junction cases preserve the destination sentinel. The CLI transport already constructs the actual Bearer token header and marks it sensitive; its on-wire regression confirms the token reaches the owned listener while environment proxies are bypassed.

The linked-output baseline failed the new early-rejection assertion; that observation is not presented as evidence that an outside write actually occurred. No new application-stack or production-provider acceptance is claimed. Existing native and gauntlet evidence keeps its original scope.

Local Node was 24.21.0; the repository pin is 24.19.0. Hosted final-commit checks and independent eligible review remain required for the protected merge.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.

## September 23, 2026: escaped-path publication correction

The baseline failure log now also normalizes two escaped Windows home-prefix spans
inside nested exception text to `<user-home>`. This is a disclosed path-only public
derivative, not a new execution. Original execution hashes and all test-result text
remain unchanged. The previous published bytes remain in Git commit
`3195fd7f15cb43946f9705640568551cdc6a57e3`; `focused-validation.json` records both
the previous published hash and the corrected published hash. Earlier validation
and source-tree bindings still describe their original tested inputs.
