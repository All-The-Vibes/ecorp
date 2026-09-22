# Verification tool boundaries

The root `pnpm test:unit` command discovers top-level `*.test.mjs` fixtures. Bare `e2e_*.mjs`
drivers can create missions, reset demo state, restart services or exercise irreversible-effect
fixtures; they are not interchangeable with that unit lane.

Before running a real-stack driver, inspect its ownership/opt-in requirements and its exact
server, database, source repository and runner workspace. Reuse the native owned-stack/lifecycle
helpers. A listener, PID file or historical port number alone is not ownership proof. Preserve
failed receipts and dirty/unverifiable worktrees; stop only resources created or verified as
owned for the current fixture.

`probe_mcp.mjs` is a separate read-only stdio/API probe. It requires explicit routing and a
trusted native binary, never resets a demo, and emits bounded metadata instead of snapshot
contents. `verify_toolchain.mjs` reports selected native tool versions without installation.
`check_documentation.mjs` validates only its marked current command/version contracts.

`operation_feedback.mjs prepare` performs reads and writes new local proposal files.
Its explicit `apply` command makes a native contract revision and requires the
selected proposal bytes/hash and current native authority. It never launches work.
An unknown result may already have committed; preserve the exact request/key and
reconcile instead of creating a new request. See `docs/OPERATION_FEEDBACK.md`.

`import_operation_behavior.mjs` reads explicitly pinned retained files and writes
a new advisory candidate corpus. It never executes a supplied historical checker,
calls native APIs or promotes historical evidence. Local review cannot activate
this evidence kind. Keep native verification and external checker outcomes distinct.

Keep exact commands, exit statuses, source identity and evidence scope in reports. Fixture
success, real-provider inference, hosted checks and production authentication are distinct.
