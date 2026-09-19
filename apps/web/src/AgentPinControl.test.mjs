import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const source = await readFile(new URL('./AgentPinControl.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText
function component() {
  const exports = {}
  const states = []
  const require = (name) => name === 'react'
    ? { useState: () => [false, (value) => states.push(value)] }
    : name === 'react/jsx-runtime' ? jsxRuntime : assert.fail(`Unexpected import ${name}`)
  new Function('require', 'exports', compiled)(require, exports)
  return { Control: exports.AgentPinControl, states }
}
const agent = { id: 'a', name: 'Engineer', role: 'engineer', adapter: 'fake-process',
  status: 'idle', current_run_id: null, mission_id: 'mission', pinned: false, pin_version: 0 }
const button = (tree) => tree.props.children[0]

test('Pin/Unpin states use existing button styling and explicit retention copy', () => {
  const { Control } = component()
  for (const pinned of [false, true]) {
    const element = Control({ agent: { ...agent, pinned }, canOperate: true, onPin: async () => {} })
    const html = renderToStaticMarkup(element)
    assert.match(html, /button button-secondary/)
    assert.match(html, pinned ? /Unpin Engineer/ : /Pin Engineer/)
    assert.match(html, /in this room/)
    assert.equal(button(element).props.disabled, false)
  }
})

test('active runs are not a reason to disable safe retention changes', async () => {
  const { Control, states } = component()
  const active = { ...agent, pinned: true, status: 'working', current_run_id: 'run' }
  const calls = []
  const element = Control({ agent: active, canOperate: true, onPin: async (...args) => calls.push(args) })
  assert.match(renderToStaticMarkup(element), /never stops active work or releases its obligations/)
  await button(element).props.onClick()
  assert.deepEqual(calls, [[active, false]])
  assert.deepEqual(states, [true, false])
})

test('non-operators and unknown versions cannot advertise a mutation', () => {
  const { Control } = component()
  for (const [canOperate, version] of [[false, 0], [true, undefined], [true, -1], [true, NaN], [true, 0.5]]) {
    const element = Control({ agent: { ...agent, pin_version: version }, canOperate, onPin: async () => {} })
    assert.equal(button(element).props.disabled, true)
  }
})

test('retired historical identities have no resurrection button', () => {
  const { Control } = component()
  assert.equal(Control({ agent: { ...agent, retired_at: '2026-09-19T00:00:00Z' }, canOperate: true, onPin: async () => {} }), null)
})

test('Corp identity copy does not promise automatic retirement on unpin', () => {
  const { Control } = component()
  for (const pinned of [false, true]) {
    assert.match(renderToStaticMarkup(Control({ agent: { ...agent, pinned, mission_id: null }, canOperate: true, onPin: async () => {} })),
      /unpinning does not retire a Corp identity/)
  }
})

test('failed request leaves button usable after its pending state', async () => {
  const { Control, states } = component()
  const element = Control({ agent, canOperate: true, onPin: async () => { throw new Error('fixture') } })
  await assert.rejects(button(element).props.onClick(), /fixture/)
  assert.deepEqual(states, [true, false])
})
