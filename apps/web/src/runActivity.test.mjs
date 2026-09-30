import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'
import * as activity from './runActivity.ts'
import { selectOfficeAgent } from './office/officeModel.ts'

const at = (seconds) => new Date(Date.UTC(2026, 8, 14, 12, 0, seconds)).toISOString()
const event = (seq, type, payload = {}, overrides = {}) => ({
  id: `event-${seq}`, seq, type, aggregate_type: 'run', aggregate_id: 'run-a',
  corp_id: 'corp-a', room_id: 'room-a', created_at: at(seq), payload, ...overrides,
})
function fixture(changes = {}) {
  return {
    corpId: 'corp-a', mission: { id: 'mission-a', room_id: 'room-a', status: 'running' },
    run: { id: 'run-a', task_id: 'task-a', agent_id: 'agent-a', runner_id: 'runner-a',
      status: 'running', execution_mode: 'provider', verification_status: 'pending' },
    tasks: [{ id: 'task-a', mission_id: 'mission-a', title: 'Implement accessible search', assigned_agent_id: 'agent-a' }],
    agents: [{ id: 'agent-a', name: 'Delivery engineer', adapter: 'github-copilot', current_run_id: 'run-a' }],
    runners: [{ id: 'runner-a', corp_id: 'corp-a', connected: true, status: 'connected', last_seen_at: at(29) }],
    actors: [{ id: 'alice', name: 'Alice' }],
    leases: [{ agent_id: 'agent-a', actor_id: 'alice', expires_at: at(60) }],
    events: [event(1, 'run.started'), event(15, 'run.tool_activity', { progressed: true })],
    reviews: [], approvals: [], connection: 'live', snapshotReceivedAt: at(30), factoryState: 'running',
    ...changes,
  }
}
const fact = (view, label) => view.facts.find((item) => item.label === label)
const viewFor = (run, extra = {}) => activity.presentRunActivity(fixture({ run: { ...fixture().run, ...run }, ...extra }))

test('Factory activity prioritizes the exact outcome review, then tool approval, before newer work', () => {
  const running = { ...fixture().run, id: 'newer' }
  const toolWait = { ...fixture().run, id: 'tool-wait', status: 'waiting_for_approval' }
  const reviewWait = { ...fixture().run, id: 'review-wait', task_id: 'review-task', status: 'waiting_for_approval' }
  const runs = [running, toolWait, reviewWait], before = structuredClone(runs)
  const approvals = [{ run_id: toolWait.id, status: 'pending' }]
  const reviews = [{ run_id: reviewWait.id, task_id: reviewWait.task_id, status: 'pending' }]
  assert.equal(activity.selectActivityRun(runs, reviews, approvals), reviewWait)
  assert.equal(activity.selectActivityRun(runs, [], approvals), toolWait)
  assert.equal(activity.selectActivityRun(runs, [], []), running)
  assert.deepEqual(runs, before)
})

test('selection ignores terminal, denied and foreign tool approvals without inventing a run', () => {
  const running = fixture().run
  const stopped = { ...running, id: 'stopped', status: 'cancelled' }
  const waiting = { ...running, id: 'waiting', status: 'waiting_for_approval' }
  const approvals = [{ run_id: 'stopped', status: 'pending' }, { run_id: 'waiting', status: 'rejected' }, { run_id: 'foreign', status: 'pending' }]
  assert.equal(activity.selectActivityRun([running, stopped, waiting], [], approvals), running)
  assert.equal(activity.selectActivityRun([], [], approvals), undefined)
})

test('terminal runs cannot become reviewable or active from dangling pending decision records', () => {
  for (const status of ['lost', 'cancelled', 'failed', 'completed']) {
    const input = fixture({
      run: { ...fixture().run, status },
      reviews: [{ run_id: 'run-a', task_id: 'task-a', status: 'pending' }],
      approvals: [{ run_id: 'run-a', status: 'pending' }],
    })
    const view = activity.presentRunActivity(input)
    assert.doesNotMatch(view.status, /Awaiting review|Awaiting decision|Executing/)
    assert.doesNotMatch(view.heading, /needs review|needs a decision/)
    assert.doesNotMatch(fact(view, 'Provider execution').value, /reported active/)
  }
})

