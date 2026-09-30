import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBudgetOverview, BUDGET_SNAPSHOT_FRESH_MS, budgetAuthority, budgetDestinationAvailable, formatBudgetMoney, formatBudgetTokens } from './budgetOverview.ts'

const now = Date.parse('2026-09-29T12:00:00Z')
const viewer = { corpId: 'corp-a', actorId: 'alice' }
const stamp = { ...viewer, receivedAt: new Date(now - 1000).toISOString(), connection: 'live', refreshFailed: false }
const mission = (id = 'mission-a', extra = {}) => ({
  id, corp_id: 'corp-a', room_id: 'room-a', title: id, status: 'running',
  original_budget_tokens: 1000, original_budget_cost_microusd: 10_000_000,
  budget_tokens: 2000, budget_cost_microusd: 12_000_000, ...extra,
})
const task = (id = 'task-a', extra = {}) => ({ id, corp_id: 'corp-a', mission_id: 'mission-a', attempt_count: 1, ...extra })
const run = (id = 'run-a', extra = {}) => ({
  id, corp_id: 'corp-a', task_id: 'task-a', agent_id: 'worker-a', status: 'completed', breaker_stage: null,
  resumed_from_run_id: null, input_tokens: 100, output_tokens: 10, cost_microusd: 100_001, ...extra,
})
const revision = (id = 'revision-a', extra = {}) => ({
  id, corp_id: 'corp-a', mission_id: 'mission-a', status: 'approved', version: 1,
  proposed_budget_tokens: 2000, proposed_budget_cost_microusd: 12_000_000, ...extra,
})
const fixture = (extra = {}) => ({
  corp: { id: 'corp-a', name: 'Budget fixture' }, rooms: [{ id: 'room-a', corp_id: 'corp-a' }],
  missions: [mission()], tasks: [task()], runs: [run()], mission_budget_revisions: [revision()], ...extra,
})
const project = (snapshot = fixture(), options = {}) =>
  buildBudgetOverview(snapshot, options.viewer ?? viewer, options.stamp ?? stamp, options.now ?? now)

test('reads immutable original and current ceilings; pending requests never grant authority', () => {
  const snapshot = fixture({ mission_budget_revisions: [revision(), revision('pending', {
    status: 'pending', version: 2, proposed_budget_tokens: 10_000, proposed_budget_cost_microusd: 50_000_000,
  })] })
  const before = JSON.stringify(snapshot)
  const result = project(snapshot)
  assert.equal(result.state, 'current')
  assert.deepEqual(result.totals.original, { tokens: 1000n, cost: 10_000_000n })
  assert.deepEqual(result.totals.current, { tokens: 2000n, cost: 12_000_000n })
  assert.deepEqual(result.totals.consumed, { tokens: 110n, cost: 100_001n })
  assert.deepEqual(result.totals.remaining, { tokens: 1890n, cost: 11_899_999n })
  assert.equal(result.rows[0].pending[0].id, 'pending')
  assert.equal(result.rows[0].currentDecisionMissing, false)
  assert.equal(JSON.stringify(snapshot), before)
})

test('counts workers, retries, resumed deltas and an auditor once from run totals, never cache or revision totals', () => {
  const snapshot = fixture({
    tasks: [task('task-a', { attempt_count: 2 }), task('task-worker'), task('task-auditor')],
    runs: [run(), run('retry', { input_tokens: 500, output_tokens: 20, cost_microusd: 200_000,
      resumed_from_run_id: 'run-a', cached_input_tokens: 450 }),
    run('worker', { task_id: 'task-worker', agent_id: 'worker-b', input_tokens: 50, output_tokens: 5, cost_microusd: 0 }),
    run('auditor', { task_id: 'task-auditor', agent_id: 'auditor-a', input_tokens: 30, output_tokens: 2, cost_microusd: 0 }), run()],
  })
  const row = project(snapshot).rows[0]
  assert.deepEqual(row.consumed, { tokens: 717n, cost: 300_001n })
  assert.equal(row.runCount, 4)
  assert.equal(row.workerCount, 3)
  assert.equal(row.resumedRunCount, 1)
  assert.equal(row.missingHistory, false)
  assert.equal(row.reportedCostRuns, 2)
  assert.equal(row.unpricedRuns, 2)
})

