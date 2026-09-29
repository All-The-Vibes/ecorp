import { isProviderLiveRun, pendingReviewForRun, selectMissionEvidenceRun } from './workflowContext.ts'

type ActivityRun = {
  id: string; task_id: string; agent_id: string; runner_id: string; status: string
  execution_mode?: string | null; breaker_stage?: string | null
  workspace_disposition?: string | null; verification_status?: string | null
}
type ActivityEvent = {
  id: string; seq: number; type: string; aggregate_type: string; aggregate_id: string
  created_at: string; payload: Record<string, unknown>; corp_id?: string; room_id?: string | null
}
type ActivityMission = { id: string; room_id: string; status: string }
type ActivityTask = { id: string; mission_id: string; title: string; assigned_agent_id: string | null }
type ActivityAgent = { id: string; name: string; adapter: string; current_run_id: string | null; mission_id?: string | null; retired_at?: string | null }
export type RunActivityInput = {
  corpId: string
  mission?: ActivityMission
  run?: ActivityRun
  selectionUnavailable?: boolean
  tasks: readonly ActivityTask[]
  agents: readonly ActivityAgent[]
  runners: readonly { id: string; corp_id: string; connected: boolean; status: string; last_seen_at: string }[]
  actors: readonly { id: string; name: string }[]
  leases: readonly { agent_id: string; actor_id: string; expires_at: string }[]
  events: readonly ActivityEvent[]
  reviews: readonly { run_id: string; task_id: string; status: string }[]
  approvals: readonly { run_id: string; status: string }[]
  connection: string
  snapshotReceivedAt: string | null
  snapshotFailed?: boolean
  factoryState?: string
}
export type RunActivityPresentation = {
  runId: string | null
  providerCurrent: boolean
  heading: string
  status: string
  tone: 'neutral' | 'working' | 'attention' | 'success'
  summary: string
  notices: string[]
  facts: { label: string; value: string; detail?: string }[]
  latest: { label: string; at: string } | null
  timeline: { id: string; label: string; at: string }[]
  context: { label: string; value: string }[]
}

const terminal = new Set(['completed', 'failed', 'cancelled', 'lost'])
const eventLabels: Record<string, string> = {
  'run.requested': 'Run requested', 'run.started': 'Run started',
  'run.output': 'Provider output recorded', 'run.status': 'Provider status updated',
  'run.usage': 'Usage recorded', 'run.approval_requested': 'Action approval requested',
  'run.verifying': 'Verification started', 'run.verification_started': 'Verification started',
  'run.verification_evidence': 'Verification evidence recorded',
  'run.verification_passed': 'Automated verification passed',
  'run.verification_failed': 'Verification failed',
  'run.verification_requested': 'Outcome review requested',
  'run.verification_waiting': 'Outcome review pending',
  'run.awaiting_approval': 'Outcome review requested',
  'run.completed': 'Run completed', 'run.failed': 'Run failed',
  'run.cancelled': 'Run cancelled', 'run.lost': 'Runner loss recorded',
  'run.reconciled': 'Run reconciled after reconnect',
  'run.workspace_preserved': 'Workspace retained', 'run.workspace_removed': 'Workspace cleanup recorded',
  'run.teardown_uncertain': 'Provider teardown is unconfirmed',
  'run.breaker_transition': 'Safety boundary recorded',
}
const adapters: Record<string, string> = {
  codex: 'OpenAI Codex', 'github-copilot': 'GitHub Copilot',
  'claude-code': 'Claude Code', opencode: 'OpenCode', 'fake-process': 'Test harness (no AI)',
}
const breakerMetrics: Record<string, string> = {
  run_tokens: 'Run token budget', run_cost: 'Run cost budget',
  mission_tokens: 'Mission token budget', mission_cost: 'Mission cost budget',
  actor_tokens_24h: 'Actor daily token budget', actor_cost_24h: 'Actor daily cost budget',
  corp_tokens_24h: 'Corp daily token budget', corp_cost_24h: 'Corp daily cost budget',
  no_progress: 'No-progress limit', repeated_tool: 'Repeated-tool limit',
}

