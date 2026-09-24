import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Evaluate only the driver's actual assertion blocks. Never import its service entrypoint.
const driver = readFileSync(new URL('./e2e_factory_budget_recovery.mjs', import.meta.url), 'utf8')
function block(start, end) {
  const from = driver.indexOf(start)
  const to = driver.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `Missing driver assertion boundary: ${start}`)
  return driver.slice(from, to)
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const stableState = new Function(block('function stableState(data)', '// Refuse linked paths') + ';return stableState')()
const review = new AsyncFunction('ctx', `const {assert, snapshot, report, newId, demo, prefix, request, ok, overrun, task, mission} = ctx;
  ${block('        const reviewState=await snapshot()', '        const resumed=await until')}
`)
const finish = new AsyncFunction('ctx', `const {assert, snapshot, report, r, task, mission, initial, proposalBody, demo, overrun, stableState, process} = ctx;
  ${block('  const final=await snapshot()', "  await json(path.join(attempt,'qa-state.json')")}
`)

function fixture({ missingCheckpoint = false, overrun = false } = {}) {
  const demo = { corp_id: 'corp', alice_actor_id: 'alice', bob_actor_id: 'bob' }
  const policy = { checks: [{ type: 'artifact', min_bytes: 1 }, { type: 'file', path: 'resumed.txt', min_bytes: 1 }],
    manual_gate: { type: 'independent_review', roles: ['member', 'owner', 'admin'], exclude_requester: true } }
  const source = { source_repository: 'all-the-vibes/ecorp', source_base_ref: 'HEAD', source_base_commit: 'a'.repeat(40) }
  const contract = { ...source, objective: 'Original', expected_output: 'Original output', acceptance_tests: ['original'],
    write_scope: ['**'], budget_tokens: 6000, budget_cost_microusd: 10000000 }
  const task = { id: 'task', corp_id: 'corp', mission_id: 'mission', contract, verification_policy: policy }
  const mission = { id: 'mission', corp_id: 'corp', requested_by: 'alice', original_budget_tokens: 6000,
    original_budget_cost_microusd: 10000000, budget_tokens: 6000, budget_cost_microusd: 10000000 }
  const r = { ...source, id: 'original', corp_id: 'corp', task_id: 'task', agent_id: 'producer',
    status: 'cancelled', breaker_stage: 'suspend', input_tokens: 5000, output_tokens: 1000, cost_microusd: 60,
    budget_tokens_limit: 6000, budget_cost_microusd_limit: 10000000, provider_session_id: 'session',
    workspace_run_id: 'workspace', workspace_disposition: 'preserved',
    workspace_fingerprint: missingCheckpoint ? null : 'b'.repeat(64), workspace_detail: 'suspended' }
  const event = { id: 'suspended-event', seq: 1, aggregate_id: r.id, type: 'run.cancelled', payload: { reason: 'budget' } }
  const incident = { id: 'suspend-incident', corp_id: 'corp', mission_id: mission.id, task_id: task.id,
    run_id: r.id, stage: 'suspend', reason: 'run_tokens', input: { used: 6000, limit: 6000 } }
  const initial = { run: r, data: { snapshot: { runs: [r], tasks: [task], missions: [mission],
    events: [event], circuit_breaker_incidents: [incident] } } }
  const finishScope = { task_id: task.id, objective: 'Finish', expected_output: 'Verified resumed.txt',
    acceptance_tests: ['resumed.txt exists'], write_scope: ['**'], budget_tokens: 4000,
    budget_cost_microusd: 1000000, verification_policy: policy }
  const { task_id, verification_policy, ...replacement } = finishScope
  const proposalBody = { proposed_budget_tokens: overrun ? 10000 : 20000, proposed_budget_cost_microusd: 10000000,
    finish_scope: finishScope }
  const revision = { id: 'revision', corp_id: 'corp', mission_id: mission.id, status: 'approved', decided_by: 'alice',
    replacement_task_id: task.id, previous_contract: contract, replacement_contract: { ...contract, ...replacement },
    previous_verification_policy: policy, replacement_verification_policy: policy,
    current_budget_tokens: 6000, current_budget_cost_microusd: 10000000,
    proposed_budget_tokens: proposalBody.proposed_budget_tokens, proposed_budget_cost_microusd: 10000000,
    consumed_tokens_at_proposal: 6000, consumed_cost_microusd_at_proposal: 60 }
  const n = { ...r, id: 'resumed', resumed_from_run_id: r.id, status: overrun ? 'cancelled' : 'completed',
    breaker_stage: overrun ? 'stop' : 'healthy', verification_status: 'passed',
    budget_tokens_limit: 4000, budget_cost_microusd_limit: 1000000, artifact_id: 'artifact' }
  const gate = { run_id: n.id, corp_id: 'corp', task_id: task.id, gate_type: 'independent_review',
    gate: policy.manual_gate, status: 'approved', decided_by: 'bob', decided_at: '2026-09-20T00:01:00Z',
    requested_at: '2026-09-20T00:00:00Z', decision_note: 'Reviewed' }
  const pendingGate = { ...gate, status: 'pending', decided_by: null, decided_at: null, decision_note: null }
  const s = { runs: [r, n], tasks: [{ ...task, contract: revision.replacement_contract, status: 'completed', verification_status: 'passed' }],
    missions: [{ ...mission, budget_tokens: proposalBody.proposed_budget_tokens, status: overrun ? 'cancelled' : 'completed' }],
    mission_budget_revisions: [revision], verification_requests: overrun ? [] : [gate],
    verification_evidence: overrun ? [] : policy.checks.map((check, check_index) => ({
      id: `evidence-${check_index}`, run_id: n.id, task_id: task.id, corp_id: 'corp', check_index, kind: check.type, status: 'passed',
    })),
    actors: [{ id: 'alice', corp_id: 'corp', kind: 'human', role: 'owner' },
      { id: 'bob', corp_id: 'corp', kind: 'human', role: 'member' }],
    agents: [{ id: 'producer', corp_id: 'corp', actor_id: 'producer-actor' }],
    events: [event], circuit_breaker_incidents: [incident],
    factory_work_items: [{ id: 'item', mission_id: mission.id, state: overrun ? 'blocked' : 'verified' }],
    factory_controllers: [] }
  const report = { proposal: { status: 200, body: { revision: { id: revision.id } } }, resume: { status: 200, body: { run_id: n.id } },
    resume_run: { id: n.id, status: n.status }, ...(overrun ? { hard_stop_protected: true } : {
      pending_review: pendingGate, self_review: { status: 403 }, independent_review: { status: 200, body: { run_id: n.id, status: 'approved' } },
      independent_review_verified: true,
    }) }
  return structuredClone({ s, demo, task, mission, r, initial, proposalBody, report, overrun,
    newId: n.id, prefix: '/controlled', process: { exitCode: 0 } })
}

