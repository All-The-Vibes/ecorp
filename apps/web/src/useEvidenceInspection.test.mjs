import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import test from 'node:test'
import ts from 'typescript'
import * as evidence from './sourceEvidence.ts'
import { renderHooks } from './testSupport/renderHooks.mjs'

const compiled = ts.transpileModule(await readFile(new URL('./useEvidenceInspection.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bytes = new TextEncoder().encode('<script>never execute</script>\nverified output\n')
const initialTime = Date.parse('2026-09-29T00:00:00Z')
const source = Object.freeze({
  kind: 'provider', runId: 'run-old', taskId: 'task-old', artifactId: 'provider-old',
  sha256: hash(bytes), mediaType: 'text/plain', bytes: null, baseCommit: 'a'.repeat(40),
  verificationSha256: 'b'.repeat(64), retentionUntil: null, form: null, headCommit: null, branch: null,
})
const viewer = { server: 'https://ecorp.invalid/api', corpId: 'corp-a', actorId: 'actor-a',
  actorRole: 'member', roomId: 'room-a', missionId: 'mission-a' }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Production hook and parsers; transport, effect boundaries and time are controlled.
function fixture(overrides = {}, model = evidence) {
  const hooks = renderHooks(), calls = [], timers = new Map()
  let now = initialTime, sequence = 0
  class Clock extends Date { static now() { return now } }
  const setTimer = (callback, delay) => {
    const id = ++sequence
    timers.set(id, { callback, at: now + delay })
    return id
  }
  const exports = {}
  new Function('require', 'exports', 'Date', 'setTimeout', 'clearTimeout', compiled)(
    (name) => {
      if (name === 'react') return hooks.react
      assert.equal(name, './sourceEvidence')
      return model
    }, exports, Clock, setTimer, (id) => timers.delete(id),
  )
  const request = (path, signal) => {
    const response = deferred()
    calls.push({ path, signal, ...response })
    return response.promise
  }
  let input = { viewer: { ...viewer }, source, available: true, request, ...overrides }
  const render = (next = input, commit = true) => {
    input = next
    return commit ? hooks.render(() => exports.useEvidenceInspection(input))
      : hooks.begin(() => exports.useEvidenceInspection(input))
  }
  const flush = async (predicate = () => hooks.value.state.status !== 'loading') => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(setImmediate)
      hooks.flush()
      if (predicate()) return
    }
    assert.fail('Evidence promise did not settle')
  }
  render()
  return {
    hooks, calls, timers, render, flush, get input() { return input }, get value() { return hooks.value },
    open() { hooks.value.open(); hooks.flush() },
    close() { hooks.value.close(); hooks.flush() },
    answer(index = 0, response = new Response(bytes, { headers: { 'content-type': 'text/plain' } })) {
      calls[index].resolve(response)
    },
    advance(milliseconds, runTimers = true) {
      const until = now + milliseconds
      if (runTimers) for (let attempt = 0; attempt < 100; attempt++) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0]); now = next[1].at; next[1].callback(); hooks.flush()
        assert.ok(attempt < 99, 'no unbounded timer loop')
      }
      now = until
      hooks.flush()
    },
    unmount() { hooks.unmount(); assert.equal(timers.size, 0, 'owned timers are cleaned up') },
  }
}

test('inspection is an explicit read of the exact selected native artifact', async () => {
  const f = fixture()
  try {
    assert.equal(f.value.state.status, 'idle')
    assert.equal(f.calls.length, 0)
    f.open()
    assert.equal(f.value.state.status, 'loading')
    assert.equal(f.calls[0].path, '/api/corps/corp-a/artifacts/provider-old?actor_id=actor-a')
    f.answer(); await f.flush()
    assert.equal(f.value.state.status, 'ready')
    assert.equal(f.value.state.document.preview.text, new TextDecoder().decode(bytes))
    f.render({ ...f.input, viewer: { ...viewer } })
    assert.equal(f.value.state.status, 'ready', 'a snapshot refresh with identical scope keeps the same evidence')
    assert.equal(f.calls.length, 1, 'no polling')
    f.close()
    assert.equal(f.value.state.status, 'idle')
    assert.equal(f.value.preview, null)
  } finally { f.unmount() }
})

