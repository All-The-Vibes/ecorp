# Usage provenance and known subtotals

`UsageReport` extends the existing runner event journal and run counters. It is a
prerequisite for issue #236's budget-auditor evidence, not an implementation of
delegated audits, budget extensions, recoverable waiting, or their UI. No new
ledger, migration, scheduler, permission, provider call, or price estimator is
introduced.

## Quantities and units

Input tokens, output tokens, and integer micro-USD are optional. Missing and JSON
`null` mean unavailable; an explicit zero remains a reported quantity. Token
coverage is `reported`, `partial`, `unavailable`, or `invalid`. USD coverage is
`reported`, `unavailable`, `invalid`, or `legacy_unverified` when a legacy amount
lacks provenance. These labels describe an observation, not a reconciled bill.
`complete_provider_bill` is always false. Known integer run subtotals stay
compatible with existing DTOs; a zero subtotal cannot establish free work or
safe dollar headroom when any billing observation is missing.

The enforcement denominator remains input plus output. Cache and reasoning
breakdowns never add tokens a second time. For a mapping that defines them as
subsets, 100 input including 40 cache-read and 10 cache-write, plus 20 output
including 5 reasoning, is 120 tokens. Each declared subset is checked against
its parent. This does not assume two cache categories are disjoint.

Negative, fractional, conflicting, overflowing, or malformed token and monetary
counts are invalid, not rounded or clamped. The entire observation is uncharged
and redacted. Native fractional model multipliers and nano-AI units have their
own nonnegative finite fields; they never become USD. No estimated-price mode,
price table, missing-price-bucket total, or monetary arithmetic is implemented.
Preparation, implementation, review, monitoring, and externally incurred billing
remain unknown unless separately measured.

## Native mappings

| Mapping | Native evidence and limitation |
| --- | --- |
| `copilot_sdk_1_0_11_usage_v1` | SDK 1.0.11 with checked CLI 1.0.79; public `assistant.usage` input/output, cache, reasoning, model, event and optional call IDs. Native `cost` is a model multiplier; `copilotUsage.totalNanoAiu` is nano-AI units. Neither is USD. Reasoning is an output subset; cache inclusion is not asserted for every model. |
| `codex_app_server_last_v1` | `thread/tokenUsage/updated` uses `last` as the call delta, scoped to the active thread/turn. The monotonic total is only a duplicate cursor. Cache/reasoning are subsets. An exact Codex binary version is not currently enforced or invented in provenance. USD is unavailable. |
| Generic external and synthetic fixture mappings | Preserve optional integer snake/camel-case counts; conflicting aliases are invalid. A supplied micro-USD amount has its explicit unit, but is not independently verified billing. No provider-wide identity or aggregate convention is inferred. |
| `retained_usage_aggregate_v1` | Collect-only session evidence. A missing component keeps that aggregate component unknown. It must never be charged again as another call. |

The pinned Copilot generated event source inspected for this mapping is
`rust/src/generated/session_events.rs` at upstream commit
`a550258d5c37bd662197536992a23d633bfe5804`, SHA-256
`e6f7a20427bc163fbd61579167baeaa18bc63b7d9d02cd43633a95571c18255a`.
The cached crate's VCS metadata says `dirty:true`; this is a file-level check,
not a claim that the whole crate equals upstream. Optional type definitions do
not establish that every CLI/model emits every optional field. Private billing
objects, prompts, and quota internals are not collected.

## Admission, identities, and controls

The server retains its exact Corp/run/runner/assignment fences. Within those
locks, the store validates usage and recomputes coverage, identities, origin,
and admission; runner-supplied accounting flags cannot grant authority. A
reported native session must equal the persisted run session. When omitted,
the persisted session supplies only the identity comparison scope, without
rewriting the original provenance. An absent stored session cannot establish
native per-call attribution.

