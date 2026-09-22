# PR #338 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Merged current main, reviewed equivalence cases, and passed strict Rust 1.94 Clippy plus focused gate receipt tests alongside all nine default-toolchain gates.

Equivalent gate-receipt object validation with Clippy compatibility at the declared Rust 1.94 MSRV; no runtime behavior change.

The nine required commands passed on source head `1b0f89b5fdd54f221d137d49fe4b49f16a385692` with staged tree `9ec6df909a798405c2c56b0ce647b8432a8e8170`, incorporating main `410eddfc8bfcfa874dae05555128d39a914f0456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

## Declared minimum Rust version

`msrv-validation.json` and its two retained logs record strict workspace Clippy and focused retained-provider-receipt tests on Rust 1.94.0. This supplements the nine default-toolchain gates. The change preserves the optional JSON-object check semantics, including absent and non-object values. No production runtime behavior change is claimed.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
