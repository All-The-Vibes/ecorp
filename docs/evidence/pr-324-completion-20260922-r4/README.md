# PR #324 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrated main 5f65e536f80e206082a8a819f2675c9b16210fce. Removed inherited tracing case-insensitively from all three native exporter Git builders, including reset, while preserving the checker protection. Added a real Rust exporter/checker regression over eight tracing variants.

Source-bound current-main contributor checks and actual native checker/exporter parity under inherited Git tracing. No application runtime or production-provider acceptance is claimed.

The nine required commands passed on source head `0484cfe02987328f18fc25b86d2e9a917e00ddc6` with staged tree `13ffe18142167b1cd64e711cfed2d226739669b5`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

An actual native-exporter mutation test reproduces the reported mismatch with tracing removal disabled (exit 101); the restored implementation passes (exit 0). The final test invokes both the real Node checker and the real Rust exporter, compares their trees and tracked changes, and asserts no trace file, source drift or dirty worktree. This is retrospective defect regression evidence, not original TDD chronology. Owned fixtures and failed attempts are retained.

`native-export-regression.json` binds the retained original and published log hashes.

This correction addresses the HIGH finding in review 5280262431. The exporter has a single small tracing scrub applied at each existing Git command boundary; no new exporter abstraction or ignore rule was added. The original retained reports remain unchanged. Two unsuccessful probe attempts are preserved: the first selected the wrong Cargo target, and the second stopped at Windows short-name root spelling. Neither is represented as defect RED/GREEN evidence. The third attempt used Git-reported canonical root spelling and the actual native exporter.

Reproduce the focused check with cargo test --locked -p crony-runner --bin crony-runner deliverable::tests::native_export_matches_checker_under_inherited_tracing -- --exact --nocapture --test-threads=1. Node and Git must be available. Each variant retains its independent synthetic repository, exporter JSON, checker outputs and parity receipt outside the source checkout. The mutation helper is retained for the bounded before/after check, with original and published hashes and explicit path placeholders.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
