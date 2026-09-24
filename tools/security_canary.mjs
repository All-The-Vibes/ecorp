import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Detector verification, never a real credential or provider call.
const binary = process.argv[2]
if (!binary || !path.isAbsolute(binary) || process.argv.length !== 3) throw new Error('Supply one absolute Gitleaks executable path')
const config = fileURLToPath(new URL('./gitleaks-snapshot.toml', import.meta.url))
const fixture = mkdtempSync(path.join(tmpdir(), 'ecorp-secret-canary-'))
const canary = ['gh', 'p_', randomBytes(27).toString('base64url').replaceAll('-', 'x').replaceAll('_', 'y')].join('')
// Random base64url values can match the detector's alphabetic-only or stopword
// exemptions. This reproducible synthetic value exercises detection every run.
const genericCanary = createHash('sha256').update('ECorp generic detector canary v1').digest('hex')
const publicId = 'b663e050-1204-482b-936a-e0d48d96c6ce'
const screenshotDigest = 'bfce9ea7da3977ab423e23e306742b3f770de74f6a801364dbf06c7b4d72ea62'
const cases = [
  {
    file: 'docs/evidence/pr-queue-completion-20260923/native/audit/acceptance.json',
    value: publicId,
    render: value => JSON.stringify({ idempotency_key: value }, null, 2),
  },
  {
    file: 'docs/evidence/pr-362-completion-20260923-r294/source-binding.json',
    value: screenshotDigest,
    render: value => JSON.stringify({ '05-secrets-suite.png': value }, null, 2),
  },
  {
    file: 'crates/crony-server/src/base_worker_tests.rs',
    value: 'fixture/secondary',
    render: value => `secondary_rpc_secret: ${JSON.stringify(value)}`,
  },
]

function scan(name, files, expectedRule) {
  const root = path.join(fixture, name)
  mkdirSync(root)
  for (const [file, contents] of files) {
    const destination = path.join(root, file)
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, contents)
  }
  // Keep scanner output outside the input directory.
  const reportPath = path.join(fixture, `${name}.json`)
  const result = spawnSync(binary, ['dir', '.', '--config', config, '--redact=100', '--no-banner', '--report-format', 'json', '--report-path', reportPath], { cwd: root, encoding: 'utf8', timeout: 60_000 })
  assert.ifError(result.error)
  const reportBytes = readFileSync(reportPath, 'utf8')
  const report = JSON.parse(reportBytes)
  assert.ok(![reportBytes, result.stdout, result.stderr].some(output => output.includes(canary) || output.includes(genericCanary)), `${name}: output must redact seeded bytes`)
  const detected = report.map(item => `${item.RuleID}: ${item.File}`)
  assert.equal(result.status, expectedRule ? 1 : 0, `${name}: unexpected detector exit; ${detected.join('; ')}`)
  if (expectedRule) {
    for (const [file] of files) {
      assert.ok(report.some(item => item.RuleID === expectedRule && item.File.replaceAll('\\', '/') === file), `${name}: ${file} must be detected by ${expectedRule}`)
    }
  } else {
    assert.equal(report.length, 0, `${name}: reviewed public values must pass`)
  }
}

try {
  scan('public-values', cases.map(item => [item.file, item.render(item.value)]))
  scan('generic-secrets', cases.map(item => [item.file, item.render(genericCanary)]), 'generic-api-key')
  scan('provider-tokens', [
    ...cases.map(item => [item.file, item.render(canary)]),
    ['docs/evidence/2026-09-08-room-context-browser.json', JSON.stringify({ token: canary })],
  ], 'github-pat')
  scan('same-path-new-field', [[cases[0].file, JSON.stringify({ api_key: publicId }, null, 2)]], 'generic-api-key')
  scan('altered-public-value', [[cases[0].file, cases[0].render(`${publicId}1`)]], 'generic-api-key')
  scan('same-line-new-secret', [[cases[0].file, `${cases[0].render(publicId).replaceAll('\n', '')} ${JSON.stringify({ token: genericCanary })}`]], 'generic-api-key')
  scan('different-path', [['docs/evidence/unreviewed.json', cases[0].render(publicId)]], 'generic-api-key')
  console.log(JSON.stringify({ schemaVersion: 2, synthetic: true, detector: 'gitleaks', scans: 7, public_values_accepted: true, seeded_secret_rejected: true, evidence_exception_does_not_hide_credentials: true, exact_path_required: true, exact_field_and_value_required: true, same_line_secrets_rejected: true, report_redacted: true }))
} finally {
  const relative = path.relative(tmpdir(), fixture)
  assert.ok(relative.startsWith('ecorp-secret-canary-') && !relative.includes(path.sep))
  rmSync(fixture, { recursive: true })
}
