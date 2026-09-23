import assert from 'node:assert/strict'
import { spawn, execFile as execFileCallback } from 'node:child_process'
import { openSync, closeSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import * as ownedStack from './owned_test_stack.mjs'

const executable = realpathSync(process.execPath)
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'windir', 'pathext', 'temp', 'tmp', 'psmodulepath'].includes(key.toLowerCase())))
const driver = readFileSync(new URL('./e2e_factory_budget_recovery.mjs', import.meta.url), 'utf8')
const first = driver.indexOf('async function start(name, program, args, extraEnv = {})')
const last = driver.indexOf('async function stopVerifiedChild', first)
assert.ok(first >= 0 && last > first, 'Review the actual start-function extraction when its boundary changes')
const start = new Function('context', `const {assert, path, openSync, closeSync, spawn, qa, attempt,
  env, children, identity, json, report, stopLaunchedChild} = context;
  ${driver.slice(first, last)}; return start`)

async function reap(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Exact test-child cleanup failed')), 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGKILL')
  })
}

for (const failure of ['identity exception', 'identity absence', 'foreign executable', 'receipt publication']) {
  test(`PR237 launch rollback: ${failure} reaps the real child before rejecting`, async t => {
    const root = await mkdtemp(path.join(realpathSync(os.tmpdir()), 'ecorp-budget-admission-'))
    const children = []
    let launched
    const peer = spawn(executable, ['-e', 'setTimeout(()=>{},45000)'], {
      cwd: root, env: environment, windowsHide: true, stdio: 'ignore',
    })
    await new Promise((resolve, reject) => { peer.once('spawn', resolve); peer.once('error', reject) })
    const context = { assert, path, openSync, closeSync, qa: root, attempt: root,
      env: environment, children, report: { cleanup: [] }, stopLaunchedChild: ownedStack.stopLaunchedChild,
      spawn: (...args) => { launched = spawn(...args); return launched },
      identity: async pid => {
        if (failure === 'identity exception') throw new Error('Synthetic identity lookup denied')
        if (failure === 'identity absence') return null
        return { pid, executable: failure === 'foreign executable' ? path.join(root, 'other.exe') : executable }
      },
      json: (file, value) => writeFile(file, JSON.stringify(value)),
    }
    if (failure === 'receipt publication') await mkdir(path.join(root, 'processes.json'))
    try {
      await assert.rejects(start(context)('inert', executable, ['-e', 'setTimeout(()=>{},45000)']))
      assert.ok(launched?.pid, 'The real operating-system child must have started')
      assert.ok(launched.exitCode !== null || launched.signalCode !== null,
        'Admission must confirm child exit before returning the failure')
      assert.equal(peer.exitCode, null, 'An unrelated child of the same executable must remain alive')
      assert.equal(peer.signalCode, null)
    } finally {
      // The test itself also reaps the broken baseline through retained handles.
      await reap(launched)
      await reap(peer)
      t.diagnostic(`Retained process-admission logs: ${root}`)
    }
  })
}

test('PR237 launch rollback: PowerShell record failure reaps or retains the exact process capability', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async t => {
  const { stdout } = await promisify(execFileCallback)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.join(import.meta.dirname, 'local_stack_admission.test.ps1'), '-NodePath', executable], {
    env: environment, windowsHide: true, timeout: 55000, maxBuffer: 1024 * 1024,
  }).catch(error => {
    if (typeof error.stdout === 'string' && error.stdout.includes('ECORP_ADMISSION_RESULT=')) return error
    throw error
  })
  const report = JSON.parse(stdout.split('ECORP_ADMISSION_RESULT=')[1])
  assert.equal(report.cleanup_verified, true, 'Every real fixture child must be reaped by the test')
  t.diagnostic(`Retained PowerShell admission logs: ${report.fixture}`)
  assert.equal(report.cases.length, 2)
  for (const result of report.cases) assert.equal(result.passed, true, result.error || result.name)
})
