import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as operations from './operation_receipt.mjs'
import { consumeOperationReceipt, ReceiptCheckError } from './consume_operation_receipt.mjs'
import { probeConfiguration, readMcpSnapshot } from './probe_mcp.mjs'
import * as feedback from '../scenarios/repo-steward/lib/feedback.mjs'

export const FEEDBACK_ADMISSION_LIMITS = Object.freeze({ bytes: 1024 * 1024, rules: 8, references: 64,
  referenceBytes: 500, guidanceBytes: 8192, maximumAgeMs: 300000, timeoutMs: 30000,
  envelopeBytes: 4 * 1024 * 1024, patchBytes: 2 * 1024 * 1024, changes: 64 })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const HASH = /^[0-9a-f]{64}$/u
const RULE = /^FB-[0-9a-f]{64}$/u
const isUuid = value => typeof value === 'string' && UUID.test(value)
const isHash = value => typeof value === 'string' && HASH.test(value)
const isRule = value => typeof value === 'string' && RULE.test(value)
const isCommit = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
const TYPED_ARTIFACT_MEDIA_TYPE = 'application/vnd.ecorp.deliverable+json'
const clone = value => structuredClone(value)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => feedback.feedbackDigest(value)
const equal = (left, right) => digest(left) === digest(right)
const iso = value => {
  requireThat(value instanceof Date || typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/u.test(value), 'invalid_time')
  requireThat(Number.isFinite(new Date(value).getTime()), 'invalid_time')
  return new Date(value).toISOString()
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export class FeedbackAdmissionError extends Error {
  constructor(code) { super(code); this.code = code }
}
const requireThat = (condition, code) => { if (!condition) throw new FeedbackAdmissionError(code) }
function bounded(bytes, code = 'unbounded_input', maximum = FEEDBACK_ADMISSION_LIMITS.bytes) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, code)
  return bytes
}
function parse(bytes, maximum = FEEDBACK_ADMISSION_LIMITS.bytes) {
  bounded(bytes, 'unbounded_input', maximum)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value = JSON.parse(text)
    digest(value)
    // JSON.parse accepts duplicate keys. Scan the already-valid bounded JSON's
    // string/structure tokens to reject ambiguity, including escaped aliases.
    const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/gu, stack = []
    for (const token of text.matchAll(tokens)) {
      if (token[0] === '{') stack.push(new Set())
      else if (token[0] === '[') stack.push(null)
      else if (token[0] === '}' || token[0] === ']') stack.pop()
      else if (/^\s*:/u.test(text.slice(token.index + token[0].length))) {
        const keys = stack.at(-1), key = JSON.parse(token[0])
        requireThat(keys && !keys.has(key), 'duplicate_json_key')
        keys.add(key)
      }
    }
    return value
  } catch { throw new FeedbackAdmissionError('invalid_json_data') }
}
const safeCode = error => error instanceof FeedbackAdmissionError ? error.code
  : error instanceof ReceiptCheckError ? `receipt_${error.code}` : 'native_observation_unavailable'
