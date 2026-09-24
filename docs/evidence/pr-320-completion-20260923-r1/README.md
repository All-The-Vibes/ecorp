# PR #320 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Keep delegated provider identities separate from production login identities. Hold live execution, room, identity and authorization-generation authority through ticket consumption, provider effects and release. Make cancellation reflect durable state, reconcile failed-cancel UI controls without reviving stale responses, and erase expired credentials through bounded server-owned recovery. Prepare provider configuration before persistent startup effects, normalize accepted digests, and use retained process handles and explicit owned-stack admission in native acceptance.

All nine contributor gates passed. Owned PostgreSQL executed all nine delegated authorization regressions, including distinct login sub/provider oid, revocation-before-effect, serialized cancellation/release and callback replay. Real-binary startup checks passed against both empty and seeded owned storage. Fourteen owned Keycloak browser/server/runner checks passed, including original-run verifier completion, protected artifact digest, private preview/release and delayed-authorization cancellation.

The nine required commands passed on source head `765aff1f8dd812cf68620177f77e722860a9ecab` with staged tree `f1a91739839dca0edbf994af3c66c2780a5518a3`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

All Rust and web implementation/test bytes and all migration SQL bytes match across these successful runs. After SQLx, the manifest registered the already-tested 0044 SQL; the Keycloak launcher then received a shorter owned Java socket directory. Full-stack acceptance includes that launcher fix. Main then added only docs/EVALS.md and historical PR273 evidence. The nine final gates cover the final integrated tree.

The original r2 launcher receipt remains running historically. Its continuation independently verified exact process/binary ownership, completed all 14 acceptance checks, and stopped only owned fixture processes. The earlier receipt was not rewritten.

Earlier failed attempts include setup/test defects and are preserved as such. No original TDD chronology or unchanged-test behavioral RED is inferred.

This is automated synthetic acceptance with Keycloak 26.7.4 and development principals. Live Azure/Entra, production identity acceptance and operating-system isolation were NOT_EXECUTED. The broader #285 SQL/hosted-OBO acceptance remains open. Local Node was 24.21.0; the repository pin is 24.19.0. Successful local checks do not replace fresh hosted checks or eligible protected review.

The three browser PNGs are genuine application captures from this owned Keycloak run. The validation image is a separate rendered results report. The native SQLx tests execute with `cargo test --locked -p crony-server delegated:: -- --ignored --test-threads=1 --nocapture` against a newly provisioned owned PostgreSQL maintenance database; SQLx creates disposable test databases. The startup driver is `tools/test_startup_validation.py`; the Keycloak launcher is `tools/qa_delegated.ps1` and browser driver is `tools/e2e_delegated.mjs`, with the explicit ownership/source/port variables defined by those tools. Never point these mutating fixtures at a retained shared office. See their existing admission contracts for first-run inputs.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
