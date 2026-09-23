# PR #341 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Isolated native acceptance on the immutable executing workflow revision, removed selected-head executable prerequisites from the production scan, hashed sensitive selected metadata, preserved completed-findings versus partial/error outcomes through native exit code 42, and added a native Git completeness preflight. Integrated current main without rewriting history; retained retrospective failures and corrected native passes.

Source-bound current-main validation of the secret-scan workflow and diagnostics. Separate real Gitleaks 8.30.1 native fixtures passed all nine cases; this ordinary unit run correctly reports those opt-in cases as skipped. No application runtime or provider acceptance is claimed.

The nine required commands passed on source head `3fbd3fdaacb94df266828ad50f4db12eff93e757` with staged tree `053a9bd9ea56997473c6401de50aa78e9e922da8`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Retrospective controlled replay: the previous workflow fails the canary-in-path and actual native partial-timeout regressions; the restored corrected workflow passes all 66 focused cases, including nine real Gitleaks 8.30.1 histories. Earlier exploratory regression attempts remain retained and are not relabelled as success. These are new author-side checks, not original development chronology or human approval.

`controlled-regression-logs.json` binds the retained original and published log hashes.

The last required change request was review 5279963419 on source head `3fbd3fdaacb94df266828ad50f4db12eff93e757`. The correction addresses all three requested boundaries. Native fixtures now run in a separate job whose checkout is `github.workflow_sha`; production retains the immutable selected head and complete ancestry, without executing its fixture code. Diagnostic paths and rule names are hashed. Native exit 42 identifies completed findings; errors and real partial timeout reports remain nonzero and explicitly incomplete. A separate Git object-completeness preflight covers the pinned scanner's failure to propagate a missing historical object.

`controlled-replay.json`, `previous-workflow.txt`, and `source-binding.json` bind the preserved baseline, corrected workflow, actual test files, timestamps and hashes. Published helper paths are placeholders; originals remain privately retained. The replay runs current regression tests with the preserved workflow and then restores corrected bytes in `finally`. This is retrospective RED/GREEN, not an assertion about original implementation order. `native-before.log` retains both failures; `all-after.log` records 66 passes and zero skips, including nine real native histories. Earlier failed fixture attempts are explicitly retained as earlier attempts.

Reproduce from this PR in a fresh isolated checkout with Node 24.19.0 (recorded local execution used 24.21.0), pnpm 11.19.0 and the verified Gitleaks 8.30.1 executable. Set `ECORP_GITLEAKS_BINARY` to that verified executable, then run `node --test tools/secret_scan.test.mjs tools/secret_scan_native.test.mjs`. The native tests create disposable Git histories and fixture-only detector configuration, exercise the actual inline workflow reporter, and clean only their owned fixtures. The partial-timeout case uses bounded fixture-only Git text conversion. For the baseline replay, preserve the current workflow, temporarily replace it with `previous-workflow.txt`, run the two named regressions from `controlled-replay.json`, and restore the exact preserved workflow in `finally` before the complete passing run. No production detector, ignore input or repository policy changes are needed.

Author-side inspection checked checkout identities, scanner installation order, process separation, untrusted metadata, native exit semantics, history completeness, cleanup and source preservation. The nine current-main gates passed separately; their ordinary Node lane correctly skipped the native fixtures because its opt-in variable was unset. The separate 66-case native run is the source of native acceptance, not those skips. Required independent review, code-owner and last-push requirements remain GitHub decisions.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
