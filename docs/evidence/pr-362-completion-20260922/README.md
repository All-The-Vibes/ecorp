# PR #362 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Integrated current main. Added fresh native subprocess tests for HTTP_PROXY and ALL_PROXY with NO_PROXY absent, covering CLI and read-only/read-write gateway requests to localhost and 127.0.0.1. The origin must receive the authorized request while the proxy receives no connection. Added the existing startup TLS/environment harness to Windows CI.

Native proxy-bypass regressions and Windows startup-harness coverage on the existing security remediation; fresh source-bound local validation, not production-identity or real-provider acceptance.

The nine required commands passed on source head `a6fe80fdd111e277b8ed286b9ad0e82b0c2a5c0a` with staged tree `6a3dcda7b8e28c5c7a5179885882590073450df6`, incorporating main `5f65e536f80e206082a8a819f2675c9b16210fce`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

Actual retrospective proxy-bypass effectiveness checks fail with the production no_proxy call removed and pass after exact-byte restoration. These are newly executed tests, not original development chronology. The separate Windows startup harness passed five tests. Prior September 21 evidence remains historical and is preserved.

`security-regression-logs.json` binds the retained original and published log hashes.

`proxy-effectiveness.json` binds the actual native failing/passing experiments and exact source restoration. `security-regressions.png` is an Edge capture of the explicitly labelled saved-results report. `REPRODUCE.md` supplies the focused commands, fixture configuration, expected output, and evidence boundaries.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
