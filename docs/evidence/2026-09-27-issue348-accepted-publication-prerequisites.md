# Issue #348 accepted-result publication: missing native prerequisites

Date: September 27, 2026. Issue #348, parent #280.

This record documents the specific missing native capabilities required by
#348's delivery boundary before any machinery is added. It is an inspection of
source, not an implementation, test result, activation or approval. No runner,
controller, publisher, provider, branch, pull request or Project effect was
started or changed.

Inspected base: main `078eb986352c8f219baeea5fddf4b8e9ff25e51e`.

## Prerequisite status

#348 requires reuse of #343, #344 and #346 and coordination with #219. On
September 27 all four issues were open with no closing pull request:

- #343 (retained source/evidence baseline). Its September 26 comment records
  that the retained 17-file #280 manifest/bundle is unavailable. No baseline
  exists to integrate.
- #344 (bounded workload intake policy). There is no versioned workload policy,
  workload identity, or expiry/revocation record in the store or migrations
  (`db/migrations` ends at `0056_delegated_scope_and_idempotency.sql`).
- #346 (independent agent-review acceptance). There is no typed reviewer verdict,
  producer/reviewer identity binding or server-owned candidate acceptance
  record. The only review gates are the human role gates
  `ManualVerificationGate::HumanApproval` and
  `ManualVerificationGate::IndependentReview { roles, exclude_requester }`
  (`crates/crony-domain/src/lib.rs:797-806`).
- #219 (human-requested review-only publication). The `requested` state exists
  in the schema (`db/migrations/0024_pull_request_publications.sql:24`), and
  start converts `requested` to `publishing` (`crates/crony-store/src/publication.rs:384-387`).
  No code path creates a `requested` publication. New publications are
  inserted directly as `publishing` (`crates/crony-store/src/publication.rs:525-531`).

## Current publication authority

The native publisher is human-authorized. `start_pull_request_publication`
requires the enrolled publisher credential (`crates/crony-store/src/publication.rs:215-221`),
and then requires a `kind = 'human'` actor holding the recorded role
(`crates/crony-store/src/publication.rs:222-228`, `1587-1606`). Active-attempt
revalidation re-derives that human role from the attempt's authorization
snapshot (`crates/crony-store/src/publication.rs:1639-1657`). Prerequisite
validation also binds the work item, mission, deliverable, persisted verifier,
Git bundle, lineage and checkpoint state (`crates/crony-store/src/publication.rs:1736-2150`).

Machine-authorized publication would require a non-human authority for the
exact accepted issue/source/contract/policy/deliverable/verifier tuple. Current
main does not have that authority source. Adding it here would invent #344's
workload authority and #346's acceptance contract. It would also allow an
unreviewed record to mint publication authority, which #348 prohibits.
Substituting a human actor would impersonate a human requester, which #219's
coordination comment prohibits.

## Consequence for #348

#348 remains blocked. Before its success-path slice can be implemented, it needs:

1. #343's recovered baseline, or an owner decision that replaces it.
2. #344's persisted workload policy and identity, including current-authority
   revalidation at the effect boundary.
3. #346's server-owned, digest-bound accepted-candidate record, which #348
   binds as its publication intent.
4. #219's `requested` intent and publisher-only routes, or an agreed shared
   intent shape. The automatic and human paths then share one attempt, lease,
   fencing, checkpoint and reconciliation engine.

When those exist, the existing publisher machinery above remains the effect
engine: enrolled credential, attempts, leases, fencing, checkpoints, signed
download, bundle import and remote-effect adoption. #348 should add only the
machine-intent provenance and its binding to that engine.

No TDD red or green result is claimed. The planned #348 tests remain planned.
