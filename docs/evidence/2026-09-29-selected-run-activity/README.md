# Selected run activity, freshness and blockers

Issue #259 is locally implemented and accepted against main `878a1774774b0630c904cbaf4b05e1b346777817`. The tested tree is
`65fbe9d0a65f2641a0e2a42d933a1ef431b9cbd9`. Required hosted CI, CodeQL, security and quality checks remain merge requirements.
This packet records no independent human approval, merge or issue completion.

## Result and acceptance

Mission activity uses the actual selected evidence run. Agent activity honors the exact current-run
pointer and fails closed when its authorized context disappears. Existing role, capability, exact
lease and native command checks gate control. Retired identities remain inspectable and read-only.
The inspector preserves the active workspace and invoking focus. The existing coalesced five-second
presence refresh now covers the mission, Factory and inspector, so Grace/offline does not require
a new run event. Safe structured details remain bounded, redacted and read-only. No backend,
migration, dependency, custom execution or permission mechanism changes.

| Issue requirement | Observed evidence |
| --- | --- |
| Exact task/owner, structured activity, time, elapsed value, freshness and blocker | Model regressions and native mission/agent ready, running, review and completed states |
| Separate intake, mission, provider, verification and runner states | Native suspension with Factory Running beside a cancelled mission/run; native review, Grace, offline and quarantine |
| Existing ordered journal and supported native events | Browser disconnect/replay without another provider run; safe metric allowlist; existing presence refresh and idempotent commands |
| Bounded details and existing permitted actions | Desktop and 390px disclosure/control captures, keyboard focus trap/restoration and reduced-motion acceptance |
| Running/idle/review/suspend/quarantine/disconnect/replay/unknown | Four accepted native reports, 28 inspected original screenshots, exact older-run/artifact selection, failed snapshot, room revocation and guest denial |

The fresh owned fixture exercised Edge -> server -> isolated native fake-process runner -> persisted
verifier -> downloaded deliverable. The main report records three runs, one attempt per task,
and 2,292 downloaded bytes with SHA256
`208d0078a70376ae978c7297cc3651330300a4ab15c598daf3f20b383471e17c`.
Separate offline, suspension and quarantine lanes retain native lifecycle and journal evidence.
Quarantine preserves the physical pinned Git HEAD; an archive/no-commit request legitimately has
`expected_head_commit: null`. The launcher stopped its exact owned stack and retained fixture data.

## Validation and source binding

Canonical `pnpm check` passed all 11 named gates: migrations, state-audit compatibility, native EVM,
docs, repository docs, full Node discovery, format, clippy, workspace Rust tests, web build and lint.
Locked installed dependencies were retained; no gate, threshold or security policy was disabled.

- Node: **3119 total / 3054 passed / 65 skipped / 0 failed, cancelled or todo**.
- Rust: **877 passed / 564 ignored / 0 failed**, across 41 summaries. Native EVM separately passed one case.
- Focused: **86/86**, no failures, skips, cancellations or todo; focused web build/lint exited zero.
- Existing web-model coverage: **479/479** tests; lines **99.72%**, functions **97.13%**, branches **97.85%**, satisfying unchanged **99/95/97** thresholds across 19 models and 29 test files. Focused and coverage counts overlap full discovery.

Native r8 and canonical r9 have identical before/after physical inventories of **7,146 files**.
The focused receipt binds HEAD, patch and status, and the coverage receipt binds its covered files;
neither is claimed to have a complete native/canonical physical-source inventory. A temporary index
reconstructs the exact tested Git tree afterward. Evidence is then added and separately checked for
the original bytes, exact tree/patch, full eleven-gate argv and Node discovery, docs, personal paths,
whitespace and native secret findings. The final commit did not exist during the original execution.

These are new retrospective regressions. The original canonical attempt recorded **3,119 total /
3,040 passed / 14 failed / 65 skipped**, and did not run subsequent gates. Three callback VM test
harness failures were repaired; eleven Python-alias failures were resolved by selecting bundled
Python in the validation process. The r8 launcher failed before checking because it expected a
nonexistent web lockfile; r9 hashes the actual root, Steward and Cargo locks. Native r6/r7 driver
failures remain historical failures. r8 retains the authenticated native Factory transition and
corrects the optional archive commit guard. No original development chronology or human decisions
are reconstructed. The older working review remains in `history/`.

## Reproduction and evidence

Use a clean isolated checkout with the repository's pinned tools and frozen dependencies. Set
`PYTHON` and the process PATH to an actual Python interpreter on Windows, and explicitly record
`RUST_TEST_THREADS=1` before `pnpm check`. Run the existing `pnpm coverage:web-models` gate and build
`cargo build --locked --bin crony-server --bin crony-runner` for a fresh native fixture.

The exact native launchers, browser drivers and supervisor are under `drivers/`. They are sanitized
historical scripts, not portable zero-configuration commands: configure private local paths,
expected source and unused ports, use a newly owned fixture, and stop only its exact owned processes
in a finally block. Never reuse retained fixtures or the configured source checkout for write runs.
The supervisor uses prebuilt binaries; runtime binary hashes were not collected. PostgreSQL 17.10
uses `initdb --auth=trust` in this local fixture. No authenticated/SCRAM database acceptance is claimed.
Node 24.21.0 and deterministic development identities/providers were used; hardware was not collected.

- [Canonical report](canonical-report.json), [sanitized log](canonical-pnpm-check.log), [source equivalence](source-equivalence.json), [focused checks](focused.json).
- [Main native report](native/issue259-browser.json), [offline](native/issue259-native-offline-r6.json), [suspension](native/issue259-native-suspension-r6.json), [quarantine](native/issue259-native-quarantine-r6.json).
- [Coverage](coverage/summary.json), [visual review](screenshot-review.json), [implementation self-review](implementation-self-review.json), [artifact hashes and redactions](summary.json).

## Material limits

Revoked room membership hid the selected mission, tasks, runs, events and controls. Existing Factory
intake still returned without room membership, so this is not comprehensive Factory intake privacy
acceptance. The injected snapshot-error notice persists in some later captures while freshness
updates correctly. Development authentication is not production OIDC, and fake-process is not live
vendor inference. No new real human decision is claimed by an automated fixture.

Skipped and ignored cases remain unexecuted. Windows tests use serial Rust execution; issue #213
parallel qualification remains separate. Existing bundle-size warnings and historical Cargo advisory
debt remain; no clean audit is claimed. `docs/PROJECT_MEMORY.md` is absent from current main.
Required hosted checks remain mandatory while organization-disabled Actions prevents them; issue
#259 stays open until verified merge and completion. Original private evidence and original hashes
are retained. Published text normalizes whitespace and removes personal paths and sensitive values.
