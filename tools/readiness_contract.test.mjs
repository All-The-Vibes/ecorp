import assert from 'node:assert/strict'
import test from 'node:test'
import { selectNodeTests, checkPlan, summarizeTests, invocationFor } from './run_checks.mjs'
import { renderContract, replaceContract, START, END } from './check_docs.mjs'

test('native test discovery covers existing web, tooling and steward suites without fixtures', () => {
  assert.deepEqual(selectNodeTests(['tools/a.test.mjs', 'apps/web/src/b.test.mjs', 'scenarios/repo-steward/c.test.mjs',
    'tools/a.test.mjs', 'node_modules/d.test.mjs', 'tools/e2e_live.mjs', '../bad.test.mjs', 'tools/../bad.test.mjs']),
  ['apps/web/src/b.test.mjs', 'scenarios/repo-steward/c.test.mjs', 'tools/a.test.mjs'])
})
test('empty discovery, invalid config and unknown groups fail closed', () => {
  assert.throws(() => checkPlan('node', []), /No Node test/)
  assert.throws(() => checkPlan('made-up', ['tools/a.test.mjs']), /Unknown check/)
  assert.throws(() => selectNodeTests([], { schemaVersion: 2 }), /Unsupported/)
})
test('CommonJS CLI integration tests join the same native Node runner', () => {
  assert.deepEqual(selectNodeTests(['tests/readiness/cli.test.js', 'tests/readiness/fixture.js']), ['tests/readiness/cli.test.js'])
})
test('review skill package tests remain enrolled when the independently reviewed skill lands', () => {
  const candidate = '.github/skills/code-review/tests/package.test.mjs'
  assert.deepEqual(selectNodeTests([candidate, '.github/skills/code-review/upstream/fixture.js']), [candidate])
})
test('Windows package-manager execution uses an explicit argument vector, never a shell', () => {
  assert.deepEqual(invocationFor('pnpm', ['build:web'], 'win32', 'C:\\Program Files\\pnpm\\bin\\pnpm.cjs'),
    { program: process.execPath, args: ['C:\\Program Files\\pnpm\\bin\\pnpm.cjs', 'build:web'] })
  assert.deepEqual(invocationFor('pnpm', ['build:web'], 'win32', 'C:\\Program Files\\pnpm\\bin\\pnpm.mjs'),
    { program: process.execPath, args: ['C:\\Program Files\\pnpm\\bin\\pnpm.mjs', 'build:web'] })
  assert.throws(() => invocationFor('pnpm', ['build:web'], 'win32', 'pnpm.cmd'), /native CLI path/)
})
test('full gate retains Rust, web and migration checks and adds Node/docs validation', () => {
  const plan = checkPlan('full', ['tools/a.test.mjs'])
  assert.deepEqual(plan.map(check => check.name), ['migrations', 'docs', 'repository-docs', 'node-tests', 'format', 'clippy', 'rust-tests', 'web-build', 'web-lint'])
  assert.deepEqual(plan.find(check => check.name === 'rust-tests').argv, ['cargo', 'test', '--workspace', '--locked'])
  assert.deepEqual(plan.find(check => check.name === 'repository-docs').argv, ['node', 'tools/check_documentation.mjs'])
  assert.deepEqual(checkPlan('docs', ['tools/a.test.mjs']).map(check => check.name), ['docs', 'repository-docs'])
})
test('every Node test group retains the native 180-second per-test deadline', () => {
  for (const group of ['node', 'test', 'full']) {
    const [command, ...argv] = checkPlan(group, ['tools/a.test.mjs']).find(check => check.name === 'node-tests').argv
    assert.deepEqual(invocationFor(command, argv), {
      program: process.execPath,
      args: ['--test', '--test-concurrency=1', '--test-timeout=180000', '--test-reporter=tap', 'tools/a.test.mjs'],
    })
  }
})
test('test results distinguish failed, passed, ignored and not-observed', () => {
  assert.deepEqual(summarizeTests('compile error'), { rust: null, node: null })
  const counts = summarizeTests('test result: ok. 2 passed; 0 failed; 3 ignored;\ntest result: FAILED. 1 passed; 2 failed; 1 ignored;\n# tests 9\n# pass 6\n# fail 1\n# skipped 2\n# todo 0\n')
  assert.deepEqual(counts.rust, { passed: 3, failed: 2, ignored: 4, summaries: 2 })
  assert.deepEqual(counts.node, { tests: 9, passed: 6, failed: 1, skipped: 2, todo: 0, cancelled: null })
})
const pkg = { packageManager: 'pnpm@11.19.0', scripts: { test: 'cargo test', 'test:js': 'node --test', check: 'node check.mjs' } }
const settings = { nodeTestRoots: ['tools/'], rustCommand: ['cargo', 'test'], ignoredTests: 'Ignored is not passed.' }
test('generated docs follow canonical command and version changes', () => {
  const rendered = renderContract(pkg, '24.19.0', '1.98.1', settings)
  assert.match(rendered, /pnpm test:js/u)
  assert.notEqual(rendered, renderContract({ ...pkg, scripts: { ...pkg.scripts, check: 'node new.mjs' } }, '24.19.0', '1.98.1', settings))
  assert.throws(() => renderContract(pkg, 'latest', '1.98.1', settings), /exact versions/)
})
test('repair preserves authored prose, is idempotent, and refuses ambiguous blocks', () => {
  const before = `Authored introduction\n${START}\nstale\n${END}\nHistorical evidence`
  const generated = renderContract(pkg, '24.19.0', '1.98.1', settings)
  const result = replaceContract(before, generated)
  assert.ok(result.startsWith('Authored introduction\n'))
  assert.ok(result.endsWith('\nHistorical evidence'))
  assert.equal(replaceContract(result, generated), result)
  for (const text of ['', `${START}${START}${END}`, `${END}${START}`]) assert.throws(() => replaceContract(text, generated), /Exactly one/)
})
test('Windows CRLF checkout is not mistaken for documentation drift', () => {
  const generated = renderContract(pkg, '24.19.0', '1.98.1', settings)
  const document = `Intro\r\n${generated.replaceAll('\n', '\r\n')}\r\nEnd`
  assert.equal(replaceContract(document, generated), document)
})