Persisted `call_identity` coverage is `reported` only for an accepted or duplicate
observation with admitted identity keys. Rejected sessions, conflicts, invalid
reports, aggregates, overflows, and observations without native identity remain
`unavailable`. An omitted session may still establish an identity through the
persisted run session; the journal keeps the originally reported provenance.

Journal event replay remains idempotent. Available native event/API/provider
call aliases identify additional replays within the same assigned run. Matching
replays may enrich aliases transitively; contradictory observations cannot claim
new aliases or overwrite a prior quantity. Equal counts never identify a call.
Within the active Codex turn, a regressing cumulative cursor and a contradictory
report at the same cursor retain invalid, uncharged evidence without rewinding
the accepted cursor. An exact duplicate at the accepted cursor is suppressed;
a later increasing cursor can still contribute its call delta once.
Without native IDs, distinct journal frames remain distinct and identity
coverage stays unavailable. Four distinct worker/retry/auditor/failed-call
observations of 100/20, 30/10, 10/5, and 7/3 total 147 input plus 38 output,
or 185 tokens; replays and parent aggregates add nothing. These role labels in
fixtures establish arithmetic, not actual auditor independence.

Run and enclosing mission/requester/Corp signed subtotals must fit before any
charge; an overflow preserves an uncharged journal observation without partially
updating counters. Existing rolling-window membership and database-clock hard
control grace remain in effect. Structural `usage_validation.disposition =
accepted` does not override terminal state or a hard control. Terminal-session
evidence cannot resume execution, add late charges, accept completion, change a
verifier, reset an incident, enlarge an allowance, or supply an approval.

Invalid reports retain null quantities and fixed, bounded validation metadata,
not raw provider input. Valid identifiers use a bounded ASCII identifier
alphabet. Room revocation hides scoped evidence without deleting the ledger.
Existing retained Codex evidence and control observations may now contain null
usage quantities; their readers must preserve that distinction. The separate
`run.session_terminated` schema is unchanged.

## Verification and comparison boundaries

Run the full locked contributor lane with `pnpm check`. Focused pure regressions
are `cargo test --locked -p crony-domain usage::tests` and
`cargo test --locked -p crony-runner usage`. The latter consumes the deterministic
native-notification corpus in
`crates/crony-runner/tests/fixtures/usage-provenance-v1.json`.

Store cases named `issue236_` require an explicitly owned disposable PostgreSQL
fixture and the opt-in command
`cargo test --locked -p crony-store issue236_ -- --ignored --test-threads=1`.
They cover scoped four-call arithmetic, exact/journal/native replay, alias
enrichment, equal counts, missing IDs/session/quantities, native units,
redaction, assignment, revocation, terminal/hard controls, and signed run and
aggregate limits. Ordinary workspace tests report these cases as ignored.
Neither compilation nor ignored discovery is a database execution receipt.

The issue's offline comparison is a separate, prospective procedure. Freeze
baseline `878a1774774b0630c904cbaf4b05e1b346777817`, an actual committed
candidate, fixture and instrumentation hashes, pins, expected outcomes, and
equivalent fresh disposable states before executing either arm. No provider
or external network calls and no retained/manual database are permitted. Stop
both arms at the first accounting mismatch, scope leak, or 30 minutes of total
fixture runtime. Preserve a failing baseline and mark subsequent rows/arms
unexecuted. Standalone candidate regressions are not a replacement comparative
pass. Freeze a new authorized epoch before changing a protected expectation.

Browser acceptance must traverse the real web/server/runner in a fresh owned
stack. A deterministic native transport fixture is explicitly synthetic; it is
not provider billing, an auditor decision, a learning trial, hosted CI, or
independent outcome review. Issues #193 and #235 remain stopped. Full issue #236
also needs scoped auditor delegation, early deduplicated audits, atomic bounded
grants, recoverable waiting, UI, and independent outcome review.

Rollback selects a compatible adapter/reader for future runs. Preserve recorded
observations, original allowances, active provenance, spend, and audit history;
never decrement counters or erase a previous estimate. Revalidate on provider,
CLI/schema, identity, ledger, or verifier changes.