/** Reuse evidence-review priority, then reveal an exact tool-approval wait before unrelated newer work. */
export function selectActivityRun<T extends ActivityRun>(
  runs: readonly T[],
  reviews: readonly { run_id: string; task_id: string; status: string }[],
  approvals: readonly { run_id: string; status: string }[],
): T | undefined {
  const evidenceRun = selectMissionEvidenceRun([...runs], [...reviews])
  if (evidenceRun && pendingReviewForRun(evidenceRun, [...reviews])) return evidenceRun
  return runs.find((run) => run.status === 'waiting_for_approval' &&
    approvals.some((approval) => approval.run_id === run.id && approval.status === 'pending')) ?? evidenceRun
}

/** An exact current pointer never falls back after revocation or a bounded snapshot. */
export function selectAgentActivity<T extends ActivityRun, M extends ActivityMission>(input: {
  agent: ActivityAgent; tasks: readonly ActivityTask[]; missions: readonly M[]; runs: readonly T[]
  reviews: RunActivityInput['reviews']; approvals: RunActivityInput['approvals']
}): { run?: T; mission?: M; selectionUnavailable: boolean } {
  const { agent } = input
  const missionFor = (run: T) => {
    if (run.agent_id !== agent.id) return undefined
    const tasks = input.tasks.filter((task) => task.id === run.task_id)
    if (tasks.length !== 1 || (agent.current_run_id && tasks[0].assigned_agent_id !== agent.id)) return undefined
    const missions = input.missions.filter((mission) => mission.id === tasks[0].mission_id)
    if (missions.length !== 1 || (agent.mission_id && missions[0].id !== agent.mission_id)) return undefined
    return missions[0]
  }
  if (agent.current_run_id) {
    const runs = input.runs.filter((run) => run.id === agent.current_run_id)
    const run = runs.length === 1 ? runs[0] : undefined
    const mission = run && missionFor(run)
    return mission ? { run, mission, selectionUnavailable: false } : { selectionUnavailable: true }
  }
  // Snapshot runs are newest-first. Retain the native exact-review priority;
  // a recorded run without a current pointer cannot establish provider control.
  const run = selectActivityRun(input.runs.filter((candidate) => missionFor(candidate)), input.reviews, input.approvals)
  return { run, mission: run && missionFor(run), selectionUnavailable: false }
}

