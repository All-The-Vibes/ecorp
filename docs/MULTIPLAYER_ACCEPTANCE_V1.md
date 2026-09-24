# Multiplayer acceptance v1: replacement contract

**Status: proposed replacement, not accepted runtime evidence.**

This specification was requested on September 17, 2026 (US Central) when the
R1-R14 / M01-M37 handoff referenced by issues #239-#249 was not available to its
contributor. The September 18 update to #318 establishes that original artifacts
are retained locally, although they are not a published canonical contract.
G0 requires their source-bound inventory and a reviewed crosswalk with MP1,
explicit differences and exact adopted bytes; adoption alone is insufficient.
The initial MP1 proposal is grounded in published acceptance criteria, related issues #51, #161,
#213, #253 and #254, and source baseline
`30ec3fab6acd566cc1fc1e574c8a6343d0ce0596`.

The `MP1-Rxx` and `MP1-Txx` identifiers below are **new requirements and test
families**. They do not reconstruct the contents, numbering or approval history
of the retained original plan. The intentional exception in subject matter is MP1-T34,
which covers the hostile-boundary obligation explicitly described as M34 in
#240 and #249; its correspondence to the original matrix must be reviewed in the crosswalk.

No test family is accepted by writing this document. All initially have verdict
`not_run`. A family expands into multiple executable cases, not one green checkbox.
Existing evidence can be linked as historical evidence only until its source,
configuration, scope and assertions are reconciled.

## Decision: separate development dependencies from activation gates

Reconciliation work should not prevent contract design, implementation or
isolated deterministic testing. It also must not become an excuse to enable
unqualified shared execution. Replace the single all-or-nothing U1 dependency
with the following gate semantics **when this replacement is adopted**:

| Gate | Required outcome | What it permits | What it does not permit |
| --- | --- | --- | --- |
| G0: development entry | Inventory source-bound original artifacts with distinct original/publication hashes; review the crosswalk and differences against MP1; adopt exact reviewed bytes, record the source baseline and bounded write scopes; assign each implementation slice a test family and explicit disabled/unavailable behavior. | U2 schema/API implementation and independently reviewable U3-U10 preparatory work in isolated branches. Real isolated database tests may run under their own fixture ownership. | Shared execution, production migration, deployment, credentials/spend, or a claim that U1 passed. |
| G1: owned baseline | MP1-T01-T10 pass on the candidate, including actual owner-only browser/server/runner/database operation; publish the initial MP1-T36 parity inventory and all missing cells. | Integrating the demonstrated owner-only baseline and building further integration tests in an owned QA environment. | Cross-owner execution, production sign-in claims based on synthetic OIDC, or U1 closure without its other criteria. |
| G2: shared-execution admission | G1 plus current identity/grant/source/scheduler/compatibility and governance cases for the proposed operation, MP1-T34/T35 for every enabled cell, and configuration-bound admission enforced at the actual server/runner boundaries. | Only the qualified, explicitly scoped shared operations in the selected QA environment. | Other providers/platforms/surfaces, unbounded spend, production deployment, or unsupported clients. |
| G3: release | Every applicable family passes on the integrated candidate, full repository gates pass, and #248/#249 production, independent-identity, physical-device and external-effect verdicts pass separately. | A separately reviewed release decision for the tested scope. | Automatic merge, deployment or migration of the existing office. |

G0 is a contract/review milestone, not a sandbox pass. Feature code can be developed
before G1/G2; it must not expose new unqualified effects. Do not assume that a
feature flag or readiness field already exists. Each implementation must identify
its real admission boundary, implement the minimum required deny-by-default
behavior, and test direct callers as well as the UI.

In particular, no browser label, runner heartbeat, provider permission callback
or peer-declared capability can enable cross-owner work. Unsupported/unqualified
requests must be rejected before effects with actionable diagnostics. A safe
owner-only fallback must be explicitly selected, never silently substituted.

### Backlog changes to make at adoption