const changes = [
  ...['server', 'corpId', 'actorId', 'roomId', 'missionId'].map((field) => [field,
    (input) => ({ ...input, viewer: { ...input.viewer, [field]: input.viewer[field] + '-b' } })]),
  ['actorRole', (input) => ({ ...input, viewer: { ...input.viewer, actorRole: 'admin' } })],
  ...['runId', 'taskId', 'artifactId', 'sha256', 'verificationSha256', 'baseCommit', 'headCommit', 'branch', 'mediaType'].map((field) => [field,
    (input) => ({ ...input, source: { ...input.source, [field]: String(input.source[field]) + '-changed' } })]),
  ['retention', (input) => ({ ...input, source: { ...input.source, retentionUntil: '2026-10-01T00:00:00Z' } })],
  ['permission', (input) => ({ ...input, viewer: { ...input.viewer, actorRole: 'viewer' } })],
  ['connection', (input) => ({ ...input, available: false })],
  ['missing source', (input) => ({ ...input, source: null })],
  ['transport', (input) => ({ ...input, request: (...args) => input.request(...args) })],
]
for (const [name, change] of changes) test(`a ${name} transition hides loaded evidence before effect cleanup`, async () => {
  const f = fixture(), original = f.input
  try {
    f.open(); f.answer(); await f.flush()
    assert.equal(f.value.state.status, 'ready')
    f.render(change(original), false)
    assert.notEqual(f.value.state.status, 'ready')
    assert.equal(f.value.preview, null)
    f.hooks.flush()
    assert.equal(f.calls.length, 1)
    f.render(original)
    assert.equal(f.value.state.status, 'idle', 'returning to A does not resurrect its old document')
  } finally { f.unmount() }
})

test('A to B to A rejects a late response even when the transport ignores abort', async () => {
  const f = fixture(), original = f.input
  try {
    f.open()
    f.render({ ...original, viewer: { ...viewer, roomId: 'room-b' } })
    assert.equal(f.calls[0].signal.aborted, true)
    f.render(original)
    f.open()
    f.answer(0); await f.flush(() => true)
    assert.equal(f.value.state.status, 'loading', 'old response cannot satisfy the newer request')
    f.answer(1); await f.flush()
    assert.equal(f.value.state.status, 'ready')
  } finally { f.unmount() }
})

test('cancel, timeout and StrictMode clean up their own read without publishing late bytes', async () => {
  const f = fixture()
  try {
    f.open(); f.close()
    assert.equal(f.calls[0].signal.aborted, true)
    f.answer(0); await f.flush()
    assert.equal(f.value.state.status, 'idle')
    f.open(); f.hooks.replayEffects()
    assert.equal(f.calls[1].signal.aborted, true)
    assert.equal(f.calls.length, 3)
    f.answer(1); await f.flush(() => true)
    assert.equal(f.value.state.status, 'loading')
    f.advance(15_000)
    assert.equal(f.value.state.problem, 'unavailable')
    assert.equal(f.calls[2].signal.aborted, true)
    f.answer(2); await f.flush()
    assert.equal(f.value.state.problem, 'unavailable')
  } finally { f.unmount() }
})

for (const [response, problem] of [
  [() => new Response('', { status: 403 }), 'denied'],
  [() => new Response('', { status: 410 }), 'expired'],
  [() => new Response('tampered', { headers: { 'content-type': 'text/plain' } }), 'mismatch'],
]) test(`native ${problem} response never produces a document`, async () => {
  const f = fixture()
  try {
    f.open(); f.answer(0, response()); await f.flush()
    assert.equal(f.value.state.status, 'error')
    assert.equal(f.value.state.problem, problem)
    assert.equal(f.value.preview, null)
  } finally { f.unmount() }
})

