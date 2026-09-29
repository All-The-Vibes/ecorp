import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  crewLifecycle, MAX_CLEAR_CREW_TARGETS, prepareRetirementOperation,
  readRetirementOperations, recordRetirementResponse, retirementBlockers,
  retirementRequest, retirementScopeKey, validateRetirementResponse,
} from './crewRetirement.ts'

const scope = () => ({ server: 'http://127.0.0.1:19348', corpId: randomUUID(), actorId: randomUUID() })
const agent = (properties = {}) => ({ id: randomUUID(), name: 'Worker', role: 'engineer',
  adapter: 'fake-process', status: 'idle', current_run_id: null, pin_version: 0, ...properties })
function storage() {
  const values = new Map()
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}
function outcome(operation, properties = {}) {
  return { replayed: false, results: operation.targets.map((target) => ({ agent_id: target.agent_id,
    status: 'retired', blockers: [], retired_at: '2026-09-29T10:00:00Z', pinned: false,
    pin_version: target.expected_pin_version, ...properties })) }
}

test('a lost Clear response preserves the exact targets, versions and key across roster changes and reload', () => {
  const s = storage(), context = scope(), a = agent(), b = agent({ pin_version: 7 })
  const operation = prepareRetirementOperation(s, context, 'clear', [a, b], randomUUID())
  const request = retirementRequest(operation), bytes = s.getItem(retirementScopeKey(context))
  // Another client pins A, removes B and adds C before the response is recovered.
  const current = [{ ...a, pinned: true, pin_version: 8 }, agent()]
  assert.throws(() => prepareRetirementOperation(s, context, 'clear', current, randomUUID()), /Retry the saved/)
  assert.equal(s.getItem(retirementScopeKey(context)), bytes)
  const [reloaded] = readRetirementOperations(s, { ...context })
  assert.deepEqual(retirementRequest(reloaded), request)
  const result = outcome(operation)
  result.replayed = true
  const completed = recordRetirementResponse(s, reloaded, result)
  assert.deepEqual(readRetirementOperations(s, context), [completed])
  assert.equal(current[0].pinned, true, 'historical results never mutate current roster data')
  const next = prepareRetirementOperation(s, context, 'clear', current, randomUUID())
  assert.notEqual(next.idempotency_key, operation.idempotency_key)
  assert.deepEqual(next.targets.map((target) => target.agent_id), current.map((item) => item.id))
})

test('server, Corp and actor partition pending requests; a substituted stored scope is rejected', () => {
  const s = storage(), context = scope()
  const operation = prepareRetirementOperation(s, context, 'retire', [agent()], randomUUID())
  for (const other of [{ ...context, server: 'http://127.0.0.1:19349' },
    { ...context, corpId: randomUUID() }, { ...context, actorId: randomUUID() }]) {
    assert.deepEqual(readRetirementOperations(s, other), [])
    s.setItem(retirementScopeKey(other), JSON.stringify(operation))
    assert.throws(() => readRetirementOperations(s, other), /invalid/)
  }
  assert.equal(readRetirementOperations(s, context)[0].idempotency_key, operation.idempotency_key)
})

test('requests require distinct explicit bounded targets and safe versions', () => {
  const context = scope(), a = agent()
  for (const targets of [[], [a, a], [a, { ...a, id: a.id.toUpperCase() }],
    [agent({ pin_version: undefined })], [agent({ pin_version: -1 })],
    [agent({ pin_version: Number.MAX_SAFE_INTEGER + 1 })], [agent({ pin_version: 0.5 })],
    [agent({ id: 'all' })], Array.from({ length: MAX_CLEAR_CREW_TARGETS + 1 }, () => agent())]) {
    const s = storage()
    assert.throws(() => prepareRetirementOperation(s, context, 'clear', targets, randomUUID()))
    assert.equal(s.values.size, 0)
  }
  assert.throws(() => prepareRetirementOperation(storage(), context, 'retire', [agent(), agent()], randomUUID()))
  assert.throws(() => prepareRetirementOperation(storage(), context, 'retire', [a], '00000000-0000-0000-0000-000000000000'))
  const bounded = prepareRetirementOperation(storage(), context, 'clear',
    Array.from({ length: MAX_CLEAR_CREW_TARGETS }, () => agent()), randomUUID())
  assert.equal(bounded.targets.length, MAX_CLEAR_CREW_TARGETS)
})

