# PR #273 completion evidence

Date: September 22, 2026. Maintainer completion pass performed under the existing ECorp-only authorization.

Merged current main, verified every original evidence digest, retained historical bytes, and ran fresh desktop and 390-pixel report interaction QA.

Frozen single-program ProgramBench report: 200/224 cases passed, 24 failed; 1/200 programs executed. Current-main compatibility checks and separate offline browser QA do not rerun or repair benchmark results.

The nine required commands passed on source head `578ff3b1f6b2ea2e80a6edc6781e08db819292b4` with staged tree `b1199b74b9c82e54e113b3ae9172a7991db01a8e`, incorporating main `410eddfc8bfcfa874dae05555128d39a914f0456`. `validation.json` binds the commands, tool versions, statuses and log hashes. Local user and checkout paths in the published logs are normalized; original hashes are also retained. The evidence files added here are subsequent documentation of that tested tree, not a claim that a not-yet-existing commit was executed.

`validation.png` is a genuine Edge screenshot of `validation.html`, rendered from these saved results. It is a test-report capture, not an application screen. Full result lines, including opt-in ignored tests, remain in the logs. No original RED/GREEN development chronology is inferred from retrospective validation.

Reproduction: use an isolated checkout of the PR, install the repository-pinned Rust/Node/pnpm toolchain, run `pnpm install --frozen-lockfile`, and execute the nine commands listed in `validation.json`. Set `RUST_TEST_THREADS=1` for the recorded Windows test configuration. Build the repository's native `crony-mcp` binary and set `CRONY_MCP_TEST_BINARY` to that owned binary for native MCP unit coverage. These results do not substitute for fresh hosted checks, required independent reviews, or production identity/provider acceptance.

Maintainer self-review: inspected the final implementation and its current-main integration against the product, architecture, security and evaluation contracts. Only evidence documented here is claimed; existing historical reports retain their original scope and limitations.

Native Git received `core.longpaths=true` through process-only Git configuration for the recorded commands. Repository and global Git configuration were not changed.

## Historical report browser acceptance

`report-browser-acceptance.json` records actual offline Edge checks at 1440-pixel desktop and 390-pixel mobile widths: all 224 rows, 200 passing and 24 failing cases, search/status filtering, failure disclosure, an exact JSON download, and print expansion followed by restoration of the filter. There were no page errors, external requests, or document overflow. Both PNGs are unmodified captures. The frozen benchmark HTML, JSON, hashes and score remain unchanged; no benchmark rerun or repair of its 24 failed cases is claimed.

Trailing line whitespace and blank lines at EOF are removed from the published logs. This formatting normalization does not alter test-result text; original and published hashes are distinct. The local `.gitattributes` preserves published evidence bytes on checkout.

## Browser receipt provenance correction

`original-browser-acceptance.json` retains the exact original browser-acceptance receipt bytes. `original_browser_acceptance_receipt` names and hashes that file. The initial completion packet called this field `original_report_sha256`, which was ambiguous: it described the pre-publication browser test receipt, not the frozen benchmark HTML. `report_sha256` continues to identify the unchanged frozen HTML; `report_data_sha256` identifies its unchanged JSON data. This metadata correction retains the original receipt and changes no evaluated code, benchmark result, screenshot or test log. The original published packet remains recoverable in commit 65cd91792b752821bcdda74c3e6fc519a03dc108.
