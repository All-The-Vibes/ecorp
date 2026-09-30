import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { app, find, evaluate, id, contract, policy, mission, task, run, text, panelHarness, saveHarness } from './contractRevisionHarness.mjs'

test('issue262 an open draft cannot silently adopt a refreshed contract version', async () => {
  const h = await panelHarness()
  h.button('Revise contract').props.onClick()
  h.edit('Revision reason', 'Clarify the acceptance evidence')
  h.replace({ task: { ...task(), contract_version: 3 }, mission: { ...mission(), specification_version: 3 } })
  await h.submit()
  assert.equal(h.requests.length, 0, 'stale draft must stay visible and require explicit reconciliation')
  assert.match(text(h.render()), /stale|changed|version conflict/i)
})

test('issue262 a lost-response retry preserves the exact request across reconnect and refreshed state', async () => {
  const h = await panelHarness()
  h.button('Revise contract').props.onClick()
  h.edit('Revision reason', 'Clarify the acceptance evidence')
  await h.submit()
  const reloaded = await panelHarness({ values: h.values })
  reloaded.replace({ task: { ...task(), contract_version: 3 }, mission: { ...mission(), specification_version: 3 } })
  await reloaded.submit()
  assert.equal(reloaded.requests.length, 1)
  assert.deepEqual(reloaded.requests[0], h.requests[0], 'the retry must not become a new request')
})

test('issue262 actual save handler retains server success and assigned version when refresh fails', async () => {
  const globals = {
    bootstrap: { corp_id: id(1) }, selectedActor: { id: id(4) },
    currentViewer: { current: { corpId: id(1), actorId: id(4) } },
    setBusy() {}, setError() {}, setAnnouncement() {},
    api: async () => ({ revision: { id: id(90), version: 9, mission_id: id(2), task_id: id(5) }, replayed: false }),
    refresh: async () => { throw new Error('Snapshot unavailable after save') },
    ApiRequestError: class extends Error {},
  }
  const handler = find(app, n => ts.isVariableDeclaration(n) && n.name.getText(app) === 'createContractRevision')
  evaluate('globalThis.save = ' + handler.initializer.getText(app), globals)
  const target = { scopeKey: 'owned', corpId: id(1), actorId: id(4), missionId: id(2), taskId: id(5), version: 2,
    missionVersion: 2, nextAction: 'redispatch', sourceRunId: null }
  const input = { task_id: id(5), expected_contract_version: 2, next_action: 'redispatch',
    source_run_id: null, idempotency_key: id(80), reason: 'Clarify', description: 'Original',
    contract: contract(), verification_policy: policy() }
  const result = handler.initializer.parameters.length === 3
    ? await globals.save(mission(), task(), input) : await globals.save(target, input)
  assert.equal(result.status, 'saved')
  assert.equal(result.version, 9, 'the server can advance past task version + 1')
  assert.match(result.refreshWarning, /Snapshot unavailable/)
})

function openDraft(h) {
  const button = h.button('Revise contract')
  assert.ok(button && !button.props.disabled)
  button.props.onClick()
  h.edit('Revision reason', 'Clarify the acceptance evidence')
}
const saved = { status: 'saved', id: id(90), version: 9, replayed: false }
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('issue262 remount refuses malformed saved warnings without sending or overwriting a request', async () => {
  const h = panelHarness({ props: { onRevise: async () => saved } })
  openDraft(h)
  await h.submit()
  assert.equal(h.requests.length, 1)
  const [[key, stored]] = h.values
  for (const refreshWarning of [{ detail: 'Malformed warning' }, [{ detail: 'Malformed warning' }], null, true, 7]) {
    const corrupted = JSON.parse(stored)
    corrupted.result.refreshWarning = refreshWarning
    const values = new Map([[key, JSON.stringify(corrupted)]])
    const reloaded = panelHarness({ values })
    assert.match(text(reloaded.render()), /Stored save result cannot be verified/)
    assert.equal(reloaded.draft(), undefined)
    assert.equal(reloaded.button('Revise contract').props.disabled, true)
    await reloaded.submit()
    assert.equal(reloaded.requests.length, 0)
    assert.equal(values.get(key), JSON.stringify(corrupted), 'Keep the original stored bytes for explicit recovery')
  }
})

