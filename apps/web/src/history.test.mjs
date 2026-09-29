import assert from 'node:assert/strict'
import test from 'node:test'
import {
  causalHistoryFilters, emptyHistoryFilters, HISTORY_ENTITY_STATUSES, historyEntryLink,
  historyPosition, historyRequestPath, isHistoryId, normalizeHistoryFilters,
  parseHistoryPage, requestHistoryPage,
} from './history.ts'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const created = '2026-09-29T12:00:00.123456Z'
const request = (kind = 'event') => ({ corpId: id(1), actorId: id(2), filters: emptyHistoryFilters(kind),
  pageSize: 2, cursor: null, after: null })
const entry = (n, kind = 'event') => ({ id: id(n), kind, room_id: id(3), title: 'A <safe> title',
  status: kind === 'event' ? 'run.completed' : 'completed', summary: 'Recorded outcome; inspect verification evidence.',
  actor_id: id(2), actor_name: 'Operator', created_at: created, seq: kind === 'event' ? String(n) : null,
  mission_id: kind === 'mission' ? id(n) : id(4), task_id: kind === 'task' ? id(n) : kind === 'mission' ? null : id(5),
  run_id: kind === 'event' || kind === 'run' ? id(n) : null, cause_id: null })
const page = (r = request(), entries = [entry(32, r.filters.kind), entry(31, r.filters.kind)]) => ({
  corp_id: r.corpId, actor_id: r.actorId, filters: { ...r.filters }, page_size: r.pageSize,
  entries, next_cursor: 'abcd', observed_at: '2026-09-29T12:01:00Z',
})
const clone = (v) => structuredClone(v)

test('all four histories have validated identity, ordering and an explicit next page', () => {
  for (const kind of ['mission', 'task', 'run', 'event']) {
    const r = request(kind), p = page(r)
    assert.deepEqual(parseHistoryPage(p, r), p)
    assert.deepEqual(historyPosition(p.entries[0]), { id: id(32), created_at: created, seq: kind === 'event' ? '32' : null })
    assert.equal(historyEntryLink(p.entries[0]).kind, kind === 'event' ? 'run' : kind)
  }
  assert.equal(historyEntryLink({ mission_id: null, task_id: null, run_id: null }), null)
})

test('requests encode literal search and scope without adding mutation authority', () => {
  const r = request('run')
  r.filters = { ...r.filters, search: '  a%_ & /?  ', room_id: id(3), mission_id: id(4),
    attributed_actor_id: id(6), record_id: id(32), status: 'completed' }
  r.cursor = '00ab'
  const url = new URL(historyRequestPath(r), 'https://fixture.invalid')
  assert.equal(url.pathname, `/api/corps/${id(1)}/history`)
  assert.equal(url.searchParams.get('search'), 'a%_ & /?')
  for (const key of ['room_id', 'mission_id', 'attributed_actor_id', 'record_id', 'status']) {
    assert.equal(url.searchParams.get(key), r.filters[key])
  }
  assert.equal(url.searchParams.get('actor_id'), id(2))
  assert.equal(url.searchParams.get('cursor'), '00ab')
  assert.equal(url.searchParams.get('page_size'), '2')
  assert.equal(url.searchParams.has('authorization'), false)
  assert.deepEqual(causalHistoryFilters(id(19)), { ...emptyHistoryFilters('event'), record_id: id(19) })
})

test('invalid viewer, scope, page size, cursor or search is rejected before a request', () => {
  for (const changes of [{ corpId: 'other' }, { actorId: id(0).replace('-4000-', '-0000-').replace('-8000-', '-0000-') },
    { pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.1 }, { cursor: 'abc' }, { cursor: 'aa'.repeat(2049) },
    { filters: { ...emptyHistoryFilters(), kind: 'payload' } },
    { filters: { ...emptyHistoryFilters(), room_id: 'bad' } },
    { filters: { ...emptyHistoryFilters(), status: 'x y' } },
    { filters: { ...emptyHistoryFilters(), search: 'x'.repeat(161) } },
    { filters: { ...emptyHistoryFilters(), search: 'spoof\u202e' } },
    { filters: { ...emptyHistoryFilters(), search: 'private\u0000' } }]) {
    assert.throws(() => historyRequestPath({ ...request(), ...changes }), /Invalid history request/)
  }
  for (const bad of [undefined, null, 1, {}, '', 'NOT-A-UUID', '00000000-0000-0000-0000-000000000000']) assert.equal(isHistoryId(bad), false)
  assert.ok(normalizeHistoryFilters({ ...emptyHistoryFilters(), search: '😀'.repeat(160) }))
  for (const [kind, values] of Object.entries(HISTORY_ENTITY_STATUSES)) for (const status of values) {
    assert.ok(normalizeHistoryFilters({ ...emptyHistoryFilters(kind), status }))
  }
  assert.equal(normalizeHistoryFilters({ ...emptyHistoryFilters('mission'), status: 'waiting_for_input' }), null)
})