Keep GitHub Issues and organization Project #5 as the only live backlog. This
document defines acceptance, not a parallel task/status board.

1. Record the replacement version and sequencing decision on #239 and #240.
2. Keep #240 open for full U1 acceptance. Split out one bounded G0 dependency
   outcome, link it to this specification, and make #241's **development start**
   depend on that outcome instead of full #240 closure.
3. Retain #240 as a runtime/integration requirement for the affected operations
   and an explicit #249 release blocker. Do not delete its acceptance criteria.
4. Keep the substantive contract ordering: U2 -> U3/U4 -> U5/U6 -> U7/U8.
   Drafting tests/UI adapters can overlap, but consumers cannot be accepted
   against invented or unmerged provider contracts.
5. Reference this version from #253/#254 and U7 child tasks #313-#316. Preserve
   their owners, scopes and separate acceptance.
6. Record the distinct #242 browser-auth review decision. Adoption of this spec
   does not restart or approve the previously rejected integration plan.

These are proposed metadata changes; creating this file changes no GitHub
dependency, assignment, Project status, `factory:ready` label or review state.
If native issue dependencies cannot represent a partial gate, use the separate
bounded G0 issue rather than marking the whole of #240 complete.

## Requirements

All requirements use existing control-plane, runner, protocol, persistence and
artifact boundaries. No second scheduler, claim ledger, provider execution loop,
authentication system or microservice is introduced by this contract.

| ID | Required behavior | Published scope |
| --- | --- | --- |
| MP1-R01 | Fixture resources are newly owned and disjoint from retained offices. Source/configuration and evidence are pinned; failures and uncertain work are retained. Readiness expires on relevant drift and shutdown requires exact ownership proof. | #240, #213 |
| MP1-R02 | Normal browser OIDC sign-in uses verified principals, state/PKCE and appropriate session/CSRF controls; logout, callback replay, wrong issuer/audience/tenant and stale sessions fail safely. Keep the supported CLI bearer path; synthetic identity is not production sign-in. | #242 |
| MP1-R03 | Corp/room membership, invitations, owner identity and versioned use/host-action/usage grants are durable and enforced on every operation and live connection. Immutable principal binding and unambiguous-only legacy backfill prevent ownership invention. | #241, #242 |
| MP1-R04 | Persistent Agent identity is distinct from versioned owner-bound AgentInstallation and runner machine. Capacity, source installation, mission requester and exact run origin remain attributable through retirement and recovery. | #241, #243, #48 |
| MP1-R05 | Join codes and rotating workload credentials are bounded and revocable. Owners explicitly import supported local provider descriptors, not credentials/configuration/executables/history. Per-user Windows installation/update/removal preserves active work and credentials. | #243, #51 |
| MP1-R06 | Only authorized canonical repositories and immutable commits are prepared into runner-owned caches/worktrees. Source generations, cancellation and acknowledgements are fenced; credentials stay local and dirty/unverifiable work is preserved. | #244, #198, #204 |
| MP1-R07 | Existing scheduling admits work using current grants, source, compatibility and capacity atomically. Fair placement and durable explicit queueing cannot launch held plans, overbook capacity or release uncertain processes. | #245, #172 |
| MP1-R08 | Assignments, leases, connection generations and renewable execution authority fence retries/reconnects/partitions. Resume retains exact runner/worktree lineage; budgets, stop/suspend and pending approvals remain authoritative. | #245, #246 |
| MP1-R09 | Shared views reflect authorized server state. Control is leased, comments are not commands, and ephemeral authenticated room presence neither grants authority nor creates attendance history. | #246, #253, #145 |
| MP1-R10 | Action approvals, human outcome approval, independent review, budget ceilings and publication authorization remain distinct. Actor changes, retries, reconnects or UI paths cannot bypass their persisted policies. | #246, #249 |
| MP1-R11 | All six persisted verifier kinds must produce actual evidence. Artifacts are scoped, byte-checked and provenance-bound; download/review requires current authority. Claimed provider completion alone is insufficient. | #240, #246 |
| MP1-R12 | Shared backlog mutations use actor-attributed intents, fencing and recoverable partial effects through trusted integrations. One shared claim authority coordinates the same backlog; Project status is not a distributed lock. | #247, #161, #232 |
| MP1-R13 | Web/CLI/Factory/gateway semantics remain coherent, with explicit internal wire compatibility and fail-closed required features. Preserve single-user and legacy immediate-only behavior, bounded snapshots and replay. | #246, #254 |
| MP1-R14 | Enabled executable surfaces are positively qualified for the exact isolation configuration. Private deployment, lifecycle transitions, backup/restore and independent multi-device qualification have separate evidence; unsupported cells remain disabled. | #240, #248, #249, #51 |

