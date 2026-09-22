# Multiplayer UI working-session walkthrough

This is a bounded product walkthrough, not multiplayer release acceptance. Start
from an explicitly owned local fixture. Development Alice/Bob/Eve actors and the
deterministic provider are not independent signed-in humans or vendor inference.
Do not bootstrap/reset retained data merely to prepare a presentation.

## Ten-minute story

1. **Shared mission (two minutes).** In Missions, select the intended mission.
   Explain the requester/viewer distinction, task responsibilities and recorded
   runner state. These rows are assignments, not a human-presence roster.
2. **Discussion versus execution (two minutes).** Use **04 · Team conversation**.
   A comment is attributed shared discussion; it is not an agent instruction,
   task submission or authorization. Open **02 · Tasks & contracts** to show
   the separate bounded execution contract. A saved plan needs explicit launch.
3. **Decisions and evidence (three minutes).** Open **03 · Evidence & decisions**.
   Point out the exact run, automated checks, artifact and separate outcome
   review. An excluded requester sees **Awaiting an eligible reviewer** and the
   reason, while an eligible reviewer sees **Your review is needed**. The server
   remains authoritative; navigating to requirements grants no permission.
4. **Continuity (one minute).** Move between Missions and Comms and reload the
   selected completed result. Durable work survives the client. Scoped in-memory
   drafts survive supported route changes, not necessarily browser reload.
   Recorded evidence remains useful when live controls are unavailable.
5. **Design feedback (two minutes).** Ask whether the hierarchy makes ownership,
   the next required decision and the distinction between conversation and
   control obvious. Use the existing narrow-screen evidence as a discussion aid.

Prefer an already verified completed mission for the live meeting. Do not make
the presentation depend on a new provider run, credentials or external effect.
If demonstrating a pending decision, inspect the exact requested scope first;
never click an unfamiliar approval to advance the presentation.

## Questions worth asking

- Can a new user tell who requested the work, who is executing it and who may decide?
- Does the mission summary make the next action clear without scrolling into technical details?
- Are **discussion**, **live direction**, **action approval** and **outcome review** distinct enough?
- Is the transition from mission to exact-run evidence predictable?
- Which information should remain visible on a narrow screen?

## What this does not claim

The current work adds collaboration clarity within the existing app. It is not an
ecosystem-wide theme change. Normal browser sign-in/invitations (#242), ephemeral
authenticated human presence (#253), shared-resource selection (#314), and
shared launch-consumer parity (#315) retain their own backend and review gates.
The proposed #318/#319 contract is not adopted merely by referencing it.

The merged foundation is #306; activity/freshness and exact-run navigation came
from #265. The U7 verification map is [U7_PARITY_MATRIX.md](U7_PARITY_MATRIX.md).
Keep #246 and #316 open for their full acceptance.

For screenshot-based fallback, use the source-qualified
[integration report](../evidence/2026-09-17-multiplayer-ui-integration.md#screenshots).
Those captures are historical, not evidence of a new current-head rehearsal.