test('response envelope cannot cross viewers, Corps, filters, sizes or inject extra fields', () => {
  const changes = [null, [], 'bad', { corp_id: id(8) }, { actor_id: id(8) }, { page_size: 100 },
    { observed_at: '2026-02-30T12:01:00Z' }, { observed_at: '2026-09-29T12:01:00+00:00' },
    { observed_at: '2026-09-29T25:00:00Z' }, { entries: {} }, { authorization: 'not-authority' },
    { filters: { ...emptyHistoryFilters(), room_id: id(9) } },
    { filters: { ...emptyHistoryFilters(), extra: true } }, { filters: [] },
    { next_cursor: 5 }, { next_cursor: 'abc' }, { next_cursor: 'ab'.repeat(2049) }]
  for (const change of changes) {
    const value = change && !Array.isArray(change) && typeof change === 'object' ? { ...page(), ...change } : change
    assert.equal(parseHistoryPage(value, request()), null, JSON.stringify(change))
  }
  const missing = page(); delete missing.filters
  assert.equal(parseHistoryPage(missing, request()), null)
  const full = page(); full.entries.push(entry(30))
  assert.equal(parseHistoryPage(full, request()), null)
  const empty = page(request(), []); empty.next_cursor = null
  assert.deepEqual(parseHistoryPage(empty, request()), empty)
  assert.equal(parseHistoryPage({ ...empty, next_cursor: 'aa' }, request()), null)
  assert.equal(parseHistoryPage({ ...page(), next_cursor: 'aa' }, { ...request(), cursor: 'aa' }), null)
  assert.equal(parseHistoryPage(page(), { ...request(), filters: { ...emptyHistoryFilters(), status: '!bad' } }), null)
})

test('safe summaries reject malformed identities, raw additions, controls and impossible relationships', () => {
  for (const patch of [{ id: 'bad' }, { kind: 'mission' }, { room_id: 'bad' }, { actor_id: 'bad' },
    { mission_id: null }, { task_id: null }, { seq: null }, { seq: '0' }, { seq: '-1' }, { seq: '01' },
    { seq: '9223372036854775808' }, { title: 'x'.repeat(241) }, { title: 'a\u202eb' },
    { title: 'a\u009fb' }, { summary: 'x'.repeat(301) }, { actor_name: 3 }, { actor_id: null },
    { actor_name: 'x'.repeat(241) }, { status: 'a\nb' }, { cause_id: id(32) },
    { created_at: '2026-02-30T01:00:00Z' }, { created_at: '2026-09-29T12:02:00Z' }, { payload: { token: 'never render' } }]) {
    const p = page(); p.entries[0] = { ...p.entries[0], ...patch }
    assert.equal(parseHistoryPage(p, request()), null, JSON.stringify(patch))
  }
  const p = page(); p.entries[0] = { ...p.entries[0], actor_id: null, actor_name: null, room_id: null,
    mission_id: null, task_id: null, run_id: null, status: 'other' }
  assert.ok(parseHistoryPage(p, request()))
  for (const kind of ['mission', 'task', 'run']) for (const patch of [{ room_id: null }, { seq: '3' },
    { cause_id: id(9) }, { status: 'unknown-status' },
    { [kind === 'mission' ? 'mission_id' : kind === 'task' ? 'task_id' : 'run_id']: id(87) }]) {
    const r = request(kind), p = page(r); Object.assign(p.entries[0], patch)
    assert.equal(parseHistoryPage(p, r), null)
  }
  for (const [kind, patch] of [['mission', { task_id: id(5) }], ['mission', { run_id: id(7) }], ['task', { run_id: id(7) }]]) {
    const r = request(kind), p = page(r); Object.assign(p.entries[0], patch)
    assert.equal(parseHistoryPage(p, r), null)
  }
})

