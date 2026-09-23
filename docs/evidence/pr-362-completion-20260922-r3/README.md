# PR #362 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Reject unlisted directories, unsafe names, symlinks and Windows reparse paths in the public evidence verifier before external reads. Remove personal home paths from gauntlet report/metadata/archive text, retain correction hashes and integrate current main.

All nine checks and fourteen exact-Git-byte verifier regressions pass. Verify archive inventories and corrected metadata hashes. Prior native transport/startup/browser acceptance remains separately bound to its original source; no new native acceptance is claimed here.

The nine required commands passed on source head `a1098b73f6fec7b3275b7e0f46e56813fe2bb726` with staged tree `cddcc8b7661b8e4feb94e9ea7f368f7a38c39b94`, incorporating main `de12261d045ddfccf790bcfd04a7fa254563d456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The verifier now checks the lexical root and every existing ancestor before resolving paths; rejects symlinks and Windows reparse points, non-regular entries and unlisted directories; validates contained regular files and their opened descriptors; and constrains manifest names, PNG paths and README targets. It retains refusal of optimized Python. Fourteen actual regressions pass with zero skips, including Windows symlinks and junctions. The controlled previous implementation fails the new boundary cases; both logs are retained.

The metadata correction replaces personal filesystem prefixes in the gauntlet report, manifest and 38 of 87 archive members. Original PNG bytes remain unchanged. Separate original/published hashes preserve the correction history; old raw metadata/archive bytes remain privately retained and are not republished with personal paths. The final exact-byte check verifies 111 manifest file rows, 14 capture-log hashes and all 38 corrected archive-member hashes. Historical acceptance is never relabeled as a new run.

The report uses CRLF in the Windows worktree and LF in Git. metadata-correction.json retains the physical worktree SHA-256, while source-binding.json and exact-staged-bytes.json separately record the published Git SHA-256 and prove its equality to canonical LF. The staged Git bytes, not an assumed checkout representation, were tested.

The earlier r4 supplemental scanner failed after incorrectly treating a GitHub API /users/ URL as a local path. Its original receipt, passing verifier output, driver and explicit failure record are retained under prior-attempts/r4/. The corrected r5 scanner requires a Windows drive-qualified home prefix. No product source changed between those supplemental attempts.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
