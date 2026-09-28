# Retire permanently denied publication requests

PR #380 previously retired explicit saved-intent mismatches, but several native prerequisite gates returned ordinary errors. A queued request whose budget authority, checkpoint, termination proof or correction provenance was withdrawn could therefore remain eligible for repeated watcher retries. This correction shares a private typed admission-denial marker across the existing validators and uses the existing durable failure transition. It adds no migration or execution mechanism.

Only confirmed authority, policy and proof denials carry the marker. Synchronous proof validation preserves the original cause. Database errors, pending audit gates, workload authentication failures and live leases retain their existing behavior. Retirement is fenced by the exact enrolled credential and repository; it records one failure event/version increment without a lease, token, attempt or remote effect. Provenance remains unchanged, replay is idempotent, and retired work leaves the queue.

## Source and validation

Main base: `878a1774774b0630c904cbaf4b05e1b346777817`. Published parent: `b3fbd3bcf5bd0aeef032ca0ea7ed2ca5841b07ab`. Tested staged tree: `fef2dcc52107406952a643ff6684771accd28565`. The complete 7,413-file physical source inventory matches the focused native runs, build, r13 browser acceptance and canonical validation. [source-equivalence.json](source-equivalence.json) binds that inventory. The correction changes 15 source paths; the complete issue implementation changes 50 paths against main outside evidence. Applied SQL, migration manifests and earlier evidence packets are unchanged by this correction.

The observed pre-fix red run had **2 passes and 9 failures** across eleven tests (Cargo exit 101). Current native regressions passed **41 store cases, 15 correction cases and 9 HTTP authorization cases**, all with zero failures or ignored cases. They cover stale run and loop-breaker authority, withdrawn or invalid checkpoint and termination proofs, correction ancestry/events, exact-credential repository isolation, idempotent retirement, database recovery and pending-audit recovery. The historical red driver bound six selected inputs; the current green receipts bind every physical source file. [correction-history.json](correction-history.json) preserves these distinctions.

Locked canonical `pnpm check` passed all eleven gates, including immutable migrations, state-audit compatibility, native EVM, full Node discovery, formatting, Clippy, Rust workspace tests and web build/lint. Node: **3,127 total, 3,062 passed, 0 failed, 65 skipped, 0 cancelled, 0 todo**. Rust: **884 passed, 0 failed, 614 ignored** across 41 summaries. The separate EVM gate passed one test. Skips and ignored cases are not passes; focused counts overlap the full suite.

## Controlled browser acceptance

Fresh r13 acceptance used real Edge, server, runner, native CLI publisher, SCRAM PostgreSQL and private Git with deterministic providers and simulated GitHub. Two genuine native verified results produced two durable tokenless human requests. One surviving watcher encountered a busy lease, server restart and actual expiry, then adopted a PR created before another publisher crashed. Recovery converged without competing/repeated effects or duplicate PRs. Caller disconnection preserved intent.

An injected Project-update failure retained the second PR link and a visible durable failure without automatic retry. There were no extra coding runs, browser publisher credentials or remote-main changes. All owned processes stopped; fixture data remains preserved. All ten original 390px/1440px screenshots were inspected. See [controlled-browser-report.json](controlled-browser-report.json) and [screenshot-review.json](screenshot-review.json).

## Remaining gates and limits

Final-head CI, CodeQL, security, quality, coverage, native integration and resolved substantive feedback remain required. Exact-head merge and verified issue state are necessary before #219 is complete. Parent #145 and machine-intent #348 remain open. The [repository-grant packet](../2026-09-28-publication-repository-grants/README.md) and earlier packets remain immutable history.

Evidence is added after code execution and checked separately for original physical source and Git-tree equivalence, unchanged canonical plan and Node discovery, documentation, paths, whitespace and secrets. No execution on the later evidence commit is invented. The prior local coverage inputs remain unchanged; hosted coverage must run on the final head.

Controlled acceptance made zero real provider calls and GitHub mutations; it does not establish production OIDC, live inference, OS isolation or independent human approval. Store/handler prerequisites are synthetic metadata; the browser separately executes the native verifier. Environment-only credentials remain reduced assurance. No Docker acceptance is claimed. Serial Rust does not resolve issue #213. Historical Cargo debt remains twelve advisories (2 high, 1 moderate, 9 low); no clean audit is claimed. The historical r11 fetch timeout remains failed with unconfirmed cause and is separate from current r13 validation.
