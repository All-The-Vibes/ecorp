import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { assertOwnedRestart, assertTestEndpoint, ownedServerEnvironment, restartOwnedTestServer, startOwnedTestServer, stopOwnedTestServer } from './owned_test_stack.mjs'

// Pure fixtures: no process discovery, signals, services, or filesystem mutation.
const root = 'C:\\fixture-root'
const binary = `${root}\\crony-server.exe`
const server = 'http://127.0.0.1:18965'
const manifest = {
  test_owned: true, workspace: root, server_url: server, server: 4242,
  server_creation: '2026-09-06T22:00:00.000Z',
}
const identity = { platform: 'win32', pid: manifest.server, executable: binary, creation: manifest.server_creation, port_owned: true }
const context = { root, server, binary, platform: 'win32' }

test('database query options are refused before filesystem or lifecycle effects', async t => {
  const folder = path.resolve(os.tmpdir(), 'ecorp-owned-query-fixture')
  const settings = { root: folder, server, binary: process.execPath,
    manifestPath: path.join(folder, 'server.json') }
  const refusal = 'PostgreSQL test database query options are not supported; refusing lifecycle operation.'
  // Block the first lifecycle write even on the unfixed helper: no real files,
  // process discovery, signals, sockets, or child launches can be reached.
  const resolved = t.mock.method(fs, 'realpathSync', value => value)
  const opened = t.mock.method(fs, 'openSync', () => { throw new Error('fixture lifecycle boundary reached') })
  syncBuiltinESMExports()
  try {
    for (const operation of [startOwnedTestServer, restartOwnedTestServer, stopOwnedTestServer]) {
      for (const query of [
        'host=other.invalid', 'hostaddr=127.0.0.2', 'port=55472', 'dbname=other', 'user=other',
        'port=55472&dbname=other', 'host=%2Ffixture-socket', 'unknown=private-query-canary',
        '%68ost=other.invalid', 'HOST=other.invalid', 'HostAddr=127.0.0.2', 'DBNAME=other',
        'port=55471&port=55472', 'sslmode=require', 'options=-csearch_path%3Dother',
        'password=private-query-canary', 'host', '&&', '%',
      ]) {
        // Test names and refusal diagnostics never contain a supplied URL/value.
        await t.test(`${operation.name} rejects query case ${query.split('=')[0]}`, async () => {
          resolved.mock.resetCalls()
          opened.mock.resetCalls()
          await assert.rejects(operation({ ...settings,
            databaseUrl: `postgres://fixture:private-password-canary@127.0.0.1:55471/fixture?${query}`,
          }), error => error.message === refusal)
          assert.equal(resolved.mock.callCount(), 0)
          assert.equal(opened.mock.callCount(), 0)
        })
      }
      for (const suffix of ['', '?']) {
        await t.test(`${operation.name} allows URL without query options (${suffix.length})`, async () => {
          opened.mock.resetCalls()
          await assert.rejects(operation({ ...settings,
            databaseUrl: `postgresql://fixture:private-password-canary@127.0.0.1:55471/fixture${suffix}`,
          }), /fixture lifecycle boundary reached/u)
          assert.equal(opened.mock.callCount(), 1)
        })
      }
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('upstream restart environment remains bounded and cannot override database authority', () => {
  const inherited = { PATH: 'fixture', DATABASE_URL: 'old-private-value' }
  const changed = ownedServerEnvironment({ CRONY_ARTIFACT_RECOVERY_GRACE_SECS: '0',
    CRONY_ARTIFACT_RECOVERY_INTERVAL_SECS: '1' }, 'new-private-value', inherited)
  assert.deepEqual(changed, { PATH: 'fixture', DATABASE_URL: 'new-private-value',
    CRONY_ARTIFACT_RECOVERY_GRACE_SECS: '0', CRONY_ARTIFACT_RECOVERY_INTERVAL_SECS: '1' })
  assert.equal(inherited.DATABASE_URL, 'old-private-value')
  for (const environment of [null, [], { DATABASE_URL: 'canary' }, { NODE_OPTIONS: '--require=canary' },
    { CRONY_ARTIFACT_RECOVERY_INTERVAL_SECS: '0' }, { CRONY_ARTIFACT_RECOVERY_GRACE_SECS: '3601' },
    { CRONY_ARTIFACT_RECOVERY_INTERVAL_SECS: 1 }, { CRONY_ARTIFACT_RECOVERY_GRACE_SECS: '-1' },
    { CRONY_ARTIFACT_RECOVERY_GRACE_SECS: '00' }, { CRONY_ARTIFACT_RECOVERY_GRACE_SECS: '1.5' }]) {
    assert.throws(() => ownedServerEnvironment(environment, 'private-value'), /refusing/u)
  }
})

test('owned server requires matching executable, creation, endpoint, and workspace', () => {
  assert.doesNotThrow(() => assertOwnedRestart(manifest, identity, context))
  for (const changed of [
    { ...identity, executable: `${root}\\other-server.exe` },
    { ...identity, creation: '2026-09-06T22:00:01.000Z' },
    { ...identity, creation: 'invalid' },
    { ...identity, port_owned: false },
    { ...identity, port_owned: 'true' },
    { ...identity, port: 18966 },
    { ...identity, pid: 4243 },
  ]) {
    assert.throws(() => assertOwnedRestart(manifest, changed, context), /refusing/u)
  }
})

test('manual, remote, stale, or non-owned manifests never authorize restart', () => {
  for (const changed of [
    { ...manifest, test_owned: false },
    { ...manifest, server: 0 },
    { ...manifest, server_creation: null },
    { ...manifest, workspace: 'C:\\other-workspace' },
    { ...manifest, server_url: 'http://127.0.0.1:8791' },
  ]) {
    assert.throws(() => assertOwnedRestart(changed, identity, context), /refusing/u)
  }
  for (const endpoint of ['http://127.0.0.1:8791', 'http://example.com:18965']) {
    assert.throws(
      () => assertOwnedRestart({ ...manifest, server_url: endpoint }, identity, { ...context, server: endpoint }),
      /refusing/u,
    )
  }
})

test('Windows native receipts preserve sub-millisecond creation identity without numeric rounding', () => {
  // CIM truncates the seventh fractional digit, while Date.parse discards four.
  // Neither representation is an exact Windows process creation identity.
  const precise = { ...identity, creation: '2026-09-06T22:00:00.0000003Z',
    native_creation_ticks: '639243288000000003' }
  const record = { ...manifest, server_creation: precise.creation, server_identity: precise }
  assert.doesNotThrow(() => assertOwnedRestart(record, precise, context))
  for (const ticks of ['639243288000000004', undefined, null, '', 'invalid',
    639243288000000003, '0639243288000000003', '3155378976000000000']) {
    assert.throws(() => assertOwnedRestart(record, { ...precise, native_creation_ticks: ticks }, context), /refusing/u)
    assert.throws(() => assertOwnedRestart({ ...record,
      server_identity: { ...precise, native_creation_ticks: ticks } }, precise, context), /refusing/u)
  }
  // Legacy ISO-only manifests retain their existing admission rules. A new
  // native receipt must never silently downgrade to that compatibility path.
  assert.doesNotThrow(() => assertOwnedRestart(manifest, precise, context))
  assert.throws(() => assertOwnedRestart({ ...record, server_identity: {} }, precise, context), /refusing/u)
})

test('owned endpoints reject every reserved/manual port and non-origin URL', () => {
  for (const address of [
    ...[5432, 54329, 8791, 8793, 5187, 5291, 15191, 15193].map(port => `http://127.0.0.1:${port}`),
    'https://127.0.0.1:18965', 'http://example.com:18965', 'http://user:secret@127.0.0.1:18965',
    'http://127.0.0.1:18965/path', 'http://127.0.0.1:18965/?query', 'http://127.0.0.1:18965/#fragment',
    'http://127.0.0.1',
  ]) assert.throws(() => assertTestEndpoint(address), /refusing/u)
})

test('Linux receipts require exact kernel identity and case-sensitive executable paths', () => {
  const linux = { platform: 'linux', pid: 4242, executable: '/fixture/server', cwd: '/fixture', uid: 1000,
    creation: manifest.server_creation, port_owned: true, start_ticks: '100001',
    boot_id: '00000000-0000-4000-8000-000000000001', network_namespace: 'net:[12345]' }
  const record = { ...manifest, workspace: '/fixture', server_state: 'running', server_identity: linux }
  const settings = { root: '/fixture', server, binary: '/fixture/server', platform: 'linux' }
  assert.doesNotThrow(() => assertOwnedRestart(record, linux, settings))
  for (const changed of [
    { ...linux, executable: '/fixture/SERVER' }, { ...linux, cwd: '/other' }, { ...linux, pid: 4243 },
    { ...linux, boot_id: '00000000-0000-4000-8000-000000000002' }, { ...linux, start_ticks: '100002' },
    { ...linux, uid: 1001 }, { ...linux, network_namespace: 'net:[12346]' }, { ...linux, port_owned: false },
  ]) assert.throws(() => assertOwnedRestart(record, changed, settings), /refusing/u)
  for (const changed of [
    { ...record, server_identity: undefined }, { ...record, server_state: 'starting' },
    { ...record, server_state: 'stopped' }, { ...record, test_owned: false },
  ]) assert.throws(() => assertOwnedRestart(changed, linux, settings), /refusing/u)
})

test('legacy PID files and pre-existing locks are preserved without signalling or starting a process', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'ecorp-owned-test-'))
  const manifestPath = path.join(folder, 'server.json')
  const settings = { root: folder, server, binary: process.execPath, manifestPath,
    databaseUrl: 'postgres://fixture:sentinel@127.0.0.1:55471/fixture' }
  try {
    writeFileSync(manifestPath, '4242\n')
    await assert.rejects(restartOwnedTestServer(settings), /refusing/u)
    assert.equal(readFileSync(manifestPath, 'utf8'), '4242\n')
    writeFileSync(manifestPath + '.lock', 'owned-by-another-operation')
    await assert.rejects(restartOwnedTestServer(settings), /EEXIST/u)
    assert.equal(readFileSync(manifestPath + '.lock', 'utf8'), 'owned-by-another-operation')
    await assert.rejects(startOwnedTestServer({ ...settings, manifestPath: path.join(folder, 'other.json'),
      server: 'http://127.0.0.1:8791' }), /refusing/u)
    assert.equal(existsSync(path.join(folder, 'other.json')), false)
  } finally {
    assert.equal(path.dirname(realpathSync(folder)), realpathSync(os.tmpdir()))
    assert.match(path.basename(folder), /^ecorp-owned-test-[a-zA-Z0-9]+$/u)
    rmSync(folder, { recursive: true })
  }
})

for (const operation of ['start', 'restart']) {
  for (const phase of ['identity', 'starting-publication', 'running-publication', 'rollback-publication']) {
    test(`native ${operation} retains diagnostics and stops its child after ${phase} failure`, {
      skip: process.env.ECORP_OWNED_PROCESS_TEST !== '1' || !['linux', 'win32'].includes(process.platform),
      timeout: 120_000,
    }, async t => {
      const folder = mkdtempSync(path.join(os.tmpdir(), 'ecorp-owned-test-'))
      const manifestPath = path.join(folder, 'server.json')
      const probe = net.createServer()
      await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
      const endpoint = `http://127.0.0.1:${probe.address().port}`
      await new Promise(resolve => probe.close(resolve))
      const settings = { root: folder, server: endpoint, binary: process.execPath, manifestPath,
        args: [path.join(import.meta.dirname, 'fixtures', 'owned_test_server.mjs')],
        databaseUrl: 'postgres://fixture:private-diagnostic-canary@127.0.0.1:55471/fixture',
        minimumRunners: 0 }
      let launched, unref, injected = 0
      const originalSpawn = childProcess.spawn
      const originalParse = JSON.parse
      const originalWrite = fs.writeFileSync
      try {
        if (operation === 'restart') await startOwnedTestServer(settings)
        t.mock.method(childProcess, 'spawn', (...args) => {
          launched = originalSpawn(...args)
          unref = t.mock.method(launched, 'unref')
          return launched
        })
        t.mock.method(JSON, 'parse', (...args) => {
          const parsed = originalParse(...args)
          if (phase === 'identity' && !injected && launched?.pid &&
            parsed?.pid === launched.pid && Object.hasOwn(parsed, 'port_owned')) {
            injected++
            throw new Error('Injected identity capture failure')
          }
          return parsed
        })
        t.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
          if (typeof file === 'string' && (file === manifestPath || file.startsWith(`${manifestPath}.next-`))) {
            const parsed = originalParse(data)
            if (launched?.pid && parsed.server === launched.pid && (
              (!injected && phase === 'starting-publication' && parsed.server_state === 'starting') ||
              (!injected && ['running-publication', 'rollback-publication'].includes(phase) && parsed.server_state === 'running') ||
              (phase === 'rollback-publication' && parsed.server_state === 'stopped' && parsed.launch_failed === true))) {
              injected++
              throw new Error('Injected manifest publication failure')
            }
          }
          return originalWrite(file, data, ...args)
        })
        syncBuiltinESMExports()
        const action = operation === 'start' ? startOwnedTestServer : restartOwnedTestServer
        await assert.rejects(action(settings), phase === 'rollback-publication' ? /incomplete cleanup or publication/u : /Injected/u)
        assert.equal(injected, phase === 'rollback-publication' ? 2 : 1)
        assert.ok(launched?.pid, 'failure happened after a real native child started')
        assert.ok(launched.exitCode !== null || launched.signalCode !== null, 'the exact child has exited before failure returns')
        assert.equal(unref.mock.callCount(), 0, 'a failed admission never releases the child reference')
        await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(Number(new URL(endpoint).port), '127.0.0.1', resolve) })
        await new Promise(resolve => probe.close(resolve))
        const entries = fs.readdirSync(folder).filter(name => name.startsWith('server.json.launch-'))
          .flatMap(name => readFileSync(path.join(folder, name), 'utf8').trim().split('\n').map(line => originalParse(line)))
        const last = entries.find(entry => entry.state === 'failed_stopped' && entry.observed_child_pid === launched.pid)
        assert.ok(last, 'failure and confirmed cleanup are retained even when the main receipt cannot be published')
        assert.equal(last.manifest_update_failed, phase === 'rollback-publication')
        assert.ok(entries.every(entry => entry.lifecycle_authority === false && entry.test_owned !== true))
        assert.equal(JSON.stringify(entries).includes('private-diagnostic-canary'), false)
        if (existsSync(manifestPath)) {
          const saved = originalParse(readFileSync(manifestPath, 'utf8'))
          assert.equal(saved.server_state, phase === 'rollback-publication' ? 'starting' : 'stopped')
          if (saved.server_state === 'stopped') assert.equal(await stopOwnedTestServer(settings), false)
          else await assert.rejects(stopOwnedTestServer(settings))
        }
        assert.equal(existsSync(`${manifestPath}.lock`), false)
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()
        if (probe.listening) await new Promise(resolve => probe.close(resolve))
        if (launched?.pid && launched.exitCode === null && launched.signalCode === null) {
          // The regression also cleans up the intentionally broken baseline by
          // retaining the real ChildProcess. Never signal a parsed numeric PID.
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Test child cleanup did not finish')), 15_000)
            launched.once('exit', () => { clearTimeout(timer); resolve() })
            launched.kill('SIGKILL')
          })
        }
        if (!launched && existsSync(manifestPath)) {
          try { await stopOwnedTestServer(settings) } catch { t.diagnostic('Preserved unverifiable fixture ' + folder) }
        }
        // Failure receipts and child logs remain available after native tests.
        t.diagnostic('Retained owned launch failure fixture ' + folder)
      }
    })
  }
}

