import assert from 'node:assert/strict'
import test from 'node:test'
import { buildExecutiveOverview, executiveDestinationAvailable } from './executiveOverview.ts'
import { executiveFixture } from './testSupport/executiveFixture.mjs'

const overview = (f) => buildExecutiveOverview(f.snapshot, f.viewer, f.stamp, f.runners, f.now)
const alerts = (f) => overview(f).missions.flatMap((row) => row.alerts)

test('Executive summary is a read-only projection of returned tasks and responsible agents', () => {
  const f = executiveFixture(), before = structuredClone(f)
  const row = overview(f).missions[0]
  assert.equal(row.mission.title, 'Deliver the scoped search')
  assert.deepEqual(row.taskCounts, [{ status: 'running', count: 1 }])
  assert.deepEqual(row.team, ['Delivery engineer'])
  assert.equal(row.teamIncomplete, false)
  assert.equal(row.activity.status, 'Executing')
  assert.deepEqual(row.alerts, [])
  assert.equal(row.item, null)
  assert.deepEqual(f, before)
})

for (const [name, change] of [
  ['failed check', (f) => { f.snapshot.runs[0].verification_status = 'failed' }],
  ['verification evidence failure', (f) => { f.snapshot.verification_evidence.push({ id: 'check', run_id: 'run-a', task_id: 'task-a', status: 'failed' }) }],
  ['review rejection', (f) => { f.snapshot.verification_requests.push({ run_id: 'run-a', task_id: 'task-a', status: 'rejected' }) }],
  ['action rejection', (f) => { f.snapshot.action_approvals.push({ run_id: 'run-a', status: 'rejected' }) }],
  ['pending review', (f) => { f.snapshot.runs[0].status = 'waiting_for_approval'; f.snapshot.verification_requests.push({ run_id: 'run-a', task_id: 'task-a', status: 'pending' }) }],
  ['pending action', (f) => { f.snapshot.runs[0].status = 'waiting_for_approval'; f.snapshot.action_approvals.push({ run_id: 'run-a', status: 'pending' }) }],
  ['missing decision record', (f) => { f.snapshot.runs[0].status = 'waiting_for_approval' }],
  ['quarantine', (f) => { f.snapshot.runs[0].workspace_disposition = 'quarantined' }],
  ['suspension', (f) => { f.snapshot.runs[0].breaker_stage = 'suspend' }],
  ['stop', (f) => { f.snapshot.runs[0].breaker_stage = 'stop' }],
  ['runner loss', (f) => { f.snapshot.runs[0].status = 'lost' }],
  ['disconnected runner', (f) => { f.runners[0].connected = false }],
  ['input wait', (f) => { f.snapshot.runs[0].status = 'waiting_for_input' }],
  ['unknown execution', (f) => { f.snapshot.runs[0].execution_mode = 'unrecognized' }],
  ['unknown state', (f) => { f.snapshot.runs[0].status = 'unrecognized' }],
]) test(`${name} on older work remains visible beside a newer successful run`, () => {
  const f = executiveFixture()
  change(f)
  f.snapshot.runs.unshift({ ...executiveFixture().snapshot.runs[0], id: 'run-newer', status: 'completed', verification_status: 'passed' })
  f.snapshot.tasks[0].attempt_count = 2
  f.snapshot.agents[0].current_run_id = 'run-newer'
  const result = alerts(f).filter((alert) => alert.target.id === 'run-a')
  assert.ok(result.length > 0, 'The earlier critical record must have its own exact drilldown')
  assert.ok(result.every((alert) => alert.target.kind === 'run' && alert.target.missionId === 'mission-a'))
})

for (const status of ['failed', 'blocked', 'awaiting_approval', 'verification_failed', 'review', 'cancelled', 'unknown', 'future_task_state']) test(`task ${status} does not require a returned run to remain visible`, () => {
  const f = executiveFixture()
  f.snapshot.tasks[0].status = status
  f.snapshot.runs = []
  const taskAlert = alerts(f).find((alert) => alert.target.kind === 'task' && alert.target.id === 'task-a')
  assert.ok(taskAlert, `Task state ${status} must retain an exact inspection path without run data`)
  assert.equal(taskAlert.target.missionId, 'mission-a')
})

