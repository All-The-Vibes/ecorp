# PR #325 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Validate canonical evidence destinations before mkdir, reject dangling aliases, correct the empty-policy diagnostic expectation, preserve the process identity guard with recorded identity diagnostics, and execute all eight native Windows handoff cases in CI.

All nine contributor gates and installed-Edge module/CLI desktop/mobile verifier acceptance passed on the same current-main source. This is verifier acceptance, not a browser-to-application-server or provider run.

The nine required commands passed on source head `45fd38835e7f81d318a42c37e279489dafeb76c9` with staged tree `25967ebae84d2551bd80610fe622281b83de7339`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The retained native handoff baseline runs all eight cases and has two failures, both the empty-policy diagnostic assertion. The corrected direct Node and junction-path diagnostic runs each pass all eight cases, retaining no-launch and no-canary assertions. Exact PID, executable and start-time comparisons remain mandatory; the only ownership change records those compared values. An earlier junction attempt stopped after three cases at that identity guard. Its failed log and partial observations are retained; its cause was not established and it is not counted as eight-case acceptance.

The output-scope baseline records two failures and two passes; it reproduces unwanted creation of a missing in-worktree destination and its alias. The corrected scope/retention suite records eleven passes with no skips, including independent Git repositories and linked worktrees. Current staged source for the focused files is byte-identical to the retained fix commit. The baseline/candidate executions are retrospective, not original TDD chronology.

`handoff-before.png` and `handoff-after.png` are genuine browser captures of the actual saved case reports. They are test reports, not application UI. `native-browser/` preserves the real verifier browser module/CLI desktop/mobile captures from the current source. `validation.png` captures the nine-gate report. Windows CI now explicitly invokes the existing PowerShell handoff test and uploads its receipts even on failure.

Reproduce the focused lanes with `node --test tools/e2e_verifier_browser_scope.test.mjs tools/e2e_verifier_browser_retention.test.mjs` and `pwsh -NoProfile -File tools/local_stack_browser_policy_handoff.test.ps1 -NodePath <absolute-node> -OutputDirectory <fresh-owned-output>`. Use the recorded native-browser driver with fresh locally configured paths and the exact approved browser binary/hash. Historical packets retain the earlier policy-boundary baseline and 91 passing policy regressions with two Unix-only skips. No new Linux/macOS or application-provider acceptance is inferred here.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
