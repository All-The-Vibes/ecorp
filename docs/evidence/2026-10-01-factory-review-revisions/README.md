# Governed review corrections after publication

Issue #95; prerequisite PR #390 at 7e65f46a0c0f991460eeb4c5b60723d2e0dff1f9, and #382 at 6f2375e06546806003a9a1d1a340bdc1a4ce4b8c.
Both exact heads are retained as parents; current main is 878a1774774b0630c904cbaf4b05e1b346777817.
Reviewed source tree after the separately tested fixture EOF cleanup: 5072c911cf980d5b48ed78e6d946f491eef94a1a.

Published Factory results can enter an explicit correction state, retain typed
attributed findings and create a separate mission from the signed published source.
The correction inherits bounded authority and the saved checks, requires a fresh
independent review, and permits explicit adoption followed by one separately
authorized superseding publication. Original records remain unchanged. Predecessor
PR and native branch drift fail closed even on completed publication replay.

Canonical pnpm check passed all eleven gates. Node: 3137 total,
3072 passed, 0 failed, 65 skipped.
Rust: 912 passed, 0 failed,
593 ignored across 41 summaries.
The separate native state-audit EVM gate passed one case. Skips and ignores are not
passes, and overlapping lane counts must not be added.

Fresh acceptance R7 passed 15 browser-to-server-to-runner scenarios using real
Chrome/App, PostgreSQL and native Git. Its provider, GitHub boundary and principals
are deterministic fixtures. Across two items it observed three fake PRs, three
create calls, two Project updates and five effects; the main correction created
one superseding PR without repeating the original Project transition. All owned
services stopped and PostgreSQL shutdown exited zero.

Canonical R3 and acceptance R7 share their original 7,397-file manifest and tree
d25ef2100f7bec0ecc65772f61308c111d8df3fd. Afterward, one redundant
final LF was removed from the test-only missionResultFixtures.mjs; both importing
test modules passed on the new source. All other 7,396 files and all runtime and
dependency bytes remain unchanged. Neither the full canonical plan nor acceptance
was rerun for this cosmetic edit. [Source binding](source-binding.json) retains
both exact manifests, trees and the observed delta receipt. The publication commit
did not exist during those executions.
Other focused receipts have explicitly recorded earlier or incomplete source
coverage. [Summary and original/published artifact hashes](summary.json) and
[implementation self-review](implementation-self-review.json) map all nine issue
criteria to code and observed scenarios. [Canonical results](canonical/report.json)
and [acceptance](acceptance/acceptance.json) retain actual counts and receipts.

Failed canonical R1/R2, temporary diagnostic failures and exact restoration,
earlier acceptance attempts and the recurrence reproduction are retained under
history. The older prerequisite/parity Node lane passed 103 cases; native
deliverable and correction lanes passed 36 and 9 cases. Windows policy tests passed 35 cases before the test-only EOF cleanup. Their exact source coverage is recorded, and the
counts overlap canonical validation. R3 uses #382's native Windows serial Rust
flag without changing assertions, deadlines or the eleven gates. This neither
diagnoses nor closes #213. Public copies redact authority
values and personal paths and consistently alias synthetic identifiers; screenshots
retain original bytes. Publication validation is separate from product execution.
The first publication scan failed on 96 synthetic UUID aliases; its redacted
findings and exact classification are retained under history. These non-secret
fixture identifiers now use explicit fixture-reference labels. The secret
scanner and repository policy remain unchanged.

This remains draft work dependent on #390 and #382. Required hosted CI, CodeQL, code-quality
and security checks are unavailable while GitHub Actions is disabled. Node 24.21.0
was used although the repository declares 24.19.0. No independent GitHub approval,
human signoff, live-provider acceptance, merge, issue closure or clean historical
Cargo advisory audit is claimed.