## Fixture and evidence contract

### Owned resources

Use the existing `local_stack.psm1` process-identity helpers and E2E drivers where
applicable. The current `qa_multiplayer_preflight.ps1` is preparation only.
Its source check uses an owned temporary index outside the product, protected
roots and QA root, reports its creation/removal, and preserves the real source
index. Gitlinks are rejected before status can recurse into child configuration.
`qa_factory_run_activity.ps1` is a scoped deterministic supervisor, not a generic
U1/OIDC/M34 launcher; review any extraction instead of copying it blindly.
`owned_test_stack.mjs` supplies scoped server restart checks, not whole-fixture
ownership. No new implementation may adopt a process or database from a PID or
healthy endpoint alone.

The Windows preflight regression defaults to `-ShortAliasMode Required`: its
native 8.3 cases need a distinct short name and fail if the volume cannot supply
one. Hosted CI uses `-ShortAliasMode ReportUnavailable` to run the portable
guards while explicitly reporting the native alias cases as blocked and not
executed. This mode does not qualify the missing native lane. The separate
`tools/qa_multiplayer_preflight_modes.test.ps1` injects failed lookup and unchanged
spelling observations to verify both modes, including the later Git identity
check. Its synthetic cases are not actual native alias coverage. Provisioned
native acceptance must still run the default Required mode successfully.

Before a runtime test, record explicitly owned API/web/database ports, database
identity, private artifact backend/namespace, runner roots and enrollment identities,
disposable source repositories, browser profiles, identity-provider fixture,
execution profile, and supervisor receipts. Enumerate all protected office roots
and ports, including offline resources. Never inherit a database, credential or
provider home merely because an environment variable is set.

Use separate authenticated owner/member/nonmember sessions and a second Corp.
Alice/Bob/Eve development selectors are useful regression fixtures, not evidence
of independent human authentication. Use a real code/token/JWKS protocol exchange
with a controlled IdP for deterministic auth tests; separately exercise the actual
production IdP for its own gate. Choose an established compatible OIDC integration
in #242; do not write test-only token validation and call it application acceptance.

Hostile probes target only synthetic sentinel files/secrets, disposable repositories
and an owned test network endpoint. Never probe real user credentials or another
person's files. Run them only inside the selected isolated execution environment;
do not execute them unsandboxed on the contributor workstation to obtain a failure.
Permitted paths/operations and forbidden targets must both be exercised.

### Per-case retained record

Each executed case records:

- Spec version and case ID, timestamp, exact product/fixture source commits and
  applicable binaries' SHA-256; dirty-source runs are exploratory only.
- OS/build, adapter and native SDK/CLI version, browser/toolchain version, security
  profile, policy/schema versions, and non-secret fixture/process identity.
- Actor/Corp/room/runner/installation/task/run and source-generation identities
  relevant to the test; never raw tokens, connection strings or provider secrets.
- Preconditions, exact command/scenario, expected results, actual assertions,
  process exit codes, persisted state/events, artifact digests and evidence links.
- `pass`, `fail`, `blocked`, `not_run`, or `unsupported` verdict and scope. A skipped
  test is not a pass. Unsupported requires an explicit product scope exclusion and
  a passing rejection-before-effects case; it cannot quietly replace required support.
