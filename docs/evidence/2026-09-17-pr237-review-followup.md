# PR237 review corrections and integration evidence

Date: September 17,2026. Non-closing test/evidence contribution toward #50.
Original reviewed head: `843130639c1429bc0e72aa974f4dfea488fbb64b`.
First integrated main: `c44fe9c93b27b042f906930e0ac5958ed16ddd5d`.
The enclosing final commit identifies the corrected candidate. Native reports
record the pre-commit HEAD because the tests ran on the integrated working tree;
they must not be misrepresented as tests of the original unmodified8431306 source.

## Findings addressed

- **Windows cleanup:** removed the budget driver's reserved `$pid` assignment and
  mixed CIM/native timestamp comparison. Read-only inspection reproduced the
  precision difference (one100ns tick) on the diagnostic process. The driver now
  uses a thin adapter over existing Get-LocalProcessIdentity/Stop-LocalOwnedProcess
  from local_stack.psm1. The native helper holds its process handle through exact
  executable/time/workspace checks and stop. No PID-only or uncertain fallback.
- **Retained source:** existing canonical-path, synthetic README, origin, tracked
  file and clean-worktree checks were retained. A regression executes the actual
  admission block and rejects a real owned junction/alias, wrong origin, extra
  tracked file, dirty work and non-synthetic bytes. Valid native source reuse also
  passed the three full recovery scenarios below.
- **Source pinning:** Windows preview and creation now send identical source-bound
  requests. The fixture checks persisted task-contract and completed-run source
  repository/ref/commit against that source. Missing task source fails before launch;
  mismatched run source cannot count as acceptance. Real HTTP and native Windows
  fixture checks include this behavior.
- **Reserved ports:** CI/GITHUB_ACTIONS flags no longer permit a manual-stack port.
  Configuration tests prove rejection before HTTP/reset effects.
- **Checkpoint marker:** the read-lock helper creates its marker without overwriting
  existing data and removes its own marker in finally. The driver releases the lock
  normally even after a failed assertion and verifies marker absence before resume.
  Native tests cover successful release and preserving an unknown existing marker.
- **CI:** quality and Windows jobs include the missing budget config/provider-stream
  suites and new process/source/marker regressions. Windows CI explicitly discovers
  and validates installed PostgreSQL17 tools before fixture preview/execution;
  it does not rely solely on an undocumented PGBIN variable or install new software.
- **Main integration:** preserve both budget-recovery finish and landed steering-
  contention provider-fixture modes. The original PR's production scope is unchanged.

## Focused checks and repository gates

The original reserved-port assertion and missing driver integration failed before
their fixes. The newly added CI-discovery assertion failed before CI wiring.
An initial test-helper Import-Module parameter mistake and a temporary short-path
alias refusal were retained and corrected; the fixture's canonical-path refusal
was not weakened to accommodate a noncanonical test path.

- Five focused suites (budget-process/marker/source admission, external-adapter
  contract/HTTP, budget config and provider stream): **44 passed**, zero skipped/failed.
- Related ownership/CI/source suites: **52 passed,1 skipped** without the native
  restart opt-in. The native receipt stop is independently exercised in the44 above.
- Migration checker:41 immutable migrations unchanged; `cargo fmt --check` passed.
- `cargo clippy --workspace --all-targets --offline --locked -- -D warnings`: passed.
- `cargo test --workspace --offline --locked -- --quiet`: **554 passed,343 ignored**,
  zero failures. Ignored:1 runner,5 server,337 store; not claimed as executed.
- Frontend/office suite at the first integration:279 passed; web build/lint passed.
- Actual server/runner/CLI binaries rebuilt with offline locked dependencies.

## Fresh native Factory recovery scenarios

Owned root: `C:\Users\aabdelsalam\.ecorp\review-qa-237\qa\issue-50-factory-recovery`.
API18450, PostgreSQL55450;18550 reserved by the fixture. The dry-run verified empty
ports before each scenario. One owned cluster was retained and reused with a new
synthetic database per attempt. No original-office snapshot was requested, so
`retained_unchanged:null` is not a byte-for-byte comparison of a private live DB.
The original office was neither targeted nor restarted/reset/re-enrolled.

Commands: `node tools/e2e_factory_budget_recovery.mjs --dry-run` then `--execute`,
with separate `--overrun` and `--missing-checkpoint` modes. Explicit QA-root/PgBin
environment variables scoped each invocation; providers and GitHub responses were
synthetic. Native Factory preview ran before each effectful fixture dispatch.

| Case | Retained attempt | Result and exact resume run |
| --- | --- | --- |
| Bounded recovery | `20260918035137743` | `recovery_passed`; `957edfad-ce42-497b-a903-ce7465fe3069` |
| Revised-budget overrun | `20260918035305338` | `hard_stop_protected`; `fc9134b3-9ddf-427d-9408-4bded5a61e0d` |
| Native missing checkpoint | `20260918035335141` | `recovery_passed`; `a9ff506d-20ba-43de-bf97-8471ebdaa384` |

Every attempt retained report.json and source/worktree evidence, original spent
usage and breaker history. All server/runner/PostgreSQL processes stopped through
verified ownership; the missing-checkpoint helper exited normally and its marker
was absent before resume. Every report records `ports_after:[]`. No real provider
inference or remote GitHub mutation occurred.

## Windows external-adapter/source integration

The existing native CI supervisor was previewed and executed on a separate new
owned fixture, `C:\Users\aabdelsalam\.ecorp\qa\ecorp-external-adapters-review-20260918`,
API18437/PostgreSQL55437. Claude/OpenCode used deterministic protocol fixtures,
never personal accounts. It passed source-bound provider lifecycles and artifact
checks, mixed-provider task graphs, controlled-runner readiness, synthetic runner
identity lifecycle and budget breakers. Original synthetic source remained clean
at `6c8596d7820dc8594f2fff6de6c018209808e667`. Verified cleanup stopped its three
owned processes; private credentials/database/worktrees were retained and are not
part of the publication. Report: `evidence/fixture-report.json` under that root.

## Limits and review disposition

This is synthetic local regression evidence, not real-provider, production OIDC,
hostile-isolation or new browser acceptance. Historical reports remain dated and
unchanged; previous hosted checks apply to their exact previous heads. Full #50
recovery after already-terminal Factory cancellation and broader lost-response/
browser cases are not claimed resolved. #236's auditor-led policy is unchanged.

Only demonstrated inline findings are eligible for resolution with this evidence.
The human request-changes review is not dismissed; fresh review of the final head
is required. No issue closure, merge, auto-merge, cloud change or deployment.
