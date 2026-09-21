# PR255-B-G04 / PR255-PRODUCTION-REGISTRATION

## Outcome
Implemented the missing production controller-registration handler regression. Source is frozen and ready for parent SQLx execution; the finding is not yet behaviorally verified/closed. No DB connection or credential access by this worker.

Starting HEAD: 690ee80e692d848c4c3a371ddb31388a78b9ddf3.
Baseline release: 2026-09-21T14:53:52.4901574Z, changed=0 across 154 inputs. All Rust edits occurred after release.

## Changes
- crates/crony-server/src/issue161_authority_tests.rs:165-335 — one native production-mode handler/SQLx regression plus targeted full-row readback helper; +172 lines.
- SHA-256: bfdce2c4e20eb5cb90964cb937f593b232361a827078001b000f82b53d2b92e1.
- factory_connection_tests.rs unchanged; existing Fixture reused without modification.
- All other 153 Rust/migration/build inputs match the released baseline. No production source, UI, PowerShell, QA API/provenance or review-state edits; no commit/push/GitHub changes, agents, installs or provisioning.

## Coverage
Calls the actual configure_factory_controller handler with native AuthService initialized in Production mode. A bounded in-process loopback Axum discovery fixture closes before admission; it is neither a persistent daemon nor a real IdP. Synthetic Principal::Oidc values use native link_human_identity/resolve_human_identity and ordinary handler authorization.

The test requires omitted/wrong/nil pins to return the exact BAD_REQUEST diagnostic with unchanged full controller, controller-operation and event rows. A correct pin must still reject a spoofed actor, member role, unknown subject and foreign Corp with FORBIDDEN and no registration effects. All denials repeat after successful registration under its existing idempotency key. Correct-pin admission creates exactly one controller, configure operation and event; exact replay returns the same controller, replayed=true, and unchanged durable rows.

This proves the production-mode handler branch when executed, not authenticate_http, bearer/UserInfo middleware, real humans, production deployment, browser, provider or live Factory. Other fixture services retain their test defaults. Native identity resolution can update last_authenticated_at; no-effects assertions intentionally target controller/operation/event persistence, not whole-database immutability.

## Executed validation
- cargo fmt --check: PASS.
- cargo test -p crony-server --locked --offline --no-run: PASS.
- cargo clippy -p crony-server --all-targets --locked --offline -- -D warnings: PASS.
- cargo test -p crony-server --locked --offline factory_connection_tests:: -- --ignored --list: PASS, 9 SQLx cases listed including the exact new selector; listing is not execution.
- cargo test -p crony-server --locked --offline -- --test-threads=1: PASS, 122 passed, 0 failed, 9 ignored. The new SQLx test is one of those ignored cases, NOT a passing behavioral test.
- git diff --check -- crates/crony-server/src/issue161_authority_tests.rs: PASS.
- All 154 frozen source hashes were rechecked after validation with no drift.

Commands ran with OS/toolchain-only child environments and offline/locked Cargo. Initial no-run compilation failed because link.exe was absent from sanitized PATH. Retrying via the already installed MSVC VsDevCmd.bat succeeded. The original setup failure is retained in compile-attempt-1-linker-setup-failed.log and static-attempt-1-results.json. The earlier draft preparation error is also retained. Neither is behavioral RED. This is coverage-only, not a reproduced product defect; no mutation test or genuine product failure is claimed.

## Parent execution handoff
ready-for-db.json contains exact selectors, passing static receipts and all 154 source hashes. Parent alone supplies the ephemeral credential through its child process environment (reduced assurance), against its owned PostgreSQL 17 fixture at 127.0.0.1:55463 described by ../database-fixture.json. Manual DB54329 was not accessed. Source remains frozen for these commands:

```powershell
cargo test -p crony-server --locked --offline factory_connection_tests::claim_authority::issue161_production_controller_registration_requires_pin_before_persistence -- --exact --ignored --test-threads=1 --nocapture
cargo test -p crony-server --locked --offline factory_connection_tests:: -- --ignored --test-threads=1 --nocapture
```

Expected counts: exact new test 1; affected fixture/authority family 9. Preserve actual outputs and match frozen hashes before claiming behavioral closure. No infrastructure blocker remains; pending work is parent-owned SQLx execution and integration/review. Full-PR checks and independent review remain the parent's separate gates.
