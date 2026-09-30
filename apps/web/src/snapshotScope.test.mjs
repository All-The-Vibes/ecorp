import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the App request handler with controlled completion order. This keeps
// the scope and publication assertions coupled to the real asynchronous path.
const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let callback
let selectActor
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'refresh' &&
      ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useCallback') {
    callback = node.initializer.arguments[0].getText(ast)
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'selectActor') {
    selectActor = node.initializer.getText(ast)
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(callback && selectActor)
const compiled = ts.transpileModule(`globalThis.refresh = ${callback}; globalThis.selectActor = ${selectActor}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

const response = (tag, corpId = 'corp-a') => ({ tag, snapshot: { corp: { id: corpId }, events: [{ seq: 1 }] } })
function setup() {
  const pending = []
  const context = {
    DOMException, Date, URL, Error,
    bootstrap: { corp_id: 'corp-a' }, currentComments: { current: {} },
    currentViewer: { current: { corpId: 'corp-a', actorId: 'alice' } },
    currentBudgetContext: { current: {} },
    snapshotReadVersion: { current: 0 }, lastEventSeq: { current: {} },
    api: (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
    setSnapshotLoad: (next) => { state.load = typeof next === 'function' ? next(state.load) : next },
    setSelectedActorId: () => {}, setConnectionsOpen: () => {}, setSavedConnectionLoad: () => {},
    setMissionSourceKey: () => {}, setMissionSourceConfirmed: () => {}, setMissionAdapter: () => {},
    setMissionModel: () => {}, setAnnouncement: () => {}, setError: (message) => state.errors.push(message),
    window: { location: { href: 'http://127.0.0.1/' }, history: { replaceState() {} } },
  }
  const state = { errors: [], load: { corpId: 'corp-a', actorId: 'alice', response: response('retained'),
    receivedAt: '2026-09-29T00:00:00Z', refreshFailed: false } }
  vm.runInNewContext(compiled, context)
  const churn = () => {
    context.currentViewer.current = { corpId: 'corp-a', actorId: 'bob' }
    context.currentViewer.current = { corpId: 'corp-a', actorId: 'alice' }
  }
  return { context, state, pending, churn, refresh: context.refresh }
}

test('a current authorized snapshot updates the receipt and event watermark', async () => {
  const s = setup()
  const request = s.refresh('corp-a', 'alice')
  s.pending[0].resolve(response('current'))
  await request
  assert.equal(s.state.load.response.tag, 'current')
  assert.equal(s.state.load.refreshFailed, false)
  assert.ok(Number.isFinite(Date.parse(s.state.load.receivedAt)))
  assert.equal(s.context.lastEventSeq.current.alice, 1)
  assert.equal(s.context.currentBudgetContext.current, null)
})

test('a failed current read withholds the prior authorized snapshot', async () => {
  const s = setup()
  const request = s.refresh('corp-a', 'alice')
  s.pending[0].reject(new Error('403 scope revoked'))
  await assert.rejects(request, /403/)
  assert.equal(s.state.load.refreshFailed, true)
  assert.equal(s.context.currentBudgetContext.current, null)
})

test('wrong-Corp responses and aborted reads cannot publish data', async () => {
  for (const aborted of [false, true]) {
    const s = setup()
    const controller = new AbortController()
    const request = s.refresh('corp-a', 'alice', controller.signal)
    if (aborted) controller.abort()
    s.pending[0].resolve(response('wrong', 'corp-b'))
    await assert.rejects(request)
    assert.equal(s.state.load.response.tag, 'retained')
    assert.equal(s.state.load.refreshFailed, !aborted)
  }
})

test('A to B to A cannot resurrect an earlier viewer-generation snapshot', async () => {
  const s = setup()
  const request = s.refresh('corp-a', 'alice')
  s.churn()
  s.pending[0].resolve(response('obsolete-generation'))
  await request
  assert.equal(s.state.load.response.tag, 'retained')
  assert.deepEqual(s.context.lastEventSeq.current, {})
})

test('a failed earlier viewer generation cannot mark the returning viewer failed', async () => {
  const s = setup()
  const request = s.refresh('corp-a', 'alice')
  s.churn()
  s.pending[0].reject(new Error('earlier-generation failure'))
  await assert.rejects(request, /earlier-generation/)
  assert.equal(s.state.load.refreshFailed, false)
})

test('an older overlapping success cannot replace a newer same-viewer receipt', async () => {
  const s = setup()
  const older = s.refresh('corp-a', 'alice')
  const newer = s.refresh('corp-a', 'alice')
  s.pending[1].resolve(response('newer'))
  await newer
  const current = s.state.load
  s.pending[0].resolve(response('older'))
  await older
  assert.equal(s.state.load, current)
})

test('an older overlapping failure cannot poison a newer authorized receipt', async () => {
  const s = setup()
  const older = s.refresh('corp-a', 'alice')
  const newer = s.refresh('corp-a', 'alice')
  s.pending[1].resolve(response('newer'))
  await newer
  const current = s.state.load
  s.pending[0].reject(new Error('older failure'))
  await assert.rejects(older, /older failure/)
  assert.equal(s.state.load, current)
})

test('a newer denied read stays withheld even if an older successful read finishes later', async () => {
  const s = setup()
  const older = s.refresh('corp-a', 'alice')
  const newer = s.refresh('corp-a', 'alice')
  s.pending[1].reject(new Error('403 scope revoked'))
  await assert.rejects(newer, /403/)
  const withheld = s.state.load
  s.pending[0].resolve(response('before-revocation'))
  await older
  assert.equal(s.state.load, withheld)
  assert.equal(s.state.load.refreshFailed, true)
})

test('an obsolete-scope read does not invalidate the current viewer request', async () => {
  const s = setup()
  const current = s.refresh('corp-a', 'alice')
  const obsolete = s.refresh('corp-a', 'bob')
  s.pending[1].resolve(response('other-viewer'))
  await obsolete
  s.pending[0].resolve(response('current-viewer'))
  await current
  assert.equal(s.state.load.response.tag, 'current-viewer')
  assert.equal(s.state.load.actorId, 'alice')
})

test('the actual actor switch clears retained data and links even on same-tick A to B to A', async () => {
  const s = setup()
  const firstViewer = s.context.currentViewer.current
  s.context.selectActor({ id: 'bob', name: 'Bob' })
  assert.equal(s.state.load, null)
  assert.equal(s.context.currentBudgetContext.current, null)
  s.context.selectActor({ id: 'alice', name: 'Alice' })
  assert.notEqual(s.context.currentViewer.current, firstViewer)
  assert.equal(s.state.load, null)
  assert.equal(s.context.currentBudgetContext.current, null)
  s.pending[0].resolve(response('bob-obsolete'))
  await new Promise(setImmediate)
  assert.equal(s.state.load, null)
  s.pending[1].resolve(response('alice-current'))
  await new Promise(setImmediate)
  assert.equal(s.state.load.response.tag, 'alice-current')
  assert.deepEqual(s.state.errors, [])
})

test('an obsolete actor switch failure does not overwrite the current viewer notice', async () => {
  const s = setup()
  s.context.selectActor({ id: 'bob', name: 'Bob' })
  s.context.selectActor({ id: 'alice', name: 'Alice' })
  s.pending[1].resolve(response('alice-current'))
  await new Promise(setImmediate)
  s.pending[0].reject(new Error('old viewer failure'))
  await new Promise(setImmediate)
  assert.deepEqual(s.state.errors, [])
  assert.equal(s.state.load.refreshFailed, false)
})
