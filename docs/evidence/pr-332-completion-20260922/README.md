# PR #332 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Reviewed the dependency and lockfile changes against current main, ran all nine required checks, and exercised persisted verifier success and deliberate failure through an isolated native stack.

Seven compatible JavaScript dependency updates, preserving the TypeScript 7 native compiler and TypeScript 6 compiler-API aliases. Actual desktop and mobile browser-to-server-to-runner acceptance is recorded separately in this directory.

The nine required commands passed on source head `d920cf70a6205ad5e91a1f102eda06de41df1bcc` with staged tree `4b85340becd7992431f6f4656ff0f06a1d78eb60`, incorporating main `410eddfc8bfcfa874dae05555128d39a914f0456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

## Actual browser and native-stack acceptance

`browser-acceptance.json` retains allowlisted, source-bound results from the unchanged `tools/e2e_verification_policy_browser.mjs` driver on the reviewed product head. The local stack used owned PostgreSQL, server, web and runner processes, development identities and the deterministic fake-process adapter. It made no external provider or GitHub calls. The lifecycle receipt confirms the owned processes stopped and the fixture/database/logs were preserved.

The 1440-pixel desktop and 390-pixel mobile captures exercise all six verifier editors and keyboard focus, preserve literal command arguments, and fit their viewports. Saving through the browser persisted the policy on the server; launching through the browser reached the runner. One mission completed only after all six checks passed. A deliberately impossible artifact floor produced a persisted failed run and retained its worktree. `stage: runner failed` in the original private report describes this expected negative case; the driver's overall status and exit code were successful.

The six PNGs are actual, unmodified browser screenshots. The task's small screenshot-signature fixture exercises the screenshot verifier and is not presented as a rendered browser image. The report's `source_commit` is the isolated task fixture; `product_source_head` identifies the reviewed dependency branch. The evidence does not claim real-provider inference, manual approval decisions, production authentication or hosted CI success.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.

The complete, secret-free reconstructed native browser recipe is in [REPRODUCE.md](REPRODUCE.md). It retains the historical product/source bindings and does not claim another browser run.