function deadline(timeoutMs) {
  requireThat(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000, 'invalid_timeout')
  const end = performance.now() + timeoutMs
  return () => {
    const remaining = Math.floor(end - performance.now())
    requireThat(remaining >= 100, 'operation_deadline_exhausted')
    return remaining
  }
}
function configuration(env, timeoutMs) {
  requireThat(object(env) && typeof env.CRONY_MCP_BINARY === 'string' && typeof env.CRONY_SERVER_HTTP === 'string'
    && isUuid(env.CRONY_CORP_ID) && isUuid(env.CRONY_ACTOR_ID)
    && (env.CRONY_ACCESS_TOKEN === undefined || typeof env.CRONY_ACCESS_TOKEN === 'string'), 'invalid_trusted_configuration')
  return probeConfiguration(env, timeoutMs)
}
function trustedScope(env, timeoutMs) {
  const config = configuration(env, timeoutMs)
  return { server_origin_sha256: sha(config.childEnv.CRONY_SERVER_HTTP), corp_id: config.corpId.toLowerCase(), actor_id: config.actorId.toLowerCase() }
}
function sameScope(receipt, trusted) {
  for (const key of Object.keys(trusted)) requireThat(receipt.scope[key] === trusted[key], 'trusted_scope_mismatch')
}
function safeArtifactPath(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 500
    && value.split('/').every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment)
      && !segment.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))
}
function sourceEligible(receipt, artifactId, artifactPath = null) {
  requireThat(isUuid(artifactId), 'invalid_artifact_selection')
  requireThat(artifactPath === null || safeArtifactPath(artifactPath), 'invalid_artifact_path')
  try { operations.validateOperationReceipt(receipt) } catch { throw new FeedbackAdmissionError('invalid_source_receipt') }
  requireThat(receipt.mode === 'current-run' && receipt.origin.kind === 'direct', 'unsupported_source_origin')
  requireThat(receipt.mission.status === 'completed' && receipt.task.status === 'completed'
    && receipt.run.is_latest_task_run === true && receipt.run.status === 'completed'
    && receipt.run.verification_status === 'passed' && receipt.verification.persisted_acceptance_observed, 'source_not_accepted')
  requireThat(receipt.verification.automated_checks_complete && receipt.verification.automated_checks_passed
    && receipt.verification.expected_check_count > 0, 'source_checks_incomplete')
  requireThat(isHash(receipt.run.verification_sha256), 'missing_verifier_digest')
  requireThat(receipt.lineage.resume_chain_complete, 'incomplete_source_lineage')
  const gate = receipt.verification.manual_gate
  requireThat(gate === null || gate.status === 'approved' && isUuid(gate.decided_by) && Number.isFinite(Date.parse(gate.decided_at)), 'source_gate_not_approved')
  requireThat(Object.values(receipt.source).every(value => typeof value === 'string' && value.length > 0), 'missing_source_identity')
  const artifact = receipt.artifacts.find(item => item.id === artifactId)
  requireThat(artifact && artifact.byte_hash_verified && artifact.signature_header_matches_record, 'missing_corpus_artifact')
  requireThat(artifactPath === null ? ['application/json', 'text/plain', 'text/markdown'].includes(artifact.media_type)
    : artifact.role === 'source_deliverable' && artifact.media_type === TYPED_ARTIFACT_MEDIA_TYPE, 'unsupported_corpus_binding')
  return artifact
}
function exactKeys(value, keys) {
  requireThat(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'typed_artifact_schema_invalid')
}
function decodeCanonicalBase64(value, maximum, code) {
  requireThat(typeof value === 'string' && value.length <= 4 * Math.ceil(maximum / 3)
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value), code)
  const decoded = Buffer.from(value, 'base64')
  requireThat(decoded.length <= maximum && decoded.toString('base64') === value, code)
  return decoded
}
export function bindFeedbackCorpusArtifact({ receipt, artifactId, artifactPath = null, artifactBytes, corpusBytes }) {
  const artifact = sourceEligible(receipt, artifactId, artifactPath)
  bounded(corpusBytes)
  bounded(artifactBytes, 'corpus_artifact_unavailable', FEEDBACK_ADMISSION_LIMITS.envelopeBytes)
  requireThat(artifactBytes.length === artifact.bytes && sha(artifactBytes) === artifact.sha256, 'corpus_artifact_bytes_mismatch')
  let content = artifactBytes
  if (artifactPath !== null) {
    const document = parse(artifactBytes, FEEDBACK_ADMISSION_LIMITS.envelopeBytes)
    exactKeys(document, ['schema_version', 'form', 'base_commit', 'head_commit', 'branch', 'verification_sha256',
      'patch_sha256', 'patch_base64', 'git_bundle_sha256', 'git_bundle_base64', 'changes'])
    requireThat(document.schema_version === 1 && document.form === 'typed_artifact_set', 'typed_artifact_form_unsupported')
    requireThat(document.base_commit === receipt.source.base_commit && document.base_commit === artifact.base_commit
      && document.verification_sha256 === receipt.run.verification_sha256 && document.verification_sha256 === artifact.verification_sha256
      && document.head_commit === artifact.head_commit && (document.head_commit === null || isCommit(document.head_commit))
      && artifact.sha256 === receipt.run.deliverable_sha256, 'typed_artifact_source_binding_mismatch')
    requireThat(typeof document.branch === 'string' && document.branch.length > 0 && document.branch.isWellFormed()
      && Buffer.byteLength(document.branch) <= 512 && document.branch.trim() === document.branch
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(document.branch), 'typed_artifact_schema_invalid')
    requireThat(document.git_bundle_sha256 === null && document.git_bundle_base64 === null, 'typed_artifact_bundle_unsupported')
    requireThat(isHash(document.patch_sha256), 'typed_artifact_patch_invalid')
    const patch = decodeCanonicalBase64(document.patch_base64, FEEDBACK_ADMISSION_LIMITS.patchBytes, 'typed_artifact_patch_invalid')
    requireThat(sha(patch) === document.patch_sha256, 'typed_artifact_patch_checksum_mismatch')
    requireThat(Array.isArray(document.changes) && document.changes.length > 0 && document.changes.length <= FEEDBACK_ADMISSION_LIMITS.changes,
      'typed_artifact_changes_invalid')
    const paths = new Set()
    for (const change of document.changes) {
      exactKeys(change, ['path', 'status', 'mode', 'sha256', 'bytes', 'media_type', 'content_base64'])
      requireThat(safeArtifactPath(change.path), 'typed_artifact_path_invalid')
      const key = change.path.toLowerCase()
      requireThat(![...paths].some(previous => previous === key || previous.startsWith(`${key}/`) || key.startsWith(`${previous}/`)), 'typed_artifact_path_ambiguous')
      paths.add(key)
      requireThat(['A', 'M', 'T', 'D'].includes(change.status), 'typed_artifact_change_unsupported')
      if (change.status === 'D') {
        requireThat(['mode', 'sha256', 'bytes', 'media_type', 'content_base64'].every(field => change[field] === null), 'typed_artifact_schema_invalid')
      } else {
        requireThat(['100644', '100755'].includes(change.mode), 'typed_artifact_mode_unsupported')
        requireThat(isHash(change.sha256) && Number.isSafeInteger(change.bytes) && change.bytes >= 0 && change.bytes <= FEEDBACK_ADMISSION_LIMITS.bytes
          && typeof change.media_type === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(change.media_type)
          && typeof change.content_base64 === 'string' && change.content_base64.length === 4 * Math.ceil(change.bytes / 3), 'typed_artifact_schema_invalid')
      }
    }
    const selected = document.changes.filter(change => change.path === artifactPath)
    requireThat(selected.length === 1 && selected[0].status !== 'D', 'typed_artifact_selected_file_unavailable')
    const change = selected[0]
    requireThat(['application/json', 'text/plain', 'text/markdown'].includes(change.media_type), 'typed_artifact_selected_media_unsupported')
    content = decodeCanonicalBase64(change.content_base64, FEEDBACK_ADMISSION_LIMITS.bytes, 'typed_artifact_base64_invalid')
    requireThat(content.length === change.bytes && sha(content) === change.sha256, 'typed_artifact_content_checksum_mismatch')
  }
  requireThat(content.equals(corpusBytes), 'corpus_artifact_bytes_mismatch')
  return { kind: artifactPath === null ? 'raw-artifact' : 'typed-artifact-set-file', path: artifactPath,
    artifact_sha256: artifact.sha256, content_sha256: sha(content), content_bytes: content.length }
}
function exactlyOne(rows, id, code) {
  requireThat(Array.isArray(rows), code)
  const matches = rows.filter(row => row?.id === id)
  requireThat(matches.length === 1, code)
  return matches[0]
}

