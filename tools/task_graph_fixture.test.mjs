import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { inspect } from 'node:util'
import { completeGraphFixtureLaunch, graphFixtureSource, taskGraphFixtureConfig, waitForGraphFixtureMission } from './task_graph_fixture.mjs'

const corp = '00000000-0000-4000-8000-000000000001'
const env = { CRONY_TASK_GRAPH_TEST: '1', CRONY_SERVER_HTTP: 'http://127.0.0.1:18437' }
const source = { repository: 'all-the-vibes/ecorp', base_ref: 'HEAD', base_commit: 'a'.repeat(40) }
const roots = ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']
const claimed = id => `task ${id} could not create a run: task is not schedulable from status claimed`
const conflict = failure => ({ status: 409, body: { error: `mission dispatch incomplete (1 new runs dispatched): ${failure}` } })
const completed = { mission: { status: 'completed' } }
function snapshot() {
  return { runners: [{ id: 'fixture', connected: true, corp_id: corp, capabilities: [
    { name: 'fake-process', available: true },
    { name: 'workspace-isolation', available: true, source_repository: source.repository,
      source_base_ref: source.base_ref, source_base_commit: source.base_commit },
  ] }] }
}

function missionSnapshot(missionStatus, runs) {
  return { snapshot: {
    missions: [{ id: corp, status: missionStatus }],
    tasks: roots.map(id => ({ id, mission_id: corp })),
    runs: runs.map((run, index) => ({ id: roots[index], task_id: roots[index], ...run })),
  } }
}

test('graph wait retains concurrency and waits beyond one minute for verified workspaces to settle', async () => {
  const stages = [
    [0, missionSnapshot('running', [{ status: 'running' }, { status: 'verifying' }])],
    [60_001, missionSnapshot('running', [{ status: 'verifying' }, { status: 'verifying' }])],
    [177_938, missionSnapshot('completed', roots.map(() => ({ status: 'completed', verification_status: 'passed' })))],
    [230_743, missionSnapshot('completed', roots.map(() => ({
      status: 'completed', verification_status: 'passed', workspace_disposition: 'preserved',
    })))],
  ]
  const before = structuredClone(stages)
  let time = 0, reads = 0
  const result = await waitForGraphFixtureMission(async () => {
    const [observedAt, state] = stages[reads++]
    time = observedAt
    return state
  }, corp, { now: () => time, wait: async () => {} })
  assert.equal(reads, 4)
  assert.equal(result.state, stages[3][1])
  assert.equal(result.maxActiveRuns, 2)
  assert.equal(result.elapsedMs, 230_743)
  assert.equal(result.timeoutMs, 300_000)
  assert.deepEqual(stages, before)
})

test('graph wait requires persisted terminal runs and workspace settlement for every mission outcome', async () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    let time = 0, reads = 0
    const result = await waitForGraphFixtureMission(async () => {
      reads++
      return missionSnapshot(status, reads === 1 ? [] : roots.map((_, index) => ({
        status: reads === 2 ? 'verifying' : status,
        workspace_disposition: reads < 4 ? null : index ? 'removed' : 'preserved',
      })))
    }, corp, { now: () => time, wait: async ms => { time += ms } })
    assert.equal(reads, 4)
    assert.equal(result.mission.status, status)
    assert.equal(result.runs.length, 2)
  }
})

test('graph wait ignores another mission and its active runs', async () => {
  const state = missionSnapshot('completed', [{ status: 'completed', workspace_disposition: 'preserved' }])
  state.snapshot.missions.push({ id: 'other', status: 'running' })
  state.snapshot.tasks.push({ id: 'other-task', mission_id: 'other' })
  state.snapshot.runs.push({ id: 'other-run', task_id: 'other-task', status: 'running' })
  const result = await waitForGraphFixtureMission(async () => state, corp)
  assert.equal(result.runs.length, 1)
  assert.equal(result.maxActiveRuns, 0)
})

test('graph wait never extends its deadline for progress or an unsettled workspace', async () => {
  for (const unsettled of [false, true]) {
    let time = 0, reads = 0
    await assert.rejects(waitForGraphFixtureMission(async () => {
      reads++
      return missionSnapshot(unsettled ? 'completed' : 'running', roots.map(() => ({
        status: unsettled ? 'completed' : reads % 2 ? 'running' : 'verifying',
        verification_status: unsettled ? 'passed' : 'pending',
      })))
    }, corp, { now: () => time, wait: async () => { time += 60_000 } }), /Timed out waiting for task-graph mission/u)
    assert.equal(time, 300_000)
    assert.equal(reads, 5)
  }
})

