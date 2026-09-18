# U7 multiplayer parity: requirements and evidence map

This is a source-bound verification design, not a second backlog, completed test
report, dispatch contract or release claim. [Feature #246][feature], [verification
task #316][verification] and [ECorp Build Project #5][project] remain authoritative
for current scope, sequencing, ownership and status.

Read [AGENTS.md](../../AGENTS.md), [CONTRIBUTING.md](../../CONTRIBUTING.md), the
[product plan](../PRODUCT_AND_TECHNICAL_PLAN.md), [architecture](../ARCHITECTURE.md),
[security](../SECURITY.md) and [evidence rule](../EVALS.md#evidence-rule) before
implementation or runtime verification.

## Source and evidence boundaries

Reviewed on September 17, 2026:

| Source | What this map can claim |
| --- | --- |
| Integrated main at `30ec3fab6acd566cc1fc1e574c8a6343d0ce0596` | The consumer inventory and baseline contract observations below were checked against this source. It includes the landed activity/freshness, cost-preflight, startup-validation and steering-lock-order changes. |
| PR #306 review candidate at `9df9f072467040e16561db9073908108d880c801`, tracked by [#313][foundation-task] | Merges the exact main baseline above without rewriting the published foundation history. This collaboration code is still separate from main, not a merged or complete U7 feature. |
| [Fresh integrated-source local evidence][integration-evidence] | 310 frontend tests, 554 passed/343 ignored Rust tests, six repository gates and a native browser/server/runner rehearsal passed at the stated synthetic-fixture scope. Includes snapshot failure/recovery, actual WebSocket disconnect, scoped drafts, exact-run navigation, independent development-actor review, artifact denial and desktop/390px captures. |
| Historical [foundation evidence][foundation-evidence] and [CI run][foundation-ci] at `e421377a49a6f1d3fbf3a3f71d00e20eba5e3f82` | Earlier 273 frontend tests, 547 passed/323 ignored Rust tests and six successful CI checks apply only to that old source. Neither old nor new local fixtures establish independent production identities or cross-owner acceptance. |

This documentation adds no runtime behavior and performs no new multiplayer
end-to-end rehearsal. Passing existing checkout regression gates is not a new
acceptance verdict for this matrix. A later UI/backend combination needs its own
source pins and applicable tests; never carry an older pass forward implicitly.

The reviewed collaboration candidate retains #265's ISO snapshot receipts,
refresh-failure metadata and exact-run navigation. Its expired synthetic QA runner
credential was recovered through native same-ID re-enrollment only after explicit
operator approval; the initial blocked checkpoint remains recorded in its report.
The original office, retained work, source and artifact history were preserved.
The final source also corrects the start guide's stale runner-connectivity label.
This main-based documentation branch separately passed 279 frontend tests and
554 Rust tests (343 ignored) plus the six repository gates. Its regression passes
do not execute or accept the future matrix. Hosted results must be checked against
the actual published PR heads; historical CI is not a pass for these new commits.

The integrated baseline now includes #265's run-activity/exact-run navigation,
snapshot-read failure and finished-review reconnect behavior, #307's Factory
planning cost preflight/admission, #290's steering lock-order fix, #288's startup
validation, #278's PR template and #275's Project #5 guidance. #251's read-only
Repo Steward is not runtime authority or an alternative multiplayer control plane.
These landed slices are reused; this map does not take ownership of them.

AC1-AC6 below identify the original six acceptance bullets of #246, in order.
They do not replace or invent identifiers for the retained R1-R14/M01-M37
contracts. If the issue's acceptance changes, reconcile that change explicitly.

## Traceability

| Original requirement | Implementation/integration owner | Reusable foundation at the stated source | Evidence still required |
| --- | --- | --- | --- |
| **AC1:** shared machine/agent selection; ownership, grants, capacity, source readiness, queue reasons and unsupported capabilities | [#314][selection], consuming #241/#243/[#244][source-preparation]/[#245][scheduling] and #48/#198 | Existing mission-preview request builder, runtime/source matching and ConnectionsPanel. PR #306 displays recorded assignments; it is not a shared-resource picker. | Owner, granted-member and denied views; authoritative readiness; vanished selection, source mismatch, saturation and unsupported capability. Selection/preview must not launch or grant authority. |
| **AC2:** every approved parity row with independent members and an unauthorized actor | [#316][verification]; aggregate gate [#246][feature] | Existing unit/SSR suites and the separate foundation fixture | Per-row source, authenticated actor, expected role/grant decision, artifact/evidence links and explicit blocked/unsupported verdicts. Several demo tabs are insufficient. |
| **AC3:** control leases, approvals, budgets, recovery lineage, publication boundaries, historical attribution and artifact authorization | [#313][foundation-task] foundation plus [#316][verification]; reuse #145 and native contracts | Foundation exact-run/controller projection, workflowContext eligibility, existing lease/decision/artifact paths and the integrated [steering-order regression](../EVALS.md#steering-and-run-status-transaction-ordering-issue-223) | Cross-user/revoked-grant outcomes, competing control and queued delivery, exact source/run/hash review, budget/recovery restrictions and authority changes before effects. Comments, steering, action approvals, outcome decisions and publication remain distinct. |
| **AC4:** consistent web/CLI/Factory/MCP/ACP/A2A launch behavior; legacy immediate-only compatibility; no unauthenticated team-mode A2A | [#315][consumers], consuming #244/#245; coordinate #204/#254 | CreateMissionRequest carries source and optional workspace_connection_id; PreviewMissionResponse carries strategy/budgets/task estimates; LaunchMissionRequest carries requested_by. Existing gateway request adapters remain the integration boundary. | Consumer-specific accepted/rejected request cases on the landed contract; missing/stale/cross-owner/incompatible values rejected before effects, deliberately supported legacy behavior and no duplicate run. |
| **AC5:** bounded startup/snapshot coalescing, revocation on open clients, replay and long-lived subscriptions | [#316][verification], reuse #5/#168/[#242][sign-in]; coordinate #254 | Existing replay/coalescer machinery; foundation disconnect/selection/draft guards; integrated [startup configuration boundary](../EVALS.md#server-startup-configuration-boundary-271) | Revoked actor with an already-open client, suspended/offline browser, late/duplicate response, replay cursor and scope replacement against the real authority. No parallel refresh or presence manager. |
| **AC6:** complete browser/server/runner parity and retained single-user regressions, with honest limitations | [#316][verification] -> [#246][feature] -> [#249][release] | Existing focused suites, six repository gates and owned-fixture procedures | Integrated-source full-stack report, single-user regressions, retained negative cases and required independent review. Real-owner/imported-agent, production identity, physical-device and real-provider verdicts remain separate. |

The inspected create/preview types do not supply the complete shared
owner/grant/capacity/readiness contract required by #314. Do not invent fields,
infer grants from runner liveness, or treat a UI affordance as implementation of
#244/#245. Confirm actual landed contracts before selecting the consumer diff.

## Consumer and regression inventory

| Surface | Source to inspect | Existing checks to reuse |
| --- | --- | --- |
| Web mission preview/creation/launch | [App][app], [missionPreview][preview], [missionRuntime][runtime], [workspaceConnections][connections] | Their existing *.test.mjs suites and missionComposer.test.mjs; preserve exact serialized source/connection binding and separate preview, saved plan and explicit launch. |
| Collaboration foundation, not integrated main | [missionCollaboration.ts][collaboration], [MissionCollaborationPanel.tsx][collaboration-panel] | [missionCollaboration.test.mjs][collaboration-tests] on the foundation candidate; exact run/actor scope, missing selection, disconnect and late draft generations. |
| Human CLI | [crony-cli/src/main.rs][cli] | Existing CLI unit tests and source-routing fixture; no implicit bypass or guessed queue field. |
| Factory | [crony-cli/src/factory.rs][factory], [factory_connection_tests.rs][factory-tests] | Existing saved-connection, claim/policy, planning cost preflight/admission (#307) and cockpit checks; reuse #204, not another intake queue. Cost policy does not supply the pending owner/grant/capacity contract. |
| Run activity and exact evidence navigation, integrated main | [runActivity.ts][run-activity], [evidenceNavigation.test.mjs][evidence-navigation] | #265's activity/freshness, exact older-run selection and finished-review reconnect regressions. The collaboration integration must retain ISO snapshot receipts and refresh-failure metadata; a live transport alone is insufficient freshness. |
| MCP | [crony-mcp.rs][mcp], [handle_mcp / mcp_mission_request][gateway-lib] | Native gateway unit tests and e2e_gateways.mjs; inventory exposed operations before declaring a launch path supported. |
| ACP | [crony-acp.rs / acp_mission_request][acp] | Native gateway tests; retain session/mission/source context and explicit native launch semantics. |
| A2A | [crony-a2a.rs / a2a_mission_request][a2a] | Native gateway tests; verify authentication and admission, not just successful protocol negotiation. |
| Common wire contracts | [crony-protocol/src/lib.rs][protocol] | Existing serialization/compatibility tests; reconcile the landed types with #254. |

These are source references, not new write scopes. The following existing
full-stack drivers are candidates for the corresponding matrix rows:

- [Rooms and threads](../../tools/e2e_rooms.mjs), [control leases](../../tools/e2e_leases.mjs),
  [browser replay](../../tools/e2e_replay.mjs) and [runner reconnect](../../tools/e2e_runner_reconnect.mjs).
- [Repository routing](../../tools/e2e_mission_repository_routing.mjs),
  [gateway behavior](../../tools/e2e_gateways.mjs), [artifact authorization](../../tools/e2e_artifacts.mjs)
  and [cockpit reconnect](../../tools/e2e_factory_cockpit_reconnect.mjs).
- [Run activity](../../tools/e2e_factory_run_activity.py) and
  [cost preflight](../../tools/e2e_factory_cost_preflight.mjs), with each driver's
  own fixture ownership and retained-state restrictions.

A listed driver is not proof that it covers every new U7 row. Read its setup,
assertions and cleanup boundaries before adapting or executing it. Do not run a
seed/reset phase over retained data.

## Minimum evidence record for each applicable case

Record: original requirement reference, exact UI/server/runner commits, consumer,
actor class, Corp/room/source/installation identity, current grant or lease,
precondition, intended request, expected result, observed side effects,
idempotency/replay outcome, evidence link and reviewer verdict. Identify the
actual fixture and resource owner without storing credentials or private tokens.

Use explicit verdicts: **not run**, **blocked by prerequisite**, **passed at stated
scope**, **failed with retained evidence**, or **not applicable with reviewed
rationale**. Missing/ignored coverage is never a pass or a completion percentage.

Cover at least:

- Owner, explicitly granted member, member lacking the needed role/use grant,
  revoked member with an already-open client, and nonmember/cross-Corp requests.
- Live, reconnecting and offline clients; disappearing selections; stale or
  reordered responses; server restart; supported/unsupported version combinations.
- Preview, creation, explicit launch, held/queued intent where supported, comment,
  control request, queued direction, transfer/steer, action approval, outcome
  review, budget/recovery and authorized artifact read.
- Exact task/run/source/hash navigation when older evidence and newer work coexist;
  unavailable selected work must not silently redirect to another item.
- Desktop and measured 390px layouts, keyboard/focus, reduced motion and explicit
  stale/error/denied states. Presentation is not an authority boundary.

At this review, normal sign-in remains under #242's unresolved review/implementation
gate. Fixture design can proceed without reopening or executing that rejected
workflow. Final integrated acceptance also depends on #313/#314/#315 and the
applicable #239 requirements. Use live issues for subsequent status changes.

## AI agent integration handoff

1. Read the relevant UI and backend issues/PRs plus current repository guidance.
   Record actual commits, contract fields, nullability, ordering, scope/error
   semantics and landing order. Separate hard blockers from coordination links.
2. Treat #244/#245 as prerequisites for #314/#315 implementation, not for writing
   this verification map. Refresh those contracts before proposing consumer edits;
   an issue description or mock payload is not a shipped API.
3. If a backend change alters a consumed contract, identify the affected UI adapter,
   projection and tests above. Make only the currently authorized compatible change
   or report the exact blocker. Do not replace the native harness or overwrite
   another contributor's overlapping work.
4. Verify the combined source, including authorization/revocation, reconnect,
   idempotency and exact evidence selection. Reuse owned fixtures, retain failures,
   and report ignored/unrun checks and production limits.
5. Keep #316, #246 and #239 open for their full acceptance. This map does not grant
   authority to dispatch, request review, change PR readiness, merge or deploy.

## Reuse rather than duplicate

- #145: contextual operating lane, notifications, control requests and decision load.
- #257/#258/#259/#260/#261/#262: console history, activity, source review, budgets
  and recovery forms. PR #265's activity slice is landed in the pinned baseline;
  preserve its exact-run and freshness semantics during collaboration integration.
- #266/#263/#264: design system, themes and presentation modes.
- #253: authenticated ephemeral human presence and its privacy lifecycle.
- #254: internal browser/server/runner compatibility, not external gateway design.
- #247: shared backlog mutations; editing tracking issues is not that implementation.
- #248/#249: deployment, physical-device rehearsal, load and release verdicts.
- #285: separate OBO work. Agent mesh and memory integration are not introduced here.

Preserve the centralized floor and agent-inspector modal, one authoritative
control plane, owner-controlled runners, historical attribution and durable
evidence. The absence of a human in the snapshot or an offline runner must not be
converted into invented presence or permission state.

## Planned validation and safety boundary

For future accepted runtime work, run focused regressions and all repository gates:

```powershell
node tools/check_migrations.mjs
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm build:web
pnpm lint:web
```

Use only explicitly owned isolated fixtures for browser/server/runner checks.
Record process/port ownership before startup; preserve credentials, native data,
source worktrees and failed evidence. Stop only owned QA services afterward.
Do not bootstrap/reset the manual office or rerun its seed phase. Production
sign-in, hostile-execution qualification, physical-device and real-provider/GitHub
effects need their own applicable authorization and evidence.

A documentation PR for this map should use a non-closing reference to #316. It
supplies a verification contract, not completed test evidence or release approval.

[feature]: https://github.com/All-The-Vibes/ecorp/issues/246
[verification]: https://github.com/All-The-Vibes/ecorp/issues/316
[project]: https://github.com/orgs/All-The-Vibes/projects/5
[foundation-task]: https://github.com/All-The-Vibes/ecorp/issues/313
[selection]: https://github.com/All-The-Vibes/ecorp/issues/314
[consumers]: https://github.com/All-The-Vibes/ecorp/issues/315
[source-preparation]: https://github.com/All-The-Vibes/ecorp/issues/244
[scheduling]: https://github.com/All-The-Vibes/ecorp/issues/245
[sign-in]: https://github.com/All-The-Vibes/ecorp/issues/242
[release]: https://github.com/All-The-Vibes/ecorp/issues/249
[foundation-evidence]: https://github.com/All-The-Vibes/ecorp/blob/e421377a49a6f1d3fbf3a3f71d00e20eba5e3f82/docs/evidence/2026-09-16-multiplayer-ui-first-slice.md
[foundation-ci]: https://github.com/All-The-Vibes/ecorp/actions/runs/35165488545
[integration-evidence]: https://github.com/All-The-Vibes/ecorp/blob/9df9f072467040e16561db9073908108d880c801/docs/evidence/2026-09-17-multiplayer-ui-integration.md
[app]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/apps/web/src/App.tsx
[preview]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/apps/web/src/missionPreview.ts
[runtime]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/apps/web/src/missionRuntime.ts
[connections]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/apps/web/src/workspaceConnections.ts
[collaboration]: https://github.com/All-The-Vibes/ecorp/blob/9df9f072467040e16561db9073908108d880c801/apps/web/src/missionCollaboration.ts
[collaboration-panel]: https://github.com/All-The-Vibes/ecorp/blob/9df9f072467040e16561db9073908108d880c801/apps/web/src/MissionCollaborationPanel.tsx
[collaboration-tests]: https://github.com/All-The-Vibes/ecorp/blob/9df9f072467040e16561db9073908108d880c801/apps/web/src/missionCollaboration.test.mjs
[cli]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/crates/crony-cli/src/main.rs
[factory]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/crates/crony-cli/src/factory.rs
[factory-tests]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/crates/crony-server/src/factory_connection_tests.rs
[mcp]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/crates/crony-gateways/src/bin/crony-mcp.rs
[gateway-lib]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/crates/crony-gateways/src/lib.rs
[acp]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/crates/crony-gateways/src/bin/crony-acp.rs
[a2a]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/crates/crony-gateways/src/bin/crony-a2a.rs
[protocol]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/crates/crony-protocol/src/lib.rs
[run-activity]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/apps/web/src/runActivity.ts
[evidence-navigation]: https://github.com/All-The-Vibes/ecorp/blob/30ec3fab6acd566cc1fc1e574c8a6343d0ce0596/apps/web/src/evidenceNavigation.test.mjs
