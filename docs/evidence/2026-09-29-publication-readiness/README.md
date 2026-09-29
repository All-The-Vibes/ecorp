# Require Factory verification before requesting publication

Issue #219 / PR #380. A ready source deliverable can exist before its Factory work item finishes verification. The shared context reader now offers unpublished candidates only when the authoritative context says `work_item.state === 'verified'` and the exact source is `ready_for_review`. Both Factory and Mission use that reader. Existing publication results stay visible after the item transitions to publishing or published. Metadata validation still rejects malformed source records before filtering candidates; a ready snapshot cannot grant publication authority.

## Source and validation

The tested staged tree is `50a7d97fa6497fa96bb0d9e4939012c84ffb3ed8` on published parent `08f041f267f403f69f948666170f8e915104dd6f`, against main `878a1774774b0630c904cbaf4b05e1b346777817`. All **7,593 physical source files** match the locked acceptance build, controlled browser run r21 and canonical run r10. The correction changes three web source/test files; the prior implementation and evidence, dependencies, pinned harness, migrations and authorization mechanisms remain unchanged. This packet follows those executions and requires separate evidence validation before publication.

Canonical `pnpm check` passed all eleven named gates: migrations, state-audit compatibility, native EVM, docs, repository docs, full Node discovery, Rust formatting, Clippy, Rust workspace tests, web build and lint. Node: **3142 total / 3077 passed / 65 skipped / 0 failed / 0 cancelled / 0 todo**. Rust: **884 passed / 632 ignored / 0 failed**, across 41 summaries. Native EVM passed once. Skips and ignored cases are not passes. See [canonical-report.json](canonical-report.json) and [source-equivalence.json](source-equivalence.json).

Focused regressions genuinely produced **14 failures and 51 passes** before the readiness correction. With the final correction, **65 passed with zero failures, skips or cancellations**. They cover thirteen non-verified/missing/unknown states, preserved malformed-source rejection, saved publication visibility, and the actual App's response to authoritative context changes despite a stale ready snapshot. These are retrospective regressions, not invented historical development tests.

## Native browser acceptance

The complete local Edge/server/runner/PostgreSQL/native publisher stack produced a ready source while Factory was `awaiting_approval` and Mission was running. Both views exposed zero publication controls and caused zero publication mutations. A synthetic Bob decision through the native verification endpoint advanced Factory to `verified`; both views then exposed the publication preview for the same selected run. Four actual context GET receipts corroborate both states. The decision is automated fixture activity, not human or GitHub approval. Explicit **Review this run** navigation refreshes Mission; no claim is made about ordinary tab visibility or a response Cache-Control header.

The same final-source acceptance exercised three verified results, three durable requests and two **simulated** PR creations. Caller disconnect, publisher crash adoption, one-watcher recovery across busy lease/server restart/expiry, failure retaining an existing PR, and malformed-intent retirement passed without extra coding runs, retry loops, live provider calls or real GitHub mutations. Owned services stopped and source/binaries remained unchanged.

Twenty original screenshots cover ten states at 390px and 1440px and were visually inspected. Recorded geometry shows no horizontal overflow; no blocked requests or page errors occurred. Existing focused skip-link overlap and a transient earlier mobile intake label are retained in [screenshot-review.json](screenshot-review.json). Earlier r18/r19/r20 fixture failures and their corrected assumptions remain recorded in [regression-history.json](regression-history.json).

## Completion limits

Required current-head hosted CI, CodeQL, code quality, security, native integration and substantive feedback still gate merging. GitHub Actions is disabled by the organization; this local packet cannot replace those checks. Historical Cargo debt remains twelve advisories, not a clean audit. Environment-only database credentials are reduced assurance, and serial Rust validation does not resolve #213. This is continued assistant review, not independent human approval or self-approval. Only verified PR merge and issue closure receipts establish #219 completion; #145 and #348 remain open.

## Evidence publication formatting

The first publication-only whitespace check rejected trailing spaces and extra final blank lines in copied tool output, plus blank context lines in Git patches. Original logs and failed validation are retained privately with their hashes. Published text copies normalize that whitespace; each transform is recorded in `summary.json`. The two patches are native zero-context diffs against the same tested source; their original bytes and publication hashes are recorded separately. This correction changes no tested implementation or observed result.
