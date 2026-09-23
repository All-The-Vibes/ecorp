# PR #362 — R14 saved local evidence

September 23, 2026. **Nine local gates passed on the frozen input below.**
This is public evidence packaging, not a new code review, test run, approval,
Santa/NICE verdict, all-CI-green claim or permission to publish/merge.

## Executed input, not a self-referential final commit

| Identity | Recorded value |
| --- | --- |
| HEAD | `a3f755687f0a6778dc0bc655e38b4b130643d04c` |
| MERGE_HEAD | `3195fd7f15cb43946f9705640568551cdc6a57e3` |
| Executed staged tree | `f127601f8885288e9b87f7569b85a647103a68bd` |
| Recorded target | `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819` |
| Validator completion | `2026-09-23T08:55:50.038660+00:00` |

The validator executed this input **before this directory existed** and closed
with 26 recorded direct processes exited. This packet adds only documentation
and saved-result derivatives. It does not claim that a later packet-bearing tree
or final commit received those runs. The packaging preservation receipt binds
the unchanged input/index and the new-directory-only output delta.

Start with [results-summary.json](results-summary.json), then
[provenance.json](provenance.json) and [SHA256SUMS](SHA256SUMS).
The summary is deliberately **not the raw private driver input** and makes no
schema-compatibility or replay-input claim. The genuine raw-nine receipt remains
private, SHA-256
`dcdc17d4c234ff1c1b161f8d8d3b026a1282bdb07119fe85df7e613d889934be`.

## Recorded results

| Gate | Result | Seconds | Public log |
| --- | --- | ---: | --- |
| Migrations | Exit 0 | 3.797 | [migrations.log](migrations.log) |
| Documentation | Exit 0 | 4.297 | [documentation.log](documentation.log) |
| Node unit | 1,254 passed; 0 failed/skipped | 87.672 | [node-unit.log](node-unit.log) |
| Steward | 227 passed; 0 failed/skipped | 90.469 | [steward.log](steward.log) |
| Rust format | Exit 0 | 9.532 | [rust-format.log](rust-format.log) |
| Rust clippy | Exit 0 | 19.828 | [rust-clippy.log](rust-clippy.log) |
| Rust workspace | 580 passed; 0 failed; **343 ignored** | 535.515 | [rust-workspace.log](rust-workspace.log) |
| Web build | Exit 0 | 16.437 | [web-build.log](web-build.log) |
| Web lint | Exit 0 | 9.766 | [web-lint.log](web-lint.log) |

[focused.log](focused.log) contains separately labelled, complete saved logs:

- Source-native MCP build, exit 0, before Node tests; incremental cache reuse,
  not a clean rebuild or foreign copied binary.
- Complete Python evidence discovery: **69 passed**, no failures/skips.
- Portable helper: **3 packets, 233 archive members, 25 images** verified.
- Startup harness: **5 passed**; not a full Docker/startup drill.
- Actual staged driver plus its regression log: **67 exact staged files,
  69 passed**. This repeats the same suite, **not 69 extra unique tests**.
  The driver checked 87 gauntlet archive members, 111 manifest rows and
  14 capture logs. The summary retains all 67 executed-file digests.

The full contribution contains **370 paths, 19 outside evidence**. The current
correction against MERGE_HEAD contains **12 paths**. Exact inventories and
source hashes are in the summary. The attributable
[automated author-delegate report](author-review.md) and
[receipt](author-review-receipt.json) describe the actual source/caller checks,
findings and evidence limits. Their verdict is `PASS_AUTHOR_SIDE_SCOPE`,
clearing `R13-PRIVACY-01`; it is **not personal human self-review, independent
review, eligible GitHub approval or a new review by this packager**.
The receipt's `report_sha256` still identifies the private report; provenance
separately binds the public report bytes.

## Actual RED/GREEN and correction history

[metadata-history.log](metadata-history.log) preserves this ordered R12 work:

1. Unchanged current-a2 helper: original **63 tests passed**.
2. First five-case instrumentation attempt: **14 failures, 1 error**; retained.
3. Corrected pre-implementation RED: **10 failing subtests, 1 intentional
   regex-allocation error** across five tests; boundary controls passed.
4. Same five tests GREEN; final historical complete suite **68 passed**.

The five cases cover duplicate/case-alias image rows, image count/type admission,
README reference-count boundaries, unmatched markers and non-regex mixed-link
scanning. The actual correction admits fewer than 128 unique safe image rows
before payload reads and at most 128 README markers before reference lookups,
using forward string scans. It adds no parser framework or dependency.
Current integration retains the remote output-ancestor regression and expects
69 tests. The old 63/68 results are not repinned as current execution.

R12 later passed 9/9 on tree `357411ada84c17e310de767de12280c466b654c7`,
but did not qualify the subsequently advanced target. Its private Node-count
postprocessor and newline-framing diagnostic each exited 1; both remain failed
historical commands, not test failures or silently repaired original receipts.
R13 passed 9/9 on tree `7c66c96aabadce40b19e369598db8ce5475a059d` but
**overall failed public privacy**. Both failed privacy audits remain preserved.
R14 clears that finding; it does not rewrite R13's verdict.

[correction-evidence.log](correction-evidence.log) retains the R14 source/privacy,
whole-contribution and whitespace check outputs plus the corrected historical
output-alias baseline. The summary includes the parent correction record and
validator's exact two-span proof:

- Two escaped 27-byte home-prefix spans at lines 15 and 27 became `<user-home>`.
- **3,515 / 3,569 original bytes = 98.486971%**, not literally 99% unchanged.
  **100% outside those two spans** is unchanged.
- Original execution SHA-256:
  `bfa14a46c73adcacf83287d577a7f63a591ad90db35f9fc4757bf98a17492532`.
- Previous public SHA-256:
  `0ea135df64673bcf9064b5f2675e22deec1f502f4badcaad87f08d912d6454b9`.
- Corrected public SHA-256:
  `e10f4389f570ed39a7fc9eda0120dc9715c3de3617a7cedd810d13203d9acc22`.
- `Ran 1 test in 2.935s` and `FAILED (failures=2)` remain unchanged.
  This is a path-only derivative, not a new or passing baseline run.

The default old-HEAD staged whitespace check **exited 2**: 310 diagnostics in
six inherited PR #273 R3 files. Each flagged file equals both target and
MERGE_HEAD bytes, including CRLF. Target-relative and correction-relative
checks separately exited 0. No historical file was normalized or repinned to
silence that failure. The summary retains all six byte-equivalence bindings.

Recorded R14 audits covered 286 standalone public text files, 61 decoded PNGs,
123 matching logs across ten historical completion packets, 233 original
archive-member derivations, 331 scoped text/member scans and four rejected
outside-rectangle RGB/alpha controls. These are scoped byte/pixel checks,
not general DLP, OCR or independent image-authenticity proof.

## Reproduction

Use a separately authorized isolated checkout with the intended index frozen
and tracked working files matching it. Do not alter this retained checkout to
reproduce a historical tree. Use the repository-pinned toolchain and already
provisioned dependencies. Recorded versions: Node 24.19.0, pnpm 11.19.0,
Python 3.12.14 and Rust/Cargo 1.98.1. No install was invoked in R14.

The recorded Windows setup used an owned Cargo target/temp directory, two build
jobs, serial Rust tests, enabled Python assertions and no bytecode writes.
Build the native MCP binary from that source before Node tests and point
`CRONY_MCP_TEST_BINARY` at it. The recorded build was
`cargo build --locked --offline -p crony-gateways --bin crony-mcp`.
The supported SDK 1.0.11 / CLI 1.0.79 cache was reused and hash-bound; the older
R226 download deviation remains historical. No network-isolation claim follows.

Run the existing nine AGENTS commands:

```powershell
node tools/check_migrations.mjs
pnpm check:docs
pnpm test:unit
pnpm test:steward
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm build:web
pnpm lint:web
```

