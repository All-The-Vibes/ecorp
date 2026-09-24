#!/usr/bin/env bash
# Native Rust coverage only: no provider, separate application server, source exclusion,
# retry, or alternate test harness. The caller owns the disposable PostgreSQL service;
# this invocation owns the local Anvil needed by the worker/gateway SQLx acceptance test.
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
command -v anvil >/dev/null
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const pins = JSON.parse(fs.readFileSync('tools/registry-toolchain/toolchain.json', 'utf8')).foundry
const version = execFileSync('anvil', ['--version'], { encoding: 'utf8' }).split(/\r?\n/)
assert.equal(version[0], `anvil Version: ${pins.version}`)
assert.equal(version[1], `Commit SHA: ${pins.commit}`)
NODE
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
# matching database. Refuse any retained SQLx namespace or HTTP fixture database
# before invoking tests. The HTTP fixture does not use SQLx's database harness.
namespace_state=$(psql --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
  --command "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE left(datname, 11) = '_sqlx_test_' OR datname = 'ecorp_coverage_base_audit') OR to_regnamespace('_sqlx_test') IS NOT NULL THEN 'retained' ELSE 'fresh' END;")
if [[ $namespace_state != fresh ]]; then
  printf '%s\n' 'Retained SQLx namespace or audit fixture database detected; use a fresh owned service.' >&2
  exit 1
fi

unset TEST_DATABASE_URL CRONY_TEST_DATABASE_URL BASE_AUDIT_TEST_DATABASE_URL GH_TOKEN GITHUB_TOKEN CRONY_ACCESS_TOKEN
unset OPENAI_API_KEY ANTHROPIC_API_KEY COPILOT_GITHUB_TOKEN SQLX_OFFLINE
unset RUSTFLAGS RUSTDOCFLAGS LLVM_PROFILE_FILE RUST_TEST_THREADS
unset ECORP_COVERAGE_ANVIL_STARTED ECORP_COVERAGE_ANVIL_READY ECORP_COVERAGE_ANVIL_EXIT_CODE
unset ECORP_COVERAGE_BASE_AUDIT_DATABASE_CREATED
export CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 COPILOT_SKIP_CLI_DOWNLOAD=1
export CARGO_LLVM_COV_TARGET_DIR="$CARGO_TARGET_DIR"
export CARGO_LLVM_COV_BUILD_DIR="$CARGO_TARGET_DIR/build"
reports=coverage
# Measured Linux baseline at 38507abc: 49,407/72,899 lines (67.7746%).
# Other platforms and coverage scopes retain their own baselines.
readonly line_floor=67.0
mkdir "$reports" # Never replace or reuse earlier reports/profiles.
printf '%s\n' 'fresh: no _sqlx_test schema, _sqlx_test_* database, or ecorp_coverage_base_audit database existed before this invocation' > "$reports/database-preflight.txt"

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
  if [[ -n ${anvil_pid:-} ]]; then
    # The shell's live child-job table fences cleanup to this invocation. Never
    # kill a listener discovered only by its historical port or a saved PID file.
    if jobs -pr | grep -Fxq "$anvil_pid"; then
      kill "$anvil_pid"
    else
      status=1
    fi
    wait "$anvil_pid"
    export ECORP_COVERAGE_ANVIL_EXIT_CODE=$?
    if [[ $ECORP_COVERAGE_ANVIL_EXIT_CODE != 0 && $ECORP_COVERAGE_ANVIL_EXIT_CODE != 143 ]]; then status=1; fi
  fi
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
  scope: 'Native cargo-llvm-cov Rust workspace unit tests plus ignored crony-store SQLx and selected crony-server SQLx/HTTP tests on this Linux build. The standalone issue297_native_adversarial_fixture requires a separately owned nonce-qualified database and is not selected by this shared SQLx lane. No source files are excluded from coverage. This is not whole-repository, web, provider, or application E2E coverage.',
  unexecuted_scope: 'The standalone issue297_native_adversarial_fixture and other ignored tests, including the explicit runner stopped-session probe, remain unexecuted in this coverage lane.',
  database: { role: process.env.PGUSER, database: process.env.PGDATABASE, host: process.env.PGHOST, port: process.env.PGPORT,
    ownership: 'Caller-provided disposable PostgreSQL service; SQLx owns its per-test databases.',
    http_fixture: { database: 'ecorp_coverage_base_audit', created: process.env.ECORP_COVERAGE_BASE_AUDIT_DATABASE_CREATED === '1',
      ownership: 'Invocation-created empty database for base_v2_api_http_disconnected_preserves_v1_and_authorization; retained until the caller tears down the owned service.' } },
  evm: { ownership: 'Invocation-owned pinned Anvil child on loopback:18556; native child-job cleanup at exit.',
    started: process.env.ECORP_COVERAGE_ANVIL_STARTED === '1', ready: process.env.ECORP_COVERAGE_ANVIL_READY === '1',
    exit_code: process.env.ECORP_COVERAGE_ANVIL_EXIT_CODE === undefined ? null : Number(process.env.ECORP_COVERAGE_ANVIL_EXIT_CODE),
    cache_directory: `${process.env.CARGO_TARGET_DIR}/anvil-cache`,
    scope: 'Local chain 84532 for base_worker_http_gateway_restart_and_finality; no public Base network.' },
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
{ rustc +1.98.1 --version; cargo +1.98.1 --version; cargo +1.98.1 llvm-cov --version; node --version; npm --version; anvil --version; } > "$reports/versions.txt"
{ sha256sum "$(command -v cargo-llvm-cov)" "$(command -v node)" "$(command -v anvil)"; } > "$reports/tool-hashes.txt"

