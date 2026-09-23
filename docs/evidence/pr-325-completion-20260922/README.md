# PR #325 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Merged current main, normalized Windows short-path test expectations with realpath, hid child windows, and verified module/CLI selection plus fail-closed hash, host and missing-executable cases.

Operator-owned installed-browser selection with exact host, platform, executable and SHA-256 binding; actual deterministic browser and arcade command-verifier acceptance.

The nine required commands passed on source head `1317618cef002977f0c56a5f075844d38e29eb20` with staged tree `3d486113647f50aa3310400948752f1595b6512c`, incorporating main `410eddfc8bfcfa874dae05555128d39a914f0456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

## Native installed-browser acceptance

`browser-acceptance.json` records the actual browser module and CLI-selection paths, each exercising the arcade command verifier on desktop and 390-pixel mobile layouts using the declared, SHA-256-checked Edge executable. Wrong hash, wrong host and missing executable all exited unsuccessfully without writing evidence. The fixture source was unchanged. The four PNGs are unmodified browser captures. This is browser/command-verifier acceptance, not ECorp full-stack or production-provider acceptance.

The original validation failed two Windows short-path expectations. `prior-attempts-provenance.json` retains that failed receipt and log, distinguishes the two tested source trees, and identifies the corrected native-realpath expectations. The full second validation passed all nine commands. It is not represented as a same-source retry or an original TDD chronology.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.
