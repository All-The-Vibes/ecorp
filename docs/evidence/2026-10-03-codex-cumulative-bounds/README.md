# Codex cumulative usage consistency

PR #402 review comment 4174016149 identified that an increasing total alone
does not establish a valid call. This correction requires the initial total and
each accepted increase to cover the known last-call quantity. It uses the largest
known input/cache subset plus the largest known output/reasoning subset with
checked arithmetic. Missing values stay unknown; subsets are not added to their
parents or assumed disjoint. Larger gaps still allow prior or unobserved history.

Impossible, regressing and conflicting reports remain invalid, uncharged evidence.
They cannot change the accepted cursor or report. Exact accepted duplicates are
suppressed; valid corrections contribute once while invalid coverage persists.
The existing native app-server protocol remains the source of usage events.
See [the evidence index](evidence.json) and [native contract excerpts](native-contract.json).

## Actual validation and acceptance

Before the correction, the four new regressions produced 1 pass and 3 failures,
0 ignored and 322 filtered, with exit 101. Those failures and their exact source
manifests remain in this packet. After correction, all 4 new regressions passed;
the domain usage lane passed 18 and all runner usage tests passed 20, with zero
failures or ignored tests. These overlapping lanes are reported separately.

Both complete discovered native SQL lanes passed 14 tests each, 0 failed,
0 ignored and 571 filtered. They used fresh owned SCRAM PostgreSQL and confirmed
wrong-password rejection and shutdown. Both native binaries were rebuilt with
fresh:false compiler artifacts and verified again before the browser run.

All seven browser/server/runner scenarios passed 74 assertions, with no failed
assertions, execution errors, failed or unexecuted scenarios, blocked requests
or page errors. Actual Edge drove fresh native services and an owned database
using a deterministic Codex protocol corpus. The original five scenarios remain
unchanged. New cases recover from an impossible initial total and repeated
impossible increases; both retain 16 input and 4 output tokens after correction,
no invented USD, invalid coverage and no duplicate charge. Persisted verifier
evidence, provider downloads, source preservation and workspace cleanup are
asserted in each scenario. All seven actual screenshots were visually inspected.

## Source and publication

Parent commit: 03f4629fc57c33f2d91da95240a9da6d6db47256. Integration source fingerprint:
2fbf6e80bbf152a6852be805517445b64598df29a624d1ab971cee748edb2fde. Focused green fingerprint: 866f55fa0262e5e41f7de36bd611774cf108373efcede2ab92a256700d5970af.
Those two source manifests differ only in the separately published historical
canonical packet; all other physical files are identical.

The complete final staged Git tree must pass all eleven canonical pnpm check
gates before committing. The PR validation comment links the actual final
receipt, report, logs and source manifests from an immutable supplemental
evidence commit. That separate publication keeps its own result outside the
validated production tree. No future canonical result is asserted in this file.

Review comment 4174016161 is addressed by the separately restored
[historical canonical packet](../2026-10-03-late-usage-replay/canonical/evidence.json).
Its passing result belongs to the parent commit above, not this correction.

Text copies use declared root/operator/example substitutions, LF and whitespace
normalization. Original and published SHA-256 values retain the transformation
record. The correction patch is a reversible JSON string. Screenshots and
downloaded provider artifacts preserve their exact bytes. Private fixture
credentials are excluded; environment-only delivery remains reduced assurance.

## Remaining scope

Issue #236 stays open and PR #402 stays draft. Auditor execution, early audits
and headroom, durable decisions, bounded atomic grants/revalidation, same-lineage
continuation, operating UI and concurrency/revocation acceptance are still
required. PR #392 and independent outcome review remain unresolved. The $10
assurance is unknown. Required hosted CI, CodeQL, security and quality are
unavailable under the organization Actions restriction; historical Cargo
advisory debt is unresolved. No policy or required check is bypassed.
This is deterministic integration coverage, not provider inference or billing.
The #193/#235 paired R4 comparison remains permanently stopped.
