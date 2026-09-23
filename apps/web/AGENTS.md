# Web contributor notes

This client projects server state. Keep mutation authority, budget decisions, runner lifecycle
and accepted verification in the existing API/server contracts.

- `src/App.tsx` owns mission/recovery state and wires the operational screens. Prefer a leaf
  component or pure model when behavior has a controlled input/callback boundary.
- `src/verificationPolicy.ts` owns draft policy transformations and client validation;
  `VerificationPolicyEditor.tsx` owns its fields, tabs and preview. The server and runner still
  validate the complete persisted contract. Draft editing must not publish a decision or launch.
- The `*.test.mjs` suites use native Node testing and actual TypeScript/React code. Some recovery
  regressions intentionally extract production ASTs; inspect those tests before moving callers.
- Preserve keyboard selection, selected-tab state, accessible labels, focus after removal and
  narrow-screen overflow. UI refactors require actual browser evidence as well as model tests.

Use root `pnpm test:unit`, `pnpm build:web` and `pnpm lint:web` for contributor checks. For a
browser/server/runner claim, use an explicitly owned fixture and record persisted policy and
verification IDs; browser-only rendering is a narrower result.

`pnpm test:js` from the root discovers the web, tooling, steward and readiness suites;
see `docs/VALIDATION.md` for the complete source-bound validation command.
Keep server, Corp, actor, room/mission and selected source explicit in state. Missing or
denied context stays unknown, and comments do not authorize approvals or steering.
Keep producer and verifier identities distinct, and preserve reconnect and 390px behavior
when exercising an owned browser/server/runner stack.
