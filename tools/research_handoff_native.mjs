import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { adversarialExecutors, fixtureEntrypoints, runnerCases, serverAssertions, verifierCases } from './research_handoff_native_catalog.mjs'

const source = fileURLToPath(new URL('..', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hex = /^[a-f0-9]{64}$/
const runnerControls = ['native_assignment_provider_started', 'native_exact_byte_readback',
  'native_read_write_permissions', 'legitimate_retained_checkpoint']
const runnerRejections = ['native_materializer_rejection', 'no_adapter_entry', 'no_provider_start',
  'workspace_preserved', 'owned_sentinel_unchanged', 'no_dependency_writes']
const serverControls = ['real_signed_artifacts_read_verified', 'persisted_two_parent_selection',
  'native_resolver_exact_declared_bytes', 'recovered_provider_and_verifier_runs_distinct',
  'restored_control_resolves_identically']
const serverNonvacuity = ['exactly_one_persisted_dependency_receipt',
  'rejection_preserves_persisted_receipt', 'restored_replay_is_idempotent']
const environment = () => Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]))
const contains = (root, child) => {
  const relative = path.relative(root, child)
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true,
    timeout: 60_000, maxBuffer: 2 * 1024 * 1024, env: environment(), ...options })
  return { executable, args, status: result.status, signal: result.signal, stdout: result.stdout ?? '',
    stderr: result.stderr ?? '', error: result.error?.code ?? null }
}

function successful(result) {
  assert.equal(result.error, null, `Execution error: ${result.error}`)
  assert.equal(result.signal, null, `Unexpected signal: ${result.signal}`)
  assert.equal(result.status, 0, result.stderr || result.stdout || 'Nonzero native exit')
}

export async function sourceFingerprint(root = source) {
  const result = command('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'])
  successful(result)
  const names = [...new Set(result.stdout.split('\0').filter(Boolean))].sort()
  assert.ok(names.length > 0)
  const files = await Promise.all(names.map(async name => [name, sha(await readFile(path.join(root, name)))]))
  return sha(JSON.stringify(files))
}

function required(actual, expected) {
  assert.ok(Array.isArray(actual) && new Set(actual).size === actual.length)
  assert.ok(expected.every(item => actual.includes(item)), `Missing native assertions: ${expected.join(', ')}`)
}