- Cleanup/shutdown result and protected-resource before/after comparison. Preserve
  failed attempts; a later pass never replaces the earlier record.

Use bounded deadlines declared before execution. Derive stop/expiry tests from the
configured lease and cleanup deadlines; record actual timings and fail if exceeded.
Do not increase timeouts after observing a failure to relabel the same attempt.
Separate flaky-fixture investigation under #213 from product acceptance.

Readiness must bind to the qualified executable/profile/policy/assignment surface,
not just a commit or heartbeat. Changes to executable bytes, provider versions,
permissions, environment allowlist, source/Git policy or isolation profile invalidate
the relevant qualification. Admission must fail closed until those cases pass
again. A cached client receipt or self-reported hash is not execution authority.

## Replacement test matrix

Every row is a test family with positive and negative executable cases. The
requirement links provide traceability; they are not proof of implementation.

| ID | Scenario and required oracle | Requirements | Unit |
| --- | --- | --- | --- |
| MP1-T01 | Fresh fixture creation and ownership: reject occupied paths/ports, aliases/reparse escapes, foreign resources and missing prerequisites before mutation. Actual services use independently owned receipts; a preflight-only pass is insufficient. | R01 | U1 |
| MP1-T02 | Protected office/source comparison: tracked, untracked and ignored sentinel bytes, Git refs, database identity, provider homes and process identities remain unchanged by the test; do not export private contents. | R01, R06 | U1 |
| MP1-T03 | Pin candidate/build/runtime/security configuration; reject stale or modified binaries/profile evidence and demonstrate qualification invalidation before new effects. | R01, R14 | U1 |
| MP1-T04 | Controlled OIDC code/token/JWKS exchange plus sandboxed browser: verify application integration and independent sessions; reject invalid/expired/replayed/issuer/audience/state/PKCE cases. Report production sign-in separately and retain #242's review gate. | R02 | U1/U3 |
| MP1-T05 | Create a held mission, reload browser and restart server: zero assignments until one authorized explicit owner launch; duplicate launch creates no additional run. | R08, R13 | U1 |
| MP1-T06 | Execute artifact/file/command/test/json_schema/screenshot checks from the persisted policy. Each kind has success and deliberate failure cases; bad/missing evidence prevents accepted completion. | R11 | U1 |
| MP1-T07 | Authorized artifact download matches stored length, digest, media and provenance; tampered, expired, foreign-Corp/room and stale-authority downloads fail without returning bytes. | R03, R11 | U1 |
| MP1-T08 | Nonmember and foreign-Corp denial across REST, snapshots, WebSocket subscription/replay and artifacts; assert neither hidden data nor new state/effects, including already-open clients after revocation. | R02, R03, R13 | U1/U3 |
| MP1-T09 | Browser reload, duplicate/reordered events, server restart and runner reconnect preserve exact history and supervision; replay neither duplicates commands nor fabricates termination. | R08, R13 | U1/U6 |
| MP1-T10 | Normal and failed fixture shutdown prove exact owned roots and descendants settled; stale/reused PIDs cannot authorize kills. Retain data/evidence and report uncertain teardown as failure. | R01, R08 | U1 |
| MP1-T11 | Real-database migrations and races for immutable issuer/subject bindings, Corp/room membership and principal classes; same-binding replay succeeds, reassignment/cross-Corp/ambiguous legacy claims fail. | R02, R03 | U2 |
| MP1-T12 | Invitations, acceptance, logout, expiration, replay and revocation against real server/database; authorization changes invalidate existing HTTP/browser/WS authority with no identity inferred from display email. | R02, R03 | U3 |
| MP1-T13 | Owner/use/host-action/usage grants and capacity changes: allow only current authorized scope; reject stale versions, nonowner updates and cross-Corp references atomically. Legacy ambiguous resources stay unclaimed/non-shareable. | R03, R04 | U2/U4 |
| MP1-T14 | Agent versus installation identity, origin and history survive mission staffing, rename, pin/unpin and retirement. Active/uncertain runs block unsafe removal; no historical requester/owner reassignment. | R04 | U2/U4 |
| MP1-T15 | Join-code/enrollment expiry and single consumption, rotating credential replay, revoke/rejoin and concurrent exchanges; codes never enter arguments, shared logs/events or issue text. | R05 | U4 |
| MP1-T16 | Explicit native profile import and Windows per-user setup/update/uninstall: unsupported settings do not execute, secrets/config/history are not uploaded, identities and worktrees survive supported transitions. | R04, R05, R14 | U4 |
| MP1-T17 | Authorized source preparation on a runner without an existing checkout reaches the exact repository/commit in its cache/worktree; no server-side Git or arbitrary protocol/remote/credential borrowing. | R06 | U5 |
| MP1-T18 | Interrupted fetch, stale generation/ack, cancellation, unavailable access, dirty/unverifiable source and reconnect report bounded actionable states and preserve bytes; source preparation creates no synthetic run. | R06, R08 | U5 |
| MP1-T19 | Concurrent admission cannot exceed configured capacity; current grants/source/compatibility/connection generation are checked transactionally. Uncertain teardown and tool-approval waits retain slots; settled outcome-review waits do not falsely hold execution capacity. | R03, R07, R08 | U6 |
| MP1-T20 | Eligible queued work gets fair least-loaded placement with stable ties and no starvation behind failed runners. Queue intent survives restart; held plans remain held. Use a bounded predeclared workload and dispatch deadline. | R07 | U6 |
| MP1-T21 | Partitions, stale generations/nonces, lease expiry and revocation stop unauthorized new effects within configured bounds; reconnect cannot redispatch while prior processes remain unproven stopped. | R03, R08 | U6 |
| MP1-T22 | Resume/retry/budget revision retain exact runner/worktree and source lineage. Exhausted, stopped, stale or unauthorized requests cannot increase authority or reset spend/attempts; dirty work remains recoverable. | R06, R08, R10 | U6/U7 |
| MP1-T23 | Two actors contend for control; transfer/expiry/reconnect fence stale steering. Duplicate operation/runner-command delivery has one effect. Comments cannot steer or approve. | R08, R09 | U7 |
| MP1-T24 | Action approval, human outcome approval and independent review remain separate; enforce roles, requester exclusion, expiry, current membership and idempotency on real persisted state. | R03, R10, R11 | U7 |
| MP1-T25 | Existing mission/Office/Factory/Comms surfaces show authoritative owner, installation, source, capacity, queue reason and exact run; offline or denied resources are never silently replaced. Exact-run review/artifact navigation retains provenance. | R04, R09, R13 | U7 |
| MP1-T26 | Web/CLI/Factory/MCP/ACP/A2A launch consumers preserve approved context and legacy immediate-only requests; unsupported shared/queued semantics and unauthenticated team A2A reject before persistence/effects. | R03, R10, R13 | U7 |
| MP1-T27 | Shared issue/edit/status intents check current actor/resource/revision and fencing before effects; denied transitions cannot invent verification/publication/merge/deploy authority or rewrite active contracts. | R10, R12 | U8 |
| MP1-T28 | Lost responses, duplicate intents, concurrent/out-of-band writers and issue-create/Project-attach partial failure recover or report conflict/unknown outcome. Deterministic transport cases are separate from authorized real test-repository effects. | R12 | U8 |
| MP1-T29 | Ephemeral room presence aggregates tabs, expires stale sessions, handles logout/revocation/restart and denies cross-room/Corp observers; no permanent attendance history or task/control authority changes. | R03, R09 | #253/U7 |
| MP1-T30 | Supported mixed-version peers operate correctly; missing/unsupported required semantics and stale browser writes reject before effects. Preserve safe supervision/settlement of active runs rather than treating incompatibility as termination. | R08, R13 | #254 |
| MP1-T31 | Team HTTPS/WSS, origins/proxy policy, private DB/artifacts and actual production IdP are verified on the selected deployment; demo impersonation/bootstrap are unavailable. Local emulator evidence cannot pass this deployment gate. | R02, R14 | U9 |
| MP1-T32 | Standby/read-only/drain/migrate/activate modes constrain writes/workers; backup/restore, upgrades, rollback restrictions and credential recovery preserve authority and exact artifact/source lineage. | R01, R08, R12, R14 | U9 |
| MP1-T33 | Independent controllers/runners using one authenticated Corp/claim authority cannot both own the same backlog claim; independent writable ledgers fail the supported-topology check. Preserve historical Project lineage and test restart recovery. | R12 | #161/U9 |
| MP1-T34 | Actual hostile verifier/repository/descendant/controlled-Git probes fail to access forbidden synthetic host/sibling/credential/network targets while authorized work succeeds, for every enabled adapter/platform/executable/profile cell. See expansion below. | R01, R05, R14 | U1/U10 |
| MP1-T35 | Windows npm.cmd/pnpm/npx/PATHEXT and quoting/path behavior execute the intended approved command with exact arguments; sibling/sequential assignments cannot reuse credentials, files, processes or stale authority. | R05, R06, R08, R14 | U1/U10 |
| MP1-T36 | Publish and execute the operation-by-client-by-role parity inventory, restart/chaos and bounded-load fixture; no regression in supported single-user operations or unbounded startup/snapshot work. Missing cells remain visible. | R01-R14 | U7/U10 |
| MP1-T37 | Independent members and enrolled runners on three physical devices complete governed work and recovery; verify selected real providers and authorized GitHub effects separately, then publish distinct release verdicts and exact shutdown evidence. | R01-R14 | U10 |

