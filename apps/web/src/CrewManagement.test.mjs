import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { isValidElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as model from './crewRetirement.ts'

const compiled = ts.transpileModule(await readFile(new URL('./CrewManagement.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023 },
}).outputText
const context = () => ({ server: 'http://127.0.0.1:19348', corpId: randomUUID(), actorId: randomUUID() })
const agent = (properties = {}) => ({ id: randomUUID(), name: 'Worker', role: 'engineer', adapter: 'fake-process',
  status: 'idle', current_run_id: null, pin_version: 0, ...properties })
function storage() {
  const values = new Map()
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}
const response = (operation) => ({ replayed: false, results: operation.targets.map((target) => ({
  agent_id: target.agent_id, status: 'retired', blockers: [], retired_at: '2026-09-29T10:00:00Z',
  pinned: false, pin_version: target.expected_pin_version,
})) })
const elements = (node) => Array.isArray(node) ? node.flatMap(elements)
  : isValidElement(node) ? [node, ...elements(node.props.children)] : []
const text = (node) => Array.isArray(node) ? node.map(text).join('')
  : isValidElement(node) ? text(node.props.children) : node == null || typeof node === 'boolean' ? '' : String(node)

// Run production callbacks with controlled hook scheduling. Browser focus,
// network authorization and native acceptance are exercised in the separate stack lane.
function harness(overrides = {}, suppliedStorage = storage()) {
  const states = [], refs = [], effects = [], requests = [], refreshes = [], missions = []
  let stateIndex, refIndex, effectIndex, stateWrites = 0
  const props = { scope: context(), agents: [agent()], runs: [], canOperate: true, snapshotCurrent: true,
    onRequest: async (operation) => { requests.push(model.retirementRequest(operation)); return response(operation) },
    onRefresh: async () => { refreshes.push(true) }, onMission: (id) => missions.push(id), ...overrides }
  const imports = {
    react: {
      useState(initial) {
        const index = stateIndex++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], (value) => { stateWrites++; states[index] = typeof value === 'function' ? value(states[index]) : value }]
      },
      useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial } },
      useEffect(setup) { const index = effectIndex++; if (!(index in effects)) effects[index] = setup() },
    },
    'react/jsx-runtime': jsxRuntime, './crewRetirement': model, './CrewManagement.css': {},
  }
  const exports = {}
  new Function('require', 'exports', 'window', 'crypto', compiled)((name) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`)
    return imports[name]
  }, exports, { get sessionStorage() { return suppliedStorage } }, { randomUUID })
  const render = () => { stateIndex = refIndex = effectIndex = 0; return exports.CrewManagement(props) }
  const find = (label) => {
    const buttons = elements(render()).filter((node) => node.type === 'button' && (node.props['aria-label'] ?? text(node)) === label)
    assert.equal(buttons.length, 1, label)
    return buttons[0]
  }
  return { render, props, requests, refreshes, missions, storage: suppliedStorage,
    button: find, html: () => renderToStaticMarkup(render()), unmount: () => effects.forEach((cleanup) => cleanup?.()),
    get stateWrites() { return stateWrites },
    async click(label) { const button = find(label); assert.equal(button.props.disabled ?? false, false); button.props.onClick(); await setImmediate() },
  }
}

test('crew renders lifecycle and history separately and retains mission navigation', async () => {
  const mission = randomUUID()
  const h = harness({ agents: [agent({ name: 'Off shift', pinned: true }), agent({ name: 'Starting', status: 'starting' }),
    agent({ name: 'Running', current_run_id: randomUUID() }),
    agent({ name: 'Historical', retired_at: '2026-09-29T10:00:00Z', mission_id: mission })] })
  const html = h.html()
  for (const copy of ['Current identities (3)', 'Retired history (1)', 'Provisioning', 'Live', 'Off shift · Pinned']) assert.ok(html.includes(copy), copy)
  assert.ok(!html.includes('aria-label="Retire Historical"'))
  assert.equal(h.button('Retire Off shift').props.disabled, false)
  await h.click('View mission for Historical')
  assert.deepEqual(h.missions, [mission])
  const empty = harness({ agents: [] })
  assert.match(empty.html(), /crew is empty/)
  assert.equal(empty.button('Clear crew').props.disabled, true)
})

test('permissions, uncertain snapshots, unavailable versions and oversized rosters cannot send mutations', () => {
  for (const overrides of [{ canOperate: false }, { snapshotCurrent: false }, { agents: [agent({ pin_version: undefined })] }]) {
    const h = harness(overrides)
    assert.equal(h.button('Clear crew').props.disabled, true)
    assert.equal(h.button('Retire Worker').props.disabled, true)
    assert.equal(h.requests.length, 0)
  }
  const h = harness({ agents: Array.from({ length: 101 }, (_, index) => agent({ name: `Identity ${index}` })) })
  assert.equal(h.button('Clear crew').props.disabled, true)
  assert.match(h.html(), /Current identities \(101\)/)
  assert.equal(elements(h.render()).filter((node) => node.props?.['aria-label']?.startsWith('Retire ')).length, 101)
  assert.equal(h.button('Retire Identity 100').props.disabled, false)
})

test('storage failures cause no API call, including write failure after the initial successful read', async () => {
  for (const store of [
    { getItem() { throw new Error('read denied') }, setItem() {} },
    { getItem() { return null }, setItem() { throw new Error('quota') } },
  ]) {
    const h = harness({}, store)
    if (!h.button('Clear crew').props.disabled) await h.click('Clear crew')
    assert.equal(h.requests.length, 0)
    assert.match(h.html(), /storage/i)
  }
})

test('lost response survives roster replacement and reload, then retries identical request bytes', async () => {
  const calls = [], s = storage(), scope = context(), oldAgent = agent({ name: 'Old worker', pin_version: 4 })
  const h = harness({ scope, agents: [oldAgent], onRequest: async (operation) => {
    calls.push(model.retirementRequest(operation)); throw new Error('Response lost after commit')
  } }, s)
  await h.click('Clear crew')
  assert.equal(h.button('Clear crew').props.disabled, true)
  assert.match(h.html(), /no confirmed outcome/)
  h.unmount()
  const reloaded = harness({ scope, agents: [agent({ name: 'New worker', pin_version: 9 })], onRequest: async (operation) => {
    calls.push(model.retirementRequest(operation)); return { ...response(operation), replayed: true }
  } }, s)
  assert.ok(reloaded.html().includes(oldAgent.id), 'removed identities remain identifiable in the saved request')
  await reloaded.click('Retry saved request')
  assert.deepEqual(calls[1], calls[0])
  assert.match(reloaded.html(), /Saved outcome recovered/)
  assert.match(reloaded.html(), /Current identities \(1\)/)
  assert.ok(reloaded.html().includes('New worker'), 'historical replay does not replace current state')
  assert.equal(reloaded.refreshes.length, 1)
})

test('double click sends one request; a late response stays with its original actor after unmount', async () => {
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const s = storage(), calls = []
  const h = harness({ onRequest: async (operation) => { calls.push(operation); return pending } }, s)
  const originalButton = h.button('Clear crew')
  originalButton.props.onClick()
  originalButton.props.onClick()
  assert.equal(calls.length, 1)
  h.unmount()
  const writes = h.stateWrites
  const other = harness({ scope: { ...h.props.scope, actorId: randomUUID() } }, s)
  assert.equal(other.button('Clear crew').props.disabled, false)
  finish(response(calls[0]))
  await setImmediate()
  assert.equal(h.stateWrites, writes)
  assert.equal(h.refreshes.length, 0)
  assert.equal(other.refreshes.length, 0)
  assert.ok(model.readRetirementOperations(s, h.props.scope)[0].response)
  assert.deepEqual(model.readRetirementOperations(s, other.props.scope), [])
})

test('malformed responses keep the pending request and explain blocked responses once confirmed', async () => {
  const h = harness({ onRequest: async () => ({ replayed: false, results: [] }) })
  await h.click('Clear crew')
  assert.match(h.html(), /outcome for every requested identity/)
  assert.equal(h.button('Clear crew').props.disabled, true)
  h.props.onRequest = async (operation) => ({ replayed: true, results: response(operation).results.map((result) => ({
    ...result, status: 'blocked', retired_at: null, blockers: ['active_run', 'provider_teardown'],
  })) })
  await h.click('Retry saved request')
  assert.match(h.html(), /0 retired, 1 blocked/)
  assert.match(h.html(), /run has not reached a terminal state/)
  assert.match(h.html(), /Provider shutdown has not been confirmed/)
  assert.equal(h.button('Clear crew').props.disabled, false)
})

test('denied requests preserve exact retries while unrelated identities remain operable after refresh and reload', async () => {
  for (const previouslyAmbiguous of [false, true]) {
    const calls = [], scope = context(), s = storage()
    const denied = agent({ name: 'Revoked room worker' }), allowed = agent({ name: 'Authorized worker' })
    const onRequest = async (operation) => {
      calls.push(model.retirementRequest(operation))
      if (operation.targets.some((target) => target.agent_id === denied.id)) {
        if (previouslyAmbiguous && calls.length === 1) throw new Error('Response lost after commit')
        throw Object.assign(new Error('Actor is not a member of this room'), { status: 403 })
      }
      return response(operation)
    }
    const h = harness({ scope, agents: [denied, allowed], onRequest }, s)
    await h.click('Retire Revoked room worker')
    if (previouslyAmbiguous) await h.click('Retry saved request')
    assert.equal(h.button('Retire Revoked room worker').props.disabled, true)
    assert.equal(h.button('Retire Authorized worker').props.disabled, false)
    assert.equal(h.button('Clear crew').props.disabled, true, 'Clear must include every visible current identity')
    h.props.agents = [allowed]
    await h.click('Refresh crew')
    h.unmount()
    const reloaded = harness({ scope, agents: [allowed], onRequest }, s)
    assert.equal(reloaded.button('Retire Authorized worker').props.disabled, false)
    assert.equal(reloaded.button('Clear crew').props.disabled, false)
    await reloaded.click('Clear crew')
    assert.deepEqual(JSON.parse(calls.at(-1).body).targets.map((target) => target.agent_id), [allowed.id])
    assert.match(reloaded.html(), /1 retired, 0 blocked/)
    assert.match(reloaded.html(), /no confirmed outcome/, 'The uncertain original still has an exact retry')
    await reloaded.click('Retry saved request')
    assert.deepEqual(calls.at(-1), calls[0])
    assert.equal(model.readRetirementOperations(s, scope).filter((operation) => !operation.response).length, 1)
    reloaded.props.onRequest = async (operation) => {
      calls.push(model.retirementRequest(operation))
      return { ...response(operation), replayed: true }
    }
    await reloaded.click('Retry saved request')
    assert.deepEqual(calls.at(-1), calls[0])
    assert.doesNotMatch(reloaded.html(), /no confirmed outcome/)
    assert.match(reloaded.html(), /Saved outcome recovered/)
  }
})

test('multiple unknown outcomes remain individually retryable and survive unrelated responses', async () => {
  const a = agent({ name: 'First' }), b = agent({ name: 'Second' }), c = agent({ name: 'Third' })
  const calls = [], s = storage(), scope = context()
  const h = harness({ scope, agents: [a, b, c], onRequest: async (operation) => {
    calls.push(model.retirementRequest(operation)); throw new Error('Response lost')
  } }, s)
  await h.click('Retire First')
  await h.click('Retire Second')
  assert.equal(h.button('Retire First').props.disabled, true)
  assert.equal(h.button('Retire Second').props.disabled, true)
  assert.equal(h.button('Retire Third').props.disabled, false)
  h.unmount()
  const reloaded = harness({ scope, agents: [c], onRequest: async (operation) => {
    calls.push(model.retirementRequest(operation)); return { ...response(operation), replayed: true }
  } }, s)
  await reloaded.click('Retry saved request 2')
  assert.deepEqual(calls[2], calls[1])
  assert.deepEqual(model.readRetirementOperations(s, scope).filter((operation) => !operation.response).map(model.retirementRequest), [calls[0]])
  await reloaded.click('Retire Third')
  assert.deepEqual(model.readRetirementOperations(s, scope).filter((operation) => !operation.response).map(model.retirementRequest), [calls[0]])
  await reloaded.click('Retry saved request')
  assert.deepEqual(calls.at(-1), calls[0])
  assert.equal(model.readRetirementOperations(s, scope).filter((operation) => !operation.response).length, 0)
})
