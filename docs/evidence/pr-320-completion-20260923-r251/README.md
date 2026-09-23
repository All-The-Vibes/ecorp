# PR #320 completion evidence

Date: September 23, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Validate the OAuth redirect together with resource, browser and UI URLs before provider construction. Production requires HTTPS; explicit development loopback remains supported. Reject embedded credentials, queries and fragments without reflecting their values.

All nine contributor gates and 14 owned Keycloak browser/server/runner acceptance checks passed on the same current source tree. The four-field URL regression runs in the Rust workspace gate. The Node gate passed 1302 tests.

The nine required commands passed on source head `2ebdcef90e8fd2f54a32c2da9e91cb034fb1fe45` with staged tree `4068fc0ae7c03042b6f64c53074eeb705d1401e0`, incorporating main `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

Automated synthetic Keycloak 26.7.4 with development principals and owned PostgreSQL. Live Azure/Entra is NOT_EXECUTED; this does not establish production identity or OS isolation, or close issue #285. SQLx and startup-negative results in the prior packet retain their original execution dates and source binding; neither lane was rerun for this URL-only correction. Local Node was 24.21.0; the repository pin remains 24.19.0.

The contributor and fresh full-stack lanes share the same tested Git tree. `source-binding.json` records implementation hashes, exact product captures, original/published logs, binary receipts, the executed driver and unchanged prior packet. The redirect is checked before provider discovery or any persistent startup effect. Tests cover each of four URL fields in development and production, plaintext non-loopback, embedded user information, queries, fragments and malformed input with secret-safe errors.

The fresh stack exercised preview, release and persisted verifier completion on the original assignment, protected-resource authorization, callback replay, cross-actor/run denial, expiry, subject mismatch and cancellation races. All exact owned processes were stopped; fixture data and failed historical evidence remain preserved. For replay, use the recorded supervisor with a new QA root and installed runtimes, then the repository `tools/qa_delegated.ps1` ownership contract.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
