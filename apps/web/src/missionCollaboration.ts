import { isProviderLiveRun, pendingReviewForRun, reviewBlockedReason } from './workflowContext.ts'
import type { RunnerNode } from './missionRuntime.ts'

type Person = { id: string; name: string; kind: string; role: string }
type Mission = { id: string; room_id: string; requested_by: string }
type Task = { id: string; mission_id: string; title: string; assigned_agent_id: string | null; status: string }
type Run = { id: string; task_id: string; agent_id: string; runner_id: string; status: string; execution_mode?: string }
type Agent = { id: string; name: string; adapter: string; current_run_id: string | null }
type Lease = { agent_id: string; actor_id: string; expires_at: string }
type Review = {
  run_id: string; task_id: string; status: string; decided_by: string | null
  gate: { type: string; roles: string[]; exclude_requester?: boolean }
}

export type CollaborationInput = {
  corpId: string
  mission: Mission
  actor: Person
  actors: readonly Person[]
  tasks: readonly Task[]
  runs: readonly Run[]
  agents: readonly Agent[]
  runners: readonly RunnerNode[]
  leases: readonly Lease[]
  reviews: readonly Review[]
  connection: 'live' | 'connecting' | 'offline'
  now: number
}

export function selectCollaborationMission<T extends { id: string }>(
  missions: readonly T[], selectedId: string | null,
): T | undefined {
  // Only an unselected view may choose a default. Revocation or a bounded
  // snapshot dropping an explicit selection must not redirect its discussion.
  return selectedId === null ? missions[0] : missions.find((mission) => mission.id === selectedId)
}

// This is a projection of an already-authorized snapshot, not membership,
// presence, assignment or permission authority. Snapshot runs are newest-first.
export function missionCollaboration(input: CollaborationInput) {
  const { mission, actor, actors, connection } = input
  const person = (id: string) => actors.find((entry) => entry.id === id && entry.kind === 'human')
  const requester = person(mission.requested_by)
  const rows = input.tasks.filter((task) => task.mission_id === mission.id).map((task) => {
    const run = input.runs.find((entry) => entry.task_id === task.id)
    const agent = input.agents.find((entry) => entry.id === (run?.agent_id ?? task.assigned_agent_id))
    const runner = run && input.runners.find((entry) => entry.id === run.runner_id && entry.corp_id === input.corpId)
    const review = pendingReviewForRun(run, input.reviews)
    const providerRun = Boolean(run && isProviderLiveRun(run, input.reviews))
    const controlsAvailable = Boolean(connection === 'live' && providerRun && agent?.current_run_id === run?.id && task.assigned_agent_id === agent?.id &&
      runner?.connected && runner.status === 'connected')
    const lease = controlsAvailable && input.leases.find((entry) => entry.agent_id === agent?.id &&
      Number.isFinite(Date.parse(entry.expires_at)) && Date.parse(entry.expires_at) > input.now)
    const controller = lease ? person(lease.actor_id) : undefined
    const runnerState = !run ? 'Not assigned to a runner yet'
      : connection !== 'live' ? 'Runner state unconfirmed while disconnected'
        : !runner ? 'Runner unavailable in this view'
          : runner.status === 'grace' ? 'Runner reconnecting'
            : runner.connected && runner.status === 'connected' ? 'Runner connected'
              : 'Runner offline'
    return {
      taskId: task.id, title: task.title, status: task.status,
      agentId: agent?.id ?? null, agentName: agent?.name ?? 'Assignment unavailable',
      adapter: agent?.adapter ?? null, runId: run?.id ?? null, runStatus: run?.status ?? null,
      runnerState, controlsAvailable,
      control: !controlsAvailable ? 'Live control unavailable'
        : lease ? `Control at snapshot: ${controller?.name ?? 'Another operator'}` : 'No unexpired control lease in this snapshot',
      review: review ? {
        runId: review.run_id,
        label: review.gate.type === 'independent_review' ? 'Independent review needed' : 'Human approval needed',
        roles: review.gate.roles.join(', '),
        blockedReason: reviewBlockedReason(review.gate, actor, mission.requested_by),
      } : null,
    }
  })
  return { requester: requester?.name ?? 'Requester unavailable', rows }
}

export type DiscussionDraft = { body: string; replyToId: string | null; linkValue: string }
export const emptyDiscussionDraft = (): DiscussionDraft => ({ body: '', replyToId: null, linkValue: '' })

// In-memory and viewer/Corp/room/mission scoped. Never persist private discussion
// drafts in a shared browser store, or infer authorization from their existence.
export function saveDiscussionDraft(cache: Map<string, DiscussionDraft>, key: string, draft: DiscussionDraft) {
  if (!draft.body && !draft.replyToId && !draft.linkValue) cache.delete(key)
  else cache.set(key, { ...draft })
}

export function createDiscussionDraftStore() {
  const cache = new Map<string, DiscussionDraft>()
  const empty = emptyDiscussionDraft()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  return {
    get: (key: string) => cache.get(key) ?? empty,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    save: (key: string, draft: DiscussionDraft) => { saveDiscussionDraft(cache, key, draft); notify() },
    complete: (key: string, submitted: DiscussionDraft) => {
      // A late response may acknowledge its own operation, but cannot erase a
      // newer draft, including a same-text edit made after switching surfaces.
      if (cache.get(key) !== submitted) return false
      cache.delete(key); notify(); return true
    },
  }
}
