# Codex last-call total consistency

PR #402 review comment 4174776187 showed that an increasing cumulative total can
still conflict with native `last.totalTokens`. A cursor moving from 10 to 12 with
last-call total 100 is now retained as invalid evidence and cannot move the
accepted cursor or charge usage. The initial total and subsequent increases must
cover both the known component lower bound and a supplied valid last-call total.

The optional last-call total is persisted in usage provenance and participates
in exact-report equality. Malformed, null, negative, fractional and out-of-range
supplied values are invalid. Legacy omission remains unknown. The total never
becomes an input/output charge or fills unknown components. Exact accepted
duplicates are suppressed first; invalid reports do not replace accepted state;
valid corrections contribute once. Larger totals remain valid because native
history may contain unobserved context. No exact component sum is required.

See [the evidence index](evidence.json) and [native contract](native-contract.json).

## Observed validation

Before the fix, the five focused regressions produced 1 pass and 4 failures,
0 ignored and 326 filtered, exit 101. Afterward all 5 passed; the domain usage
lane passed 19 and all runner usage tests passed 25. The overlapping focused
lanes are reported separately, each with zero failures or ignored cases.

The complete native usage lane passed 15 tests, 0 failed, 0 ignored and 571
filtered. The complete native hard-control lane passed 14, 0 failed, 0 ignored
and 572 filtered. Both discovered test lists exactly match their executions.
The fresh owned SCRAM database rejected a wrong password and was stopped.

All 12 browser/server/runner scenarios passed 124 assertions,
with zero failures, execution errors, failed or unexecuted scenarios, blocked
requests or page errors. The first seven corpus cases are unchanged. Five new
cases cover impossible initial and incremental last-call totals, malformed
values and recovery, same-cursor last-call conflicts, and unknown components.
Actual Edge drove rebuilt native services and a fresh owned database through a
deterministic Codex transport. Persisted verifier evidence, downloaded provider
artifacts, deduplication, source preservation and workspace cleanup are checked.
All 12 actual screenshots were inspected. The services are verified stopped.

## Source and publication

Parent: 9cbac5bb6fd5892799f1ec668c9cd6955e20ec6c. Exact acceptance physical fingerprint:
2f37a7a62a224147a18a20706e735322f27cbd09254cdfb478771eeedac029af, covering 7806 files. Focused green, native SQL,
native binary rebuild and browser acceptance all used those same bytes. This
packet is the only subsequent addition. The final staged tree must pass all
eleven canonical `pnpm check` gates before committing. The PR validation comment
records the observed final results and receipt/log/report digests; original
canonical logs and manifests remain in the local run records. This packet does
not claim a future run passed. Prior canonical validation applies only to its
recorded historical commit.

Text copies declare root/operator/example substitutions, LF and whitespace
normalization, with original and published SHA-256 values. The correction patch
is a reversible JSON string. Screenshots and downloaded provider artifacts keep
their exact bytes. Private credentials are excluded; environment-only delivery
remains reduced assurance. Archived driver text does not enter Node discovery.

## Remaining scope

Issue #236 stays open and PR #402 stays draft. Auditor execution, early audits
and headroom, durable decisions, bounded atomic grants and revalidation,
same-lineage continuation, operating UI and concurrency/revocation acceptance
remain required. PR #392 and independent outcome review are unresolved; the
$10 assurance is unknown. Required hosted CI, CodeQL, security and quality are
unavailable under the organization Actions restriction. Historical Cargo
advisory debt is unresolved. No policy or check is bypassed. These deterministic
receipts do not establish provider inference or billing. The #193/#235 paired
R4 comparison remains permanently stopped.