test('failed task verification stays visible independently of the recorded task state', () => {
  const f = executiveFixture()
  f.snapshot.tasks[0].status = 'completed'
  f.snapshot.tasks[0].verification_status = 'failed'
  f.snapshot.runs = []
  const taskAlert = alerts(f).find((alert) => alert.target.kind === 'task' && alert.target.id === 'task-a')
  assert.ok(taskAlert)
  assert.match(taskAlert.detail, /Task verification: Failed/)
})

for (const status of ['pending', 'ready', 'claimed', 'running', 'completed']) test(`ordinary task ${status} does not invent a task decision or failure`, () => {
  const f = executiveFixture()
  f.snapshot.tasks[0].status = status
  f.snapshot.runs = []
  assert.equal(alerts(f).some((alert) => alert.target.kind === 'task'), false)
  assert.deepEqual(overview(f).missions[0].taskCounts, [{ status, count: 1 }])
})

for (const status of ['failed', 'cancelled', 'unknown', 'future_mission_state']) test(`mission ${status} retains an explicit attention path`, () => {
  const f = executiveFixture()
  f.snapshot.missions[0].status = status
  const alert = alerts(f).find((entry) => entry.key === 'mission')
  assert.ok(alert, 'A failed or unconfirmed mission must not disappear from needs attention')
  assert.deepEqual(alert.target, { kind: 'mission', id: 'mission-a', missionId: 'mission-a' })
  if (['unknown', 'future_mission_state'].includes(status)) assert.match(alert.title, /unconfirmed/)
})

for (const [name, change, expected] of [
  ['exhausted authority', (f) => { f.snapshot.runs[0].input_tokens = 1000 }, /ceiling is exhausted/],
  ['unpriced usage', (f) => { f.snapshot.runs[0].cost_microusd = 0 }, /Cost assurance is incomplete/],
  ['unreported usage', (f) => { Object.assign(f.snapshot.runs[0], { input_tokens: 0, output_tokens: 0, cost_microusd: 0 }) }, /Cost assurance is incomplete/],
  ['missing attempts', (f) => { f.snapshot.tasks[0].attempt_count = 2 }, /history or usage is incomplete/],
  ['invalid usage', (f) => { f.snapshot.runs[0].input_tokens = -1 }, /Remaining authority is unavailable/],
  ['missing tasks', (f) => { f.snapshot.tasks = []; f.snapshot.runs = [] }, /Task progress unavailable/],
  ['missing approval receipt', (f) => { f.snapshot.missions[0].budget_tokens = 2000 }, /Budget approval evidence is unavailable/],
  ['pending budget request', (f) => { f.snapshot.mission_budget_revisions.push({ id: 'revision-a', corp_id: 'corp-a', mission_id: 'mission-a', status: 'pending', version: 1, proposed_budget_tokens: 2000, proposed_budget_cost_microusd: 2000000 }) }, /budget requests need a decision/],
]) test(`${name} has an explicit limitation or decision without inventing authority`, () => {
  const f = executiveFixture(); change(f)
  assert.ok(alerts(f).some((alert) => expected.test(alert.title)))
})

for (const [name, change] of [
  ['expired receipt', (f) => { f.now += 60_000 }],
  ['future receipt', (f) => { f.now-- }],
  ['offline', (f) => { f.stamp.connection = 'offline' }],
  ['connecting', (f) => { f.stamp.connection = 'connecting' }],
  ['failed authorized refresh', (f) => { f.stamp.refreshFailed = true }],
  ['another actor', (f) => { f.viewer.actorId = 'bob' }],
  ['another Corp', (f) => { f.viewer.corpId = 'corp-b' }],
  ['conflicting task', (f) => { f.snapshot.tasks.push({ ...f.snapshot.tasks[0], title: 'Conflicting task' }) }],
  ['conflicting run', (f) => { f.snapshot.runs.push({ ...f.snapshot.runs[0], status: 'completed' }) }],
]) test(`${name} withholds prior mission data and exact navigation`, () => {
  const f = executiveFixture(); change(f)
  const result = overview(f)
  assert.notEqual(result.state, 'current')
  assert.deepEqual(result.missions, [])
  assert.equal(executiveDestinationAvailable(result, { kind: 'run', id: 'run-a', missionId: 'mission-a' }), false)
})

