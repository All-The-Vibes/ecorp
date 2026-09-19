# Bounded agent Pin/Unpin validation

Refs [#48](https://github.com/All-The-Vibes/ecorp/issues/48). This is the Pin/Unpin
slice only, not completion of the crew-management umbrella. Clear crew and manual
Retire are not implemented here.

## Source and contract

The isolated implementation branch is `afateen/issue-48-agent-pinning`, based on
`6da302631e437aa6171d4d7b57fd80c231fb35b0`. That base already contains #158 staffing
and #177 recovered activation. No migrations, dependency manifests, lockfiles or
provider adapters changed. The immutable migration check still covers 41 migrations.

The store, authenticated API, CLI and current office inspector share the existing
agent retention flag. Human `Operate` roles and current owning-room membership are
checked even on replay. Expected versions fence stale multiplayer changes; exact
operation keys bind the actor, agent, value and version. A committed audit event is
the version source. Replay returns the historical operation result without
reapplying it, and new operations on retired identities conflict.

Unpin changes neither execution nor operational authority. Retirement additionally
preserves unfinished assignments in another saved/running mission, preventing an
unpinned reused worker from disappearing before its next accepted task starts.
The existing native retirement and authorized recovery mechanisms remain in place.

## Focused checks

| Command or suite | Result |
| --- | --- |
| `cargo test --locked -p crony-store -p crony-server -p crony-cli issue48_ -- --include-ignored --test-threads=1` | 20 passed: 16 store, 3 server, 1 CLI; no failures or ignored matches |
| Exact store test executable, `issue171_ --ignored --test-threads=1` | 18 existing recovered-activation cases passed |
| `node --test apps/web/src/AgentPinControl.test.mjs tools/e2e_agent_pinning.test.mjs` | 9 passed |

The SQLx cases use actual migrations and fresh databases under an explicitly owned,
SCRAM-authenticated PostgreSQL 17.11 cluster. Coverage includes permission changes,
OIDC principal/actor substitution at the real handler boundary, room/Corp isolation,
exact replay, stale ABA versions, concurrent operators/duplicates/retirement,
observed revocation-lock contention, rollback and byte preservation of active
operational rows. The OIDC handler fixture is not a production identity-provider test.

The activation suite reuses the exact test executable produced by the successful
focused Cargo command; its executable hash and command are retained. A redundant
package-only rebuild was stopped before running tests, rather than consuming
another feature-graph build. The partial log is retained and is not counted as a pass.

## Native server, runner, browser and CLI

The final acceptance used `tools/e2e_agent_pinning.mjs` against a fresh
`issue48_app_final` database, a fresh enrolled runner credential/workspace, and an
independent clean source repository. An earlier successful fixture remains in
`issue48_app`; no reset or historical cleanup was used. The final driver waits
6.5 seconds across the saved second plan, exceeding two nominal three-second
retirement reconciliation intervals.

Long-lived fixture services used only loopback ports 59030 (PostgreSQL), 59031
(native API), and 59032 (web). The native binaries came from this worktree's exclusive
target directory, never a sibling implementation. All tasks used the existing
deterministic `fake-process` adapter, not real model inference or Factory publication.

1. Alice used the actual inspector's Pin button. Already-open Bob received the
   updated Unpin control through the live projection.
2. The real runner started the source-pinned task and suspended at its durable
   action approval. Bob held a control lease; Alice had one queued message.
3. Bob activated Unpin by keyboard in the actual inspector. Its HTTP response was
   version 2, attributed to Bob. The driver compared exact run, task, mission, lease,
   approval, review, message and command rows before/after. All were unchanged.
   Alice's already-open inspector showed the same active run and retained obligations.
4. The native CLI repinned with an exact duplicate retry. Native completion passed
   the persisted artifact/file checks, downloaded artifacts matched their hashes,
   and the provider termination receipts reported no live provider process.
5. A second held mission reused the same identity. CLI Unpin and exact duplicate
   retry left the saved assignment intact across reconciliation intervals. The
   second native launch completed, consumed the queued message, and the unpinned
   identity then retired automatically.
6. A fresh retired Pin was rejected. Replaying the original successful Pin never
   resurrected the identity. After an owned server restart, the exact core snapshot
   (agents, tasks, runs and pin events) was unchanged, the runner reconnected, and
   the native CLI still returned the historical result without mutation.
7. Bob's full native WebSocket replay returned exactly four ordered pin operations,
   versions 1–4. Eve received zero pin events and zero private-room events. Guest,
   foreign-Corp and extra-effect requests were rejected. Browser reload removed the
   retired identity from the operable crew without discarding mission/run history.

Final database counts: **1 identity, 2 missions, 2 tasks, 2 completed runs,
4 pin events, 1 retirement, 1 delivered queued message, 0 pending commands,
0 Factory work items**. Four native verifier rows passed, two per run. Both dirty
worktrees were preserved, and the original source HEAD/status/content were unchanged.
The final JSON records run/task/agent IDs, artifact hashes, verifier IDs and
termination event IDs; optional root verification-digest fields remain null.

## Required contributor gates

Tools were Rust/Cargo 1.98.1 (Windows GNU with matching bundled `rust-lld`),
Node 24.19.0 and pnpm 11.19.0. Cargo used one build job; Rust tests ran serially.

| Gate | Result |
| --- | --- |
| `node tools/check_migrations.mjs` | Passed: 41 immutable migrations |
| `pnpm check:docs` | Passed |
| `pnpm test:unit` | Passed: 1,162 passed, 44 opt-in skips, 0 failures |
| `pnpm test:steward` | Passed: 227 passed, 0 skips/failures |
| `cargo fmt --check` | Passed |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `cargo test --workspace` | **Failed, exit 101**: 371 passed, 5 failed, 1 ignored before Cargo stopped at the runner |
| `pnpm build:web` | Passed |
| `pnpm lint:web` | Passed |

The full-gate runner result was 207 passed, 5 failed and 1 ignored. Three failures
could not create Windows symlinks (OS error 1314). Two connection-setup integration
fixtures could not establish private directory permissions. No privilege elevation
or ACL weakening was attempted. Both failed connection fixture directories were
retained. No matched baseline was executed, so this report makes **no regression
or baseline-causality claim** about these five failures.

After Cargo stopped, the already-built remaining server/store test executables were
run explicitly: server **130 passed / 7 ignored**, store **61 passed / 353 ignored**.
These continuation results do not turn the failed workspace gate green; unexecuted
documentation tests are not claimed. Focused opt-in lifecycle cases are listed
separately above.

## Limits and retained evidence

- Development identities simulate multiple operators; they are not independently
  authenticated production humans. No cloud registration or real provider spend occurred.
- Broader Eve WebSocket replay also exposed three **room-null control events**:
  `control.lease_acquired`, `control.message_queued`, and `control.lease_released`.
  Those are outside the new pin journal. The initial broader exclusion assertion
  failed and is retained. Pin events/private-room events remained excluded; this
  slice makes no universal control-event privacy claim and does not expand into #89.
- Integrated browser viewport declarations did not reliably control renderer size.
  The final active-work screenshots and no-horizontal-overflow measurement are at
  **1040 actual CSS pixels**. The earlier narrow capture is 375 physical pixels,
  with a 288-CSS-pixel renderer reporting a 320-pixel audit width. A requested
  390-pixel responsive gate is **not** claimed. Initial pointer actionability retries
  are retained; final Pin/Unpin used ordinary keyboard activation without forced clicks.

Private evidence is retained at
`C:\Repos\ecorp\temp\evidence\issue48-agent-pinning-20260919`.
The `final-native` subdirectory contains the final native checkpoint, complete
snapshot, downloaded artifacts, actual browser screenshots, process ownership,
and exact restart/WebSocket replay proof. The root contains every gate log,
the earlier fixture/failed probes, tool hashes and canonical-versus-physical
source/binary provenance. Final commit/tree identity is recorded outside Git in
`final-source-provenance.json` to avoid a self-referential commit claim.

Owned service processes are stopped by exact recorded identity, and authenticated
PostgreSQL is shut down after its tests. The final cleanup receipt records remaining
allocated listeners. Databases, source checkout, dirty worktrees and failure fixtures
are retained for independent inspection. No push, PR, merge, rebase, issue closure or
public update is part of this delivery.
