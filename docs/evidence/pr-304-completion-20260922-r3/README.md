# PR #304 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Require explicit boolean draft state for every new live sync and publication snapshot while preserving historical v1/v2 replay. Validate source and target Git refs before processing inventory details; reject malformed/missing source refs without discarding valid nested or Unicode branch names. This fresh packet supersedes older packets for current-source validation; historical evidence remains unchanged and is not reused as proof of this source.

Nine contributor gates and 566 separate package/snapshot/executor-state tests passed on the same staged source. This is local CLI and policy-tooling validation, including immutable historical journal replay. It does not authenticate reviewers or claim application-runtime/provider acceptance.

The nine required commands passed on source head `8f9d76c24eea69038ea25b4f39a5f475f8b46011` with staged tree `ea803db5e705a70a88378e075d0c92e623f3f592`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The final complete suite passed 566/566 with no failures, cancellations or skips. The separate baseline/candidate logs retain retrospective live-draft and malformed-source-ref controls; they are not an original development TDD claim. Current evidence is the final suite and nine gates, both bound to the same staged source. Prior packets remain historical.

`executor-regressions.json` binds the retained original and published log hashes.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
