import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, open, realpath, rename } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { negativeFixtureCases } from '../scripts/research-negative-fixture.mjs'
import { loadResearchQa, researchDemo } from './research_handoff_browser.mjs'
import { requiredAdversarialCases } from './research_handoff_native_catalog.mjs'
export { requiredAdversarialCases } from './research_handoff_native_catalog.mjs'

// These are full required gates, not a list of whichever tests happen to exist.
// Extra invalid-probe and failed-parent controls do not replace any TF02/03 case.
const implementedNativeCases = [...negativeFixtureCases, 'unauthorized-artifact']
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const active = new Set(['provisioning', 'starting', 'running', 'waiting_for_input', 'waiting_for_approval', 'verifying'])
const sortIds = rows => rows.map(row => row.id).sort()
const prefix = 'ISSUE297 NEGATIVE FIXTURE: '

export function initialAdversarialCoverage() {
  return requiredAdversarialCases.map(case_id => ({
    case_id, status: 'not_executed',
    assertions: [], evidence_scope: 'native-full-stack-required',
  }))
}

export function adversarialCoverageResult(rows) {
  assert.ok(Array.isArray(rows))
  assert.deepEqual(rows.map(row => row.case_id).sort(), [...requiredAdversarialCases].sort(),
    'Every required case must appear exactly once')
  assert.ok(rows.every(row => ['not_executed', 'not_implemented', 'native_rejection_observed', 'failed'].includes(row.status)))
  for (const row of rows.filter(row => row.status === 'native_rejection_observed')) {
    assert.ok(implementedNativeCases.includes(row.case_id), 'No native executor exists for this claimed case')
    const required = row.case_id === 'unauthorized-artifact'
      ? ['authorized_signed_download', 'unauthorized_download_denied', 'no_mutations', 'unchanged_authority']
      : ['constructed_fault', 'native_parent_rejection', 'no_child_dispatch', 'unchanged_authority']
    assert.ok(row.evidence_scope === 'native-full-stack-required' &&
      Array.isArray(row.assertions) && new Set(row.assertions).size === 4 &&
      required.every(id => row.assertions.includes(id)) &&
      uuid.test(row.mission_id ?? '') && row.run_ids?.length === 2 &&
      new Set(row.run_ids).size === 2 && row.run_ids.every(id => uuid.test(id)) &&
      /^[0-9a-f]{64}$/.test(row.snapshot_sha256 ?? ''), 'Incomplete native assertions cannot satisfy a case')
  }
  const missing = rows.filter(row => row.status !== 'native_rejection_observed').map(row => row.case_id)
  return { accepted: false, phase: 'incomplete', missing_cases: missing,
    native_cases_observed: rows.length - missing.length,
    reason: 'Native fixture mappings exist separately; absent live TF02/03 and owner gates are never accepted' }
}

function missionView(state, missionId) {
  const s = state.snapshot
  const missions = s.missions.filter(row => row.id === missionId)
  assert.equal(missions.length, 1)
  const tasks = s.tasks.filter(row => row.mission_id === missionId).sort((a, b) => a.plan_key.localeCompare(b.plan_key))
  assert.deepEqual(tasks.map(task => task.plan_key), ['specialist-a', 'specialist-b', 'synthesis'])
  return { mission: missions[0], tasks, runs: s.runs.filter(row => tasks.some(task => task.id === row.task_id)) }
}

export function negativeAuthority(state, missionId) {
  const { mission, tasks } = missionView(state, missionId)
  const take = (row, fields) => Object.fromEntries(fields.map(key => [key, row[key]]))
  return hash({
    mission: take(mission, ['id', 'corp_id', 'room_id', 'requested_by', 'title', 'description',
      'strategy', 'max_nodes', 'max_depth', 'budget_tokens', 'budget_cost_microusd']),
    tasks: tasks.map(task => take(task, ['id', 'corp_id', 'mission_id', 'plan_key', 'assigned_agent_id',
      'required_adapter', 'depends_on', 'depth', 'max_attempts', 'contract_version', 'contract', 'verification_policy'])),
  })
}

