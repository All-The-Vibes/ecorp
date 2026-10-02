import { isMissionDeadlinePolicy, sameDeadlineInstant, taskDeadlineAt } from './missionDeadline'
import type { MissionDeadlineDraft, MissionDeadlineDraftResult, MissionDeadlinePolicy } from './missionDeadline'

export function MissionDeadlineEditor({ draft, result, onChange }: {
  draft: MissionDeadlineDraft
  result: MissionDeadlineDraftResult
  onChange: (draft: MissionDeadlineDraft) => void
}) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return (
    <fieldset className="mission-deadline-editor" data-testid="mission-deadline-editor">
      <legend>Mission deadline (optional)</legend>
      <p id="mission-deadline-help">Leave blank for an untimed mission. Waiting, restarts and verification share this cutoff.</p>
      <div className="loadout-grid">
        <div className="mission-field">
          <label htmlFor="mission-deadline">Deadline in local time ({timezone})</label>
          <input id="mission-deadline" type="datetime-local" step="1" value={draft.deadlineLocal}
            aria-describedby="mission-deadline-help mission-deadline-feedback"
            aria-invalid={Boolean(result.error)}
            onChange={(event) => onChange({ ...draft, deadlineLocal: event.target.value })} />
        </div>
        <div className="mission-field">
          <label htmlFor="mission-reserve-seconds">Reserve seconds (optional)</label>
          <input id="mission-reserve-seconds" type="text" inputMode="numeric" value={draft.reserveSeconds}
            aria-describedby="mission-reserve-help mission-deadline-feedback"
            onChange={(event) => onChange({ ...draft, reserveSeconds: event.target.value })} />
        </div>
        <div className="mission-field">
          <label htmlFor="mission-reserve-keys">Protected task keys, one per line</label>
          <textarea id="mission-reserve-keys" rows={3} value={draft.reserveTaskKeys}
            aria-describedby="mission-reserve-help mission-deadline-feedback"
            onChange={(event) => onChange({ ...draft, reserveTaskKeys: event.target.value })} />
        </div>
      </div>
      <p id="mission-reserve-help">Use exact keys from the allocation preview. A reserve must protect every later stage that depends on those tasks and leave time for earlier work. The server checks the task graph.</p>
      <p id="mission-deadline-feedback" className={result.error ? 'contract-error' : 'operations-approval-note'}>
        {result.error ?? (result.policy ? `Absolute cutoff: ${result.policy.deadline_at}.` : 'No deadline or reserve is supplied by default.')}
      </p>
    </fieldset>
  )
}

export function MissionDeadlineReadback({ deadline, heading = 'Saved mission deadline', taskKey, contractDeadline }: {
  deadline: MissionDeadlinePolicy | null | undefined
  heading?: string
  taskKey?: string
  contractDeadline?: string | null
}) {
  if (!deadline) return (
    <p data-testid="mission-deadline-readback" data-deadline-state="untimed">
      {contractDeadline ? <>Task contract deadline: <time dateTime={contractDeadline}>{contractDeadline}</time>.</> : 'No mission deadline declared.'}
    </p>
  )
  if (!isMissionDeadlinePolicy(deadline)) return (
    <p role="alert" data-testid="mission-deadline-readback" data-deadline-state="unknown">Saved deadline policy is unavailable. Refresh the mission before relying on its time allowance.</p>
  )
  if (taskKey !== undefined && !sameDeadlineInstant(contractDeadline, deadline.deadline_at)) return (
    <p role="alert" data-testid="mission-deadline-readback" data-deadline-state="mismatch">Saved mission deadline and task contract do not agree. Refresh the mission before relying on its time allowance.</p>
  )
  const earlierDeadline = deadline.reserve ? taskDeadlineAt(deadline, '') : null
  return (
    <div className="mission-deadline-readback" data-testid="mission-deadline-readback" data-deadline-state="saved"
      data-mission-deadline={deadline.deadline_at} data-task-deadline={taskKey === undefined ? undefined : taskDeadlineAt(deadline, taskKey)}>
      <p><strong>{heading}:</strong> <time dateTime={deadline.deadline_at}>{deadline.deadline_at}</time></p>
      {taskKey !== undefined ? <p>Task allowance ends: <time dateTime={taskDeadlineAt(deadline, taskKey)}>{taskDeadlineAt(deadline, taskKey)}</time>.</p> : null}
      {deadline.reserve ? <p>{deadline.reserve.seconds} seconds reserved for <code>{deadline.reserve.task_keys.join(', ')}</code>. Earlier tasks and their verification must finish by <time dateTime={earlierDeadline ?? undefined}>{earlierDeadline}</time>.</p> : null}
      <p className="operations-approval-note">Waiting, restarts and verification use this same deadline. The saved task and run states report the outcome.</p>
    </div>
  )
}