cargo +1.98.1 llvm-cov test --workspace --locked --no-report 2>&1 | tee "$reports/unit-tests.log"
# In 0.9.1, --no-report already retains profiles and conflicts with --no-clean.
cargo +1.98.1 llvm-cov test -p crony-store --locked --no-report -- --ignored --test-threads=1 2>&1 | tee "$reports/store-sqlx-tests.log"
# This existing Tokio HTTP test migrates and bootstraps its own database. Create
# it in the same explicitly owned service; CREATE DATABASE refuses a collision.
psql --no-password --no-psqlrc --set=ON_ERROR_STOP=1 \
  --command 'CREATE DATABASE ecorp_coverage_base_audit WITH TEMPLATE template0;' > "$reports/base-audit-database.txt"
export ECORP_COVERAGE_BASE_AUDIT_DATABASE_CREATED=1
BASE_AUDIT_TEST_DATABASE_URL=$(node --input-type=module <<'NODE'
const database = new URL(process.env.DATABASE_URL)
database.pathname = '/ecorp_coverage_base_audit'
process.stdout.write(database.href)
NODE
)
export BASE_AUDIT_TEST_DATABASE_URL
# Keep the full worker/gateway acceptance in this measured SQLx lane and provide
# its independently owned native EVM. Refuse a pre-existing listener before launch.
node --input-type=module <<'NODE'
import net from 'node:net'
const listener = net.createServer()
await new Promise((resolve, reject) => {
  listener.once('error', reject)
  listener.listen({ host: '127.0.0.1', port: 18556, exclusive: true }, resolve)
})
await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
NODE
anvil_cache="$CARGO_TARGET_DIR/anvil-cache"
mkdir "$anvil_cache"
anvil --host 127.0.0.1 --port 18556 --chain-id 84532 --quiet \
  --cache-path "$anvil_cache" --max-persisted-states 10000 > "$reports/anvil.log" 2>&1 &
anvil_pid=$!
export ECORP_COVERAGE_ANVIL_STARTED=1
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
const deadline = Date.now() + 30_000
for (;;) {
  try {
    const result = await new Promise((resolve, reject) => {
      const request = http.request('http://127.0.0.1:18556', { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
        let body = ''
        response.on('data', chunk => { body += chunk; if (body.length > 4096) response.destroy(new Error('Oversized fixture readiness reply')) })
        response.on('error', reject)
        response.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
      })
      request.on('error', reject)
      request.setTimeout(1000, () => request.destroy(new Error('Fixture readiness timeout')))
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }))
    })
    assert.equal(result.result, '0x14a34')
    break
  } catch (error) {
    if (Date.now() >= deadline) throw error
    await delay(100)
  }
}
NODE
if ! jobs -pr | grep -Fxq "$anvil_pid"; then
  printf '%s\n' 'Owned Anvil exited before SQLx execution.' >&2
  exit 1
fi
export ECORP_COVERAGE_ANVIL_READY=1
# This native adversarial entrypoint rejects ordinary DATABASE_URL ownership:
# its separate driver supplies a nonce-qualified service and per-case schema.
cargo +1.98.1 llvm-cov test -p crony-server --locked --no-report -- --ignored --skip artifacts::tests::issue297_native_adversarial_fixture --test-threads=1 2>&1 | tee "$reports/server-sqlx-tests.log"
cargo +1.98.1 llvm-cov report --locked --json --output-path "$reports/native-summary.json" 2>&1 | tee "$reports/json-report.log"
cargo +1.98.1 llvm-cov report --locked --lcov --output-path "$reports/lcov.info" 2>&1 | tee "$reports/lcov-report.log"
cargo +1.98.1 llvm-cov report --locked --fail-under-lines "$line_floor" 2>&1 | tee "$reports/line-guard.log"
