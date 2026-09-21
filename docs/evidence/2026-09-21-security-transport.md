# Security transport regression evidence — September 21, 2026

This is candidate repair evidence, not a claim that the changes are merged or deployed.

## Boundaries repaired

- CLI and every gateway mode validate the configured API origin, require HTTPS outside
  explicit loopback development origins, and refuse redirects. Loopback requests bypass proxies.
- The gateway's parsed origin is private. Relative requests cannot replace it, MCP room IDs
  are parsed as UUIDs, and unauthenticated A2A refuses non-loopback listeners.
- Secret encryption uses the existing AEAD library's OS-random nonce generator without changing
  the 12-byte stored nonce, ciphertext format, key selection, or associated data.
- The Factory test proxy returns a fixed 502 body and logs only an allowlisted diagnostic
  category. The startup TLS fixture explicitly requires TLS 1.2.

CodeQL's reported UUID sources in alerts #3/#4 are object identifiers rather than credentials.
The client transport nevertheless had real credential-exposure risks, including custom publisher
headers on redirects. The repair addresses those risks rather than renaming scanner sources.
No alert dismissals, scan exclusions, threshold changes, or branch-policy changes are included.

## Local verification

Windows x64; Rust/Cargo 1.98.1; Node 24.16.0; pnpm 11.19.0. Hosted CI uses the repository's
separately pinned Node versions and remains required for the committed candidate.

All nine contributor gates returned zero: migration and documentation checks, Node unit tests,
steward tests, Rust formatting, strict workspace Clippy, workspace Rust tests, web build, and lint.
The final Rust receipt used an isolated worktree-specific target directory.

Additional checks:

- Compiled native MCP/probe/receipt tests: **99 passed, zero skipped**. Both MCP modes now
  reject redirects; the previous unrestricted-redirect expectation was corrected.
- CLI transport tests: **2 passed**; gateway tests: **18 passed**. Negative network operations
  have bounded, failure-producing timeouts. Redirect destinations receive no request.
- Actual proxy-function regression: **1 passed**, covering fixed public error output and
  non-disclosing diagnostic categories.
- Python harness tests: **5 passed**, including a certificate-verified TLS 1.2 connection and
  exclusion of unrelated ambient credentials from child processes.
- Complete opt-in startup regression: **passed**, including invalid-configuration nonmutation,
  secret-safe CLI/help output, and production startup against owned TLS storage with 32- and
  33-byte signing keys. Its owned containers and temporary infrastructure were removed.

The deliberately stripped Windows test environment needed `SystemRoot` for native networking.
An A/B probe isolated that requirement; only this OS variable is forwarded, not the ambient
environment. OpenSSL is resolved from PATH or an existing Git for Windows installation.

Reproduce the additional portable tests:

```text
cargo test -p crony-cli transport::tests
cargo test -p crony-gateways
node --test tools/security_fixtures.test.mjs
python -m unittest discover -s tools -p test_startup_validation_harness.py
```

For compiled MCP checks, set `CRONY_MCP_TEST_BINARY` to the candidate's absolute executable path
and run the three test files used by CI. For the owned startup drill, run
`tools/test_startup_validation.py --server-binary <absolute-candidate-path> --allow-disposable-docker`;
Python 3.10+, OpenSSL, Docker, and a locally available `postgres:17-alpine` image are required.
Do not point these tests at the retained manual stack.

Independent code-review and architecture lanes approved the source and the narrow Windows
harness follow-up. These local reviews do not substitute for human PR review or hosted CI.
Earlier failed attempts and load-sensitive local test receipts remain in the operator worktrees;
only successful final receipts are used above. Ordinary ignored SQLx cases are not represented
as passing local tests.

## Separate dependency finding

Dependabot alert #1 (`GHSA-wrw7-89jp-8q8g`, GLib) is not fixed by this transport patch.
The inspected published Tauri 2.11.6 dependency graph still requires GTK/GLib 0.18, whereas the
advisory's fixed GLib versions start at 0.20. The alert remains open; there is no version spoof,
unreviewed fork, vendoring change, or risk-acceptance dismissal in this PR.
