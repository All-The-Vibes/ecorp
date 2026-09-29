# Publication artifact authorization

Issue #219 / PR #380. The publisher artifact route previously committed its authority checks before a separate artifact lookup. The correction keeps credential, publication, human membership and source locks through the canonical lookup and rechecks credential/repository scope and lease with fresh time before commit. Metadata readback no longer carries an artifact authorization option. Signed-object verification remains unchanged, and the canonical download query/filter is shared without changing its predicates. No applied migration or earlier evidence packet changes.

## Source and actual validation

The tested staged tree is `79cbed68705e0e67324ac223155067c92ee84c8a` on published parent `f822f0929f53b160e568f2569bc9e24e6a2efca4`, against main `878a1774774b0630c904cbaf4b05e1b346777817`. All 7,538 physical source files agree across native regressions, build r9, browser r17 and canonical r9. This packet was added after those executions; separate publication checks must reconstruct the same tested tree and retain the full named plan and Node discovery. Final-head hosted checks remain required.

Canonical `pnpm check` passed all eleven gates with locked dependencies: migrations, state-audit compatibility, local EVM, documentation, full Node discovery, Rust formatting/Clippy/workspace tests, web build and lint. Node: **3127 total, 3062 passed, 65 skipped, 0 failed, 0 cancelled, 0 todo**. Rust: **884 passed, 632 ignored, 0 failed** across 41 summaries. The separate local EVM test passed once. Skips and ignored tests are not passes. See [canonical-report.json](canonical-report.json) and [source-equivalence.json](source-equivalence.json).

The new six HTTP/PostgreSQL regressions genuinely failed before the correction. They block the actual canonical query, observe it through PostgreSQL activity, require credential/version/role/membership mutations to time out while authorization holds its locks, then verify denial after mutation. Two cases cross actual credential/lease expiry while the lookup is blocked. First green attempt: 14 pass and one denial-status failure; final HTTP run: **15 pass, zero failed/ignored**. Its deliberately invalid/missing object provenance returns 500 after successful serialization, so this is authorization evidence, not successful download acceptance.

Store publication family **53** and correction publication **15** passed in r1. That wrapper failed because its source-download filter selected zero tests. Corrected r2 freshly passed **seven** canonical source-download tests and reused the earlier 68 results after complete source/log hash verification. No empty lane or fresh rerun of those 68 is claimed. See [regression-history.json](regression-history.json).

## Browser acceptance

Real Edge, server, runner, native CLI publisher, PostgreSQL and private Git exercised three native verified results and three durable human requests with deterministic providers and simulated GitHub. Two simulated PR creations covered disconnect survival, publisher crash adoption, and one surviving watcher recovering after busy lease, server restart and actual expiry. A controlled Project failure preserved its PR link. Malformed saved intent retired once with no Git effect or retry loop. No extra coding run, browser publisher credential or remote-main change occurred. All browser requests stayed on loopback and owned fixture services stopped.

Twelve screenshots cover six states at 390px and 1440px. Resized full-page previews were visually inspected and original hashes verified; no horizontal overflow was observed. The existing focused skip link overlaps part of the title/card edge without covering publication actions. See [controlled-browser-report.json](controlled-browser-report.json), [controlled-native-report.json](controlled-native-report.json), and [screenshot-review.json](screenshot-review.json).

## Completion limits

Current-head hosted CI, CodeQL, code quality, security, native integration and substantive review resolution still gate merge. This packet is retrospective regression/acceptance evidence, not independent human approval. The controlled fixture makes zero real provider calls or GitHub mutations and proves no production OIDC or OS isolation. Environment-only database delivery remains reduced assurance. Serial Rust checks do not resolve #213. Historical Cargo debt remains twelve advisories, not a clean audit. Only a verified merge and issue-state receipt establish #219 completion; #145 and #348 stay open.

## Evidence publication formatting

The first publication-only whitespace check rejected trailing spaces and extra final blank lines in copied tool output, plus blank context lines in Git patches. Original logs and failed validation are retained privately with their hashes. Published text copies normalize that whitespace; each transform is recorded in `summary.json`. The two patches are native zero-context diffs against the same tested source; their original bytes and publication hashes are recorded separately. This correction changes no tested implementation or observed result.
