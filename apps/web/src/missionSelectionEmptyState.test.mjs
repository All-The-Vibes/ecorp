import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const candidates = []
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((property) =>
    ts.isJsxAttribute(property) && property.name.text === 'className' &&
    property.initializer && ts.isStringLiteral(property.initializer) && property.initializer.text === 'empty-state') &&
    node.getText(ast).includes('Selected mission unavailable')) candidates.push(node.getText(ast))
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(candidates.length, 1, 'Exercise the actual mission fallback rendered by App')
const code = ts.transpileModule(`export const view = (selectedMissionId, missionChoices) => (${candidates[0]})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const exports = {}
new Function('require', 'exports', code)((name) => {
  assert.equal(name, 'react/jsx-runtime')
  return jsxRuntime
}, exports)

test('first visit with authorized missions invites an explicit selection', () => {
  const html = renderToStaticMarkup(exports.view(null, [{ id: 'available-mission' }]))
  assert.match(html, /Choose a mission/u)
  assert.match(html, /Select a mission/u)
  assert.doesNotMatch(html, /No missions yet|Start with a concrete outcome/u)
})

test('an actually empty mission view retains the create-mission guidance', () => {
  const html = renderToStaticMarkup(exports.view(null, []))
  assert.match(html, /No missions yet/u)
  assert.match(html, /Start with a concrete outcome/u)
})

test('a remembered unavailable mission is never replaced by an available one', () => {
  for (const choices of [[], [{ id: 'different-mission' }]]) {
    const html = renderToStaticMarkup(exports.view('unavailable-mission', choices))
    assert.match(html, /Selected mission unavailable/u)
    assert.match(html, /not.*substituted automatically/u)
    assert.doesNotMatch(html, /No missions yet|Start with a concrete outcome/u)
  }
})