function context(options) {
  const f = fixture(options)
  const ctx = { ...f, s: structuredClone(f.s), assert, stableState }
  ctx.snapshot = async () => ({ snapshot: ctx.s })
  return ctx
}

function pendingContext(options) {
  const ctx = context(options)
  ctx.s.runs[1].status = 'waiting_for_approval'
  ctx.s.runs[1].verification_status = 'waiting_for_approval'
  ctx.s.tasks[0].status = 'awaiting_approval'
  ctx.s.tasks[0].verification_status = 'waiting_for_approval'
  ctx.s.verification_requests = [structuredClone(ctx.report.pending_review)]
  ctx.report = {}
  ctx.calls = []
  ctx.request = async (route, body) => {
    ctx.calls.push(body.actor_id)
    return body.actor_id === ctx.demo.alice_actor_id ? { status: 403 } :
      { status: 200, body: { run_id: ctx.newId, status: 'approved' } }
  }
  ctx.ok = async (route, body) => {
    const response = await ctx.request(route, body)
    assert.ok(response.status >= 200 && response.status < 300)
    return response.body
  }
  return ctx
}

for (const missingCheckpoint of [false, true]) {
  test(`direct completion cannot bypass pending independent review (missing checkpoint: ${missingCheckpoint})`, async () => {
    const ctx = pendingContext({ missingCheckpoint })
    ctx.s.runs[1].status = 'completed'
    await assert.rejects(review(ctx), assert.AssertionError)
    assert.deepEqual(ctx.calls, [])
  })
  test(`complete persisted proof is accepted (missing checkpoint: ${missingCheckpoint})`, async () => {
    const ctx = context({ missingCheckpoint })
    await finish(ctx)
    assert.equal(ctx.report.status, 'recovery_passed')
    assert.equal(ctx.process.exitCode, 0)
  })
}

test('pending review requires requester denial followed by distinct reviewer approval', async () => {
  const ctx = pendingContext()
  await review(ctx)
  assert.deepEqual(ctx.calls, ['alice', 'bob'])
  assert.equal(ctx.report.independent_review_verified, true)
  const completed = context()
  Object.assign(completed.report, ctx.report)
  await finish(completed)
  assert.equal(completed.report.status, 'recovery_passed')
})

for (const [name, mutate] of [
  ['missing review', c => { c.s.verification_requests = [] }],
  ['non-independent gate', c => { c.s.verification_requests[0].gate_type = 'human_approval' }],
  ['requester allowed', c => { c.s.verification_requests[0].gate.exclude_requester = false }],
  ['already decided gate', c => { c.s.verification_requests[0].status = 'approved' }],
  ['same actor', c => { c.demo.bob_actor_id = c.demo.alice_actor_id }],
  ['unauthorized role', c => { c.s.actors[1].role = 'spectator' }],
  ['producer reviewing', c => { c.s.agents[0].actor_id = c.demo.bob_actor_id }],
  ['requester accepted', c => { c.request = async () => ({ status: 200 }) }],
  ['reviewer denied', c => { c.request = async () => ({ status: 403 }) }],
  ['reviewer response for another run', c => {
    const request = c.request
    c.request = async (...args) => {
      const result = await request(...args)
      if (result.body) result.body.run_id = 'other'
      return result
    }
  }],
  ['requester denial changes gate', c => {
    const snapshot = c.snapshot
    let reads = 0
    c.snapshot = async () => {
      const result = structuredClone(await snapshot())
      if (++reads > 1) result.snapshot.verification_requests[0].status = 'approved'
      return result
    }
  }],
]) test(`pending gate rejects ${name}`, async () => {
  const ctx = pendingContext()
  mutate(ctx)
  await assert.rejects(review(ctx), assert.AssertionError)
})

