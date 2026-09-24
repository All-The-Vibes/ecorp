# PR #304 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Reject incomplete PR title/body/URL metadata before inventory fingerprints and detail reads. Use one literal Git-ref validator for inventory and every new live sync/publication snapshot, preserving historical v1/v2 journal compatibility and valid nested/Unicode branch names.

All nine contributor gates and 572 separate package/snapshot/executor-state tests passed on the same staged source. This covers local CLI input admission and historical replay, not reviewer authentication or application/provider acceptance.

The nine required commands passed on source head `16f4fb5ec0a179541b9aac9100fd5c3def149162` with staged tree `c97338af9bb83055a493fc4f38f7047b79fd1418`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The final complete suite passed 572/572 with no failures, cancellations or skips. The retained retrospective six-test baseline had one passing control and five failures; the candidate passed all six. Their input hashes and printed outcomes are retained. The complete final suite receipt supplies its actual command and source identity. No original development chronology is claimed.

`executor-regressions.json` binds the retained original and published log hashes.

The collector now requires a string title, an explicit nullable-string body and the exact expected GitHub pull URL before fingerprinting metadata or fetching PR details. New live `sync`, `published` and `progress-published` snapshots reuse the collector's literal branch validator. Immutable v1/v2 replay is deliberately unchanged; invalid historical spellings remain historical data, not newly authorized publication scope.

This is validation-tooling work. The contributor skill files are candidate PR content, not instructions activated for this completion pass. The retained rendered image is a test-result report, not a product screenshot. Node 24.21.0 was used locally; the repository pin remains 24.19.0. Hosted checks and independent eligible latest-push/CODEOWNER approval remain separate protected-merge gates.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
