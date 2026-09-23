import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('native Windows source preflight cannot fetch or follow object alternates or aliases', {
  skip: process.platform !== 'win32',
  timeout: 170_000,
}, () => {
  const result = spawnSync('pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./qa_multiplayer_object_sources.test.ps1', import.meta.url)),
  ], { encoding: 'utf8', timeout: 160_000, maxBuffer: 8 * 1024 * 1024 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const summary = result.stdout.split(/\r?\n/).filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line)).find(row => row.event === 'object-source-summary')
  assert.ok(summary, 'Native fixture summary is required')
  assert.equal(summary.cases, 25)
  assert.equal(summary.failed, 0)
})
