# Native feedback review binding v1

This optional client admission contract extends [operation feedback](../OPERATION_FEEDBACK.md).
It reuses native verification decisions, artifact downloads and the existing versioned
reference-only contract revision. It creates no review service, corpus store or execution loop.

## Immutable intent

`prepare-review` consumes explicitly selected corpus/local-review bytes, a fresh pending
source receipt, one native artifact/path, one to eight active rule IDs and one saved Direct
target. It captures the live native review before and after reading verified artifact bytes.
The source must be the latest Direct run, waiting for approval with complete passed automated
evidence and an existing pending independent gate with `exclude_requester: true`.
The target retains the existing same-Corp/room/source, different-mission, unrun and version guards.

The create-only JSON has kind `ecorp-native-feedback-adoption-intent`, schema 1. Its canonical
digest uses the existing sorted-key `feedbackDigest`; its raw UTF-8 file SHA is a separate
input-integrity pin. It binds:

- intent UUID, creation time and expiry within 24 hours and every selected rule's lifetime;
- selected server-origin digest, Corp, room and adopter actor;
- exact source mission/task/run, source repository/ref/commit, native task/specification versions,
  producer/requester identities and original review-request time;
- native `verification_sha256`, separate persisted verifier-policy digest and the stable
  automated-evidence projection (`expected_check_count` and ordered receipt evidence);
- native artifact ID and digest, optional typed-file path and exact corpus byte/canonical digests;
- the existing local review-file hash and sorted selected rule IDs/digests/guidance/expiry;
- target mission/task/versions, description, previous contract, unchanged verifier policy,
  replacement contract digest and the exact appended reference strings;
- the reference-only effect and independent-review requirement, excluding the producer,
  source requester and adopter.

The runner computes native `verification_sha256` from its pre-decision `VerificationReport`:
automated results and manual-gate configuration, without a human decision. The store preserves
that digest on acceptance. Full receipt verification objects, acceptance flags, lifecycle
statuses, update times and the eventual decision are excluded from the intent identity.
The full persisted policy is bound separately; its hash is not assumed to be the native report
digest. Changing policy or automated evidence still invalidates the intent.

Unknown/duplicate JSON fields, inconsistent native scope, missing evidence, changed bytes or
versions and intents predating the native review request fail reconstruction. Creating an intent
does not relax accepted-source admission in ordinary preparation or apply.

## Existing native decision

The real reviewer submits the existing
`POST /api/corps/{corp}/runs/{run}/verification-decision`, with approved=true and exactly:

```text
ECorp advisory adoption v1; intent-sha256=<canonical intent digest>; approve the exact corpus, selected rules and reference-only target revision; no launch.
```

The native endpoint remains responsible for principal, role, room, independent-gate and pending
state authorization. The feedback client never posts this decision. Generic approval prose,
human-approval-only gates, another run, wrong reviewer or a digest embedded in contradictory
text does not satisfy the contract. The source must subsequently be completed/passed with its
same signed artifact and complete automated evidence. Review time must fall within the intent's
lifetime and cannot be future-dated. Existing completed sources cannot acquire retrospective review.

## Reviewed adoption and compatibility

`prepare --require-native-independent-review` requires both an absolute intent file and its raw
file SHA. It brackets the accepted-source/artifact capture with live review reads, reconstructs
the exact intent and emits a v2 feedback proposal with the raw input pin, canonical intent digest
and minimal decision projection. Public operation receipts remain exact schema v1. Ordinary
advisory preparation/application remains feedback schema v1 with its original semantics.

The original intent UUID is the revision idempotency key. Apply selects the same intent bytes,
repeats current source/decision/target/expiry checks and rebuilds the exact proposal against its
original target. A separate native read permits only the unchanged target or that proposal's
one exact prior revision, so same-key reconciliation works after the references were adopted.
The single existing contract-revision POST preserves description, objective, tools, scope,
budgets, attempts, secrets and verifier policy; only bounded advisory references change.

The mutation proposal lasts at most five minutes and never exceeds intent/rule expiry.
Post-request failures remain unknown; post-effect source/review drift remains explicitly
applied-but-changed. Preserve the key and original request. No automatic retry, new key, launch,
publication or rule activation occurs.

`native_independent_review_binding_verified` is a client observation of a persisted native
decision and exact effect, not mandatory server enforcement of feedback policy. Existing native
rows do not attest historical authentication mode/issuer. Production-identity, offline-authority
and physical-human claims remain false/unproved; development fixtures must be labeled accordingly.
Source/decision reads and the target transaction remain non-atomic.

## Validation scope

Focused fixtures exercise pending-to-approved identity stability, exact reviewed adoption and
one-revision replay; scope/role/decision/note/policy/evidence/intent drift; malformed or partial
native observations; expiry; ambiguous effects; CLI file selection; and legacy v1 behavior.
They create no native reviews and do not prove an actual human decision or a task improvement.
A genuine prospective native carrier/reviewer/adoption/readback is a separate operating check.
