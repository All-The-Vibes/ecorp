# PR #359 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Supply the saved-room repair's behavioral baseline/candidate proof, and accurately describe durable-key read/write failures and guarded best-effort cleanup.

Nine current contributor gates and one actual saved-room SQLx scenario run retrospectively against the old and corrected planners. Existing source-bound native/browser acceptance remains in r3; it was not rerun for this documentation/evidence correction.

The nine required commands passed on source head `d360d3bd1001d8cb9baff0323408865de6c42a6b` with staged tree `a93a4def1ffecc4ca856d00aac3e903f57399254`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

## Saved-room retrospective

The actual `factory_connection_tests::issue48_planner_reuses_pins_in_the_saved_connection_room` scenario ran against two source variants on one fresh authenticated, loopback-only PostgreSQL fixture. The historical planner failed at the assigned-agent behavioral assertion (exit 101); the corrected planner passed the same one test (exit 0). The complete test and current store were identical in both variants. The old planner came from immutable commit `85fc88f037ee71531cf6c945f2a2fdc86be82e4b`. Its only interface bridge supplies `None` to the current three-argument store API, preserving the former default-room lookup. Commands, source hashes, timestamps, complete logs and the baseline patch are retained under `retrospective/`. This is retrospective evidence, not original development chronology.

To reproduce, use an isolated checkout at this candidate, provision an owned disposable PostgreSQL database, and run `cargo test --locked -p crony-server factory_connection_tests::issue48_planner_reuses_pins_in_the_saved_connection_room -- --exact --ignored --nocapture --test-threads=1` with that fixture's `DATABASE_URL` supplied through the test process environment. In a second isolated checkout, apply `git apply --unidiff-zero retrospective/baseline-planner.patch` to restore the exact historical planner plus interface bridge, leaving the test/store unchanged, and run the identical command. Expect the old planner's assigned-agent assertion to fail and the corrected planner's test to pass. Do not use a shared database or modify the configured source checkout. Exact owned PostgreSQL cleanup was verified; database, credential and source fixtures remain retained locally. Environment-only database credential delivery is reduced assurance.

## Corrected cleanup statement

The r3 README now says storage reads/writes and key acquisition fail visibly before dispatch. `sessionStorage.removeItem()` cleanup is intentionally guarded best-effort; a retained key remains replay-safe. The helper's working behavior is unchanged. `retrospective/prior-r3-README.md` preserves the prior claim and its original hash. The source-binding receipt proves the native/browser implementation and the retrospective test match the previous accepted source. No unrelated acceptance was rerun.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