// Only native metadata from the authenticated snapshot/context readers reaches here.
export function projectFeedbackTarget(payload, context, { corpId, actorId, missionId, taskId }) {
  requireThat([corpId, actorId, missionId, taskId].every(isUuid), 'invalid_target_selection')
  const snapshot = payload?.snapshot
  requireThat(snapshot?.corp?.id === corpId, 'target_corp_mismatch')
  const mission = exactlyOne(snapshot.missions, missionId, 'target_mission_unavailable')
  const task = exactlyOne(snapshot.tasks, taskId, 'target_task_unavailable')
  requireThat(mission.corp_id === corpId && task.corp_id === corpId && task.mission_id === missionId, 'target_identity_mismatch')
  requireThat(context?.corp_id === corpId && context.actor_id === actorId && context.mission_id === missionId
    && context.room_id === mission.room_id && context.origin?.kind === 'direct', 'target_origin_or_scope_mismatch')
  requireThat(Array.isArray(snapshot.runs), 'target_runs_unavailable')
  return { corp_id: corpId, room_id: mission.room_id, actor_id: actorId, origin: 'direct', run_history_coverage: 'bounded_snapshot', mission: clone(mission), task: clone(task),
    run_ids: snapshot.runs.filter(run => run.task_id === taskId || run.task_id && snapshot.tasks.some(item => item.id === run.task_id && item.mission_id === missionId)).map(run => run.id).sort(),
    revisions: clone((snapshot.mission_contract_revisions ?? []).filter(item => item.mission_id === missionId && item.task_id === taskId)) }
}
function targetState(target) {
  // Preserve every native mission/task field, including fields introduced later.
  const result = clone(target)
  delete result.revisions
  return result
}
function requireNativeObjectiveFixedPoint(target) {
  // Conservative fixed-point subset of contract_revision.rs:609-641 and the
  // native description normalizer. Do not send a reference-only proposal whose
  // unchanged description/objective the endpoint would compose differently.
  const description = target.mission.description, objective = target.task.contract.objective
  const trim = value => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
  requireThat(typeof description === 'string' && description.isWellFormed()
    && trim(description.replaceAll('\r\n', '\n').replaceAll('\r', '\n')) === description
    && Buffer.byteLength(description) <= 100000 && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(description), 'target_description_not_native_fixed_point')
  requireThat(typeof objective === 'string' && objective.isWellFormed() && objective.length > 0 && trim(objective) === objective
    && Buffer.byteLength(objective) <= 100000 && target.task.objective === objective
    && (description === '' || objective === description || objective.startsWith(`${description}\n\nTASK-SPECIFIC OBJECTIVE:\n`)),
  'target_objective_not_native_fixed_point')
}
function targetEligible(target, receipt) {
  requireThat(object(target) && [target.corp_id, target.room_id, target.actor_id, target.mission?.id, target.mission?.corp_id,
    target.mission?.room_id, target.mission?.requested_by, target.task?.id, target.task?.corp_id, target.task?.mission_id].every(isUuid), 'invalid_target_identity')
  requireThat(object(target) && target.origin === 'direct' && target.corp_id === receipt.scope.corp_id
    && target.actor_id === receipt.scope.actor_id && target.room_id === receipt.scope.room_id, 'target_scope_mismatch')
  requireThat(target.mission.id !== receipt.scope.mission_id && target.task.id !== receipt.scope.task_id, 'same_source_and_target')
  requireThat(target.mission.room_id === target.room_id && target.mission.corp_id === target.corp_id && target.task.corp_id === target.corp_id
    && target.task.mission_id === target.mission.id, 'target_identity_mismatch')
  requireThat(target.run_history_coverage === 'bounded_snapshot', 'target_run_history_coverage_missing')
  requireThat(target.mission.status === 'ready' && Array.isArray(target.run_ids) && target.run_ids.length === 0, 'target_not_unrun_ready')
  requireThat(Number.isSafeInteger(target.task.contract_version) && target.task.contract_version > 0
    && Number.isSafeInteger(target.mission.specification_version) && target.mission.specification_version > 0, 'invalid_target_version')
  const contract = target.task.contract
  requireThat(object(contract) && Array.isArray(contract.references) && object(target.task.verification_policy), 'target_contract_unavailable')
  requireNativeObjectiveFixedPoint(target)
  requireThat(contract.source_repository?.toLowerCase() === receipt.source.repository.toLowerCase()
    && contract.source_base_ref === receipt.source.base_ref && contract.source_base_commit === receipt.source.base_commit, 'target_source_mismatch')
  requireThat(['ready', 'pending', 'queued', 'planned', 'blocked'].includes(target.task.status), 'target_task_not_ready')
}
function selection(corpus, selectedRuleIds, reviewBytes, now, validateCorpus) {
  requireThat(typeof validateCorpus === 'function', 'corpus_validator_unavailable')
  try { validateCorpus(corpus) } catch { throw new FeedbackAdmissionError('invalid_feedback_corpus') }
  requireThat(Array.isArray(selectedRuleIds) && selectedRuleIds.length > 0 && selectedRuleIds.length <= FEEDBACK_ADMISSION_LIMITS.rules
    && selectedRuleIds.every(isRule) && new Set(selectedRuleIds).size === selectedRuleIds.length, 'invalid_rule_selection')
  const reviewHash = sha(bounded(reviewBytes))
  return [...selectedRuleIds].sort().map(id => {
    const record = exactlyOne(corpus.records, id, 'missing_selected_rule')
    requireThat(record.status === 'active' && record.review?.decision === 'activate', 'rule_not_active')
    requireThat(Date.parse(record.expires_at) > now && Date.parse(record.review.at) <= now && Date.parse(corpus.updated_at) <= now, 'rule_expired_or_future')
    requireThat(record.review.evidence_sha256 === reviewHash, 'review_bytes_mismatch')
    return { id, digest: digest(record), guidance: clone(record.guidance), expires_at: record.expires_at }
  })
}

