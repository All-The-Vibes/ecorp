import { verificationPolicyErrors } from './verificationPolicy.ts'
import type { VerificationPolicy } from './verificationPolicy'

export type TaskContract = {
  objective: string
  expected_output: string
  source_repository: string | null
  source_base_ref: string | null
  source_base_commit: string | null
  workspace_connection_id?: string | null
  acceptance_tests: string[]
  allowed_tools: string[]
  prohibited_actions: string[]
  references: string[]
  write_scope: string[]
  budget_tokens: number
  budget_cost_microusd: number
  deadline_at: string | null
  escalation: string
  secret_refs: { secret_id: string; env_name: string; tool: string; resource: string }[]
  model: string | null
  reasoning_effort: string | null
  deliverable: {
    form: 'commit_branch' | 'patch' | 'archive' | 'typed_artifact_set' | 'review_only_report'
    commit_after_verification: boolean
    paths: string[]
  } | null
}
// The API accepts these serde defaults. Keep omitted fields omitted in exact JSON.
export type RevisionContract = Omit<TaskContract, 'source_repository' | 'source_base_ref' | 'source_base_commit' |
  'budget_cost_microusd' | 'deadline_at' | 'secret_refs' | 'model' | 'reasoning_effort' | 'deliverable'> &
  Partial<Pick<TaskContract, 'source_repository' | 'source_base_ref' | 'source_base_commit' |
    'budget_cost_microusd' | 'deadline_at' | 'secret_refs' | 'model' | 'reasoning_effort'>> &
  { deliverable?: Partial<NonNullable<TaskContract['deliverable']>> | null }
export type RevisionPolicy = Omit<VerificationPolicy, 'manual_gate'> & Partial<Pick<VerificationPolicy, 'manual_gate'>>
export type MissionContractRevisionInput = {
  task_id: string
  expected_contract_version: number
  next_action: 'redispatch' | 'resume'
  source_run_id: string | null
  reason: string
  idempotency_key: string
  description: string
  contract: RevisionContract
  verification_policy: RevisionPolicy
}
export type ContractRevisionTarget = {
  scopeKey: string
  corpId: string
  actorId: string
  roomId: string
  missionId: string
  taskId: string
  version: number
  missionVersion: number
  nextAction: MissionContractRevisionInput['next_action']
  sourceRunId: string | null
  recoveryKey: string | null
}
export type ContractRevisionSaveResult =
  | { status: 'saved'; id: string; version: number; replayed: boolean; refreshWarning?: string }
  | { status: 'rejected' | 'unknown'; message: string }
export type ContractRevisionDraft = {
  schema: 1
  target: ContractRevisionTarget
  before: { description: string; contract: RevisionContract; policy: RevisionPolicy }
  description: string
  reason: string
  contractJson: string
  policyJson: string
  idempotencyKey: string
  pending: MissionContractRevisionInput | null
  result: ContractRevisionSaveResult | null
}
type Errors = Record<string, string>
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(v)
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
const byteLength = (v: string) => new TextEncoder().encode(v).length
const contractKeys = [
  'objective', 'expected_output', 'source_repository', 'source_base_ref', 'source_base_commit',
  'workspace_connection_id', 'acceptance_tests', 'allowed_tools', 'prohibited_actions', 'references',
  'write_scope', 'budget_tokens', 'budget_cost_microusd', 'deadline_at', 'escalation', 'secret_refs',
  'model', 'reasoning_effort', 'deliverable',
]
export const contractListLabels = {
  acceptance_tests: 'Acceptance criteria', allowed_tools: 'Allowed tools', prohibited_actions: 'Prohibited actions',
  references: 'References', write_scope: 'Write scope',
} as const

export function sameRevisionValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length &&
    left.every((v, i) => sameRevisionValue(v, right[i]))
  return record(left) && record(right) && Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(k => Object.hasOwn(right, k) && sameRevisionValue(left[k], right[k]))
}