test('issue262 explicit stale reconciliation keeps edits but captures the new baseline and a new key', async () => {
  const h = panelHarness()
  openDraft(h)
  h.edit('Mission description', 'My unsubmitted specification')
  const original = structuredClone(h.draft())
  const newTask = { ...task(), contract_version: 3, contract: { ...contract(), objective: 'New server objective' } }
  h.replace({ task: newTask, mission: { ...mission(), specification_version: 4, description: 'New server specification' } })
  assert.equal(h.button('Save revision').props.disabled, true)
  assert.equal(h.draft().target.version, 2)
  h.button('Use current baseline, keep edits').props.onClick()
  const current = h.draft()
  assert.equal(current.description, 'My unsubmitted specification')
  assert.equal(current.reason, original.reason)
  assert.equal(current.contractJson, original.contractJson)
  assert.equal(current.policyJson, original.policyJson)
  assert.equal(current.before.contract.objective, 'New server objective')
  assert.equal(current.before.description, 'New server specification')
  assert.equal(current.target.version, 3)
  assert.equal(current.target.missionVersion, 4)
  assert.notEqual(current.idempotencyKey, original.idempotencyKey)
  await h.submit()
  assert.equal(h.requests[0][1].expected_contract_version, 3)
})

test('issue262 hiding and remounting retains raw incomplete JSON and the exact unsent draft', () => {
  const h = panelHarness()
  openDraft(h)
  h.patch({ contractJson: '{"objective": "work in progress",' })
  const original = structuredClone(h.draft())
  h.button('Keep draft and close').props.onClick()
  assert.ok(h.button('Continue revision draft'))
  const reloaded = panelHarness({ values: h.values })
  assert.deepEqual(reloaded.draft(), original)
  assert.equal(reloaded.button('Save revision').props.disabled, true)
  assert.equal(h.requests.length, 0)
})

test('issue262 a definitive initial refusal permits correction with a fresh key', async () => {
  const h = panelHarness({ props: { onRevise: async () => ({ status: 'rejected', message: 'Invalid specification' }) } })
  openDraft(h)
  await h.submit()
  const rejected = structuredClone(h.requests[0])
  h.edit('Revision reason', 'Corrected specification')
  await h.submit()
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1][1].reason, 'Corrected specification')
  assert.notEqual(h.requests[1][1].idempotency_key, rejected[1].idempotency_key)
})

test('issue262 refusal of a previously uncertain replay never releases the original request for editing', async () => {
  const h = panelHarness()
  openDraft(h)
  await h.submit()
  const original = structuredClone(h.draft())
  h.replace({ onRevise: async () => ({ status: 'rejected', message: 'Actor no longer eligible' }) })
  await h.submit()
  h.edit('Revision reason', 'Must not replace an unconfirmed request')
  assert.equal(h.draft().reason, original.reason)
  assert.equal(h.draft().result.status, 'unknown')
  assert.deepEqual(h.draft().pending, original.pending)
  assert.match(text(h.render()), /earlier save is still unconfirmed/)
  assert.deepEqual(h.requests[1], h.requests[0])
})

test('issue262 replay can confirm a save after execution starts; its receipt fences further revisions', async () => {
  const h = panelHarness()
  openDraft(h)
  await h.submit()
  const reloaded = panelHarness({ values: h.values, props: {
    task: { ...task(), contract_version: 9, status: 'running' }, mission: { ...mission(), status: 'running' },
    runs: [run({ status: 'running' })], onRevise: async () => ({ ...saved, replayed: true }),
  } })
  await reloaded.submit()
  assert.deepEqual(reloaded.requests[0], h.requests[0])
  assert.equal(reloaded.draft().result.version, 9)
  assert.equal(reloaded.button('Save revision'), undefined)
  assert.equal(reloaded.button('Retry exact request'), undefined)
  assert.equal(reloaded.button('Start another revision').props.disabled, true)
  await reloaded.submit()
  assert.equal(reloaded.requests.length, 1)
})