export function buildFeedbackProposal({ corpusBytes, reviewBytes, receiptBytes, sourceArtifactBytes, artifactId, artifactPath = null, selectedRuleIds,
  target, now = new Date(), ttlMs = FEEDBACK_ADMISSION_LIMITS.maximumAgeMs, idempotencyKey = randomUUID(), requireIndependentReview = false },
{ validateCorpus = feedback.validateFeedbackCorpus } = {}) {
  bounded(corpusBytes); bounded(reviewBytes); bounded(receiptBytes)
  requireThat(isUuid(artifactId) && isUuid(idempotencyKey), 'invalid_identity')
  requireThat(artifactPath === null || typeof artifactPath === 'string', 'invalid_artifact_path')
  requireThat(Number.isInteger(ttlMs) && ttlMs >= 1000 && ttlMs <= FEEDBACK_ADMISSION_LIMITS.maximumAgeMs, 'invalid_expiry')
  requireThat(typeof requireIndependentReview === 'boolean', 'invalid_review_requirement')
  const at = Date.parse(iso(now))
  const base = { schema_version: 1, kind: 'ecorp-feedback-contract-proposal', state: 'candidate', created_at: iso(new Date(at)), expires_at: iso(new Date(at + ttlMs)),
    idempotency_key: idempotencyKey, inputs: { corpus_sha256: sha(corpusBytes), review_sha256: sha(reviewBytes), receipt_sha256: sha(receiptBytes), artifact_id: artifactId, artifact_path: artifactPath,
      selected_rule_ids: clone(selectedRuleIds), require_independent_review: requireIndependentReview }, reasons: [], request: null,
    assurance: { authority: 'none', independent_review_verified: false, production_identity_verified: false, source_check_non_atomic: true,
      launch_authorized: false, corpus_source_descriptors_authenticated: false, zero_historical_runs_verified: false,
      native_pre_execution_admission_required: true } }
  try {
    const corpus = parse(corpusBytes), receipt = parse(receiptBytes)
    const selected = selection(corpus, selectedRuleIds, reviewBytes, at, validateCorpus)
    const artifact = sourceEligible(receipt, artifactId, artifactPath)
    const binding = bindFeedbackCorpusArtifact({ receipt, artifactId, artifactPath, artifactBytes: sourceArtifactBytes, corpusBytes })
    requireThat(corpus.scope.repository.toLowerCase() === receipt.source.repository.toLowerCase(), 'corpus_repository_mismatch')
    requireThat(corpus.records.filter(record => selectedRuleIds.includes(record.id)).every(record =>
      record.evidence.every(item => item.source_commit === receipt.source.base_commit)), 'corpus_source_mismatch')
    targetEligible(target, receipt)
    requireThat(!requireIndependentReview, 'independent_review_not_proven')
    const suffix = [
      `Advisory feedback corpus ${digest(corpus)}; source run ${receipt.scope.run_id}; artifact ${artifactId}${artifactPath === null ? '' : `; file ${artifactPath}`}. Context only; the existing task contract and verification policy remain authoritative.`,
      ...selected.map(record => `Advisory ${record.id} (${record.digest}); ${record.guidance.route}: ${record.guidance.text}`),
    ]
    const references = [...target.task.contract.references, ...suffix]
    requireThat(references.length <= FEEDBACK_ADMISSION_LIMITS.references && references.every(entry => typeof entry === 'string'
      && entry.trim().length > 0 && Buffer.byteLength(entry) <= FEEDBACK_ADMISSION_LIMITS.referenceBytes), 'reference_bounds_exceeded')
    requireThat(Buffer.byteLength(suffix.join('\n')) <= FEEDBACK_ADMISSION_LIMITS.guidanceBytes, 'guidance_bounds_exceeded')
    requireThat(!suffix.some(entry => target.task.contract.references.includes(entry)), 'guidance_already_present')
    const contract = { ...clone(target.task.contract), references }
    const reason = `Local advisory feedback ${idempotencyKey}; corpus ${digest(corpus)}; source observation ${operations.operationReceiptFingerprint(receipt)}. No independent review or new authority asserted.`
    return { ...base, state: 'ready-for-review', source: { scope: clone(receipt.scope), source: clone(receipt.source),
      observation_fingerprint_sha256: operations.operationReceiptFingerprint(receipt), artifact: clone(artifact), corpus_binding: binding, verifier_sha256: receipt.run.verification_sha256 },
    corpus_digest: digest(corpus), corpus_revision: corpus.revision, selected, target: targetState(target), reference_suffix: suffix,
    request: { actor_id: target.actor_id, task_id: target.task.id, expected_contract_version: target.task.contract_version,
      next_action: 'redispatch', source_run_id: null, reason, idempotency_key: idempotencyKey, description: target.mission.description,
      contract, verification_policy: clone(target.task.verification_policy) } }
  } catch (error) { return { ...base, reasons: [safeCode(error)] } }
}