export function assertNegativePlan(state, missionId, source) {
  const { mission, tasks, runs } = missionView(state, missionId)
  assert.ok(mission.status === 'ready' && mission.strategy === 'parallel-specialists' && runs.length === 0)
  assert.equal(mission.corp_id, researchDemo.corp_id)
  assert.equal(mission.room_id, researchDemo.room_id)
  assert.equal(mission.requested_by, researchDemo.alice_actor_id)
  assert.equal(new Set(tasks.map(task => task.assigned_agent_id)).size, 3)
  for (const task of tasks) {
    assert.equal(task.corp_id, researchDemo.corp_id)
    assert.equal(task.required_adapter, 'fake-process')
    assert.equal(task.max_attempts, 1)
    assert.equal(task.attempt_count, 0)
    assert.equal(task.verification_policy.manual_gate, null)
    assert.deepEqual({
      repository: task.contract.source_repository, base_ref: task.contract.source_base_ref,
      base_commit: task.contract.source_base_commit,
    }, source)
    if (task.plan_key === 'synthesis') {
      assert.deepEqual([...task.depends_on].sort(), tasks.filter(t => t.depth === 0).map(t => t.id).sort())
    } else {
      const paths = [`handoffs/${task.plan_key}.md`, `handoffs/${task.plan_key}-probe.json`]
      assert.equal(task.depth, 0)
      assert.deepEqual(task.depends_on, [])
      assert.equal(task.contract.expected_output, `Verified research files: ${paths.join(', ')}`)
      assert.deepEqual(task.contract.write_scope, paths)
      assert.deepEqual(task.contract.deliverable, {
        form: 'typed_artifact_set', commit_after_verification: false, paths,
      })
      const checks = task.verification_policy.checks
      assert.equal(checks.length, 4)
      assert.deepEqual(checks.slice(0, 3), [
        { type: 'artifact', min_bytes: 1 },
        ...paths.map(path => ({ type: 'file', path, min_bytes: 1 })),
      ])
      assert.deepEqual(checks[3], {
        type: 'command', program: 'node', args: ['-e',
          "const fs=require('node:fs');for(const p of process.argv.slice(1)){const b=fs.readFileSync(p);const s=new TextDecoder('utf-8',{fatal:true}).decode(b);if(!b.length||b.length>6144)process.exit(1);if(p.endsWith('.json'))JSON.parse(s)}",
          ...paths], timeout_ms: 5000,
      })
    }
  }
}

