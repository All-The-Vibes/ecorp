# Mission-scoped staffing and safe crew retirement

Issue #48 is locally implemented and accepted against main `878a1774774b0630c904cbaf4b05e1b346777817`. The tested tree is
`47be931d1eee3169c25da7f2d339ac59856f5f51`. This packet does not assert a GitHub approval, merge, or issue closure.
Required hosted CI, CodeQL, security and quality checks remain merge requirements.

## Result

Authorized Clear crew and Retire share bounded, versioned, transactional retirement rules.
Clear returns an explicit result for every identity and preserves pinned workers. Explicit
Retire can retire an inactive pinned worker. Both reject operational obligations and uncertain
provider teardown without cancelling work or deleting historical records. Current authority is
rechecked on exact idempotent replay. Manual retirement fences generic and Factory recovery;
automatic retirement retains existing authorized recovery. The browser preserves uncertain or
denied requests across reload, fences overlapping operations and allows unrelated work.

The existing mission-owned staffing and merged Pin/Unpin implementation are retained.
`test-review` adds a tester and a distinct reviewer with immutable selected source, exact typed
handoffs, existing bounded task graph and persisted verification. Automatic runtime selection
skips an incompatible higher-priority adapter. No migration, dependency, custom execution engine
or new permission system is added. An agent's review is not a human approval or OS isolation.

## Acceptance against the issue

| Requirement | Observed evidence |
| --- | --- |
| Fresh Corp with zero workers; single mission creates only its role | Retirement native report: empty Corp, one held mission-owned identity, actual browser Start mission |
| Two specialists and a synthesizer; tester and distinct reviewer | Staffing native report: three-role dependency graph and two-role review graph, exact typed source/parent bytes |
| Available adapter/model and capability fallback | Staffing report: unavailable model/adapter and explicit incompatible adapter rejected before staffing; automatic fallback completes on fake-process |
| Safe Clear and Retire, explicit blockers | Retirement report: active run/lease/approval/message/command rows unchanged; six eligible legacy identities cleared; pinned manual Retire |
| Historical attribution and roster lifecycle | Both reports: identities retire without removing missions/tasks/runs/evidence; screenshots show empty/live/off-shift/pinned/retired history |
| Physical provider teardown and automatic retirement | Native process observations and persisted termination/workspace events; 3 retirement runs and 7 staffing runs completed |
| Reuse, Pin/Unpin, manual retirement | Native Pin/Unpin replay, same-room pinned reuse, Unpin, automatic retirement and exact manual-retirement replay |
| Multiplayer authority and audit | Alice/Bob browser operations, real HTTP 403, exact authority restoration, scoped dynamic-worker events, no resurrection |
| Browser recovery and narrow controls | Lost response, reload and exact retry; denied operation survives unrelated Clear; controls fit 390 CSS pixels and focus remains usable |

The retirement fixture ends with **8 agents, 8 retired, 3 missions/tasks/completed runs and
6 persisted verifier rows**. The staffing fixture ends with **7 agents, 7 retired, 3 missions,
7 tasks/completed runs and 19 verifier rows**. Both use the actual server, native isolated runner,
PostgreSQL and Edge browser, with deterministic providers. All exact owned services stopped;
fixture data and retained worktrees are preserved. A higher-priority synthetic Copilot capability
advertisement receives no tasks; this is capability fallback evidence, not live Copilot inference.

## Validation and source identity

`pnpm check` passed all 11 current named gates: migrations, state-audit compatibility, native EVM,
docs, repository docs, full Node discovery, Rust formatting, clippy, workspace Rust tests, web
build and web lint. Locked root/web installs and offline Steward `npm ci` preceded the check.

- Node: **3,123 total / 3,058 passed / 65 skipped / 0 failed, cancelled or todo**.
- Rust: **886 passed / 588 ignored / 0 failed**, across 41 summaries; native EVM separately passed one case.
- Fresh SCRAM PostgreSQL regression lane: **43 passed / 0 failed / 0 ignored**, including current-authority races, replay, history, live obligations and manual-recovery fencing.
- Focused lanes: **20 Crew Node**, **33 planning**, **3 staffing**, **3 budget-cost** cases, plus web build/lint. These overlap broader discovery and are not additional unique tests.