In this table `Rxx` abbreviates `MP1-Rxx` only. It never refers to the retained
original `R1-R14` text.

### MP1-T34 and MP1-T35 executable expansion

Freeze the supported cell list before attempting acceptance. At minimum list:

| Dimension | Required recorded values |
| --- | --- |
| Platform | Exact supported Windows build/security configuration initially; any additional supported OS is a separate cell, not inferred from compilation. |
| Adapter | Deterministic fake-process, GitHub Copilot, Codex, Claude Code and OpenCode each have explicit supported/unqualified/unsupported status. A fixture provider cannot qualify a real provider's executable boundary. |
| Surface | Provider tools, persisted command/test verifiers, repository build/install/test code, descendants, controlled Git hooks/helpers/configuration and source/deliverable operations. Include each surface actually reachable in the supported flow. |
| Isolation profile | Exact OS enforcement, executable versions/hashes, ACL/token/container/VM policy as applicable, environment allowlist, credential brokerage and network rules. Job-object cleanup or permission prompts alone are not filesystem/network isolation. |
| Assignment relation | Single assignment, concurrent sibling assignments and sequential reuse on the same runner; both same-owner and cross-owner grant cases. |

For each applicable cell, execute allowed worktree reads/writes/builds and permitted
scratch operations, then probes against synthetic forbidden host, sibling, prior-run
and credential locations and owned network endpoints. Include traversal, links,
environment leakage, descendant survival and controlled Git behavior. Observe
actual denied access and unchanged sentinels, not just configured permissions or
an adapter's claimed refusal.

