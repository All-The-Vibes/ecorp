# PR #359 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Reject canonical equality, nesting, filesystem aliases and special-file targets among fixture source/output/private paths before writes. Use an authenticated isolated database and retain driver filenames consistently. Integrate current main.

All nine checks, path isolation regressions, eighteen owned PostgreSQL issue48 regressions, and real Edge/CLI/native-runner lifecycle acceptance pass on the same tree.

The nine required commands passed on source head `063d2940c5c086bfeac13bba71a9e7a295b26dcc` with staged tree `d9ee7add48137f1891244cfc27a22774d9dc8af7`, incorporating main `de12261d045ddfccf790bcfd04a7fa254563d456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The fixture rejects overlapping or aliased source/output/private roots and non-regular checkpoint/lease targets before write. Canonical-ancestor regressions exercise equality/nesting and Windows junction/case aliases. Sixteen store and two server issue48 SQLx cases pass. Actual Edge, CLI and native runner exercise versioned pin/unpin replay, preserved leases/messages, completed runs, retained saved-plan obligations and eventual retirement; five original application captures are retained. The recorded drivers keep their original filenames, so supervisor lookups resolve within recorded-drivers/.

The new PostgreSQL fixture uses SCRAM with a random ephemeral password in ACL-private files outside the synthetic source and runner workspaces. An incorrect-password probe fails before authenticated creation. PSQL uses PGPASSFILE; native server/SQLx environment-only credential delivery is explicitly reduced assurance. Child launch environments are cleared and the runner/browser do not receive the database credential. The fixture does not establish OS isolation between processes owned by the same user.

See REPRODUCE.md for fresh-receipt requirements and recorded driver filenames. Historical acceptance is preserved with its original scope.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