async function nativeJson(env, route, { method = 'GET', body, timeoutMs = FEEDBACK_ADMISSION_LIMITS.timeoutMs } = {}) {
  const config = configuration(env, timeoutMs)
  const response = await fetch(`${config.childEnv.CRONY_SERVER_HTTP}${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { ...(env.CRONY_ACCESS_TOKEN ? { authorization: `Bearer ${env.CRONY_ACCESS_TOKEN}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) { await response.body?.cancel(); const error = new FeedbackAdmissionError('native_request_rejected'); error.httpStatus = response.status; throw error }
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > FEEDBACK_ADMISSION_LIMITS.bytes)) {
    await response.body?.cancel()
    throw new FeedbackAdmissionError('native_response_unbounded')
  }
  const chunks = []; let bytes = 0
  requireThat(response.body, 'native_response_missing')
  for await (const chunk of response.body) { bytes += chunk.length; requireThat(bytes <= FEEDBACK_ADMISSION_LIMITS.bytes, 'native_response_unbounded'); chunks.push(chunk) }
  return parse(Buffer.concat(chunks))
}
export async function readFeedbackTarget({ env = process.env, missionId, taskId, timeoutMs = FEEDBACK_ADMISSION_LIMITS.timeoutMs }) {
  requireThat(isUuid(missionId) && isUuid(taskId), 'invalid_target_selection')
  const config = configuration(env, timeoutMs)
  const remaining = deadline(timeoutMs)
  const { payload } = await readMcpSnapshot({ env, timeoutMs: remaining() })
  const context = await nativeJson(env, `/api/corps/${config.corpId}/missions/${missionId}/context?actor_id=${config.actorId}`, { timeoutMs: remaining() })
  return projectFeedbackTarget(payload, context, { corpId: config.corpId.toLowerCase(), actorId: config.actorId.toLowerCase(), missionId, taskId })
}
const defaults = {
  readSource: options => { requireThat(typeof operations.exportOperationEvidence === 'function', 'artifact_capture_unavailable'); return operations.exportOperationEvidence(options) },
  readTarget: readFeedbackTarget,
  revise: ({ env, corpId, missionId, body, timeoutMs }) => nativeJson(env, `/api/corps/${corpId}/missions/${missionId}/contract-revisions`, { method: 'POST', body, timeoutMs }),
  validateCorpus: corpus => { requireThat(typeof feedback.validateFeedbackCorpus === 'function', 'corpus_validator_unavailable'); return feedback.validateFeedbackCorpus(corpus) },
}
async function checkedSource({ receiptBytes, artifactId, artifactPath = null, env, timeoutMs }, native) {
  const receipt = parse(receiptBytes)
  sourceEligible(receipt, artifactId, artifactPath)
  sameScope(receipt, trustedScope(env, timeoutMs))
  const observed = await native.readSource({ env, runId: receipt.scope.run_id, mode: 'current-run', timeoutMs, artifactIds: [artifactId] })
  requireThat(observed && Array.isArray(observed.artifactBytes), 'corpus_artifact_unavailable')
  await consumeOperationReceipt({ receipt, runId: receipt.scope.run_id, env, timeoutMs, readCurrent: async () => observed.receipt })
  sourceEligible(observed.receipt, artifactId, artifactPath)
  sameScope(observed.receipt, trustedScope(env, timeoutMs))
  const artifacts = observed.artifactBytes.filter(item => item.id === artifactId)
  requireThat(artifacts.length === 1, 'corpus_artifact_unavailable')
  return { receipt: observed.receipt, bytes: bounded(artifacts[0].bytes, 'corpus_artifact_unavailable', FEEDBACK_ADMISSION_LIMITS.envelopeBytes) }
}

