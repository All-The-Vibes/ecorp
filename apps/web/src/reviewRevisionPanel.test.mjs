import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isValidElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'
import * as reader from './missionResultContext.ts'
import * as operations from './reviewRevisionOperations.ts'
import { missionResultFixture, reviewRevisionFixture } from './missionResultFixtures.mjs'

// Actual panel, reader, command builder and App retry-key helpers. Only React
// scheduling, transport, browser storage and timers are controlled. These are
// callback regressions, not browser/server/runner acceptance or review decisions.
const ids = { corpId: 'corp-a', actorId: 'alice', missionId: 'mission-a', roomId: 'room-a',
  workItemId: 'item-a', sourceRepository: 'owner/repo' }
const scope = reader.missionResultScope(ids)
const tick = () => new Promise(setImmediate)
const findings = [{ id: 1, kind: 'security', summary: 'Keep the lookup within its Corp.',
  path: 'src/auth.rs', line: '12', source_url: 'https://github.com/owner/repo/pull/17#discussion_r1' }]

function publishedFixture(selected = scope, phase = 'published') {
  const value = missionResultFixture(selected, phase)
  value.work_item.state = phase === 'published' ? 'published' : 'publishing'
  value.publication.supersedes_publication_id = null
  value.publication.provenance.source_issue = { number: 71, url: value.work_item.source_issue_url, revision: 'issue-r1' }
  value.publication_history = [value.publication]
  value.review_revisions = []
  return value
}

