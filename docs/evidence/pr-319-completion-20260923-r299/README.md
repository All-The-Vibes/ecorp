# PR #319 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Reject inherited Git tracing and repository includes before effectful Git work; reject gitlinks before recursive status; compare source through a freshly populated owned temporary index instead of trusting the real index stat cache; preserve the real index and restore environment state.

Current-source native Windows source-attestation revalidation, all nine contributor gates and retained historical failures. Preparation and proposed-contract scope only; no new multiplayer browser/runtime, production identity, provider or release acceptance.

The nine required commands passed on source head `beddfcd9fe098ea635237afefafa55e65f52ef32` with staged tree `6ffaa13d585d6ed67f5a4465f8afb31c11fbb2c2`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

`current-revalidation/native.log` is a fresh complete native Windows execution against the source bound in `source-binding.json`. It includes same-size/restored-time and ordinary dirty controls, clean controls, rejected gitlinks before child filters, tracing/includes, replacement refs, hidden index flags, source/configuration/index preservation, Windows alias and tool-selection checks. Exact executed raw input hashes and their CRLF-to-LF bridge to staged blobs are verified.

The earlier r4 clean-filter hashes cannot be independently bridged to the current source representation. They are preserved, not replaced. The new current-source execution satisfies the requested alternative; retained prior failures remain in `prior-baseline/` and `prior-attempts/`. Baseline and final test hashes differ and are disclosed separately.

This remains non-closing preparation work for #318. G0 still requires retained-original inventory, reviewed crosswalk/differences and explicit adoption; #240 runtime, #242 independent browser-auth and #249 release qualification are separate. Temporary-index creation/removal is explicitly reported and never refreshes the real index.

Exact native invocation from the retained driver: `pwsh -NoLogo -NoProfile -NonInteractive -File tools/qa_multiplayer_preflight.test.ps1`. The published driver normalizes only the local worktree path and text whitespace; its original/public hashes are separate.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
