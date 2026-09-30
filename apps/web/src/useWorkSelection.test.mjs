import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import * as selection from './workSelection.ts'
import { renderHooks } from './testSupport/renderHooks.mjs'

const compiled = ts.transpileModule(await readFile(new URL('./useWorkSelection.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const a = { server: 'http://fixture.invalid', corpId: id(1), actorId: id(2) }
const b = { ...a, actorId: id(3) }
const first = { missionId: id(10), taskId: id(20), runId: id(30) }
const second = { missionId: id(11), taskId: id(21), runId: id(31) }
function fixture(initial = new Map(), fails = false) {
  const hooks = renderHooks(), writes = [], exports = {}
  const sessionStorage = { getItem: (key) => initial.get(key) ?? null,
    setItem(key, value) { if (fails) throw new Error('blocked'); initial.set(key, value); writes.push([key, value]) } }
  const require = (name) => name === 'react' ? hooks.react : name === './workSelection' ? selection : assert.fail(name)
  new Function('require', 'exports', 'window', compiled)(require, exports, { sessionStorage })
  let scope = a
  return { hooks, writes, storage: initial,
    begin(next = scope) { scope = next; return hooks.begin(() => exports.useWorkSelection(scope)) },
    render(next = scope) { scope = next; return hooks.render(() => exports.useWorkSelection(scope)) } }
}

test('restoration masks old scope before effects and never leaks an A choice into B', () => {
  const f = fixture(new Map([[selection.workSelectionKey(a), JSON.stringify(first)],
    [selection.workSelectionKey(b), JSON.stringify(second)]]))
  assert.equal(f.begin().selection, selection.UNAVAILABLE_WORK_SELECTION)
  assert.deepEqual(f.hooks.flush().selection, first)
  const beforeSwitch = f.hooks.value.remember
  assert.equal(f.begin(b).selection, selection.UNAVAILABLE_WORK_SELECTION)
  f.hooks.commit()
  assert.equal(beforeSwitch(second), false)
  assert.deepEqual(f.hooks.flush().selection, second)
  assert.equal(f.writes.length, 0)
})

test('a newer choice fences stale asynchronous callbacks, including before rerender', () => {
  const f = fixture()
  const empty = f.render()
  assert.equal(empty.selection, null)
  assert.equal(empty.remember(first), true)
  assert.equal(empty.remember(second), false, 'the stale callback is fenced in the same event turn')
  const current = f.hooks.flush()
  assert.deepEqual(current.selection, first)
  assert.equal(current.remember(second), true)
  assert.deepEqual(f.hooks.flush().selection, second)
  assert.deepEqual(JSON.parse(f.storage.get(selection.workSelectionKey(a))), second)
})

test('A to B to A cannot revive a callback from the first A incarnation', () => {
  const f = fixture()
  f.render().remember(first)
  const stale = f.hooks.flush().remember
  assert.equal(f.render(b).selection, null)
  assert.deepEqual(f.render(a).selection, first)
  assert.equal(stale(second), false)
  assert.equal(f.hooks.value.remember(second), true)
  assert.deepEqual(f.hooks.flush().selection, second)
})

test('remembering the same tuple does not invalidate a current action callback', () => {
  const f = fixture()
  f.render().remember(first)
  const current = f.hooks.flush()
  assert.equal(current.remember({ ...first }), true)
  assert.equal(current.remember(second), true)
  assert.deepEqual(f.hooks.flush().selection, second)
})

test('StrictMode repeated setup restores once per setup and keeps the newest callback usable', () => {
  const f = fixture(new Map([[selection.workSelectionKey(a), JSON.stringify(first)]]))
  f.render()
  const current = f.hooks.replayEffects()
  assert.deepEqual(current.selection, first)
  assert.equal(current.remember(second), true)
  assert.deepEqual(f.hooks.flush().selection, second)
  f.hooks.unmount()
  assert.equal(f.hooks.value.remember(first), false)
})

test('missing identity and blocked storage fail without altering the selected tuple', () => {
  const f = fixture(new Map([[selection.workSelectionKey(a), '{']]), true)
  assert.equal(f.render().selection, selection.UNAVAILABLE_WORK_SELECTION)
  assert.equal(f.hooks.value.remember(first), false)
  assert.equal(f.hooks.flush().selection, selection.UNAVAILABLE_WORK_SELECTION)
  assert.equal(f.render({ ...a, actorId: '' }).remember(first), false)
  assert.equal(f.render({ ...a, corpId: '' }).remember(first), false)
  assert.equal(f.writes.length, 0)
})
