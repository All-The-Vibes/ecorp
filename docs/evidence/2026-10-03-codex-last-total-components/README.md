# Codex last-call component consistency

PR #402 review comment 4175209381 demonstrated that `last.totalTokens: 1`
with input 10 and output 2 could pass admission when the cumulative total was
12. A supplied last-call total now must cover its own known component floor:
`max(input, cached_input, cache_write_input) + max(output, reasoning_output)`.
The same rule applies to initial reports and later cumulative increases.

Contradictory last-call reports cannot claim a cursor, consume deduplication
identity or charge usage. A corrected report at that cursor contributes once.
Unknown parent quantities remain unknown; known cache and reasoning subsets
still impose their lower bound. Cache categories are alternatives, not additive
charges. Larger native totals remain valid; exact component equality is not
required. Existing duplicate, cumulative-regression and invalid-shape handling
is preserved. No harness mechanism or applied migration changes.

See [the evidence index](evidence.json) and [native contract](native-contract.json).

## Observed validation

The pre-fix runner filter produced 5 passes and 3 failures, 0 ignored and 326
filtered, exit 101. On the final acceptance source, all 8 filter tests passed;
domain usage passed 22 and all runner usage tests passed 28. These overlapping
lanes are reported separately, each with zero failures or ignored cases.

The first SQL attempt passed 15 tests and failed the new regression's assertion
that an invalid raw last-call total would survive admission. The existing store
correctly redacts invalid input. Only that fixture's assertions changed: they
now require the bounded redacted rejection and unchanged counters, followed by
one valid correction and replay suppression. That failed attempt, its complete
log and source manifests remain archived; its hard-control lane was not run.

After that correction, the complete native usage lane passed 16 tests, 0 failed,
0 ignored and 571 filtered. The complete native hard-control lane passed 14,
0 failed, 0 ignored and 573 filtered. Both discovered test lists exactly match
their executions. Both owned SCRAM databases rejected a wrong password and were
stopped. Prior focused and failed SQL observations retain their own source
identity; final focused tests, SQL, binaries and browser use the corrected source.

All 15 browser/server/runner scenarios passed 154 assertions,
with zero failures, execution errors, failed or unexecuted scenarios, blocked
requests or page errors. The first twelve corpus cases are unchanged. Three
new cases cover contradictory last-call components initially, after an accepted
cursor, and with unknown parents plus cache/reasoning subsets. Each checks
invalid evidence, a valid correction and replay suppression. Actual Edge drove
rebuilt native services and a fresh owned database through deterministic Codex
transport. Persisted verifier evidence, downloaded provider artifacts, source
preservation and workspace cleanup are checked. All 15 actual screenshots were
inspected. The owned services are verified stopped.

## Source and publication

Parent: 08a057fd89ca0dae7904c00a22fd295bd76c3d0d. Exact acceptance physical fingerprint:
72d2db239e539bf44d58ce11192555e7bb7580b9d724c1612e26d543591c8469, covering 7890 files. Final focused tests, native SQL,
native rebuild and browser acceptance used those same bytes. This evidence
packet is the only subsequent addition. The final staged tree must pass all
eleven canonical `pnpm check` gates before commit. The PR validation comment
records observed final results and receipt/log/report digests; complete original
canonical logs and manifests remain in local run records. This packet does not
claim a future check passed. Historical validation applies only to its recorded
commit and source manifest.

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
