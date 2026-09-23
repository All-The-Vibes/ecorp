# PR #332 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrated main 5f65e536f80e206082a8a819f2675c9b16210fce. Added the complete reconstructed browser fixture recipe and fresh live execution captures for all nine required commands, addressing A332-E01 and A332-E02.

Fresh current-main contributor checks, with live child-process execution captures. Historical desktop/mobile browser acceptance remains separately bound to its original tested product.

The nine required commands passed on source head `5fc4f59deae52f9a684bb48407fe05400b869ca5` with staged tree `d0b14516558c71d7aed5f8346f26e25c8203cc86`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

All nine checks were launched and streamed by the retained live browser command runner. Each *.execution.json binds the child PID, start/end times, exact staged source tree, raw log hash and two unmodified images. Every running capture records the child still alive both when capture began and when it finished. These are genuine fresh test-runner captures, not product images or playback of saved logs. live-captures.json binds the runner and command configurations; the nine completed images retain their actual command results.

The older saved-report image and six application captures remain unchanged in ../pr-332-completion-20260922/. Its REPRODUCE.md and prepare-browser-fixture.ps1 provide the complete secret-free reconstructed startup, synthetic source preparation, native driver invocation and owned cleanup recipe. That historical acceptance is not relabelled as a fresh product run. This follow-up changed documentation only beyond the existing dependency update.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.

The final Git whitespace inspection used process-only core.whitespace=blank-at-eol,space-before-tab,cr-at-eol,-blank-at-eof to preserve the already tested historical recipe bytes (CRLF and a final blank line). The ordinary diff-check diagnostic is retained privately. No repository/global Git configuration or required validation command was changed.