test('graph wait refuses a response arriving after the fixed deadline even if it has settled', async () => {
  let time = 0
  await assert.rejects(waitForGraphFixtureMission(async () => {
    time = 300_001
    return missionSnapshot('completed', [{ status: 'completed', workspace_disposition: 'removed' }])
  }, corp, { now: () => time, wait: async () => assert.fail('Expired wait cannot poll again') }),
  /Timed out waiting for task-graph mission/u)
})

test('graph timeout reports only bounded identifiers and lifecycle states from its last snapshot', async () => {
  let time = 0
  const state = missionSnapshot('completed', roots.map(() => ({
    status: 'unknown-state-private-canary', verification_status: 'passed', workspace_disposition: null,
    summary: 'summary-private-canary', artifact_uri: 'artifact-private-canary',
    workspace_path: 'path-private-canary', verification_summary: 'verification-private-canary',
  })))
  state.snapshot.secrets = ['snapshot-private-canary']
  const before = structuredClone(state)
  await assert.rejects(waitForGraphFixtureMission(async () => state, corp,
    { now: () => time, wait: async () => { time += 300_000 } }), error => {
    assert.doesNotMatch(inspect(error), /private-canary/u)
    const details = JSON.parse(error.message.split('Timed out waiting for task-graph mission: ')[1])
    assert.deepEqual(details.mission, { id: corp, status: 'completed' })
    assert.equal(details.run_count, 2)
    assert.deepEqual(details.runs[0], { id: roots[0], task_id: roots[0], status: null,
      verification_status: 'passed', workspace_disposition: null })
    return true
  })
  assert.deepEqual(state, before)
})

test('task graph requires explicit ownership and a single dry-run option', () => {
  assert.equal(taskGraphFixtureConfig([], env).server, env.CRONY_SERVER_HTTP)
  assert.equal(taskGraphFixtureConfig(['--dry-run'], env).dryRun, true)
  for (const args of [['--execute'], ['--skip'], ['--dry-run', '--dry-run']]) {
    assert.throws(() => taskGraphFixtureConfig(args, env), /option/u)
  }
  for (const options of [{}, { CRONY_SERVER_HTTP: env.CRONY_SERVER_HTTP }, { CRONY_TASK_GRAPH_TEST: '1' }]) {
    assert.throws(() => taskGraphFixtureConfig([], options), /explicit/iu)
  }
  const output = path.join(import.meta.dirname, '..', 'output', 'owned-graph.json')
  assert.equal(taskGraphFixtureConfig([], { ...env, CRONY_TASK_GRAPH_OUTPUT: output }).output, output)
})

test('task graph refuses manual ports, credentials, remote origins and malformed endpoints even in CI', () => {
  for (const server of [
    ...['5432', '54329', '8791', '8793', '5187', '5291', '15191', '15193'].map(port => 'http://127.0.0.1:' + port),
    'https://127.0.0.1:18437', 'http://example.com:18437', 'http://user:canary@127.0.0.1:18437',
    'http://127.0.0.1:18437/path', 'http://127.0.0.1:18437/?query', 'http://127.0.0.1:18437/#fragment',
    'http://127.0.0.1', 'not a URL',
  ]) assert.throws(() => taskGraphFixtureConfig([], { ...env, CRONY_SERVER_HTTP: server, GITHUB_ACTIONS: 'true', CI: 'true' }),
    error => !error.message.includes('canary'))
  for (const server of ['http://localhost:18437', 'http://[::1]:18437']) {
    assert.equal(taskGraphFixtureConfig([], { ...env, CRONY_SERVER_HTTP: server }).server, server)
  }
})