test('live task, agent, control, timestamps and safe activity come from one scope without mutation', () => {
  const input = fixture(), before = structuredClone(input)
  const view = activity.presentRunActivity(input)
  assert.equal(view.runId, 'run-a')
  assert.equal(view.status, 'Executing')
  assert.match(fact(view, 'Assigned agent').value, /Delivery engineer · GitHub Copilot/)
  assert.match(fact(view, 'Assigned agent').detail, /Alice/)
  assert.equal(fact(view, 'Task in focus').value, input.tasks[0].title)
  assert.match(fact(view, 'Provider execution').value, /reported active/)
  assert.equal(view.latest.at, at(15))
  assert.equal(view.latest.label, 'Tool activity reported progress')
  assert.match(view.context.find((item) => item.label === 'Recorded run interval').value, /^14s through/)
  assert.deepEqual(input, before)
})

test('a stale Running intake never claims that a cancelled provider is active', () => {
  const view = viewFor({ status: 'cancelled', breaker_stage: 'suspend' }, {
    mission: { ...fixture().mission, status: 'cancelled' },
    events: [event(1, 'run.started'), event(20, 'run.session_terminated', { provider_process_alive: false }), event(21, 'run.cancelled')],
  })
  assert.equal(view.status, 'Needs attention')
  assert.equal(fact(view, 'Provider execution').value, 'Provider termination confirmed')
  assert.ok(view.notices.some((text) => /intake record says Running/.test(text)))
  assert.match(view.context.find((item) => item.label === 'Recorded run interval').value, /^19s through/)
})

test('pending exact-run outcome review is distinct from an active provider and completion', () => {
  const view = viewFor({ status: 'waiting_for_approval', verification_status: 'passed' }, {
    reviews: [{ run_id: 'run-a', task_id: 'task-a', status: 'pending' }],
    events: [event(1, 'run.started'), event(20, 'run.verification_waiting')],
  })
  assert.equal(view.status, 'Awaiting review')
  assert.doesNotMatch(fact(view, 'Provider execution').value, /reported active/)
  assert.match(view.summary, /not the required human/)
  assert.equal(view.latest.label, 'Outcome review pending')
})

test('tool authority and unavailable decision context do not become outcome approval', () => {
  assert.equal(viewFor({ status: 'waiting_for_approval' }, { approvals: [{ run_id: 'run-a', status: 'pending' }] }).status, 'Awaiting decision')
  assert.equal(viewFor({ status: 'waiting_for_approval' }).status, 'Decision context needed')
  assert.equal(viewFor({ status: 'waiting_for_input' }).status, 'Waiting for input')
})

test('a completed run is not automatically a completed mission or published application', () => {
  const run = viewFor({ status: 'completed' })
  assert.equal(run.heading, 'This run is complete')
  assert.match(run.summary, /does not mean publication, merge or deployment/)
  assert.match(fact(run, 'Provider execution').value, /termination receipt not in this snapshot/)
  assert.equal(viewFor({ status: 'completed' }, { mission: { ...fixture().mission, status: 'completed' } }).heading, 'The mission is complete')
})

for (const change of [{ connection: 'offline' }, { connection: 'connecting' }, { snapshotFailed: true }, { snapshotReceivedAt: null }]) {
  test(`retained data cannot claim current execution: ${JSON.stringify(change)}`, () => {
    const view = activity.presentRunActivity(fixture(change))
    assert.equal(view.status, 'Updates unavailable')
    assert.match(fact(view, 'Provider execution').value, /current execution unconfirmed/)
    assert.ok(view.notices.length)
    assert.doesNotMatch(fact(view, 'Assigned agent').detail, /Control at snapshot: Alice/)
  })
}

test('grace, offline and wrong-Corp runner records cannot establish provider liveness', () => {
  for (const runner of [{ ...fixture().runners[0], connected: false, status: 'grace' },
    { ...fixture().runners[0], connected: false, status: 'offline' },
    { ...fixture().runners[0], corp_id: 'foreign' }]) {
    const view = activity.presentRunActivity(fixture({ runners: [runner] }))
    assert.equal(view.status, 'State unconfirmed')
    assert.match(fact(view, 'Provider execution').value, /current execution unconfirmed/)
  }
})

