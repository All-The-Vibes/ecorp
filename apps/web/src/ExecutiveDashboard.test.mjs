import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as budget from './budgetOverview.ts'
import * as executive from './executiveOverview.ts'
import * as reader from './missionResultContext.ts'
import { executiveFixture } from './testSupport/executiveFixture.mjs'
import { elements, renderHooks } from './testSupport/renderHooks.mjs'

// Production components and the existing authorized result reader. Only time,
// transport and hook scheduling are controlled; this is not browser acceptance.
const sources = Object.fromEntries(await Promise.all([
  'ExecutiveDashboard.tsx', 'useMissionResultContext.ts', 'PublishedResultCard.tsx', 'WorkResultCard.tsx',
].map(async (fileName) => {
  const source = await readFile(new URL(`./${fileName}`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
  assert.deepEqual(compiled.diagnostics, [], fileName)
  return [fileName, compiled.outputText]
})))
function evaluate(source, imports) {
  const exports = {}
  new Function('require', 'exports', source)((name) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected dependency ${name}`)
    return imports[name]
  }, exports)
  return exports
}
const { WorkResultCard } = evaluate(sources['WorkResultCard.tsx'], {
  'react/jsx-runtime': jsxRuntime, './WorkResultCard.css': {},
})
const { PublishedResultCard } = evaluate(sources['PublishedResultCard.tsx'], {
  'react/jsx-runtime': jsxRuntime, './WorkResultCard': { WorkResultCard },
})
function loadDashboard(react) {
  const hook = evaluate(sources['useMissionResultContext.ts'], { react, './missionResultContext': reader })
  // Expose the module-private production component only in this test loader.
  return evaluate(`${sources['ExecutiveDashboard.tsx']}\nexports.ExecutiveResult = ExecutiveResult;`, {
    react, 'react/jsx-runtime': jsxRuntime, './budgetOverview': budget, './executiveOverview': executive,
    './missionResultContext': reader, './useMissionResultContext': hook,
    './PublishedResultCard': { PublishedResultCard }, './ExecutiveDashboard.css': {},
  })
}
const { ExecutiveDashboard } = loadDashboard(React)
function propsFor(f = executiveFixture()) {
  return { ...f, api: async () => { throw new Error('No unowned result request is expected') },
    onOpen() {}, onRefresh() {}, onWorkspace() {} }
}
const render = (props) => renderToStaticMarkup(jsxRuntime.jsx(ExecutiveDashboard, props))
const markup = (tree) => renderToStaticMarkup(tree)
const tick = () => new Promise((resolve) => setImmediate(resolve))
function button(tree, label) {
  const matches = elements(tree, (node) => node.type === 'button' && node.props.children === label)
  assert.equal(matches.length, 1, `Expected one ${label} control`)
  return matches[0].props
}

test('Executive rendering presents recorded outcomes, team and unavailable results without operational controls', () => {
  const html = render(propsFor())
  assert.match(html, /Outcomes &amp; decisions/)
  assert.match(html, /Deliver the scoped search/)
  assert.match(html, /Task counts describe returned records, not a completion estimate/)
  assert.match(html, /1 Running/)
  assert.match(html, /Delivery engineer/)
  assert.match(html, /No uniquely attributed intake result/)
  assert.match(html, /Browse authorized history in Operations/)
  assert.doesNotMatch(html, /corp-a|room-a|mission-a|task-a|run-a|artifact-a|agent-a|runner-a/)
  assert.doesNotMatch(html, /<(form|input|select|textarea)\b|Approve|Reject|Cancel run|Restart|Stop runner|Download source/)
})

test('failed checks, rejections, unknown state, pending decisions and exhausted authority remain outside disclosures', () => {
  const f = executiveFixture()
  f.snapshot.missions[0].status = 'unknown'
  f.snapshot.tasks[0].status = 'awaiting_approval'
  f.snapshot.runs[0].input_tokens = 1000
  f.snapshot.runs[0].verification_status = 'failed'
  f.snapshot.verification_requests.push({ run_id: 'run-a', task_id: 'task-a', status: 'rejected' })
  f.snapshot.verification_evidence.push({ id: 'check-a', run_id: 'run-a', task_id: 'task-a', status: 'failed' })
  const html = render(propsFor(f)).split('<details')[0]
  assert.match(html, /A failed check remains in the evidence/)
  assert.match(html, /A recorded decision was rejected/)
  assert.match(html, /Awaiting approval/)
  assert.match(html, /Mission state unconfirmed/)
  assert.match(html, /ceiling is exhausted/)
  assert.doesNotMatch(html, /No decision or blocker is reported/)
})

for (const [label, change] of [
  ['access denied', (p) => { p.stamp.refreshFailed = true }],
  ['different actor', (p) => { p.viewer.actorId = 'bob' }],
  ['different Corp', (p) => { p.viewer.corpId = 'corp-b' }],
  ['offline', (p) => { p.stamp.connection = 'offline' }],
  ['reconnecting', (p) => { p.stamp.connection = 'connecting' }],
  ['missing receipt', (p) => { p.stamp.receivedAt = null }],
  ['expired receipt', (p) => { p.stamp.receivedAt = '2000-01-01T00:00:00Z' }],
  ['future receipt', (p) => { p.stamp.receivedAt = '2099-01-01T00:00:00Z' }],
]) test(`${label} removes previous mission titles, people, decisions and result links during rendering`, () => {
  const props = propsFor(); change(props)
  const html = render(props)
  assert.match(html, /Current work is unavailable/)
  assert.match(html, /Refresh work/)
  assert.match(html, /runner can continue independently/)
  assert.doesNotMatch(html, /Deliver the scoped search|Delivery engineer|Open mission|Inspect exact|href=/)
})

test('an authorized empty snapshot remains distinct from a read failure and is not all-history absence', () => {
  const props = propsFor()
  props.snapshot.missions = []; props.snapshot.tasks = []; props.snapshot.runs = []
  const html = render(props)
  assert.match(html, /No missions were returned for this authorized view/)
  assert.match(html, /does not establish that the Corp has no historical work/)
  assert.doesNotMatch(html, /Current work is unavailable/)
})

test('mission and team content is escaped as text', () => {
  const props = propsFor()
  props.snapshot.missions[0].title = '<img src=x onerror=alert(1)>'
  props.snapshot.agents[0].name = '<script>untrusted</script>'
  const html = render(props)
  assert.match(html, /&lt;img/)
  assert.match(html, /&lt;script/)
  assert.doesNotMatch(html, /<(script|img)\b/)
})

function clockFixture(t) {
  const hooks = renderHooks(), dashboard = loadDashboard(hooks.react).ExecutiveDashboard
  const timers = new Map(), calls = { opened: [], refreshed: 0 }
  let now = Date.parse('2026-09-30T05:00:00Z'), sequence = 0
  let props = propsFor(executiveFixture(now))
  props.onOpen = (value) => calls.opened.push(value)
  props.onRefresh = () => { calls.refreshed++ }
  const original = globalThis.window
  t.mock.method(Date, 'now', () => now)
  globalThis.window = {
    setTimeout(callback, delay) { timers.set(++sequence, { at: now + delay, callback }); return sequence },
    clearTimeout(key) { timers.delete(key) },
  }
  t.after(() => {
    hooks.unmount(); assert.equal(timers.size, 0)
    if (original === undefined) delete globalThis.window
    else globalThis.window = original
  })
  return {
    hooks, timers, calls,
    get now() { return now }, set now(value) { now = value },
    get props() { return props },
    render() { return hooks.render(() => dashboard(props)) },
    replace(next) { props = next; return hooks.begin(() => dashboard(props)) },
    due() {
      for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback() }
      return hooks.flush()
    },
  }
}
const missionCards = (tree) => elements(tree, (node) => node.type === 'article').length
test('receipt expiration removes mission cards and rechecks a click before a throttled timer fires', (t) => {
  const c = clockFixture(t), initial = c.render(); c.due()
  assert.equal(missionCards(initial), 1)
  const open = button(initial, 'Open mission in Operations').onClick
  open(); assert.deepEqual(c.calls.opened, [{ kind: 'mission', id: 'mission-a', missionId: 'mission-a' }])
  c.now += budget.BUDGET_SNAPSHOT_FRESH_MS
  open(); assert.equal(c.calls.opened.length, 1); assert.equal(c.calls.refreshed, 1)
  c.now++; assert.equal(missionCards(c.due()), 0)
  assert.equal(c.timers.size, 0)
})
test('fresh receipts replace their timer and permission loss hides data before effects', (t) => {
  const c = clockFixture(t); c.render(); c.due()
  c.now += 30_000
  c.replace({ ...c.props, stamp: { ...c.props.stamp, receivedAt: new Date(c.now).toISOString() } })
  assert.equal(missionCards(c.hooks.flushLayout()), 1, 'Fresh mission cards are present before passive effects or timers')
  c.hooks.flush(); c.due(); c.now += 30_002
  assert.equal(missionCards(c.due()), 1)
  const denied = c.replace({ ...c.props, stamp: { ...c.props.stamp, refreshFailed: true } })
  assert.equal(missionCards(denied), 0)
  c.hooks.flush()
  assert.equal(missionCards(c.replace({ ...c.props, viewer: { ...c.props.viewer, actorId: 'bob' } })), 0)
})
test('receipt synchronization retains rejection of a genuinely future receipt', (t) => {
  const c = clockFixture(t); c.render(); c.now += 30_000
  c.replace({ ...c.props, stamp: { ...c.props.stamp, receivedAt: new Date(c.now + 120_000).toISOString() } })
  assert.equal(missionCards(c.hooks.flushLayout()), 0)
  assert.equal(missionCards(c.due()), 0)
})
test('StrictMode repeated cleanup/setup leaves one expiry and no timer after unmount', (t) => {
  const c = clockFixture(t); c.render(); c.hooks.replayEffects(); c.hooks.replayEffects(); c.due()
  assert.equal(c.timers.size, 1)
  c.now += budget.BUDGET_SNAPSHOT_FRESH_MS + 1
  assert.equal(missionCards(c.due()), 0)
})

function publicationFixture() {
  const digest = 'a'.repeat(64), verification = 'b'.repeat(64), base = 'c'.repeat(40), head = 'd'.repeat(40)
  const issue = 'https://github.com/owner/repo/issues/71'
  const pr = { number: 17, url: 'https://github.com/owner/repo/pull/17', state: 'OPEN', draft: false,
    base_ref: 'main', head_sha: head, head_repository_owner: 'owner', is_cross_repository: false }
  const deliverable = { id: 'deliverable-a', corp_id: 'corp-a', task_id: 'task-a', run_id: 'run-a',
    artifact_id: 'artifact-a', form: 'commit_branch', file_name: 'ecorp-commit-branch.json',
    uri: '/api/corps/corp-a/artifacts/artifact-a', sha256: digest,
    media_type: 'application/vnd.ecorp.deliverable+json', bytes: 1234, provenance_signature: 'e'.repeat(64),
    verification_sha256: verification, base_commit: base, head_commit: head, branch: 'crony/source',
    integration_state: 'published', retention_until: '2099-01-01T00:00:00Z' }
  return { work_item: { id: 'item-a', corp_id: 'corp-a', mission_id: 'mission-a', version: 9,
    source_repository_owner: 'owner', source_repository_name: 'repo', source_issue_number: 71, source_issue_url: issue },
  publication: { id: 'publication-a', corp_id: 'corp-a', mission_id: 'mission-a', factory_work_item_id: 'item-a',
    task_id: 'task-a', run_id: 'run-a', artifact_id: 'artifact-a', source_deliverable_id: 'deliverable-a',
    source_issue_number: 71, source_issue_url: issue, state: 'published', version: 4,
    target_repository: 'owner/repo', base_ref: 'HEAD', branch: 'ecorp/result', commit_sha: head, failure_detail: null,
    pull_request_number: pr.number, pull_request_url: pr.url, pull_request_state: pr.state, pull_request_draft: pr.draft,
    pull_request_base_ref: pr.base_ref, pull_request_head_sha: head, pull_request_head_repository_owner: 'owner',
    pull_request_is_cross_repository: false,
    provenance: { schema_version: 2, factory_work_item_id: 'item-a', mission_id: 'mission-a',
      task_ids: ['task-a'], run_ids: ['run-a'], verification_sha256: verification,
      deliverable: { id: 'deliverable-a', artifact_id: 'artifact-a', sha256: digest,
        base_commit: base, head_commit: head, source_branch: deliverable.branch },
      target: { repository: 'owner/repo', base_ref: 'HEAD', branch: 'ecorp/result', commit: head }, pull_request: pr } },
  source_deliverables: [deliverable] }
}
function resultFixture(t, role = 'owner', response = publicationFixture()) {
  const hooks = renderHooks(), Result = loadDashboard(hooks.react).ExecutiveResult
  const f = executiveFixture(), calls = { requests: [], opened: [] }
  f.viewer.role = role
  f.snapshot.factory_work_items = [{ ...response.work_item, state: 'published' }]
  f.snapshot.runs.unshift({ ...f.snapshot.runs[0], id: 'run-newer', artifact_id: 'artifact-newer' })
  const row = executive.buildExecutiveOverview(f.snapshot, f.viewer, f.stamp, f.runners, f.now).missions[0]
  let props = { row, viewer: f.viewer, onOpen: (target) => calls.opened.push(target),
    api: async (...args) => { calls.requests.push(args); return response } }
  t.after(() => hooks.unmount())
  return { hooks, calls,
    get props() { return props },
    replace(next) { props = next; return hooks.begin(() => Result(props)) },
    render() { return hooks.render(() => Result(props)) },
    async settle() { await tick(); hooks.flush(); return markup(hooks.value) },
  }
}
for (const role of ['owner', 'admin', 'manager', 'member']) test(`${role} reuses the existing result reader and keeps the delivered older run`, async (t) => {
  const f = resultFixture(t, role); f.render()
  const html = await f.settle()
  assert.match(html, /Open pull request #17/)
  assert.match(html, /https:\/\/github.com\/owner\/repo\/pull\/17/)
  assert.equal(f.calls.requests.length, 1)
  const [path, options] = f.calls.requests[0]
  assert.equal(path, '/api/corps/corp-a/factory/work-items/item-a/publication-context?actor_id=alice')
  assert.equal(options.method, 'GET'); assert.equal(options.cache, 'no-store')
  button(f.hooks.value, 'Open delivered evidence in Operations').onClick()
  assert.deepEqual(f.calls.opened, [{ kind: 'run', id: 'run-a', missionId: 'mission-a' }])
  const collapsed = html.slice(html.indexOf('<details'))
  assert.match(collapsed, /Delivered run/); assert.doesNotMatch(collapsed, /<details[^>]*\bopen/)
  assert.doesNotMatch(html.slice(0, html.indexOf('<details')), /run-a|publication-a|Approve|Reject|Download source/)
})
for (const role of ['viewer', 'guest', 'unknown']) test(`${role} gets no new result authority or publication request`, async (t) => {
  const f = resultFixture(t, role); f.render()
  const html = await f.settle()
  assert.match(html, /Result details are unavailable/)
  assert.doesNotMatch(html, /github.com|Delivered run|Open delivered/)
  assert.equal(f.calls.requests.length, 0)
})
test('missing delivered run remains unavailable without substituting newer work', async (t) => {
  const f = resultFixture(t)
  f.props.row.runs = f.props.row.runs.filter((run) => run.id !== 'run-a')
  f.render(); const html = await f.settle()
  assert.match(html, /delivered run is outside this snapshot/)
  assert.match(html, /no newer run has been substituted/)
  assert.doesNotMatch(html, /Open delivered evidence/)
  assert.deepEqual(f.calls.opened, [])
})
test('role loss, actor change and A to B to A remove earlier results before effects and reject late requests', async (t) => {
  const f = resultFixture(t); f.render(); assert.match(await f.settle(), /Open pull request/)
  const denied = f.replace({ ...f.props, viewer: { ...f.props.viewer, role: 'viewer' } })
  assert.doesNotMatch(markup(denied), /Open pull request|Open delivered evidence/)
  f.hooks.flush(); assert.equal(f.calls.requests.length, 1)
  const pending = []
  const api = (...args) => new Promise((resolve) => pending.push({ args, resolve }))
  f.replace({ ...f.props, viewer: { ...f.props.viewer, role: 'owner' }, api }); f.hooks.flush(); await tick()
  f.replace({ ...f.props, viewer: { ...f.props.viewer, actorId: 'bob' } }); f.hooks.flush(); await tick()
  const again = f.replace({ ...f.props, viewer: { ...f.props.viewer, actorId: 'alice' } })
  assert.doesNotMatch(markup(again), /Open pull request/)
  f.hooks.flush(); await tick()
  assert.equal(pending.length, 3)
  assert.equal(pending[0].args[1].signal.aborted, true)
  assert.equal(pending[1].args[1].signal.aborted, true)
  pending[0].resolve(publicationFixture()); pending[1].resolve(publicationFixture())
  assert.doesNotMatch(await f.settle(), /Open pull request/)
  pending[2].resolve(publicationFixture()); assert.match(await f.settle(), /Open pull request/)
})
test('malformed publication identity fails closed without raw transport or credentials in the UI', async (t) => {
  const response = publicationFixture(); response.publication.corp_id = 'foreign-corp'
  const f = resultFixture(t, 'owner', response); f.render()
  const html = await f.settle()
  assert.match(html, /Result details are unavailable/)
  assert.doesNotMatch(html, /foreign-corp|github.com|Open delivered/)
})