test('issue262 successful receipt uses the assigned version and awaits a refreshed baseline', async () => {
  const h = panelHarness({ props: { onRevise: async () => saved } })
  openDraft(h)
  await h.submit()
  assert.match(text(h.render()), /Saved revision v9/)
  assert.equal(h.button('Start another revision').props.disabled, true)
  h.button('Start another revision').props.onClick()
  assert.equal(h.draft().result.version, 9)
  h.replace({ task: { ...task(), contract_version: 9 }, mission: { ...mission(), specification_version: 9 } })
  h.button('Start another revision').props.onClick()
  assert.equal(h.draft().target.version, 9)
  assert.equal(h.draft().result, null)
  assert.equal(h.draft().reason, '')
})

test('issue262 duplicate same-tick submissions produce one mutation and one retained body', async () => {
  const response = deferred()
  const h = panelHarness({ props: { onRevise: () => response.promise } })
  openDraft(h)
  const first = h.submit(), second = h.submit()
  assert.equal(h.requests.length, 1)
  h.edit('Revision reason', 'Must not alter an in-flight request')
  assert.equal(h.draft().reason, h.requests[0][1].reason)
  response.resolve({ status: 'unknown', message: 'Connection lost' })
  await Promise.all([first, second])
  assert.deepEqual(h.draft().pending, h.requests[0][1])
})

test('issue262 unavailable or unreadable storage prevents sending and never deletes stored data', async () => {
  for (const kind of ['read-failure', 'malformed-json', 'wrong-scope']) {
    let writes = 0
    const storage = { getItem() {
      if (kind === 'read-failure') throw new Error('Storage blocked')
      return kind === 'malformed-json' ? '{"broken":' : JSON.stringify({ schema: 1, target: { scopeKey: 'other' } })
    }, setItem() { writes++ } }
    const h = panelHarness({ storage })
    assert.equal(h.button('Revise contract').props.disabled, true)
    await h.submit()
    assert.equal(h.requests.length, 0)
    assert.equal(writes, 0)
    assert.match(text(h.render()), /storage is unavailable or cannot be verified/)
  }
})

test('issue262 storage write failure or changed readback never sends an unpreserved mutation', async () => {
  for (const mismatch of [false, true]) {
    let stored = null
    const h = panelHarness({ storage: {
      getItem: () => stored,
      setItem(_key, value) { if (!mismatch) throw new Error('Quota exceeded'); stored = value + 'changed' },
    } })
    openDraft(h)
    await h.submit()
    assert.equal(h.requests.length, 0)
    assert.match(text(h.render()), /storage could not preserve|draft changed in another view/)
    assert.equal(h.draft().reason, 'Clarify the acceptance evidence')
  }
})

test('issue262 an old response cannot overwrite a newer remounted draft', async () => {
  const response = deferred()
  const original = panelHarness({ props: { onRevise: () => response.promise } })
  openDraft(original)
  const oldSave = original.submit()
  const reloaded = panelHarness({ values: original.values, props: {
    onRevise: async () => ({ ...saved, replayed: true }),
    task: { ...task(), contract_version: 9 }, mission: { ...mission(), specification_version: 9 },
  } })
  await reloaded.submit()
  reloaded.button('Start another revision').props.onClick()
  reloaded.edit('Revision reason', 'A subsequent revision')
  const expected = [...original.values.entries()]
  response.resolve(saved)
  await oldSave
  assert.deepEqual([...original.values.entries()], expected)
  assert.equal(reloaded.draft().reason, 'A subsequent revision')
  assert.match(text(original.render()), /changed in another view/)
})

test('issue262 actor, Corp, room, mission, task and server scope changes cannot expose or submit a prior draft', async () => {
  for (const change of [
    { actorId: id(14) }, { corpId: id(11) }, { mission: { ...mission(), room_id: id(13) } },
    { mission: { ...mission(), id: id(12) } }, { task: { ...task(), id: id(15) } },
  ]) {
    const h = panelHarness()
    openDraft(h)
    const original = structuredClone(h.draft())
    h.replace(change)
    assert.equal(h.draft(), undefined)
    await h.submit()
    assert.equal(h.requests.length, 0)
    const remounted = panelHarness({ values: h.values, props: change })
    assert.equal(remounted.draft(), undefined)
    assert.deepEqual(panelHarness({ values: h.values }).draft(), original)
  }
  const h = panelHarness()
  openDraft(h)
  const otherServer = panelHarness({ values: h.values, globals: { API_URL: 'http://another.invalid' } })
  assert.equal(otherServer.draft(), undefined)
})

