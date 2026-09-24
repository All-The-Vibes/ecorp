# PR #319 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrated current main, strengthened Windows path/source-identity controls and genuine alias regressions, and aligned the emitted G0 blocker with the retained-original inventory, reviewed crosswalk/differences and exact adoption requirements. Two exact historical scanner fingerprints cover the original ordinary-prose finding at commit 6fe6668479417a2df43dbe1f7e471b4dec21457a and its copy in the explanatory comment at commit f284775268d0ca76b40cf3de92744904e2b5827d. That current comment now uses neutral wording. No pattern-wide exclusion was added. Both earlier evidence packets and failed scans remain unchanged.

Fresh nine-gate validation after the second exact-fingerprint secret-scanner false-positive suppression. Native PowerShell preflight coverage is retained and explicitly bound to the unchanged implementation and test files by SHA-256 and Git-tree equality. This is preparation and proposed-contract coverage, not U1 browser/runtime acceptance or adoption of the MP1 contract.

The nine required commands passed on source head `f284775268d0ca76b40cf3de92744904e2b5827d` with staged tree `fa2d24aba74c565e0cc8d6fe5b69cb1e1ddccb66`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The native suite previously passed on staged tree ffe63d4d70fa05fd2e572ef845a4261f8691bf18. Its PowerShell implementation/test bytes are unchanged in the new nine-gate tree; native-source-binding.json records their hashes and the checked Git-tree equality. The original baseline/candidate controls remain in the unchanged first packet. Native .NET already expands genuine short aliases; the baseline fails the G0 text assertion, not a demonstrated alias escape.

`native-preflight.json` binds the retained original and published log hashes.

Issue #318 remains open: the original retained R1-R14/M01-M37 artifacts are needed for the source-bound inventory, reviewed MP1 crosswalk/differences and exact adoption together. The proposal is not adopted by this PR. Preserve #242 independent browser-auth review, #240 U1 runtime acceptance and #249 release obligations.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