export async function prepareOperationFeedback(options, dependencies = {}) {
  const native = { ...defaults, ...dependencies }
  const { env = process.env, timeoutMs = FEEDBACK_ADMISSION_LIMITS.timeoutMs, missionId, taskId } = options
  const remaining = deadline(timeoutMs)
  let source, target, observationError
  try {
    source = await checkedSource({ ...options, env, timeoutMs: remaining() }, native)
    target = await native.readTarget({ env, timeoutMs: remaining(), missionId, taskId })
    remaining()
  } catch (error) { observationError = safeCode(error) }
  const proposal = buildFeedbackProposal({ ...options, target, sourceArtifactBytes: source?.bytes }, native)
  return observationError ? { ...proposal, state: 'candidate', reasons: [observationError], request: null } : proposal
}
function expectedRevision(proposal, revision) {
  const before = proposal.target
  return object(revision) && revision.corp_id === before.corp_id && revision.mission_id === before.mission.id
    && revision.task_id === before.task.id && revision.revised_by === before.actor_id
    && revision.version === Math.max(before.mission.specification_version, before.task.contract_version) + 1
    && revision.next_action === 'redispatch' && revision.source_run_id === null && revision.reason === proposal.request.reason
    && equal(revision.previous_contract, before.task.contract) && equal(revision.replacement_contract, proposal.request.contract)
    && revision.previous_description === before.mission.description && revision.replacement_description === before.mission.description
    && equal(revision.previous_verification_policy, before.task.verification_policy)
    && equal(revision.replacement_verification_policy, before.task.verification_policy)
}
function unchangedAfterRevision(proposal, current) {
  const original = targetState(proposal.target), after = targetState(current)
  const version = Math.max(original.mission.specification_version, original.task.contract_version) + 1
  // Only the native revision's documented projection changes are allowed.
  after.mission.specification_version = original.mission.specification_version
  after.mission.updated_at = original.mission.updated_at
  after.task.contract_version = original.task.contract_version
  after.task.contract = clone(original.task.contract)
  after.task.objective = original.task.objective
  after.task.verification_status = original.task.verification_status
  after.task.updated_at = original.task.updated_at
  return current.mission.specification_version === version && current.task.contract_version === version
    && equal(current.task.contract, proposal.request.contract) && current.task.objective === proposal.request.contract.objective
    && current.task.verification_status === 'pending' && equal(original, after)
}

