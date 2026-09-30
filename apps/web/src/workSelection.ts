import type { WorkContext, WorkLink } from './workflowContext'
import { isHistoryId } from './history.ts'

export type WorkSelection = { missionId: string; taskId: string | null; runId: string | null }
export type WorkSelectionScope = { server: string; corpId: string; actorId: string }
type SelectionStorage = Pick<Storage, 'getItem' | 'setItem'>
// An invalid or unreadable choice must not be treated as a first visit.
export const UNAVAILABLE_WORK_SELECTION: WorkSelection = { missionId: '', taskId: null, runId: null }

export function workSelectionKey(scope: WorkSelectionScope): string {
  return 'ecorp:work-selection:v1:' + JSON.stringify([scope.server, scope.corpId, scope.actorId])
}
export function validWorkSelection(value: unknown): value is WorkSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const choice = value as Record<string, unknown>
  return Object.keys(choice).length === 3 && isHistoryId(choice.missionId) &&
    (choice.taskId === null || isHistoryId(choice.taskId)) &&
    (choice.runId === null || (isHistoryId(choice.runId) && isHistoryId(choice.taskId)))
}
export function readWorkSelection(storage: () => SelectionStorage, key: string): WorkSelection | null {
  try {
    const value = storage().getItem(key)
    if (value === null) return null
    if (value.length > 256) return UNAVAILABLE_WORK_SELECTION
    const parsed: unknown = JSON.parse(value)
    return validWorkSelection(parsed) ? parsed : UNAVAILABLE_WORK_SELECTION
  } catch { return UNAVAILABLE_WORK_SELECTION }
}
export function rememberWorkSelection(storage: () => SelectionStorage, key: string, choice: WorkSelection): boolean {
  if (!validWorkSelection(choice)) return false
  try {
    // One write persists the entire exact context; no partially saved task/run.
    storage().setItem(key, JSON.stringify(choice))
    return true
  } catch { return false }
}
export function missionWorkSelection(current: WorkSelection | null, missionId: string): WorkSelection {
  return current?.missionId === missionId ? current : { missionId, taskId: null, runId: null }
}
export function workSelectionForLink(
  link: WorkLink, context: WorkContext, current: WorkSelection | null,
): WorkSelection | null {
  if (link.kind === 'mission') return context.missions.some((mission) => mission.id === link.id)
    ? missionWorkSelection(current, link.id) : null
  const run = link.kind === 'run' || link.kind === 'artifact'
    ? context.runs.find((candidate) => link.kind === 'run' ? candidate.id === link.id : candidate.artifact_id === link.id)
    : undefined
  if ((link.kind === 'run' || link.kind === 'artifact') && !run) return null
  const task = context.tasks.find((candidate) => candidate.id === (run?.task_id ?? link.id))
  if (!task || !context.missions.some((mission) => mission.id === task.mission_id)) return null
  return { missionId: task.mission_id, taskId: task.id, runId: run?.id ?? null }
}
