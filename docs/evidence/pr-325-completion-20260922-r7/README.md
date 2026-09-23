# PR #325 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Pin the native process handle and creation time, await bounded child readiness, then refresh and verify the exact image before control. Repeat all eight handoff cases at zero and 250 ms readiness delays. Admit the exact macOS managed Chromium basename Google Chrome for Testing with negative allowlist controls. Retain both workflow snapshots and a new locally executed exact run block with separate Git and checkout hashes.

Nine contributor gates, 16 native Windows handoff cases, 16 cases from a separate local execution of the exact CI run block, and installed-Edge module/CLI desktop/mobile verifier acceptance passed on the same staged source. Browser-policy tests: 85 passed and two Unix-only skips. No native macOS execution or browser-to-application-server/provider acceptance is inferred.

The nine required commands passed on source head `1a98eabd1a462d0e522fbc960d5d22735aa56c05` with staged tree `4398a8b5a7d01e02afce88172b112250d7943039`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The Windows fixture keeps its original native handle and creation-time pin across the bounded readiness wait, refreshes the image observation, and requires the exact ready image before writing a release file or terminating that handle. An unverified child is left to its existing bounded self-exit lease. Both normal and literal/bracket launch routes run valid, invalid, empty and absent policy cases at zero and 250 ms delays: 16 cold launches pass. A separate run executes the actual two-line CI command block locally and passes the same 16 cases. These are separate overlapping runs, not 32 distinct behaviors.

The macOS managed executable allowlist now includes only the exact additional basename `Google Chrome for Testing`. Focused controls reject near names, changed case, arbitrary tools and the wrong browser family. This is a source-contract regression on Windows, not native macOS browser acceptance. The fresh 87-test policy suite has 85 passes and two Unix-only FIFO skips.

The fresh raw checkout workflow snapshot reproduces the disputed historical SHA-256 `c8c14cac19c397727a55287ab686871cb40fe8ad2019efbcaeb3cbbe37fc543e`. Its canonical Git snapshot has SHA-256 `e717f1d0c908e676d774073faf282cd03d3049bce6554d75c658be88f60050d6`; the retained bytes differ only by line endings. The earlier receipt is preserved unchanged. The r8 receipt inherited wording that the old hash remained unsupported; `workflow-hash-clarification.json` corrects that sentence using the now-retained snapshots. This is a newly established mapping and execution, not proof of historical execution chronology. The extracted step hash is also recorded. `GITHUB_WORKSPACE` names the fresh private output root while the source worktree is the working directory; this is a local run, not a hosted Actions claim.

`native-browser/` contains genuine current-source Edge module/CLI desktop/mobile captures. `handoff-results.png` is a genuine browser capture of the retained cold-launch results, and `validation.png` is a saved-results report. Earlier failures, eight-case runs and scope/retention baselines remain in the previous packets under their original scope. Local Node is 24.21.0; the repository pin remains 24.19.0. All newly claimed runs bind to the nine-gate staged tree. No application-server or provider run is inferred.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