test('obsolete roster SQL cannot be silently re-enabled', () => {
  assert.throws(() => taskGraphFixtureConfig([], { ...env, ECORP_CI_UNIX_DEMO_ROSTER: '1' }), /obsolete/u)
  const helper = readFileSync(new URL('./task_graph_fixture.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(helper, /child_process|UPDATE agents|docker.*exec|unixDemoRosterSql/u)
})

test('source-selected staffing reads exact source metadata without mutating the snapshot', () => {
  const state = snapshot(), before = structuredClone(state)
  assert.deepEqual(graphFixtureSource(state, corp).source, source)
  assert.deepEqual(state, before)
  state.runners[0].capabilities[1].source_base_commit = 'b'.repeat(64)
  assert.equal(graphFixtureSource(state, corp).source.base_commit.length, 64)
})

test('source selection rejects wrong Corp, connection, adapter, source, or ambiguous runner', () => {
  for (const change of [
    state => { state.runners = [] },
    state => { state.runners.push(structuredClone(state.runners[0])) },
    state => { state.runners[0].connected = false },
    state => { state.runners[0].corp_id = 'other' },
    state => { state.runners[0].capabilities[0].available = false },
    state => { state.runners[0].capabilities[0].workspace_connection_id = 'other' },
    state => { state.runners[0].capabilities[1].available = false },
    state => { state.runners[0].capabilities[1].workspace_connection_id = 'other' },
    state => { state.runners[0].capabilities[1].source_base_commit = 'HEAD' },
    state => { state.runners[0].capabilities[1].source_base_commit = source.base_commit + '\n' },
    state => { state.runners[0].capabilities[1].source_repository = null },
    state => { state.runners[0].capabilities.push(structuredClone(state.runners[0].capabilities[1])) },
  ]) { const state = snapshot(); change(state); assert.throws(() => graphFixtureSource(state, corp)) }
})

test('normal graph launch keeps its response and never launches a second time', async () => {
  let calls = 0
  const body = { run_ids: ['root-a', 'root-b'], replayed: false }
  const result = await completeGraphFixtureLaunch(async () => {
    assert.equal(++calls, 1)
    return { status: 200, body }
  }, async () => completed, roots)
  assert.deepEqual(result, { launched: body, result: completed, initialStatus: 200 })
})

test('the hosted root-claim conflict reconciles once, only after persisted mission completion', async () => {
  const order = []
  const replay = { run_ids: ['root-a', 'root-b'], replayed: true }
  const result = await completeGraphFixtureLaunch(async () => {
    order.push('launch')
    if (order.length === 1) return conflict(claimed(roots[1]))
    assert.deepEqual(order, ['launch', 'complete', 'launch'])
    return { status: 200, body: replay }
  }, async () => { order.push('complete'); return completed }, roots)
  assert.deepEqual(result, { launched: replay, result: completed, initialStatus: 409 })
})

test('graph launch rejects authorization, dispatch, mixed and unknown-task failures without waiting or replaying', async () => {
  for (const response of [
    { status: 403, body: {} }, { status: 500, body: {} },
    { status: 409, body: { error: 'mission has no schedulable tasks' } },
    conflict(`task ${roots[1]} secret assignment failed: denied`),
    conflict(`${claimed(roots[1])}; task ${roots[0]} dependency context failed: missing`),
    conflict(claimed(corp)),
  ]) {
    let calls = 0
    await assert.rejects(completeGraphFixtureLaunch(async () => { calls++; return response },
      async () => assert.fail('Rejected launches cannot wait or reconcile'), roots))
    assert.equal(calls, 1)
  }
})

test('graph launch never replays a failed, cancelled, incomplete or timed-out mission', async () => {
  for (const status of ['failed', 'cancelled', 'running', 'ready', 'timeout']) {
    let calls = 0
    await assert.rejects(completeGraphFixtureLaunch(async () => { calls++; return conflict(claimed(roots[1])) },
      async () => { if (status === 'timeout') throw new Error('mission deadline'); return { mission: { status } } }, roots))
    assert.equal(calls, 1)
  }
})

test('failed graph reports bounded identifiers and states without private free text', async () => {
  const failed = {
    mission: { id: corp, status: 'failed', secret: 'mission-private-canary' },
    runs: Array.from({ length: 20 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
      task_id: roots[index % 2], status: 'failed',
      summary: 'command stderr: summary-private-canary',
      verification_status: 'failed', verification_summary: 'verification-private-canary'.repeat(100),
      workspace_disposition: 'preserved', workspace_detail: 'workspace-private-canary',
      artifact_uri: 'artifact-private-canary', credentials: { password: 'credential-private-canary' },
    })),
    state: { snapshot: { secrets: ['snapshot-private-canary'] } },
  }
  const before = structuredClone(failed)
  let calls = 0
  await assert.rejects(completeGraphFixtureLaunch(async () => {
    calls++
    return conflict(claimed(roots[1]))
  }, async () => failed, roots), error => {
    assert.match(error.message, /Task graph did not complete:/u)
    assert.doesNotMatch(inspect(error), /private-canary|000000000112/u)
    const detail = JSON.parse(error.message.split('\n')[0].split('Task graph did not complete: ')[1])
    assert.deepEqual(detail.mission, { id: corp, status: 'failed' })
    assert.equal(detail.run_count, 20)
    assert.equal(detail.runs.length, 12)
    assert.deepEqual(detail.runs[0], {
      id: failed.runs[0].id, task_id: roots[0], status: 'failed',
      verification_status: 'failed', workspace_disposition: 'preserved',
    })
    return true
  })
  assert.equal(calls, 1)
  assert.deepEqual(failed, before)
})

test('graph failure diagnostics omit nested values in allowed fields', async () => {
  await assert.rejects(completeGraphFixtureLaunch(async () => ({ status: 200, body: {} }),
    async () => ({ mission: { status: 'failed' }, runs: [null, { summary: { secret: 'nested-private-canary' } }] }),
    roots), error => {
    assert.match(error.message, /Task graph did not complete:/u)
    assert.doesNotMatch(error.message, /nested-private-canary/u)
    return true
  })
})

test('graph failure rejects malformed identifiers and states without assertion value disclosure', async () => {
  for (const invalid of ['private-canary', `${corp}\nprivate-canary`, 'a'.repeat(2000),
    { secret: 'nested-private-canary' }, null, 123]) {
    await assert.rejects(completeGraphFixtureLaunch(async () => ({ status: 200, body: {} }),
      async () => ({ mission: { id: invalid, status: invalid }, runs: [{
        id: invalid, task_id: invalid, status: invalid,
        verification_status: invalid, workspace_disposition: invalid,
      }] }), roots), error => {
      assert.doesNotMatch(inspect(error), /private-canary|a{513}/u)
      const detail = JSON.parse(error.message.split('\n')[0].split('Task graph did not complete: ')[1])
      assert.deepEqual(detail, { mission: { id: null, status: null }, run_count: 1,
        runs: [{ id: null, task_id: null, status: null, verification_status: null, workspace_disposition: null }] })
      assert.equal(error.actual, false)
      return true
    })
  }
})

test('source-selection assertions do not disclose private Corp or commit values', () => {
  for (const change of [
    state => { state.runners[0].corp_id = 'corp-private-canary' },
    state => { state.runners[0].capabilities[1].source_base_commit = 'commit-private-canary' },
    state => { state.runners[0].capabilities[1].source_base_commit = { secret: 'nested-private-canary' } },
  ]) {
    const state = snapshot()
    change(state)
    assert.throws(() => graphFixtureSource(state, corp), error => {
      assert.doesNotMatch(inspect(error), /private-canary/u)
      return true
    })
  }
})

test('launch and replay assertions never print unknown response values', async () => {
  for (const invalid of ['response-private-canary', { secret: 'nested-private-canary' }]) {
    for (const responses of [
      [{ status: invalid, body: {} }],
      [conflict(claimed(roots[1])), { status: invalid, body: {} }],
      [conflict(claimed(roots[1])), { status: 200, body: { replayed: invalid } }],
    ]) {
      let calls = 0
      await assert.rejects(completeGraphFixtureLaunch(async () => responses[calls++],
        async () => completed, roots), error => {
        assert.doesNotMatch(inspect(error), /private-canary/u)
        return true
      })
      assert.equal(calls, responses.length)
    }
  }
})

test('graph reconciliation rejects a repeated conflict or a response that dispatched new work', async () => {
  for (const response of [conflict(claimed(roots[1])), { status: 200, body: { replayed: false } }]) {
    let calls = 0
    await assert.rejects(completeGraphFixtureLaunch(async () => ++calls === 1 ? conflict(claimed(roots[1])) : response,
      async () => completed, roots))
    assert.equal(calls, 2)
  }
})

test('the E2E retains native staffing, source assertions, concurrency, handoff and Windows mixed-provider coverage', () => {
  const script = readFileSync(new URL('./e2e_task_graph.mjs', import.meta.url), 'utf8')
  for (const evidence of ['graphFixtureSource(initial, demo.corp_id)', 'source_selected: sourceSelected',
    'worker?.mission_id, created.mission_id', 'legacy_mixed_provider_graph', "parallelGraph.runner_os === 'windows'",
    'root_adapters:', 'synthesis_consumed_verified_specialists: true', 'task.attempt_count, task.max_attempts']) {
    assert.ok(script.includes(evidence), 'Lost graph coverage: ' + evidence)
  }
  assert.ok(script.indexOf('if (config.dryRun)') < script.indexOf("await post('/api/demo/reset'"))
  assert.doesNotMatch(script, /prepareUnixDemoRoster|roster_fixture/u)
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(workflow, /ECORP_CI_UNIX_DEMO_ROSTER/u)
  const wrapper = readFileSync(new URL('./ci_external_adapters_windows.ps1', import.meta.url), 'utf8')
  assert.ok(wrapper.includes('legacy_mixed_provider_graph.root_adapters'))
})