test('runner loss and uncertain teardown remain unknown until a positive termination receipt', () => {
  assert.match(fact(viewFor({ status: 'lost' }), 'Provider execution').value, /termination unconfirmed/)
  const events = [event(1, 'run.started'), event(10, 'run.session_terminated', { provider_process_alive: false }), event(11, 'run.teardown_uncertain')]
  assert.match(fact(viewFor({}, { events }), 'Provider execution').value, /termination unconfirmed/)
  events.push(event(12, 'run.session_terminated', { provider_process_alive: false }))
  assert.equal(fact(viewFor({}, { events }), 'Provider execution').value, 'Provider termination confirmed')
})

test('verifier-only runs never appear as a running model', () => {
  const view = viewFor({ execution_mode: 'verification_only' })
  assert.equal(view.status, 'Verifying')
  assert.equal(fact(view, 'Provider execution').value, 'Verifier-only run; no provider')
})

test('quarantine and protected stops stay prominent even with stale transport', () => {
  assert.equal(viewFor({ workspace_disposition: 'quarantined' }).status, 'Quarantined')
  assert.equal(viewFor({ breaker_stage: 'stop' }).status, 'Stopped')
  const view = viewFor({ workspace_disposition: 'quarantined', breaker_stage: 'stop' }, { connection: 'offline' })
  assert.ok(view.notices.some((text) => /quarantine/.test(text)))
  assert.ok(view.notices.some((text) => /stop-stage/.test(text)))
})

test('failed verification, cancelled work and unknown execution modes remain explicit', () => {
  assert.equal(viewFor({ status: 'failed', verification_status: 'failed' }).status, 'Checks failed')
  assert.equal(viewFor({ status: 'cancelled' }).status, 'Cancelled')
  const unknown = viewFor({ execution_mode: 'unknown' })
  assert.equal(unknown.status, 'State unconfirmed')
  assert.ok(unknown.notices.some((text) => /unsupported execution mode/.test(text)))
})

test('missing, duplicate or foreign task context cannot fall back to another run', () => {
  for (const tasks of [[], [{ ...fixture().tasks[0], mission_id: 'foreign' }], [fixture().tasks[0], fixture().tasks[0]]]) {
    const view = activity.presentRunActivity(fixture({ tasks }))
    assert.equal(view.runId, null)
    assert.equal(view.status, 'Context unconfirmed')
    assert.equal(view.latest, null)
    assert.deepEqual(view.timeline, [])
    assert.equal(fact(view, 'Assigned agent'), undefined)
  }
  assert.equal(activity.presentRunActivity(fixture({ run: undefined })).status, 'No run in view')
})

test('activity is scoped, deduplicated, ordered, bounded and never reveals raw payloads', () => {
  const sentinel = 'NEVER_RENDER_SECRET_OR_PROVIDER_CONTENT'
  const events = Array.from({ length: 9 }, (_, n) => event(n, 'run.output', { message: sentinel, summary: sentinel }))
  events.push(events[0], event(50, 'run.output', { message: sentinel }, { aggregate_id: 'foreign' }),
    event(51, 'run.output', {}, { corp_id: 'foreign' }), event(52, 'run.output', {}, { room_id: 'foreign' }),
    event(53, 'run.output', {}, { seq: NaN }), event(54, 'run.output', {}, { created_at: 'invalid' }),
    event(55, 'run.tool_activity', { signature: sentinel, progressed: false }))
  const view = activity.presentRunActivity(fixture({ events: events.reverse() }))
  assert.equal(view.timeline.length, 5)
  assert.equal(view.latest.at, at(55))
  assert.equal(view.latest.label, 'Tool activity recorded')
  assert.equal(new Set(view.timeline.map((item) => item.id)).size, 5)
  assert.doesNotMatch(JSON.stringify(view), new RegExp(sentinel))
  for (const type of ['__proto__', 'constructor', 'run.unknown']) {
    const unknown = activity.presentRunActivity(fixture({ events: [event(1, type)] }))
    assert.equal(unknown.latest.label, 'Run event recorded')
    assert.deepEqual(unknown.timeline, [])
  }
})

