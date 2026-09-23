# Issue 161 local runtime QA — September 13, 2026

## Verdict

The approved owned Windows QA run exercised the real database, server, CLI,
runner processes and browser. The shared-authority claim and independent-ledger
rejection cases passed. The full #161 multi-host outcome is **not accepted**:
these are one-host, development-identity, deterministic-provider results.

Two important qualifications remain visible:

1. PR #237's original Windows supervisor refused the first restart because CIM
   creation time lost native timestamp precision. A small recorded helper patch
   fixed the measurement mismatch without removing the exact stop check.
2. The deterministic source-drift preflight accepted its plan. Dispatch then
   rejected the unmatched immutable commit, leaving one blocked QA item/mission
   and zero runs. This is not proof of rejection before claim/materialization.

See [the machine-readable runtime result](runtime-result.json) and the earlier
[source and repository-gate checkpoint](qa-handoff.md).

## Source and ownership

- Contribution base: `b2523964e7576cafc00e84a51e1044f55826dea7`.
- Contribution branch: `codex/issue-161-shared-authority`; changes remain uncommitted.
- QA root: `C:\Users\aabdelsalam\.ecorp\qa\issue-161-shared-authority`.
- PostgreSQL: port 55461; separate `issue161_shared`, `issue161_independent` and
  `issue161_sqlx_maintenance` databases. Native process, listener and data-directory
  identity were checked before tests.
- APIs: 18971/18972. Browser client: 15471.
- Synthetic source initially: `b228823085c7116b85df07d8c45f234877c6d7e0`.
- Deliberate synthetic source advance: `40af1830a20523ec5a32002b3bcc6795772308eb`.
- Shared authority: `5201c04e-abbd-47b7-8a0c-f74b66fbf532`.
- Independent authority: `ce756f92-c806-4e20-ac7b-fdc524468cef`.
  Both databases use demo Corp `00000000-0000-4000-8000-000000000001`.

The fixture's GitHub origin name is synthetic routing metadata. No real GitHub
API, provider account or publication was used. Source commits were made only in
the synthetic repository and native isolated task branches, not in the contribution
or retained operator checkout. Environment delivery remains reduced assurance.

## Executed checks

| Layer | Observed result |
| --- | --- |
| Actual-migration store tests | Six `issue161_` cases passed, zero failures/ignored |
| Actual-handler database tests | Three `issue161_` cases passed, zero failures/ignored |
| Shared helper conformance after precision patch | Seven tests passed, including actual Windows startup, two restarts, database-drift refusal and idempotent stop |
| Focused UI/controller-selection/QA-plan tests | 20 passed after QA additions |
| Native binaries | `cargo build --workspace --locked --offline` passed |
| QA web bundle | Build passed with the isolated API/WS addresses |
| QA script checks | All `.mjs` syntax checks and the PowerShell parser passed |
| Migration/patch integrity | 42 migration checksums passed; exact helper patch reverse-check passed |
| Whitespace | `git diff --check` passed |

Database commands ran only after the supervisor verified the owned PostgreSQL
identity. `DATABASE_URL` stayed in the private test subprocess environment:

```powershell
cargo test -p crony-store issue161_ --locked --offline -- --ignored --test-threads=1
cargo test -p crony-server issue161_ --locked --offline -- --ignored --test-threads=1
```

The nine newly exercised cases were previously listed as ignored; this report
does not reclassify the remaining database/provider tests as executed.

## Native execution cases

### Concurrent controllers (#9161)

Both native controller dry runs observed the same synthetic Project/item/source,
verified the same authority pin and reported `mutations: []` with valid preflight.
They used independent controlled GitHub read snapshots so both could observe Todo;
the real shared PostgreSQL claim ledger had to decide ownership.

One controller executed; the other received HTTP 409 for the same live claim.
The authoritative result was exactly one item, mission, task and run:

- Item: `bb6699bc-d7b2-4d25-b5d6-779aee339d74`.
- Mission: `23f8707a-ac41-47c6-8cde-ece1ae4247e6`.
- Run: `81de136d-5cd8-4c93-a5e6-820e9860b5c7`.

The item became `verified`; native verification passed. This is not a live
GitHub consistency or publication test.

### API/runner reconnect (#9163, then #9164)

