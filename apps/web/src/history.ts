import type { WorkLink } from './workflowContext'

export type HistoryKind = 'mission' | 'task' | 'run' | 'event'
export type HistoryFilters = {
  kind: HistoryKind
  room_id: string | null
  mission_id: string | null
  attributed_actor_id: string | null
  record_id: string | null
  status: string | null
  search: string
}
export type HistoryEntry = {
  id: string
  kind: HistoryKind
  room_id: string | null
  title: string
  status: string
  summary: string
  actor_id: string | null
  actor_name: string | null
  created_at: string
  seq: string | null
  mission_id: string | null
  task_id: string | null
  run_id: string | null
  cause_id: string | null
}
export type HistoryPage = {
  corp_id: string
  actor_id: string
  filters: HistoryFilters
  page_size: number
  entries: HistoryEntry[]
  next_cursor: string | null
  observed_at: string
}
export type HistoryPosition = Pick<HistoryEntry, 'id' | 'created_at' | 'seq'>
export type HistoryRequest = {
  corpId: string
  actorId: string
  filters: HistoryFilters
  cursor: string | null
  after: HistoryPosition | null
  pageSize: number
}
export type HistoryLoad =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; page: HistoryPage }
  | { key: string; status: 'error'; message: string }

export const HISTORY_KINDS: readonly HistoryKind[] = ['mission', 'task', 'run', 'event']
export const HISTORY_PAGE_SIZE = 25
export const HISTORY_ENTITY_STATUSES: Record<Exclude<HistoryKind, 'event'>, readonly string[]> = {
  mission: ['draft', 'ready', 'running', 'completed', 'failed', 'cancelled', 'unknown'],
  task: ['pending', 'ready', 'claimed', 'running', 'blocked', 'awaiting_approval', 'verification_failed',
    'review', 'completed', 'failed', 'cancelled', 'unknown'],
  run: ['provisioning', 'starting', 'running', 'waiting_for_input', 'waiting_for_approval', 'verifying',
    'completed', 'failed', 'cancelled', 'lost', 'unknown'],
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const NIL = '00000000-0000-0000-0000-000000000000'
// oxlint-disable-next-line no-control-regex -- Reject controls and bidi overrides in labels and search.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
const CURSOR = /^(?:[0-9a-f]{2}){1,2048}$/u
const FILTER_KEYS = ['kind', 'room_id', 'mission_id', 'attributed_actor_id', 'record_id', 'status', 'search'] as const
const ENTRY_KEYS = ['id', 'kind', 'room_id', 'title', 'status', 'summary', 'actor_id', 'actor_name',
  'created_at', 'seq', 'mission_id', 'task_id', 'run_id', 'cause_id'] as const

export function isHistoryId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value) && value !== NIL
}
function optionalId(value: unknown): value is string | null {
  return value === null || isHistoryId(value)
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && [...value].length <= max && !UNSAFE.test(value)
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
}
function timestampKey(value: string): string {
  // Preserve PostgreSQL microseconds; Date alone rounds to milliseconds.
  return value.slice(0, 19) + (value.slice(19, -1).replace('.', '')).padEnd(9, '0')
}
function sequence(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n
}
function status(value: unknown, kind: HistoryKind): value is string {
  return typeof value === 'string' && (kind === 'event'
    ? /^[a-z][a-z0-9._]{0,95}$/u.test(value)
    : HISTORY_ENTITY_STATUSES[kind].includes(value))
}

