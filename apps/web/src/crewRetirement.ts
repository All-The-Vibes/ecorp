import type { OfficeAgent } from './office/officeModel'

export type RetirementScope = { server: string; corpId: string; actorId: string }
export type RetirementTarget = { agent_id: string; expected_pin_version: number }
export type RetirementMode = 'retire' | 'clear'
export const MAX_CLEAR_CREW_TARGETS = 100
export const retirementBlockers = {
  retention_changed: 'Retention changed. Refresh and make a new request.',
  pinned: 'Pinned identities stay in the crew. Use Retire for this identity.',
  current_run: 'A run is still assigned.',
  active_status: 'The worker is not idle or offline.',
  assigned_work: 'A saved or running mission still needs this worker.',
  active_run: 'A run has not reached a terminal state.',
  control_lease: 'A control lease is still active.',
  queued_message: 'Queued direction is still pending.',
  pending_approval: 'An action approval is still pending.',
  pending_verification: 'A verification decision is still pending.',
  runner_command: 'A runner command is still pending.',
  provider_teardown: 'Provider shutdown has not been confirmed.',
} as const
export type RetirementResult = {
  agent_id: string
  status: 'retired' | 'already_retired' | 'blocked'
  blockers: (keyof typeof retirementBlockers)[]
  retired_at: string | null
  pinned: boolean
  pin_version: number
}
export type RetirementResponse = { results: RetirementResult[]; replayed: boolean }
export type RetirementOperation = {
  scope: RetirementScope
  mode: RetirementMode
  targets: RetirementTarget[]
  idempotency_key: string
  response?: RetirementResponse
}
type OperationStorage = Pick<Storage, 'getItem' | 'setItem'>
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000'
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function retirementScopeKey(scope: RetirementScope): string {
  return `ecorp:crew-retirement:${JSON.stringify([scope.server, scope.corpId, scope.actorId])}`
}

function validateOperation(value: unknown, scope: RetirementScope): RetirementOperation {
  if (!object(value) || !object(value.scope) ||
    value.scope.server !== scope.server || value.scope.corpId !== scope.corpId ||
    value.scope.actorId !== scope.actorId || !uuid(scope.corpId) || !uuid(scope.actorId) ||
    !uuid(value.idempotency_key) || !['retire', 'clear'].includes(String(value.mode)) ||
    !Array.isArray(value.targets) || value.targets.length === 0 ||
    value.targets.length > MAX_CLEAR_CREW_TARGETS ||
    (value.mode === 'retire' && value.targets.length !== 1)) {
    throw new Error('The saved retirement request is invalid. No retirement was sent.')
  }
  const targets = value.targets.map((target) => {
    if (!object(target) || !uuid(target.agent_id) || !version(target.expected_pin_version)) {
      throw new Error('The saved retirement targets are invalid. No retirement was sent.')
    }
    return { agent_id: target.agent_id, expected_pin_version: target.expected_pin_version }
  })
  if (new Set(targets.map((target) => target.agent_id.toLowerCase())).size !== targets.length) {
    throw new Error('Retirement targets must be distinct.')
  }
  const operation: RetirementOperation = {
    scope: { ...scope }, mode: value.mode as RetirementMode,
    targets, idempotency_key: value.idempotency_key,
  }
  if (value.response !== undefined) operation.response = validateRetirementResponse(operation, value.response)
  return operation
}

/** Retain every uncertain request, even after authority over one of its targets is lost. */
export function readRetirementOperations(storage: OperationStorage, scope: RetirementScope): RetirementOperation[] {
  let raw: string | null
  try { raw = storage.getItem(retirementScopeKey(scope)) }
  catch { throw new Error('Browser storage is unavailable. The retirement retry request cannot be preserved.') }
  if (raw === null) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch { throw new Error('The saved retirement request cannot be read. No retirement was sent.') }
  // Earlier sessions stored one operation directly. Read it without changing its
  // request bytes, and upgrade only when the next operation or result is saved.
  const values = object(parsed) && Object.hasOwn(parsed, 'version')
    ? parsed.version === 2 && Array.isArray(parsed.operations) ? parsed.operations : null
    : [parsed]
  if (!values || values.length === 0) {
    throw new Error('The saved retirement requests are invalid. No retirement was sent.')
  }
  const operations = values.map((value) => validateOperation(value, scope))
  if (new Set(operations.map((operation) => operation.idempotency_key.toLowerCase())).size !== operations.length) {
    throw new Error('The saved retirement request keys are not distinct. No retirement was sent.')
  }
  return operations
}

function save(storage: OperationStorage, scope: RetirementScope, operations: RetirementOperation[]): void {
  const key = retirementScopeKey(scope)
  const serialized = JSON.stringify({ version: 2, operations })
  try {
    storage.setItem(key, serialized)
    if (storage.getItem(key) !== serialized) throw new Error('Storage did not retain the request')
  } catch {
    throw new Error('Browser storage could not preserve the retirement requests. Refresh and reconcile saved requests after storage is available.')
  }
}

