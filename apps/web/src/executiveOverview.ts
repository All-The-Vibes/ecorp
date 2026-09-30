import { buildBudgetOverview } from './budgetOverview.ts'
import type { BudgetMission, BudgetSnapshot, BudgetSnapshotStamp, BudgetViewer } from './budgetOverview.ts'
import { factoryControllerState, presentFactoryPolling } from './factoryPolling.ts'
import { HISTORY_ENTITY_STATUSES } from './history.ts'
import { presentRunActivity, selectActivityRun } from './runActivity.ts'
import type { RunActivityInput } from './runActivity.ts'

type ExecutiveTask = BudgetSnapshot['tasks'][number] & RunActivityInput['tasks'][number] & {
  status: string; verification_status: string
}
type ExecutiveRun = BudgetSnapshot['runs'][number] & NonNullable<RunActivityInput['run']> & {
  artifact_id?: string | null
}
type IntakeItem = {
  id: string; corp_id: string; mission_id: string | null; state: string; version: number
  source_repository_owner: string; source_repository_name: string
}
export type ExecutiveSnapshot = Omit<BudgetSnapshot, 'missions' | 'tasks' | 'runs'> & {
  missions: readonly (BudgetMission & { description: string })[]
  tasks: readonly ExecutiveTask[]
  runs: readonly ExecutiveRun[]
  agents: RunActivityInput['agents']
  actors: RunActivityInput['actors']
  leases: RunActivityInput['leases']
  events: RunActivityInput['events']
  verification_requests: RunActivityInput['reviews']
  action_approvals: RunActivityInput['approvals']
  verification_evidence: readonly { id: string; run_id: string; task_id: string; status: string }[]
  factory_work_items: readonly IntakeItem[]
  factory_controllers?: readonly { id: string; corp_id: string; status: string; desired_state: string }[]
  pull_request_publications: readonly { id: string; factory_work_item_id: string; version: number }[]
}
export type ExecutiveDestination = {
  kind: 'mission' | 'task' | 'run' | 'artifact'; id: string; missionId: string
}
export type ExecutiveAlert = { key: string; title: string; detail: string; target: ExecutiveDestination }
export const executiveStatus = (value: string) => value.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase())

