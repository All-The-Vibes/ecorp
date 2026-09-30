// A read-only projection of the existing mission/run ledger. Pending revisions
// are requests, never additional authority. No pricing or grant policy lives here.
type Scoped = { id: string; corp_id: string }
export type BudgetMission = Scoped & {
  room_id: string; title: string; status: string
  original_budget_tokens: number; original_budget_cost_microusd: number
  budget_tokens: number; budget_cost_microusd: number
}
type BudgetTask = Scoped & { mission_id: string; attempt_count: number }
type BudgetRun = Scoped & {
  task_id: string; agent_id: string; status: string; breaker_stage: string | null
  resumed_from_run_id: string | null
  input_tokens: number; output_tokens: number; cost_microusd: number
}
export type BudgetRevision = Scoped & {
  mission_id: string; status: string; version: number
  proposed_budget_tokens: number; proposed_budget_cost_microusd: number
}
export type BudgetSnapshot = {
  corp: { id: string; name: string }
  rooms: readonly Scoped[]
  missions: readonly BudgetMission[]
  tasks: readonly BudgetTask[]
  runs: readonly BudgetRun[]
  mission_budget_revisions: readonly BudgetRevision[]
}
export type BudgetSnapshotStamp = {
  corpId: string; actorId: string; receivedAt: string | null
  connection: 'live' | 'connecting' | 'offline'; refreshFailed: boolean
}
export type BudgetViewer = { corpId: string; actorId: string }
type Amount = bigint | null
type Authority = { tokens: Amount; cost: Amount }
export type BudgetRow = {
  mission: BudgetMission
  original: Authority; current: Authority; consumed: Authority; remaining: Authority
  runCount: number; workerCount: number; resumedRunCount: number
  reportedCostRuns: number; unpricedRuns: number; unreportedRuns: number
  missingHistory: boolean; invalidUsage: boolean; currentDecisionMissing: boolean
  revisions: BudgetRevision[]; pending: BudgetRevision[]; suspendedRunIds: string[]
}
export type BudgetOverview = {
  state: 'current' | 'stale' | 'unavailable'; reason: string
  rows: BudgetRow[]; unattributedRuns: number
  totals: { original: Authority; current: Authority; consumed: Authority; remaining: Authority } | null
}
export type BudgetDestination =
  | { kind: 'budget'; missionId: string }
  | { kind: 'revision'; missionId: string; revisionId: string }
  | { kind: 'suspension'; missionId: string; runId: string }

// A display freshness limit, not a spending threshold or authorization policy.
export const BUDGET_SNAPSHOT_FRESH_MS = 60_000

function amount(value: number): Amount {
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
}
function sum(values: Amount[]): Amount {
  return values.some((value) => value === null)
    ? null : values.reduce<bigint>((total, value) => total + (value as bigint), 0n)
}
function subtract(limit: Amount, used: Amount): Amount {
  return limit === null || used === null ? null : limit - used
}
export function budgetAuthority(tokens: number, cost: number): Authority {
  return { tokens: amount(tokens), cost: amount(cost) }
}

function unique<T extends Scoped>(records: readonly T[], corpId: string): T[] | null {
  const byId = new Map<string, T>()
  for (const record of records) {
    if (record.corp_id !== corpId) continue
    const previous = byId.get(record.id)
    // Identical duplicate rows contribute once. Conflicting copies must not
    // silently choose the smaller spend or the larger authorization ceiling.
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) return null
    byId.set(record.id, record)
  }
  return [...byId.values()]
}

function groupBy<T>(records: readonly T[], key: (record: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const record of records) {
    const id = key(record)
    const group = groups.get(id)
    if (group) group.push(record)
    else groups.set(id, [record])
  }
  return groups
}

