# Server startup validation evidence — September 15, 2026

## Outcome and scope

For #271, invalid configuration is rejected before migrations and startup
recovery. All preparation finishes before artifact-directory creation or worker
activation. The change reuses native CORS/URL/key parsers, the existing OIDC
initializer and pinned object_store 0.12.5 client construction. It introduces no
migration, lifecycle framework, deployment or change to OIDC discovery URL joining.

Base: `b2523964e7576cafc00e84a51e1044f55826dea7`. Evidence describes the source
files below, not an upstream merge or production deployment. Validation ran on
macOS Apple Silicon in an isolated worktree backed by an independent local clone.

## Reproduction and regressions

- Unmodified baseline, production mode with missing issuer: exit 1, public tables
  changed from **0 to 42** before the error was reported.
- The checked-in regression run against that preserved baseline exits 1 with
  `empty/missing_issuer: database changed`.
- Updated binary: **58 rejection cases passed** against empty and populated
  disposable database clones. The populated template contains a connected runner;
  valid startup on a separate clone demonstrably changes it to grace.
- Valid development startup migrated and bootstrapped a demo. Restart preserved
  the quiescent database fingerprint and the saved demo remained readable.
- Startup removed an unreserved staging object and preserved an unrelated local
  artifact marker. Runner recovery used the existing persisted connection epoch.
- Explicit CLI parse errors and `--help` were tested with owned database URLs,
  unchanged fingerprints, zero fixture requests, and no environment-secret echo.
- Full backtraces were enabled for a rejection case. Only the fixed top-level
  error was printed; the previous executable emitted a 2,374-byte backtrace.
- Production startup passed with both 32- and 33-byte artifact signing keys and
  actually contacted the trusted local TLS object-store listing fixture.
- Three Docker-cleanup guard tests passed, including timeout after creation,
  rejection of a foreign ownership label and no-op cleanup before creation.

The harness uses a temporary CA/leaf certificate and process-scoped trust only.
Standalone `cargo build -p crony-server` is the TLS-fixture build target. A macOS
workspace build unified a different TLS backend and failed the fixture trust
check; this was not counted as a passing production-positive run. No product TLS
policy, system trust, credentials or certificate-verification settings changed.

## Repository gates

All six required gates passed on the final Rust implementation:

```sh
node tools/check_migrations.mjs
cargo fmt --check
cargo clippy --workspace --all-targets --locked --offline -- -D warnings
cargo test --workspace --locked --offline
pnpm build:web
pnpm lint:web
```

The Rust suite reported **517 passed, 0 failed, 323 ignored**. Ignored tests are
not passed tests; the actual-database startup suite above was explicitly executed.
The migration checker verified 41 immutable migration checksums. Web dependencies
were installed using `pnpm install --frozen-lockfile --offline`.

Builds used an isolated `CARGO_TARGET_DIR` with `CARGO_PROFILE_DEV_DEBUG=0`,
`CARGO_PROFILE_TEST_DEBUG=0`, and `CARGO_INCREMENTAL=0` to limit disk usage.
After the full workspace gates, the standalone server was built and tested using:

```sh
cargo build -p crony-server --locked --offline
PYTHONDONTWRITEBYTECODE=1 python3 tools/test_startup_validation.py --server-binary "$CARGO_TARGET_DIR/debug/crony-server" --allow-disposable-docker
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools -p test_startup_validation_harness.py -v
```

## Owned browser/server/runner evidence

A separate disposable stack used the modified server, current web client, real
runner and isolated task worktrees. The original operator stack was not restarted.

1. The browser submitted a mission using the built-in Copilot **fixture**, not
   hosted inference. The UI displayed Completed with 1/1 verification checks.
   The downloaded provider artifact matched its persisted SHA-256.
2. `tools/e2e_artifacts.mjs`, with `CRONY_SERVER_HTTP` explicitly set to the owned
   QA endpoint, exercised the real runner's **fake-process child**. The browser
   received Completed and 1/1 verification checks. The existing E2E checked bytes,
   signed provenance, retention, download authorization and absence of local-path
   disclosure. Unauthorized download returned 404.
3. The two dirty QA worktrees were preserved outside temporary storage before
   stopping the owned stack and removing its disposable database. Original
   operator worktrees, credentials, database and mission history were untouched.

These are deterministic local execution results, not real OIDC sign-in, hosted
Copilot execution, production S3 authorization or deployment acceptance.

| Receipt | Value |
|---|---|
| Browser fixture run | `31f85b04-345e-4e78-a58a-0ea41f2fdc3a` |
| Browser artifact SHA-256 (403 bytes) | `1394a92527f1f4e9a9e07afbdb5fa9aef58239374b71d71d715481cb7b3576d4` |
| Child-process run | `259846bc-b88c-4fd2-8bd6-f2da64c16416` |
| Child artifact SHA-256 (1385 bytes) | `b8a02ce931e699c1f7263df34718dbc3e51204a583c16a9d87f5f30c2a4664e2` |

## Independent review

GitHub Copilot `gpt-6-astra`, high effort, completed the implementation proposal,
test-design proposal, independent review and follow-up review. Findings were
checked against source and tests. The executable boundary was hardened for
backtraces; the harness gained timeout-safe owned cleanup, recovery-sensitive
seeding, all-method request counting, exact secret-value checks and isolated
CLI/help coverage. The follow-up found no new product-code defect and identified
the CLI/help isolation gap, which was corrected and retested.

## PR review follow-up: help output

The published review identified that clap still displayed the built-in development
database URL as a default in help. Added `hide_default_value = true` and expanded
the actual-binary help assertion to reject both the built-in URL and the supplied
disposable database URL. The full 58-case rejection suite and positive startup,
recovery, CLI/help and TLS storage checks passed again. All six repository gates
listed above passed again on this change. GitHub Copilot `gpt-6-astra`, high effort,
completed a focused static review with no actionable findings. Runtime behavior
was independently verified by the local regression suite.

## Source fingerprints

| File | SHA-256 |
|---|---|
| `crates/crony-server/src/main.rs` | `5d0e5916a4e4771c346e3acc84b21c3263058b34f7eda83f4bd6a6c06884347c` |
| `crates/crony-server/src/artifacts.rs` | `4310086176d81ca91329a99fa7eac719566d999291d5fcf2150c6146f6a90b95` |
| `crates/crony-server/src/startup.rs` | `14d68f013a5afb985d3e5c392088e09621bc5a4b366add5707162c6eb80b2177` |
| `tools/test_startup_validation.py` | `315aa7a8acbed7d6b4bc82e54b11215971452585775c2696552f6699cdb0f94e` |
| `tools/test_startup_validation_harness.py` | `04f54f57a225737db70756207ab724b15000531c4a57b2db9f3f47a74d417fc4` |

## Integration boundaries

Issue #230's PowerShell wrapper, #248's retained lifecycle work and #270's existing
unpublished OIDC path fix remain separate. At the ownership refresh, #271 was open
and unassigned with no comments or recorded blockers. PR #255 did not change
startup ordering; PR #283 adds a startup service and needs a fresh integration
check before publication. No ticket claim, comment, PR, merge, Factory intake or
deployment was performed as part of this validation.
