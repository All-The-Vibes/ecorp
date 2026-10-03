# Late usage replay identity

Draft PR #402 review comment 4173665178 identified that accepted usage arriving
after terminalization or expired hard-control grace was excluded from native
identity lookup. A retry with a new journal ID became another accepted origin.
The lookup now includes accepted uncharged observations and duplicate aliases.
It reuses the existing Corp/run-scoped journal, exact assignment locks and
database-clock accounting controls.

The tested source is parent `53ff7a6d2fc394a98cb438806f653c1254bbe976` plus the decoded `patch` string in
`source/correction.patch.json`. Encoding and decoding preserve every patch byte.
Its physical fingerprint is `b800aafc22d25e718466021669803fc771b00da96ac855630af0c8bbd8177a66`. The complete manifest and patch
bind the exact uncommitted bytes used by the native and integration runs.
The final published commit is identified in PR #402's source-bound handoff.

## Observed regression results

The before-correction run had 12 passed, 2 failed, 0 ignored and 571 filtered
tests. Both failures observed `accepted` where `duplicate` was required. These
are retained failed checks, with their actual logs and test-only source hashes.

After correction, both complete native SQL lanes passed on fresh owned SCRAM
PostgreSQL with wrong-password rejection and verified shutdown:

| Lane | Passed | Failed | Ignored | Filtered |
| --- | ---: | ---: | ---: | ---: |
| usage-provenance-transactions | 14 | 0 | 0 | 571 |
| hard-control-transactions | 14 | 0 | 0 | 571 |

The tests replay the existing terminal `late-event` report and cover completed,
failed, cancelled and lost runs; missing hard-boundary time; expired stop and
suspend grace; same-journal retries; enriched and alias-only identities; omitted
optional session identity; and conflicting reports that cannot claim new aliases.
They assert stable origins, unchanged counters and terminal/breaker state, and
retained hard-boundary/cutoff evidence. Production keeps its five-second grace.

## Observed integration acceptance

All five browser scenarios passed 54 assertions with zero failed assertions,
execution errors, failed scenarios or unexecuted scenarios. Actual Edge,
native server/runner and fresh owned PostgreSQL used a deterministic Codex
protocol corpus. Each scenario verifies persisted completion evidence, provider
artifact identity, source preservation and disposable workspace cleanup. This
is deterministic integration coverage; the new late-replay case is exercised
by the native SQL regressions above.

Historical canonical validation passed all eleven `pnpm check` gates on
the staged tree `4fdc55f3c244ce790625dcbadf72f781c9cc8c30`, subsequently committed
as `03f4629fc57c33f2d91da95240a9da6d6db47256`. The [retained receipt](canonical/issue236-canonical-late-replay-final-r3.json),
[readiness report](canonical/readiness-report.json), [log](canonical/canonical.log.txt)
and [source binding](canonical/evidence.json) are published in this packet.
They record 3,105 Node tests (3,040 passed, 65 skipped), 937 passed and 596
ignored Rust tests, and one passed EVM test, with no failed checks. The
before/after manifests, locked-install logs and commit receipt establish the
original source identity. This historical result does not validate subsequent
changes, including the later cumulative-total correction.

## Remaining scope

#236 remains open and #402 remains draft. Auditor execution, early audits and
headroom, durable decisions, bounded atomic grants/revalidation, same-lineage
continuation, the operating UI and concurrency/revocation acceptance are still
required. Dependency #392 and independent outcome review remain unresolved.
The $10 assurance is unknown. Required hosted CI, CodeQL, security and quality
are unavailable under the retained organization Actions restriction. No policy
or required check was bypassed, and historical Cargo advisory debt is unresolved.
The #193/#235 paired R4 experiment remains permanently stopped.

Text copies normalize only declared local roots, local operator names,
synthetic-user examples, line endings and trailing whitespace. Original and
published hashes record each transformation. The correction diff uses a reversible
UTF-8 JSON string; its decoded bytes and original hash are unchanged. Screenshots
and downloaded provider artifacts preserve their exact bytes. Private database
credentials are excluded. Environment-only fixture delivery is reduced assurance.