for (const [name, mutate] of [
  ['no pending observation', c => { delete c.report.pending_review }],
  ['no requester denial', c => { delete c.report.self_review }],
  ['requester non-403', c => { c.report.self_review.status = 400 }],
  ['no independent response', c => { delete c.report.independent_review }],
  ['no independent proof flag', c => { delete c.report.independent_review_verified }],
  ['no persisted decision', c => { c.s.verification_requests = [] }],
  ['decision by requester', c => { c.s.verification_requests[0].decided_by = 'alice' }],
  ['decision still pending', c => { c.s.verification_requests[0].status = 'pending' }],
  ['decision gate drift', c => { c.s.verification_requests[0].gate.exclude_requester = false }],
  ['foreign decision', c => { c.s.verification_requests[0].task_id = 'other' }],
  ['missing decision timestamp', c => { c.s.verification_requests[0].decided_at = null }],
  ['missing automated evidence', c => { c.s.verification_evidence.pop() }],
  ['failed file check', c => { c.s.verification_evidence[1].status = 'failed' }],
  ['foreign proof', c => { c.s.verification_evidence[0].run_id = 'other' }],
  ['wrong proof kind', c => { c.s.verification_evidence[1].kind = 'artifact' }],
  ['wrong proof task', c => { c.s.verification_evidence[1].task_id = 'other' }],
  ['wrong proof Corp', c => { c.s.verification_evidence[1].corp_id = 'other' }],
  ['wrong proof index', c => { c.s.verification_evidence[1].check_index = 3 }],
  ['missing artifact', c => { c.s.runs[1].artifact_id = null }],
  ['failed verification', c => { c.s.runs[1].verification_status = 'failed' }],
  ['changed source ref', c => { c.s.runs[1].source_base_ref = 'other' }],
  ['changed source repository', c => { c.s.tasks[0].contract.source_repository = 'other' }],
  ['changed source commit', c => { c.s.runs[1].source_base_commit = 'other' }],
  ['changed source connection', c => { c.s.runs[1].workspace_connection_id = 'other' }],
  ['changed provider session', c => { c.s.runs[1].provider_session_id = 'other' }],
  ['changed workspace lineage', c => { c.s.runs[1].workspace_run_id = 'other' }],
  ['changed resume ancestor', c => { c.s.runs[1].resumed_from_run_id = 'other' }],
  ['changed verifier', c => { c.s.tasks[0].verification_policy = { checks: [], manual_gate: null } }],
  ['changed finish tokens', c => { c.s.runs[1].budget_tokens_limit = 9999 }],
  ['changed finish cost', c => { c.s.runs[1].budget_cost_microusd_limit = 9999 }],
  ['changed revision task', c => { c.s.mission_budget_revisions[0].replacement_task_id = 'other' }],
  ['missing approved revision', c => { c.s.mission_budget_revisions = [] }],
  ['unapproved revision', c => { c.s.mission_budget_revisions[0].status = 'pending' }],
  ['rewritten prior contract', c => { c.s.mission_budget_revisions[0].previous_contract.objective = 'changed' }],
  ['rewritten prior policy', c => { c.s.mission_budget_revisions[0].previous_verification_policy = null }],
  ['changed current mission budget', c => { c.s.missions[0].budget_tokens = 99999 }],
  ['changed original budget', c => { c.s.missions[0].original_budget_tokens = 1 }],
  ['rewritten original fingerprint', c => { c.s.runs[0].workspace_fingerprint = 'invented' }],
  ['rewritten original spend', c => { c.s.runs[0].input_tokens = 0 }],
  ['rewritten suspension history', c => { c.s.events[0].payload.reason = 'rewritten' }],
  ['missing original event', c => { c.s.events = [] }],
  ['rewritten breaker incident', c => { c.s.circuit_breaker_incidents[0].input.used = 0 }],
  ['missing breaker incident', c => { c.s.circuit_breaker_incidents = [] }],
]) test(`final recovery rejects ${name}`, async () => {
  const ctx = context({ missingCheckpoint: true })
  mutate(ctx)
  await assert.rejects(finish(ctx), assert.AssertionError)
})

test('hard-stop lane needs no successful review', async () => {
  const ctx = context({ overrun: true })
  ctx.request = ctx.ok = async () => { assert.fail('Hard stop must not submit review') }
  await review(ctx)
  await finish(ctx)
  assert.equal(ctx.report.status, 'hard_stop_protected')
  assert.equal(ctx.process.exitCode, 0)
})
