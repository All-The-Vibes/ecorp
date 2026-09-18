import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Detector verification, never a real credential or provider call.
const binary = process.argv[2]
if (!binary || !path.isAbsolute(binary) || process.argv.length !== 3) throw new Error('Supply one absolute Gitleaks executable path')
const config = fileURLToPath(new URL('../.gitleaks.toml', import.meta.url))
const fixture = mkdtempSync(path.join(tmpdir(), 'ecorp-secret-canary-'))
const canary = ['gh', 'p_', randomBytes(27).toString('base64url').replaceAll('-', 'x').replaceAll('_', 'y')].join('')
try {
  mkdirSync(path.join(fixture, 'docs/evidence'), { recursive: true })
  // A credential-shaped canary must still be caught inside an allowlisted artifact.
  writeFileSync(path.join(fixture, 'docs/evidence/2026-09-08-room-context-browser.json'), JSON.stringify({ token: canary }))
  const reportPath = path.join(fixture, 'report.json')
  const result = spawnSync(binary, ['dir', fixture, '--config', config, '--redact=100', '--no-banner', '--report-format', 'json', '--report-path', reportPath], { encoding: 'utf8' })
  assert.equal(result.status, 1, 'Seeded invalid credential must make the detector fail')
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.ok(report.some(item => item.RuleID === 'github-pat'))
  assert.ok(!JSON.stringify(report).includes(canary), 'Report must redact the seeded bytes')
  console.log(JSON.stringify({ schemaVersion: 1, synthetic: true, detector: 'gitleaks', seeded_secret_rejected: true, evidence_exception_does_not_hide_credentials: true, report_redacted: true }))
} finally {
  const relative = path.relative(tmpdir(), fixture)
  assert.ok(relative.startsWith('ecorp-secret-canary-') && !relative.includes(path.sep))
  rmSync(fixture, { recursive: true })
}
