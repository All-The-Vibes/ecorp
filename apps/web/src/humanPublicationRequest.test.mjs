import assert from 'node:assert/strict'
import test from 'node:test'
import { humanPublicationRequest, readHumanPublicationPreview } from './humanPublicationRequest.ts'
import { missionResultScope } from './missionResultContext.ts'

// Transport/controller regressions with synthetic public DTOs. These do not
// establish native authority, browser acceptance or a GitHub publication.
const scope = missionResultScope({
  corpId: 'corp-a', actorId: 'alice', roomId: 'room-a', missionId: 'mission-a',
  workItemId: 'item-a', sourceRepository: 'owner/repo',
})
const source = Object.freeze({
  id: 'deliverable-a', task_id: 'task-a', run_id: 'run-a', artifact_id: 'artifact-a',
  head_commit: 'a'.repeat(40), sha256: 'b'.repeat(64), verification_sha256: 'c'.repeat(64),
})
const preview = Object.freeze({
  plan: Object.freeze({
    source_deliverable_id: source.id, target_repository: scope.sourceRepository,
    base_ref: 'main', branch: 'ecorp/review-result', title: 'Review the selected result',
    body: 'A review-only pull request.\n\tExact result selected by the operator.',
  }),
  commit_sha: source.head_commit, artifact_sha256: source.sha256,
  verification_sha256: source.verification_sha256, source_revision: 'source-revision-a',
  fingerprint: 'd'.repeat(64),
})
const saved = {
  publisher_token: null,
  publication: {
    id: 'publication-a', corp_id: scope.corpId, mission_id: scope.missionId,
    factory_work_item_id: scope.workItemId, task_id: source.task_id,
    run_id: source.run_id, artifact_id: source.artifact_id, ...preview.plan,
    commit_sha: source.head_commit, state: 'requested',
  },
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(transport) {
  const timers = new Map(), calls = [], views = []
  let nextTimer = 0, refreshes = 0
  const clock = {
    setTimeout(callback, delay) {
      assert.equal(delay, 15_000)
      const id = ++nextTimer
      timers.set(id, callback)
      return id
    },
    clearTimeout(id) { timers.delete(id) },
  }
  const controller = humanPublicationRequest(scope, source, (path, init) => {
    const response = deferred()
    calls.push({ path, init, response })
    return transport ? transport(path, init) : response.promise
  }, (view) => views.push(view), () => { refreshes++ }, clock)
  return {
    controller, calls, views, timers,
    get view() { return views.at(-1) },
    get refreshes() { return refreshes },
    expire() {
      assert.equal(timers.size, 1)
      const [id, callback] = [...timers][0]
      timers.delete(id)
      callback()
    },
    async ready() {
      controller.preview()
      await tick()
      calls.at(-1).response.resolve(preview)
      await tick()
      assert.equal(views.at(-1).phase, 'ready')
    },
  }
}

test('preview retains only exact human-visible plan and selected source hashes', () => {
  const result = readHumanPublicationPreview({
    ...preview, publisher_token: 'never-retain', authorization_snapshot: { private: true },
    plan: { ...preview.plan, credential: 'never-retain' },
  }, scope, source)
  assert.deepEqual(result, preview)
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.plan))
})

test('preview preserves Unicode and multiline text as the exact literal plan', () => {
  const value = { ...preview, plan: { ...preview.plan,
    title: 'Review the résumé 📝', body: 'First line\n\tExact résumé result\r\nFinal line',
  } }
  assert.deepEqual(readHumanPublicationPreview(value, scope, source), value)
})

test('preview rejects mismatched scope, lineage, unsafe text and malformed fingerprints', () => {
  const changes = [
    (value) => { value.plan.source_deliverable_id = 'other-result' },
    (value) => { value.plan.target_repository = 'owner/other' },
    (value) => { value.commit_sha = 'e'.repeat(40) },
    (value) => { value.artifact_sha256 = 'e'.repeat(64) },
    (value) => { value.verification_sha256 = 'e'.repeat(64) },
    (value) => { value.plan.branch = value.plan.base_ref },
    (value) => { value.plan.title += '\nspoofed line' },
    (value) => { value.plan.body += String.fromCharCode(0) },
    (value) => { value.plan.body = 'x'.repeat(65_537) },
    (value) => { value.fingerprint += '\n' },
    (value) => { value.fingerprint = 'e'.repeat(63) },
  ]
  changes.forEach((change, index) => {
    const value = structuredClone(preview)
    change(value)
    assert.throws(() => readHumanPublicationPreview(value, scope, source), undefined, `case ${index}`)
  })
})

test('only explicit preview then submit sends the exact plan, once, without authority overrides', async () => {
  const f = fixture()
  try {
    f.controller.submit()
    await tick()
    assert.equal(f.calls.length, 0)
    f.controller.preview()
    f.controller.preview()
    await tick()
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].path, '/api/corps/corp-a/factory/work-items/item-a/publication/preview')
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { actor_id: 'alice', source_deliverable_id: source.id })
    f.calls[0].response.resolve(preview)
    await tick()
    assert.equal(f.view.phase, 'ready')
    assert.equal(f.calls.length, 1)
    f.controller.submit()
    f.controller.submit()
    f.controller.preview()
    await tick()
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls[1].path, '/api/corps/corp-a/factory/work-items/item-a/publication/request')
    assert.deepEqual(f.calls[1].init, {
      method: 'POST', cache: 'no-store', body: JSON.stringify({ actor_id: 'alice', preview }),
    })
    f.calls[1].response.resolve(saved)
    await tick()
    assert.equal(f.view.phase, 'saved')
    assert.equal(f.view.preview, null)
    assert.equal(f.refreshes, 1)
    f.controller.submit()
    f.controller.preview()
    await tick()
    assert.equal(f.calls.length, 2)
    assert.equal(f.timers.size, 0)
  } finally { f.controller.dispose() }
})

