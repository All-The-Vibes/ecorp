export type MissionDeadlinePolicy = {
  deadline_at: string
  reserve?: { seconds: number; task_keys: string[] }
}

export type MissionDeadlineDraft = {
  deadlineLocal: string
  reserveSeconds: string
  reserveTaskKeys: string
}

export const emptyMissionDeadlineDraft = (): MissionDeadlineDraft => ({
  deadlineLocal: '', reserveSeconds: '', reserveTaskKeys: '',
})

export type MissionDeadlineDraftResult = {
  policy: MissionDeadlinePolicy | null
  error: string | null
  admissionClosesAt: number | null
}

/** A datetime-local is a local wall time, never an implicit UTC timestamp. */
function localDeadline(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0))
  if (year < 1) return null
  const date = new Date(0)
  // setFullYear avoids the Date constructor's special treatment of years 0–99.
  date.setFullYear(year, month - 1, day)
  date.setHours(hour, minute, second, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
    date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null
  return date.getTime()
}

/** Client feedback only. The server admits the request against its database clock. */
export function readMissionDeadlineDraft(draft: MissionDeadlineDraft, now: number): MissionDeadlineDraftResult {
  const invalid = (error: string): MissionDeadlineDraftResult => ({ policy: null, error, admissionClosesAt: null })
  const secondsText = draft.reserveSeconds.trim()
  const keysText = draft.reserveTaskKeys.trim()
  if (!draft.deadlineLocal) {
    return secondsText || keysText
      ? invalid('Set a mission deadline before adding a reserve.')
      : { policy: null, error: null, admissionClosesAt: null }
  }
  const deadline = localDeadline(draft.deadlineLocal)
  if (deadline === null) return invalid('Enter a valid local date and time. A skipped daylight-saving time is not a deadline.')
  if (!Number.isFinite(now) || deadline <= now) return invalid('The mission deadline must still be in the future.')
  const policy: MissionDeadlinePolicy = { deadline_at: new Date(deadline).toISOString() }
  if (!secondsText && !keysText) return { policy, error: null, admissionClosesAt: deadline }
  if (!secondsText || !keysText) return invalid('Enter both reserve seconds and protected task keys, or clear both.')
  const seconds = Number(secondsText)
  if (!/^[1-9]\d*$/.test(secondsText) || !Number.isSafeInteger(seconds * 1000)) {
    return invalid('Reserve seconds must be a positive whole number within the mission allowance.')
  }
  const task_keys = keysText.split(/\r?\n/).map((key) => key.trim()).filter(Boolean)
  if (task_keys.length === 0 || task_keys.length > 8 || new Set(task_keys).size !== task_keys.length) {
    return invalid('Enter distinct exact task keys, one per line, from the allocation preview (at most eight).')
  }
  const admissionClosesAt = deadline - seconds * 1000
  if (admissionClosesAt <= now) return invalid('The reserve must leave time for earlier tasks before the mission deadline.')
  policy.reserve = { seconds, task_keys }
  return { policy, error: null, admissionClosesAt }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function deadlineInstant(value: unknown): bigint | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  const offset = match[8] === 'Z' ? 0 : (match[8][0] === '+' ? 1 : -1) *
    (Number(match[8].slice(1, 3)) * 60 + Number(match[8].slice(4, 6)))
  const wall = new Date(milliseconds + offset * 60_000)
  if (wall.getUTCFullYear() !== Number(match[1]) || wall.getUTCMonth() + 1 !== Number(match[2]) ||
    wall.getUTCDate() !== Number(match[3]) || wall.getUTCHours() !== Number(match[4]) ||
    wall.getUTCMinutes() !== Number(match[5]) || wall.getUTCSeconds() !== Number(match[6])) return null
  // Chrono can serialize nanoseconds. Date.parse alone would hide a changed sub-ms cutoff.
  return BigInt(Math.floor(milliseconds / 1000)) * 1_000_000_000n + BigInt((match[7] ?? '').padEnd(9, '0'))
}

export function sameDeadlineInstant(left: unknown, right: unknown): boolean {
  const instant = deadlineInstant(left)
  return instant !== null && instant === deadlineInstant(right)
}

export function isMissionDeadlinePolicy(value: unknown): value is MissionDeadlinePolicy {
  if (!object(value) || Object.keys(value).some((key) => !['deadline_at', 'reserve'].includes(key)) ||
    typeof value.deadline_at !== 'string' || deadlineInstant(value.deadline_at) === null) return false
  if (value.reserve === undefined) return true
  const reserve = value.reserve
  return object(reserve) && Object.keys(reserve).every((key) => ['seconds', 'task_keys'].includes(key)) &&
    typeof reserve.seconds === 'number' && reserve.seconds > 0 && Number.isSafeInteger(reserve.seconds) && Number.isSafeInteger(reserve.seconds * 1000) &&
    Number.isFinite(new Date(Date.parse(value.deadline_at) - reserve.seconds * 1000).getTime()) &&
    Array.isArray(reserve.task_keys) && reserve.task_keys.length > 0 && reserve.task_keys.length <= 8 &&
    reserve.task_keys.every((key) => typeof key === 'string' && key.length > 0 && key.trim() === key) &&
    new Set(reserve.task_keys).size === reserve.task_keys.length
}

/** RFC3339 spellings may differ; the instant, reserve and exact keys may not. */
export function sameMissionDeadline(requested: unknown, echoed: unknown): boolean {
  if (requested == null || echoed == null) return requested == null && echoed == null
  if (!isMissionDeadlinePolicy(requested) || !isMissionDeadlinePolicy(echoed) ||
    !sameDeadlineInstant(requested.deadline_at, echoed.deadline_at)) return false
  if (!requested.reserve || !echoed.reserve) return requested.reserve === echoed.reserve
  return requested.reserve.seconds === echoed.reserve.seconds &&
    requested.reserve.task_keys.length === echoed.reserve.task_keys.length &&
    requested.reserve.task_keys.every((key, index) => key === echoed.reserve?.task_keys[index])
}

/** A projection of the saved policy, not a grant of remaining runtime. */
export function taskDeadlineAt(policy: MissionDeadlinePolicy, taskKey: string): string {
  const reserved = policy.reserve?.task_keys.includes(taskKey)
  const cutoff = new Date(Date.parse(policy.deadline_at) - (reserved ? 0 : (policy.reserve?.seconds ?? 0) * 1000)).toISOString()
  // Reserves are whole seconds. Keep the original fraction instead of silently
  // rounding a server-supplied nanosecond cutoff to JavaScript milliseconds.
  const fraction = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/.exec(policy.deadline_at)?.[1] ?? '000'
  return cutoff.replace(/\.\d{3}Z$/, `.${fraction}Z`)
}