export function buildBudgetOverview(
  snapshot: BudgetSnapshot, viewer: BudgetViewer, stamp: BudgetSnapshotStamp, now: number,
): BudgetOverview {
  const unavailable = (reason: string, state: BudgetOverview['state'] = 'unavailable'): BudgetOverview =>
    ({ state, reason, rows: [], totals: null, unattributedRuns: 0 })
  if (!viewer.corpId || !viewer.actorId || snapshot.corp.id !== viewer.corpId ||
      stamp.corpId !== viewer.corpId || stamp.actorId !== viewer.actorId) {
    return unavailable('The snapshot does not belong to the current Corp and viewer. Refresh to read budgets.')
  }
  if (stamp.refreshFailed) return unavailable('The authorized snapshot could not be refreshed. Budget details are hidden until access is confirmed.')
  const received = Date.parse(stamp.receivedAt ?? '')
  if (!Number.isFinite(received) || !Number.isFinite(now) || received > now) {
    return unavailable('Snapshot receipt time is unavailable. Refresh to read budgets.')
  }
  if (stamp.connection !== 'live' || now - received >= BUDGET_SNAPSHOT_FRESH_MS) {
    return unavailable('Budget data is stale. Reconnect or refresh before inspecting current authority.', 'stale')
  }
  const rooms = unique(snapshot.rooms, viewer.corpId)
  const missions = unique(snapshot.missions, viewer.corpId)
  const tasks = unique(snapshot.tasks, viewer.corpId)
  const runs = unique(snapshot.runs, viewer.corpId)
  const revisions = unique(snapshot.mission_budget_revisions, viewer.corpId)
  if (!rooms || !missions || !tasks || !runs || !revisions) {
    return unavailable('The snapshot contains conflicting records. Refresh before reading totals.')
  }
  const roomIds = new Set(rooms.map((room) => room.id))
  const visibleMissions = missions.filter((mission) => roomIds.has(mission.room_id))
  const missionIds = new Set(visibleMissions.map((mission) => mission.id))
  const visibleTasks = tasks.filter((task) => missionIds.has(task.mission_id))
  const taskIds = new Set(visibleTasks.map((task) => task.id))
  const visibleRuns = runs.filter((run) => taskIds.has(run.task_id))
  const runById = new Map(visibleRuns.map((run) => [run.id, run]))
  const tasksByMission = groupBy(visibleTasks, (task) => task.mission_id)
  const runsByTask = groupBy(visibleRuns, (run) => run.task_id)
  const revisionsByMission = groupBy(revisions, (revision) => revision.mission_id)
  const unattributedRuns = runs.length - visibleRuns.length
  const rows = visibleMissions.map((mission): BudgetRow => {
    const missionTasks = tasksByMission.get(mission.id) ?? []
    const missionRuns = missionTasks.flatMap((task) => runsByTask.get(task.id) ?? [])
    const recordedRevisions = (revisionsByMission.get(mission.id) ?? [])
      .toSorted((left, right) => right.version - left.version || left.id.localeCompare(right.id))
    const original = budgetAuthority(mission.original_budget_tokens, mission.original_budget_cost_microusd)
    const current = budgetAuthority(mission.budget_tokens, mission.budget_cost_microusd)
    const consumed = {
      tokens: sum(missionRuns.flatMap((run) => [amount(run.input_tokens), amount(run.output_tokens)])),
      cost: sum(missionRuns.map((run) => amount(run.cost_microusd))),
    }
    const invalidUsage = consumed.tokens === null || consumed.cost === null
    const missingHistory = missionTasks.some((task) => !Number.isSafeInteger(task.attempt_count) ||
      task.attempt_count < 0 || task.attempt_count > (runsByTask.get(task.id)?.length ?? 0)) ||
      missionRuns.some((run) => run.resumed_from_run_id !== null &&
        runById.get(run.resumed_from_run_id)?.task_id !== run.task_id)
    const remaining = missingHistory || unattributedRuns > 0
      ? { tokens: null, cost: null }
      : { tokens: subtract(current.tokens, consumed.tokens), cost: subtract(current.cost, consumed.cost) }
    const revised = mission.budget_tokens !== mission.original_budget_tokens ||
      mission.budget_cost_microusd !== mission.original_budget_cost_microusd
    return {
      mission, original, current, consumed, remaining, missingHistory, invalidUsage,
      currentDecisionMissing: revised && !recordedRevisions.some((revision) => revision.status === 'approved' &&
        revision.proposed_budget_tokens === mission.budget_tokens &&
        revision.proposed_budget_cost_microusd === mission.budget_cost_microusd),
      runCount: missionRuns.length, workerCount: new Set(missionRuns.map((run) => run.agent_id)).size,
      resumedRunCount: missionRuns.filter((run) => run.resumed_from_run_id !== null).length,
      reportedCostRuns: missionRuns.filter((run) => run.cost_microusd > 0).length,
      unpricedRuns: missionRuns.filter((run) => run.cost_microusd === 0 &&
        (run.input_tokens > 0 || run.output_tokens > 0)).length,
      unreportedRuns: missionRuns.filter((run) => run.cost_microusd === 0 &&
        run.input_tokens === 0 && run.output_tokens === 0).length,
      revisions: recordedRevisions, pending: recordedRevisions.filter((revision) => revision.status === 'pending'),
      // Suspension is a persisted breaker stage, not a run status. The runner
      // terminates these runs as failed/cancelled. Keep the original record
      // inspectable through termination and later resumes; existing controls
      // and server policy decide whether recovery is currently authorized.
      suspendedRunIds: missionRuns.filter((run) => run.breaker_stage === 'suspend').map((run) => run.id),
    }
  }).toSorted((left, right) => Number(right.pending.length > 0) - Number(left.pending.length > 0) ||
    Number(right.suspendedRunIds.length > 0) - Number(left.suspendedRunIds.length > 0) ||
    left.mission.title.localeCompare(right.mission.title) || left.mission.id.localeCompare(right.mission.id))
  const total = (field: 'original' | 'current' | 'consumed' | 'remaining'): Authority =>
    unattributedRuns > 0 && (field === 'consumed' || field === 'remaining')
      ? { tokens: null, cost: null }
      : { tokens: sum(rows.map((row) => row[field].tokens)), cost: sum(rows.map((row) => row[field].cost)) }
  return {
    state: 'current', reason: '', rows, unattributedRuns,
    totals: { original: total('original'), current: total('current'), consumed: total('consumed'), remaining: total('remaining') },
  }
}

// Call against a freshly computed projection at activation time. A stale row or
// an ID from another mission must never choose a substitute decision or run.
export function budgetDestinationAvailable(overview: BudgetOverview, target: BudgetDestination): boolean {
  if (overview.state !== 'current') return false
  const row = overview.rows.find((item) => item.mission.id === target.missionId)
  if (!row) return false
  if (target.kind === 'revision') return row.revisions.some((revision) => revision.id === target.revisionId)
  if (target.kind === 'suspension') return row.suspendedRunIds.includes(target.runId)
  return true
}

export function formatBudgetTokens(value: Amount): string {
  return value === null ? 'Unavailable' : `${value.toLocaleString('en-US')} tokens`
}

export function formatBudgetMoney(value: Amount): string {
  if (value === null) return 'Unavailable'
  const absolute = value < 0n ? -value : value
  // Preserve recorded microdollars, including amounts below one cent. This is
  // ledger precision, never a claim that provider billing was measured.
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')
  return `${value < 0n ? '-' : ''}$${(absolute / 1_000_000n).toLocaleString('en-US')}.${fraction}`
}
