# PR #354 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Recheck the complete runner requirements under the same map guard as StartRun dispatch, covering capability updates between selection and send. Correct the historical reproduction receipt schema while retaining its original version. Integrate current main.

All nine checks, the eight-case dispatch capability-race regression, four owned PostgreSQL issue256 regressions, real HTTP readiness checks, and fresh Edge browser-to-server-to-native-runner acceptance pass on the same tree.

The nine required commands passed on source head `b17065604660d8a91fa9fe047ce2060b8d9389d7` with staged tree `6b052727d44ffc40cf05008b45e52ccc1f19472c`, incorporating main `de12261d045ddfccf790bcfd04a7fa254563d456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Selection and guarded StartRun delivery share runner_satisfies_requirements. Corp, workspace, adapter, model, reasoning, source repository, source ref and commit are checked immediately at send. The focused regression fails on the previous send guard and passes on the corrected guard. HTTP acceptance proves not_ready/ready, execution-intent conflict and observer denial while eight ledger hashes remain unchanged. The actual Edge flow verifies accepted completion and verifier rejection. The old reproduction driver now accepts staged_tree or tested_staged_tree and compares implementation separately from later evidence.

The new PostgreSQL fixture uses SCRAM with a random ephemeral password in ACL-private files outside the synthetic source and runner workspaces. An incorrect-password probe fails before authenticated creation. PSQL uses PGPASSFILE; native server/SQLx environment-only credential delivery is explicitly reduced assurance. Child launch environments are cleared and the runner/browser do not receive the database credential. The fixture does not establish OS isolation between processes owned by the same user.

See REPRODUCE.md for fresh-receipt requirements and recorded driver filenames. Historical acceptance is preserved with its original scope.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