export async function applyOperationFeedback({ proposalBytes, expectedSha256, corpusBytes, reviewBytes, receiptBytes,
  env = process.env, now, timeoutMs = FEEDBACK_ADMISSION_LIMITS.timeoutMs }, dependencies = {}) {
  const native = { ...defaults, ...dependencies }
  const remaining = deadline(timeoutMs)
  const clock = dependencies.clock ?? (() => now ?? new Date())
  const result = { schema_version: 1, kind: 'ecorp-feedback-application-receipt', checked_at: iso(clock()), status: 'refused-before-effect',
    proposal_sha256: sha(bounded(proposalBytes)), mutation_requests: 0, launched: false, native_revision_id: null,
    source_check_non_atomic: true, production_identity_verified: false, independent_review_verified: false }
  let proposal, sourceOptions
  try {
    requireThat(isHash(expectedSha256) && result.proposal_sha256 === expectedSha256, 'proposal_byte_hash_mismatch')
    proposal = parse(proposalBytes)
    requireThat(Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`).equals(proposalBytes), 'proposal_encoding_changed')
    requireThat(proposal.state === 'ready-for-review' && proposal.kind === 'ecorp-feedback-contract-proposal', 'proposal_not_ready')
    requireThat(Date.parse(proposal.created_at) <= Date.parse(result.checked_at) && Date.parse(result.checked_at) < Date.parse(proposal.expires_at)
      && Date.parse(proposal.expires_at) - Date.parse(proposal.created_at) <= FEEDBACK_ADMISSION_LIMITS.maximumAgeMs, 'proposal_expired_or_future')
    for (const [key, bytes] of [['corpus', corpusBytes], ['review', reviewBytes], ['receipt', receiptBytes]]) {
      requireThat(sha(bounded(bytes)) === proposal.inputs[`${key}_sha256`], 'input_bytes_changed')
    }
    sourceOptions = { receiptBytes, artifactId: proposal.inputs.artifact_id, artifactPath: proposal.inputs.artifact_path, env }
    const source = await checkedSource({ ...sourceOptions, timeoutMs: remaining() }, native)
    const rebuilt = buildFeedbackProposal({ corpusBytes, reviewBytes, receiptBytes, sourceArtifactBytes: source.bytes,
      artifactId: proposal.inputs.artifact_id, artifactPath: proposal.inputs.artifact_path, selectedRuleIds: proposal.inputs.selected_rule_ids, target: proposal.target,
      now: proposal.created_at, ttlMs: Date.parse(proposal.expires_at) - Date.parse(proposal.created_at),
      idempotencyKey: proposal.idempotency_key, requireIndependentReview: proposal.inputs.require_independent_review }, native)
    requireThat(equal(proposal, rebuilt), 'proposal_contents_changed')
    // Current expiry is independent of the byte-stable proposal reconstruction.
    requireThat(proposal.selected.every(record => Date.parse(record.expires_at) > Date.parse(result.checked_at)), 'rule_expired')
    const target = await native.readTarget({ env, timeoutMs: remaining(), missionId: proposal.target.mission.id, taskId: proposal.target.task.id })
    targetEligible(target, source.receipt)
    const exactBefore = equal(targetState(target), proposal.target)
    const exactReplay = !exactBefore && unchangedAfterRevision(proposal, target)
      && target.revisions.filter(revision => expectedRevision(proposal, revision)).length === 1
    requireThat(exactBefore || exactReplay, 'target_changed')
    const atWrite = Date.parse(iso(clock()))
    requireThat(atWrite < Date.parse(proposal.expires_at) && proposal.selected.every(record => atWrite < Date.parse(record.expires_at)), 'expired_before_revision')
    remaining()
    result.source_before_fingerprint_sha256 = operations.operationReceiptFingerprint(source.receipt)
    result.idempotency_key = proposal.idempotency_key
    result.request_sha256 = digest(proposal.request)
  } catch (error) { return { ...result, error: safeCode(error) } }
  let response
  try {
    const postTimeoutMs = remaining()
    result.mutation_requests = 1
    response = await native.revise({ env, timeoutMs: postTimeoutMs, corpId: proposal.target.corp_id, missionId: proposal.target.mission.id, body: clone(proposal.request) })
  } catch (error) {
    if (result.mutation_requests === 0) return { ...result, error: safeCode(error) }
    // HTTP status does not establish the transaction stage. In particular, the
    // native API can map an ambiguous commit failure to 400 after persistence.
    return { ...result, status: 'outcome-unknown',
      native_http_status: Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? error.httpStatus : null,
      error: 'native_revision_not_confirmed', reconciliation: 'Preserve this exact request and idempotency key; no automatic retry or launch.' }
  }
  try {
    requireThat(typeof response?.replayed === 'boolean' && expectedRevision(proposal, response.revision) && isUuid(response.revision.id), 'native_revision_mismatch')
    result.native_revision_id = response.revision.id
    result.native_revision_version = response.revision.version
    result.replayed = response.replayed
    result.response_sha256 = digest(response)
    const target = await native.readTarget({ env, timeoutMs: remaining(), missionId: proposal.target.mission.id, taskId: proposal.target.task.id })
    requireThat(unchangedAfterRevision(proposal, target), 'target_changed_after_revision')
  } catch { return { ...result, status: 'outcome-unknown', error: 'native_revision_readback_not_confirmed' } }
  try {
    const source = await checkedSource({ ...sourceOptions, timeoutMs: remaining() }, native)
    const binding = bindFeedbackCorpusArtifact({ receipt: source.receipt, artifactId: proposal.inputs.artifact_id,
      artifactPath: proposal.inputs.artifact_path, artifactBytes: source.bytes, corpusBytes })
    requireThat(equal(binding, proposal.source.corpus_binding), 'source_artifact_changed')
    requireThat(proposal.selected.every(record => Date.parse(iso(clock())) < Date.parse(record.expires_at)), 'rule_expired_after_revision')
    result.source_after_fingerprint_sha256 = operations.operationReceiptFingerprint(source.receipt)
  } catch { return { ...result, status: 'applied-but-source-changed', error: 'source_readback_changed_or_unavailable' } }
  return { ...result, status: 'applied', authority: 'Native actor-authorized reference-only contract revision; no launch or future authority.' }
}

export function readFeedbackFile(file, expectedSha256) {
  requireThat(typeof file === 'string' && path.isAbsolute(file), 'absolute_input_path_required')
  let descriptor
  try {
    requireThat(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'input_not_regular')
    descriptor = openSync(file, 'r')
    const stat = fstatSync(descriptor)
    requireThat(stat.isFile() && stat.size > 0 && stat.size <= FEEDBACK_ADMISSION_LIMITS.bytes, 'unbounded_input')
    const buffer = Buffer.alloc(stat.size + 1), length = readSync(descriptor, buffer, 0, buffer.length, 0)
    requireThat(length === stat.size, 'input_changed_during_read')
    const bytes = buffer.subarray(0, length)
    if (expectedSha256 !== undefined) requireThat(isHash(expectedSha256) && sha(bytes) === expectedSha256, 'input_byte_hash_mismatch')
    return bytes
  } catch (error) { throw error instanceof FeedbackAdmissionError ? error : new FeedbackAdmissionError('input_unreadable') }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}
function reserveOutput(file) {
  requireThat(typeof file === 'string' && path.isAbsolute(file), 'absolute_output_path_required')
  const parent = path.dirname(file), normalized = value => process.platform === 'win32' ? value.toLowerCase() : value
  requireThat(normalized(realpathSync(parent)) === normalized(parent), 'redirected_output_parent')
  return openSync(file, 'wx', 0o600)
}
function writeOutput(descriptor, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  bounded(bytes)
  writeFileSync(descriptor, bytes)
  return sha(bytes)
}
export function renderFeedbackProposal(proposal) {
  if (proposal.state !== 'ready-for-review') return `Feedback remains candidate: ${proposal.reasons.join(', ')}. No native mutation.\n`
  return `Review advisory references for mission ${proposal.target.mission.id}, task ${proposal.target.task.id}.\n\nSource run: ${proposal.source.scope.run_id}\nCorpus: ${proposal.corpus_digest}\nExpected contract version: ${proposal.request.expected_contract_version}\nExpires: ${proposal.expires_at}\n\nExisting references:\n~~~json\n${JSON.stringify(proposal.target.task.contract.references, null, 2)}\n~~~\n\nOnly these references will be appended:\n~~~json\n${JSON.stringify(proposal.reference_suffix, null, 2)}\n~~~\n\nAll other task fields and verifier policy stay unchanged. Application is a native contract revision; launch remains separate. Local review hashes do not prove independent or production identity. Source observation and revision are non-atomic. The bounded snapshot shows no target run; only the native endpoint can recheck full historical run state during admission.\n`
}
// A valid candidate is a successful preparation report, not successful adoption.
// Apply uses 0 only for confirmed application; 2 means pre-effect refusal and 3
// means an uncertain or applied-but-changed outcome requiring reconciliation.
export function feedbackCommandExitCode(command, result) {
  if (command === 'prepare') return ['candidate', 'ready-for-review'].includes(result.state) ? 0 : 1
  if (command === 'apply') return result.status === 'applied' ? 0 : result.status === 'refused-before-effect' ? 2 : 3
  return 1
}
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  requireThat(Array.isArray(argv) && argv.every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\r\n\0]/u.test(value)), 'invalid_arguments')
  const command = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'prepare'
  const allowed = command === 'prepare' ? ['corpus', 'corpus-sha256', 'review', 'review-sha256', 'receipt', 'receipt-sha256', 'artifact-id', 'artifact-path', 'rule-ids', 'mission-id', 'task-id', 'out']
    : command === 'apply' ? ['proposal', 'sha256', 'corpus', 'review', 'receipt', 'out'] : []
  requireThat(allowed.length > 0 && argv.length % 2 === 0, 'invalid_arguments')
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].slice(2)
    requireThat(argv[index].startsWith('--') && allowed.includes(key) && !Object.hasOwn(args, key) && argv[index + 1], 'invalid_arguments')
    args[key] = argv[index + 1]
  }
  requireThat(allowed.filter(key => key !== 'artifact-path').every(key => Object.hasOwn(args, key)), 'missing_arguments')
  let descriptor, reviewDescriptor
  try {
    // Reserve receipts before any network request. An existing/unwritable result
    // destination must not cause a mutation whose local outcome cannot be saved.
    descriptor = reserveOutput(args.out)
    if (command === 'prepare') reviewDescriptor = reserveOutput(`${args.out}.md`)
    const common = { env: dependencies.env ?? process.env, ...(dependencies.clock ? { now: dependencies.clock() } : {}) }
    const result = command === 'prepare'
      ? await prepareOperationFeedback({ ...common, corpusBytes: readFeedbackFile(args.corpus, args['corpus-sha256']), reviewBytes: readFeedbackFile(args.review, args['review-sha256']),
        receiptBytes: readFeedbackFile(args.receipt, args['receipt-sha256']), artifactId: args['artifact-id'], artifactPath: args['artifact-path'] ?? null, selectedRuleIds: args['rule-ids'].split(','),
        missionId: args['mission-id'], taskId: args['task-id'] }, dependencies)
      : await applyOperationFeedback({ ...common, proposalBytes: readFeedbackFile(args.proposal, args.sha256), expectedSha256: args.sha256,
        corpusBytes: readFeedbackFile(args.corpus), reviewBytes: readFeedbackFile(args.review), receiptBytes: readFeedbackFile(args.receipt) }, dependencies)
    const outputHash = writeOutput(descriptor, result)
    if (reviewDescriptor !== undefined) writeFileSync(reviewDescriptor, renderFeedbackProposal(result))
    return { status: result.state ?? result.status, output_sha256: outputHash, mutation_requests: result.mutation_requests ?? 0,
      launched: false, exit_code: feedbackCommandExitCode(command, result) }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (reviewDescriptor !== undefined) closeSync(reviewDescriptor)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.exit_code }).catch(error => {
    process.stderr.write(`${JSON.stringify({ error: safeCode(error), detail: 'Raw native responses, input content and credentials withheld.' })}\n`)
    process.exitCode = 1
  })
}