test('expiry hides loaded data and catches suspended-tab activation without relying on a timer', async () => {
  const f = fixture({ source: { ...source, retentionUntil: new Date(initialTime + 1000).toISOString() } })
  try {
    f.open(); f.answer(); await f.flush()
    assert.equal(f.value.state.status, 'ready')
    f.advance(1000)
    assert.equal(f.value.state.problem, 'expired')
    f.close(); f.open()
    assert.equal(f.calls.length, 1, 'expired evidence never issues a new read')
  } finally { f.unmount() }
  const suspended = fixture({ source: { ...source, retentionUntil: new Date(initialTime + 1000).toISOString() } })
  try {
    suspended.advance(1001, false); suspended.open()
    assert.equal(suspended.value.state.problem, 'expired')
    assert.equal(suspended.calls.length, 0)
  } finally { suspended.unmount() }
})

test('a response that arrives after retention expires is withheld, including long retention timers', async () => {
  const f = fixture({ source: { ...source, retentionUntil: new Date(initialTime + 1000).toISOString() } })
  try {
    f.open(); f.advance(1001, false); f.answer(); await f.flush()
    assert.equal(f.value.state.problem, 'expired')
  } finally { f.unmount() }
  const long = 2_147_483_647 + 10_000
  const g = fixture({ source: { ...source, retentionUntil: new Date(initialTime + long).toISOString() } })
  try {
    g.advance(long - 1)
    assert.equal(g.value.state.status, 'idle')
    g.advance(1)
    assert.equal(g.value.state.problem, 'expired')
    assert.equal(g.calls.length, 0)
  } finally { g.unmount() }
})

test('unknown roles, missing scope, absent source and lost availability cannot request evidence', () => {
  for (const overrides of [{ available: false }, { source: null },
    ...['viewer', 'service', '', 'OWNER'].map((actorRole) => ({ viewer: { ...viewer, actorRole } })),
    ...['server', 'corpId', 'actorId', 'roomId', 'missionId'].map((field) => ({ viewer: { ...viewer, [field]: '' } }))]) {
    const f = fixture(overrides)
    try {
      f.open()
      assert.equal(f.value.state.status, 'disabled')
      assert.equal(f.calls.length, 0)
    } finally { f.unmount() }
  }
})

async function manifestFixture(overrides = {}) {
  const files = ['a', 'b'].map((name) => {
    const content = new TextEncoder().encode(`verified file ${name}\n`)
    return { path: `${name}.txt`, status: 'A', mode: '100644', sha256: hash(content),
      bytes: content.byteLength, media_type: 'text/plain', content_base64: Buffer.from(content).toString('base64') }
  })
  const tree = 'c'.repeat(40)
  const manifest = new TextEncoder().encode(JSON.stringify({
    schema_version: 1, form: 'archive', base_commit: source.baseCommit, head_commit: null,
    branch: 'codex/evidence-fixture', verification_sha256: source.verificationSha256, verified_tree: tree,
    source_verification: { tree, base_commit: source.baseCommit, candidate_commit: source.baseCommit,
      ignored_input_sha256: hash(''), ignored_input_count: 0, ignored_input_bytes: 0 },
    patch_sha256: hash(''), patch_base64: null, git_bundle_sha256: null, git_bundle_base64: null, changes: files,
  }))
  const descriptor = { ...source, kind: 'source', artifactId: 'manifest-artifact',
    sha256: hash(manifest), bytes: manifest.byteLength, mediaType: 'application/vnd.ecorp.deliverable+json',
    form: 'archive', branch: 'codex/evidence-fixture', ...overrides }
  const reads = []
  const f = fixture({ source: descriptor }, { ...evidence,
    inspectManifestFile(file) {
      const read = { file, ...deferred() }
      reads.push(read)
      return read.promise
    },
  })
  const load = async () => {
    f.open()
    f.answer(f.calls.length - 1, new Response(manifest, { headers: { 'content-type': descriptor.mediaType } }))
    await f.flush()
    assert.equal(f.value.state.document.kind, 'manifest', 'use the real verified envelope parser')
  }
  await load()
  const select = (index) => {
    f.value.inspect(f.value.state.document.files[index])
    f.hooks.flush()
  }
  const settle = async (index, rejected = false) => {
    if (rejected) reads[index].reject(new evidence.EvidenceError('mismatch'))
    else reads[index].resolve(await evidence.inspectManifestFile(reads[index].file))
    await f.flush(() => true)
  }
  return { f, reads, load, select, settle }
}

