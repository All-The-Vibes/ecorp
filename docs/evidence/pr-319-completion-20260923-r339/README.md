# PR #319 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Disable lazy fetching for every source Git invocation and reject repository-local alternate object stores before dereferencing HEAD. Preserve the existing tracing/include/filter guards, fresh temporary-index attestation, unsupported-index rejection, real source/index/environment, and final HEAD recheck.

All nine contributor gates passed, including one bounded retry of the full Rust workspace after an index-write failure. The original failure remains preserved and its cause is unproven; the isolated failed test passed five repetitions. The retrospective object-source baseline passed one and failed nine cases; the unchanged test inputs passed all ten after the correction. Fresh complete native Windows source-attestation coverage also passed. No multiplayer runtime acceptance is claimed.

The nine required commands passed on source head `b690103f4df127ecddabde75d943348e8a2ad131` with staged tree `ef4dfa5d519079e69b57c15b1dd952e956a272c8`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Retry provenance: Original workspace failure is retained. The unchanged-source isolated deliverable test passed five consecutive runs; this bounded retry re-executes the complete failed Rust workspace gate. The cause of the original index-write failure remains unproven.

The first failed receipt and failed-command logs are preserved under `prior-attempts/`; normalization and separate original/published hashes are recorded in `validation.json`. Successful command logs were retained byte-for-byte before publication normalization.

Define multiplayer development gates and an isolated Windows U1 preflight that validates physical paths and source identity before creating runtime resources. G0 requires the retained R1-R14/M01-M37 inventory, reviewed MP1 crosswalk and differences, and exact reviewed adoption bytes together. Refs #318; this preparation/proposed-contract work does not close it.

Production APIs and runtime code are unchanged by this correction. Source identity is tested using actual Windows Git promisor and alternate stores without network transport; the control proves object materialization and the corrected preflight forbids it. Baseline and candidate use identical test bytes. This does not establish #240 runtime acceptance, #242 independent browser-auth review, #249 release qualification, or completed #318 adoption. The prior Rust index-write failure and its full log remain under prior-attempts; no product fix or root cause is inferred from the five isolated passes and subsequent passing complete workspace gate.

Windows x64, Node 24.21.0 (repository pin 24.19.0), pnpm 11.19.0 and Rust 1.98.1 were used. Report images are Edge captures of actual saved results. Existing historical evidence retains its original scope and source. The source here incorporates the main commit recorded in validation.json; subsequent main integration and hosted CI/security checks remain necessary before merge. Maintainer self-review is distinct from an independent review.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