test('missing start, invalid clocks and backwards timestamps do not invent a duration', () => {
  for (const events of [[], [event(2, 'run.output')], [event(1, 'run.started', {}, { created_at: at(20) }), event(2, 'run.output')]]) {
    const view = activity.presentRunActivity(fixture({ events }))
    assert.match(view.context.find((item) => item.label === 'Recorded run interval').value, /not available/)
  }
  assert.equal(activity.activityTime('invalid'), 'Time unavailable')
})

test('expired leases and foreign attribution do not display an active controller', () => {
  for (const leases of [[{ ...fixture().leases[0], expires_at: at(10) }], [{ ...fixture().leases[0], agent_id: 'other' }]]) {
    const view = activity.presentRunActivity(fixture({ leases }))
    assert.doesNotMatch(fact(view, 'Assigned agent').detail, /Alice/)
  }
})

test('provider control requires fresh exact ownership and no recorded execution boundary', () => {
  assert.equal(activity.presentRunActivity(fixture()).providerCurrent, true)
  for (const changes of [
    { agents: [{ ...fixture().agents[0], current_run_id: 'newer-run' }] },
    { agents: [] },
    { tasks: [{ ...fixture().tasks[0], assigned_agent_id: 'other-agent' }] },
    { mission: { ...fixture().mission, status: 'cancelled' } },
    { connection: 'offline' }, { snapshotFailed: true },
    { run: { ...fixture().run, breaker_stage: 'suspend' } },
    { run: { ...fixture().run, breaker_stage: 'stop' } },
    { run: { ...fixture().run, workspace_disposition: 'quarantined' } },
    { events: [event(1, 'run.started'), event(2, 'run.teardown_uncertain')] },
    { events: [event(1, 'run.started'), event(2, 'run.session_terminated', { provider_process_alive: false })] },
  ]) {
    const view = activity.presentRunActivity(fixture(changes))
    assert.equal(view.providerCurrent, false, JSON.stringify(changes))
    assert.doesNotMatch(fact(view, 'Assigned agent').detail, /Control at snapshot: Alice/)
    assert.doesNotMatch(fact(view, 'Provider execution').value, /reported active$/)
  }
})

test('activity supports non-Factory work and an unavailable exact selection without inventing intake or a mission', () => {
  const direct = activity.presentRunActivity(fixture({ factoryState: undefined }))
  assert.equal(direct.context.some((entry) => entry.label === 'Intake record'), false)
  const absent = activity.presentRunActivity(fixture({ mission: undefined, run: undefined, selectionUnavailable: true }))
  assert.equal(absent.runId, null)
  assert.equal(absent.providerCurrent, false)
  assert.equal(absent.status, 'Context unconfirmed')
  assert.match(absent.summary, /No alternative run/)
  assert.equal(absent.context.some((entry) => entry.label === 'Mission record'), false)
})

test('agent activity honors the exact pointer and does not substitute a recorded run after context loss', () => {
  assert.equal(typeof activity.selectAgentActivity, 'function')
  const f = fixture()
  const input = { agent: f.agents[0], tasks: f.tasks, missions: [f.mission], runs: [f.run], reviews: [], approvals: [] }
  assert.equal(activity.selectAgentActivity(input).run, f.run)
  for (const changes of [
    { runs: [{ ...f.run, id: 'other-run' }] },
    { runs: [{ ...f.run, agent_id: 'other-agent' }] },
    { tasks: [{ ...f.tasks[0], assigned_agent_id: 'other-agent' }] },
    { tasks: [] }, { missions: [] },
    { agent: { ...f.agents[0], mission_id: 'other-mission' } },
  ]) {
    const selected = activity.selectAgentActivity({ ...input, ...changes })
    assert.equal(selected.run, undefined, JSON.stringify(changes))
    assert.equal(selected.selectionUnavailable, true)
  }
})

