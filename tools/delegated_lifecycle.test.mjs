import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

test('delegated fixture cleanup retains exact process ownership through stop', {
  skip: process.platform !== 'win32' ? 'Requires Windows and PowerShell 7.4+' : false,
}, async t => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|PSModulePath|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)$/iu.test(name)))
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(import.meta.dirname, 'delegated_lifecycle.test.ps1'), '-NodePath', process.execPath], {
    env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
  })
  assert.ifError(result.error)
  const prefix = 'ECORP_DELEGATED_LIFECYCLE_RESULT='
  const reports = result.stdout.split(/\r?\n/u).filter(line => line.startsWith(prefix))
  assert.equal(reports.length, 1, `Expected one fixture report; exit=${result.status}`)
  const report = JSON.parse(reports[0].slice(prefix.length))
  assert.equal(report.cases.length, 7)
  assert.ok(report.created_processes >= 4)
  for (const entry of report.cases) {
    await t.test(entry.name, () => assert.equal(entry.passed, true, entry.error))
  }
  assert.equal(result.status, 0)
})
