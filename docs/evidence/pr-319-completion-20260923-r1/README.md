# PR #319 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Keep Required native alias coverage as the default; use ReportUnavailable in the portable hosted Windows lane, with explicit blocked status when the volume cannot supply an alias. Guard both path-overlap and later Git-identity cases consistently.

Nine contributor gates, a complete native Windows preflight using an actual distinct 8.3 alias, and four synthetic missing-alias mode controls passed on the same staged source. No new U1 application acceptance is claimed.

The nine required commands passed on source head `f62ea050bb65850c4780c3dfcfb1e5223475b8cd` with staged tree `12f5e2a401fd0fbc0ae831bffa4db65bde69637f`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The native lane actually obtained a distinct alias, rejected all four overlap cases, and attested the same clean Git commit through the alias. Its receipt reports Required, executed=true, distinctAlias=true and passed. Portable hosted CI no longer assumes every hosted volume has the prerequisite.

The four separately retained synthetic cases cover failed lookup and unchanged spelling under both modes. Required exits 1 at its explicit prerequisite; ReportUnavailable exits 0 only after portable checks and reports both alias sub-lanes blocked and unexecuted. These intentional prerequisite failures are not counted as native passing coverage. The complete original logs and their source-bound hashes are retained.

This is preparation/specification tooling. It starts no product stack and does not close the retained-original reconciliation, MP1 contract adoption, independent browser-auth review, native U1 runtime acceptance or release obligations. Earlier evidence remains historical; the new image is a genuine saved-results report capture. Node 24.21.0 was used locally; the repository pin remains 24.19.0.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