test('read, write and silent storage failures reject preparation before any request is returned', () => {
  for (const s of [
    { getItem() { throw new Error('denied') }, setItem() {} },
    { getItem() { return null }, setItem() { throw new Error('quota') } },
    { getItem() { return null }, setItem() {} },
    { getItem() { return 'broken JSON' }, setItem() {} },
  ]) assert.throws(() => prepareRetirementOperation(s, scope(), 'retire', [agent()], randomUUID()))
})

test('partial, duplicate, foreign and malformed results never consume a pending request', () => {
  const s = storage(), context = scope()
  const operation = prepareRetirementOperation(s, context, 'clear', [agent(), agent()], randomUUID())
  const bytes = s.getItem(retirementScopeKey(context))
  const mutations = [
    (result) => result.results.pop(),
    (result) => { result.results[1] = result.results[0] },
    (result) => { result.results[1].agent_id = randomUUID() },
    (result) => { result.results[0].status = 'completed' },
    (result) => { result.results[0].retired_at = null },
    (result) => { result.results[0].retired_at = 'tomorrow' },
    (result) => { result.results[0].blockers = ['active_run'] },
    (result) => { result.results[0].pin_version = -1 },
    (result) => { result.results[0].pinned = 'false' },
    (result) => { result.replayed = 'true' },
    (result) => { result.results[0] = { ...result.results[0], status: 'blocked', retired_at: null, blockers: [] } },
    (result) => { result.results[0] = { ...result.results[0], status: 'blocked', retired_at: null, blockers: ['unknown'] } },
    (result) => { result.results[0] = { ...result.results[0], status: 'blocked', retired_at: null, blockers: ['pinned', 'pinned'] } },
  ]
  for (const mutate of mutations) {
    const result = outcome(operation)
    mutate(result)
    assert.throws(() => recordRetirementResponse(s, operation, result))
    assert.equal(s.getItem(retirementScopeKey(context)), bytes)
    assert.equal(readRetirementOperations(s, context)[0].response, undefined)
  }
})

test('all known blocked outcomes are preserved and a new deliberate request can follow them', () => {
  const s = storage(), context = scope()
  const operation = prepareRetirementOperation(s, context, 'retire', [agent()], randomUUID())
  const blocked = outcome(operation, { status: 'blocked', retired_at: null, blockers: Object.keys(retirementBlockers) })
  assert.deepEqual(validateRetirementResponse(operation, blocked), blocked)
  recordRetirementResponse(s, operation, blocked)
  assert.ok(prepareRetirementOperation(s, context, 'retire', [agent()], randomUUID()))
  assert.throws(() => recordRetirementResponse(s, operation, outcome(operation)), /request changed/)
})

test('unrelated operations preserve every uncertain request and upgrade the single-request storage format', () => {
  const s = storage(), context = scope(), a = agent(), b = agent(), c = agent()
  const original = prepareRetirementOperation(s, context, 'retire', [a], randomUUID())
  // A previous app session stored this exact request before its response was lost.
  s.setItem(retirementScopeKey(context), JSON.stringify(original))
  const originalRequest = retirementRequest(original)
  const unrelated = prepareRetirementOperation(s, context, 'clear', [b, c], randomUUID())
  assert.equal(JSON.parse(s.getItem(retirementScopeKey(context))).version, 2)
  const reloaded = readRetirementOperations(s, context)
  assert.deepEqual(reloaded.map(retirementRequest), [originalRequest, retirementRequest(unrelated)])
  recordRetirementResponse(s, unrelated, outcome(unrelated))
  const after = readRetirementOperations(s, context)
  assert.deepEqual(retirementRequest(after[0]), originalRequest)
  assert.equal(after[0].response, undefined)
  assert.ok(after[1].response)
  const bytes = s.getItem(retirementScopeKey(context))
  assert.throws(() => prepareRetirementOperation(s, context, 'retire', [{ ...a, id: a.id.toUpperCase() }], randomUUID()), /Retry the saved/)
  assert.throws(() => prepareRetirementOperation(s, context, 'clear', [a, b, c], randomUUID()), /Retry the saved/)
  assert.equal(s.getItem(retirementScopeKey(context)), bytes, 'Clear never silently drops pending targets')
  const recovered = recordRetirementResponse(s, after[0], { ...outcome(original), replayed: true })
  assert.deepEqual(readRetirementOperations(s, context), [recovered])
  assert.ok(prepareRetirementOperation(s, context, 'retire', [a], randomUUID()))
})