export function validateFixtureResult(result, { case_id, nonce, lane }) {
  assert.equal(result.error, null, 'Setup error or timeout is not native evidence')
  assert.equal(result.signal, null)
  const markers = result.stdout.split(/\r?\n/).filter(line => line.startsWith('ISSUE297_NATIVE_FIXTURE:'))
  assert.equal(markers.length, 1, 'Require exactly one native receipt')
  assert.ok(markers[0].length < 8192)
  const receipt = JSON.parse(markers[0].slice('ISSUE297_NATIVE_FIXTURE:'.length).trim())
  assert.equal(receipt.schema_version, 1)
  assert.equal(receipt.case_id, case_id)
  assert.equal(receipt.nonce, nonce)
  assert.match(result.stdout, /(?:^|\r?\n)running 1 test(?:\r?\n|$)/)
  assert.ok(Object.values(fixtureEntrypoints).includes(fixtureEntrypoints[lane]))
  assert.ok(result.stdout.includes(fixtureEntrypoints[lane]), 'Native test identity absent')
  if (lane === 'runner') {
    assert.ok(runnerCases.includes(case_id))
    assert.equal(receipt.evidence_scope, verifierCases.includes(case_id) ? 'native-runner-verifier' : 'native-runner-assignment-materialization')
    required(receipt.positive_controls, runnerControls)
    assert.ok(typeof receipt.qualification === 'string' && receipt.qualification.length > 0)
    if (receipt.status === 'unqualified') {
      assert.notEqual(result.status, 0, 'Unqualified native cases must fail')
      assert.match(result.stdout, /test result: FAILED\. 0 passed; 1 failed; 0 ignored;/)
      return { status: 'unqualified', receipt }
    }
    if (verifierCases.includes(case_id)) {
      assert.equal(receipt.status, 'native_rejection_observed')
      required(receipt.positive_controls, ['native_verifier_unchanged_control', 'exact_6144_byte_note_control'])
      required(receipt.rejection_assertions, ['real_fake_process_fault', 'signed_download_not_claimed',
        'native_verifier_exact_check_rejected', 'four_native_verifier_assertions', 'provider_artifact_present'])
      assert.equal(receipt.observations.passed, false)
      assert.equal(receipt.observations.checks.length, 4)
      assert.equal(receipt.observations.checks[0].passed, true)
      assert.equal(receipt.observations.checks[case_id === 'missing-file' ? 1 : 3].passed, false)
    } else if (case_id === 'parent-tree-isolation') {
      assert.equal(receipt.status, 'native_rejection_observed')
      required(receipt.rejection_assertions, ['native_os_parent_read_denied', 'owned_sentinel_unchanged'])
      assert.equal(receipt.observations.parent.attempted, true)
      assert.equal(receipt.observations.parent.denied, true)
    } else {
      required(receipt.rejection_assertions, runnerRejections)
      assert.equal(receipt.status, case_id === 'exact-limit-control' ? 'native_control_observed' : 'native_rejection_observed')
      const controls = {
        'file-count-limit': ['exact_file_count_limit'],
        'wire-file-byte-limit': ['exact_utf8_file_byte_limit'],
        'aggregate-byte-limit': ['exact_file_count_limit', 'exact_file_byte_limit', 'exact_serialized_aggregate_limit'],
        'exact-limit-control': ['exact_file_count_limit', 'exact_file_byte_limit', 'exact_serialized_aggregate_limit'],
        'destination-symlink': ['same_destination_plain_file_control', 'native_destination_link_resolves_exact_target', 'relative_internal_symlink_checkpoint'],
        'destination-reparse': ['same_destination_plain_file_control', 'native_destination_link_resolves_exact_target', 'fresh_owned_worktree_base_and_head'],
      }
      required(receipt.positive_controls, controls[case_id])
      if (['aggregate-byte-limit', 'exact-limit-control'].includes(case_id)) {
        assert.deepEqual(receipt.observations, { file_count_limit: 8, file_byte_limit: 12288,
          aggregate_wire_limit: 65536, rejected_wire_bytes: 65537 })
      }
    }
  } else {
    assert.ok(Object.hasOwn(serverAssertions, case_id))
    assert.equal(receipt.evidence_scope, 'native-integrated-fixture')
    assert.equal(receipt.fixture_schema_removed, true)
    assert.equal(receipt.full_stack, false)
    assert.equal(receipt.provider_inference, false)
    required(receipt.positive_controls, serverControls)
    required(receipt.nonvacuity_controls, serverNonvacuity)
    required(receipt.native_rejection_assertions, serverAssertions[case_id])
  }
  successful(result)
  assert.match(result.stdout, /test result: ok\. 1 passed; 0 failed; 0 ignored;/)
  return { status: case_id === 'exact-limit-control' ? 'native_control_observed' : 'native_rejection_observed', receipt }
}

export function nativeCoverageResult(rows) {
  const expected = adversarialExecutors()
  assert.deepEqual(rows.map(row => row.case_id).sort(), expected.map(row => row.case_id).sort(),
    'Require the complete, unique 23-case ledger, not a subset')
  for (const row of rows) {
    const mapping = expected.find(item => item.case_id === row.case_id)
    assert.equal(row.lane, mapping.lane)
    assert.equal(row.evidence_scope, mapping.evidence_scope)
    assert.ok(['not_executed', 'failed', 'unqualified', 'native_rejection_observed', 'native_control_observed'].includes(row.status))
    if (row.status.startsWith('native_') || row.status === 'unqualified') {
      assert.notEqual(row.lane, 'owned-live-stack', 'Offline driver cannot credit live observations')
      const checked = validateFixtureResult(row.execution, row)
      assert.equal(checked.status, row.status)
      assert.ok(hex.test(row.binary_sha256 ?? '') && hex.test(row.source_sha256 ?? ''))
    }
  }
  const observed = rows.filter(row => row.status.startsWith('native_')).map(row => row.case_id)
  return { accepted: false, full_stack: false, browser: false, r4: false, owner_acceptance: false,
    native_observed: observed, incomplete_cases: rows.filter(row => !observed.includes(row.case_id)).map(row => row.case_id),
    reason: 'Offline fixtures do not satisfy live browser/full-stack/R4/owner acceptance.' }
}

