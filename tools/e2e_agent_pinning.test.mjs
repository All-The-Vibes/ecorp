import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const driver = fileURLToPath(new URL('./e2e_agent_pinning.mjs', import.meta.url))
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
