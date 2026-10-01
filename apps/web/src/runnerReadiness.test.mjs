import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

// Execute the production list without mounting the unrelated application state.
const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const lists = []
let adapterLabel
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'adapterLabel') adapterLabel = node.getText(parsed)
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(parsed) === 'ul'
    && node.getText(parsed).includes('runner.capabilities')) lists.push(node.getText(parsed))
  ts.forEachChild(node, visit)
}
visit(parsed)
assert.equal(lists.length, 1, 'locate the actual runner capability list')
assert.ok(adapterLabel)
const compiled = ts.transpileModule(`${adapterLabel}\nexport function render(runner) { return (${lists[0]}); }`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText
const exported = {}
new Function('require', 'exports', compiled)((name) => {
  assert.equal(name, 'react/jsx-runtime')
  return jsxRuntime
}, exported)
const rows = (capabilities) => exported.render({ capabilities }).props.children
const capability = (workspace_connection_id, overrides = {}) => ({
  name: 'github-copilot', available: true, workspace_connection_id,
  detail: 'Native account and model catalog checked; inference has not been tested.',
  models: [{ id: 'auto', policy_state: 'enabled' }, { id: 'blocked', policy_state: 'disabled' }],
  source_repository: 'https://github.com/example/owned-fixture', source_base_ref: 'main',
  source_base_commit: 'a'.repeat(40), ...overrides,
})
const firstId = '19800000-0000-4000-8000-000000000001'
const secondId = '19800000-0000-4000-8000-000000000002'

test('base and multiple saved connections keep distinct identities and authoritative readiness', () => {
  const entries = [
    capability(null, { available: false, models: [] }), capability(firstId), capability(secondId),
    capability(firstId, { name: 'workspace-isolation', models: [] }),
  ]
  const rendered = rows(entries)
  assert.equal(rendered.length, 3, 'only the isolation detail is excluded')
  assert.equal(new Set(rendered.map((row) => row.key)).size, 3)
  const html = rendered.map((row) => renderToStaticMarkup(row))
  assert.match(html[0], /GitHub Copilot/)
  assert.match(html[0], /Base installation/)
  assert.match(html[0], /Unavailable/)
  for (const [index, id] of [[1, firstId], [2, secondId]]) {
    assert.match(html[index], /GitHub Copilot/)
    assert.match(html[index], new RegExp(`Saved connection ${id}`))
    assert.match(html[index], /Ready/)
    assert.match(html[index], /1 selectable models/)
  }
})

test('refresh, reorder and retest update status without replacing connection identity', () => {
  const before = [capability(null, { available: false }), capability(firstId), capability(secondId)]
  const keys = rows(before).map((row) => row.key)
  assert.equal(new Set(keys).size, 3)
  const refreshed = structuredClone(before).reverse().map((entry) => ({
    ...entry, available: !entry.available, models: [], detail: 'Retested', source_base_commit: 'b'.repeat(40),
  }))
  const after = rows(refreshed)
  assert.deepEqual(after.map((row) => row.key), [...keys].reverse())
  assert.match(renderToStaticMarkup(after[0]), new RegExp(`Saved connection ${secondId}`))
  assert.match(renderToStaticMarkup(after[0]), /Unavailable/)
  assert.match(renderToStaticMarkup(after[2]), /Base installation/)
  assert.match(renderToStaticMarkup(after[2]), /Ready/)
  assert.doesNotMatch(renderToStaticMarkup(after[0]), /selectable models/)
})

test('omitted and null connection scope identify the same base installation', () => {
  const withNull = rows([capability(null)])[0]
  const withoutId = rows([capability(undefined)])[0]
  assert.equal(withNull.key, withoutId.key)
  assert.match(renderToStaticMarkup(withoutId), /Base installation/)
  assert.doesNotMatch(renderToStaticMarkup(withoutId), /Saved connection/)
})

test('provider remains part of identity within the same saved connection', () => {
  const rendered = rows([capability(firstId), capability(firstId, { name: 'codex' })])
  assert.notEqual(rendered[0].key, rendered[1].key)
  assert.match(renderToStaticMarkup(rendered[0]), /GitHub Copilot/)
  assert.match(renderToStaticMarkup(rendered[1]), /OpenAI Codex/)
})