/** The summary uses the same authorized snapshot and freshness boundary as budgets. */
export function buildExecutiveOverview(
  snapshot: ExecutiveSnapshot, viewer: BudgetViewer, stamp: BudgetSnapshotStamp,
  runners: RunActivityInput['runners'], now: number,
) {
  const budget = buildBudgetOverview(snapshot, viewer, stamp, now)
  const notices: string[] = []
  const missions = budget.rows.map((budgetRow) => {
    const mission = snapshot.missions.find((item) => item.corp_id === viewer.corpId && item.id === budgetRow.mission.id)!
    // The budget reader has already rejected conflicting scoped records.
    const tasks = [...new Map(snapshot.tasks.filter((task) => task.corp_id === viewer.corpId &&
      task.mission_id === mission.id).map((task) => [task.id, task])).values()]
    const taskById = new Map(tasks.map((task) => [task.id, task]))
    const runs = [...new Map(snapshot.runs.filter((run) => run.corp_id === viewer.corpId &&
      taskById.has(run.task_id)).map((run) => [run.id, run])).values()]
    const runById = new Map(runs.map((run) => [run.id, run]))
    const reviews = snapshot.verification_requests.filter((review) => runById.get(review.run_id)?.task_id === review.task_id)
    const approvals = snapshot.action_approvals.filter((approval) => runById.has(approval.run_id))
    const relatedAgents = new Set([...tasks.flatMap((task) => task.assigned_agent_id ? [task.assigned_agent_id] : []),
      ...runs.map((run) => run.agent_id)])
    const agents = [...relatedAgents].flatMap((id) => {
      const candidates = snapshot.agents.filter((agent) => agent.id === id && (!agent.mission_id || agent.mission_id === mission.id))
      return candidates.length === 1 ? candidates : []
    })
    const intake = snapshot.factory_work_items.filter((item) => item.corp_id === viewer.corpId && item.mission_id === mission.id)
    const item = intake.length === 1 ? intake[0] : null
    const input = {
      corpId: viewer.corpId, mission, tasks, agents, runners, actors: snapshot.actors,
      leases: snapshot.leases, events: snapshot.events, reviews, approvals,
      connection: stamp.connection, snapshotReceivedAt: stamp.receivedAt,
      snapshotFailed: stamp.refreshFailed, factoryState: item?.state,
    }
    const activityRun = selectActivityRun(runs, reviews, approvals)
    const activity = presentRunActivity({ ...input, run: activityRun })
    const alerts: ExecutiveAlert[] = []
    const target = (kind: ExecutiveDestination['kind'], id: string): ExecutiveDestination => ({ kind, id, missionId: mission.id })
    const add = (key: string, title: string, detail: string, destination = target('mission', mission.id)) => {
      alerts.push({ key, title, detail, target: destination })
    }
    // Inspect every returned run, including older failures and decisions. Choosing
    // a newer activity record must never erase the earlier run's safety boundary.
    for (const run of runs) {
      const context = presentRunActivity({ ...input, run })
      const task = taskById.get(run.task_id)!
      if (context.tone === 'attention' || context.status === 'State unconfirmed' || run.status === 'waiting_for_input') {
        add(`activity:${run.id}`, `${task.title} · ${context.status}`, context.summary, target('run', run.id))
      }
      const reviewRejected = reviews.some((review) => review.run_id === run.id && review.status === 'rejected')
      const actionRejected = approvals.some((approval) => approval.run_id === run.id && approval.status === 'rejected')
      if (reviewRejected || actionRejected) add(`rejected:${run.id}`, 'A recorded decision was rejected',
        `${task.title}: ${reviewRejected ? 'outcome review' : 'requested action'} rejected. Inspect this exact run before relying on its outcome.`, target('run', run.id))
      if (snapshot.verification_evidence.some((evidence) => evidence.run_id === run.id && evidence.task_id === run.task_id && evidence.status === 'failed')) {
        add(`checks:${run.id}`, 'A failed check remains in the evidence', `${task.title}: inspect the recorded checks and their recovery history.`, target('run', run.id))
      }
      const criticalNotices = context.notices.filter((notice) => !notice.startsWith('This is a recorded run,') &&
        !(notice.startsWith('The selected run’s current agent') && ['completed', 'failed', 'cancelled', 'lost'].includes(run.status)))
      if (criticalNotices.length) add(`notices:${run.id}`, `${task.title} · recorded context`, criticalNotices.join(' '), target('run', run.id))
    }
    for (const task of tasks) {
      const stateKnown = task.status !== 'unknown' && HISTORY_ENTITY_STATUSES.task.includes(task.status)
      if (!stateKnown || ['failed', 'blocked', 'awaiting_approval', 'verification_failed', 'review', 'cancelled'].includes(task.status) || task.verification_status === 'failed') {
        add(`task:${task.id}`, `${task.title} · ${stateKnown ? executiveStatus(task.status) : 'Task state unconfirmed'}`,
          `${stateKnown ? '' : 'The recorded task state is unrecognized. '}Task verification: ${executiveStatus(task.verification_status)}. Inspect the existing task and its exact evidence.`, target('task', task.id))
      }
    }
    const missionStateKnown = mission.status !== 'unknown' && HISTORY_ENTITY_STATUSES.mission.includes(mission.status)
    if (!missionStateKnown) add('mission', 'Mission state unconfirmed',
      'The recorded mission state is unrecognized. Inspect the mission and its exact evidence before relying on its outcome.')
    else if (['failed', 'cancelled'].includes(mission.status)) add('mission', `Mission recorded as ${executiveStatus(mission.status)}`,
      'The recorded mission outcome requires inspection. No completion or replacement work is inferred.')
    if (!tasks.length) add('tasks', 'Task progress unavailable', 'No authorized tasks were returned for this mission. This is not proof that no work exists.')
    if (budgetRow.missingHistory || budgetRow.invalidUsage) add('history', 'Run history or usage is incomplete',
      'The snapshot cannot establish complete progress or spend. Open the existing work and history for evidence.')
    if (budgetRow.remaining.tokens === null || budgetRow.remaining.cost === null) add('authority-unknown', 'Remaining authority is unavailable',
      'Missing ledger data cannot establish permission for more work.')
    else if (budgetRow.remaining.tokens <= 0n || budgetRow.remaining.cost <= 0n) add('exhausted', 'A recorded budget ceiling is exhausted',
      'Inspect the budget and existing recovery or revision controls in Operations. A view change grants no authority.')
    if (budgetRow.pending.length) add('budget-decisions', `${budgetRow.pending.length} budget requests need a decision`,
      'Requested increases are not authorized headroom. The shared budget panel links to the exact revisions.')
    if (budgetRow.unpricedRuns || budgetRow.unreportedRuns) add('cost-unknown', 'Cost assurance is incomplete',
      `${budgetRow.unpricedRuns} runs have unpriced usage; ${budgetRow.unreportedRuns} have no recorded usage or price. Zero reported cost is not proof of free work.`)
    if (budgetRow.currentDecisionMissing) add('budget-receipt', 'Budget approval evidence is unavailable',
      'The revised ceiling has no matching approval receipt in this snapshot.')
    if (item && ['blocked', 'verification_failed', 'failed', 'awaiting_approval'].includes(item.state)) add('intake', `Intake recorded as ${executiveStatus(item.state)}`,
      'Inspect the owning mission and its existing decision or recovery controls.')
    if (intake.length > 1) add('intake-ambiguous', 'Result attribution is unavailable', 'More than one intake record claims this mission; no publication link has been inferred.')
    const taskCounts = new Map<string, number>()
    for (const task of tasks) taskCounts.set(task.status, (taskCounts.get(task.status) ?? 0) + 1)
    return {
      mission, tasks, runs, activity, activityRun, alerts, item,
      publicationRevision: snapshot.pull_request_publications.filter((publication) => publication.factory_work_item_id === item?.id)
        .map((publication) => `${publication.id}:${publication.version}`).join(','),
      taskCounts: [...taskCounts].map(([status, count]) => ({ status, count })),
      team: [...new Set(agents.map((agent) => agent.name))],
      teamIncomplete: agents.length !== relatedAgents.size || tasks.some((task) => !task.assigned_agent_id),
    }
  })
  if (budget.state === 'current') {
    const missionIds = new Set(missions.map((row) => row.mission.id))
    if (snapshot.factory_work_items.some((item) => item.corp_id === viewer.corpId && (!item.mission_id || !missionIds.has(item.mission_id)))) {
      notices.push('Some intake records have no authorized mission in this snapshot. Their progress and blockers are unavailable here; inspect Factory in Operations.')
    }
    for (const controller of snapshot.factory_controllers ?? []) {
      if (controller.corp_id !== viewer.corpId) continue
      const state = factoryControllerState(controller)
      if (!['watching', 'working'].includes(state)) {
        const polling = presentFactoryPolling(controller, now)
        notices.push(`Factory intake: ${executiveStatus(state)}. ${polling ? `${polling.reason} ${polling.retryMessage}` : 'Inspect the controller and existing recovery controls in Operations.'}`)
      }
    }
  }
  return { state: budget.state, reason: budget.reason, missions, notices }
}

export type ExecutiveOverview = ReturnType<typeof buildExecutiveOverview>
export type ExecutiveMission = ExecutiveOverview['missions'][number]

/** Validate exact ancestry again at activation; never choose a nearby result. */
export function executiveDestinationAvailable(overview: ExecutiveOverview, target: ExecutiveDestination): boolean {
  if (overview.state !== 'current') return false
  const row = overview.missions.find((candidate) => candidate.mission.id === target.missionId)
  if (!row) return false
  if (target.kind === 'mission') return row.mission.id === target.id
  if (target.kind === 'task') return row.tasks.some((task) => task.id === target.id)
  if (target.kind === 'run') return row.runs.some((run) => run.id === target.id)
  return row.runs.filter((run) => run.artifact_id === target.id).length === 1
}
