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
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'setAgentPin') initializer = node.initializer
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(initializer, 'Exercise the actual App Pin callback')
const code = ts.transpileModule(`${helpers}\nconst setAgentPin = ${initializer.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2023 },
}).outputText
function fixture({ readFails = false, writeFails = false, loseFirstResponse = false } = {}) {
  const stored = new Map(), errors = [], requests = []
  const sessionStorage = {
    getItem(key) { if (readFails) throw new Error('Storage disabled'); return stored.get(key) ?? null },
    setItem(key, value) { if (writeFails) throw new Error('Quota exceeded'); stored.set(key, value) },
    removeItem(key) { stored.delete(key) },
  }
  const api = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    if (loseFirstResponse && requests.length === 1) throw new Error('Response lost after commit')
  }
  const handler = new Function('window', 'crypto', 'bootstrap', 'selectedActor', 'setError', 'api', 'refresh', 'ApiRequestError',
    `${code}; return setAgentPin;`)({ sessionStorage }, { randomUUID }, { corp_id: 'corp' }, { id: 'actor' },
    (error) => errors.push(error), api, async () => {}, class ApiRequestError extends Error {})
  return { handler, stored, errors, requests }
}
const agent = { id: 'agent', pin_version: 7 }
for (const failure of ['readFails', 'writeFails']) {
  test(`Pin reports ${failure} before issuing a mutation`, async () => {
    const f = fixture({ [failure]: true })
    await f.handler(agent, true)
    assert.equal(f.requests.length, 0, 'No request may use a key that cannot be persisted')
    assert.match(f.errors.at(-1), /browser storage.*retry key/i)
    assert.equal(f.stored.size, 0)
  })
}
test('Pin retries a lost response with the same saved request key and clears only after success', async () => {
  const f = fixture({ loseFirstResponse: true })
  await f.handler(agent, true)
  assert.equal(f.stored.size, 1)
  assert.match(f.errors.at(-1), /Response lost/)
  await f.handler(agent, true)
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.requests[1], f.requests[0])
  assert.equal(f.stored.size, 0)
})