test('an agent without a current pointer may show exact recorded review but cannot claim current execution', () => {
  assert.equal(typeof activity.selectAgentActivity, 'function')
  const f = fixture(), agent = { ...f.agents[0], current_run_id: null }
  const review = { ...f.run, id: 'old-review', status: 'waiting_for_approval' }
  const reviews = [{ run_id: review.id, task_id: review.task_id, status: 'pending' }]
  const selected = activity.selectAgentActivity({ agent, tasks: f.tasks, missions: [f.mission],
    runs: [f.run, review], reviews, approvals: [] })
  assert.equal(selected.run, review)
  const view = activity.presentRunActivity({ ...f, ...selected, agents: [agent], reviews })
  assert.equal(view.status, 'Awaiting review')
  assert.equal(view.providerCurrent, false)
  assert.ok(view.notices.some((notice) => /recorded run|historical/i.test(notice)))
  const recordedActive = activity.presentRunActivity({ ...f, agents: [agent] })
  assert.equal(recordedActive.providerCurrent, false)
  assert.doesNotMatch(fact(recordedActive, 'Provider execution').value, /reported active$/)
})

test('a concrete breaker reason uses only a matching native stage and allowlisted metric', () => {
  const sentinel = 'NEVER_RENDER_RAW_BREAKER_REASON'
  for (const [metric, expected] of [
    ['run_tokens', /Run token budget/], ['mission_cost', /Mission cost budget/],
    ['actor_tokens_24h', /Actor daily token budget/], ['corp_cost_24h', /Corp daily cost budget/],
    ['no_progress', /No-progress limit/], ['repeated_tool', /Repeated-tool limit/],
  ]) {
    const view = viewFor({ breaker_stage: 'suspend' }, { events: [event(1, 'run.breaker_transition', {
      stage: 'suspend', reason: sentinel, input: { metric, used: sentinel, limit: sentinel },
    })] })
    assert.match(fact(view, 'Execution blocker').value, expected)
    assert.doesNotMatch(JSON.stringify(view), new RegExp(sentinel))
  }
  for (const payload of [
    { stage: 'suspend', input: { metric: sentinel }, reason: sentinel },
    { stage: 'stop', input: { metric: 'run_tokens' } },
    { stage: 'suspend', input: { metric: '__proto__' } },
  ]) {
    const view = viewFor({ breaker_stage: 'suspend' }, { events: [event(1, 'run.breaker_transition', payload)] })
    assert.match(fact(view, 'Execution blocker').value, /reason unavailable/)
    assert.doesNotMatch(JSON.stringify(view), new RegExp(sentinel))
  }
})

test('a recorded constrain stage cannot mask a current decision, verification or terminal outcome', () => {
  const constrained = { breaker_stage: 'constrain' }
  for (const [run, extra, expected] of [
    [{ status: 'waiting_for_approval' }, { reviews: [{ run_id: 'run-a', task_id: 'task-a', status: 'pending' }] }, 'Human outcome review pending'],
    [{ status: 'waiting_for_approval' }, { approvals: [{ run_id: 'run-a', status: 'pending' }] }, 'Requested action approval pending'],
    [{ status: 'verifying' }, {}, 'Verification in progress'],
    [{ status: 'failed', verification_status: 'failed' }, {}, 'Recorded verification failed'],
    [{ status: 'completed' }, {}, 'Completed run; inspect recorded evidence'],
    [{ status: 'cancelled' }, {}, 'Cancelled run; inspect recorded evidence'],
  ]) {
    const view = viewFor({ ...constrained, ...run }, extra)
    assert.equal(fact(view, 'Execution blocker').value, expected)
  }
  assert.match(fact(viewFor(constrained), 'Execution blocker').value, /Constrain/)
  for (const breaker_stage of ['suspend', 'stop']) {
    assert.match(fact(viewFor({ status: 'completed', breaker_stage }), 'Execution blocker').value, /Suspend|Stop/)
  }
})

