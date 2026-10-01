# Factory base-refresh lock-order correction

Issue #84, PR #390. Review comments 4149881329 and 4149881373.
Current main: 878a1774774b0630c904cbaf4b05e1b346777817. Parent: 31337c258360b7df2421e605e54d9a6f31753628. Tested source tree: e19869b13b8a4a59231a2d9babece644f2b9e43c.

Base refresh now acquires the audit ledger before the native Corp lock, matching
ordinary audited transactions. The correction calls the existing lock helpers and
preserves transaction, authorization, idempotency, verification and budget behavior.
It changes no migration SQL or harness mechanism.

Three native PostgreSQL regressions observe the refresh waiting on a held ledger
before the ledger owner requests the Corp lock. On the old ordering, all three
reproduced real deadlocks: 0 passed, 3 failed, 0 ignored, 572 filtered, Cargo exit101.
On the correction: 3 passed, 0 failed, 0 ignored, 572 filtered, Cargo exit0.
Authorization, adoption and abandonment are covered; the latter two deliberately
cover only the replacement mission. The broader base-refresh store lane passed
24 tests, with 0 failed, 0 ignored and 551 filtered. Its count includes those three.
The first regression attempt's fixture-prerequisite failure remains documented.

All eleven canonical pnpm check gates passed. Node: 3109 total,
3044 passed, 65 skipped, 0 failed.
Rust: 900 passed, 588 ignored, 0 failed
across 41 summaries. The separate native EVM gate also passed.
Rust used one test thread; locked dependencies and the full Node discovery lane
were preserved. No ignored native test is represented as executed by that lane.

A fresh owned PostgreSQL/server/runner/Vite/browser stack passed all 10 acceptance
scenarios and retained 2 original screenshots. Provider execution and
GitHub responses use explicit deterministic local fixtures. These are acceptance
observations, not actual human approvals or live external-service receipts.
The fixture publisher credential was revoked and owned services stopped.

All validation boundaries observed the same 7,239 source files:
db1161f52fd2ace790c0fecf494d165b2030d776fb37ac457fb1fce01c110a8b. The new native source guard also passed 22 regressions, including
real NTFS hard links and aliased parents. Publication uses the same guard. This
establishes fresh boundary checks, not historical filesystem metadata or continuous
operating-system locking.

The [original packet](../2026-09-30-factory-base-refresh/README.md) stays unchanged.
Its omitted successful publication receipt, observed exits and original logs are
included under history/passing-publication. That success concerns tested tree
52867f5d35cb30be622fe9a550cec7e07322c8e6 and publication tree
a5c854eaf73333092f32ead0e5e00c96b1133009, completed September 30, 2026 at
22:06:12 UTC. It does not validate this later lock-order correction.

Core publication R1 failed when Gitleaks flagged five synthetic UUID decision,
settlement and operation identifiers. The failed packet remains preserved locally;
its redacted receipt and logs appear under history/failed-lock-publication-r1.
The sanitizer now aliases those fixture identifiers consistently, preserving their
equality relationships. No scan exemption or security-policy change was made.

This packet was assembled after source execution. Its documentation, privacy,
secret scan, full check-plan equivalence and exact publication tree are verified
separately before committing. Artifact hashes distinguish original bytes from
sanitized copies. Screenshots retain original bytes. Text copies normalize
whitespace and personal paths; fixture credentials are redacted and operation/idempotency
identifiers use stable aliases. Published driver copies require explicit local
path configuration before reproduction; run Python with bytecode caching disabled.

Actual Node was 24.21.0; the repository declares 24.19.0. Hosted CI, CodeQL, quality,
security and review requirements remain required before merge. No issue closure,
merge, independent approval or clean historical Cargo advisory audit is claimed.
