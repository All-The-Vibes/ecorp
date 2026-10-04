# Implementing-agent review of the finite ceiling

Reviewed product: `44a451be3262016635fa1dcca8d0365291664678`, parent
`878a1774774b0630c904cbaf4b05e1b346777817`. Current-main contributor, product,
architecture, security and evaluation guides were read. `docs/PROJECT_MEMORY.md`
was absent on main; the configured checkout's preserved copy was supplemental.
The expanded contributor authorization permits this prospective draft; it does
not certify the historical Factory workflow.

The review inspected the changed production paths, surrounding dispatch/recovery
helpers, budget locks and queries, migrations, helper safety checks, tests and
the actual final-source evidence. No additional confirmed blocking code defect
was found in that scoped review. The acceptance gaps below still block completion.

| Contract | Source and observed coverage | Disposition |
| --- | --- | --- |
| Finite exact integer and rejected invalid bounds | Domain constant; planning; store/revisions; UI; migration 0057; numeric/frontend/SQLx/API cases | Implemented and locally validated |
| Initial remaining authority | `clamped_token_allocation` and initial dispatch under existing locks; SQLx mission/rolling/exhaustion cases; native requester/Corp/zero cases | Implemented and locally validated |
| Overflow-safe percentages | i128 intermediates preserve 75/90/100/110 thresholds; real numeric regressions | Implemented and locally validated |
| Migration compatibility | Only new 0057 and manifest added; existing applied SQL and persisted allocations/spend preserved in fresh-store regression | Locally validated; deploy against updated main only after required gates |
| Real helper commands | Numeric Cargo/frontend execution; qualified descriptor; disposable Git boundary; pinned frozen/offline pnpm; actual child logs | Implemented and locally validated |
| Full-stack source identity | Cargo artifact digest, native process creation/listener identity, served source-map bytes, signed artifact bytes | Observed on the recorded physical candidate with synthetic peer |
| Completion workflow | Native Factory exact-source verification/publication; genuine independent human outcome decision | Not completed |
| Merge readiness | Required hosted CI, CodeQL, security and quality/review gates on current head and base | Not established; draft only |

The change introduces no new execution or permission engine. It reuses existing
harness adapters, approvals, budget locks, rolling queries, workspace ownership
and verifier policy. Native tool permission is not treated as tenant authority or
OS isolation. Task/mission sums use checked arithmetic; authored smaller policies
remain valid. The verifier-only zero allocation keeps its existing separate
semantics. Cost/attempt/loop controls are not enlarged by the finite token default.

Source line references for the product commit: `crates/crony-domain/src/lib.rs:30`,
`crates/crony-store/src/lib.rs:573` and `:6520`,
`crates/crony-server/src/planning.rs:1300`,
`crates/crony-store/src/token_ceiling_tests.rs:215`, `:328`, `:403` and `:444`,
`apps/web/src/App.tsx:64`, and `tools/e2e_token_ceiling.mjs:208`, `:270` and `:305`.
The complete diff and receipts remain the authoritative review inputs.