function contractShape(value: unknown): value is RevisionContract {
  if (!record(value) || !['objective', 'expected_output', 'escalation'].every(k => typeof value[k] === 'string') ||
    !Object.keys(contractListLabels).every(k => strings(value[k])) || typeof value.budget_tokens !== 'number') return false
  if (!['source_repository', 'source_base_ref', 'source_base_commit', 'workspace_connection_id', 'deadline_at',
    'model', 'reasoning_effort'].every(k => value[k] == null || typeof value[k] === 'string')) return false
  if (value.budget_cost_microusd !== undefined && typeof value.budget_cost_microusd !== 'number') return false
  if (value.secret_refs !== undefined && (!Array.isArray(value.secret_refs) ||
    !value.secret_refs.every(v => record(v) && ['secret_id', 'env_name', 'tool', 'resource'].every(k => typeof v[k] === 'string')))) return false
  return value.deliverable == null || (record(value.deliverable) &&
    (value.deliverable.form === undefined || typeof value.deliverable.form === 'string') &&
    (value.deliverable.commit_after_verification === undefined || typeof value.deliverable.commit_after_verification === 'boolean') &&
    (value.deliverable.paths === undefined || strings(value.deliverable.paths)))
}
function policyShape(value: unknown): value is RevisionPolicy {
  if (!record(value) || !Array.isArray(value.checks)) return false
  if (!value.checks.every(c => {
    if (!record(c)) return false
    if (['artifact', 'file', 'screenshot'].includes(String(c.type))) return typeof c.min_bytes === 'number' &&
      (c.type === 'artifact' || typeof c.path === 'string')
    if (c.type === 'json_schema') return typeof c.path === 'string' && strings(c.required_keys)
    return (c.type === 'command' || c.type === 'test') && typeof c.program === 'string' &&
      strings(c.args) && typeof c.timeout_ms === 'number' &&
      (c.cache_suppression == null || ['python_interpreter', 'python_environment', 'node_compile_cache'].includes(String(c.cache_suppression)))
  })) return false
  return value.manual_gate == null || (record(value.manual_gate) && strings(value.manual_gate.roles) &&
    (value.manual_gate.type === 'human_approval' ||
      (value.manual_gate.type === 'independent_review' && typeof value.manual_gate.exclude_requester === 'boolean')))
}
function parseObject<T>(json: string, guard: (v: unknown) => v is T, label: string): { value: T | null; error?: string } {
  try {
    const value: unknown = JSON.parse(json)
    return guard(value) ? { value } : { value: null, error: label + ' has missing fields or unsupported field types.' }
  } catch (caught) { return { value: null, error: label + ': ' + (caught instanceof Error ? caught.message : String(caught)) } }
}
export function parseContractRevision(contractJson: string, policyJson: string) {
  const contract = parseObject(contractJson, contractShape, 'Task contract')
  const policy = parseObject(policyJson, policyShape, 'Verification policy')
  const errors: Errors = {}
  if (contract.error) errors.contract = contract.error
  if (policy.error) errors.policy = policy.error
  return { contract: contract.value, policy: policy.value, errors }
}
const relativePath = (p: string) => Boolean(p) && byteLength(p) <= 500 && p === p.trim() &&
  !/[\\:\p{Cc}]/u.test(p) && p.split('/').every(s => s && s !== '.' && s !== '..')
const writeScope = (s: string) => s === '**' || (relativePath(s.replace(/\/\*\*$/u, '')) &&
  !/[*?[\]]/u.test(s.replace(/\/\*\*$/u, '')))
const scopeContains = (scope: string, candidate: string) => scope === '**' || scope === candidate ||
  (scope.endsWith('/**') && (candidate === scope.slice(0, -3) || candidate.startsWith(scope.slice(0, -2))))

function nativeDefault(contract: RevisionContract, key: keyof RevisionContract): unknown {
  if (key === 'budget_cost_microusd') return contract[key] ?? 1_000_000
  if (key === 'secret_refs') return contract[key] ?? []
  if (key === 'deliverable' && contract.deliverable != null) return {
    form: 'review_only_report', commit_after_verification: false, paths: [], ...contract.deliverable,
  }
  return contract[key] ?? null
}

