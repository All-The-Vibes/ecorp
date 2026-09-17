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

Keep exact commands, exit statuses, source identity and evidence scope in reports. Fixture
success, real-provider inference, hosted checks and production authentication are distinct.
