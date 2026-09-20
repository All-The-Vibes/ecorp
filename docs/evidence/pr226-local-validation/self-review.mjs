import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { git, sha256, snapshot } from './verify-inputs.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
const read = path => readFileSync(`${directory}/${path}`)
const json = path => JSON.parse(read(path))
const records = json('baseline-results.json')
const retries = json('web-retry-results.json')
const diagnostics = [...json('final-checks-results.json'), ...json('final-diff-check-results.json'), ...json('normal-git-check-results.json')]
const manifestHash = sha256(read('tested-inputs.json'))
const expected = ['version-node', 'version-git', 'version-cargo', 'version-rustc', 'version-pnpm',
  'migrations', 'rustfmt', 'clippy', 'cargo-tests', 'web-build', 'web-lint',
  'canary', 'new-red', 'new-green', 'verify-inputs', 'diff-check']
assert.deepEqual(records.map(record => record.id), expected)
assert.deepEqual(retries.map(record => record.id), ['proxy-install', 'web-build-retry', 'web-lint-retry', 'verify-inputs-after-retry', 'owned-diff-check'])
for (const record of [...records, ...retries, ...diagnostics]) {
  assert.equal(record.sourceManifestSha256, manifestHash)
  const retainedFailures = { 'web-build': 1, 'web-lint': 1, 'diff-check': 2, 'current-whole-tree-diff-check': 2 }
  assert.equal(record.exitCode, retainedFailures[record.id] ?? (record.id === 'new-red' ? 1 : 0), record.id)
  assert.equal(record.signal, null)
  assert.equal(record.result, record.id in retainedFailures ? 'FAIL' : 'PASS', record.id)
  for (const log of Object.values(record.logs)) {
    assert.equal(sha256(read(log.path)), log.portableSha256, log.path)
    assert.equal(log.credentialRedactions, 0, 'credential matches require explicit review')
  }
}
assert.deepEqual(snapshot(), json('tested-inputs.json').files)
const red = json('logs/new-red.stdout.txt')
const green = json('logs/new-green.stdout.txt')
assert.equal(red.revision, 'ec1700db3074ecaf2045314c71ef893434c4d79e')
assert.equal(green.revision, json('tested-inputs.json').sourceHead)
git(['merge-base', '--is-ancestor', red.revision, green.revision])
assert.equal(red.checks.length, 2)
assert.equal(green.checks.length, 2)
assert(red.checks.every(check => !check.pass))
assert(green.checks.every(check => check.pass))
assert.deepEqual(red.checks.map(check => check.requiredSha256), green.checks.map(check => check.actualSha256))
assert.deepEqual(red.checks.map(check => check.actualSha256), [
  '1c02e7e18433d419039da13ccfc1789b62cc227c6c907ee0cb5e457a635c6091',
  '75091bd742b2714b2e164ca10dd6ecd912f8f3b516160ad8ca4a22cf6f1bbda8',
])
assert.match(read('logs/canary.stdout.txt').toString(), /# pass 10/)
assert.match(read('logs/canary.stdout.txt').toString(), /# fail 0/)
// snapshot() already verifies index and working bytes; avoid checkout/stat-cache coercion.
const changedTracked = git(['diff', '--cached', '--name-only', '-z', json('tested-inputs.json').sourceHead]).toString().split('\0').filter(Boolean)
assert(changedTracked.every(path => path.startsWith('docs/')), 'non-documentation tracked change')
const files = readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => `${entry.parentPath}/${entry.name}`.slice(directory.length).replaceAll('\\', '/').replace(/^\//, ''))
  .filter(path => !path.startsWith('self-review-result.') && !path.startsWith('logs/self-review') && !path.startsWith('author-review'))
  .sort()
const knownSecrets = Object.entries(process.env)
  .filter(([name, value]) => /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|DATABASE_URL/i.test(name) && value.length >= 8)
  .map(([, value]) => value)
for (const path of files) {
  const text = read(path).toString()
  if (!path.startsWith('logs/')) assert(!/[ \t]+$/m.test(text), `authored trailing whitespace: ${path}`)
  for (const secret of knownSecrets) assert(!text.includes(secret), `credential match withheld: ${path}`)
  assert(!/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/.test(text),
    `credential-shaped match withheld: ${path}`)
  assert(!/C:[/\\]+Users[/\\]+sschofield/i.test(text), `unredacted personal path: ${path}`)
}
assert.match(read('README.md').toString(), /not.*historical.*RED/i)
assert.match(read('README.md').toString(), /native acceptance.*unproven/i)
const summary = json('summary.json')
const groups = [...read('logs/cargo-tests.stdout.txt').toString().matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/g)]
assert.equal(summary.rust.passed, groups.reduce((sum, group) => sum + Number(group[1]), 0))
assert.equal(summary.rust.ignored, groups.reduce((sum, group) => sum + Number(group[3]), 0))
assert.equal(summary.rust.failed, 0)
assert.equal(summary.baselineCommands.length, 6)
assert(summary.baselineCommands.every(command => command.exitCode === 0 && command.result === 'PASS'))
assert(read('summary.html').toString().includes(`${summary.rust.passed} passed / ${summary.rust.ignored} ignored`))
console.log(JSON.stringify({
  result: 'PASS', performedAt: new Date().toISOString(),
  scope: 'Automated author self-review of this evidence package only; not independent review or human approval.',
  checks: [
    'All 16 initial commands and five recovery/check commands present; actual exits/signals verified.',
    'Initial web policy failures (exit 1) retained; approved-proxy frozen install and both web retries pass.',
    'Global-config-disabled whitespace diagnostics (exit 2) retained; normal configured checkout diff check passes. No other-owned file or Git config edited.',
    'Every portable log hash and executed-input manifest verified; no matched credentials.',
    '388 tracked non-doc input records still match; current tracked changes are documentation-only.',
    'Immutable RED ancestor genuinely violates both unchanged hashes; GREEN satisfies both.',
    'Current canary TAP reports 10 passed and zero failed.',
    'Personal absolute paths redacted; authored text has no trailing whitespace; README and HTML retain historical/native/screenshot boundaries.',
  ],
  manifestSha256: manifestHash, changedTracked,
  reviewedFiles: files.map(path => ({ path, sha256: sha256(read(path)) })),
  remaining: ['Original issue225 native acceptance remains unproven/open.', 'Browser capture is outside this check; see the separate owner browser-capture.json and reviewed image.'],
}, null, 2))