export function assertNativeNegativeOutcome(state, { case_id, nonce, mission_id, run_ids, authority }) {
  assert.ok(negativeFixtureCases.includes(case_id))
  const { mission, tasks, runs } = missionView(state, mission_id)
  assert.equal(negativeAuthority(state, mission_id), authority, 'Task/source/verifier authority changed')
  assert.equal(mission.status, 'failed', 'Native mission must reject the handoff')
  const child = tasks.find(task => task.plan_key === 'synthesis')
  assert.equal(child.attempt_count, 0, 'Synthesis must not be attempted')
  assert.ok(!runs.some(run => run.task_id === child.id), 'Rejected parents must not release synthesis')
  assert.deepEqual(sortIds(runs), [...run_ids].sort(), 'No replacement runs')
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map(run => run.task_id).sort(), tasks.filter(task => task.depth === 0).map(task => task.id).sort(),
    'Exactly one original run per parent required')
  const observed = []
  for (const run of runs) {
    const task = tasks.find(t => t.id === run.task_id)
    assert.equal(task.attempt_count, 1)
    assert.equal(run.corp_id, researchDemo.corp_id)
    assert.equal(run.status, 'failed')
    assert.equal(run.workspace_disposition, 'preserved', 'Failed fixture workspaces must remain')
    assert.equal(task.status, case_id === 'failed-parent' ? 'failed' : 'verification_failed')
    const events = state.snapshot.events.filter(event => event.aggregate_id === run.id)
    assert.equal(events.filter(event => event.type === 'run.started').length, 1)
    assert.equal(events.filter(event => event.type === 'run.completed').length, 0)
    assert.equal(events.filter(event => event.type === 'run.verification_passed').length, 0)
    const constructions = events.filter(event => event.type === 'run.output' &&
      typeof event.payload?.text === 'string' && event.payload.text.startsWith(prefix))
    assert.equal(constructions.length, 1, 'No verified fixture construction observation; setup failure is not native rejection')
    const proof = JSON.parse(constructions[0].payload.text.slice(prefix.length))
    assert.equal(proof.case_id, case_id)
    assert.equal(proof.nonce, nonce)
    assert.equal(proof.run_id, run.id)
    assert.deepEqual(proof.files.map(file => file.path), [
      `handoffs/${task.plan_key}.md`, `handoffs/${task.plan_key}-probe.json`,
    ])
    for (const [index, file] of proof.files.entries()) {
      if (case_id === 'missing-file' && index === 0) continue
      assert.ok(Number.isInteger(file.bytes) && file.bytes > 0 &&
        file.bytes <= (case_id === 'oversized-file' && index === 0 ? 6145 : 6144) &&
        /^[0-9a-f]{64}$/.test(file.sha256) && !file.missing)
    }
    if (case_id === 'missing-file') assert.equal(proof.files[0].missing, true)
    if (case_id === 'oversized-file') {
      assert.equal(proof.files[0].bytes, 6145)
      assert.equal(proof.files[0].sha256, createHash('sha256').update('x'.repeat(6145)).digest('hex'))
    }
    if (case_id === 'invalid-probe') {
      assert.equal(proof.files[1].bytes, 12)
      assert.equal(proof.files[1].sha256, createHash('sha256').update('{"observed":').digest('hex'))
    }
    if (case_id === 'failed-parent') {
      assert.ok(events.some(event => event.type === 'run.failed' &&
        event.payload?.error === 'Issue297 explicitly constructed failed parent.'))
    } else {
      assert.equal(run.verification_status, 'failed')
      assert.equal(task.verification_status, 'failed')
      assert.equal(events.filter(event => event.type === 'run.verification_failed').length, 1)
      const evidence = state.snapshot.verification_evidence.filter(row => row.run_id === run.id)
        .sort((a, b) => a.check_index - b.check_index)
      assert.equal(evidence.length, task.verification_policy.checks.length)
      for (const [index, row] of evidence.entries()) {
        assert.equal(row.check_index, index)
        assert.equal(row.kind, task.verification_policy.checks[index].type)
        assert.equal(row.task_id, task.id)
        assert.equal(row.corp_id, run.corp_id)
        assert.equal(row.status, index === 3 || (case_id === 'missing-file' && index === 1) ? 'failed' : 'passed',
          'Exact native check must reject; setup or unrelated verifier failure cannot substitute')
        if ((index === 1 || index === 2) && row.status === 'passed') {
          assert.deepEqual(row.payload, proof.files[index - 1], 'Native read must match constructed bytes')
        }
      }
      const execution = evidence[3].payload
      assert.equal(execution.exit_code, 1, 'Missing executable, timeout, or signal is not content rejection')
      assert.equal(execution.requested_program, 'node')
      assert.deepEqual(execution.args, task.verification_policy.checks[3].args)
      assert.ok(/^[0-9a-f]{64}$/.test(execution.resolved_executable?.canonical_path_sha256 ?? ''))
      if (case_id === 'missing-file') assert.match(execution.stderr, /ENOENT/)
      if (case_id === 'invalid-probe') assert.match(execution.stderr, /SyntaxError/)
      if (case_id === 'oversized-file') assert.equal(execution.stderr, '')
    }
    observed.push(proof)
  }
  return { case_id, status: 'native_rejection_observed', evidence_scope: 'native-full-stack-required',
    assertions: ['constructed_fault', 'native_parent_rejection', 'no_child_dispatch', 'unchanged_authority'],
    mission_id, run_ids: [...run_ids], snapshot_sha256: hash(state), construction: observed }
}

