# Web contribution context

The root AGENTS.md and product/security contracts still apply.

- Start with the relevant pure projection/reader beside App.tsx, not the entire UI file.
- Run `pnpm test:js` from the repository root; Node 24 executes the existing `.test.mjs`
  suites and their TypeScript imports. `pnpm build:web` type-checks and builds;
  `pnpm lint:web` checks the web source. See `docs/VALIDATION.md` at the repo root.
- Server snapshots, exact context readers and persisted run IDs are authoritative.
  Missing/denied/incomplete context stays unknown; do not substitute another run or viewer.
- Scope state by server, Corp, actor, room/mission and selected source where applicable.
  A remembered run ID grants no authority. Comments are not approvals or steering commands.
- Keep mission, task, run, producer and verifier identities distinct in evidence views.
- For changed user-visible behavior, verify the browser-to-server-to-runner path in an owned
  isolated stack, including reconnect and 390px layout. SSR/unit success is not that proof.
- Coordinate changes to App.tsx with active UI work; extract a bounded responsibility only
  with regression coverage. Do not rewrite shared schemas or lockfiles incidentally.
