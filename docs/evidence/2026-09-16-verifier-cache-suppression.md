# Verifier cache suppression — September 16, 2026

## Scope and native capability

Issue #140; base main `b2523964e7576cafc00e84a51e1044f55826dea7`.
Branch `codex/issue-140-verifier-caches`. Changes cover the domain policy, native
runner verifier and disposition detail, frontend policy type, and mechanical
constructor/pattern updates in existing planning, store validation and runner tests.
No schema migration or dependency update.

Python 3.14.5 and Node 22.23.1 were exercised locally. Python's native
[`-B` and environment controls](https://docs.python.org/3/using/cmdline.html)
provide import-cache suppression; `-E`/`-I` ignore environment variables, so direct
Python entrypoints also receive `-B`. Node's
[`NODE_DISABLE_COMPILE_CACHE`](https://nodejs.org/download/release/v22.17.0/docs/api/module.html)
control is available from 22.8. The ECorp gap was scoped delivery of these native
controls during authoritative verification, with explicit evidence. No new process
harness, general environment map, cache deletion engine or approval is introduced.

## Behavior and limits

- Omitted policy keeps the old serialized shape; recognized direct Python names
  automatically receive `-B` and child-only `PYTHONDONTWRITEBYTECODE=1`.
- Explicit typed options support interpreter, environment-only wrapper and Node
  compile-cache modes. Unknown enum values fail deserialization.
- Windows `py` launchers get environment-only suppression. Wrapper flags and
  environment-discarding children need an explicitly authored command; automatic
  launcher argument rewriting is not claimed.
- Older runners may ignore the optional field. Use an updated runner for suppression;
  mixed-version enforcement and browser policy-editor controls are not claimed.
- Existing dirty/committed/unknown workspace preservation remains authoritative.
  Tracked/untracked/ignored counts are separate; ignored ownership is unknown.
  No cache directories are allocated and no file becomes owned by its name.
- Provider artifacts retain their own artifact records. Suppression evidence is
  a requested control, never proof of zero writes or permission to remove caches.

## Local checks

All six repository gates passed:

```sh
node tools/check_migrations.mjs
cargo fmt --check
cargo clippy --workspace --all-targets --locked --offline -- -D warnings
cargo test --workspace --locked --offline
pnpm build:web
pnpm lint:web
```

41 immutable migrations; final default workspace suite: **519 passed, 0 failed,
326 ignored**. Three new external-runtime cases are opt-in, not silently counted
as passes. They and the two pure regressions passed explicitly:

```sh
cargo test -p crony-runner issue140_ --locked --offline -- --include-ignored
```

**5 passed, 0 failed, 0 ignored.** Coverage:

1. Real Python imports under normal, `-E`, `-I`, and combined `-IE` flags create no
   cache directory; the native linked-worktree manager removes clean worktrees.
2. Preexisting ignored bytecode and an unrelated log preserve their bytes and
   force native preservation after passing verification.
3. Child-only environment overrides, argument order, absent-policy serialization,
   unknown-policy rejection and narrow interpreter recognition.
4. Explicit environment-only command keeps argv and returns the expected child setting.
5. Node's real `enableCompileCache()` reports `DISABLED` under the explicit control.

The mixed-path regression separately checks tracked, untracked, ignored and rename
accounting including newline-containing paths. No baseline application race or
real-provider execution is claimed by these checks.

## Full-stack acceptance

An owned disposable PostgreSQL fixture, actual candidate server and runner, existing
fake-process adapter, and web UI ran against a separate minimal committed source repo.
Both missions were launched by clicking **Start mission** in the browser.

| Case | Mission | Run | Result |
|---|---|---|---|
| Clean worktree | `c47d8e15-6a1d-4096-aee5-5567a5226ea7` | `e93de02b-670f-4824-99db-204a5918d575` | Completed, 3/3 checks, native removal and branch deletion |
| Ignored file | `b07fee3f-ff1e-4759-800a-15dafbca212f` | `de27f13c-017f-4400-8183-39bb4dbdae08` | Completed, 3/3 checks, worktree and original log bytes preserved |

Each persisted policy exercised artifact verification, Python `-IE` import and explicit
Node suppression. API readback verified the policy evidence and filesystem disposition;
the browser independently showed 3/3 checks and the correct Removed/Preserved state.
The ignored case had tracked_changes=0, untracked_files=0, ignored_files=1, with
unattributed ownership. Provider evidence was stored outside the source worktree.

QA database history was exported, source and the preserved worktree retained, and only
owned server/runner/web/container resources stopped. The personal runtime and database
were untouched. This proves the exercised local fixture, not vendor inference, hosted
CI, Windows runtime behavior or deployment readiness.

## Independent review

GitHub Copilot GPT-6 Astra/high design and independent correctness reviews completed.
The independent review found no production-code defect; it flagged the Node test's
22.8+ runtime dependency. External-runtime cases were made explicit and all five were
rerun successfully. Final workspace and Clippy checks passed after that adjustment.

## Source fingerprints

| File | SHA-256 |
|---|---|
| `crates/crony-domain/src/lib.rs` | `7f3f5d61d938eea0cf9a7a87fc230d9e4b02083da286ac20efd3da107ba6a795` |
| `crates/crony-runner/src/verifier.rs` | `05d1501b18017fbd6ef2ccea2375b67d2cb20cc23f8ab9b3ffff72cac388f86e` |
| `crates/crony-runner/src/workspace.rs` | `c09e83d3f01d4e53efa33da1864e43d961bbf9e3cf6cb0a339858032c27f8c7d` |