test('foreign scope and missing room ancestry cannot supply missions, teams, decisions or links', () => {
  const f = executiveFixture()
  f.snapshot.rooms = []
  assert.deepEqual(overview(f).missions, [])
  f.snapshot.rooms = [{ id: 'room-a', corp_id: 'corp-b' }]
  assert.deepEqual(overview(f).missions, [])
})

test('unrelated failed evidence and rejected reviews never contaminate a mission', () => {
  const f = executiveFixture()
  f.snapshot.verification_evidence = [{ id: 'foreign', run_id: 'run-a', task_id: 'foreign-task', status: 'failed' }]
  f.snapshot.verification_requests = [{ run_id: 'foreign-run', task_id: 'task-a', status: 'rejected' },
    { run_id: 'run-a', task_id: 'foreign-task', status: 'rejected' }]
  f.snapshot.action_approvals = [{ run_id: 'foreign-run', status: 'pending' }]
  f.snapshot.agents.push({ ...f.snapshot.agents[0], id: 'unrelated', name: 'Private unrelated team' })
  assert.deepEqual(alerts(f), [])
  assert.deepEqual(overview(f).missions[0].team, ['Delivery engineer'])
})

test('missing or ambiguous team attribution remains explicitly incomplete', () => {
  const f = executiveFixture()
  f.snapshot.agents.push({ ...f.snapshot.agents[0], name: 'Conflicting agent' })
  assert.deepEqual(overview(f).missions[0].team, [])
  assert.equal(overview(f).missions[0].teamIncomplete, true)
})

test('intake without a unique authorized mission yields no inferred publication link', () => {
  const f = executiveFixture()
  const item = { id: 'item-a', corp_id: 'corp-a', mission_id: 'mission-a', state: 'blocked', version: 1,
    source_repository_owner: 'owner', source_repository_name: 'repo' }
  f.snapshot.factory_work_items = [item]
  assert.equal(overview(f).missions[0].item.id, item.id)
  assert.ok(alerts(f).some((alert) => /Intake recorded as/.test(alert.title)))
  f.snapshot.factory_work_items.push({ ...item, id: 'another-item' })
  assert.equal(overview(f).missions[0].item, null)
  assert.ok(alerts(f).some((alert) => /Result attribution/.test(alert.title)))
  f.snapshot.factory_work_items = [{ ...item, mission_id: null }]
  assert.match(overview(f).notices.join(' '), /no authorized mission/)
})

test('controller blockers are presented without taking over its existing control plane', () => {
  const f = executiveFixture()
  f.snapshot.factory_controllers = [{ id: 'controller-a', corp_id: 'corp-a', status: 'backing_off', desired_state: 'running' },
    { id: 'controller-b', corp_id: 'corp-b', status: 'blocked', desired_state: 'running' }]
  assert.equal(overview(f).notices.length, 1)
  assert.match(overview(f).notices[0], /Backing off/)
})

test('exact destinations require their own returned ancestry, never a newer substitute', () => {
  const f = executiveFixture()
  for (const [kind, id] of [['mission', 'mission-a'], ['task', 'task-a'], ['run', 'run-a'], ['artifact', 'artifact-a']]) {
    const target = { kind, id, missionId: 'mission-a' }
    assert.equal(executiveDestinationAvailable(overview(f), target), true)
    assert.equal(executiveDestinationAvailable(overview(f), { ...target, id: 'absent' }), false)
    assert.equal(executiveDestinationAvailable(overview(f), { ...target, missionId: 'foreign' }), false)
  }
  f.snapshot.runs.push({ ...f.snapshot.runs[0], id: 'ambiguous-artifact' })
  assert.equal(executiveDestinationAvailable(overview(f), { kind: 'artifact', id: 'artifact-a', missionId: 'mission-a' }), false)
})
