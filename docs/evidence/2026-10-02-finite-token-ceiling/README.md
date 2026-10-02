# Finite token ceiling: prospective contributor evidence

The finite ceiling and initial remaining-budget implementation is locally code-ready
at product commit `44a451be3262016635fa1dcca8d0365291664678`, based on main
`878a1774774b0630c904cbaf4b05e1b346777817`. This packet supports a contributor
draft for issue #291. It is not native Factory publication or completed acceptance.

The implementation accepts the exact finite integer `999999999999999` across the
UI, ordinary and Factory planning, store and revisions. Initial dispatch reuses
the existing budget locks and persists the smallest positive task, mission,
requester and Corp remaining allowance before a run or attempt is written.
Smaller authored policies, accumulated usage, existing cost/attempt/loop limits,
verification and terminal history remain in force. Migration 0057 changes new-row
defaults and the mission maximum; previously applied SQL is unchanged.

## Source and evidence boundary

All final native and canonical runs used the same 7,151-file physical fingerprint
`e366d091bab92043a0e67a4efc30fa84f19e632bf17541d31a8ae6510e218fce` before the product
commit. The original before/after manifest SHA-256 values are
`f81e4fd726154352ad64020cf491f99f6225401d4e673c712329a0bcd6dbbd57` and
`de0df961d18d532802221508b289f94f021222782de1595cc541781626655565`.
The physical source stayed unchanged during and after those validations.

[The product binding](receipts/issue291-product-binding-r1.json) maps every changed
path's physical SHA-256 to its committed blob and records Git's applicable CRLF
to LF normalization. These normalized blobs are not claimed byte-identical to the
native inputs. Unchanged paths retain their main blobs. The product tree is
`eb83a62821245ff6049ed656cb9fd8f174857da8`; this evidence is an ordinary documentation
child of that product commit and does not change its executable source.

[Artifact provenance](artifact-provenance.json) records original and public hashes
and byte counts. Public copies replace personal Windows home prefixes with
`<USER_HOME>` and normalize actual CRLF line endings to LF; no other text is
changed. Hashes embedded in copied receipts still identify the original retained
files. Use the provenance mapping to verify the public copy. Private credentials,
databases and retained worktrees are not included. Driver snapshots use `.txt`
suffixes so publishing them does not add executable tests to Node discovery.

## Observed validation on October 2, 2026

The canonical `pnpm check` ran from 04:09:21Z to 05:21:25Z, with frozen/offline
pnpm installation and locked Rust commands. All eleven named gates passed:
migrations, state-audit compatibility, state-audit EVM, generated docs, repository
docs, full Node discovery, Rust formatting, clippy, workspace tests, web build and
web lint. The complete commands, outputs and source data are in the
[full report](receipts/canonical-full-report.json),
[wrapper](receipts/issue291-canonical-r1.json) and
[log](receipts/issue291-canonical-r1.log).

| Lane | Observed result |
| --- | --- |
| Full Node discovery | 3,109 total; 3,044 passed; 0 failed; 65 skipped; 0 cancelled; 0 todo |
| Rust workspace | 881 passed; 0 failed; 569 ignored across 41 summaries |
| Separate local EVM gate | 1 passed; 0 failed; 0 ignored |
| Dedicated SQLx token-ceiling lane | 5 passed; 0 failed or ignored; 554 filtered; all five discovered cases executed |
| Safe helper unit tests | 5 passed; 0 failed |
| Disposable web helpers | Actual build and lint passed with frozen/offline hoisted/copy installs |
| Browser, server and runner | 18 of 18 defined cases passed; no page errors |

Ignored, filtered and skipped cases are not counted as passes. The five SQLx cases
ran separately on a fresh owned SCRAM PostgreSQL fixture; the wrong-password probe
rejected and the owned process was stopped. They cover ordinary/Factory admission,
rejected input without ledger writes, rolling and mission remainders, exhaustion,
and migration preservation. See the [database receipt](receipts/issue291-native-database-r3.json).

The web helper's approved descriptor is byte-identical to the current integrity-only
primary lock (zero feed replacements). The primary lock, versions, integrities,
registry policy and TLS were unchanged. Child receipts and their actual command
logs are included under `children/`; wrapper success alone is not the evidence.

The [native lifecycle](receipts/issue291-native-r2-lifecycle.json) and
[browser receipt](receipts/browser-server-runner-r2.json) record real Edge,
PostgreSQL, server and runner execution with the existing **synthetic Codex
protocol peer and development principals**. Cargo artifact hashes, process
creation/listener identity and the served App source-map bytes were inspected.
Three browser-created missions persisted run allowances of `999999999999999`,
`20` and `20`, used 12 synthetic-peer tokens each, passed their persisted verifier,
and returned signed, hash-checked artifacts. Zero remainder returned 409 without
run or attempt writes. Fourteen invalid preview/create requests returned 400/422
without ledger changes. Prior history was unchanged. Exact owned stack processes
were verified stopped; the fixtures remain retained locally.

## Failed attempts and limits

The failed database r1 is retained: two passes and three failures exposed a
synthetic history missing required workspace lineage. The fixture was repaired
without weakening production constraints. Native r1 completed the numeric helper
and native build but failed its unconditional New mission selector on an already
open empty composer. That test interaction was corrected. `failed-attempts/`
preserves those results; they are not final-source passes or hidden retries.

This packet is prospective automated regression evidence, not the original
September development chronology. The unavailable private reference inputs were
not reconstructed. Terminal #279/#282/#284/#286 lineages and their workspaces were
not resumed, reset or adopted. #266 must not run under a smaller ceiling.

Issue #291 remains open for exact-source native Factory verification/publication,
genuine independent human outcome review, required hosted checks and a verified
merge. The implementing agent's code review is not independent human acceptance.
GitHub Actions was disabled and required hosted results were absent at the last
remote check; local results do not replace those gates. Historical Cargo advisory
debt has not been resolved or represented as a clean audit. No production
deployment, account change, permission bypass or merge is certified here.