export function prepareRetirementOperation(
  storage: OperationStorage, scope: RetirementScope, mode: RetirementMode,
  agents: readonly OfficeAgent[], idempotencyKey: string,
): RetirementOperation {
  const previous = readRetirementOperations(storage, scope)
  const operation = validateOperation({
    scope, mode, idempotency_key: idempotencyKey,
    targets: agents.map((agent) => ({ agent_id: agent.id, expected_pin_version: agent.pin_version })),
  }, scope)
  if (previous.some((saved) => saved.idempotency_key.toLowerCase() === operation.idempotency_key.toLowerCase())) {
    throw new Error('A new retirement request requires a distinct operation key.')
  }
  const pending = previous.filter((saved) => !saved.response)
  const targets = new Set(operation.targets.map((target) => target.agent_id.toLowerCase()))
  if (pending.some((saved) => saved.targets.some((target) => targets.has(target.agent_id.toLowerCase())))) {
    throw new Error('Retry the saved retirement request for these identities before starting another operation.')
  }
  save(storage, scope, [...pending, operation])
  return operation
}

/** A partial/malformed response cannot acknowledge the request or lose its retry key. */
export function validateRetirementResponse(operation: RetirementOperation, value: unknown): RetirementResponse {
  if (!object(value) || typeof value.replayed !== 'boolean' || !Array.isArray(value.results) ||
    value.results.length !== operation.targets.length) {
    throw new Error('The server did not return an outcome for every requested identity. Retry the saved request.')
  }
  const expected = new Set(operation.targets.map((target) => target.agent_id.toLowerCase()))
  const results = value.results.map((result): RetirementResult => {
    if (!object(result) || !uuid(result.agent_id) || !expected.delete(result.agent_id.toLowerCase()) ||
      !['retired', 'already_retired', 'blocked'].includes(String(result.status)) ||
      !Array.isArray(result.blockers) ||
      result.blockers.some((blocker) => typeof blocker !== 'string' || !Object.hasOwn(retirementBlockers, blocker)) ||
      new Set(result.blockers).size !== result.blockers.length ||
      typeof result.pinned !== 'boolean' || !version(result.pin_version) ||
      (result.status === 'blocked'
        ? result.retired_at !== null || result.blockers.length === 0
        : typeof result.retired_at !== 'string' || !Number.isFinite(Date.parse(result.retired_at)) || result.blockers.length !== 0)) {
      throw new Error('The retirement outcome is incomplete or inconsistent. Retry the saved request.')
    }
    return {
      agent_id: result.agent_id, status: result.status as RetirementResult['status'],
      blockers: result.blockers as RetirementResult['blockers'], retired_at: result.retired_at as string | null,
      pinned: result.pinned, pin_version: result.pin_version,
    }
  })
  return { results, replayed: value.replayed }
}

export function recordRetirementResponse(
  storage: OperationStorage, operation: RetirementOperation, response: unknown,
): RetirementOperation {
  const operations = readRetirementOperations(storage, operation.scope)
  const current = operations.find((saved) => saved.idempotency_key === operation.idempotency_key)
  if (!current || JSON.stringify({ ...current, response: undefined }) !== JSON.stringify({ ...operation, response: undefined })) {
    throw new Error('The saved retirement request changed. Refresh to reconcile its outcome.')
  }
  const completed = { ...operation, response: validateRetirementResponse(operation, response) }
  save(storage, operation.scope, [
    ...operations.filter((saved) => !saved.response && saved.idempotency_key !== operation.idempotency_key),
    completed,
  ])
  return completed
}

export function retirementRequest(operation: RetirementOperation): { path: string; body: string } {
  const saved = validateOperation(operation, operation.scope)
  const base = `/api/corps/${saved.scope.corpId}/agents`
  const shared = { actor_id: saved.scope.actorId, idempotency_key: saved.idempotency_key }
  return saved.mode === 'clear'
    ? { path: `${base}/clear`, body: JSON.stringify({ ...shared, targets: saved.targets }) }
    : { path: `${base}/${saved.targets[0].agent_id}/retire`,
      body: JSON.stringify({ ...shared, expected_pin_version: saved.targets[0].expected_pin_version }) }
}

export function crewLifecycle(agent: OfficeAgent, runStatus?: string): string {
  if (agent.retired_at != null) return 'Retired'
  if (agent.status === 'starting' || ['provisioning', 'starting'].includes(runStatus ?? '')) return 'Provisioning'
  if (agent.current_run_id) return 'Live'
  if (agent.status === 'blocked') return 'Needs attention'
  return 'Off shift'
}