for (const rejected of [false, true]) test(`late file ${rejected ? 'failure' : 'success'} cannot replace the newer selected file`, async () => {
  const { f, reads, select, settle } = await manifestFixture()
  try {
    select(0); select(1)
    assert.deepEqual(reads.map((read) => read.file.path), ['a.txt', 'b.txt'])
    assert.equal(f.value.preview.selection.title, 'b.txt')
    assert.equal(f.value.preview.status, 'loading')
    await settle(0, rejected)
    assert.equal(f.value.preview.selection.title, 'b.txt')
    assert.equal(f.value.preview.status, 'loading')
    await settle(1)
    assert.equal(f.value.preview.status, 'ready')
    assert.equal(f.value.preview.preview.text, 'verified file b\n')
    assert.equal(f.calls.length, 1, 'file previews reuse verified bytes, not another host path or request')
  } finally { f.unmount() }
})

test('file A to B to A requires the new A preview and rejects a detached manifest entry', async () => {
  const { f, reads, select, settle } = await manifestFixture()
  try {
    f.value.inspect({ ...f.value.state.document.files[0] })
    f.hooks.flush()
    assert.equal(reads.length, 0, 'only entries from the current verified manifest may be inspected')
    f.value.inspect()
    f.hooks.flush()
    assert.equal(f.value.preview, null, 'an absent diff does not create a preview')
    select(0); select(1); select(0)
    await settle(0)
    await settle(1, true)
    assert.equal(f.value.preview.status, 'loading')
    assert.equal(f.value.preview.selection.title, 'a.txt')
    await settle(2)
    assert.equal(f.value.preview.status, 'ready')
    assert.equal(f.value.preview.preview.text, 'verified file a\n')
  } finally { f.unmount() }
})

test('file preview is fenced by viewer and source transitions, including returning to the original scope', async () => {
  for (const change of [
    (input) => ({ ...input, viewer: { ...input.viewer, actorId: 'actor-b' } }),
    (input) => ({ ...input, viewer: { ...input.viewer, roomId: 'room-b' } }),
    (input) => ({ ...input, source: { ...input.source, runId: 'run-b', artifactId: 'artifact-b' } }),
    (input) => ({ ...input, available: false }),
  ]) {
    const { f, load, select, settle } = await manifestFixture()
    const original = f.input
    try {
      select(0)
      f.render(change(original), false)
      assert.equal(f.value.preview, null, 'scope change hides pending preview before cleanup')
      await settle(0)
      assert.equal(f.value.preview, null)
      f.render(original)
      assert.equal(f.value.state.status, 'idle')
      assert.equal(f.value.preview, null)
      await load()
      assert.equal(f.value.preview, null, 'reloading the same manifest requires a new file selection')
      select(1); await settle(1)
      assert.equal(f.value.preview.preview.text, 'verified file b\n')
    } finally { f.unmount() }
  }
})

test('close and retention expiry hide pending file previews and reject late publication', async () => {
  for (const action of ['close', 'expiry']) {
    const { f, select, settle } = await manifestFixture({ retentionUntil: new Date(initialTime + 1000).toISOString() })
    try {
      select(0)
      if (action === 'close') f.close()
      else f.advance(1000)
      await settle(0)
      assert.equal(f.value.preview, null)
      assert.equal(f.value.state.status, action === 'close' ? 'idle' : 'error')
      if (action === 'expiry') assert.equal(f.value.state.problem, 'expired')
      assert.equal(f.calls.length, 1)
    } finally { f.unmount() }
  }
})

test('unmount and effect replay prevent superseded file previews from settling the current selection', async () => {
  const { f, select, settle } = await manifestFixture()
  try {
    select(0)
    f.hooks.replayEffects()
    await settle(0)
    assert.equal(f.value.preview.status, 'loading')
    await settle(1)
    assert.equal(f.value.preview.status, 'ready')
    select(1)
    f.unmount()
    await settle(2)
    assert.equal(f.value.preview.status, 'loading', 'cleaned-up promise cannot publish ready data')
  } finally { f.unmount() }
})
