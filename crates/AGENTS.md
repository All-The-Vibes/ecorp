# Rust contribution context

The root AGENTS.md and product/security contracts still apply.

- Domain contains pure policies; protocol contains wire DTOs; store owns transactional
  persistence; server owns authenticated control; runner owns isolated execution; CLI and
  gateways adapt supported native operations. Preserve these boundaries.
- Start with the affected crate's Cargo.toml and relevant module. Use a focused package/test
  filter first, then `cargo fmt --check`, workspace Clippy and workspace tests before committing.
- The compiler toolchain is pinned in rust-toolchain.toml; Cargo.lock remains authoritative.
- Inline tests and macro-generated cases are real Rust tests. Filename or annotation counts
  are not execution counts. Report passed, failed and ignored results separately.
- SQLx tests marked ignored require explicitly owned disposable fixtures. Never inherit a
  retained application's database just to run them. Native-session probes remain opt-in.
- Prefer native harness capabilities and existing recovery/approval operations over parallel
  orchestration machinery. Scope admission by Corp, actor, run, source and current authority.
- Completion needs persisted verifier evidence. A code path, configured gate or successful
  unit test does not establish real-provider, hosted or production acceptance.