The 7,157 physical source files match canonical r2, focused r2 and SQL r3. Native startup
verified those files and the three binary hashes against canonical binding r2. This packet
reconstructs their Git tree using a temporary index after execution; all original bytes must
remain unchanged. Evidence was added afterward and requires a separate exact-tree/full-command-
plan, documentation, personal-path, whitespace and native secret validation. The final commit
did not exist during the original run. `source-equivalence.json` records that distinction.
The full canonical argv includes all Node discovery files; the old unit-test subset is not used.
Published text logs remove trailing spaces and terminal empty lines to satisfy the whitespace
check. Original logs, original hashes, counts and failed-validation receipts remain preserved.

Canonical r1 failed on a TypeScript return-type defect, repaired before r2. Earlier native
driver failures and the staffing rendering-readiness race remain in `history/`; they are not
passes and no original development chronology is reconstructed. The staffing driver waits for
either the open form or collapsed composer before proceeding. All 17 screenshots were visually
inspected during this ongoing task. The fallback screenshot's detail panel still shows the prior
specialists mission; its completed queue row and native report establish the fallback outcome.

## Reproduction

Use a clean isolated checkout of the published PR and the repository's pinned toolchain/dependencies:

```powershell
pnpm install --frozen-lockfile
pnpm --dir apps/web install --frozen-lockfile
npm --prefix scenarios/repo-steward ci --ignore-scripts --no-audit --no-fund --workspaces=false
$env:RUST_TEST_THREADS = '1'
pnpm check
cargo build -p crony-cli -p crony-server -p crony-runner
```

The complete original native drivers and supervisor are under `drivers/`. They intentionally
fail closed on changed source, binary hashes, occupied paths/ports or ambiguous process ownership.
For a new run, configure local tool paths, expected head and a newly collected canonical binding;
replace `<USERPROFILE>` only in a private driver copy. Use a fresh owned fixture for each lane,
ports 59030/59031/59032, private PGPASSFILE, and no existing production or contributor runtime.
Start the supervisor with `-ProviderMode fake-only`, run the retirement or staffing launcher,
and stop only the exact owned processes in a finally block. Do not point a rerun at retained
fixture directories or treat these sanitized historical scripts as portable zero-configuration tooling.

Recorded environment: Windows, Node 24.21.0, PostgreSQL 17.10, existing pinned Cargo and pnpm
toolchain; deterministic native fake-process with development Alice/Bob principals. Source and
binary digests, exact commands, original/published evidence hashes and assertion timestamps are
in the JSON receipts. Firmware is not applicable; hardware was not collected.

## Evidence and limits

- [Canonical report](canonical-report.json), [source binding](canonical-source-binding.json), [focused](focused.json), [native SQL](native-sql.json).
- [Retirement native report](retirement/native-report.json), [Pin/Unpin report](retirement/native-pin-unpin.json), [staffing native report](staffing/native-report.json).
- [Assistant self-review](implementation-self-review.json), [visual review](screenshot-review.json), [artifact hashes and redactions](summary.json).
- [390px crew history](retirement/07-narrow-retired-history.png), [denied Retire and unrelated Clear](retirement/native-403-unrelated-clear.png), [tester/reviewer plan](staffing/tester-reviewer-review.png), [all seven retired](staffing/all-seven-retired-history.png). All 17 original PNG files are committed alongside these links.

Development identities are not production OIDC acceptance. Deterministic providers are not vendor
inference. Reviewer instructions are not OS filesystem isolation. Private-room assertions apply to
the dynamic worker events; broader legacy room-null events are not private-room evidence.
Environment-only server database credentials are reduced assurance. Sensitive fields and repeated
values are redacted before publication; originals remain private and their hashes are retained.
The publication check also detected two caret-escaped personal roots in PostgreSQL output;
those copies were redacted, and the failed check and original log were retained.
The unchanged native secret scanner also matched 32 noncredential replay UUID occurrences.
Published reports use consistent `OP` labels for these identifiers, preserving replay equality;
original hashes and the scan failure/triage are retained. No scan rule or ignore policy changed.
Windows tests used `RUST_TEST_THREADS=1`; issue #213 parallel qualification remains separate.
Skipped/ignored tests remain unexecuted. The existing web bundle-size warning and historical
Cargo debt (**12 advisories, including 2 high**) remain; no clean dependency audit is claimed.
`docs/PROJECT_MEMORY.md` is absent from the reviewed current main. Organization-disabled Actions
prevents required hosted validation, so issue #48 remains open until verified merge and completion.