test('explicit submit starts transport even when the view immediately disconnects', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.controller.submit()
    f.controller.dispose()
    await tick()
    assert.equal(f.calls.length, 2, 'detaching a view must not cancel its explicit request')
    assert.equal(f.calls[1].init.signal, undefined, 'publication transport is independent of the view')
    const viewCount = f.views.length
    f.calls[1].response.resolve(saved)
    await tick()
    assert.equal(f.views.length, viewCount)
    assert.equal(f.refreshes, 0, 'a detached view must not refresh another view')
    assert.equal(f.timers.size, 0)
  } finally { f.controller.dispose() }
})

test('preview timeout is bounded and a late preview cannot enable submission', async () => {
  const f = fixture()
  try {
    f.controller.preview()
    await tick()
    f.expire()
    assert.equal(f.view.phase, 'unavailable')
    assert.equal(f.calls[0].init.signal.aborted, true)
    f.calls[0].response.resolve(preview)
    await tick()
    f.controller.submit()
    assert.equal(f.view.phase, 'unavailable')
    assert.equal(f.calls.length, 1)
    assert.equal(f.refreshes, 0)
  } finally { f.controller.dispose() }
})

test('malformed previews and transport failures require a new explicit preview', async () => {
  for (const value of [null, [], {}, { plan: null }, { plan: [] }, new Error('PRIVATE TRANSPORT FAILURE')]) {
    const f = fixture()
    try {
      f.controller.preview()
      const response = f.calls[0].response
      if (value instanceof Error) response.reject(value)
      else response.resolve(value)
      await tick()
      assert.equal(f.view.phase, 'unavailable')
      assert.equal(f.view.preview, null)
      assert.equal(f.timers.size, 0)
      assert.equal(f.refreshes, 0)
      assert.doesNotMatch(JSON.stringify(f.views), /PRIVATE|TRANSPORT|FAILURE/)
      f.controller.submit()
      assert.equal(f.calls.length, 1, 'a failed preview cannot submit or retry itself')
      await f.ready()
      assert.equal(f.calls.length, 2, 'the user may explicitly request a new preview')
    } finally { f.controller.dispose() }
  }
})

test('a queued timeout and late rejection cannot overwrite a replacement preview', async () => {
  const f = fixture()
  try {
    f.controller.preview()
    const queuedTimeout = [...f.timers.values()][0]
    f.expire()
    assert.equal(f.view.phase, 'unavailable')
    f.controller.preview()
    queuedTimeout()
    f.calls[0].response.reject(new Error('old preview failure'))
    await tick()
    assert.equal(f.view.phase, 'previewing')
    assert.equal(f.timers.size, 1)
    f.calls[1].response.resolve(preview)
    await tick()
    assert.equal(f.view.phase, 'ready')
    assert.equal(f.calls.length, 2)
    assert.equal(f.timers.size, 0)
    assert.equal(f.refreshes, 0)
  } finally { f.controller.dispose() }
})

test('request timeout remains uncertain with no abort or automatic retry', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.controller.submit()
    await tick()
    f.expire()
    assert.equal(f.view.phase, 'unconfirmed')
    assert.equal(f.calls[1].init.signal, undefined)
    f.controller.submit()
    f.controller.preview()
    f.calls[1].response.resolve(saved)
    await tick()
    assert.equal(f.calls.length, 2)
    assert.equal(f.view.phase, 'unconfirmed')
    assert.equal(f.refreshes, 0)
    assert.equal(f.timers.size, 0)
  } finally { f.controller.dispose() }
})

test('request errors and contradictory confirmations expose no native error or credentials', async () => {
  for (const response of [
    () => { throw new Error('PRIVATE NATIVE ERROR WITH CREDENTIAL') },
    () => ({ ...saved, publisher_token: 'PRIVATE TOKEN' }),
    () => ({ ...saved, publication: { ...saved.publication, corp_id: 'other-corp' } }),
    () => ({ ...saved, publication: { ...saved.publication, run_id: 'other-run' } }),
    () => ({ ...saved, publication: { ...saved.publication, branch: 'other-branch' } }),
  ]) {
    const f = fixture((path) => path.endsWith('/preview') ? Promise.resolve(preview) : response())
    try {
      f.controller.preview()
      await tick()
      f.controller.submit()
      await tick()
      assert.equal(f.view.phase, 'unconfirmed')
      assert.equal(f.view.preview, null)
      assert.doesNotMatch(JSON.stringify(f.views), /PRIVATE|TOKEN|CREDENTIAL/)
      assert.equal(f.refreshes, 0)
      assert.equal(f.timers.size, 0)
      f.controller.submit()
      await tick()
      assert.equal(f.calls.length, 2)
    } finally { f.controller.dispose() }
  }
})

test('disposing preview aborts only that view and discards late results', async () => {
  const f = fixture()
  f.controller.preview()
  await tick()
  f.controller.dispose()
  assert.equal(f.calls[0].init.signal.aborted, true)
  f.calls[0].response.resolve(preview)
  await tick()
  f.controller.preview()
  f.controller.submit()
  assert.equal(f.calls.length, 1)
  assert.equal(f.view.phase, 'previewing')
  assert.equal(f.timers.size, 0)
})