Windows command cases include paths with spaces/metacharacters, empty and quoted
arguments, `.cmd` shims, executable precedence and a controlled PATH/PATHEXT
shadowing attempt. Capture the exact argv/target reached and reject unintended
interpreter or executable substitution. Package acquisition is restricted to the
approved registry; use pre-acquired fixtures where possible, never weaken the
execution boundary or fetch arbitrary canary packages.

Never run a surface outside isolation because its provider-native sandbox does
not cover it. A failure blocks that cell. Support can be narrowed only through an
explicit product decision and tested admission denial; this leaves any promised
support tracked as missing, rather than recording a blanket M34 pass.

### MP1-T36 parity and load inventory

Enumerate operations from the supported product, not just the new UI: save/preview/
launch, queued launch, observe/comment, control/steer/interrupt/stop, approvals,
independent review, budgets, contract revision, recovery/resume, source/artifact
download, publication request, backlog mutation, enrollment/grants/retirement and
history. Cross each with applicable web/CLI/Factory/gateway consumers, actor roles,
ownership and reconnect/revocation cases.

For every row record the existing single-user baseline, intended multiplayer
behavior, backend authority checks, owner issue and automated scenario/evidence.
Explicitly mark unsupported consumers rather than inventing parity.

Use the published bounded rehearsal envelope: 32 members, ten concurrent browser
sessions and three runners. These are test dimensions, not hard product limits.
Before running, record configured capacities, presence TTL/update limits, reconnect
and request deadlines, peak memory/request-rate budgets and pass thresholds for the
selected hardware. Test duplicates, request coalescing, queue saturation and stale
clients; zero unauthorized effects, duplicate runs and lost accepted history are
mandatory. A run without predeclared quantitative thresholds is diagnostic only.