export function emptyHistoryFilters(kind: HistoryKind = 'event'): HistoryFilters {
  return { kind, room_id: null, mission_id: null, attributed_actor_id: null, record_id: null,
    status: null, search: '' }
}
export function normalizeHistoryFilters(value: HistoryFilters): HistoryFilters | null {
  if (!HISTORY_KINDS.includes(value.kind) ||
    ![value.room_id, value.mission_id, value.attributed_actor_id, value.record_id].every(optionalId) ||
    (value.status !== null && !status(value.status, value.kind))) return null
  const search = value.search.trim()
  return text(search, 160) ? { ...value, search } : null
}
export function historyRequestPath(request: HistoryRequest): string {
  const filters = normalizeHistoryFilters(request.filters)
  if (!filters || !isHistoryId(request.corpId) || !isHistoryId(request.actorId) ||
    !Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 100 ||
    (request.cursor !== null && !CURSOR.test(request.cursor))) throw new Error('Invalid history request.')
  const query = new URLSearchParams({ actor_id: request.actorId, page_size: String(request.pageSize) })
  for (const key of FILTER_KEYS) {
    const value = filters[key]
    if (value !== null) query.set(key, value)
  }
  if (request.cursor) query.set('cursor', request.cursor)
  return '/api/corps/' + request.corpId + '/history?' + query.toString()
}
function older(left: HistoryPosition, right: HistoryPosition, kind: HistoryKind): boolean {
  if (kind === 'event') return sequence(left.seq) && sequence(right.seq) && BigInt(left.seq) < BigInt(right.seq)
  const a = timestampKey(left.created_at), b = timestampKey(right.created_at)
  return a < b || (a === b && left.id < right.id)
}
function entry(value: unknown, filters: HistoryFilters): value is HistoryEntry {
  if (!object(value) || !hasKeys(value, ENTRY_KEYS) || value.kind !== filters.kind ||
    !isHistoryId(value.id) || !timestamp(value.created_at) ||
    !['room_id', 'actor_id', 'mission_id', 'task_id', 'run_id', 'cause_id'].every((key) => optionalId(value[key])) ||
    !text(value.title, 240) || !text(value.summary, 300) || !status(value.status, filters.kind) ||
    !(value.actor_name === null || text(value.actor_name, 240)) ||
    (value.actor_id === null && value.actor_name !== null)) return false
  if (filters.kind === 'event') {
    if (!sequence(value.seq) || value.cause_id === value.id) return false
  } else if (value.seq !== null || value.cause_id !== null || value.room_id === null) return false
  if (value.run_id !== null && (value.task_id === null || value.mission_id === null)) return false
  if (value.task_id !== null && value.mission_id === null) return false
  if (filters.kind === 'mission' && (value.mission_id !== value.id || value.task_id !== null || value.run_id !== null)) return false
  if (filters.kind === 'task' && (value.task_id !== value.id || value.run_id !== null)) return false
  if (filters.kind === 'run' && value.run_id !== value.id) return false
  return (filters.room_id === null || value.room_id === filters.room_id) &&
    (filters.mission_id === null || value.mission_id === filters.mission_id) &&
    (filters.attributed_actor_id === null || value.actor_id === filters.attributed_actor_id) &&
    (filters.record_id === null || value.id === filters.record_id) &&
    (filters.status === null || value.status === filters.status)
}
export function parseHistoryPage(value: unknown, request: HistoryRequest): HistoryPage | null {
  const filters = normalizeHistoryFilters(request.filters)
  if (!filters || !object(value) ||
    !hasKeys(value, ['corp_id', 'actor_id', 'filters', 'page_size', 'entries', 'next_cursor', 'observed_at']) ||
    value.corp_id !== request.corpId || value.actor_id !== request.actorId || value.page_size !== request.pageSize ||
    !object(value.filters) || !hasKeys(value.filters, FILTER_KEYS) ||
    !FILTER_KEYS.every((key) => value.filters && (value.filters as Record<string, unknown>)[key] === filters[key]) ||
    !timestamp(value.observed_at) || !Array.isArray(value.entries) || value.entries.length > request.pageSize ||
    !(value.next_cursor === null || (typeof value.next_cursor === 'string' && CURSOR.test(value.next_cursor) &&
      value.next_cursor !== request.cursor && value.entries.length === request.pageSize))) return null
  const entries: HistoryEntry[] = []
  const ids = new Set<string>()
  let previous = request.after
  for (const candidate of value.entries) {
    if (!entry(candidate, filters) || ids.has(candidate.id) || (previous && !older(candidate, previous, filters.kind)) ||
      timestampKey(candidate.created_at) > timestampKey(value.observed_at)) return null
    ids.add(candidate.id)
    entries.push(candidate)
    previous = candidate
  }
  return { corp_id: request.corpId, actor_id: request.actorId, filters, page_size: request.pageSize,
    entries, next_cursor: value.next_cursor as string | null, observed_at: value.observed_at }
}
export function historyEntryLink(record: HistoryEntry): WorkLink | null {
  if (record.run_id) return { kind: 'run', id: record.run_id }
  if (record.task_id) return { kind: 'task', id: record.task_id }
  if (record.mission_id) return { kind: 'mission', id: record.mission_id }
  return null
}
export function historyPosition(record: HistoryEntry): HistoryPosition {
  return { id: record.id, created_at: record.created_at, seq: record.seq }
}
export function causalHistoryFilters(causeId: string): HistoryFilters {
  return { ...emptyHistoryFilters('event'), record_id: causeId }
}
export function requestHistoryPage(
  request: HistoryRequest,
  key: string,
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
  publish: (load: HistoryLoad) => void,
  timeoutMs = 15000,
): () => void {
  const controller = new AbortController()
  let active = true
  const fail = () => {
    if (active) publish({ key, status: 'error',
      message: 'History is unavailable or this search expired. Refresh the search to recheck access. No other record was substituted.' })
  }
  const timer = setTimeout(() => {
    fail()
    active = false
    controller.abort()
  }, timeoutMs)
  publish({ key, status: 'loading' })
  void (async () => {
    try {
      const value = await api<unknown>(historyRequestPath(request), { signal: controller.signal, cache: 'no-store' })
      if (!active) return
      const page = parseHistoryPage(value, request)
      if (page) publish({ key, status: 'ready', page })
      else fail()
    } catch { fail() }
    finally { clearTimeout(timer) }
  })()
  return () => { active = false; clearTimeout(timer); controller.abort() }
}