async function boundedJson(response) {
  const bytes = await boundedBytes(response, 8 * 1024 * 1024)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('Native API returned invalid JSON; body omitted') }
}

async function boundedBytes(response, limit) {
  assert.ok(response.body, 'Native API response body required')
  let size = 0
  const chunks = []
  for await (const chunk of response.body) {
    size += chunk.length
    assert.ok(size <= limit, 'Native response exceeds fixture bound')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function exclusiveJson(file, value) {
  const handle = await open(file, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() }
  finally { await handle.close() }
}

export async function runResearchAdversarial() {
  assert.equal(process.env.CRONY_RESEARCH_HANDOFF_TEST, '1', 'Explicit research QA opt-in required')
  const nonce = process.env.CRONY_ISSUE297_ADVERSARIAL_NONCE
  assert.ok(typeof nonce === 'string' && uuid.test(nonce), 'Operator-bound adversarial nonce required on client and dedicated runner')
  const owned = await loadResearchQa()
  const supplied = process.env.CRONY_RESEARCH_HANDOFF_OUTPUT
  assert.ok(typeof supplied === 'string' && path.isAbsolute(supplied), 'Fresh absolute output leaf required')
  const output = path.resolve(supplied)
  const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)))
  assert.notEqual(output, path.parse(output).root)
  const parent = await realpath(path.dirname(output))
  const relative = path.relative(repository, parent)
  assert.ok(path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`),
    'Evidence must remain outside the candidate source checkout')
  await mkdir(output)
  const reportPath = path.join(output, 'adversarial-research-handoff.json')
  const report = { schema_version: 1, issue: 297, case: 'adversarial', accepted: false,
    phase: 'in_progress', browser_executed: false, vendor_inference: false, nonce,
    source: owned.qa.source, candidate_head: owned.qa.head, candidate_files_sha256: owned.qa.files_sha256,
    coverage: initialAdversarialCoverage(), operations: [], cases: [], baseline_ids: null }
  let sequence = 0
  await exclusiveJson(reportPath, report)
  const save = async () => {
    const pending = path.join(output, `.adversarial-${++sequence}.pending`)
    await exclusiveJson(pending, report)
    await rename(pending, reportPath)
  }
  const deadline = Date.now() + 50_000
  let requests = 0
  const api = `/api/corps/${researchDemo.corp_id}`
  const fetchNative = async (route, body) => {
    assert.ok(Date.now() < deadline && ++requests <= 160, 'Adversarial time/request bound exhausted')
    assert.ok(route === '/health' || route.startsWith(`${api}/`), 'Owned API only')
    return fetch(`${owned.qa.server.url}${route}`, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.min(5000, Math.max(1, deadline - Date.now()))),
    })
  }
  const post = async (case_id, route, body) => {
    assert.ok(route === `${api}/missions` || report.cases.some(row =>
      route === `${api}/missions/${row.mission_id}/launch`), 'Only create and exact launch are permitted')
    assert.ok(!report.operations.some(row => row.case_id === case_id && row.route === route), 'Never retry an uncertain POST')
    await owned.check()
    const operation = { case_id, route, state: 'pending' }
    report.operations.push(operation)
    await save()
    const response = await fetchNative(route, body)
    const result = await boundedJson(response)
    Object.assign(operation, { state: 'response_received', http_status: response.status,
      mission_id: result.mission_id, task_ids: result.task_ids, run_ids: result.run_ids })
    await save()
    assert.equal(response.status, 200, 'Native mutation rejected; preserve original IDs')
    return result
  }
  const snapshot = async () => {
    const response = await fetchNative(`${api}/snapshot?actor_id=${researchDemo.alice_actor_id}`)
    assert.equal(response.status, 200)
    const state = await boundedJson(response)
    const observation = `observation-${requests}-native-snapshot.json`
    await exclusiveJson(path.join(output, observation), state)
    report.last_snapshot = { file: observation, sha256: hash(state) }
    await save()
    const s = state.snapshot
    for (const key of ['missions', 'tasks', 'runs', 'events', 'verification_evidence', 'source_deliverables', 'factory_work_items']) {
      assert.ok(Array.isArray(s?.[key]) && s[key].length < 500, 'Fresh bounded snapshot required')
    }
    assert.equal(s.corp.id, researchDemo.corp_id)
    assert.equal(s.factory_work_items.length, 0)
    const runners = state.runners.filter(row => row.connected)
    assert.equal(runners.length, 1)
    assert.equal(runners[0].id, owned.qa.runner.id)
    for (const name of ['fake-process', 'verified-dependency-files-v1']) {
      assert.ok(runners[0].capabilities.some(cap => cap.name === name && cap.available), 'Candidate capability missing')
    }
    const sources = runners[0].capabilities.filter(cap => cap.name === 'workspace-isolation' &&
      cap.available && cap.workspace_connection_id == null)
    assert.equal(sources.length, 1)
    assert.deepEqual({ repository: sources[0].source_repository?.toLowerCase(),
      base_ref: sources[0].source_base_ref, base_commit: sources[0].source_base_commit }, owned.qa.source)
    report.last_inventory = Object.fromEntries(['missions', 'tasks', 'runs'].map(key => [key, sortIds(s[key])]))
    await save()
    assert.deepEqual(sortIds(s.missions), report.cases.map(row => row.mission_id).sort(), 'Foreign mission or unexpected intake')
    return state
  }
  try {
    const healthResponse = await fetchNative('/health')
    assert.equal(healthResponse.status, 200)
    const health = await boundedJson(healthResponse)
    assert.ok(health.status === 'ok' && health.mode === 'development')
    const initial = await snapshot()
    for (const key of ['missions', 'tasks', 'runs', 'verification_evidence', 'source_deliverables']) {
      assert.equal(initial.snapshot[key].length, 0, 'Fresh pre-seeded owned fixture required; never reset')
    }
    assert.ok(!initial.snapshot.events.some(event => /^(mission|task|run)\./.test(event.type)))
    report.baseline_ids = report.last_inventory
    let downloadControl
    for (const case_id of negativeFixtureCases) {
      report.current_case = case_id
      const created = await post(case_id, `${api}/missions`, {
        requested_by: researchDemo.alice_actor_id, preferred_adapter: 'fake-process',
        strategy: 'parallel-specialists', max_task_attempts: 1, source: owned.qa.source,
        title: `[issue297-adversarial:${case_id}:${nonce}]`,
        description: 'Owned deterministic negative research fixture. Reject invalid parent outputs without synthesis; no vendor inference or approval.',
        secret_refs: [], budget_tokens: 280_000, budget_cost_microusd: 3_000_000,
      })
      assert.match(created.mission_id, uuid)
      assert.ok(created.task_ids?.length === 3 && new Set(created.task_ids).size === 3 && created.task_ids.every(id => uuid.test(id)))
      const testCase = { case_id, mission_id: created.mission_id, task_ids: created.task_ids }
      report.cases.push(testCase)
      await save()
      const held = await snapshot()
      assertNegativePlan(held, testCase.mission_id, owned.qa.source)
      testCase.authority = negativeAuthority(held, testCase.mission_id)
      const launched = await post(case_id, `${api}/missions/${testCase.mission_id}/launch`,
        { requested_by: researchDemo.alice_actor_id })
      assert.ok(launched.run_ids?.length === 2 && new Set(launched.run_ids).size === 2 &&
        launched.run_ids.every(id => uuid.test(id)))
      testCase.run_ids = launched.run_ids
      await save()
      let final
      do {
        const state = await snapshot()
        const view = missionView(state, testCase.mission_id)
        assert.equal(negativeAuthority(state, testCase.mission_id), testCase.authority)
        assert.ok(view.runs.every(run => testCase.run_ids.includes(run.id)), 'Unexpected child or replacement execution')
        if (view.mission.status === 'failed' && view.runs.length === 2 &&
          view.runs.every(run => !active.has(run.status) && run.workspace_disposition === 'preserved')) {
          final = state
          break
        }
        assert.notEqual(view.mission.status, 'completed', 'Negative mission was accepted')
        await new Promise(resolve => setTimeout(resolve, 200))
      } while (Date.now() < deadline)
      assert.ok(final, 'Timed out; setup/timeout is never native rejection evidence')
      const proof = assertNativeNegativeOutcome(final, { ...testCase, nonce })
      await exclusiveJson(path.join(output, `${case_id}-native-snapshot.json`), final)
      report.coverage[report.coverage.findIndex(row => row.case_id === case_id)] = proof
      await save()
      if (case_id === 'invalid-probe') downloadControl = { testCase, state: final }
    }
    assert.ok(downloadControl)
    report.current_case = 'unauthorized-artifact'
    const { testCase, state } = downloadControl
    const run = state.snapshot.runs.find(row => testCase.run_ids.includes(row.id) && row.artifact_id)
    assert.ok(run && uuid.test(run.artifact_id), 'Negative download control needs a real retained signed provider artifact')
    assert.ok(typeof run.artifact_signature === 'string' && run.artifact_signature.length > 0 &&
      /^[0-9a-f]{64}$/.test(run.artifact_sha256), 'Signed native artifact metadata required')
    assert.equal(run.artifact_uri, `${api}/artifacts/${run.artifact_id}`)
    const authorized = await fetchNative(`${run.artifact_uri}?actor_id=${researchDemo.alice_actor_id}`)
    report.download_control = { mission_id: testCase.mission_id, artifact_id: run.artifact_id,
      authorized_status: authorized.status }
    await save()
    assert.equal(authorized.status, 200, 'Authorized control must succeed before testing denial')
    assert.equal(authorized.headers.get('x-crony-artifact-role'), 'provider_evidence')
    assert.equal(authorized.headers.get('x-crony-artifact-signature'), run.artifact_signature)
    const bytes = await boundedBytes(authorized, 512 * 1024)
    assert.ok(bytes.length > 0)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), run.artifact_sha256)
    const eve = '00000000-0000-4000-8000-000000000013'
    const denied = await fetchNative(`${run.artifact_uri}?actor_id=${eve}`)
    report.download_control.unauthorized_status = denied.status
    await save()
    assert.ok([403, 404].includes(denied.status), 'Native artifact handler must deny the nonmember')
    await denied.body?.cancel()
    const unchanged = await snapshot()
    assert.equal(negativeAuthority(unchanged, testCase.mission_id), testCase.authority)
    for (const field of ['missions', 'tasks', 'runs']) {
      assert.deepEqual(sortIds(unchanged.snapshot[field]), report.cases.flatMap(row =>
        field === 'missions' ? [row.mission_id] : row[field === 'tasks' ? 'task_ids' : 'run_ids']).sort())
    }
    report.coverage[report.coverage.findIndex(row => row.case_id === 'unauthorized-artifact')] = {
      case_id: 'unauthorized-artifact', status: 'native_rejection_observed', evidence_scope: 'native-full-stack-required',
      assertions: ['authorized_signed_download', 'unauthorized_download_denied', 'no_mutations', 'unchanged_authority'],
      mission_id: testCase.mission_id, run_ids: testCase.run_ids, snapshot_sha256: hash(unchanged),
      artifact_id: run.artifact_id, authorized_status: 200, unauthorized_status: denied.status,
    }
    await save()
    await owned.check()
    Object.assign(report, adversarialCoverageResult(report.coverage))
    await save()
    throw new Error('Adversarial coverage is incomplete; retained native subset is not accepted TF02/03 evidence')
  } catch (error) {
    report.phase = report.phase === 'incomplete' ? 'incomplete' : 'failed'
    report.accepted = false
    report.failure = 'Adversarial gate did not pass. Preserve all original operations, cases and workspaces; no automatic retry.'
    await save()
    throw error
  }
}