test('issue262 selected source changes keep the old target frozen until explicitly reconciled', async () => {
  const first = run()
  const second = run({ id: id(16), workspace_run_id: id(16) })
  const h = panelHarness({ props: { runs: [first, second], selectedRunId: first.id } })
  openDraft(h)
  assert.equal(h.draft().target.sourceRunId, first.id)
  h.replace({ selectedRunId: second.id })
  await h.submit()
  assert.equal(h.requests.length, 0)
  assert.equal(h.draft().target.sourceRunId, first.id)
  h.button('Use current baseline, keep edits').props.onClick()
  await h.submit()
  assert.equal(h.requests[0][1].source_run_id, second.id)
})

test('issue262 completed, active, stopped and quarantined projections cannot authorize a new revision', async () => {
  for (const change of [
    { task: { ...task(), status: 'completed' } }, { mission: { ...mission(), status: 'completed' } },
    { runs: [run({ status: 'running' })] }, { runs: [run({ breaker_stage: 'stop' })] },
    { runs: [run({ workspace_disposition: 'quarantined' })] },
    { actorId: id(14), actorRole: 'member' },
  ]) {
    const h = panelHarness()
    openDraft(h)
    h.replace(change)
    await h.submit()
    assert.equal(h.requests.length, 0)
  }
  const h = panelHarness({ props: { runs: [run()], budgetBlocked: true, onRevise: async () => saved } })
  openDraft(h)
  assert.match(text(h.render()), /Budget is exhausted/)
  await h.submit()
  assert.equal(h.requests.length, 1, 'saving a narrowing revision does not recover budget or launch work')
  assert.match(text(h.render()), /existing budget recovery controls/)
})

test('issue262 save handler sends only the captured Corp/actor/mission and refuses mismatched requests', async () => {
  const h = saveHarness()
  await h.save()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0][0], '/api/corps/' + id(1) + '/missions/' + id(2) + '/contract-revisions')
  assert.deepEqual(JSON.parse(h.requests[0][1].body), { actor_id: id(4), ...h.input })
  for (const changes of [
    { task_id: id(15) }, { expected_contract_version: 3 }, { next_action: 'resume' }, { source_run_id: id(6) },
  ]) {
    const result = await h.globals.save(h.target, { ...h.input, ...changes })
    assert.equal(result.status, 'rejected')
  }
  h.globals.currentViewer.current = { corpId: id(1), actorId: id(14) }
  assert.equal((await h.save()).status, 'rejected')
  h.globals.currentViewer.current = null
  assert.equal((await h.save()).status, 'rejected')
  assert.equal(h.requests.length, 1)
})

test('issue262 save receipts are verified and a late success cannot refresh or announce into another viewer', async () => {
  for (const revision of [
    null, { id: 'not-a-uuid', version: 9, mission_id: id(2), task_id: id(5) },
    { id: id(90), version: 2, mission_id: id(2), task_id: id(5) },
    { id: id(90), version: 9, mission_id: id(12), task_id: id(5) },
    { id: id(90), version: 9, mission_id: id(2), task_id: id(15) },
  ]) {
    const h = saveHarness({ api: async () => ({ revision, replayed: false }) })
    assert.equal((await h.save()).status, 'unknown')
  }
  const response = deferred()
  const h = saveHarness({ api: () => response.promise })
  const saving = h.save()
  h.globals.currentViewer.current = { corpId: id(11), actorId: id(14) }
  response.resolve({ revision: { id: id(90), version: 9, mission_id: id(2), task_id: id(5) }, replayed: true })
  assert.equal((await saving).status, 'saved')
  assert.equal(h.refreshes.length, 0)
  assert.equal(h.announcements.length, 0)
})

test('issue262 save failures distinguish definite refusal from rate limits, timeouts and unknown transport outcomes', async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 408, 425, 429, 500, 503]) {
    const h = saveHarness()
    h.globals.api = async () => { throw new h.globals.ApiRequestError(status) }
    const expected = [400, 401, 403, 404, 409, 422].includes(status) ? 'rejected' : 'unknown'
    assert.equal((await h.save()).status, expected, String(status))
  }
  const h = saveHarness({ api: async () => { throw new Error('Network interrupted') } })
  assert.equal((await h.save()).status, 'unknown')
})