async function readLoad(value, selected = scope) {
  const loads = []
  const stop = reader.startMissionResultRead(selected, async () => value, (load) => loads.push(load))
  try {
    await tick()
    const load = loads.at(-1)
    assert.equal(load.status, 'ready', 'synthetic DTO must pass the production reader')
    return load
  } finally { stop() }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function compile(name) {
  const source = await readFile(new URL(name, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { fileName: name, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
  assert.deepEqual(output.diagnostics, [])
  return output.outputText
}
function evaluate(source, imports, environment = {}) {
  const exports = {}
  new Function('require', 'exports', 'globalThis', 'window', 'document', 'crypto', source)(
    (name) => { assert.ok(Object.hasOwn(imports, name), name); return imports[name] }, exports,
    environment.timers ?? globalThis, environment.window, environment.document, environment.crypto)
  return exports
}
const panelSource = await compile('./ReviewRevisionPanel.tsx')
const { WorkResultCard } = evaluate(await compile('./WorkResultCard.tsx'), {
  'react/jsx-runtime': jsxRuntime, './WorkResultCard.css': {},
})
const appSource = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const app = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const helperNames = ['browserOperationKey', 'clearBrowserOperation']
const helperDeclarations = app.statements.filter((node) => ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.text))
assert.equal(helperDeclarations.length, 2)
const helperSource = ts.transpileModule(helperDeclarations.map((node) => node.getText(app)).join('\n') +
  '\nexports.operationKey=browserOperationKey; exports.clearOperation=clearBrowserOperation;',
{ compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText

function text(node) {
  if (Array.isArray(node)) return node.map(text).join(' ')
  if (isValidElement(node)) return text(node.props.children)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}
function hosts(node) {
  if (Array.isArray(node)) return node.flatMap(hosts)
  if (!isValidElement(node)) return []
  assert.notEqual(typeof node.type, 'function', 'hookful children must be materialized only once per render')
  return [...(typeof node.type === 'string' ? [node] : []), ...hosts(node.props.children)]
}
function one(tree, type, expression) {
  const found = hosts(tree).filter((node) => node.type === type && expression.test(text(node).replace(/\s+/gu, ' ').trim()))
  assert.equal(found.length, 1, `one ${type} matching ${expression}`)
  return found[0]
}

function panelFixture(load, overrides = {}) {
  const frames = new Map(), storage = new Map(), requests = [], timers = new Map(), animationFrames = []
  const calls = { refresh: 0, changed: 0, navigation: [], downloads: [], focus: [] }
  let activeFrame, cursor, dirty = false, nextId = 0, nextKey = 0, nextTimer = 0, tree, props
  let storageAvailable = true
  const different = (before, after) => !before || before.length !== after.length || after.some((item, index) => !Object.is(item, before[index]))
  const react = {
    useState(initial) {
      const frame = activeFrame, index = cursor++
      if (!frame.slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial }
        slot.set = (value) => {
          if (!frame.mounted) return
          slot.value = typeof value === 'function' ? value(slot.value) : value
          dirty = true
        }
        frame.slots[index] = slot
      }
      return [frame.slots[index].value, frame.slots[index].set]
    },
    useRef(value) {
      const index = cursor++
      activeFrame.slots[index] ??= { current: value }
      return activeFrame.slots[index]
    },
    useMemo(create, dependencies) {
      const index = cursor++
      if (different(activeFrame.slots[index]?.dependencies, dependencies)) {
        activeFrame.slots[index] = { value: create(), dependencies }
      }
      return activeFrame.slots[index].value
    },
    useId() { return react.useMemo(() => `fixture-${++nextId}`, []) },
    useLayoutEffect(create, dependencies) {
      const index = cursor++
      if (different(activeFrame.slots[index]?.dependencies, dependencies)) {
        const previous = activeFrame.slots[index]
        activeFrame.slots[index] = { create, dependencies, cleanup: previous?.cleanup, pending: true }
      }
    },
  }
  const environment = {
    timers: {
      setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
      clearTimeout(id) { timers.delete(id) },
    },
    window: {
      sessionStorage: {
        getItem(key) { if (!storageAvailable) throw new Error('storage unavailable'); return storage.get(key) ?? null },
        setItem(key, value) { if (!storageAvailable) throw new Error('storage unavailable'); storage.set(key, value) },
        removeItem(key) { if (!storageAvailable) throw new Error('storage unavailable'); storage.delete(key) },
      },
      requestAnimationFrame(callback) { animationFrames.push(callback) },
    },
    document: { getElementById(id) { return { focus() { calls.focus.push(id) } } } },
    crypto: { randomUUID() { return `synthetic-operation-${++nextKey}` } },
  }
  const retry = evaluate(helperSource, {}, environment)
  const { ReviewRevisionPanel } = evaluate(panelSource, {
    react, 'react/jsx-runtime': jsxRuntime, './missionResultContext': reader,
    './reviewRevisionOperations': operations, './WorkResultCard': { WorkResultCard }, './ReviewRevisionPanel.css': {},
  }, environment)
  const api = (path, init) => {
    const response = deferred()
    requests.push({ path, init, body: JSON.parse(init.body), response })
    return response.promise
  }
  props = { scope: load.scope, load, server: 'http://ecorp-fixture.invalid', actorRole: 'manager',
    actors: [{ id: 'authorizer', name: 'Fixture authorizer' }, { id: 'alice', name: 'Alice' }], api,
    ...retry, onRefresh() { calls.refresh++ }, onChanged() { calls.changed++; return Promise.resolve() },
    onOpenMission(...identity) { calls.navigation.push(identity) }, onDownload(value) { calls.downloads.push(value) }, ...overrides }
  const cleanup = (frame) => {
    frame.mounted = false
    for (const slot of frame.slots) slot?.cleanup?.()
  }
  const materialize = (node, path, seen) => {
    if (Array.isArray(node)) return node.map((child, index) => materialize(child, `${path}/${index}`, seen))
    if (!isValidElement(node)) return node
    if (typeof node.type === 'function') {
      const location = `${path}:${node.key ?? ''}`
      let frame = frames.get(location)
      if (!frame || frame.type !== node.type) {
        if (frame) cleanup(frame)
        frame = { type: node.type, slots: [], mounted: true }
        frames.set(location, frame)
      }
      seen.add(location)
      activeFrame = frame; cursor = 0
      const child = node.type(node.props)
      return materialize(child, `${location}/child`, seen)
    }
    return jsxRuntime.jsx(node.type, { ...node.props, children: materialize(node.props.children, `${path}/children`, seen) }, node.key ?? undefined)
  }
  const render = (next = {}) => {
    props = { ...props, ...next }
    for (let pass = 0; ; pass++) {
      assert.ok(pass < 10, 'component effects must settle')
      dirty = false
      const seen = new Set()
      tree = materialize(jsxRuntime.jsx(ReviewRevisionPanel, props), 'root', seen)
      for (const [location, frame] of frames) if (!seen.has(location)) { cleanup(frame); frames.delete(location) }
      for (const frame of frames.values()) for (const slot of frame.slots) {
        if (slot?.pending) { slot.pending = false; slot.cleanup?.(); slot.cleanup = slot.create() }
      }
      if (!dirty) return tree
    }
  }
  render()
  return {
    requests, storage, calls, timers, animationFrames, retry,
    get tree() { return tree }, get props() { return props }, render,
    fillSummary(summary = findings[0].summary) {
      const field = hosts(tree).find((node) => node.type === 'textarea' && /-finding-/.test(node.props.id))
      assert.ok(field)
      field.props.onChange({ target: { value: summary } }); render()
    },
    fillReason(reason = 'The correction meets the saved checks and independent review.') {
      const field = hosts(tree).find((node) => node.type === 'textarea' && /-reason$/.test(node.props.id))
      assert.ok(field)
      field.props.onChange({ target: { value: reason } }); render()
    },
    submit() { return one(tree, 'form', /Authorize bounded corrections|Adoption or abandonment reason/).props.onSubmit({ preventDefault() {} }) },
    expire() {
      assert.equal(timers.size, 1)
      const [id, timer] = [...timers][0]
      assert.equal(timer.delay, 30_000)
      timers.delete(id); timer.callback()
    },
    disableStorage() { storageAvailable = false },
    unmount() { for (const frame of frames.values()) cleanup(frame); frames.clear() },
  }
}

function responseFor(command, selected = scope) {
  const p = command.publication
  const r = command.action === 'authorize' ? {
    id: 'new-revision', mission_id: 'new-correction', state: 'pending', authorized_by: selected.actorId,
    findings: command.body.findings,
  } : { ...command.revision, state: command.action === 'adopt' ? 'adopted' : 'abandoned', settled_by: selected.actorId }
  Object.assign(r, { corp_id: selected.corpId, factory_work_item_id: selected.workItemId, publication_id: p.id,
    source_head_commit: p.commit_sha, source_mission_id: p.mission_id, source_task_id: p.task_id,
    source_run_id: p.run_id, source_deliverable_id: p.source_deliverable_id })
  return { revision: r, replayed: false, events: [], work_item: {
    id: selected.workItemId, corp_id: selected.corpId, version: command.body.expected_version + 1,
    mission_id: command.action === 'adopt' ? r.mission_id : p.mission_id,
    state: command.action === 'authorize' ? 'review_revision' : command.action === 'adopt' ? 'verified' : 'published',
  } }
}
function responseTo(view, action = 'authorize') {
  const call = view.requests.at(-1)
  const drafts = (call.body.findings ?? []).map((finding, index) => ({ ...finding, id: index,
    path: finding.path ?? '', source_url: finding.source_url ?? '', line: finding.line ? String(finding.line) : '' }))
  const command = operations.reviewRevisionCommand(view.props.scope, view.props.load, view.props.actorRole,
    action, drafts, call.body.reason ?? '')
  return responseFor(command, view.props.scope)
}

test('commands bind current actor, exact publication, source revision and Factory version', async () => {
  const load = await readLoad(publishedFixture())
  const command = operations.reviewRevisionCommand(scope, load, 'manager', 'authorize', findings, '')
  assert.equal(command.path, '/api/corps/corp-a/factory/work-items/item-a/review-revisions')
  assert.deepEqual(command.body, { actor_id: 'alice', expected_version: 9, observed_source_revision: 'issue-r1',
    publication_id: 'publication-a', published_head_commit: 'd'.repeat(40), findings: [{
      kind: 'security', summary: findings[0].summary, source_url: findings[0].source_url, path: 'src/auth.rs', line: 12,
    }] })
  for (const role of ['member', 'guest', 'spectator', '']) {
    assert.throws(() => operations.reviewRevisionCommand(scope, load, role, 'authorize', findings, ''))
  }
  const freshScope = reader.missionResultScope(ids)
  assert.equal(operations.reviewRevisionView(freshScope, load), null, 'same identifiers do not revive an old read generation')
  assert.throws(() => operations.reviewRevisionCommand(freshScope, load, 'owner', 'authorize', findings, ''))
  const missing = publishedFixture(); delete missing.publication.provenance.source_issue
  const missingLoad = await readLoad(missing)
  assert.throws(() => operations.reviewRevisionCommand(scope, missingLoad, 'manager', 'authorize', findings, ''))
})

test('finding validation rejects unbounded, malformed and credential-bearing inputs', () => {
  for (const input of [[], Array.from({ length: 21 }, () => findings[0]),
    [{ ...findings[0], summary: '🙂'.repeat(501) }], [{ ...findings[0], path: '../auth.rs' }],
    [{ ...findings[0], line: '1.5' }], [{ ...findings[0], line: '4294967296' }],
    [{ ...findings[0], source_url: 'https://user:password@example.org' }],
    [{ ...findings[0], source_url: `https://example.org/${'🙂'.repeat(501)}` }],
    [{ ...findings[0], path: '', line: '1' }]]) assert.throws(() => operations.findingsFromDraft(input))
  assert.equal(operations.findingsFromDraft([{ ...findings[0], summary: '  A concrete defect  ' }])[0].summary, 'A concrete defect')
})

test('mutation confirmation binds every source identity and authenticated decision', async () => {
  for (const action of ['authorize', 'adopt', 'abandon']) {
    const load = await readLoad(action === 'authorize' ? publishedFixture() : reviewRevisionFixture(scope))
    const command = operations.reviewRevisionCommand(scope, load, 'manager', action, findings, 'Verified the correction')
    const response = responseFor(command)
    assert.equal(operations.reviewRevisionResponseMatches(response, scope, command), true)
    for (const field of ['corp_id', 'factory_work_item_id', 'publication_id', 'source_head_commit',
      'source_mission_id', 'source_task_id', 'source_run_id', 'source_deliverable_id', 'state',
      action === 'authorize' ? 'authorized_by' : 'settled_by']) {
      const wrong = structuredClone(response); wrong.revision[field] = 'foreign'
      assert.equal(operations.reviewRevisionResponseMatches(wrong, scope, command), false, `${action}:${field}`)
    }
    for (const field of ['id', 'corp_id', 'mission_id', 'state', 'version']) {
      const wrong = structuredClone(response); wrong.work_item[field] = field === 'version' ? command.body.expected_version : 'foreign'
      assert.equal(operations.reviewRevisionResponseMatches(wrong, scope, command), false, field)
    }
    assert.equal(operations.reviewRevisionResponseMatches({}, scope, command), false)
  }
})

test('an initial unfinished publication never appears as published or enables correction', async () => {
  for (const phase of ['requested', 'publishing', 'branch_pushed', 'pull_request_created']) {
    const load = await readLoad(publishedFixture(scope, phase))
    assert.equal(operations.reviewRevisionView(scope, load), null)
    const view = panelFixture(load)
    assert.equal(text(view.tree), '')
    assert.equal(view.requests.length, 0)
    view.unmount()
  }
})

test('an unfinished successor retains the previous published head and adopted correction history', async () => {
  const value = reviewRevisionFixture(scope, 'published')
  const p = value.publication
  p.state = 'branch_pushed'; p.provenance.pull_request = null
  for (const key of Object.keys(p)) if (key.startsWith('pull_request_')) p[key] = null
  value.work_item.state = 'publishing'
  for (const failure of [null, 'Remote unavailable']) {
    p.failure_detail = failure
    const load = await readLoad(value)
    const model = operations.reviewRevisionView(scope, load)
    assert.equal(model.latest.id, 'publication-a')
    assert.equal(model.pendingPublication.id, 'publication-b')
    assert.equal(model.revision.state, 'adopted')
    const view = panelFixture(load)
    assert.match(text(view.tree), /Last recorded review head/)
    assert.match(text(view.tree), /No PR recorded yet/)
    assert.match(text(view.tree), /The superseding publication has not finished/)
    assert.doesNotMatch(text(view.tree), /PR #null|Authorize bounded corrections|Adoption or abandonment reason/)
    const currentHead = one(view.tree, 'dt', /^Last recorded review head$/)
    const fact = hosts(view.tree).find((node) => node.props.children?.includes?.(currentHead))
    assert.ok(fact, 'the recorded head has a labeled fact')
    assert.match(text(fact), new RegExp(model.latest.commit_sha))
    assert.doesNotMatch(text(fact), new RegExp(model.pendingPublication.commit_sha))
    assert.equal(view.requests.length, 0)
    view.unmount()
  }
})

test('authorization is explicit and double submit before rerender sends one bounded request', async () => {
  const view = panelFixture(await readLoad(publishedFixture()))
  assert.equal(view.requests.length, 0)
  assert.equal(view.storage.size, 0)
  view.fillSummary()
  const submit = one(view.tree, 'form', /Authorize bounded corrections/).props.onSubmit
  submit({ preventDefault() {} }); submit({ preventDefault() {} })
  assert.equal(view.requests.length, 1)
  assert.equal(view.requests[0].init.method, 'POST')
  assert.equal(view.requests[0].body.actor_id, scope.actorId)
  assert.equal(view.requests[0].body.published_head_commit, 'd'.repeat(40))
  assert.equal(view.requests[0].body.expected_version, 9)
  assert.doesNotMatch(JSON.stringify(view.requests[0].body), /launch|budget|tools|write_scope|reviewer|publish_branch/)
  view.requests[0].response.resolve(responseTo(view))
  await tick(); view.render()
  assert.equal(view.calls.refresh, 1)
  assert.equal(view.calls.changed, 1)
  assert.equal(view.storage.size, 0)
  assert.equal(view.requests.length, 1, 'authorization does not launch, review or publish')
  assert.equal(view.calls.navigation.length, 0)
  assert.match(text(view.tree), /Correction decision recorded/)
  view.unmount()
})

test('unconfirmed transport or malformed responses retain the App key for an unchanged retry', async () => {
  for (const outcome of ['transport', 'malformed']) {
    const view = panelFixture(await readLoad(publishedFixture()))
    view.fillSummary(); view.submit()
    const first = view.requests[0]
    if (outcome === 'transport') first.response.reject(new Error('connection lost'))
    else first.response.resolve({ revision: { id: 'foreign' } })
    await tick(); view.render()
    assert.equal(view.calls.refresh, 0)
    assert.equal(view.storage.size, 1)
    assert.match(text(view.tree), /could not be confirmed/)
    view.submit()
    assert.equal(view.requests.length, 2)
    assert.equal(view.requests[1].body.idempotency_key, first.body.idempotency_key)
    view.requests[1].response.resolve(responseTo(view))
    await tick(); view.render()
    assert.equal(view.storage.size, 0)
    view.unmount()
  }
})

test('timeout completes even when transport ignores abort and its late response cannot clear a retry', async () => {
  const view = panelFixture(await readLoad(publishedFixture()))
  view.fillSummary(); view.submit()
  const first = view.requests[0], firstResponse = responseTo(view)
  view.expire(); await tick(); view.render()
  assert.equal(first.init.signal.aborted, true)
  assert.match(text(view.tree), /could not be confirmed/)
  assert.equal(view.timers.size, 0)
  view.fillSummary('A newly scoped finding after the timeout.'); view.submit()
  assert.equal(view.requests.length, 2)
  assert.notEqual(view.requests[1].body.idempotency_key, first.body.idempotency_key)
  first.response.resolve(firstResponse)
  await tick(); view.render()
  assert.equal(view.storage.size, 1)
  assert.equal(view.calls.refresh, 0)
  view.requests[1].response.resolve(responseTo(view))
  await tick(); view.render()
  assert.equal(view.calls.refresh, 1)
  assert.equal(view.storage.size, 0)
  view.unmount()
})

test('A to B to A navigation cannot revive old callbacks or clear a newer operation', async () => {
  const load = await readLoad(publishedFixture())
  const view = panelFixture(load)
  view.fillSummary(); view.submit()
  const first = view.requests[0], response = responseTo(view)
  const retiredSubmit = one(view.tree, 'form', /Authorize bounded corrections/).props.onSubmit
  const other = reader.missionResultScope({ ...ids, actorId: 'bob' })
  view.render({ scope: other, load: await readLoad(publishedFixture(other), other) })
  assert.equal(first.init.signal.aborted, true)
  view.render({ scope, load })
  view.fillSummary('Current view finding'); view.submit()
  retiredSubmit({ preventDefault() {} })
  assert.equal(view.requests.length, 2)
  first.response.resolve(response)
  await tick(); view.render()
  assert.equal(view.calls.refresh, 0)
  assert.equal(view.storage.size, 1)
  const stored = JSON.parse([...view.storage.values()][0])
  assert.equal(stored.key, view.requests[1].body.idempotency_key)
  view.requests[1].response.resolve(responseTo(view))
  await tick(); view.render()
  assert.equal(view.calls.refresh, 1)
  view.unmount()
})

test('role, API, server, scope generation and unmount retire pending correction requests', async () => {
  for (const change of ['role', 'api', 'server', 'generation', 'unmount']) {
    const load = await readLoad(publishedFixture())
    const view = panelFixture(load)
    view.fillSummary(); view.submit()
    const first = view.requests[0], response = responseTo(view)
    const retiredSubmit = one(view.tree, 'form', /Authorize bounded corrections/).props.onSubmit
    if (change === 'role') view.render({ actorRole: 'member' })
    if (change === 'api') view.render({ api: async () => { throw new Error('replacement API was not invoked') } })
    if (change === 'server') view.render({ server: 'http://other-fixture.invalid' })
    if (change === 'generation') {
      const current = reader.missionResultScope(ids)
      view.render({ scope: current, load: await readLoad(publishedFixture(current), current) })
    }
    if (change === 'unmount') view.unmount()
    retiredSubmit({ preventDefault() {} })
    assert.equal(first.init.signal.aborted, true, change)
    first.response.resolve(response)
    await tick()
    assert.equal(view.requests.length, 1)
    assert.equal(view.calls.refresh, 0)
    assert.equal(view.calls.changed, 0)
    assert.equal(view.storage.size, 1)
    assert.equal(view.timers.size, 0)
    view.unmount()
  }
})

test('missing durable browser storage prevents a decision request', async () => {
  const view = panelFixture(await readLoad(publishedFixture()))
  view.fillSummary(); view.disableStorage(); view.submit(); view.render()
  assert.equal(view.requests.length, 0)
  assert.match(text(view.tree), /Browser storage could not preserve the retry key/)
  view.unmount()
})

test('adoption and abandonment use exact correction identities, saved source revision and a reason', async () => {
  for (const action of ['adopt', 'abandon']) {
    const selected = reader.missionResultScope({ ...ids, missionId: 'correction-a' })
    const view = panelFixture(await readLoad(reviewRevisionFixture(scope), selected))
    assert.match(text(view.tree), /Unadopted correction source/)
    assert.match(text(view.tree), /Fixture authorizer/)
    view.fillReason('  Inspected the saved correction and its review.  ')
    if (action === 'adopt') view.submit()
    else one(view.tree, 'button', /^Abandon correction$/).props.onClick()
    assert.equal(view.requests.length, 1)
    assert.equal(view.requests[0].path, `/api/corps/corp-a/factory/work-items/item-a/review-revisions/revision-a/${action}`)
    assert.deepEqual(Object.keys(view.requests[0].body).sort(), ['actor_id', 'expected_version', 'idempotency_key', 'observed_source_revision', 'reason'])
    assert.equal(view.requests[0].body.observed_source_revision, 'issue-r1')
    assert.equal(view.requests[0].body.reason, 'Inspected the saved correction and its review.')
    view.requests[0].response.resolve(responseTo(view, action))
    await tick(); view.render()
    assert.equal(view.calls.refresh, 1)
    assert.equal(view.storage.size, 0)
    view.unmount()
  }
})

test('settlement cannot infer acceptance from multiple exports or an absent reason', async () => {
  const value = reviewRevisionFixture(scope)
  value.source_deliverables.push({ ...value.source_deliverables[1], id: 'second-export', run_id: 'second-run' })
  const view = panelFixture(await readLoad(value))
  assert.equal(one(view.tree, 'button', /^Adopt verified correction$/).props.disabled, true)
  view.submit(); view.render()
  assert.equal(view.requests.length, 0)
  view.fillReason(); view.submit(); view.render()
  assert.equal(view.requests.length, 0)
  assert.match(text(view.tree), /single replacement export is required/)
  view.unmount()
})

test('history navigates and downloads the exact correction run without snapshot membership', async () => {
  const view = panelFixture(await readLoad(reviewRevisionFixture(scope)))
  one(view.tree, 'button', /^Inspect correction run$/).props.onClick()
  assert.deepEqual(view.calls.navigation, [['correction-a', 'correction-run']])
  one(view.tree, 'button', /^Download unadopted source$/).props.onClick()
  assert.equal(view.calls.downloads[0].id, 'correction-deliverable')
  assert.equal(view.requests.length, 0)
  view.unmount()
})

test('read-only and adopted views expose evidence while withholding decision forms', async () => {
  const readonly = panelFixture(await readLoad(reviewRevisionFixture(scope)), { actorRole: 'member' })
  assert.equal(hosts(readonly.tree).filter((node) => node.type === 'form').length, 0)
  assert.match(text(readonly.tree), /An owner, admin or manager/)
  readonly.unmount()
  const adopted = panelFixture(await readLoad(reviewRevisionFixture(scope, 'adopted')))
  assert.match(text(adopted.tree), /Adopted replacement/)
  assert.match(text(adopted.tree), /awaits an explicit superseding publication/)
  assert.equal(hosts(adopted.tree).filter((node) => node.type === 'form').length, 0)
  adopted.unmount()
})

test('removing a finding preserves the remaining input and moves focus to its actual label target', async () => {
  const view = panelFixture(await readLoad(publishedFixture()))
  view.fillSummary('First finding')
  one(view.tree, 'button', /^Add finding$/).props.onClick(); view.render()
  const second = hosts(view.tree).filter((node) => node.type === 'textarea')[1]
  second.props.onChange({ target: { value: 'Second finding' } }); view.render()
  one(view.tree, 'button', /^Remove finding 1$/).props.onClick(); view.render()
  for (const callback of view.animationFrames.splice(0)) callback()
  const remaining = hosts(view.tree).filter((node) => node.type === 'textarea')
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].props.value, 'Second finding')
  assert.deepEqual(view.calls.focus, [remaining[0].props.id])
  assert.ok(hosts(view.tree).some((node) => node.type === 'label' && node.props.htmlFor === remaining[0].props.id))
  view.unmount()
})
