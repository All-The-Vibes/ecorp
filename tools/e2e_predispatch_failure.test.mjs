import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'

test('predispatch ownership uses the native receipt contract', { skip: process.platform !== 'win32' }, async t => {
  const root = 'C:\\predispatch-fixture'
  const binary = `${root}\\crony-server.exe`
  const server = 'http://127.0.0.1:18965'
  const native = { platform: 'win32', pid: 4242, executable: binary,
    creation: '2026-09-06T22:00:00.0000003Z', native_creation_ticks: '639243288000000003',
    port_owned: true }
  const manifest = { test_owned: true, workspace: root, server_url: server, server: native.pid,
    server_creation: native.creation, server_identity: native }
  let observed = native
  let probes = 0
  let bounds = 0
  const probe = async (program, args, options) => {
    probes++
    assert.ok(['pwsh.exe', 'powershell.exe'].includes(program))
    assert.equal(options.env.ECORP_QA_PROCESS_ID, String(manifest.server))
    assert.equal(options.env.ECORP_QA_PROCESS_PORT, '18965')
    const script = args.at(-1)
    assert.doesNotMatch(script, /Stop-Process|\.Kill\(|taskkill/iu)
    if (script.includes('Get-CimInstance')) {
      // The buggy caller's real output shape, not a fabricated native receipt.
      return JSON.stringify({ executable: observed.executable,
        creation: observed.creation.slice(0, -2) + 'Z', port_owned: observed.port_owned })
    }
    assert.match(script, /Get-Process -Id/u)
    assert.match(script, /\$process\.Handle/u)
    assert.match(script, /StartTime\.ToUniversalTime\(\)/u)
    assert.match(script, /native_creation_ticks=\$creation\.Ticks\.ToString\(\)/u)
    assert.match(script, /platform='win32'; pid=\$processId/u)
    return JSON.stringify(observed)
  }
  // Stub the process boundary before loading the real helper. No shell, socket,
  // process discovery/termination, database, or driver entry point can execute.
  const fakeExec = () => { throw new Error('Unexpected callback process execution') }
  fakeExec[promisify.custom] = async (...args) => ({ stdout: await probe(...args), stderr: '' })
  t.mock.method(childProcess.ChildProcess.prototype, 'spawn', () => {
    throw new Error('Native process execution is forbidden in this regression')
  })
  const originalExec = childProcess.execFile
  childProcess.execFile = fakeExec
  syncBuiltinESMExports()
  try {
    const helpers = await import('./owned_test_stack.mjs')
    const source = readFileSync(new URL('./e2e_predispatch_failure.mjs', import.meta.url), 'utf8')
    const imports = source.match(/import \{ ([^}]+) \} from '\.\/owned_test_stack\.mjs'/u)
    assert.ok(imports)
    const bindings = Object.fromEntries(imports[1].split(',').map(name => {
      name = name.trim()
      assert.equal(typeof helpers[name], 'function', `Missing actual helper export: ${name}`)
      return [name, helpers[name]]
    }))
    // Execute the actual caller body only; importing this driver runs its E2E.
    const body = source.match(/async function processOwnership\(\) \{[\s\S]*?\r?\n\}(?=\r?\nfunction connectedSource)/u)
    assert.ok(body)
    const ownership = runInNewContext(`(${body[0]})`, {
      ...bindings, assert, path, root, binary, server, endpoint: new URL(server),
      process: { env: {} }, command: (...args) => { bounds++; return probe(...args) },
      bounded: () => { bounds++ },
      required: name => { assert.equal(name, 'CRONY_TEST_SERVER_PID_FILE'); return 'fixture.json' },
      stat: async file => { assert.equal(file, 'fixture.json'); return { size: 1024 } },
      readFile: async file => { assert.equal(file, 'fixture.json'); return JSON.stringify(manifest) },
    })
    await t.test('matching native receipt passes the actual caller', async () => {
      await assert.doesNotReject(ownership())
    })
    for (const [label, changed] of [
      ['one native tick changed', { native_creation_ticks: '639243288000000004' }],
      ['native ticks missing', { native_creation_ticks: undefined }],
      ['native ticks rounded to number', { native_creation_ticks: Number(native.native_creation_ticks) }],
      ['PID changed', { pid: 4243 }],
      ['PID missing', { pid: undefined }],
      ['platform changed', { platform: 'linux' }],
      ['platform missing', { platform: undefined }],
      ['executable changed', { executable: `${root}\\other.exe` }],
      ['listener not owned', { port_owned: false }],
    ]) {
      await t.test(label + ' is denied', async () => {
        observed = { ...native, ...changed }
        await assert.rejects(ownership(), /ownership changed or is unverifiable; refusing/u)
      })
    }
    assert.equal(probes, 10)
    assert.equal(bounds, 10)
  } finally {
    childProcess.execFile = originalExec
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})