async function plainAncestors(directory) {
  let current = path.resolve(directory)
  while (true) {
    const metadata = await lstat(current)
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Fixture parent must be a plain directory')
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

async function admit(manifest) {
  assert.equal(manifest.schema_version, 1)
  assert.equal(await realpath(manifest.source), await realpath(source), 'This checkout only')
  assert.equal(manifest.source_sha256, await sourceFingerprint())
  const head = command('git', ['-C', source, 'rev-parse', 'HEAD'])
  successful(head)
  assert.equal(head.stdout.trim(), manifest.head)
  for (const lane of ['runner', 'server']) {
    const binary = manifest[lane]
    assert.ok(hex.test(binary?.sha256 ?? ''))
    assert.equal(sha(await readFile(binary.path)), binary.sha256)
    assert.equal(sha(await readFile(binary.build_receipt)), binary.build_receipt_sha256)
    validateBuildReceipt((await readFile(binary.build_receipt, 'utf8')).trim().split(/\r?\n/).map(JSON.parse),
      { lane, binary: binary.path, root: source })
    const listing = command(binary.path, [fixtureEntrypoints[lane], '--exact', '--ignored', '--list'])
    successful(listing)
    assert.match(listing.stdout, /1 test, 0 benchmarks/)
    assert.ok(listing.stdout.includes(`${fixtureEntrypoints[lane]}: test`), 'No ignored native entrypoint in admitted binary')
  }
  for (const name of ['initdb', 'postgres', 'psql', 'pg_ctl']) {
    const binary = manifest.postgres[name]
    assert.equal(path.basename(binary.path).toLowerCase(), `${name}${process.platform === 'win32' ? '.exe' : ''}`)
    assert.ok(hex.test(binary.sha256))
    assert.equal(sha(await readFile(binary.path)), binary.sha256)
  }
}

export function validateBuildReceipt(records, { lane, binary, root }) {
  assert.ok(Object.hasOwn(fixtureEntrypoints, lane))
  const finishes = records.filter(record => record.reason === 'build-finished')
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].success, true)
  assert.ok(records.some(record => record.reason === 'compiler-artifact' &&
    record.target?.name === `crony-${lane}` && record.profile?.test === true &&
    record.executable && path.resolve(record.executable) === path.resolve(binary) &&
    path.resolve(record.manifest_path) === path.join(path.resolve(root), 'crates', `crony-${lane}`, 'Cargo.toml')),
  'Require a successful cargo test-artifact build receipt for this checkout')
}

async function freshPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  assert.ok(port >= 49152, 'Require an ephemeral high port; never substitute a known service port')
  assert.ok(![55483, 8791, 5187].includes(port), 'Retained stack ports are forbidden')
  return port
}