export function contractRevisionErrors(contract: RevisionContract, policy: RevisionPolicy,
  before?: ContractRevisionDraft['before'], nextAction?: string, factoryLinked = false, adapter?: string | null): Errors {
  const errors: Errors = {}
  for (const [key, max] of [['objective', 100000], ['expected_output', 10000], ['escalation', 2000]] as const) {
    if (!contract[key].trim() || byteLength(contract[key]) > max) errors[key] = 'Enter text up to ' + max.toLocaleString() + ' bytes.'
  }
  for (const key of Object.keys(contractListLabels) as (keyof typeof contractListLabels)[]) {
    const values = contract[key]
    if ((key !== 'references' && !values.length) || values.length > 64 ||
      values.some(v => !v.trim() || byteLength(v) > 500)) errors[key] = 'Use ' + (key === 'references' ? '0' : '1') + '–64 entries, each 1–500 bytes.'
  }
  if (contract.write_scope.some(s => !writeScope(s))) errors.write_scope = 'Use repository-relative paths, directory/** or **; no traversal or other globs.'
  for (const [key, max] of [['budget_tokens', 2000000], ['budget_cost_microusd', 10000000]] as const) {
    if (key === 'budget_cost_microusd' && contract[key] === undefined) continue
    const value = contract[key]
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0 || value > max) errors[key] = 'Use a whole number from 1 to ' + max.toLocaleString() + '.'
  }
  const source = [contract.source_repository, contract.source_base_ref, contract.source_base_commit]
  if (source.some(v => v != null) && !source.every(v => typeof v === 'string' && v.length)) {
    errors.source_repository = 'Repository, base ref and commit must be supplied together.'
  } else if (source.every(v => v != null)) {
    if (!/^[\w.-]{1,100}\/[\w.-]{1,100}$/u.test(contract.source_repository ?? '')) errors.source_repository = 'Use owner/repository.'
    const ref = contract.source_base_ref
    if (!ref || byteLength(ref) > 240 || /^[-/]|[/.]$/u.test(ref) || ref.includes('..') || ref.includes('@{') ||
      ref.includes('[') || /[\\ ~^:?*]/u.test(ref) ||
      [...ref].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) errors.source_base_ref = 'Use a valid source ref.'
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(contract.source_base_commit ?? '')) errors.source_base_commit = 'Use the full reviewed commit hash.'
  }
  if (contract.workspace_connection_id != null && !uuid(contract.workspace_connection_id)) errors.workspace_connection_id = 'Use a workspace connection UUID.'
  if (contract.deadline_at != null && (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(contract.deadline_at) ||
    !Number.isFinite(Date.parse(contract.deadline_at)))) errors.deadline_at = 'Use an RFC 3339 date with a timezone, or null.'
  if (contract.model != null && (!contract.model.trim() || byteLength(contract.model) > 128)) errors.model = 'Use a model name up to 128 bytes, or null.'
  if (contract.reasoning_effort != null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(contract.reasoning_effort)) {
    errors.reasoning_effort = 'Choose a supported reasoning effort.'
  }
  if (adapter === 'fake-process' && (contract.model != null || contract.reasoning_effort != null)) errors.model = 'The deterministic adapter does not accept a model or reasoning effort.'
  const names = new Set<string>()
  for (const secret of contract.secret_refs ?? []) {
    if (!uuid(secret.secret_id) || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(secret.env_name) ||
      names.has(secret.env_name) || !secret.tool.trim() || byteLength(secret.tool) > 64 ||
      !secret.resource.trim() || byteLength(secret.resource) > 512 ||
      Object.keys(secret).some(k => !['secret_id', 'env_name', 'tool', 'resource'].includes(k))) {
      errors.secret_refs = 'Use distinct valid environment names and scoped secret IDs, tools and resources; never secret values.'
    }
    names.add(secret.env_name)
  }
  if (contract.deliverable != null) {
    const deliverable = contract.deliverable
    if ((deliverable.form !== undefined && !['commit_branch', 'patch', 'archive', 'typed_artifact_set', 'review_only_report'].includes(deliverable.form)) ||
      (deliverable.paths ?? []).length > 128 || (deliverable.paths ?? []).some(p => !relativePath(p)) ||
      Object.keys(deliverable).some(k => !['form', 'paths', 'commit_after_verification'].includes(k))) {
      errors.deliverable = 'Use a supported deliverable form and at most 128 repository-relative paths.'
    }
  }
  const unknown = Object.keys(contract).filter(k => !contractKeys.includes(k))
  if (unknown.length) errors.contract = 'Unsupported contract fields would be lost by the API: ' + unknown.join(', ')
  const policyErrors = verificationPolicyErrors({ ...policy, manual_gate: policy.manual_gate ?? null })
  if (policyErrors.length) errors.policy = policyErrors.join(' ')
  if (Object.keys(policy).some(k => !['checks', 'manual_gate'].includes(k))) errors.policy = 'Unsupported verification-policy fields must be corrected in exact JSON.'
  for (const check of policy.checks) {
    const allowed = check.type === 'artifact' ? ['type', 'min_bytes']
      : check.type === 'json_schema' ? ['type', 'path', 'required_keys']
      : check.type === 'command' || check.type === 'test' ? ['type', 'program', 'args', 'timeout_ms', 'cache_suppression']
      : ['type', 'path', 'min_bytes']
    if (Object.keys(check).some(k => !allowed.includes(k))) errors.policy = 'Unsupported verifier fields must be corrected in exact JSON.'
    if ('min_bytes' in check && !Number.isSafeInteger(check.min_bytes)) errors.policy = 'Verifier byte floors must be safe whole numbers.'
    if ('path' in check && !relativePath(check.path)) errors.policy = 'Verifier paths must be repository-relative without traversal.'
    if (check.type === 'command' || check.type === 'test') {
      if (byteLength(check.program) > 256 || check.program.startsWith('-') || check.args.length > 32 ||
        check.args.some(v => byteLength(v) > 2000) || !Number.isSafeInteger(check.timeout_ms)) errors.policy = 'Check the executable, argument bounds and whole-number timeout.'
    }
    if (check.type === 'json_schema' && (check.required_keys.length > 32 ||
      check.required_keys.some(v => !v.trim() || byteLength(v) > 128))) errors.policy = 'Use 1–32 nonempty JSON keys, at most 128 bytes each.'
  }
  if (policy.manual_gate && (policy.manual_gate.roles.length > 16 || Object.keys(policy.manual_gate).some(k =>
    !(policy.manual_gate?.type === 'independent_review' ? ['type', 'roles', 'exclude_requester'] : ['type', 'roles']).includes(k)))) {
    errors.policy = 'Use supported manual-gate fields and at most 16 roles.'
  }
  if (before && nextAction === 'resume') {
    for (const key of ['budget_tokens', 'budget_cost_microusd', 'source_repository', 'source_base_ref', 'source_base_commit',
      'workspace_connection_id', 'secret_refs', 'model', 'reasoning_effort', 'deliverable'] as const) {
      // Native Option fields treat omitted and null identically; do not add absent fields to the draft.
      if (!sameRevisionValue(nativeDefault(contract, key), nativeDefault(before.contract, key))) errors[key] = 'Resume must retain the original ' + key.replaceAll('_', ' ') + '.'
    }
    if (contract.allowed_tools.some(v => !before.contract.allowed_tools.includes(v))) errors.allowed_tools = 'Resume cannot add tools.'
    if (before.contract.prohibited_actions.some(v => !contract.prohibited_actions.includes(v))) errors.prohibited_actions = 'Resume must retain every existing prohibition.'
    if (contract.write_scope.some(v => !before.contract.write_scope.some(s => scopeContains(s, v)))) errors.write_scope = 'Resume can only retain or narrow the existing write scope.'
    if (factoryLinked && (!sameRevisionValue(policy.manual_gate ?? null, before.policy.manual_gate ?? null) ||
      policy.checks.length !== before.policy.checks.length || policy.checks.some((c, i) => c.type !== before.policy.checks[i]?.type))) {
      errors.policy = 'Factory recovery must retain the manual gate and the count and kinds of verifier checks.'
    }
  }
  return errors
}

