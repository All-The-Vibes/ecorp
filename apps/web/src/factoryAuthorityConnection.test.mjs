import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as authority from './factoryAuthority.ts'

// Execute App's real callbacks, as in snapshotRefresh/evidenceNavigation tests.
// No React rendering, network, server, runner or production identity is involved.
const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const app = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let effect, connectProduction
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(app) === 'useEffect'
    && node.arguments[1]?.getText(app) === '[refresh, connectionAttempt]') {
    effect = node.arguments[0].getText(app)
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(app) === 'connectProduction') {
    connectProduction = node.initializer.getText(app)
  }
  ts.forEachChild(node, visit)
}
visit(app)
assert.ok(effect && connectProduction, 'test the actual health effect and connection form')
const compiled = ts.transpileModule(
  `globalThis.mount = ${effect}; globalThis.connectProduction = ${connectProduction};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2023 } },
).outputText
const settle = () => new Promise(setImmediate)
const healthy = (mode) => ({ ok: true, status: 200, json: async () => ({ status: 'ok', mode }) })

function setup(t, initialMode = 'unknown') {
  const state = { mode: initialMode, errors: [], calls: [], response: healthy('production'), snapshotError: null }
  const storage = new Map([['ecorp_corp_id', 'corp'], ['ecorp_actor_id', 'actor'], ['ecorp_access_token', 'fixture-token']])
  const fetch = t.mock.fn(async (url, options) => {
    assert.equal(url, 'https://control.invalid/health')
    assert.ok(options?.signal === undefined || options.signal instanceof AbortSignal)
    if (state.response instanceof Error) throw state.response
    return state.response
  })
  // Imported shared helpers, if used by App, see the same inert HTTP boundary.
  t.mock.method(globalThis, 'fetch', fetch)
  const timers = new Map()
  const context = {
    ...authority, fetch, AbortController, URLSearchParams, Error,
    API_URL: 'https://control.invalid', currentViewer: { current: null }, currentComments: { current: null },
    connectionCorpId: 'corp', connectionActorId: 'actor', connectionToken: 'fixture-token',
    storedAccessToken: () => storage.get('ecorp_access_token'),
    setServerMode: (mode) => { state.mode = mode },
    setError: (error) => { if (error) state.errors.push(error) },
    setBootstrap: () => {}, setSelectedActorId: () => {}, setRequiresConnection: () => {},
    setAnnouncement: () => {}, setBusy: () => {}, setConnectionToken: () => {},
    api: async (path) => {
      state.calls.push(path)
      return { corp_id: 'corp', alice_actor_id: 'actor' }
    },
    refresh: async () => {
      state.calls.push('snapshot')
      if (state.snapshotError) throw state.snapshotError
    },
    window: {
      sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key) },
      location: { search: '' },
      setTimeout: (callback) => { timers.set(callback, callback); return callback },
      clearTimeout: (id) => timers.delete(id),
    },
  }
  vm.runInNewContext(compiled, context)
  return { state, timers, mount: context.mount, connect: () => context.connectProduction({ preventDefault() {} }) }
}

test('production health, failed snapshot, then development retry replaces the old mode', async (t) => {
  const s = setup(t)
  s.state.snapshotError = new Error('snapshot unavailable')
  const cleanup = s.mount()
  await settle()
  assert.deepEqual(s.state.errors, ['snapshot unavailable'])
  cleanup()
  s.state.snapshotError = null
  s.state.response = healthy('development')
  s.mount()
  await settle()
  assert.equal(s.state.mode, 'development')
  assert.deepEqual(s.state.calls, ['snapshot', '/api/demo/bootstrap?seed_crew=false', 'snapshot'])
})

test('development health, failed snapshot, then production retry records production without demo bootstrap', async (t) => {
  const s = setup(t)
  s.state.response = healthy('development')
  s.state.snapshotError = new Error('snapshot unavailable')
  const cleanup = s.mount()
  await settle()
  cleanup()
  s.state.snapshotError = null
  s.state.response = healthy('production')
  s.mount()
  await settle()
  assert.equal(s.state.mode, 'production')
  assert.deepEqual(s.state.calls, ['/api/demo/bootstrap?seed_crew=false', 'snapshot', 'snapshot'])
})

test('each pending attempt and failed snapshot clears previously verified mode', async (t) => {
  const s = setup(t, 'production')
  let resolve
  s.state.response = new Promise((done) => { resolve = done })
  s.mount()
  assert.equal(s.state.mode, 'unknown')
  s.state.snapshotError = new Error('snapshot unavailable')
  resolve(healthy('production'))
  await settle()
  assert.equal(s.state.mode, 'unknown')
  assert.deepEqual(s.state.errors, ['snapshot unavailable'])
})

test('unavailable or malformed health cannot retain authentication assurance or bootstrap', async (t) => {
  const cases = [
    ['network failure', new Error('health unavailable')],
    ['HTTP failure with production body', { ...healthy('production'), ok: false, status: 503 }],
    ['invalid JSON', { ok: true, json: async () => { throw new SyntaxError('invalid JSON') } }],
    ...[null, {}, [], 'production', { status: 'ok' }, { status: 'ok', mode: null },
      { status: 'ok', mode: 42 }, { status: 'ok', mode: 'Production' }, { status: 'ok', mode: 'unknown' },
      { mode: 'production' }, { mode: 'production', status: 'failed' }].map(
      (body) => [JSON.stringify(body), { ok: true, json: async () => body }],
    ),
  ]
  for (const [name, response] of cases) {
    await t.test(name, async (t) => {
      const s = setup(t, 'production')
      s.state.response = response
      s.mount()
      await settle()
      assert.equal(s.state.mode, 'unknown')
      assert.equal(s.state.errors.length, 1)
      assert.deepEqual(s.state.calls, [])
    })
  }
})

test('cancelled health cannot overwrite a newer successful development attempt', async (t) => {
  const s = setup(t)
  let resolve
  s.state.response = new Promise((done) => { resolve = done })
  const cleanup = s.mount()
  cleanup()
  s.state.response = healthy('development')
  s.mount()
  await settle()
  assert.equal(s.state.mode, 'development')
  resolve(healthy('production'))
  await settle()
  assert.equal(s.state.mode, 'development')
  assert.deepEqual(s.state.calls, ['/api/demo/bootstrap?seed_crew=false', 'snapshot'])
})

test('production form retry clears failed assurance and revalidates health on success', async (t) => {
  const s = setup(t, 'production')
  s.state.snapshotError = new Error('snapshot unavailable')
  const failed = s.connect()
  assert.equal(s.state.mode, 'unknown')
  await failed
  assert.equal(s.state.mode, 'unknown')
  s.state.snapshotError = null
  await s.connect()
  assert.equal(s.state.mode, 'production')
  s.state.response = healthy('development')
  await s.connect()
  assert.equal(s.state.mode, 'unknown', 'a development endpoint is not a production login')
  assert.deepEqual(s.state.calls, ['snapshot', 'snapshot'])
})

test('health validation without a caller signal still has a bounded deadline', async (t) => {
  const controller = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    assert.equal(milliseconds, 30_000)
    return controller.signal
  })
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    assert.equal(signal, controller.signal)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  const pending = authority.fetchServerMode('https://control.invalid')
  controller.abort(new Error('health deadline'))
  await assert.rejects(pending, /health deadline/)
})