const source = await readFile(new URL('./RunActivityDetails.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { fileName: 'RunActivityDetails.tsx', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
assert.deepEqual(compiled.diagnostics, [])
const exports = {}
new Function('require', 'exports', compiled.outputText)((name) => {
  if (name === 'react/jsx-runtime') return jsxRuntime
  if (name === './runActivity') return activity
  throw new Error(`Unexpected dependency ${name}`)
}, exports)

test('actual React detail component reuses current classes, native disclosure and escaped text', () => {
  for (const title of ['<script>not executable</script>', '<SCRIPT>not executable</SCRIPT>', '<ScRiPt src="untrusted">not executable</ScRiPt>']) {
    const view = activity.presentRunActivity(fixture({ tasks: [{ ...fixture().tasks[0], title }] }))
    const html = renderToStaticMarkup(jsxRuntime.jsx(exports.RunActivityDetails, { view }))
    assert.match(html, /work-result-facts/)
    assert.match(html, /class="work-result-details"/)
    assert.doesNotMatch(html, /<details[^>]*\bopen/)
    assert.match(html, /&lt;script\b/i)
    assert.doesNotMatch(html, /<script\b/i)
    assert.match(html, /not its complete history/)
    assert.match(html, /data-run-id="run-a"/)
  }
  assert.doesNotMatch(source, /\b(fetch|setInterval|WebSocket)\s*\(/)
})

test('the shared panel keeps current state prominent and recorded details collapsed', () => {
  assert.equal(typeof exports.RunActivityPanel, 'function')
  const view = viewFor({ status: 'waiting_for_approval' }, {
    reviews: [{ run_id: 'run-a', task_id: 'task-a', status: 'pending' }],
  })
  const html = renderToStaticMarkup(jsxRuntime.jsx(exports.RunActivityPanel, { view }))
  assert.match(html, /aria-label="Selected run activity"/)
  assert.match(html, /Awaiting review/)
  assert.match(html, /This outcome needs review/)
  assert.match(html, /Task in focus/)
  assert.doesNotMatch(html, /<details[^>]*\bopen/)
})

// Compile the actual inspector and its control/idempotency helpers. Only hook
// scheduling, storage, unrelated portraits and command callbacks are controlled.
const appSource = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const appFile = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
assert.deepEqual(appFile.parseDiagnostics, [])
const selectedAgentDeclarations = [], viewAgentCallbacks = []
const inspectAppSelection = (node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'selectedAgent') selectedAgentDeclarations.push(node)
  if (ts.isJsxAttribute(node) && node.name.getText(appFile) === 'onViewAgent' &&
    node.initializer && ts.isJsxExpression(node.initializer) && ts.isArrowFunction(node.initializer.expression)) {
    viewAgentCallbacks.push(node.initializer.expression)
  }
  ts.forEachChild(node, inspectAppSelection)
}
inspectAppSelection(appFile)
assert.equal(selectedAgentDeclarations.length, 1)
assert.equal(viewAgentCallbacks.length, 1)
const selectionCode = ts.transpileModule(`
  exports.select = (data, floorAgents, selectedAgentId, selectOfficeAgent) => {
    const selectedFloorAgent = selectOfficeAgent(floorAgents, selectedAgentId);
    return (${selectedAgentDeclarations[0].initializer.getText(appFile)});
  };
  exports.open = (data, currentAgents, setSelectedAgentId, setFloorInspectorOpen, activateWorkspaceView) =>
    (${viewAgentCallbacks[0].getText(appFile)});
`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText
const appSelection = {}
new Function('exports', selectionCode)(appSelection)

test('actual App inspector resolves exact hidden and retired identities without replacing a missing selection', () => {
  const visible = { id: 'visible', retired_at: null }
  const hidden = { id: 'hidden-test-agent', retired_at: null }
  const retired = { id: 'historical-agent', retired_at: at(20) }
  const data = { snapshot: { agents: [visible, hidden, retired] } }
  for (const agent of [visible, hidden, retired]) {
    assert.equal(appSelection.select(data, [visible], agent.id, selectOfficeAgent), agent)
  }
  assert.equal(appSelection.select(data, [visible], 'revoked-or-missing', selectOfficeAgent), undefined)
  assert.equal(appSelection.select(data, [visible], null, selectOfficeAgent), visible)
})

test('actual Mission agent callback opens authorized historical identities without changing the workspace', () => {
  const current = { id: 'current', retired_at: null }, retired = { id: 'retired', retired_at: at(20) }
  const data = { snapshot: { agents: [current, retired] } }, calls = []
  const open = appSelection.open(data, [current], (id) => calls.push(['select', id]),
    (open) => calls.push(['open', open]), (view) => calls.push(['navigate', view]))
  open(retired.id)
  assert.deepEqual(calls, [['select', retired.id], ['open', true]])
  open('not-authorized')
  assert.equal(calls.length, 2, 'absent identities cannot be opened')
})
const deskNames = new Set(['AgentDesk', 'agentStatusLabel', 'adapterLabel', 'capabilitySupports',
  'detailValue', 'canOperate', 'shortId', 'time', 'StatusMark', 'browserOperationKey', 'clearBrowserOperation'])
const deskNodes = appFile.statements.filter((node) => ts.isFunctionDeclaration(node) && deskNames.has(node.name?.text))
assert.equal(deskNodes.length, deskNames.size)
const deskCompiled = ts.transpileModule(deskNodes.map((node) => node.getText(appFile)).join('\n') + '\nexports.AgentDesk = AgentDesk;', {
  fileName: 'AgentDesk.tsx', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
assert.deepEqual(deskCompiled.diagnostics, [])

function deskHosts(node) {
  if (Array.isArray(node)) return node.flatMap(deskHosts)
  if (!isValidElement(node)) return []
  if (typeof node.type === 'function') return deskHosts(node.type(node.props))
  return [...(typeof node.type === 'string' ? [node] : []), ...deskHosts(node.props.children)]
}
function deskText(node) {
  if (Array.isArray(node)) return node.map(deskText).join(' ')
  if (!isValidElement(node)) return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
  return deskText(typeof node.type === 'function' ? node.type(node.props) : node.props.children)
}
function deskFixture(overrides = {}) {
  let cursor = 0, tree
  const slots = [], storage = new Map(), calls = []
  const useState = (initial) => {
    const index = cursor++
    if (!slots[index]) slots[index] = { value: initial }
    return [slots[index].value, (value) => { slots[index].value = value }]
  }
  const compiledExports = {}
  new Function('require', 'exports', 'useState', 'presentRunActivity', 'RunActivityPanel', 'AgentAvatar', 'AgentPinControl', 'window', deskCompiled.outputText)(
    (name) => { assert.equal(name, 'react/jsx-runtime'); return jsxRuntime }, compiledExports, useState,
    activity.presentRunActivity, exports.RunActivityPanel, () => null, () => null,
    { sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) } },
  )
  const input = fixture()
  let props = {
    agent: { ...input.agents[0], status: 'working', role: 'Engineer' }, activityInput: input,
    actor: { id: 'alice', name: 'Alice', role: 'owner', kind: 'human' },
    humans: [{ id: 'alice', name: 'Alice', role: 'owner' }, { id: 'bob', name: 'Bob', role: 'member' }],
    capability: { detail: 'steer=yes;interrupt=yes;stop=yes' }, lease: input.leases[0], leaseToken: 'synthetic-test-token', queuedCount: 0,
    onClaim: (...args) => calls.push(['claim', ...args]), onRelease: (...args) => calls.push(['release', ...args]),
    onTransfer: (...args) => calls.push(['transfer', ...args]), onInterrupt: (...args) => calls.push(['interrupt', ...args]),
    onEmergencyStop: (...args) => calls.push(['stop', ...args]), onPin: (...args) => calls.push(['pin', ...args]),
    onInspectRun: (...args) => calls.push(['inspect', ...args]),
    onMessage: async (...args) => { calls.push(['message', ...args]); return true }, ...overrides,
  }
  const render = (next = props) => { props = next; cursor = 0; tree = compiledExports.AgentDesk(props); renderToStaticMarkup(tree) }
  render()
  return {
    calls, render, get props() { return props }, get tree() { return tree },
    nodes: (type) => deskHosts(tree).filter((node) => node.type === type),
    buttons: () => deskHosts(tree).filter((node) => node.type === 'button').map(deskText),
  }
}

test('actual AgentDesk navigates to its exact run and passes a live lease only through the existing message action', async () => {
  const desk = deskFixture()
  assert.deepEqual(desk.calls, [])
  assert.ok(desk.buttons().includes('Renew control'))
  assert.ok(desk.buttons().includes('Interrupt turn'))
  desk.nodes('button').find((node) => /Inspect this run/.test(deskText(node))).props.onClick()
  assert.deepEqual(desk.calls, [['inspect', 'run-a']])
  desk.nodes('input')[0].props.onChange({ target: { value: 'Continue the selected task' } })
  desk.render()
  await desk.nodes('form')[0].props.onSubmit({ preventDefault() {} })
  const message = desk.calls[1]
  assert.equal(message[0], 'message')
  assert.equal(message[1].id, 'agent-a')
  assert.equal(message[3], 'synthetic-test-token')
  assert.match(message[4], /^[0-9a-f-]{36}$/, 'actual existing browser operation helper supplies the retry key')
})

test('actual AgentDesk hides live commands for review, historical, stale, terminated or mismatched run context', () => {
  for (const changes of [
    { run: { ...fixture().run, status: 'waiting_for_approval' }, reviews: [{ run_id: 'run-a', task_id: 'task-a', status: 'pending' }] },
    { agents: [{ ...fixture().agents[0], current_run_id: null }] },
    { connection: 'offline' }, { snapshotFailed: true }, { snapshotReceivedAt: null },
    { tasks: [{ ...fixture().tasks[0], assigned_agent_id: 'other' }] },
    { mission: { ...fixture().mission, status: 'cancelled' } },
    { events: [event(2, 'run.session_terminated', { provider_process_alive: false })] },
    { selectionUnavailable: true, run: undefined, mission: undefined },
  ]) {
    const desk = deskFixture({ activityInput: fixture(changes) })
    assert.doesNotMatch(desk.buttons().join('|'), /Renew control|Claim live control|Release|Transfer|Interrupt turn|Emergency stop|Steer/, JSON.stringify(changes))
    assert.match(deskText(desk.tree), /Live control unavailable/)
    assert.deepEqual(desk.calls, [])
  }
})

test('retired agent inspection is read-only even with an inconsistent current-run pointer', () => {
  const retired = { ...fixture().agents[0], retired_at: at(20), status: 'working', role: 'Engineer' }
  const input = fixture({ agents: [retired] })
  assert.equal(activity.presentRunActivity(input).providerCurrent, false)
  const desk = deskFixture({ agent: retired, activityInput: input })
  assert.doesNotMatch(desk.buttons().join('|'), /Renew control|Claim live control|Release|Transfer|Interrupt turn|Emergency stop|Steer|Queue note/)
  assert.equal(desk.nodes('form').length, 0)
  assert.match(deskText(desk.tree), /retired|read-only/i)
  assert.deepEqual(desk.calls, [])
})

test('actual AgentDesk does not use expired, foreign or role-ineligible leases for steering', async () => {
  for (const changes of [
    { lease: { ...fixture().leases[0], expires_at: at(10) } },
    { lease: { ...fixture().leases[0], agent_id: 'other-agent' } },
    { actor: { id: 'alice', name: 'Alice', role: 'viewer', kind: 'human' } },
  ]) {
    const desk = deskFixture(changes)
    assert.doesNotMatch(desk.buttons().join('|'), /Renew control|Release|Transfer|Interrupt turn|Steer/)
    desk.nodes('input')[0].props.onChange({ target: { value: 'A queued note' } })
    desk.render()
    await desk.nodes('form')[0].props.onSubmit({ preventDefault() {} })
    assert.equal(desk.calls[0][3], undefined, 'queued notes cannot carry live steering authority')
  }
})

test('the Factory integration uses the existing exact-run selector, scoped snapshot and old callbacks', async () => {
  const app = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
  assert.match(app, /const activityRun = selectActivityRun\(selectedRuns, verificationRequests, actionApprovals\)/)
  assert.match(app, /run: activityRun, tasks: selectedTasks/)
  assert.match(app, /events=\{data\.snapshot\.events\}/)
  assert.match(app, /snapshotReceivedAt=\{snapshotLoad\?\.receivedAt/)
  assert.match(app, /Intake · \{statusLabel\(selected.state\)\}/)
  assert.match(app, /onClick=\{\(\) => onOpenMission\(selectedMission\)\}/)
  assert.match(app, /onOpenMission\(selectedMission, runActivity\?\.runId \?\? undefined\)/)
  assert.match(app, /navigateToWorkspaceEntity\(runId \? 'run' : 'mission', runId \?\? mission.id\)/)
  assert.match(app, /previous\?\.corpId === corpId && previous.actorId === actorId/)
})