test('zero recorded price with tokens is unpriced; no usage is unavailable, never free', () => {
  const row = project(fixture({ runs: [run('unpriced', { cost_microusd: 0 }),
    run('unreported', { input_tokens: 0, output_tokens: 0, cost_microusd: 0 }),
    run('output-only', { input_tokens: 0, output_tokens: 5, cost_microusd: 0 }), run('reported')] })).rows[0]
  assert.equal(row.unpricedRuns, 2)
  assert.equal(row.unreportedRuns, 1)
  assert.equal(row.reportedCostRuns, 1)
  assert.equal(Object.hasOwn(row, 'measuredCost'), false)
  assert.equal(Object.hasOwn(row, 'estimatedCost'), false)
})

test('authorized snapshot scope excludes foreign Corp records and missions outside returned rooms', () => {
  const result = project(fixture({
    missions: [mission(), mission('foreign', { corp_id: 'corp-b' }), mission('denied', { room_id: 'room-denied' })],
    tasks: [task(), task('foreign-task', { corp_id: 'corp-b', mission_id: 'foreign' })],
    runs: [run(), run('foreign-run', { corp_id: 'corp-b', task_id: 'foreign-task', input_tokens: 900 })],
    mission_budget_revisions: [revision(), revision('foreign-revision', { corp_id: 'corp-b', status: 'pending' })],
  }))
  assert.deepEqual(result.rows.map((row) => row.mission.id), ['mission-a'])
  assert.equal(result.totals.consumed.tokens, 110n)
  assert.equal(result.rows[0].pending.length, 0)
})

for (const [name, options] of [
  ['different viewer', { stamp: { ...stamp, actorId: 'bob' } }],
  ['different Corp receipt', { stamp: { ...stamp, corpId: 'corp-b' } }],
  ['missing viewer', { viewer: { ...viewer, actorId: '' } }],
  ['missing Corp', { viewer: { ...viewer, corpId: '' } }],
  ['revoked or failed refresh', { stamp: { ...stamp, refreshFailed: true } }],
  ['missing timestamp', { stamp: { ...stamp, receivedAt: null } }],
  ['invalid timestamp', { stamp: { ...stamp, receivedAt: 'invalid' } }],
  ['future timestamp', { stamp: { ...stamp, receivedAt: new Date(now + 1).toISOString() } }],
  ['invalid clock', { now: NaN }],
]) test(`${name} hides all previous budget data`, () => {
  const result = project(fixture(), options)
  assert.equal(result.state, 'unavailable')
  assert.deepEqual(result.rows, [])
  assert.equal(result.totals, null)
})

test('mismatched server Corp never yields a budget projection', () => {
  assert.equal(project(fixture({ corp: { id: 'corp-b', name: 'Other Corp' } })).state, 'unavailable')
})

for (const connection of ['offline', 'connecting']) test(`${connection} hides stale totals`, () => {
  assert.equal(project(fixture(), { stamp: { ...stamp, connection } }).state, 'stale')
})

test('freshness boundary is explicit and a new receipt restores visibility', () => {
  const receivedAt = new Date(now - BUDGET_SNAPSHOT_FRESH_MS).toISOString()
  assert.equal(project(fixture(), { stamp: { ...stamp, receivedAt } }).state, 'stale')
  assert.equal(project(fixture(), { stamp: { ...stamp, receivedAt }, now: now - 1 }).state, 'current')
  assert.equal(project().state, 'current')
})

for (const key of ['rooms', 'missions', 'tasks', 'runs', 'mission_budget_revisions']) {
  test(`${key}: identical duplicates count once and conflicting copies withhold all totals`, () => {
    const snapshot = fixture()
    snapshot[key].push(structuredClone(snapshot[key][0]))
    assert.equal(project(snapshot).totals.consumed.tokens, 110n)
    snapshot[key][1] = { ...snapshot[key][1], title: 'conflicting copy' }
    const result = project(snapshot)
    assert.equal(result.state, 'unavailable')
    assert.deepEqual(result.rows, [])
    assert.equal(result.totals, null)
  })
}

test('unattributed runs withhold aggregate consumption and all apparent remaining headroom', () => {
  const result = project(fixture({ runs: [run(), run('orphan', { task_id: 'absent' })] }))
  assert.equal(result.unattributedRuns, 1)
  assert.equal(result.totals.consumed.tokens, null)
  assert.equal(result.totals.remaining.cost, null)
  assert.equal(result.rows[0].consumed.tokens, 110n)
  assert.equal(result.rows[0].remaining.tokens, null)
  const empty = project(fixture({ missions: [], tasks: [] }))
  assert.equal(empty.totals.remaining.tokens, null)
})