test('multiple uncertain outcomes can be acknowledged in any order without erasing another retry', () => {
  const s = storage(), context = scope()
  const operations = Array.from({ length: 3 }, () => prepareRetirementOperation(s, context, 'retire', [agent()], randomUUID()))
  const requests = operations.map(retirementRequest)
  recordRetirementResponse(s, operations[1], outcome(operations[1]))
  assert.deepEqual(readRetirementOperations(s, context).filter((saved) => !saved.response).map(retirementRequest), [requests[0], requests[2]])
  recordRetirementResponse(s, operations[0], { ...outcome(operations[0]), replayed: true })
  assert.deepEqual(readRetirementOperations(s, context).filter((saved) => !saved.response).map(retirementRequest), [requests[2]])
  recordRetirementResponse(s, operations[2], outcome(operations[2]))
  assert.equal(readRetirementOperations(s, context).length, 1, 'Only the latest confirmed result needs client storage')
  assert.ok(readRetirementOperations(s, context)[0].response)
})

test('a mismatched response, reused key or malformed journal cannot overwrite saved operations', () => {
  const s = storage(), context = scope()
  const first = prepareRetirementOperation(s, context, 'retire', [agent()], randomUUID())
  const second = prepareRetirementOperation(s, context, 'retire', [agent()], randomUUID())
  const bytes = s.getItem(retirementScopeKey(context))
  assert.throws(() => recordRetirementResponse(s, first, outcome(second)), /incomplete or inconsistent/)
  assert.throws(() => recordRetirementResponse(s, { ...first, targets: second.targets }, outcome(second)), /request changed/)
  assert.throws(() => prepareRetirementOperation(s, context, 'retire', [agent()], first.idempotency_key.toUpperCase()), /distinct operation key/)
  assert.equal(s.getItem(retirementScopeKey(context)), bytes)
  for (const value of [{ version: 3, operations: [first] }, { version: 2, operations: [] },
    { version: 2, operations: null }, { version: 2, operations: [first, { ...second, idempotency_key: first.idempotency_key.toUpperCase() }] }]) {
    s.setItem(retirementScopeKey(context), JSON.stringify(value))
    assert.throws(() => readRetirementOperations(s, context))
  }
})

test('storage failure while acknowledging one outcome retains every original pending request', () => {
  const s = storage(), context = scope()
  const first = prepareRetirementOperation(s, context, 'retire', [agent()], randomUUID())
  const second = prepareRetirementOperation(s, context, 'retire', [agent()], randomUUID())
  const failing = { getItem: s.getItem, setItem() { throw new Error('quota') } }
  assert.throws(() => recordRetirementResponse(failing, second, outcome(second)), /storage could not preserve/i)
  assert.deepEqual(readRetirementOperations(s, context), [first, second])
  assert.throws(() => prepareRetirementOperation(failing, context, 'retire', [agent()], randomUUID()), /storage could not preserve/i)
  assert.deepEqual(readRetirementOperations(s, context), [first, second])
})

test('Retire uses one identity and an expected version; Clear uses the complete explicit list', () => {
  for (const mode of ['retire', 'clear']) {
    const context = scope(), agents = mode === 'retire' ? [agent({ pin_version: 11 })] : [agent(), agent()]
    const operation = prepareRetirementOperation(storage(), context, mode, agents, randomUUID())
    const { path, body } = retirementRequest(operation), parsed = JSON.parse(body)
    assert.equal(parsed.actor_id, context.actorId)
    assert.equal(parsed.idempotency_key, operation.idempotency_key)
    if (mode === 'retire') {
      assert.equal(path, `/api/corps/${context.corpId}/agents/${agents[0].id}/retire`)
      assert.equal(parsed.expected_pin_version, 11)
    } else {
      assert.equal(path, `/api/corps/${context.corpId}/agents/clear`)
      assert.deepEqual(parsed.targets, operation.targets)
    }
  }
})

test('crew lifecycle distinguishes retired history, provisioning, live work and off-shift identities', () => {
  assert.equal(crewLifecycle(agent({ retired_at: '2026-09-29T10:00:00Z', current_run_id: randomUUID() })), 'Retired')
  assert.equal(crewLifecycle(agent({ status: 'starting' })), 'Provisioning')
  assert.equal(crewLifecycle(agent({ current_run_id: randomUUID() }), 'provisioning'), 'Provisioning')
  assert.equal(crewLifecycle(agent({ current_run_id: randomUUID(), status: 'working' }), 'running'), 'Live')
  assert.equal(crewLifecycle(agent({ status: 'blocked' })), 'Needs attention')
  for (const status of ['idle', 'offline']) assert.equal(crewLifecycle(agent({ status })), 'Off shift')
})
