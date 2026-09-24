# PR #353 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Validate native startup identities, source refs, canonical ancestors and access before restart; preserve enrollment, source checkout and owned processes on rejected preflight. Integrate current main.

All nine checks and fresh actual Windows startup/recovery plus Edge browser-to-server-to-native-runner acceptance pass on the integrated current-main tree. Unchanged native binaries are explicitly reused after complete native input and binary hash comparison.

The nine required commands passed on source head `d74229df9286048cb073e33bb03e31fd537a186f` with staged tree `dc498871228bd9a4ee1b8a88ef0dd3ea46d44678`, incorporating main `de12261d045ddfccf790bcfd04a7fa254563d456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Fresh acceptance checks valid and rejected read-only preflight, repeated start, missing-web recovery and explicit restart. Rejected preflight preserves state and process identities; successful restart retains enrollment. Actual Edge accepts passing verification and rejects a failing policy. Original build inputs and binaries are hash-checked before reuse. Earlier native attempts are retained under their own trees; their UI results are not attributed to the current tree.

The new PostgreSQL fixture uses SCRAM with a random ephemeral password in ACL-private files outside the synthetic source and runner workspaces. An incorrect-password probe fails before authenticated creation. PSQL uses PGPASSFILE; native server/SQLx environment-only credential delivery is explicitly reduced assurance. Child launch environments are cleared and the runner/browser do not receive the database credential. The fixture does not establish OS isolation between processes owned by the same user.

See REPRODUCE.md for fresh-receipt requirements and recorded driver filenames. Historical acceptance is preserved with its original scope.

The r7 validation is retained as FAILED in prior-validation-attempts/r7/. All commands returned zero, but its final source guard correctly rejected a moved tracked output placeholder. The exact preserved file was restored before the complete successful r8 rerun. Original and published receipt/log hashes are recorded in source-binding.json.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
