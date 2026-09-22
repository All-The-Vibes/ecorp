# PR #324 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Removed inherited GIT_TRACE* and GIT_CURL_VERBOSE variables before the first Git child. Six native trace regression cases preserve source bytes and the candidate tree; all 49 focused tests pass. The earlier completion packet and its linker-failure provenance remain unchanged.

Deliverable patch checking remains isolated from the source checkout, including hostile inherited Git tracing settings. Tooling-only acceptance; no new application runtime claim.

The nine required commands passed on source head `0c01bbca17bcb724c989329bb470cd0b8b11c062` with staged tree `b7b58c1b4fdc355849f0f3c4af24c30d87e57202`, incorporating main `410eddfc8bfcfa874dae05555128d39a914f0456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

The before-fix native regression reproduced a source write through inherited GIT_TRACE. The fixed implementation passed all 49 focused tests, including six native trace variants. These retained before/after results cover the September 22 follow-up repair; they do not claim the original author development chronology.

`git-trace-regression.json` binds the retained original and published log hashes.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