function validTime(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
export function activityTime(value: string): string {
  const parsed = validTime(value)
  return parsed === null ? 'Time unavailable' : new Date(parsed).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  })
}
function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase())
}
function duration(ms: number): string {
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`
}
function eventLabel(event: ActivityEvent): string | null {
  // Provider text, tool signatures, arguments and raw payloads never enter this view.
  if (event.type === 'run.session_terminated') {
    return event.payload?.provider_process_alive === false
      ? 'Provider termination confirmed' : 'Provider termination report received'
  }
  if (event.type === 'run.tool_activity') {
    return event.payload?.human_conversation === true ? 'Human conversation recorded'
      : event.payload?.progressed === true ? 'Tool activity reported progress' : 'Tool activity recorded'
  }
  return Object.hasOwn(eventLabels, event.type) ? eventLabels[event.type] : null
}

/** A read-only projection of one selected, already-authorized snapshot context. */
export function presentRunActivity(input: RunActivityInput): RunActivityPresentation {
  const { mission, run } = input
  const received = validTime(input.snapshotReceivedAt)
  const fresh = input.connection === 'live' && !input.snapshotFailed && received !== null
  const view: RunActivityPresentation = {
    runId: null, providerCurrent: false, heading: 'Waiting for a run', status: 'No run in view', tone: 'neutral',
    summary: 'This snapshot contains no selected run. A missing run is not proof that work never started.',
    notices: [], facts: [], latest: null, timeline: [],
    context: [
      ...(input.factoryState ? [{ label: 'Intake record', value: label(input.factoryState) }] : []),
      ...(mission ? [{ label: 'Mission record', value: label(mission.status) }] : []),
    ],
  }
  if (!fresh) view.notices.push(input.snapshotFailed
    ? 'The last snapshot refresh failed. These are retained observations, not confirmed current execution.'
    : 'Live updates are unavailable. The runner can continue independently; reconnect before relying on current activity.')
  const snapshotFact = {
    label: 'Snapshot received', value: input.snapshotReceivedAt && received !== null
      ? activityTime(input.snapshotReceivedAt) : 'Not recorded',
    detail: fresh ? 'Live event stream connected; this is a snapshot, not a new process probe.'
      : input.snapshotFailed ? 'Refresh failed; retained snapshot.' : 'Current state unconfirmed.',
  }
  view.facts.push(snapshotFact)
  if (input.selectionUnavailable || (run && !mission)) return {
    ...view, heading: 'Run context unavailable', status: 'Context unconfirmed', tone: 'attention',
    summary: 'The exact selected run and its authorized context are unavailable in this snapshot. No alternative run has been selected.',
  }
  if (!run || !mission) return view
  const tasks = input.tasks.filter((task) => task.id === run.task_id)
  if (tasks.length !== 1 || tasks[0].mission_id !== mission.id) return {
    ...view, heading: 'Run context unavailable', status: 'Context unconfirmed', tone: 'attention',
    summary: 'The selected run does not have one matching task in this mission. No alternative run has been selected.',
  }
  view.runId = run.id
  const runners = input.runners.filter((node) => node.id === run.runner_id && node.corp_id === input.corpId)
  const runner = runners.length === 1 ? runners[0] : undefined
  const agents = input.agents.filter((candidate) => candidate.id === run.agent_id)
  const agent = agents.length === 1 ? agents[0] : undefined
  const currentOwner = Boolean(agent && agent.retired_at == null && agent.current_run_id === run.id && tasks[0].assigned_agent_id === agent.id &&
    (!agent.mission_id || agent.mission_id === mission.id))
  const pendingReview = Boolean(pendingReviewForRun(run, input.reviews))
  const pendingAction = !terminal.has(run.status) && input.approvals.some((approval) =>
    approval.run_id === run.id && approval.status === 'pending')
  if (terminal.has(run.status) && input.reviews.some((review) =>
    review.run_id === run.id && review.task_id === run.task_id && review.status === 'pending')) {
    view.notices.push('A pending review record remains for this ended run. It is not an actionable outcome review; inspect the recorded failure and recovery context.')
  }
  const events = input.events.filter((event) => event.aggregate_type === 'run' && event.aggregate_id === run.id &&
    (!event.corp_id || event.corp_id === input.corpId) && (!event.room_id || event.room_id === mission.room_id) &&
    Number.isSafeInteger(event.seq) && event.seq >= 0 && validTime(event.created_at) !== null)
    .toSorted((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
  const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()]
    .toSorted((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
  const lastEvent = uniqueEvents.at(-1)
  const termination = uniqueEvents.findLast((event) => event.type === 'run.session_terminated' &&
    event.payload?.provider_process_alive === false)
  const uncertain = uniqueEvents.findLast((event) => event.type === 'run.teardown_uncertain')
  const terminated = Boolean(termination && (!uncertain || termination.seq > uncertain.seq))
  const verifyingOnly = run.execution_mode === 'verification_only'
  const knownMode = !run.execution_mode || run.execution_mode === 'provider' || verifyingOnly
  const reportsProvider = isProviderLiveRun(run, input.reviews) && !terminated && knownMode
  const runnerCurrent = runner?.connected === true && runner.status === 'connected'
  view.providerCurrent = fresh && runnerCurrent && currentOwner && reportsProvider && !uncertain &&
    !terminal.has(mission.status) && run.workspace_disposition !== 'quarantined' &&
    run.breaker_stage !== 'suspend' && run.breaker_stage !== 'stop'
  let execution = 'No active provider reported'
  if (!knownMode) execution = 'Execution mode unrecognized'
  else if (verifyingOnly) execution = 'Verifier-only run; no provider'
  else if (terminated) execution = 'Provider termination confirmed'
  else if (run.status === 'lost' || uncertain) execution = 'Provider termination unconfirmed'
  else if (pendingReview) execution = 'Outcome review pending; no provider run reported'
  else if (reportsProvider) execution = view.providerCurrent
    ? run.status === 'provisioning' ? 'Preparing a provider run' : run.status === 'starting' ? 'Provider starting' : 'Provider run reported active'
    : 'Last reported active; current execution unconfirmed'
  else if (terminal.has(run.status)) execution = `${label(run.status)} run; termination receipt not in this snapshot`
  else if (run.status === 'verifying') execution = 'Verification in progress; provider not reported active'
  else execution = 'Execution state unconfirmed'

  if (!fresh) {
    view.heading = 'Inspect the last reported state'; view.status = 'Updates unavailable'; view.tone = 'attention'
    view.summary = 'The retained run and evidence are still available. A disconnected browser does not mean the mission stopped.'
  } else if (run.workspace_disposition === 'quarantined') {
    view.heading = 'Source needs a safety review'; view.status = 'Quarantined'; view.tone = 'attention'
    view.summary = 'Source integrity is quarantined. Inspect the existing recovery record; do not restart or replace this work.'
  } else if (run.breaker_stage === 'stop') {
    view.heading = 'A safety boundary stopped this run'; view.status = 'Stopped'; view.tone = 'attention'
    view.summary = 'The recorded stop remains effective. Inspect the existing evidence and exact recovery eligibility; ordinary provider resume is not authorized.'
  } else if (run.breaker_stage === 'suspend') {
    view.heading = 'This run is suspended'; view.status = 'Needs attention'; view.tone = 'attention'
    view.summary = 'Inspect remaining budget, the recorded blocker and existing recovery controls before another attempt. Preserved source is not a verified result.'
  } else if (pendingReview) {
    view.heading = 'This outcome needs review'; view.status = 'Awaiting review'; view.tone = 'attention'
    view.summary = 'Inspect this run’s checks and evidence. A recorded check pass is not the required human outcome decision.'
  } else if (pendingAction) {
    view.heading = 'A requested action needs a decision'; view.status = 'Awaiting decision'; view.tone = 'attention'
    view.summary = 'Inspect the exact requested action, scope and consequence in this work item. Discussion does not authorize it.'
  } else if (run.status === 'waiting_for_approval') {
    view.heading = 'This run is waiting for a decision'; view.status = 'Decision context needed'; view.tone = 'attention'
    view.summary = 'The run reports an approval wait, but its decision record is not in this snapshot. Inspect the exact mission context; no new approval is inferred.'
  } else if (run.status === 'lost' || (!runnerCurrent && reportsProvider) || uncertain && !terminated) {
    view.heading = 'Execution needs confirmation'; view.status = 'State unconfirmed'; view.tone = 'attention'
    view.summary = 'The runner or its teardown is not confirmed. Inspect connection and recovery state instead of starting replacement work.'
  } else if (run.verification_status === 'failed') {
    view.heading = 'Verification needs attention'; view.status = 'Checks failed'; view.tone = 'attention'
    view.summary = 'Inspect the recorded failed checks and existing recovery context. A provider result alone cannot complete this outcome.'
  } else if (run.status === 'completed') {
    view.heading = mission.status === 'completed' ? 'The mission is complete' : 'This run is complete'
    view.status = 'Completed'; view.tone = 'success'
    view.summary = 'Inspect the selected run’s accepted evidence and source result. Completion does not mean publication, merge or deployment.'
  } else if (terminal.has(run.status)) {
    view.heading = 'Inspect the stopped work'; view.status = label(run.status); view.tone = 'attention'
    view.summary = 'This run ended without an accepted outcome. Its failure and recovery records remain available; no new work has been started.'
  } else if (run.status === 'verifying' || verifyingOnly) {
    view.heading = 'The runner is checking the work'; view.status = 'Verifying'
    view.summary = 'Verification is separate from provider execution. Wait for the recorded checks and any required outcome review.'
  } else if (view.providerCurrent) {
    view.heading = run.status === 'waiting_for_input' ? 'This run is waiting for input' : 'Your team is working'; view.status = run.status === 'waiting_for_input' ? 'Waiting for input' : 'Executing'; view.tone = 'working'
    view.summary = 'The selected task has a provider run reported active. Use the existing controls to inspect or direct that work.'
  } else {
    view.heading = 'Inspect the reported run'; view.status = 'State unconfirmed'
    view.summary = 'The available records do not establish current execution. No progress or completion has been inferred.'
  }
  if (run.workspace_disposition === 'quarantined') view.notices.push('Source quarantine is recorded. Do not replace or resume the retained work through an ordinary action.')
  if (run.breaker_stage === 'stop') view.notices.push('A stop-stage safety boundary is recorded; ordinary provider resume is not authorized.')
  if (input.factoryState === 'running' && terminal.has(run.status) && terminal.has(mission.status)) {
    view.notices.push(`The intake record says Running, while the mission is ${label(mission.status)} and this run is ${label(run.status)}. Intake state is not proof of an active provider.`)
  }
  if (!knownMode) view.notices.push('This run reports an unsupported execution mode; provider activity is not inferred.')
  if (run.breaker_stage === 'constrain') view.notices.push('A safety constraint was recorded for this run. Its current outcome and decision records are shown separately below.')
  if (agent && agent.current_run_id !== run.id) view.notices.push('This is a recorded run, not the agent’s current run. Its history does not establish current execution or control.')
  else if (!currentOwner) view.notices.push('The selected run’s current agent and task assignment cannot be confirmed. Current execution and control remain unconfirmed.')
  if (terminal.has(mission.status) && !terminal.has(run.status)) view.notices.push('The mission has ended while this run retains an unfinished state. Inspect its recorded recovery context; current provider execution is not established.')
  const lease = input.leases.find((candidate) => candidate.agent_id === run.agent_id && received !== null &&
    (validTime(candidate.expires_at) ?? 0) > received)
  const control = view.providerCurrent
    ? lease ? `Control at snapshot: ${input.actors.find((actor) => actor.id === lease.actor_id)?.name ?? 'another operator'}.`
      : 'No unexpired control lease in this snapshot.' : 'Current control is not asserted from this record.'
  const boundary = uniqueEvents.findLast((event) => event.type === 'run.breaker_transition')
  const boundaryInput = boundary?.payload?.input
  const metric = boundaryInput && typeof boundaryInput === 'object' && 'metric' in boundaryInput ? boundaryInput.metric : null
  const boundaryReason = boundary?.payload?.stage === run.breaker_stage && typeof metric === 'string' && Object.hasOwn(breakerMetrics, metric)
    ? breakerMetrics[metric] : 'Safety boundary reason unavailable'
  const blocker = run.workspace_disposition === 'quarantined' ? 'Source integrity quarantine'
    : ['suspend', 'stop'].includes(run.breaker_stage ?? '') ? `${boundaryReason} · ${label(run.breaker_stage!)}`
    : pendingReview ? 'Human outcome review pending'
    : pendingAction ? 'Requested action approval pending'
    : run.status === 'waiting_for_approval' ? 'Decision record unavailable'
    : run.status === 'waiting_for_input' ? 'Provider input requested'
    : run.verification_status === 'failed' ? 'Recorded verification failed'
    : run.status === 'lost' || (uncertain && !terminated) ? 'Provider termination unconfirmed'
    : !fresh ? 'Live updates unavailable; current blocker unconfirmed'
    : reportsProvider && !runnerCurrent ? runner?.status === 'grace' ? 'Runner reconnecting' : 'Runner unavailable'
    : reportsProvider && !view.providerCurrent ? 'Current run assignment or mission state unconfirmed'
    : terminal.has(run.status) ? `${label(run.status)} run; inspect recorded evidence`
    : run.status === 'verifying' || verifyingOnly ? 'Verification in progress'
    : run.breaker_stage === 'constrain' ? `${boundaryReason} · Constrain`
    : 'No blocker reported in this snapshot'
  view.facts = [
    { label: 'Task in focus', value: tasks[0].title, detail: `Selected run ${run.id.slice(0, 8)}.` },
    { label: 'Assigned agent', value: agent ? `${agent.name} · ${Object.hasOwn(adapters, agent.adapter) ? adapters[agent.adapter] : 'Runtime not recognized'}` : 'Agent attribution unavailable', detail: control },
    { label: 'Provider execution', value: execution, detail: runner
      ? `Runner: ${label(runner.status)}${validTime(runner.last_seen_at) !== null ? ` · last seen ${activityTime(runner.last_seen_at)}` : ''}.`
      : 'Assigned runner is not in this snapshot.' },
    { label: 'Execution blocker', value: blocker }, snapshotFact,
  ]
  view.timeline = uniqueEvents.flatMap((event) => {
    const text = eventLabel(event)
    return text ? [{ id: event.id, label: text, at: event.created_at }] : []
  }).slice(-5).reverse()
  view.latest = lastEvent ? { label: eventLabel(lastEvent) ?? 'Run event recorded', at: lastEvent.created_at } : null
  view.context.push({ label: 'Selected run', value: `${run.id} · ${label(run.status)}` })
  const start = uniqueEvents.find((event) => event.type === 'run.started')
  const end = terminated ? termination : terminal.has(run.status)
    ? uniqueEvents.findLast((event) => event.type === `run.${run.status}`) : lastEvent
  if (start && end && end.seq >= start.seq && Date.parse(end.created_at) >= Date.parse(start.created_at)) {
    view.context.push({ label: 'Recorded run interval', value: `${duration(Date.parse(end.created_at) - Date.parse(start.created_at))} through ${activityTime(end.created_at)}; not a live elapsed-time or completion estimate.` })
  } else view.context.push({ label: 'Recorded run interval', value: 'Start/end evidence is not available in this snapshot.' })
  return view
}
