#!/usr/bin/env bash
# Native Rust coverage only: no provider, application server, source exclusion,
# retry, or alternate test harness. The caller owns the disposable PostgreSQL service.
set -euo pipefail

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  printf '%s\n' 'This measured coverage lane requires Linux x86_64.' >&2
  exit 1
fi
if [[ ${ECORP_COVERAGE_OWNED_DATABASE:-} != 1 ]]; then
  printf '%s\n' 'Explicitly owned disposable coverage database is required.' >&2
  exit 1
fi
if [[ ${CARGO_TARGET_DIR:-} != /* || -e ${CARGO_TARGET_DIR:-} ]]; then
  printf '%s\n' 'CARGO_TARGET_DIR must name a new absolute directory.' >&2
  exit 1
fi
if [[ $(node --version) != v22.23.2 || $(cargo +1.98.1 llvm-cov --version) != 'cargo-llvm-cov 0.9.1' ]]; then
  printf '%s\n' 'Pinned Node 22.23.2 and cargo-llvm-cov 0.9.1 are required.' >&2
  exit 1
fi
command -v npm >/dev/null
command -v psql >/dev/null
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
const env = process.env
let db
try { db = new URL(env.DATABASE_URL) } catch { throw new Error('Invalid owned database configuration') }
assert.equal(db.protocol, 'postgres:')
assert.ok(['127.0.0.1', 'localhost', 'postgres'].includes(db.hostname))
assert.equal(db.hostname, env.PGHOST)
assert.equal(db.port || '5432', env.PGPORT)
assert.equal(db.username, 'ecorp_coverage')
assert.equal(env.PGUSER, db.username)
assert.equal(db.pathname, '/ecorp_coverage')
assert.equal(env.PGDATABASE, 'ecorp_coverage')
assert.ok(decodeURIComponent(db.password) === env.PGPASSWORD, 'Owned database configuration mismatch')
assert.ok(env.PGPASSWORD && !db.search && !db.hash)
NODE

# SQLx 0.8.6 derives deterministic _sqlx_test_* names and may clean an old
# matching database. Refuse any retained SQLx namespace before invoking tests.
namespace_state=$(psql --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
  --command "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE left(datname, 11) = '_sqlx_test_') OR to_regnamespace('_sqlx_test') IS NOT NULL THEN 'retained' ELSE 'fresh' END;")
if [[ $namespace_state != fresh ]]; then
  printf '%s\n' 'Retained SQLx database/schema namespace detected; use a fresh owned service.' >&2
  exit 1
fi

unset TEST_DATABASE_URL CRONY_TEST_DATABASE_URL GH_TOKEN GITHUB_TOKEN CRONY_ACCESS_TOKEN
unset OPENAI_API_KEY ANTHROPIC_API_KEY COPILOT_GITHUB_TOKEN SQLX_OFFLINE
unset RUSTFLAGS RUSTDOCFLAGS LLVM_PROFILE_FILE RUST_TEST_THREADS
export CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 COPILOT_SKIP_CLI_DOWNLOAD=1
export CARGO_LLVM_COV_TARGET_DIR="$CARGO_TARGET_DIR"
export CARGO_LLVM_COV_BUILD_DIR="$CARGO_TARGET_DIR/build"
reports=coverage
# Measured Linux baseline at 38507abc: 49,407/72,899 lines (67.7746%).
# Other platforms and coverage scopes retain their own baselines.
readonly line_floor=67.0
mkdir "$reports" # Never replace or reuse earlier reports/profiles.
printf '%s\n' 'fresh: no _sqlx_test schema or _sqlx_test_* database existed before this invocation' > "$reports/database-preflight.txt"

source_snapshot() {
  node --input-type=module - "$1" <<'NODE'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const git = (...args) => execFileSync('git', args).toString()
const files = git('ls-files', '-z', '--', 'crates', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml')
  .split('\0').filter(file => /\.rs$|(^|\/)Cargo\.(toml|lock)$|^rust-toolchain\.toml$/.test(file)).sort()
if (!files.length) throw new Error('Rust source inventory is empty')
const status = git('status', '--porcelain', '--', 'crates', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml')
if (status) throw new Error('Coverage requires unchanged committed Rust sources')
const blobs = new Map(git('ls-tree', '-r', '-z', 'HEAD').split('\0').filter(Boolean).map(entry => {
  const [metadata, file] = entry.split('\t'); return [file, metadata.split(' ')[2]]
}))
fs.writeFileSync(process.argv[2], JSON.stringify({ commit: git('rev-parse', 'HEAD').trim(), files: files.map(file => ({
  file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), git_blob: blobs.get(file),
})) }, null, 2) + '\n', { flag: 'wx' })
NODE
}
source_snapshot "$reports/source-before.json"

finish() {
  status=$?
  trap - EXIT
  set +e
  if ! source_snapshot "$reports/source-after.json" || ! cmp -s "$reports/source-before.json" "$reports/source-after.json"; then
    printf '%s\n' 'Rust source identity changed during coverage.' >&2
    status=1
  fi
  ECORP_COVERAGE_EXIT_STATUS=$status ECORP_COVERAGE_LINE_FLOOR=$line_floor node --input-type=module <<'NODE'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const tests = {}
for (const [stage, file] of Object.entries({ unit: 'unit-tests.log', store: 'store-sqlx-tests.log', server: 'server-sqlx-tests.log' })) {
  if (!fs.existsSync(`coverage/${file}`)) continue
  const summaries = [...fs.readFileSync(`coverage/${file}`, 'utf8').matchAll(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/g)]
  tests[stage] = { passed: 0, failed: 0, ignored: 0, native_summaries: summaries.length }
  for (const [, , passed, failed, ignored] of summaries) {
    tests[stage].passed += Number(passed); tests[stage].failed += Number(failed); tests[stage].ignored += Number(ignored)
  }
}
let status = Number(process.env.ECORP_COVERAGE_EXIT_STATUS)
if (!status && ['unit', 'store', 'server'].some(stage => !(tests[stage]?.passed > 0) || tests[stage].failed)) status = 1
const native = fs.existsSync('coverage/native-summary.json') ? JSON.parse(fs.readFileSync('coverage/native-summary.json')) : null
const files = fs.readdirSync('coverage').filter(file => fs.statSync(`coverage/${file}`).isFile())
const receipt = { schema_version: 1, status: status === 0 ? 'passed' : 'incomplete', exit_code: status,
  line_floor_percent: Number(process.env.ECORP_COVERAGE_LINE_FLOOR),
  platform: { os: process.platform, arch: process.arch }, tests, native_totals: native?.data?.[0]?.totals ?? null,
  reported_source_files: native?.data?.flatMap(data => data.files?.map(file => file.filename) ?? []) ?? [],
  scope: 'Native cargo-llvm-cov Rust workspace unit tests plus ignored crony-store/crony-server SQLx tests on this Linux build. The standalone issue297_native_adversarial_fixture requires a separately owned nonce-qualified database and is not selected by this shared SQLx lane. No source files are excluded from coverage. This is not whole-repository, web, provider, or application E2E coverage.',
  unexecuted_scope: 'The standalone issue297_native_adversarial_fixture and other ignored tests, including the explicit runner stopped-session probe, remain unexecuted in this coverage lane.',
  database: { role: process.env.PGUSER, database: process.env.PGDATABASE, host: process.env.PGHOST, port: process.env.PGPORT,
    ownership: 'Caller-provided disposable PostgreSQL service; SQLx owns its per-test databases.' },
  artifacts: files.map(file => ({ file, sha256: digest(`coverage/${file}`) })),
  invocation_source_sha256: digest('tools/coverage_rust_sqlx.sh'),
  workflow_source_sha256: digest('.github/workflows/repository-checks.yml'), finished_at: new Date().toISOString() }
fs.writeFileSync('coverage/run.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
process.exitCode = status
NODE
  receipt_status=$?
  if [[ $receipt_status != 0 ]]; then status=1; fi
  exit "$status"
}
trap finish EXIT

psql --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
  --command 'SELECT current_database(), current_user, version();' > "$reports/postgres.txt"
{ rustc +1.98.1 --version; cargo +1.98.1 --version; cargo +1.98.1 llvm-cov --version; node --version; npm --version; } > "$reports/versions.txt"
{ sha256sum "$(command -v cargo-llvm-cov)" "$(command -v node)"; } > "$reports/tool-hashes.txt"

cargo +1.98.1 llvm-cov test --workspace --locked --no-report 2>&1 | tee "$reports/unit-tests.log"
# In 0.9.1, --no-report already retains profiles and conflicts with --no-clean.
cargo +1.98.1 llvm-cov test -p crony-store --locked --no-report -- --ignored --test-threads=1 2>&1 | tee "$reports/store-sqlx-tests.log"
# This native adversarial entrypoint rejects ordinary DATABASE_URL ownership:
# its separate driver supplies a nonce-qualified service and per-case schema.
cargo +1.98.1 llvm-cov test -p crony-server --locked --no-report -- --ignored --skip artifacts::tests::issue297_native_adversarial_fixture --test-threads=1 2>&1 | tee "$reports/server-sqlx-tests.log"
cargo +1.98.1 llvm-cov report --locked --json --output-path "$reports/native-summary.json" 2>&1 | tee "$reports/json-report.log"
cargo +1.98.1 llvm-cov report --locked --lcov --output-path "$reports/lcov.info" 2>&1 | tee "$reports/lcov-report.log"
cargo +1.98.1 llvm-cov report --locked --fail-under-lines "$line_floor" 2>&1 | tee "$reports/line-guard.log"
