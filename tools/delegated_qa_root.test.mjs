import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

test('delegated QA paths and PostgreSQL stop preserve physical ownership', {
  skip: process.platform !== 'win32' ? 'Requires native Windows path and process APIs' : false,
}, async t => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|PSModulePath|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)$/iu.test(name)))
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(import.meta.dirname, 'delegated_qa_root.test.ps1'), '-NodePath', process.execPath], {
    env, encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 1024 * 1024,
  })
  assert.ifError(result.error)
  const prefix = 'ECORP_DELEGATED_QA_ROOT_RESULT='
  const reports = result.stdout.split(/\r?\n/u).filter(line => line.startsWith(prefix))
  assert.equal(reports.length, 1, `Expected one fixture report; exit=${result.status}; ${result.stderr}`)
  const report = JSON.parse(reports[0].slice(prefix.length))
  assert.equal(report.cases.length, 21)
  assert.equal(report.subst_exercised, true)
  assert.equal(report.subst_removed, true)
  for (const entry of report.cases) {
    await t.test(entry.name, { skip: entry.skip || false }, () => assert.equal(entry.passed, true, entry.error))
  }
  assert.equal(result.status, 0)
})