test('native owned child startup, two restarts, refusal of database drift and idempotent stop', {
  skip: process.env.ECORP_OWNED_PROCESS_TEST !== '1' || !['linux', 'win32'].includes(process.platform),
  timeout: 240_000,
}, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'ecorp-owned-test-'))
  const manifestPath = path.join(folder, 'server.json')
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${listener.address().port}`
  const settings = { root: folder, server: endpoint, binary: process.execPath, manifestPath,
    args: [path.join(import.meta.dirname, 'fixtures', 'owned_test_server.mjs')],
    databaseUrl: 'postgres://fixture:sentinel@127.0.0.1:55471/fixture' }
  let stopped = false
  try {
    // A pre-existing listener is never adopted or killed, even on an allowed port.
    await assert.rejects(startOwnedTestServer(settings), /EADDRINUSE/u)
    assert.equal(existsSync(manifestPath), false)
    assert.equal(listener.listening, true)
    await new Promise(resolve => listener.close(resolve))
    const first = await startOwnedTestServer(settings)
    const initial = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(initial.server, first)
    assert.equal(initial.server_state, 'running')
    assert.equal(initial.test_owned, true)
    assert.equal(initial.server_identity.port_owned, true)
    if (process.platform === 'win32') {
      assert.match(initial.server_identity.native_creation_ticks, /^[1-9][0-9]{0,18}$/u)
      const changed = { ...initial, server_identity: { ...initial.server_identity,
        native_creation_ticks: (BigInt(initial.server_identity.native_creation_ticks) + 1n).toString() } }
      writeFileSync(manifestPath, JSON.stringify(changed))
      await assert.rejects(restartOwnedTestServer(settings), /refusing/u)
      await assert.rejects(stopOwnedTestServer(settings), /refusing/u)
      assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), changed)
      assert.equal((await fetch(`${endpoint}/health`, {
        redirect: 'error', signal: AbortSignal.timeout(3000),
      })).ok, true)
      writeFileSync(manifestPath, JSON.stringify(initial))
    }
    assert.equal(readFileSync(manifestPath, 'utf8').includes('sentinel'), false)
    await assert.rejects(startOwnedTestServer(settings), /already exists/u)
    await assert.rejects(restartOwnedTestServer({ ...settings,
      databaseUrl: 'postgres://fixture:sentinel@127.0.0.1:55472/other' }), /database target changed/u)
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), initial)
    const second = await restartOwnedTestServer(settings)
    const third = await restartOwnedTestServer(settings)
    assert.notEqual(first, second)
    assert.notEqual(second, third)
    const current = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(current.previous_server_pid, second)
    assert.equal(current.server, third)
    assert.equal(current.server_state, 'running')
    assert.equal(current.server_identity.port_owned, true)
    assert.equal(await stopOwnedTestServer(settings), true)
    stopped = true
    assert.equal(await stopOwnedTestServer(settings), false)
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).server_state, 'stopped')
  } finally {
    if (listener.listening) await new Promise(resolve => listener.close(resolve))
    if (!stopped && existsSync(manifestPath)) {
      try { stopped = await stopOwnedTestServer(settings) } catch {
        t.diagnostic('Unverifiable test process/receipt preserved at ' + folder)
      }
    }
    if (stopped || !existsSync(manifestPath)) {
      assert.equal(path.dirname(realpathSync(folder)), realpathSync(os.tmpdir()))
      assert.match(path.basename(folder), /^ecorp-owned-test-[a-zA-Z0-9]+$/u)
      rmSync(folder, { recursive: true })
    }
  }
})
