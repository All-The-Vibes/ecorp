# Issue 161 implementation working record

Base: `b2523964e7576cafc00e84a51e1044f55826dea7`.

The contribution is isolated from the retained operator checkout and services.
It remains an uncommitted, unpublished candidate; full #161 acceptance is open.

Read [runtime-acceptance.md](runtime-acceptance.md) and
[runtime-result.json](runtime-result.json) for the latest recorded local runtime
verdict. The earlier [qa-handoff.md](qa-handoff.md) deliberately preserves the
pre-runtime gate and setup-preview checkpoint. Its then-unrun nine database tests
were subsequently executed and passed in the approved owned QA fixture.

## Native boundary

Reuse the existing Postgres claim locks, opaque claim tokens, operation replay,
saved execution connections, and native runner registration/reconciliation.
The missing boundary is an explicit, inspectable, operator-pinned claim authority
for contributors sharing the same backlog, not another execution loop or lock service.

## Implemented candidate

- Persist a non-secret, Corp-scoped claim-authority UUID, stable across restart.
- Expose it through an authenticated read and the existing Corp/UI projection.
- Pin new shared Factory policy and validate it in native preflight/claim paths.
- Keep legacy local execution explicitly uncoordinated and retain old policy bytes.
- Cover distinct ledgers with equal Corp IDs, concurrent same-ledger claims,
  reconnect, and source mismatch without touching retained operator data.
- Keep physical multi-host acceptance separate from same-host process fixtures.

## Review boundaries

The recorded source-drift preflight accepted its deterministic plan; dispatch
rejected after claim/materialization, leaving a blocked item/mission and zero runs.
This narrower result is preserved, not rewritten as pre-claim rejection. Review
plan-validity versus dispatch-readiness semantics as a separate narrow follow-up;
the authority candidate does not change the existing planner branch.

QA depends on PR #237 at `b31a38a62330aacba80c3953142e1da957a63ecd` plus
the exact [native-timestamp patch](../../../tools/issue161/pr237-native-time.patch).
Its base, dirty-file scope and SHA-256 are checked by the QA driver. Coordinate
the helper fix there without importing the broader PR. Keep the refused reconnect
attempt and separately successful attempt distinct.

The approved PR-preparation pass updates documentation and local publication
drafts only, then runs the final repository gates. It does not change application
behavior or rerun the retained full stack. Production authentication, independent
human/provider identities, physical multi-host acceptance and real GitHub/provider
effects remain unproven. #248/#249 retain their separate ownership and scope.