for (const count of [2, -1, NaN, 1.5]) test(`attempt count ${count} detects missing or invalid run history`, () => {
  const row = project(fixture({ tasks: [task('task-a', { attempt_count: count })] })).rows[0]
  assert.equal(row.missingHistory, true)
  assert.equal(row.remaining.tokens, null)
  assert.equal(row.consumed.tokens, 110n)
})

test('a missing or different-task resume ancestor withholds remaining authority', () => {
  assert.equal(project(fixture({ runs: [run('child', { resumed_from_run_id: 'missing' })] })).rows[0].missingHistory, true)
  const result = project(fixture({ tasks: [task(), task('other')], runs: [
    run('child', { resumed_from_run_id: 'parent' }), run('parent', { task_id: 'other' }),
  ] }))
  assert.equal(result.rows[0].missingHistory, true)
})

test('revised ceilings remain authoritative while a missing approval receipt stays explicit', () => {
  assert.equal(project(fixture({ mission_budget_revisions: [] })).rows[0].currentDecisionMissing, true)
  assert.equal(project(fixture({ mission_budget_revisions: [revision('pending', { status: 'pending' })] })).rows[0].currentDecisionMissing, true)
  assert.equal(project(fixture({ mission_budget_revisions: [revision('wrong', { proposed_budget_tokens: 3 })] })).rows[0].currentDecisionMissing, true)
  assert.equal(project(fixture({ mission_budget_revisions: [revision('wrong', { proposed_budget_cost_microusd: 3 })] })).rows[0].currentDecisionMissing, true)
  assert.equal(project(fixture({ missions: [mission('mission-a', { budget_tokens: 1000, budget_cost_microusd: 10_000_000 })],
    mission_budget_revisions: [] })).rows[0].currentDecisionMissing, false)
})

for (const invalid of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
  test(`unsafe ledger value ${invalid} is unavailable instead of rounded or reset`, () => {
    const result = project(fixture({ runs: [run('bad', { input_tokens: invalid, cost_microusd: invalid })],
      missions: [mission('mission-a', { original_budget_tokens: invalid, budget_cost_microusd: invalid })] }))
    assert.equal(result.rows[0].invalidUsage, true)
    assert.equal(result.totals.consumed.tokens, null)
    assert.equal(result.totals.remaining.cost, null)
    assert.equal(result.rows[0].original.tokens, null)
  })
}

test('safe individual integer values sum exactly beyond the JS safe integer range', () => {
  const result = project(fixture({ runs: [run('a', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }),
    run('b', { input_tokens: 1, output_tokens: 0 })] }))
  assert.equal(result.totals.consumed.tokens, 9007199254740993n)
  assert.equal(result.totals.remaining.tokens, -9007199254738993n)
})

test('attention sorting is stable; original ceilings are never pooled into new authority', () => {
  const missions = [mission('z'), mission('b'), mission('a'), mission('same-b', { title: 'same' }), mission('same-a', { title: 'same' })]
  const result = project(fixture({ missions, tasks: [task('tz', { mission_id: 'z' })],
    runs: [run('suspended', { task_id: 'tz', status: 'cancelled', breaker_stage: 'suspend' })],
    mission_budget_revisions: [revision('pending', { mission_id: 'b', status: 'pending' }),
      revision('newer', { mission_id: 'b', version: 2 }), revision('same-version', { mission_id: 'b', version: 2 })],
  }))
  assert.deepEqual(result.rows.map((row) => row.mission.id), ['b', 'z', 'a', 'same-a', 'same-b'])
  assert.deepEqual(result.rows[1].suspendedRunIds, ['suspended'])
  assert.deepEqual(result.rows[0].revisions.map((item) => item.id), ['newer', 'same-version', 'pending'])
  assert.equal(result.totals.original.tokens, 5000n)
})

test('an empty authorized snapshot is distinguishable from unavailable data', () => {
  const result = project(fixture({ missions: [], tasks: [], runs: [], mission_budget_revisions: [] }))
  assert.equal(result.state, 'current')
  assert.deepEqual(result.rows, [])
  assert.deepEqual(result.totals.consumed, { tokens: 0n, cost: 0n })
})

