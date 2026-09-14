import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'
import * as activity from './runActivity.ts'

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
    tasks: [{ id: 'task-a', mission_id: 'mission-a', title: 'Implement accessible search' }],
    agents: [{ id: 'agent-a', name: 'Delivery engineer', adapter: 'github-copilot' }],
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
  const view = activity.presentRunActivity(fixture({ tasks: [{ ...fixture().tasks[0], title: '<script>not executable</script>' }] }))
  const html = renderToStaticMarkup(jsxRuntime.jsx(exports.RunActivityDetails, { view }))
  assert.match(html, /work-result-facts/)
  assert.match(html, /class="work-result-details"/)
  assert.doesNotMatch(html, /<details[^>]*\bopen/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /not its complete history/)
  assert.match(html, /data-run-id="run-a"/)
  assert.doesNotMatch(source, /\b(fetch|setInterval|WebSocket)\s*\(/)
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
