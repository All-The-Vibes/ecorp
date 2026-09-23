# PR #341 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Accept exactly zero/zero native Gitleaks locations as path-only findings while preserving hashed attribution and exit 42. Keep positive ordered line validation for line findings, reject malformed mixed or noninteger ranges, and document both shapes. Exercise the actual pinned default pkcs12-file detector using harmless synthetic .p12 content.

All nine contributor gates passed. A fresh 76-case reporter/native suite passed without skips, including ten actual native histories. The retrospective pre-fix execution failed the two new path-only cases. Detector and suppression policy are unchanged; no application/provider acceptance is claimed.

The nine required commands passed on source head `5454066c616bb73bb1cc6edd651a20bee190531b` with staged tree `bbaa4beab359d30c53679fdbdba06bc22f4dc581`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Build provenance: Workspace package artifacts are removed under the task Cargo mutex before Rust validation. Third-party dependency cache is retained. Node tests use a freshly built copied native MCP binary. `validation.json` also binds the workspace-refresh and MCP-build logs, their original/published hashes, and the copied MCP binary hash.

The new default-rule native fixture writes harmless synthetic `.p12` text. It creates no credential or certificate, changes no production detector or suppression, and invokes the verified Gitleaks 8.30.1 executable. Native zero/zero findings now retain hashed file/rule/finding attribution, explicit path location and exit 42. Positive ordered line results retain their prior shape. Mixed zero/positive, negative, string and fractional ranges remain diagnostic failures.

The retrospective baseline ran the added tests against the previous reporter and failed the reporter and real-native path-only cases. The corrected combined suite passes all 76 tests with no skips, including ten real native histories. This is an actual new native execution; the historical 66-case evidence remains in prior packets and is not relabeled. The baseline/candidate receipts retain exact scanner and source hashes. The ordinary unit gate may omit explicitly opt-in native histories; their execution is established by this separate receipt.

The production path still scans the selected head and full ancestry without executing selected-head fixtures. Free-form metadata stays hashed, partial scans remain incomplete, and native failure semantics remain nonzero. This repairs diagnostics; the old behavior was not a false-green scan or a secret disclosure. Local Node is 24.21.0 while the repository pin remains 24.19.0. No UI/provider or production acceptance is inferred. The report screenshot renders saved results; it is not an application-runtime capture.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
