import assert from 'node:assert/strict'
import test from 'node:test'
import {
  missionWorkSelection, readWorkSelection, rememberWorkSelection, UNAVAILABLE_WORK_SELECTION,
  validWorkSelection, workSelectionForLink, workSelectionKey,
} from './workSelection.ts'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope = { server: 'http://fixture.invalid', corpId: id(1), actorId: id(2) }
const selected = { missionId: id(10), taskId: id(20), runId: id(30) }
const context = { missions: [{ id: id(10) }, { id: id(11) }],
  tasks: [{ id: id(20), mission_id: id(10) }, { id: id(21), mission_id: id(11) }],
  runs: [{ id: id(30), task_id: id(20), artifact_id: id(40) }, { id: id(31), task_id: id(21), artifact_id: id(41) }] }
function storage() {
  const values = new Map(), writes = []
  return { values, writes, getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { writes.push([key, value]); values.set(key, value) } }
}

test('one exact tuple survives reload and is scoped to server, Corp and viewer', () => {
  const store = storage(), key = workSelectionKey(scope)
  assert.equal(readWorkSelection(() => store, key), null)
  assert.equal(rememberWorkSelection(() => store, key, selected), true)
  assert.deepEqual(readWorkSelection(() => store, key), selected)
  assert.deepEqual(store.writes, [[key, JSON.stringify(selected)]])
  for (const field of Object.keys(scope)) {
    const otherKey = workSelectionKey({ ...scope, [field]: `${scope[field]}:other` })
    assert.notEqual(otherKey, key)
    assert.equal(readWorkSelection(() => store, otherKey), null)
  }
  assert.notEqual(workSelectionKey({ ...scope, corpId: 'a:b', actorId: 'c' }),
    workSelectionKey({ ...scope, corpId: 'a', actorId: 'b:c' }))
})

test('incomplete, malformed and inaccessible storage never becomes a first visit', () => {
  const invalid = [null, [], 'run-id', {}, { ...selected, missionId: 'bad' },
    { ...selected, taskId: null }, { ...selected, runId: 'bad' }, { ...selected, taskId: 'bad' },
    { ...selected, authority: 'not-authority' }, { missionId: id(10) }]
  for (const value of invalid) {
    assert.equal(validWorkSelection(value), false)
    assert.equal(readWorkSelection(() => ({ getItem: () => JSON.stringify(value) }), 'k'), UNAVAILABLE_WORK_SELECTION)
    assert.equal(rememberWorkSelection(() => { assert.fail('invalid values must not reach storage') }, 'k', value), false)
  }
  for (const value of ['', '{', 'x'.repeat(257)]) {
    assert.equal(readWorkSelection(() => ({ getItem: () => value }), 'k'), UNAVAILABLE_WORK_SELECTION)
  }
  assert.equal(readWorkSelection(() => { throw new Error('blocked') }, 'k'), UNAVAILABLE_WORK_SELECTION)
  assert.equal(rememberWorkSelection(() => { throw new Error('blocked') }, 'k', selected), false)
  assert.equal(rememberWorkSelection(() => ({ setItem() { throw new Error('quota') } }), 'k', selected), false)
  for (const choice of [{ missionId: id(10), taskId: null, runId: null },
    { missionId: id(10), taskId: id(20), runId: null }]) assert.equal(validWorkSelection(choice), true)
})

test('exact run and artifact links resolve the producer through the authorized snapshot', () => {
  assert.deepEqual(workSelectionForLink({ kind: 'run', id: id(31) }, context, selected),
    { missionId: id(11), taskId: id(21), runId: id(31) })
  assert.deepEqual(workSelectionForLink({ kind: 'artifact', id: id(40) }, context, null), selected)
  for (const kind of ['run', 'artifact', 'task', 'mission']) {
    assert.equal(workSelectionForLink({ kind, id: id(99) }, context, selected), null)
  }
  for (const changes of [{ tasks: [] }, { missions: [] }, { runs: [] }]) {
    assert.equal(workSelectionForLink({ kind: 'run', id: id(30) }, { ...context, ...changes }, selected), null)
  }
})

test('task selection clears another run and mission-only navigation retains an exact existing choice', () => {
  assert.deepEqual(workSelectionForLink({ kind: 'task', id: id(21) }, context, selected),
    { missionId: id(11), taskId: id(21), runId: null })
  assert.equal(workSelectionForLink({ kind: 'mission', id: id(10) }, context, selected), selected)
  assert.deepEqual(workSelectionForLink({ kind: 'mission', id: id(11) }, context, selected),
    { missionId: id(11), taskId: null, runId: null })
  assert.deepEqual(missionWorkSelection(null, id(10)), { missionId: id(10), taskId: null, runId: null })
})