R14 added only `--locked --offline` to the actual Cargo clippy/test argv and
resolved pnpm through the bundled Node executable. Exact argv, times, statuses
and original stream hashes are in the summary.

Record a **genuine fresh raw-nine receipt** from those actual runs, beside their
unchanged logs. The existing driver's input requires `status: "passed"`,
`source_unchanged: true`, the actual `staged_tree`, and exactly nine unique
canonical `checks`, each with `name`, `program`, `arguments`, actual integer
`exit_code: 0`, a safe receipt-relative `log` and that log's SHA-256.
Record the real executions and preserve the raw streams; do not manufacture
successful rows, substitute this summary or repoint an archival normalized
receipt. See the existing driver's `REQUIRED_GATES` and admission checks.

Set `$Python` to the real Python executable, `$Repository` to that isolated
checkout, `$FreshRawNine` to its new receipt, and `$NewOwnedOutput` to a new,
nonexistent, unlinked owned output directory. From that checkout:

```powershell
& $Python -B -X utf8 -m unittest discover -s tools -p 'test_*evidence*.py' -v
& $Python -B -X utf8 docs/evidence/pr362-combined-20260921/verify_public.py
& $Python -B -X utf8 -m unittest discover -s tools -p test_startup_validation_harness.py -v
& $Python -B -X utf8 tools/verify_pr362_staged_evidence.py --repository $Repository --validation $FreshRawNine --output-directory $NewOwnedOutput
```

These commands match the recorded executions with caller-supplied paths.
Packaging did **not** rerun the suites or staged driver; only its narrow
documentation/migration and packet-preservation checks were newly executed.
To inspect the author-side findings, follow the file/caller table in the report,
the 19-path inventory and the 12 correction hashes; review is not an executable
approval gate. The public packet alone does not contain the private raw inputs.

## Custody, image and remaining gates

`provenance.json` distinguishes original private/source hashes from public
derivative hashes. Bundled-log byte ranges are zero-based, end-exclusive and
exclude the new segment labels. Only disclosed personal-home prefixes
(including escaped forms), CRLF and needed trailing-whitespace/EOF formatting
are normalized. Test-result text, statuses, timing and source IDs are retained.
Originals remain untouched. Combined stdout then stderr is **not chronological
interleaving**. Synthetic credential-shaped rejection fixtures remain test
text; no environment dump or operator credentials were copied.

[validation.html](validation.html) and [validation.png](validation.png) show all
claimed validation lanes as saved results. The PNG is a genuine Edge/Playwright
browser capture of that HTML, **not a drawn terminal, application screenshot or
fresh product execution**. [capture.json](capture.json) binds the actual render.
[packaging-checks.json](packaging-checks.json) records the narrow new checks
and input-preservation proof. `SHA256SUMS` covers every other packet file;
its own digest is reported separately to avoid a self-hash.

The first packaging whitespace assertion failed because it expected exit 0
from an added-file `git diff --no-index --check`; Git returned 1 with no
whitespace diagnostic. That failed assertion is retained privately. The
corrected readback records the added-file exit separately and requires empty
diagnostics, with process-only line-ending configuration. It does not change
source, index or the historical failed whitespace result.
That readback also found an extra final separator newline in a new bundled log.
The three new bundles now omit that added EOF separator; all 29 hash-bound
saved-log/report segments remain unchanged. Both packaging failures and the
successful readback are retained, separately from the historical validator.

The retained parent receipt reports four successful CodeQL analyses but a
**NEUTRAL aggregate**. Native `gh run rerun` exited 1:
“This workflow run cannot be retried.” This lane did not query GitHub, retry,
change settings or bypass the check. **Truthful all-green/NICE remains unmet.**

The parent still owns two fresh scoped publication reviews, subsequent
whole-PR reviews, hosted-state fences and protected acceptance. No fresh full
browser/server/runner path, full startup/Docker drill, ignored Rust opt-ins,
production/provider execution or merge is claimed. Stop here: package only;
do not stage, commit, push, replace historical packets or manufacture approval.