export async function runNativeFixtures(manifest, output) {
  output = path.resolve(output)
  await plainAncestors(path.dirname(output))
  assert.ok(!contains(await realpath(source), output) && !contains(output, await realpath(source)),
    'Native evidence must not overlap this checkout')
  await mkdir(output) // Never adopt or overwrite an earlier result directory.
  const rows = adversarialExecutors().map(mapping => ({ ...mapping, status: 'not_executed' }))
  const report = { schema_version: 1, accepted: false, manifest, rows, commands: [], failures: [] }
  const save = () => writeFile(path.join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
  const execute = async (label, executable, args, options) => {
    const result = command(executable, args, { cwd: output, ...options })
    await writeFile(path.join(output, `${label}.stdout.log`), result.stdout, { flag: 'wx' })
    await writeFile(path.join(output, `${label}.stderr.log`), result.stderr, { flag: 'wx' })
    report.commands.push({ label, ...result })
    await save()
    return result
  }
  const fixtureEnvironment = { ...environment(), TEMP: output, TMP: output }
  let postgres
  let postgresError
  let postgresExited = false
  let postgresExit
  let databaseOwned = false
  let pgOutput
  let pgErrors
  const data = path.join(output, 'postgres-data')
  const ownPid = async () => {
    const pid = Number((await readFile(path.join(data, 'postmaster.pid'), 'utf8')).split(/\r?\n/)[0])
    assert.equal(pid, postgres.pid, 'Refuse a postmaster not spawned by this driver')
  }
  try {
    await admit(manifest)
    await save()
    const nonce = randomUUID()
    const database = `ecorp_issue297_${nonce.replaceAll('-', '')}`
    const port = await freshPort()
    Object.assign(report, { nonce, port, database })
    successful(await execute('initdb', manifest.postgres.initdb.path,
      ['-D', data, '-U', 'fixture', '--auth=trust', '--encoding=UTF8', '--no-locale', '--no-sync'],
      { env: fixtureEnvironment }))
    pgOutput = createWriteStream(path.join(output, 'postgres.stdout.log'), { flags: 'wx' })
    pgErrors = createWriteStream(path.join(output, 'postgres.stderr.log'), { flags: 'wx' })
    postgres = spawn(manifest.postgres.postgres.path, ['-D', data, '-p', String(port), '-h', '127.0.0.1'],
      { cwd: output, env: fixtureEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    postgres.stdout.pipe(pgOutput)
    postgres.stderr.pipe(pgErrors)
    postgres.once('error', error => { postgresError = error })
    postgresExit = new Promise(resolve => postgres.once('exit', (code, signal) => {
      postgresExited = true
      report.postgres_exit = { code, signal }
      resolve()
    }))
    const psql = async (label, db, sql) => execute(label, manifest.postgres.psql.path,
      ['-X', '-w', '-h', '127.0.0.1', '-p', String(port), '-U', 'fixture', '-d', db,
        '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { timeout: 5000, env: fixtureEnvironment })
    let ready = false
    for (let attempt = 0; attempt < 20; attempt++) {
      assert.ok(!postgresError && !postgresExited, 'Owned PostgreSQL exited during startup')
      // The owned pidfile must exist before any database query is issued.
      try { await ownPid() } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await new Promise(resolve => setTimeout(resolve, 250))
        continue
      }
      const result = await psql(`ready-${attempt}`, 'postgres', "SELECT current_setting('data_directory')")
      if (result.status === 0 && !result.error) {
        assert.equal(await realpath(result.stdout.trim()), await realpath(data), 'Wrong database process')
        ready = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(ready, 'Owned PostgreSQL startup timeout')
    databaseOwned = true
    report.postgres_pid = postgres.pid
    successful(await psql('create-database', 'postgres', `CREATE DATABASE ${database} OWNER fixture`))
    successful(await psql('mark-database', 'postgres', `COMMENT ON DATABASE ${database} IS 'ecorp-issue297:${nonce}'`))
    for (const row of rows.filter(row => row.lane !== 'owned-live-stack')) {
      const caseNonce = row.lane === 'server' ? nonce : randomUUID()
      try {
        assert.equal(await sourceFingerprint(), manifest.source_sha256, 'Source changed after build admission')
        const binary = manifest[row.lane]
        assert.equal(sha(await readFile(binary.path)), binary.sha256, 'Native binary changed')
        if (row.lane === 'server') {
          assert.ok(databaseOwned && !postgresExited)
          await ownPid()
        }
        const env = { ...fixtureEnvironment, ECORP_ISSUE297_NATIVE_CASE: row.case_id,
          ECORP_ISSUE297_FIXTURE_NONCE: caseNonce,
          ...(row.lane === 'server' ? {
            ECORP_ISSUE297_FIXTURE_DATABASE_OWNED: nonce,
            ECORP_ISSUE297_FIXTURE_DATABASE_URL: `postgres://fixture@127.0.0.1:${port}/${database}`,
          } : { ECORP_ISSUE297_FIXTURE_ROOT: path.join(output, caseNonce) }) }
        const execution = await execute(row.case_id, binary.path,
          [row.executor, '--exact', '--ignored', '--nocapture', '--test-threads=1'], { env, timeout: 120_000 })
        Object.assign(row, { nonce: caseNonce, execution, binary_sha256: binary.sha256,
          source_sha256: manifest.source_sha256 })
        Object.assign(row, validateFixtureResult(execution, row))
        if (row.status === 'unqualified') report.failures.push({ case_id: row.case_id, error: row.receipt.qualification })
      } catch (error) {
        row.status = 'failed'
        row.error = error.stack
        report.failures.push({ case_id: row.case_id, error: error.stack })
      }
      await save()
    }
    assert.equal(await sourceFingerprint(), manifest.source_sha256, 'Source drift during execution')
  } catch (error) {
    report.failures.push({ phase: 'setup-or-admission', error: error.stack })
  } finally {
    if (postgres?.pid && !postgresExited) {
      try {
        await ownPid()
        successful(await execute('stop-owned-postgres', manifest.postgres.pg_ctl.path,
          ['-D', data, '-m', 'fast', '-w', '-t', '20', 'stop'], { env: fixtureEnvironment, timeout: 25_000 }))
        await Promise.race([postgresExit, new Promise((_, reject) => setTimeout(() => reject(new Error('Owned PostgreSQL exit timeout')), 5000).unref())])
      } catch (error) {
        report.failures.push({ phase: 'owned-postgres-cleanup', pid: postgres.pid, error: error.stack })
        postgres.kill() // Exact child only; never terminate another stack by process name.
      }
    }
    pgOutput?.end()
    pgErrors?.end()
    report.coverage = nativeCoverageResult(rows)
    report.accepted = false
    await save()
  }
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 4, 'Usage: node tools/research_handoff_native.mjs <admitted-manifest.json> <new-evidence-directory>')
    const report = await runNativeFixtures(JSON.parse(await readFile(process.argv[2], 'utf8')), process.argv[3])
    console.log(JSON.stringify({ accepted: false, ...report.coverage, failures: report.failures }))
    process.exitCode = 1 // Even complete offline native coverage is never live acceptance.
  } catch (error) {
    console.error(JSON.stringify({ accepted: false, phase: 'refused', error: error.message }))
    process.exitCode = 1
  }
}
