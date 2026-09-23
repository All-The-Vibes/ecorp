import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { captureOwnedTestServerManifest } from './owned_test_stack.mjs'

const server = process.env.CRONY_SERVER_HTTP
const root = process.env.ECORP_AGGREGATE_FIXTURE_ROOT
assert.ok(root && path.isAbsolute(root), 'explicit owned fixture root required')
assert.match(server ?? '', /^http:\/\/127\.0\.0\.1:5901[1-9]$/u)
const owner = JSON.parse(await readFile(path.join(root, 'server-process.json'), 'utf8'))
assert.equal(owner.test_owned, true)
assert.equal(owner.server, server)
assert.equal(path.resolve(owner.root), path.resolve(root))
const live = await captureOwnedTestServerManifest({
  root, server, binary: owner.path, pid: owner.pid,
  pidPath: path.join(root, 'aggregate-live-server.json'),
})
assert.ok(Math.abs(Date.parse(live.server_creation) - Date.parse(owner.started_at)) <= 20,
  'server process generation must match the owned launch')
const active = new Set(['provisioning', 'starting', 'running', 'waiting_for_input', 'waiting_for_approval', 'verifying'])
async function request(route, body, expected = 200) {
  const response = await fetch(`${server}${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const value = response.status === 204 ? null : await response.json()
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(value)}`)
  return value
}
async function wait(label, check) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  throw new Error(`bounded wait failed: ${label}`)
}
const results = []
for (const scope of ['mission', 'requester_24h', 'corp_24h']) {
  const demo = await request('/api/demo/reset', {})
  const snapshot = () => request(`/api/corps/${demo.corp_id}/snapshot?actor_id=${demo.alice_actor_id}`)
  const state = await wait('native runner connected', async () => {
    const state = await snapshot()
    return state.runners.some((runner) => runner.connected) && state
  })
  const runner = state.runners.find((runner) => runner.connected)
  const capability = runner.capabilities.find((entry) => entry.name === 'workspace-isolation' && entry.available)
  assert.ok(capability?.source_repository && capability.source_base_commit)
  const source = { repository: capability.source_repository, base_ref: capability.source_base_ref, base_commit: capability.source_base_commit }
  await request(`/api/corps/${demo.corp_id}/budget-policy`, {
    actor_id: demo.alice_actor_id, actor_tokens_per_24h: scope === 'requester_24h' ? 10_000 : 1_000_000,
    actor_cost_microusd_per_24h: 1_000_000_000, corp_tokens_per_24h: scope === 'corp_24h' ? 10_000 : 1_000_000,
    corp_cost_microusd_per_24h: 1_000_000_000, no_progress_event_limit: 100, repeated_tool_limit: 100,
  }, 204)
  async function launch(actor, parallel) {
    const mission = await request(`/api/corps/${demo.corp_id}/missions`, {
      requested_by: actor, preferred_adapter: 'fake-process', source,
      strategy: parallel ? 'parallel-specialists' : 'single',
      title: `[budget-late-completion] Issue56 ${scope} concurrent authority`,
      budget_tokens: scope === 'mission' && parallel ? 10_000 : 100_000,
      budget_cost_microusd: 10_000_000,
    })
    const launched = await request(`/api/corps/${demo.corp_id}/missions/${mission.mission_id}/launch`, { requested_by: actor })
    return { mission, runs: launched.run_ids ?? [launched.run_id] }
  }
  const first = await launch(demo.alice_actor_id, scope === 'mission')
  const second = scope === 'mission' ? null : await launch(demo.alice_actor_id, false)
  const outsider = await launch(scope === 'mission' ? demo.alice_actor_id : demo.bob_actor_id, false)
  const expected = [...first.runs, ...(second?.runs ?? []), ...(scope === 'corp_24h' ? outsider.runs : [])]
  const all = [...new Set([...expected, ...outsider.runs])]
  const children = await wait('all concurrent native children at barrier', async () => {
    try {
      return await Promise.all(all.map(async (id) => {
        const child = JSON.parse(await readFile(path.join(root, 'ready', `${id}.json`), 'utf8'))
        assert.equal(child.run_id, id)
        assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
        process.kill(child.pid, 0) // Signal zero checks liveness without sending a signal.
        return child
      }))
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return false
      throw error
    }
  })
  assert.equal(new Set(children.map((child) => child.pid)).size, all.length)
  const before = await snapshot()
  assert.equal(all.filter((id) => active.has(before.snapshot.runs.find((run) => run.id === id)?.status)).length, all.length)
  await writeFile(path.join(root, 'controls', `${first.runs[0]}.json`), JSON.stringify({ tokens: 11_000 }))
  const fenced = await wait('every affected run fenced', async () => {
    const current = await snapshot()
    return expected.every((id) => current.snapshot.runs.find((run) => run.id === id)?.breaker_stage === 'stop') && current
  })
  for (const id of expected) {
    const transition = fenced.snapshot.events.find((event) => event.type === 'run.breaker_transition' && event.aggregate_id === id)
    assert.ok(transition)
    if (id !== first.runs[0] || scope !== 'mission') {
      assert.equal(transition.payload.input.scope, scope)
      assert.equal(transition.payload.input.used, 11_000)
      assert.equal(transition.payload.input.limit, 10_000)
      assert.deepEqual([...transition.payload.input.affected_run_ids].sort(), [...expected].sort())
    }
  }
  if (scope !== 'corp_24h') {
    for (const id of outsider.runs) {
      assert.equal(fenced.snapshot.runs.find((run) => run.id === id)?.breaker_stage, 'healthy')
      await writeFile(path.join(root, 'controls', `${id}.json`), JSON.stringify({ complete: true }))
    }
  }
  const final = await wait('native cleanup and command acknowledgements', async () => {
    const current = await snapshot()
    return all.every((id) => {
      const run = current.snapshot.runs.find((run) => run.id === id)
      return run && !active.has(run.status) && ['preserved', 'removed'].includes(run.workspace_disposition)
    }) && expected.every((id) => current.snapshot.events.some((event) =>
      event.type === 'runner.command_acknowledged' && event.aggregate_id === id &&
      event.payload.command_kind === 'circuit_breaker')) && current
  })
  for (const id of expected) {
    assert.notEqual(final.snapshot.runs.find((run) => run.id === id)?.status, 'completed')
    assert.equal(final.snapshot.runs.find((run) => run.id === id)?.artifact_id, null)
    assert.ok(!final.snapshot.source_deliverables.some((artifact) => artifact.run_id === id))
    assert.ok(!final.snapshot.events.some((event) => event.aggregate_id === id && ['run.completed', 'run.artifact', 'run.deliverable'].includes(event.type)))
    assert.equal(final.snapshot.circuit_breaker_incidents.filter((incident) => incident.run_id === id && incident.stage === 'stop').length, 1)
    const attempt = JSON.parse(await readFile(path.join(root, 'attempts', `${id}.json`), 'utf8'))
    assert.equal(attempt.completion_attempted, true)
  }
  let rejectedDispatch = null
  if (scope !== 'mission') {
    const denied = await request(`/api/corps/${demo.corp_id}/missions`, {
      requested_by: demo.alice_actor_id, preferred_adapter: 'fake-process', source,
      strategy: 'single', title: `[budget-late-completion] Issue56 ${scope} exhausted dispatch`,
      budget_tokens: 100_000, budget_cost_microusd: 10_000_000,
    })
    const rejection = await request(`/api/corps/${demo.corp_id}/missions/${denied.mission_id}/launch`,
      { requested_by: demo.alice_actor_id }, 409)
    assert.match(JSON.stringify(rejection), /budget has no remaining authority/u)
    const deniedState = await snapshot()
    const tasks = new Set(deniedState.snapshot.tasks.filter((task) => task.mission_id === denied.mission_id).map((task) => task.id))
    assert.ok(!deniedState.snapshot.runs.some((run) => tasks.has(run.task_id)))
    rejectedDispatch = { mission_id: denied.mission_id, http_status: 409, new_runs: 0, rejection }
  }
  results.push({
    scope, concurrent_runs: all, affected_runs: expected, source, children,
    rejected_dispatch: rejectedDispatch,
    runs: final.snapshot.runs.filter((run) => all.includes(run.id)),
    transitions: final.snapshot.events.filter((event) => expected.includes(event.aggregate_id) &&
      ['run.breaker_transition', 'runner.command_acknowledged', 'run.failed', 'run.cancelled'].includes(event.type)),
    late_artifacts_accepted: 0, late_completions_accepted: 0,
  })
  await writeFile(path.join(root, 'native-aggregate-results.json'), `${JSON.stringify(results, null, 2)}\n`)
  console.log(`${scope}: ${all.length} concurrent children, ${expected.length} fenced; late artifact/completion rejected`)
}
