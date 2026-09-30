import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as budget from './budgetOverview.ts'
import { elements, renderHooks } from './testSupport/renderHooks.mjs'

const source = await readFile(new URL('./BudgetOverviewPanel.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { fileName: 'BudgetOverviewPanel.tsx', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
assert.deepEqual(compiled.diagnostics, [])
function loadPanel(react) {
  const exports = {}
  new Function('require', 'exports', compiled.outputText)((name) => {
    const imports = { react, 'react/jsx-runtime': jsxRuntime, './budgetOverview': budget, './BudgetOverviewPanel.css': {} }
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`)
    return imports[name]
  }, exports)
  return exports.BudgetOverviewPanel
}
const BudgetOverviewPanel = loadPanel(React)

function fixture() {
  return {
    snapshot: {
      corp: { id: 'corp-a', name: 'Authorized Corp' },
      rooms: [{ id: 'room-a', corp_id: 'corp-a' }],
      missions: [{ id: 'mission-a', corp_id: 'corp-a', room_id: 'room-a', title: 'Scoped mission', status: 'running',
        original_budget_tokens: 1000, original_budget_cost_microusd: 1_000_000,
        budget_tokens: 2000, budget_cost_microusd: 2_000_000 }],
      tasks: [{ id: 'task-a', corp_id: 'corp-a', mission_id: 'mission-a', attempt_count: 1 }],
      runs: [{ id: 'run-a', corp_id: 'corp-a', task_id: 'task-a', agent_id: 'worker-a', status: 'cancelled',
        breaker_stage: 'suspend', resumed_from_run_id: null, input_tokens: 100, output_tokens: 10, cost_microusd: 0 }],
      mission_budget_revisions: [{ id: 'revision-a', corp_id: 'corp-a', mission_id: 'mission-a', status: 'pending', version: 2,
        proposed_budget_tokens: 3000, proposed_budget_cost_microusd: 3_000_000 }],
    },
    viewer: { corpId: 'corp-a', actorId: 'alice' },
    stamp: { corpId: 'corp-a', actorId: 'alice', receivedAt: new Date().toISOString(), connection: 'live', refreshFailed: false },
    onRefresh() {}, onOpen() {},
  }
}
const render = (props) => renderToStaticMarkup(jsxRuntime.jsx(BudgetOverviewPanel, props))

test('renders actual snapshot totals and limitations with pending decisions outside the disclosure', () => {
  const html = render(fixture())
  const summary = html.split('<details')[0]
  assert.match(summary, /Snapshot-limited totals/)
  assert.match(summary, /No time filter; includes completed work returned in this snapshot/)
  assert.match(summary, /not a shared pool or permission to spend/)
  assert.match(summary, /1,000 tokens/)
  assert.match(summary, /2,000 tokens/)
  assert.match(summary, /110 tokens/)
  assert.match(summary, /1,890 tokens/)
  assert.match(summary, /1 budget requests need a decision/)
  assert.match(summary, /Scoped mission · inspect pending revision 2/)
  assert.match(summary, /3,000 tokens · \$3.00. Not yet authorized/)
  assert.match(summary, /Measured and estimated cost are unavailable/)
  assert.match(summary, /1 runs have unpriced token usage/)
  assert.match(summary, /Zero reported cost is not evidence of free work/)
  assert.match(summary, /remainder may overstate headroom/)
  assert.match(summary, /Auditor-led extension and audit status are unavailable/)
  assert.match(summary, /1 revised mission ceilings have no matching approval receipt/)
  assert.match(html, /Inspect suspension run-a &amp; existing recovery controls/)
  assert.doesNotMatch(html, /<details[^>]*\bopen/)
})

for (const [name, change] of [
  ['revoked refresh', (props) => { props.stamp.refreshFailed = true }],
  ['changed actor', (props) => { props.viewer.actorId = 'bob' }],
  ['changed Corp', (props) => { props.viewer.corpId = 'corp-b' }],
  ['offline', (props) => { props.stamp.connection = 'offline' }],
  ['old receipt', (props) => { props.stamp.receivedAt = '2000-01-01T00:00:00Z' }],
  ['missing receipt', (props) => { props.stamp.receivedAt = null }],
]) test(`${name} renders a refreshable state with no prior titles, spend or decision links`, () => {
  const props = fixture()
  change(props)
  const html = render(props)
  assert.match(html, /role="status"/)
  assert.match(html, /Refresh budgets/)
  assert.doesNotMatch(html, /Scoped mission|Authorized Corp|budget-overview-totals|revision-a|2,000 tokens/)
})

test('empty authorized data differs from a failed read', () => {
  const props = fixture()
  for (const key of ['missions', 'tasks', 'runs', 'mission_budget_revisions']) props.snapshot[key] = []
  const html = render(props)
  assert.match(html, /No missions are available in this authorized snapshot/)
  assert.match(html, /0 tokens/)
  assert.match(html, /\$0.00/)
  assert.doesNotMatch(html, /role="status"/)
})

test('missing history and invalid requested amounts stay explicit without crashing the component', () => {
  const props = fixture()
  props.snapshot.tasks[0].attempt_count = 2
  props.snapshot.mission_budget_revisions[0].proposed_budget_tokens = NaN
  props.snapshot.mission_budget_revisions[0].proposed_budget_cost_microusd = 0.1
  const html = render(props)
  assert.match(html.split('<details')[0], /Some usage or run history is missing or invalid/)
  assert.match(html, /Requested: Unavailable · Unavailable. Not yet authorized/)
  assert.match(html, /recorded subtotal is not proof of total consumption/)
})

test('mission labels use React escaping and never introduce executable markup', () => {
  const props = fixture()
  props.snapshot.missions[0].title = '<script>alert("not markup")</script>'
  const html = render(props)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script\b/)
})

function clockFixture(t) {
  const hooks = renderHooks(), panel = loadPanel(hooks.react), timers = new Map()
  let now = Date.parse('2026-09-29T12:00:00Z'), id = 0, props = fixture()
  const calls = { opened: [], refreshed: 0 }
  props.stamp.receivedAt = new Date(now).toISOString()
  props.onOpen = (target) => calls.opened.push(target)
  props.onRefresh = () => { calls.refreshed++ }
  t.mock.method(Date, 'now', () => now)
  const original = globalThis.window
  globalThis.window = {
    setTimeout(callback, delay) { timers.set(++id, { at: now + delay, callback }); return id },
    clearTimeout(key) { timers.delete(key) },
  }
  t.after(() => {
    hooks.unmount()
    assert.equal(timers.size, 0, 'Unmount releases every owned timer')
    if (original === undefined) delete globalThis.window
    else globalThis.window = original
  })
  return {
    hooks, calls, timers,
    get now() { return now },
    set now(value) { now = value },
    get props() { return props },
    replace(next) { props = next; return hooks.begin(() => panel(props)) },
    render() { return hooks.render(() => panel(props)) },
    due() {
      for (const [key, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(key); timer.callback()
      }
      return hooks.flush()
    },
  }
}
const hasTotals = (tree) => elements(tree, (node) => node.props?.['data-testid'] === 'budget-overview-totals').length > 0
const openBudget = (tree) => elements(tree, (node) => node.type === 'button' && node.props.children === 'Open mission budget')[0].props.onClick()

test('clock expiry hides totals without polling and navigation rechecks a delayed timer', (t) => {
  const c = clockFixture(t)
  const initial = c.render()
  assert.equal(hasTotals(initial), true)
  c.due()
  openBudget(initial)
  assert.equal(c.calls.opened.length, 1)
  c.now += budget.BUDGET_SNAPSHOT_FRESH_MS
  openBudget(initial) // The browser may throttle the scheduled expiration callback.
  assert.equal(c.calls.opened.length, 1)
  assert.equal(c.calls.refreshed, 1)
  c.now++
  assert.equal(hasTotals(c.due()), false)
  assert.equal(c.timers.size, 0, 'A spent snapshot does not schedule repeated clock work')
})

test('a fresh receipt cancels prior expiration and access loss hides data before effects', (t) => {
  const c = clockFixture(t)
  c.render(); c.due()
  c.now += 30_000
  c.replace({ ...c.props, stamp: { ...c.props.stamp, receivedAt: new Date(c.now).toISOString() } })
  c.hooks.flush(); c.due()
  assert.equal(hasTotals(c.hooks.value), true)
  c.now += 30_002
  assert.equal(hasTotals(c.due()), true, 'The superseded receipt cannot expire the current data')
  const denied = c.replace({ ...c.props, stamp: { ...c.props.stamp, refreshFailed: true } })
  assert.equal(hasTotals(denied), false, 'A denied refresh removes amounts during render')
  c.hooks.flush()
  const otherViewer = c.replace({ ...c.props, viewer: { corpId: 'corp-a', actorId: 'bob' } })
  assert.equal(hasTotals(otherViewer), false)
})

test('StrictMode effect replay owns one receipt sample and expiry with no leaked timer', (t) => {
  const c = clockFixture(t)
  c.render()
  c.hooks.replayEffects()
  c.hooks.replayEffects()
  c.due()
  c.now += budget.BUDGET_SNAPSHOT_FRESH_MS + 1
  assert.equal(hasTotals(c.due()), false)
  assert.equal(c.timers.size, 0)
})
