# Multiplayer working-session rehearsal and review-summary correction

Base: main `b641497c6877438675e7a5480983d4648b89cfb1`.
Branch: `codex/multiplayer-ui-working-session`. The enclosing commit identifies
the small presentation correction, its regressions and this walkthrough evidence.
Related work: #246 and #316, non-closing.

## Demonstrated defect and correction

The live requester Alice was correctly excluded from independent outcome review,
but the mission's result summary still said **Your review is needed** and invited
her to review. The collaboration row and disabled decision controls correctly
explained the exclusion. This contradictory next-action text was reproduced on
the current-main native stack, not inferred solely from source.

The result summary now uses the same existing `reviewBlockedReason` result as
the decision controls. Excluded requesters and ineligible roles see **Awaiting an
eligible reviewer**, the actual reason, and **Inspect review requirements**.
Eligible reviewers retain the original invitation. No authorization, API,
manual-gate policy, server behavior or theme changes.

Five tests execute the actual App summary expressions and existing eligibility
initializer: excluded requester, wrong role, eligible member, requester-eligible
human gate and completed state. The first two failed on the original source.
All five passed after correction; 54 focused collaboration/context/summary tests
passed with no skips.

## Current-revision native rehearsal

The retained isolated fixture was resumed with its native owned-process helper,
without Prepare/Start/reset/re-enrollment. All four process identities were
verified. Source and private credentials were retained; the native workload
credential rotated normally. No original-office service was used or stopped.
After a latest-main refresh, server and runner were rebuilt and the same fixture
was stopped/resumed through those ownership checks.

Exactly one new synthetic mission was previewed, saved and then launched through
the actual browser as Alice. Its fixture action approval simulates a publication
request but performs no real publication or external effect.

| Object | Identity/result |
| --- | --- |
| Mission | `2cb0b9e0-2df6-4a22-a07b-13c582ebdcc6`, completed |
| Task | `e3bb3c08-4d35-4aa3-929a-c4f7c5bcf514` |
| Run | `76263cd0-489b-436f-a8ac-0959a4718db2`, one run on `multiplayer-ui-qa` |
| Isolated source commit | `171eafdadc6a6a738f6d45dd639fc63936ebd2c8` |
| Artifact | `b7291998-62d3-49c0-ac82-f2fec091e117` |
| SHA-256 | `9db411231d208da74bec99519d486c0d630e05e7a0471ee0a5872d21865f4dbd` |
| Verification | Two persisted checks passed; authorized download matched the recorded digest |
| Outcome review | Alice excluded; Bob accepted through a second actual browser client |

Observed after the UI fix: Alice's corrected summary and disabled decision
buttons; Bob's unchanged review invitation; exact-run review navigation; completed
result with **Approved by Bob**; Bob's single acknowledged comment visible in
Alice's client; empty composer after acknowledgment. Existing completed work and
the original unexecuted **Separate draft boundary** plan retained their states.
Eve's snapshot contained no missions and her artifact request returned HTTP 404.

The desktop browser captured the real local UI during the session. Those captures
were displayed in the operator's local task, not retained as new repository image
files. The earlier [committed screenshot pack](2026-09-17-multiplayer-ui-integration.md#screenshots)
is only historical fallback. It must not be labeled current-revision evidence.
The attempted 390px browser override still measured a 1280px viewport; therefore
no new mobile pass is claimed. The override was reset. Actual WebSocket-failure
and snapshot-failure drills were not repeated in this bounded rehearsal; their
earlier evidence retains its original source and scope.

## Validation

Windows ARM64, Node 24.19.0, pnpm 11.19.0, Rust 1.98.1 and native PostgreSQL 17.
Dependencies installed with the frozen lockfile. No dependency or lockfile edits.

| Command | Result |
| --- | --- |
| `node tools/check_migrations.mjs` | Passed, 41 immutable migrations |
| `pnpm check:docs` | Passed |
| `pnpm test:unit` after the correction | 1,118 passed, 34 skipped, zero failed |
| `pnpm test:steward` | 214 passed, zero skipped/failed |
| `cargo fmt --check` | Passed |
| `cargo clippy --workspace --all-targets --offline --locked -- -D warnings` | Passed |
| `cargo test --workspace --offline --locked -- --test-threads=1` | 561 passed, 343 ignored, zero failed |
| `pnpm build:web` / `pnpm lint:web` after the correction | Passed |
| `cargo build -p crony-server -p crony-runner --offline --locked` | Passed |

Rust checks use the same unchanged native source before/after the UI-only edit;
the final Node suite/build/lint include the correction. Skipped and ignored tests
were not executed. Hosted checks require a separate exact-head result.

An operator helper's first read-only preview printed success but then hit a
Windows Node shutdown assertion after an immediate `process.exit`. Creation was
not attempted on that failed invocation. Normal natural termination replaced the
helper exit; a clean dry-run preceded the single recorded mission creation.

## Boundaries and handoff

This is deterministic local systems evidence, not vendor inference, production
identity, multi-host/physical-device acceptance, shared-machine ownership or full
U7 qualification. No Factory intake, cloud action, real GitHub effect from the
runner, review dismissal, merge or deployment occurred. The separately authorized
contribution PR is publication for human review only.

The same owned fixture is intentionally left running for the operator's working
session, not as an unattended background worker. Factory watch remains disabled.
The operator-local walkthrough contains the precise dry-run/owned-stop command.
All fixture data, source worktrees and earlier failed evidence remain retained.
