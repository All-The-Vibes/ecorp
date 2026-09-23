# PR #362 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Canonicalize only the trusted test-owned temporary root before copying evidence, including macOS /var aliases; retain the production verifier boundary unchanged.

All nine gates and fifteen exact-staged-byte verifier regressions pass on Windows with no skips. The original hosted macOS failure, controlled fixture baseline and earlier diagnostics are retained. Hosted macOS acceptance requires the new workflow run.

The nine required commands passed on source head `b31d075fc1be2fba5e44e3ff68c5bb2aad49bbeb` with staged tree `622a40b2bb3d8c341c4fbde75b323d313fd7f7f6`, incorporating main `de12261d045ddfccf790bcfd04a7fa254563d456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The hosted macOS job failed because Python's trusted temporary directory had a lexical /var alias. The production verifier correctly rejects aliased input ancestors. The fixture now resolves the allocated trusted root before placing packet copies beneath it. Every malicious root, ancestor, directory, reference and file negative remains enforced by the unchanged production verifier.

The added regression supplies an owned physical directory through a real Windows junction or Unix symlink and checks that copying targets the canonical root. It then actually executes the verifier. The retained r8 baseline fails the canonical-root assertion before verifier invocation. The earlier r6 allocation hang and r7 copy error remain separately labeled diagnostics.

The exact Git-byte run exports and checks 64 files, passes all 15 regressions with zero Windows skips, and checks 87 archive members, 111 manifest rows, 14 capture-log hashes and 38 corrected members. This is local Windows verification; hosted macOS results must be observed after publication. No new application-runtime acceptance is claimed.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
