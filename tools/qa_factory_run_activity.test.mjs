import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

test('Factory activity acceptance rejects redirected QA roots before effects', {
  skip: process.platform !== 'win32' ? 'Requires native Windows path semantics and PowerShell 7.4+' : false,
}, async (t) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|PSModulePath|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)$/iu.test(name)))
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(import.meta.dirname, 'qa_factory_run_activity.test.ps1')], {
    env, encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 1024 * 1024,
  })
  assert.ifError(result.error)
  const prefix = 'ECORP_ACTIVITY_PATH_RESULT='
  const reports = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith(prefix))
  assert.equal(reports.length, 1, `Expected the native admission receipt; exit=${result.status}; ${result.stderr}`)
  const report = JSON.parse(reports[0].slice(prefix.length))
  assert.equal(report.cases.length, 23)
  assert.equal(report.services_started, 0)
  for (const entry of report.cases) await t.test(entry.name, () => assert.equal(entry.passed, true, entry.error))
  t.diagnostic(JSON.stringify({ fixture: report.fixture, fixture_removed: report.fixture_removed, scope: report.scope }))
  assert.equal(report.fixture_removed, true)
  assert.equal(result.status, 0)
})