test('every non-text applied filter must match each returned row, not just the echo', () => {
  for (const [key, value] of [['room_id', id(9)], ['mission_id', id(9)], ['attributed_actor_id', id(9)],
    ['record_id', id(9)], ['status', 'run.started']]) {
    const r = request(); r.filters[key] = value
    assert.equal(parseHistoryPage(page(r), r), null)
  }
  const r = request(); r.filters = { ...r.filters, room_id: id(3), mission_id: id(4),
    attributed_actor_id: id(2), record_id: id(32), status: 'run.completed' }
  const p = page(r, [entry(32)]); p.next_cursor = null
  assert.ok(parseHistoryPage(p, r))
})

test('sequence ordering is exact beyond JavaScript safe integers and independent of event time', () => {
  const p = page()
  p.entries[0].seq = '9223372036854775807'; p.entries[1].seq = '9223372036854775806'
  p.entries[0].created_at = '2026-09-28T12:00:00Z'
  assert.ok(parseHistoryPage(p, request()))
  const r = { ...request(), after: { id: id(80), created_at: created, seq: '9223372036854775807' } }
  assert.equal(parseHistoryPage(p, r), null, 'exclusive continuation must reject a repeated boundary')
  p.entries[0].seq = '9223372036854775806'; p.entries[1].seq = '9223372036854775805'
  assert.ok(parseHistoryPage(p, r))
  p.entries.reverse()
  assert.equal(parseHistoryPage(p, request()), null)
})

test('entity ordering preserves microseconds, ID ties and exclusive page boundaries', () => {
  const r = request('mission'), p = page(r)
  p.entries[0].id = p.entries[0].mission_id = id(30)
  p.entries[0].created_at = '2026-09-29T12:00:00.123457Z'
  assert.ok(parseHistoryPage(p, r), 'microseconds must outrank the reversed ID tie')
  p.entries[0].created_at = '2026-09-29T12:00:00.123455Z'
  assert.equal(parseHistoryPage(p, r), null)
  p.entries[0].created_at = created
  assert.equal(parseHistoryPage(p, r), null)
  p.entries[0].id = p.entries[0].mission_id = id(32)
  assert.ok(parseHistoryPage(p, r))
  assert.equal(parseHistoryPage(p, { ...r, after: historyPosition(p.entries[0]) }), null)
  assert.ok(parseHistoryPage(p, { ...r, after: { ...historyPosition(p.entries[0]), id: id(33) } }))
  p.entries[1] = clone(p.entries[0])
  assert.equal(parseHistoryPage(p, r), null)
})

const tick = () => new Promise((resolve) => setImmediate(resolve))
test('reader uses no-store, validates the response and publishes only its own key', async () => {
  const loads = [], calls = [], r = request()
  const stop = requestHistoryPage(r, 'viewer-query', async (...args) => { calls.push(args); return page(r) }, (v) => loads.push(v))
  await tick()
  assert.deepEqual(loads.map(({ key, status }) => [key, status]), [['viewer-query', 'loading'], ['viewer-query', 'ready']])
  assert.equal(calls[0][1].cache, 'no-store')
  assert.equal(calls[0][1].signal.aborted, false)
  stop(); assert.equal(calls[0][1].signal.aborted, true)
})

test('cleanup suppresses late resolutions and rejections after a scope or page change', async () => {
  for (const rejects of [false, true]) {
    const loads = []
    let finish
    const stop = requestHistoryPage(request(), 'old', () => new Promise((resolve, reject) => {
      finish = rejects ? reject : resolve
    }), (v) => loads.push(v))
    stop(); finish(rejects ? new Error('sensitive old response') : page()); await tick()
    assert.deepEqual(loads.map((v) => v.status), ['loading'])
  }
})

test('errors, invalid data and timeout expose static diagnostics and suppress late success', async () => {
  for (const api of [async () => { throw new Error('credential=secret') }, async () => ({ raw: 'secret' })]) {
    const loads = [], stop = requestHistoryPage(request(), 'current', api, (v) => loads.push(v))
    await tick(); stop()
    assert.equal(loads.at(-1).status, 'error')
    assert.doesNotMatch(JSON.stringify(loads), /credential|secret/)
  }
  const loads = []
  let resolve, signal
  const stop = requestHistoryPage(request(), 'slow', (_, init) => {
    signal = init.signal
    return new Promise((done) => { resolve = done })
  }, (v) => loads.push(v), 5)
  await new Promise((done) => setTimeout(done, 25))
  assert.equal(signal.aborted, true)
  assert.equal(loads.at(-1).status, 'error')
  resolve(page()); await tick(); stop()
  assert.deepEqual(loads.map((v) => v.status), ['loading', 'error'])
})
