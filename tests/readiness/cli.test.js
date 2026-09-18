// Black-box tests of the actual validation CLI; fixture counts are not product-test counts.
const assert = require('node:assert/strict')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const source = path.resolve(__dirname, '../..')

function fixture(t, testBody = "import test from 'node:test'; test('owned fixture', () => {})") {
  const root = mkdtempSync(path.join(tmpdir(), 'ecorp-readiness-cli-'))
  t.after(() => {
    const relative = path.relative(tmpdir(), root)
    assert.ok(relative.startsWith('ecorp-readiness-cli-') && !relative.includes(path.sep))
    rmSync(root, { recursive: true })
  })
  for (const directory of ['tools', 'docs']) mkdirSync(path.join(root, directory))
  for (const file of ['tools/run_checks.mjs', 'tools/check_docs.mjs', 'test.config.json', 'package.json', '.node-version', 'rust-toolchain.toml', 'docs/VALIDATION.md']) {
    copyFileSync(path.join(source, file), path.join(root, file))
  }
  writeFileSync(path.join(root, '.gitignore'), 'output/\n')
  writeFileSync(path.join(root, 'tools/fixture.test.mjs'), testBody)
  writeFileSync(path.join(root, 'tools/check_migrations.mjs'), "console.error('synthetic gate rejection'); process.exit(1)")
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  git(['init', '--quiet'])
  git(['add', '.'])
  git(['-c', 'user.name=Readiness CLI fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'isolated test fixture'])
  const childEnvironment = { ...process.env }
  // Each black-box invocation is a new CLI, not a nested Node test worker.
  delete childEnvironment.NODE_TEST_CONTEXT
  return { root, git, invoke: args => spawnSync(process.execPath, ['tools/run_checks.mjs', ...args], { cwd: root, env: childEnvironment, encoding: 'utf8', timeout: 20000 }) }
}

function receipt(root) {
  const directory = path.join(root, 'output/readiness')
  const files = readdirSync(directory).filter(file => file.endsWith('.json'))
  assert.equal(files.length, 1)
  return JSON.parse(readFileSync(path.join(directory, files[0]), 'utf8'))
}

test('dry run executes no checks, creates no receipt and leaves source unchanged', t => {
  const f = fixture(t), before = f.git(['status', '--porcelain'])
  const result = f.invoke(['--group', 'full', '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.dry_run, true)
  assert.deepEqual(preview.writes, [])
  assert.equal(preview.checks.length, 8)
  assert.equal(f.git(['status', '--porcelain']), before)
  assert.ok(!readdirSync(f.root).includes('output'))
})
test('unknown arguments cannot become commands', t => {
  const f = fixture(t)
  const result = f.invoke(['--group', 'node', '--anything'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage:/)
  assert.ok(!readdirSync(f.root).includes('output'))
})
test('successful native tests produce observed counts and stable-source evidence', t => {
  const f = fixture(t), result = f.invoke(['--group', 'node'])
  assert.equal(result.status, 0, result.stderr)
  const report = receipt(f.root)
  assert.equal(report.status, 'passed')
  assert.equal(report.sourceChangedDuringValidation, false)
  assert.equal(report.checks[0].counts.node.passed, 1)
  assert.equal(report.checks[0].counts.node.cancelled, 0)
  assert.deepEqual(report.notRun, [])
})
test('failing first gate stops execution and marks later gates not run', t => {
  const f = fixture(t), result = f.invoke(['--group', 'fast'])
  assert.equal(result.status, 1)
  const report = receipt(f.root)
  assert.equal(report.status, 'failed')
  assert.equal(report.checks.length, 1)
  assert.equal(report.checks[0].name, 'migrations')
  assert.deepEqual(report.notRun, ['docs', 'format'])
})
test('a passing test cannot certify source it modified during validation', t => {
  const f = fixture(t, "import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('mutation fixture', () => writeFileSync('new-source.txt', 'changed'))")
  const result = f.invoke(['--group', 'node'])
  assert.equal(result.status, 1)
  const report = receipt(f.root)
  assert.equal(report.checks[0].counts.node.passed, 1)
  assert.equal(report.sourceChangedDuringValidation, true)
  assert.equal(report.status, 'source_changed')
})
