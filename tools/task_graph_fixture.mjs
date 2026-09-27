import assert from 'node:assert/strict'
import path from 'node:path'
import { assertTestEndpoint } from './owned_test_stack.mjs'

export function taskGraphFixtureConfig(args, env) {
  assert.ok(args.length <= 1 && args.every(arg => arg === '--dry-run'), 'Unknown or repeated task-graph fixture option')
  assert.ok(env.CRONY_TASK_GRAPH_TEST === '1', 'Explicit owned task-graph fixture opt-in is required')
  let endpoint
  try { endpoint = assertTestEndpoint(env.CRONY_SERVER_HTTP) } catch {
    throw new Error('An explicit non-manual loopback fixture URL is required; its value was not disclosed')
  }
  assert.ok(env.ECORP_CI_UNIX_DEMO_ROSTER === undefined || env.ECORP_CI_UNIX_DEMO_ROSTER === '0',
    'Legacy roster SQL is obsolete; use native source-selected mission staffing')
  return { server: endpoint.origin,
    output: path.resolve(env.CRONY_TASK_GRAPH_OUTPUT ?? path.join(import.meta.dirname, '..', 'output', 'e2e-task-graph.json')),
    dryRun: args.includes('--dry-run') }
}

export function graphFixtureSource(state, corpId) {
  const runners = state.runners.filter(runner => runner.connected)
  assert.equal(runners.length, 1, 'Task-graph fixture requires exactly one connected runner')
  const runner = runners[0]
  assert.ok(runner.corp_id === corpId, 'Task-graph runner must belong to the selected Corp')
  assert.ok(runner.capabilities.some(cap => cap.name === 'fake-process' && cap.available && cap.workspace_connection_id == null),
    'Native deterministic staffing must be available')
  const sources = runner.capabilities.filter(cap => cap.name === 'workspace-isolation' && cap.available && cap.workspace_connection_id == null)
  assert.equal(sources.length, 1, 'Task-graph fixture requires one unambiguous legacy source')
  const source = sources[0]
  assert.ok(source.source_repository && source.source_base_ref)
  assert.ok(typeof source.source_base_commit === 'string'
    && [40, 64].includes(source.source_base_commit.length)
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(source.source_base_commit),
  'Task-graph source must have an exact Git commit')
  return { runner, source: { repository: source.source_repository, base_ref: source.source_base_ref, base_commit: source.source_base_commit } }
}

function graphFailureDetails(result) {
  // Only validated identifiers, known states and counts belong in CI logs.
  // Free-text summaries/details may contain private output; truncation is not redaction.
  const id = value => typeof value === 'string' && value.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value) ? value : null
  const state = (value, allowed) => allowed.includes(value) ? value : null
  const runs = Array.isArray(result?.runs) ? result.runs : []
  return {
    mission: { id: id(result?.mission?.id),
      status: state(result?.mission?.status, ['draft', 'ready', 'running', 'completed', 'failed', 'cancelled']) },
    run_count: runs.length,
    runs: runs.slice(0, 12).map(run => ({
      id: id(run?.id), task_id: id(run?.task_id),
      status: state(run?.status, ['provisioning', 'starting', 'running', 'waiting_for_input',
        'waiting_for_approval', 'verifying', 'completed', 'failed', 'cancelled', 'lost']),
      verification_status: state(run?.verification_status, ['pending', 'running', 'passed', 'failed', 'waiting_for_approval']),
      workspace_disposition: state(run?.workspace_disposition, ['removed', 'preserved']),
    })),
  }
}

export async function completeGraphFixtureLaunch(launch, waitForMission, rootTaskIds) {
  const initial = await launch()
  assert.ok([200, 409].includes(initial?.status), 'Graph launch failed: expected HTTP 200 or a known root-claim conflict')
  if (initial.status === 409) {
    // A native scheduling sweep may claim another root after the first explicit
    // dispatch admits the mission. Do not reconcile any other dispatch failure.
    const conflict = typeof initial.body?.error === 'string'
      && /^mission dispatch incomplete \(\d+ new runs dispatched\): (.+)$/u.exec(initial.body.error)
    assert.ok(conflict, 'Graph launch did not report a root-claim conflict')
    for (const failure of conflict[1].split('; ')) {
      const claim = /^task ([0-9a-f-]{36}) could not create a run: task is not schedulable from status (?:claimed|running|verifying|completed)$/u.exec(failure)
      assert.ok(claim && rootTaskIds.includes(claim[1]), 'Graph launch had a failure other than a known root claim')
    }
  }
  const result = await waitForMission()
  assert.ok(result?.mission?.status === 'completed',
    'Task graph did not complete: ' + JSON.stringify(graphFailureDetails(result)))
  // Reconcile only after completion, when the native endpoint cannot dispatch a
  // dependency or retry. A successful replay requires persisted run.started.
  const reconciled = initial.status === 409 ? await launch() : initial
  assert.ok(reconciled?.status === 200, 'Completed graph launch did not reconcile')
  if (initial.status === 409) assert.ok(reconciled.body?.replayed === true, 'Completed graph launch must replay existing work')
  return { launched: reconciled.body, result, initialStatus: initial.status }
}