test('formatting preserves sub-cent recorded amounts, large totals and overruns', () => {
  for (const [value, expected] of [[null, 'Unavailable'], [0n, '$0.00'], [1n, '$0.000001'],
    [10_000n, '$0.01'], [1_230_000n, '$1.23'], [1_234_567n, '$1.234567'],
    [-1_000_000n, '-$1.00'], [1_234_567_890_120n, '$1,234,567.89012']]) {
    assert.equal(formatBudgetMoney(value), expected)
  }
  assert.equal(formatBudgetTokens(null), 'Unavailable')
  assert.equal(formatBudgetTokens(-1234n), '-1,234 tokens')
})

test('requests with invalid wire amounts stay unavailable instead of throwing or granting authority', () => {
  assert.deepEqual(budgetAuthority(NaN, 1.2), { tokens: null, cost: null })
  assert.deepEqual(budgetAuthority(-1, Number.MAX_SAFE_INTEGER + 1), { tokens: null, cost: null })
  assert.deepEqual(budgetAuthority(0, 1), { tokens: 0n, cost: 1n })
})

test('exact budget navigation requires a current authorized mission and its own decision or suspended run', () => {
  const result = project(fixture({
    missions: [mission(), mission('other')],
    tasks: [task(), task('other-task', { mission_id: 'other' })],
    runs: [run('suspended', { status: 'failed', breaker_stage: 'suspend' }),
      run('other-suspension', { task_id: 'other-task', status: 'cancelled', breaker_stage: 'suspend' })],
    mission_budget_revisions: [revision(), revision('other-revision', { mission_id: 'other' })],
  }))
  const target = { kind: 'budget', missionId: 'mission-a' }
  assert.equal(budgetDestinationAvailable(result, target), true)
  assert.equal(budgetDestinationAvailable(result, { ...target, missionId: 'missing' }), false)
  assert.equal(budgetDestinationAvailable(project(fixture(), { stamp: { ...stamp, connection: 'offline' } }), target), false)
  assert.equal(budgetDestinationAvailable(project(fixture(), { stamp: { ...stamp, refreshFailed: true } }), target), false)
  assert.equal(budgetDestinationAvailable(result, { ...target, kind: 'revision', revisionId: 'revision-a' }), true)
  assert.equal(budgetDestinationAvailable(result, { ...target, kind: 'revision', revisionId: 'other-revision' }), false)
  assert.equal(budgetDestinationAvailable(result, { ...target, kind: 'suspension', runId: 'suspended' }), true)
  assert.equal(budgetDestinationAvailable(result, { ...target, kind: 'suspension', runId: 'other-suspension' }), false)
})

for (const status of ['failed', 'cancelled']) {
  test(`a terminated ${status} budget suspension retains its exact inspection link`, () => {
    const result = project(fixture({ runs: [
      run('budget-boundary', { status, breaker_stage: 'suspend',
        workspace_disposition: 'preserved', provider_session_id: 'recorded-session' }),
      run('ordinary-failure', { status: 'failed', breaker_stage: 'healthy' }),
      run('stopped', { status: 'cancelled', breaker_stage: 'stop' }),
    ] }))
    assert.deepEqual(result.rows[0].suspendedRunIds, ['budget-boundary'])
    assert.equal(budgetDestinationAvailable(result, {
      kind: 'suspension', missionId: 'mission-a', runId: 'budget-boundary',
    }), true)
    assert.equal(budgetDestinationAvailable(result, {
      kind: 'suspension', missionId: 'mission-a', runId: 'ordinary-failure',
    }), false)
  })
}

test('suspension inspection follows the recorded breaker through termination and a later resume', () => {
  const snapshot = fixture({ tasks: [task('task-a', { attempt_count: 2 })], runs: [
    run('original', { status: 'running', breaker_stage: 'suspend', provider_session_id: null }),
  ] })
  assert.deepEqual(project(snapshot).rows[0].suspendedRunIds, ['original'])
  snapshot.runs[0].status = 'cancelled'
  snapshot.runs[0].workspace_disposition = 'preserved'
  snapshot.runs[0].provider_session_id = 'recorded-session'
  snapshot.runs.push(run('resumed', { status: 'running', breaker_stage: 'healthy', resumed_from_run_id: 'original' }))
  const result = project(snapshot)
  assert.deepEqual(result.rows[0].suspendedRunIds, ['original'])
  assert.equal(result.rows[0].missingHistory, false)
  assert.equal(result.rows[0].resumedRunCount, 1)
  assert.equal(budgetDestinationAvailable(result, { kind: 'suspension', missionId: 'mission-a', runId: 'resumed' }), false)
  // History inspection does not decide whether an existing recovery control may run.
  assert.equal(Object.hasOwn(result.rows[0], 'canResume'), false)
})