## Implementation sequence and closure

First land the replacement contract and preflight slice for review; this is not
U1 completion. Start U2 durable contracts and real-database fixtures in parallel
with building the owned U1 fixture. Prepare U3/U4 cases against explicit contract
versions, not imagined API fields. Once those contracts exist, implement U5/U6 and
then U7/U8. Deployment preparation can proceed independently; activation cannot.

For the U1 harness, build in this order:

1. Resource manifest, fresh owned provisioning and independently verified teardown
   using existing process helpers; preserve all failures.
2. Current-source deterministic owner-only baseline, six verifier kinds, artifact
   bytes, nonmember denial, replay and source comparisons.
3. Controlled OIDC/browser integration under its reviewed contract, then isolated
   executable probes and the full declared MP1-T34/T35 cell list.
4. Bind qualification to configuration and actual admission, publish the initial
   parity baseline/missing-cell list, and reconcile all seven #240 acceptance items.

#240 may close only when its applicable runtime criteria are actually satisfied
against this adopted replacement, with required review. #249 still requires the
integrated repeat on the release candidate; earlier owner-only/component passes
are not enough. Reconcile the retained original artifacts before G0 adoption:
compare requirements and evidence explicitly, record differences in the reviewed
crosswalk and retain historical identifiers/results. Later discovered revisions
require a new explicit comparison. Do not silently renumber cases or discard failures.

## Source and scope references

- [Epic #239](https://github.com/All-The-Vibes/ecorp/issues/239) and
  [U1 #240](https://github.com/All-The-Vibes/ecorp/issues/240).
- U2-U10: issues [#241](https://github.com/All-The-Vibes/ecorp/issues/241),
  [#242](https://github.com/All-The-Vibes/ecorp/issues/242),
  [#243](https://github.com/All-The-Vibes/ecorp/issues/243),
  [#244](https://github.com/All-The-Vibes/ecorp/issues/244),
  [#245](https://github.com/All-The-Vibes/ecorp/issues/245),
  [#246](https://github.com/All-The-Vibes/ecorp/issues/246),
  [#247](https://github.com/All-The-Vibes/ecorp/issues/247),
  [#248](https://github.com/All-The-Vibes/ecorp/issues/248),
  [#249](https://github.com/All-The-Vibes/ecorp/issues/249).
- [Human presence #253](https://github.com/All-The-Vibes/ecorp/issues/253) and
  [internal compatibility #254](https://github.com/All-The-Vibes/ecorp/issues/254).
- [Architecture](ARCHITECTURE.md), [security](SECURITY.md),
  [evaluation contracts](EVALS.md), and
  [contributor boundaries](../CONTRIBUTING.md).
- `VerifierCheck` / `ManualVerificationGate` in
  `crates/crony-domain/src/lib.rs` define the existing six automated checks and
  separate manual decisions; this proposal does not change their semantics.
