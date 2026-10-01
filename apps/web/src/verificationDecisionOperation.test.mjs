import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const helpers = ['browserOperationKey', 'clearBrowserOperation'].map((name) => {
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(declaration, name)
  return declaration.getText(ast)
}).join('\n')
let initializer
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'decideVerification') initializer = node.initializer
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(initializer, 'Exercise the actual verification decision callback')
const code = ts.transpileModule(helpers + '\nconst decideVerification = ' + initializer.getText(ast) + ';', {
  compilerOptions: { target: ts.ScriptTarget.ES2023 },
}).outputText
function fixture({ storageFailure, loseFirstResponse = false } = {}) {
  const stored = new Map(), errors = [], requests = [], busy = []
  const sessionStorage = {
    getItem(key) { if (storageFailure === 'read') throw new Error('Storage disabled'); return stored.get(key) ?? null },
    setItem(key, value) { if (storageFailure === 'write') throw new Error('Quota exceeded'); stored.set(key, value) },
    removeItem(key) { stored.delete(key) },
  }
  const actor = { id: 'reviewer', name: 'Bob' }
  const api = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    if (loseFirstResponse && requests.length === 1) throw new Error('Response lost after commit')
  }
  const handler = new Function('window', 'crypto', 'bootstrap', 'selectedActor', 'setError', 'setBusy', 'api', 'refresh',
    code + '; return decideVerification;')({ sessionStorage }, { randomUUID }, { corp_id: 'corp' }, actor,
    (error) => errors.push(error), (value) => busy.push(value), api, async () => {})
  return { handler, stored, errors, requests, busy, actor }
}
for (const approved of [true, false]) {
  test('Verification ' + (approved ? 'approval' : 'rejection') + ' retries the exact durable decision after a lost response', async () => {
    const f = fixture({ loseFirstResponse: true })
    await f.handler({ id: 'run' }, approved)
    assert.equal(f.stored.size, 1)
    assert.match(f.errors.at(-1), /Response lost/)
    const body = f.requests[0].body
    assert.equal(body.actor_id, 'reviewer')
    assert.equal(body.approved, approved)
    assert.match(body.decision_key, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    await f.handler({ id: 'run' }, approved)
    assert.deepEqual(f.requests[1], f.requests[0])
    assert.equal(f.stored.size, 0)
    assert.equal(f.busy.at(-1), false)
  })
}
for (const storageFailure of ['read', 'write']) {
  test('Verification decision fails closed when retry-key storage cannot ' + storageFailure, async () => {
    const f = fixture({ storageFailure })
    await f.handler({ id: 'run' }, true)
    assert.equal(f.requests.length, 0)
    assert.match(f.errors.at(-1), /browser storage.*retry key/i)
    assert.equal(f.busy.at(-1), false)
  })
}
test('Verification retry authority stays scoped to the actor, run and decision', async () => {
  const f = fixture({ loseFirstResponse: true })
  await f.handler({ id: 'original' }, true)
  await f.handler({ id: 'other' }, true)
  await f.handler({ id: 'original' }, false)
  f.actor.id = 'other-reviewer'
  await f.handler({ id: 'original' }, true)
  assert.equal(new Set(f.requests.map((request) => request.body.decision_key)).size, 4)
  assert.equal(f.stored.size, 1, 'Retain the original uncertain decision for its exact retry')
})

