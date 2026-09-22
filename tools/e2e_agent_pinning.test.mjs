import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createRequire } from 'node:module'

const ts = createRequire(new URL('../apps/web/package.json', import.meta.url))('typescript')

const driver = fileURLToPath(new URL('./e2e_agent_pinning.mjs', import.meta.url))

// Execute the actual output statements against real filesystem aliases. This
// regression needs neither a live server nor a substitute implementation.
const sourceText = await readFile(driver, 'utf8')
const syntax = ts.createSourceFile(driver, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const outputWrites = []
function findOutputWrites(node) {
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'writeFile' &&
      /provider-artifact\.txt|native-final-snapshot\.json/.test(node.arguments[0].getText(syntax))) {
    outputWrites.push(node.getText(syntax))
  }
  ts.forEachChild(node, findOutputWrites)
}
findOutputWrites(syntax)
assert.equal(outputWrites.length, 2, 'Exercise both production immutable output sinks')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
for (const [index, statement] of outputWrites.entries()) {
  const filename = index === 0 ? 'owned-run-provider-artifact.txt' : 'native-final-snapshot.json'
  const write = new AsyncFunction('writeFile', 'path', 'output', 'nativeRun', 'bytes', 'settled', `await ${statement}`)
  for (const kind of ['occupied', 'hard-link', 'symlink']) {
    test(`native Pin ${filename} preserves ${kind} output and source sentinel`, async (t) => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ecorp-pin-output-')))
      t.after(() => rm(root, { recursive: true, force: true }))
      const output = path.join(root, 'output')
      const source = path.join(root, 'source')
      await mkdir(output)
      await mkdir(source)
      const sentinel = path.join(source, 'seed.txt')
      const target = path.join(output, filename)
      await writeFile(sentinel, 'preserved source\n')
      if (kind === 'occupied') await writeFile(target, 'prior output\n')
      if (kind === 'hard-link') await link(sentinel, target)
      if (kind === 'symlink') {
        try { await symlink(sentinel, target, 'file') } catch (error) {
          if (process.platform === 'win32' && error.code === 'EPERM') {
            t.skip('Windows file-symlink privilege unavailable; hard-link lane still executes')
            return
          }
          throw error
        }
      }
      await assert.rejects(write(writeFile, path, output, { id: 'owned-run' }, Buffer.from('new artifact'), { done: true }),
        { code: 'EEXIST' })
      assert.equal(await readFile(sentinel, 'utf8'), 'preserved source\n')
      assert.equal(await readFile(target, 'utf8'), kind === 'occupied' ? 'prior output\n' : 'preserved source\n')
    })
  }
  test(`native Pin ${filename} creates a fresh output once`, async (t) => {
    const output = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ecorp-pin-fresh-')))
    t.after(() => rm(output, { recursive: true, force: true }))
    await write(writeFile, path, output, { id: 'owned-run' }, Buffer.from('new artifact'), { done: true })
    const content = await readFile(path.join(output, filename), 'utf8')
    assert.equal(content, index === 0 ? 'new artifact' : JSON.stringify({ done: true }, null, 2))
  })
}
function denied(overrides, message, args = ['--phase', 'prepare']) {
  const result = spawnSync(process.execPath, [driver, ...args], {
    encoding: 'utf8', timeout: 15000,
    env: {
      ...process.env, CRONY_PIN_TEST: '1', CRONY_SERVER_HTTP: 'http://127.0.0.1:59031',
      CRONY_PIN_WEB: 'http://127.0.0.1:59032', CRONY_PIN_OUTPUT: '',
      CRONY_PIN_PRIVATE: '', CRONY_CLI_BINARY: '', CRONY_PIN_SOURCE: '', ECORP_PSQL_BINARY: '',
      ...overrides,
    },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, message)
  assert.equal(result.stdout, '')
}

test('native pin driver fails before writes without explicit opt-in and bounded phase', () => {
  denied({ CRONY_PIN_TEST: '0' }, /owned-stack opt-in required/)
  denied({}, /AssertionError/, ['--phase', 'reset'])
})

test('native pin driver refuses external, inherited shared-port and credentialed origins', () => {
  for (const url of ['https://example.invalid', 'http://localhost:59031', 'http://127.0.0.1:8791',
    'http://127.0.0.1:55483', 'http://user:fixture@127.0.0.1:59031', 'http://127.0.0.1:59031/api']) {
    denied({ CRONY_SERVER_HTTP: url }, /AssertionError/)
  }
  denied({ CRONY_PIN_WEB: 'http://127.0.0.1:5187' }, /allocated ports/)
})

test('native pin driver never invents missing output or source paths', () => {
  denied({}, /CRONY_PIN_OUTPUT must be explicit and absolute/)
  denied({ CRONY_PIN_OUTPUT: 'relative-output' }, /CRONY_PIN_OUTPUT must be explicit and absolute/)
})

test('native pin driver rejects overlapping and aliased directories before any write in every phase', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ecorp-pin-boundary-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  await mkdir(source)
  await writeFile(path.join(source, 'seed.txt'), 'unchanged source\n')
  const alias = path.join(root, 'alias')
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const output = path.join(root, 'output')
  const privateDirectory = path.join(root, 'private')
  const cases = [
    [source, privateDirectory, source],
    [path.join(source, 'new', 'output'), privateDirectory, source],
    [root, privateDirectory, source],
    [output, source, source],
    [output, path.join(source, 'new', 'private'), source],
    [output, root, source],
    [output, output, source],
    [output, path.join(output, 'private'), source],
    [path.join(privateDirectory, 'output'), privateDirectory, source],
    [alias, privateDirectory, source],
    [path.join(alias, 'new', 'output'), privateDirectory, source],
    [output, alias, source],
    [output, path.join(alias, 'new', 'private'), source],
    [source, privateDirectory, alias],
  ]
  if (process.platform === 'win32') {
    cases.push([source.toUpperCase(), privateDirectory, source])
    cases.push([source, privateDirectory, source.toUpperCase()])
  }
  for (const phase of ['prepare', 'start', 'complete']) {
    for (const [destination, leaseDirectory, sourceDirectory] of cases) {
      denied({
        CRONY_PIN_OUTPUT: destination, CRONY_PIN_PRIVATE: leaseDirectory, CRONY_PIN_SOURCE: sourceDirectory,
        CRONY_CLI_BINARY: process.execPath, ECORP_PSQL_BINARY: process.execPath,
        PGHOST: '127.0.0.1', PGPORT: '59030', PGDATABASE: 'issue48_app', PGUSER: 'issue48',
      }, /source, output and private directories must be disjoint/, ['--phase', phase])
      assert.deepEqual((await readdir(root)).sort(), ['alias', 'source'])
      assert.deepEqual(await readdir(source), ['seed.txt'])
      assert.equal(await readFile(path.join(source, 'seed.txt'), 'utf8'), 'unchanged source\n')
    }
  }
})

test('native pin driver rejects non-directory ancestors and dangling links before creating output', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ecorp-pin-boundary-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  await mkdir(source)
  await writeFile(path.join(root, 'file'), 'unchanged\n')
  await symlink(path.join(root, 'missing'), path.join(root, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const output of [path.join(root, 'file', 'child'), path.join(root, 'dangling', 'child')]) {
    denied({
      CRONY_PIN_OUTPUT: output, CRONY_PIN_PRIVATE: path.join(root, 'private'), CRONY_PIN_SOURCE: source,
      CRONY_CLI_BINARY: process.execPath, ECORP_PSQL_BINARY: process.execPath,
      PGHOST: '127.0.0.1', PGPORT: '59030', PGDATABASE: 'issue48_app', PGUSER: 'issue48',
    }, /must be a directory|ENOENT|ENOTDIR/)
    assert.deepEqual((await readdir(root)).sort(), ['dangling', 'file', 'source'])
  }
})