The #9163 native run completed, but its API restart was refused before stop. That
attempt and original item/mission/run were retained; it is not counted as a
successful restart.

Read-only inspection proved identical live executable/PID identity, with native
creation time differing from CIM by two and four 100-ns ticks for the two APIs.
The corrected helper inspects through a retained native `Process` handle, the
same clock used by its exact stop comparison. New receipts additionally compare
native tick strings exactly. No timestamp check was disabled or relaxed.

The dependency remains based on PR #237 commit
`b31a38a62330aacba80c3953142e1da957a63ecd` with only
[`pr237-native-time.patch`](../../../tools/issue161/pr237-native-time.patch) applied.
Patched helper SHA-256:
`aa0d3c377847c479c69e8be6e1f809bf4b155c53dc6903c1d6922fde4732e144`.
The QA API driver checks the base, exact dirty-file scope and patched digest.
No change was pushed to #237.

A separately identified #9164 case restarted the API while its native run was
running. API PID changed from 48208 to 47932. Runner PIDs 49896 and 13372 stayed
alive; both QA credential files rotated through native reconnect. The same
mission `340a1098-efa4-41d8-a91c-17cf626e5d5d` and run
`ec5540b2-cab3-413e-9f15-bf16320bf835` completed with passed verification and no
duplicate lineage. The browser resumed live state after the restart.

### Browser-to-server-to-runner and second runner

Using the real UI, the test selected the exact synthetic repository/commit,
enabled developer fixtures, chose **Test harness — no AI**, and used the minimum
UI ceiling of 500,000 synthetic tokens (zero real inference). The reviewed policy
required both provider evidence and `result.md`, each with a one-byte minimum.

Browser mission `f84d7484-b139-4940-a687-f2e54d9b8669`, run
`f4011d7d-1bb9-4a73-a41b-2e74f11baf66`, reached **Completed / 2 of 2 checks passed**.
The rendered UI showed the preserved worktree and a downloadable source archive.
Screenshots and accessibility observations were captured in the task; no portable
browser-export or responsive-breakpoint pass is claimed.

An initial aggregation assumption that sequential work must use both runners was
not treated as a scheduler contract. Instead, the now-idle, receipt-owned runner A
was explicitly stopped and the separate bounded #9165 case ran on runner B. Both
real runner processes therefore produced verified work across the recorded cases.

All five provider artifacts and all five source bundles were independently
downloaded through authorized QA API routes and matched their recorded lengths
and hashes. Each run had native provider-termination evidence. The browser's
source archive was 1,956 bytes with SHA-256
`895329452e63ec8a4cdaa8fdb9a15f543a11b86f1068caff969ee218108a74d5`.

### Independent ledger and source drift

Ledger B rejected ledger A's pin with HTTP 409 despite identical Corp IDs.
Its item/mission/task/run/event state stayed unchanged.

After the synthetic source HEAD advanced, both #9162 dry runs still reported a
valid deterministic plan. Execution was rejected at dispatch because no connected
runner advertised the new immutable commit. The QA item
`d8277c53-f3df-42b0-a9b4-46066e8685c2` and mission
`39b4f934-2a1c-4816-9e39-373fee7de57d` remain blocked, with zero runs.
Every prior item/mission/task/run projection remained unchanged. No wrong-source
workspace or write was created. Earlier pre-claim-rejection expectations are
superseded by this measured, narrower result.

## Cleanup and remaining gates

The temporary browser tab was closed. Both QA APIs were stopped with the pinned,
patched #237 helper; host processes used ECorp's existing receipt/handle-based
local lifecycle module, and PostgreSQL used its verified native stop path.
Ports 55461, 18971, 18972 and 15471 had no listeners after shutdown.

Data, logs, process receipts, synthetic commits/worktrees, failed attempts and the
detached helper dependency were retained. `C:\dev\ecorp` stayed clean at
`971445e1cbf9388c51803e2adf28b11bd98b1ffa`. The retained office's database and runner
credentials were not accessed or changed.

Still required before closing #161: actual multi-host/independent-human acceptance,
production-auth topology, coordinated integration/review of the helper fix, and an
explicit verdict on deterministic preflight readiness semantics. No contribution
commit, PR, issue closure, hosted-CI result, real-provider/GitHub effect, merge or
deployment is claimed.
