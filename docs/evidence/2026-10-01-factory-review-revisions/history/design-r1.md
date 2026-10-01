# Issue 95 completion work

This is a design and ownership record, not implementation or acceptance evidence.

The isolated managed checkout is `<ISOLATED_CHECKOUT>`, branch `codex/issue95-governed-review-revision`. It was fast-forwarded from current main `878a1774774b0630c904cbaf4b05e1b346777817` to prerequisite PR #390 head `7e65f46a0c0f991460eeb4c5b60723d2e0dff1f9`. Both commits remain in its history. The checkout was clean when this continuation started. No issue 95 code, test execution, service or dependency installation preceded this record. The configured source checkout and its local documentation edits remain untouched.

Queue reconciliation is in `queue-reconcile-r4.json`: authenticated actor `shyamsridhar123`, 97 open issues excluding PRs, 12 open PRs, unchanged main, prerequisite head matching this checkout. Required hosted checks are unavailable while Actions is disabled; this run will not merge or close implementation issues without those checks.

## Intended behavior

- Record bounded, typed review findings under the authenticated actor, linking exact publication, PR and published head.
- Keep the accepted mission, task, run and deliverable immutable. Create a separate correction mission in the original room, retaining the original requester as budget owner and attributing authorization/events to the real actor.
- Enter explicit `review_revision` Factory state while keeping the original mission selected. After complete verification and a fresh independent review, explicitly adopt the correction and return the selected item to `verified`.
- Reuse native staffing, task dispatch, isolated workspaces, provider fresh/resume sessions, permission handlers, verifier and create-only publisher. The pinned SDK 1.0.11 and CLI 1.0.79 already provide those execution mechanisms. Signed publication-source reconstruction and tenant-scoped publication succession are ECorp control-plane responsibilities.
- Inherit the exact source repository/base/connection, scope, tools, secrets, model, deadline and deliverable contract. Allocate only remaining original mission and task token/cost authority and remaining task attempts. Keep every saved check and restrict the manual gate to independent review.
- Restore the signed portable source into a new private workspace before native execution. Add explicit runner capability negotiation; old runners cannot silently discard the revision seed. Resume only the preserved workspace with the same immutable seed authority.
- Allow one successor per publication and a bounded nonforking chain. Native run retry consumes the correction's remaining attempts; it does not authorize another correction mission against the same predecessor.
- Create one explicit superseding publication on a distinct deterministic branch. Preserve the original publication and expose history separately from current selection. Revalidate live predecessor PR/branch identity before publication and on completed publication replay so manual drift fails closed.
- Project original result, findings, correction task/run, adopted result and review head in the UI. Keep governance in server/store operations.

## Required verification

Meaningful policy, scope, budget/attempt, replay/concurrency, provenance, runner seeding/resume, review independence and remote drift regressions; full canonical `pnpm check` with locked dependencies and all 11 current gates; native database and EVM receipts; fresh owned browser/server/database/runner/Git acceptance; source-bound evidence and implementation review before a draft stacked PR dependent on #390.

Prior #390/#389 results are historical evidence only and do not validate future #95 changes. Node currently available is 24.21.0 while the repository declares 24.19.0; any resulting validation must disclose this difference. `docs/PROJECT_MEMORY.md` is absent from current main; the user's configured-source guidance was read, not silently added or claimed as tracked main content.