export function revisionChanges(before: ContractRevisionDraft['before'], description: string,
  contract: RevisionContract | null, policy: RevisionPolicy | null) {
  const entries: { field: string; before: unknown; after: unknown }[] = []
  if (description !== before.description) entries.push({ field: 'Mission description', before: before.description, after: description })
  if (contract) for (const key of new Set([...Object.keys(before.contract), ...Object.keys(contract)])) {
    const old = (before.contract as unknown as Record<string, unknown>)[key]
    const value = (contract as unknown as Record<string, unknown>)[key]
    if (!sameRevisionValue(old, value)) entries.push({ field: key.replaceAll('_', ' '), before: old, after: value })
  }
  if (policy && !sameRevisionValue(before.policy, policy)) entries.push({ field: 'Verification policy', before: before.policy, after: policy })
  return entries
}

export function revisionRequest(draft: ContractRevisionDraft, contract: RevisionContract, policy: RevisionPolicy): MissionContractRevisionInput {
  return { task_id: draft.target.taskId, expected_contract_version: draft.target.version,
    next_action: draft.target.nextAction, source_run_id: draft.target.sourceRunId, reason: draft.reason,
    idempotency_key: draft.idempotencyKey, description: draft.description, contract, verification_policy: policy }
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>
export function readRevisionDraft(storage: () => DraftStorage, scopeKey: string): { draft: ContractRevisionDraft | null; error: string | null; serialized: string | null } {
  try {
    const json = storage().getItem('ecorp:contract-revision:' + scopeKey)
    if (json === null) return { draft: null, error: null, serialized: null }
    const value: unknown = JSON.parse(json)
    if (!record(value) || !record(value.target)) throw new Error('Stored draft is malformed.')
    const target = value.target
    const scope: unknown = JSON.parse(scopeKey)
    if (!Array.isArray(scope) || scope.length !== 6 || typeof scope[0] !== 'string' ||
      !sameRevisionValue(scope.slice(1), [target.corpId, target.actorId, target.roomId, target.missionId, target.taskId])) {
      throw new Error('Stored target differs from this server, Corp, actor, room, mission or task.')
    }
    if (value.schema !== 1 || target.scopeKey !== scopeKey ||
      !['description', 'reason', 'contractJson', 'policyJson', 'idempotencyKey'].every(k => typeof value[k] === 'string') ||
      !record(value.before) || typeof value.before.description !== 'string' ||
      !contractShape(value.before.contract) || !policyShape(value.before.policy) ||
      !['corpId', 'actorId', 'roomId', 'missionId', 'taskId'].every(k => uuid(target[k])) ||
      !Number.isSafeInteger(value.target.version) || Number(value.target.version) < 1 ||
      !Number.isSafeInteger(value.target.missionVersion) || Number(value.target.missionVersion) < 1 ||
      !['resume', 'redispatch'].includes(String(value.target.nextAction)) ||
      (value.target.sourceRunId !== null && !uuid(value.target.sourceRunId)) ||
      (value.target.recoveryKey !== null && typeof value.target.recoveryKey !== 'string') ||
      !uuid(value.idempotencyKey)) throw new Error('Stored draft does not match its scope or schema.')
    const draft = value as unknown as ContractRevisionDraft
    if (draft.target.nextAction === 'resume'
      ? !uuid(draft.target.sourceRunId)
      : draft.target.sourceRunId !== null || draft.target.recoveryKey !== null) {
      throw new Error('Stored action and recovery source do not match.')
    }
    if (draft.target.recoveryKey !== null) {
      const recovery: unknown = JSON.parse(draft.target.recoveryKey)
      if (!Array.isArray(recovery) || recovery.length !== 7 ||
        !sameRevisionValue(recovery.slice(0, 3), [draft.target.corpId, draft.target.actorId, draft.target.missionId]) ||
        !uuid(recovery[3]) || !Number.isSafeInteger(recovery[4]) || recovery[4] < 1 ||
        !Number.isSafeInteger(recovery[5]) || recovery[5] < 0 || typeof recovery[6] !== 'string') {
        throw new Error('Stored Factory recovery scope cannot be verified.')
      }
    }
    if (draft.pending !== null) {
      if (!record(draft.pending) || !contractShape(draft.pending.contract) || !policyShape(draft.pending.verification_policy) ||
        !sameRevisionValue(draft.pending, revisionRequest(draft, draft.pending.contract, draft.pending.verification_policy)) ||
        !sameRevisionValue(JSON.parse(draft.contractJson), draft.pending.contract) ||
        !sameRevisionValue(JSON.parse(draft.policyJson), draft.pending.verification_policy)) throw new Error('Stored retry request cannot be verified.')
    }
    if (draft.result !== null && (!draft.pending || !record(draft.result) || !['saved', 'rejected', 'unknown'].includes(draft.result.status) ||
      (draft.result.status === 'saved'
        ? !uuid(draft.result.id) || !Number.isSafeInteger(draft.result.version) || draft.result.version <= draft.target.version ||
          typeof draft.result.replayed !== 'boolean' ||
          (draft.result.refreshWarning !== undefined && typeof draft.result.refreshWarning !== 'string')
        : typeof draft.result.message !== 'string'))) throw new Error('Stored save result cannot be verified.')
    return { draft, error: null, serialized: json }
  } catch (caught) {
    return { draft: null, serialized: null, error: 'Draft storage is unavailable or cannot be verified. No request was sent. ' + (caught instanceof Error ? caught.message : String(caught)) }
  }
}
export function writeRevisionDraft(storage: () => DraftStorage, draft: ContractRevisionDraft, expected: string | null): string | null {
  try {
    const key = 'ecorp:contract-revision:' + draft.target.scopeKey
    if (storage().getItem(key) !== expected) return 'This draft changed in another view. Reload to read the preserved draft before saving; no new request was sent.'
    const json = JSON.stringify(draft)
    storage().setItem(key, json)
    if (storage().getItem(key) !== json) throw new Error('Draft readback differs.')
    return null
  } catch { return 'Browser storage could not preserve this draft and exact retry request. Restore session storage before saving; no new request was sent.' }
}

type RecoveryRun = {
  id: string; task_id: string; status: string; provider_session_id: string | null
  workspace_run_id: string; resumed_from_run_id: string | null
  workspace_disposition: string | null; workspace_path: string | null; workspace_detail: string | null
  breaker_stage: string | null
  execution_mode?: string; agent_id?: string; runner_id?: string
  source_repository?: string | null; source_base_ref?: string | null; source_base_commit?: string | null
}
export function ordinaryContractRevisionSource(runs: readonly RecoveryRun[], taskId: string, selectedRunId?: string | null): string | null {
  const candidates = runs.filter(run => run.task_id === taskId &&
    (selectedRunId == null || run.id === selectedRunId) && ['failed', 'cancelled', 'lost'].includes(run.status) &&
    run.workspace_disposition === 'preserved' && run.workspace_path && run.breaker_stage !== 'stop')
  const eligible = candidates.filter(source => {
    if (!source.workspace_run_id) return false
    const lineage = runs.filter(run => run.workspace_run_id === source.workspace_run_id)
    if (lineage.some(run => run.breaker_stage === 'stop' || run.workspace_disposition === 'quarantined')) return false
    // Without native creation timestamps, require one provable ancestry chain. Never trust snapshot order.
    const ancestors = new Set<string>()
    let providerSession = Boolean(source.provider_session_id)
    let current: RecoveryRun | undefined = source
    while (current && !ancestors.has(current.id) && ancestors.size < 64) {
      ancestors.add(current.id)
      if (!current.resumed_from_run_id) { current = undefined; break }
      current = lineage.find(run => run.id === current?.resumed_from_run_id)
      if (!current) return false
      if (['task_id', 'agent_id', 'runner_id', 'source_repository', 'source_base_ref', 'source_base_commit'].some(
        key => (current as unknown as Record<string, unknown>)[key] !== (source as unknown as Record<string, unknown>)[key],
      )) return false
      if (source.execution_mode === 'verification_only' && current.provider_session_id) providerSession = true
    }
    if (current || !providerSession) return false
    return lineage.every(run => ancestors.has(run.id) ||
      (run.status === 'failed' && run.workspace_path == null && run.workspace_disposition == null && run.workspace_detail === 'dispatch_not_started'))
  })
  return eligible.length === 1 ? eligible[0].id : null
}
