# Saved recovery warning correction

Issue #262, PR #389, review comment 4145802423. Current main: 878a1774774b0630c904cbaf4b05e1b346777817.
Correction parent: dcf510abd809b16cf64a00bdcfd04c12f0e4458c. Tested implementation tree: d663784b009b9f65b0dc6be913bda4735255fcdd.

A saved recovery draft could restore an object in its optional refresh warning and
pass it to React rendering. Restoration now accepts only an absent warning or a
string. Invalid values use the existing storage error, preserve the stored bytes,
disable revision and send no request. Valid receipts and exact pending requests
keep their existing behavior. The correction changes one guard and adds three tests.

Retrospective regressions observed 39 tests: 37 passed and 2 failed before the guard
fix; 39 passed, 0 failed and 0 skipped afterward. Both failures were the new malformed
warning cases. The tests were written during this correction, not original development.

All eleven canonical pnpm check gates passed with unchanged locked dependencies.
Node: 3142 total / 3077 passed / 65 skipped /
0 failed. Rust: 879 passed / 564 ignored /
0 failed across 41 summaries. The EVM gate is separate.
Model coverage: 502 tests passed across 20 models and 31 test files; 99.69% lines,
97.58% functions and 97.12% branches, with unchanged 99/95/97 thresholds.
These counts overlap and are not additive.

The fresh owned browser/server/PostgreSQL/runner run passed 15 top-level acceptance
groups and retained 19 original screenshots. Ten malformed browser-storage variants
were rejected; absent, empty and textual warnings restored. No revision request was
sent and server revisions/runs were unchanged by these cases. Other groups re-exercise
saved response loss and exact replay, stale reconciliation, explicit launch, native
protocol resume, persisted verification, authority denials and budget restrictions.
The provider and Codex protocol remain deterministic fixtures. Seven recovery
presentation cases are explicitly synthetic. Zero actual human reviews occurred.
The owned services stopped successfully and fixture data was retained.

Green regressions, coverage, native acceptance and canonical validation observed the
same 7,231 physical files: a75e5aa2a6609d78c6c022671d099b7d4720927a661e8323d0a763f64cd92ad5. The tested tree was reconstructed after process
exit. Publication adds this evidence packet afterward and separately verifies original
source bytes, complete check arguments, Node discovery, documentation and secret scanning.
The [previous packet](../2026-09-30-guided-contract-recovery/README.md) remains unchanged
as history. This packet is current validation of the correction, not a rewrite of it.

Artifact SHA-256 pairs identify the original and published bytes. Personal paths and
discovered credential strings are redacted. Synthetic idempotency identifiers use
consistent aliases. Original screenshots are unchanged; private credentials are excluded.

GitHub Actions remains disabled. Required hosted checks are still mandatory; no merge,
issue completion, self-approval or clean historical dependency audit is claimed.

Qualifications:
- This is retrospective observed regression and acceptance evidence, and an assistant implementation self-review. It is not original development chronology, an independent GitHub approval or a human decision.
- The red test run used the published production guard with new regression tests and observed two failures. The green run changes only that production guard relative to the red source. Three new test cases account for the model-coverage increase from 499 to 502.
- The browser/server/PostgreSQL/runner stack is fresh and owned. Execution uses the existing deterministic fake-process and synthetic Codex protocol fixture, not live vendor inference or production identity.
- Malformed and valid warning variants are synthetic browser-storage edits to a receipt genuinely saved and replayed by the local server. They are not malformed API responses.
- The 15 top-level browser groups include one group with seven explicitly synthetic recovery presentation cases; they are not 15 wholly native tests. Zero actual human reviews were performed.
- Nineteen original screenshots are preserved. The two new warning views were visually spot checked at reduced display resolution; this does not establish exhaustive visual or accessibility certification.
- Green regressions, coverage, native r10 and canonical checks observed identical 7,231-file physical source. The final commit did not exist then. The original evidence packet is retained byte-for-byte as historical validation of the previous implementation.
- Native r10's receipt predates final canonical completion and records that check as pending. The completed canonical receipt and source-equivalence binding in this packet establish its later successful result without rewriting the native receipt.
- Skipped Node and ignored Rust cases are not passes. Canonical, focused, coverage and native counts overlap. Dedicated live and immutable historical replay lanes remain separate.
- Prior locked-dependency receipts are reused only with unchanged lockfiles. The pnpm install receipt included a log digest; the Steward receipt did not. Its retained log bytes were first bound retrospectively by the existing dependency-artifact receipt. Installs were not re-executed in this correction.
- Required hosted CI, CodeQL, code-quality and security checks remain unavailable because GitHub Actions is disabled. Local checks do not replace them. No merge, issue closure, self-approval, policy change, live-provider acceptance or clean historical Cargo advisory audit is claimed.
