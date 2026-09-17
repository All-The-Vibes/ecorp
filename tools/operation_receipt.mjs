import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { probeConfiguration, readMcpSnapshot } from './probe_mcp.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const HASH = /^[0-9a-f]{64}$/u
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu
const MAX_METADATA_BYTES = 4 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_ARTIFACT_BYTES = 32 * 1024 * 1024
const fail = (message) => { throw new Error(message) }
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value) => Number.isSafeInteger(value) && value >= 0
// These are observed native metadata, never executable arguments or route parts.
// Rust native validation bounds runner/model strings at 128 UTF-8 bytes and
// source/publication refs at 240; it does not impose our former identifier alphabet.
const nativeText = (maximum) => (value) => typeof value === 'string' && value.isWellFormed()
  && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= maximum
const runnerName = nativeText(128)
const modelName = nativeText(128)
const sourceRef = nativeText(240)
const status = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
const isUuid = (value) => typeof value === 'string' && UUID.test(value)
const isHash = (value) => typeof value === 'string' && HASH.test(value)
const isCommit = (value) => typeof value === 'string' && COMMIT.test(value)
const repository = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(value)
const mediaType = (value) => typeof value === 'string' && /^[a-z0-9!#$%&'*+.^_`{|}~-]+\/[a-z0-9!#$%&'*+.^_`{|}~-]+$/u.test(value)
const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/u.test(value) && Number.isFinite(Date.parse(value))
const nullable = (predicate) => (value) => value === null || predicate(value)
const literal = (value) => (candidate) => candidate === value
const oneOf = (...values) => (value) => values.includes(value)
const list = (shape, maximum = 1000) => ({ list: shape, maximum })

const sourceShape = { repository: nullable(repository), base_ref: nullable(sourceRef), base_commit: nullable(isCommit) }
const schema = {
  schema_version: literal(1), kind: literal('ecorp-operation-receipt'), mode: oneOf('current-run', 'published-result'),
  checked_at: timestamp, duration_ms: integer,
  scope: { server_origin_sha256: isHash, corp_id: isUuid, actor_id: isUuid, room_id: isUuid, mission_id: isUuid, task_id: isUuid, run_id: isUuid },
  source: sourceShape,
  mission: { status, specification_version: integer, updated_at: timestamp },
  task: { status, contract_version: integer, attempt_count: integer, max_attempts: integer, assigned_agent_id: nullable(isUuid), updated_at: timestamp },
  run: { status, verification_status: status, agent_id: isUuid, runner_id: runnerName, model: nullable(modelName), execution_mode: status,
    created_at: timestamp, updated_at: timestamp, resumed_from_run_id: nullable(isUuid), verification_sha256: nullable(isHash),
    deliverable_sha256: nullable(isHash), is_latest_task_run: nullable((value) => typeof value === 'boolean') },
  origin: { kind: oneOf('direct', 'factory'), work_item_id: nullable(isUuid), repository: nullable(repository), issue_number: nullable(integer) },
  factory: { nullable: { id: isUuid, version: integer, state: status, source_revision_sha256: isHash, updated_at: timestamp } },
  publication: { nullable: { id: isUuid, version: integer, state: status, run_id: isUuid, task_id: isUuid, source_deliverable_id: isUuid,
    artifact_id: isUuid, commit_sha: isCommit, base_ref: sourceRef, recorded_pr_head_sha: nullable(isCommit), recorded_pr_state: nullable(oneOf('OPEN', 'CLOSED', 'MERGED')),
    updated_at: timestamp, matches_selected_run: (value) => typeof value === 'boolean' } },
  verification: {
    persisted_acceptance_observed: (value) => typeof value === 'boolean', expected_check_count: nullable((value) => integer(value) && value > 0 && value <= 16),
    automated_checks_complete: (value) => typeof value === 'boolean', automated_checks_passed: (value) => typeof value === 'boolean',
    evidence: list({ id: isUuid, check_index: integer, kind: status, status: oneOf('passed', 'failed'), exit_code: nullable(Number.isSafeInteger) }),
    manual_gate: { nullable: { gate_type: status, status, decided_by: nullable(isUuid), decided_at: nullable(timestamp) } },
  },
  artifacts: list({ id: isUuid, role: oneOf('provider_evidence', 'source_deliverable'), sha256: isHash, media_type: mediaType, bytes: (value) => integer(value) && value > 0,
    source_deliverable_id: nullable(isUuid), verification_sha256: nullable(isHash), base_commit: nullable(isCommit), head_commit: nullable(isCommit),
    byte_hash_verified: literal(true), signature_header_matches_record: literal(true), client_hmac_verified: literal(false) }, 8),
  lineage: { resume_run_ids: list(isUuid, 100), resume_chain_complete: (value) => typeof value === 'boolean', recovery_ids: list(isUuid, 100) },
  coverage: { verification_evidence: literal('bounded_excerpt'), events: literal('bounded_excerpt'), recoveries: literal('bounded_excerpt'),
    source_deliverables: oneOf('exact_factory_context', 'bounded_excerpt') },
  assurance: { read_only: literal(true), non_atomic: literal(true), observation_only: literal(true), authenticity_claim: literal(false), offline_authority: literal(false),
    production_identity_verified: literal(false), credential_delivery: oneOf('environment_reduced_assurance', 'not_supplied'),
    server_hmac_verification: literal('server_download_boundary'), client_hmac_verified: literal(false), remote_pr_rechecked: literal(false), future_authority_granted: literal(false) },
}

function checkShape(value, shape, field = 'receipt') {
  if (typeof shape === 'function') {
    if (!shape(value)) fail(`Invalid ${field}`)
  } else if (Object.hasOwn(shape, 'nullable')) {
    if (value !== null) checkShape(value, shape.nullable, field)
  } else if (Object.hasOwn(shape, 'list')) {
    if (!Array.isArray(value) || value.length > shape.maximum) fail(`Invalid ${field}`)
    value.forEach((item) => checkShape(item, shape.list, field))
  } else {
    if (!object(value) || Object.keys(value).length !== Object.keys(shape).length || Object.keys(value).some((key) => !Object.hasOwn(shape, key))) fail(`Invalid ${field} fields`)
    for (const [key, nested] of Object.entries(shape)) checkShape(value[key], nested, `${field}.${key}`)
  }
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function required(value, predicate, message) { if (!predicate(value)) fail(message); return value }
function uuid(value) { return required(value, isUuid, 'Invalid native identity').toLowerCase() }
function hash(value) { return required(value, isHash, 'Invalid native digest') }
function optionalHash(value) { return value == null ? null : hash(value) }
function commit(value) { return required(value, isCommit, 'Invalid native source commit') }
function same(a, b, message) { if (a !== b) fail(message) }
function unique(rows, id, message) {
  if (!Array.isArray(rows)) fail('Required native collection is unavailable')
  const matches = rows.filter((row) => typeof row?.id === 'string' && row.id.toLowerCase() === id)
  if (matches.length !== 1) fail(message)
  return matches[0]
}
function scoped(record, corpId) { same(uuid(record?.corp_id), corpId, 'Native Corp scope mismatch') }
function timeValue(value) {
  required(value, timestamp, 'Invalid native timestamp')
  const parts = value.match(/^(.*T\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/u)
  return BigInt(Date.parse(`${parts[1]}${parts[3]}`)) * 1_000_000n + BigInt((parts[2] ?? '').padEnd(9, '0') || '0')
}
function sourceTuple(run) {
  const source = { repository: run.source_repository ?? null, base_ref: run.source_base_ref ?? null, base_commit: run.source_base_commit ?? null }
  checkShape(source, sourceShape, 'source')
  if (Object.values(source).filter((value) => value !== null).length % 3 !== 0) fail('Partial native source tuple')
  if (source.repository) source.repository = source.repository.toLowerCase()
  return source
}
function issueUrl(value, repo, number, kind = 'issues') {
  if (!repository(repo) || !integer(number) || number < 1) fail('Invalid native GitHub source identity')
  same(typeof value === 'string' ? value.toLowerCase() : null, `https://github.com/${repo}/${kind}/${number}`.toLowerCase(), 'Native GitHub URL identity mismatch')
}

function verificationState(snapshot, run, task, mission, recoveries) {
  const rows = Array.isArray(snapshot.verification_evidence) ? snapshot.verification_evidence : []
  const evidence = rows.filter((item) => item?.run_id === run.id).map((item) => {
    scoped(item, run.corp_id)
    same(item.task_id, task.id, 'Verification task scope mismatch')
    return { id: uuid(item.id), check_index: item.check_index, kind: item.kind, status: item.status,
      exit_code: Number.isSafeInteger(item.payload?.exit_code) ? item.payload.exit_code : null }
  }).sort((a, b) => a.check_index - b.check_index || a.id.localeCompare(b.id))
  const counts = []
  for (const event of snapshot.events ?? []) {
    if (event?.aggregate_type !== 'run' || event.aggregate_id !== run.id || event.type !== 'run.verification_started') continue
    scoped(event, run.corp_id)
    same(event.room_id, mission.room_id, 'Verification event room scope mismatch')
    counts.push(event.payload?.check_count)
  }
  for (const recovery of recoveries) {
    if (recovery.replacement_run_id === run.id && Array.isArray(recovery.replacement_verification_policy?.checks)) counts.push(recovery.replacement_verification_policy.checks.length)
  }
  const usable = counts.length > 0 && counts.every((count) => Number.isSafeInteger(count) && count > 0 && count <= 16 && count === counts[0])
  const expected = usable ? counts[0] : null
  const complete = expected !== null && evidence.length === expected && evidence.every((item, index) => item.check_index === index)
  const decisions = (snapshot.verification_requests ?? []).filter((item) => item?.run_id === run.id)
  if (decisions.length > 1) fail('Ambiguous native verification decision')
  let manual = null
  if (decisions.length) {
    const decision = decisions[0]
    scoped(decision, run.corp_id)
    same(decision.task_id, task.id, 'Verification decision scope mismatch')
    manual = { gate_type: decision.gate_type, status: decision.status, decided_by: decision.decided_by ?? null, decided_at: decision.decided_at ?? null }
  }
  return { persisted_acceptance_observed: run.status === 'completed' && run.verification_status === 'passed', expected_check_count: expected,
    automated_checks_complete: complete, automated_checks_passed: complete && evidence.every((item) => item.status === 'passed'), evidence, manual_gate: manual }
}

function publicationBinding(publication, deliverables, item, mission, origin, snapshot) {
  if (!publication) return null
  scoped(publication, mission.corp_id)
  same(publication.factory_work_item_id, item.id, 'Publication work-item mismatch')
  same(publication.mission_id, mission.id, 'Publication mission mismatch')
  same(publication.source_issue_number, origin.source_issue_number, 'Publication source issue mismatch')
  same(publication.source_issue_url?.toLowerCase(), origin.source_issue_url?.toLowerCase(), 'Publication source URL mismatch')
  const publicationRun = unique(snapshot.runs, uuid(publication.run_id), 'Publication run unavailable or ambiguous')
  const publicationTask = unique(snapshot.tasks, uuid(publication.task_id), 'Publication task unavailable or ambiguous')
  for (const record of [publicationRun, publicationTask]) scoped(record, mission.corp_id)
  same(publicationRun.task_id, publicationTask.id, 'Publication run task mismatch')
  same(publicationTask.mission_id, mission.id, 'Publication task mission mismatch')
  const selected = unique(deliverables, uuid(publication.source_deliverable_id), 'Publication deliverable unavailable or ambiguous')
  scoped(selected, mission.corp_id)
  for (const key of ['task_id', 'run_id', 'artifact_id']) same(selected[key], publication[key], 'Publication deliverable identity mismatch')
  same(selected.form, 'commit_branch', 'Publication has an unsupported deliverable form')
  same(selected.head_commit, publication.commit_sha, 'Publication source commit mismatch')
  if (publicationRun.verification_sha256 != null) same(selected.verification_sha256, publicationRun.verification_sha256, 'Publication run verifier mismatch')
  if (publicationRun.deliverable_sha256 != null) same(selected.sha256, publicationRun.deliverable_sha256, 'Publication run deliverable digest mismatch')
  const selectedSource = sourceTuple(publicationRun)
  if (selectedSource.base_commit) same(selected.base_commit, selectedSource.base_commit, 'Publication run source base mismatch')
  if (selectedSource.repository) same(selectedSource.repository, origin.source_repository.toLowerCase(), 'Publication run repository mismatch')
  const proof = publication.provenance
  if (![1, 2, 3].includes(proof?.schema_version)) fail('Publication provenance schema is unavailable')
  same(proof.factory_work_item_id, item.id, 'Publication provenance work-item mismatch')
  same(proof.mission_id, mission.id, 'Publication provenance mission mismatch')
  if (!Array.isArray(proof.run_ids) || !Array.isArray(proof.task_ids) || !proof.run_ids.includes(publication.run_id) || !proof.task_ids.includes(publication.task_id)) fail('Publication lineage mismatch')
  if (proof.source_issue !== undefined) {
    same(proof.source_issue?.number, origin.source_issue_number, 'Publication provenance issue mismatch')
    issueUrl(proof.source_issue?.url, origin.source_repository, origin.source_issue_number)
  }
  same(proof.verification_sha256, selected.verification_sha256, 'Publication verifier digest mismatch')
  for (const [key, value] of Object.entries({ id: selected.id, artifact_id: selected.artifact_id, sha256: selected.sha256,
    base_commit: selected.base_commit, head_commit: selected.head_commit, source_branch: selected.branch })) same(proof.deliverable?.[key], value, 'Publication signed-deliverable metadata mismatch')
  for (const [key, value] of Object.entries({ repository: publication.target_repository, base_ref: publication.base_ref,
    branch: publication.branch, commit: publication.commit_sha })) same(proof.target?.[key], value, 'Publication target mismatch')
  same(publication.target_repository?.toLowerCase(), origin.source_repository?.toLowerCase(), 'Publication repository mismatch')
  if (['pull_request_created', 'published'].includes(publication.state)) {
    issueUrl(publication.pull_request_url, origin.source_repository, publication.pull_request_number, 'pull')
    same(publication.pull_request_head_sha, publication.commit_sha, 'Recorded publication head mismatch')
    same(publication.pull_request_head_repository_owner?.toLowerCase(), origin.source_repository.split('/')[0].toLowerCase(), 'Recorded publication repository mismatch')
    same(publication.pull_request_is_cross_repository, false, 'Cross-repository publication is unsupported')
    for (const key of ['url', 'number', 'state', 'draft', 'head_sha', 'base_ref', 'head_repository_owner', 'is_cross_repository']) {
      same(proof.pull_request?.[key], publication[`pull_request_${key}`], 'Publication pull-request provenance mismatch')
    }
  }
  return publication
}

// Pure projection. Raw signatures are confined to private artifact references,
// never returned in the public receipt or included in an error message.
export function projectOperationState(payload, contexts, config, runId, mode = 'current-run') {
  const corpId = uuid(config.corpId), actorId = uuid(config.actorId)
  runId = uuid(runId)
  if (!['current-run', 'published-result'].includes(mode)) fail('Unsupported receipt mode')
  const snapshot = payload?.snapshot
  same(uuid(snapshot?.corp?.id), corpId, 'Snapshot Corp scope mismatch')
  const run = unique(snapshot.runs, runId, 'Requested run unavailable or ambiguous')
  const task = unique(snapshot.tasks, uuid(run.task_id), 'Run task unavailable or ambiguous')
  const mission = unique(snapshot.missions, uuid(task.mission_id), 'Run mission unavailable or ambiguous')
  for (const record of [run, task, mission]) scoped(record, corpId)
  const room = unique(snapshot.rooms, uuid(mission.room_id), 'Mission room unavailable or ambiguous')
  scoped(room, corpId)
  const agent = unique(snapshot.agents, uuid(run.agent_id), 'Run agent unavailable or ambiguous')
  scoped(agent, corpId)
  const peerRuns = snapshot.runs.filter((item) => item?.task_id === task.id)
  let latest = true
  for (const peer of peerRuns) {
    scoped(peer, corpId)
    if (peer.id === run.id) continue
    if (timeValue(peer.created_at) > timeValue(run.created_at)) latest = false
    else if (timeValue(peer.created_at) === timeValue(run.created_at) && latest !== false) latest = null
  }
  if (mode === 'current-run' && latest !== true) fail('Requested run is not an unambiguous current task run')
  if (mode === 'current-run' && task.assigned_agent_id != null) same(task.assigned_agent_id, run.agent_id, 'Current task producer differs from the selected run')
  const context = contexts.mission
  for (const [key, value] of Object.entries({ corp_id: corpId, actor_id: actorId, mission_id: mission.id, room_id: mission.room_id })) same(context?.[key], value, 'Exact mission context mismatch')
  const nativeOrigin = context.origin
  if (!['direct', 'factory'].includes(nativeOrigin?.kind)) fail('Native mission origin unavailable')
  let item = null, publication = null
  let deliverables = snapshot.source_deliverables ?? []
  const origin = { kind: nativeOrigin.kind, work_item_id: null, repository: null, issue_number: null }
  if (nativeOrigin.kind === 'factory') {
    item = contexts.publication?.work_item
    scoped(item, corpId)
    same(item.id, uuid(nativeOrigin.work_item_id), 'Exact Factory work-item mismatch')
    same(item.mission_id, mission.id, 'Factory mission mismatch')
    same(`${item.source_repository_owner}/${item.source_repository_name}`.toLowerCase(), nativeOrigin.source_repository?.toLowerCase(), 'Factory source repository mismatch')
    same(item.source_issue_number, nativeOrigin.source_issue_number, 'Factory issue mismatch')
    same(item.source_issue_url?.toLowerCase(), nativeOrigin.source_issue_url?.toLowerCase(), 'Factory source URL mismatch')
    issueUrl(nativeOrigin.source_issue_url, nativeOrigin.source_repository, nativeOrigin.source_issue_number)
    deliverables = contexts.publication.source_deliverables
    if (!Array.isArray(deliverables)) fail('Exact source deliverables are unavailable')
    publication = publicationBinding(contexts.publication.publication, deliverables, item, mission, nativeOrigin, snapshot)
    Object.assign(origin, { work_item_id: item.id, repository: nativeOrigin.source_repository.toLowerCase(), issue_number: nativeOrigin.source_issue_number })
  }
  if (mode === 'published-result' && (publication?.state !== 'published' || publication.run_id !== run.id || publication.task_id !== task.id)) fail('Requested run is not the exact recorded published result')
  const source = sourceTuple(run)
  if (origin.repository && source.repository) same(origin.repository, source.repository, 'Run source differs from Factory origin')
  const resumeIds = [], seen = new Set([run.id])
  let ancestorId = run.resumed_from_run_id, resumeComplete = true
  while (ancestorId != null) {
    uuid(ancestorId)
    if (seen.has(ancestorId) || resumeIds.length >= 100) fail('Invalid or excessive native resume lineage')
    seen.add(ancestorId)
    const found = snapshot.runs.filter((candidate) => candidate?.id === ancestorId)
    if (!found.length) { resumeComplete = false; break }
    if (found.length !== 1) fail('Ambiguous native resume lineage')
    const ancestor = found[0]
    scoped(ancestor, corpId)
    same(ancestor.task_id, task.id, 'Resume lineage crosses task scope')
    same(ancestor.agent_id, run.agent_id, 'Resume lineage crosses producer scope')
    resumeIds.push(ancestorId)
    ancestorId = ancestor.resumed_from_run_id
  }
  const recoveries = (snapshot.factory_verification_recoveries ?? []).filter((entry) => seen.has(entry?.source_run_id) || seen.has(entry?.replacement_run_id))
  for (const entry of recoveries) {
    scoped(entry, corpId)
    same(entry.task_id, task.id, 'Recovery task scope mismatch')
    same(entry.mission_id, mission.id, 'Recovery mission scope mismatch')
    if (item) same(entry.factory_work_item_id, item.id, 'Recovery Factory scope mismatch')
  }
  const artifactReferences = []
  const provider = [run.artifact_id, run.artifact_sha256, run.artifact_media_type, run.artifact_signature]
  if (provider.some((value) => value != null)) {
    if (provider.some((value) => value == null)) fail('Incomplete native artifact reference')
    artifactReferences.push({ id: uuid(run.artifact_id), role: 'provider_evidence', sha256: hash(run.artifact_sha256),
      media_type: required(run.artifact_media_type, mediaType, 'Invalid native artifact media type'), bytes: null, signature: hash(run.artifact_signature),
      source_deliverable_id: null, verification_sha256: null, base_commit: null, head_commit: null })
  }
  for (const entry of deliverables.filter((candidate) => candidate?.run_id === run.id)) {
    scoped(entry, corpId)
    same(entry.task_id, task.id, 'Source deliverable task mismatch')
    if (run.verification_sha256 != null) same(entry.verification_sha256, run.verification_sha256, 'Source deliverable verifier mismatch')
    if (run.deliverable_sha256 != null) same(entry.sha256, run.deliverable_sha256, 'Source deliverable run digest mismatch')
    if (source.base_commit) same(entry.base_commit, source.base_commit, 'Source deliverable base mismatch')
    artifactReferences.push({ id: uuid(entry.artifact_id), role: 'source_deliverable', sha256: hash(entry.sha256),
      media_type: required(entry.media_type, mediaType, 'Invalid source deliverable media type'), bytes: required(entry.bytes, (value) => integer(value) && value > 0, 'Invalid artifact byte length'),
      signature: hash(entry.provenance_signature), source_deliverable_id: uuid(entry.id), verification_sha256: hash(entry.verification_sha256),
      base_commit: commit(entry.base_commit), head_commit: entry.head_commit == null ? null : commit(entry.head_commit) })
  }
  if (artifactReferences.length > 8 || new Set(artifactReferences.map((entry) => entry.id)).size !== artifactReferences.length) fail('Ambiguous or excessive artifact references')
  artifactReferences.sort((a, b) => a.id.localeCompare(b.id))
  const body = {
    schema_version: 1, kind: 'ecorp-operation-receipt', mode,
    scope: { server_origin_sha256: digest(config.childEnv.CRONY_SERVER_HTTP), corp_id: corpId, actor_id: actorId, room_id: mission.room_id, mission_id: mission.id, task_id: task.id, run_id: run.id },
    source, mission: { status: mission.status, specification_version: mission.specification_version, updated_at: mission.updated_at },
    task: { status: task.status, contract_version: task.contract_version, attempt_count: task.attempt_count, max_attempts: task.max_attempts,
      assigned_agent_id: task.assigned_agent_id ?? null, updated_at: task.updated_at },
    run: { status: run.status, verification_status: run.verification_status, agent_id: run.agent_id, runner_id: run.runner_id, model: run.model ?? null,
      execution_mode: run.execution_mode, created_at: run.created_at, updated_at: run.updated_at, resumed_from_run_id: run.resumed_from_run_id ?? null,
      verification_sha256: optionalHash(run.verification_sha256), deliverable_sha256: optionalHash(run.deliverable_sha256), is_latest_task_run: latest },
    origin, factory: item ? { id: item.id, version: item.version, state: item.state,
      source_revision_sha256: digest(required(item.source_revision, nativeText(160), 'Invalid native source revision')),
      updated_at: item.updated_at } : null,
    publication: publication ? { id: publication.id, version: publication.version, state: publication.state, run_id: publication.run_id, task_id: publication.task_id,
      source_deliverable_id: publication.source_deliverable_id, artifact_id: publication.artifact_id, commit_sha: publication.commit_sha, base_ref: publication.base_ref,
      recorded_pr_head_sha: publication.pull_request_head_sha ?? null, recorded_pr_state: publication.pull_request_state?.toUpperCase() ?? null,
      updated_at: publication.updated_at, matches_selected_run: publication.run_id === run.id } : null,
    verification: verificationState(snapshot, run, task, mission, recoveries), artifacts: [],
    lineage: { resume_run_ids: resumeIds, resume_chain_complete: resumeComplete, recovery_ids: recoveries.map((entry) => uuid(entry.id)).sort() },
    coverage: { verification_evidence: 'bounded_excerpt', events: 'bounded_excerpt', recoveries: 'bounded_excerpt', source_deliverables: item ? 'exact_factory_context' : 'bounded_excerpt' },
    assurance: { read_only: true, non_atomic: true, observation_only: true, authenticity_claim: false, offline_authority: false,
      production_identity_verified: false, credential_delivery: config.childEnv.CRONY_ACCESS_TOKEN ? 'environment_reduced_assurance' : 'not_supplied',
      server_hmac_verification: 'server_download_boundary', client_hmac_verified: false, remote_pr_rechecked: false, future_authority_granted: false },
  }
  // Validate public primitive shapes before any artifact requests or public output.
  checkShape({ ...body, checked_at: new Date().toISOString(), duration_ms: 0 }, schema)
  return { body, artifactReferences, consistency: digest(canonical({ body, artifactReferences })) }
}

export function validateOperationReceipt(receipt) {
  checkShape(receipt, schema)
  if (![0, 3].includes(Object.values(receipt.source).filter((value) => value !== null).length)) fail('Receipt source tuple is incomplete')
  if (receipt.origin.kind === 'direct') {
    if (receipt.factory !== null || receipt.publication !== null || Object.entries(receipt.origin).some(([key, value]) => key !== 'kind' && value !== null)) fail('Direct receipt contains Factory context')
    same(receipt.coverage.source_deliverables, 'bounded_excerpt', 'Direct receipt coverage is inconsistent')
  } else {
    if (!receipt.factory || receipt.factory.id !== receipt.origin.work_item_id || !receipt.origin.repository || !receipt.origin.issue_number) fail('Receipt Factory origin binding is incomplete')
    if (receipt.source.repository) same(receipt.source.repository, receipt.origin.repository, 'Receipt source and Factory repositories differ')
    same(receipt.coverage.source_deliverables, 'exact_factory_context', 'Factory receipt coverage is inconsistent')
  }
  const ancestors = receipt.lineage.resume_run_ids
  if (new Set(ancestors).size !== ancestors.length || ancestors.includes(receipt.scope.run_id)) fail('Receipt resume lineage is cyclic or duplicated')
  if (receipt.run.resumed_from_run_id === null) {
    if (ancestors.length || !receipt.lineage.resume_chain_complete) fail('Receipt resume lineage contradicts the selected run')
  } else if (ancestors.length) same(ancestors[0], receipt.run.resumed_from_run_id, 'Receipt resume ancestor differs from the selected run')
  else if (receipt.lineage.resume_chain_complete) fail('Receipt claims complete missing resume lineage')
  if (new Set(receipt.lineage.recovery_ids).size !== receipt.lineage.recovery_ids.length) fail('Receipt recovery identities are duplicated')
  same(receipt.verification.persisted_acceptance_observed, receipt.run.status === 'completed' && receipt.run.verification_status === 'passed', 'Receipt contradicts persisted run state')
  const checks = receipt.verification.evidence, count = receipt.verification.expected_check_count
  if (new Set(checks.map((entry) => entry.id)).size !== checks.length) fail('Receipt check identities are duplicated')
  const complete = count !== null && checks.length === count && checks.every((item, index) => item.check_index === index)
  same(receipt.verification.automated_checks_complete, complete, 'Receipt check completeness is inconsistent')
  same(receipt.verification.automated_checks_passed, complete && checks.every((item) => item.status === 'passed'), 'Receipt check outcome is inconsistent')
  if (receipt.mode === 'current-run' && receipt.run.is_latest_task_run !== true) fail('Receipt is not an unambiguous current-run observation')
  if (receipt.mode === 'current-run' && receipt.task.assigned_agent_id !== null) same(receipt.task.assigned_agent_id, receipt.run.agent_id, 'Receipt current producer differs from the selected run')
  const artifacts = receipt.artifacts
  if (new Set(artifacts.map((entry) => entry.id)).size !== artifacts.length) fail('Receipt artifact identities are duplicated')
  const sourceIds = artifacts.filter((entry) => entry.role === 'source_deliverable').map((entry) => entry.source_deliverable_id)
  if (new Set(sourceIds).size !== sourceIds.length) fail('Receipt source-deliverable identities are duplicated')
  if (artifacts.reduce((total, entry) => total + entry.bytes, 0) > MAX_TOTAL_ARTIFACT_BYTES) fail('Receipt artifact bytes exceed their bounded allowance')
  for (const entry of artifacts) {
    if (entry.bytes > MAX_ARTIFACT_BYTES) fail('Receipt artifact bytes exceed their bounded allowance')
    if (entry.role === 'provider_evidence') {
      if ([entry.source_deliverable_id, entry.verification_sha256, entry.base_commit, entry.head_commit].some((value) => value !== null)) fail('Receipt provider artifact has source-deliverable fields')
    } else {
      if (entry.source_deliverable_id === null || entry.verification_sha256 === null || entry.base_commit === null) fail('Receipt source artifact binding is incomplete')
      if (receipt.source.base_commit) same(entry.base_commit, receipt.source.base_commit, 'Receipt artifact source base mismatch')
      if (receipt.run.verification_sha256) same(entry.verification_sha256, receipt.run.verification_sha256, 'Receipt artifact verifier mismatch')
      if (receipt.run.deliverable_sha256) same(entry.sha256, receipt.run.deliverable_sha256, 'Receipt artifact run digest mismatch')
    }
  }
  if (receipt.publication) same(receipt.publication.matches_selected_run, receipt.publication.run_id === receipt.scope.run_id, 'Receipt publication/run relation is inconsistent')
  if (receipt.publication?.matches_selected_run) same(receipt.publication.task_id, receipt.scope.task_id, 'Receipt publication task differs from the selected run')
  if (receipt.publication?.state === 'published') same(receipt.publication.recorded_pr_head_sha, receipt.publication.commit_sha, 'Receipt recorded publication head mismatch')
  if (receipt.mode === 'published-result') {
    const publication = receipt.publication
    if (!publication || publication.state !== 'published' || !publication.matches_selected_run || publication.task_id !== receipt.scope.task_id) fail('Receipt is not the selected recorded publication')
    const selected = receipt.artifacts.filter((entry) => entry.source_deliverable_id === publication.source_deliverable_id && entry.id === publication.artifact_id)
    if (selected.length !== 1 || selected[0].head_commit !== publication.commit_sha) fail('Receipt publication artifact binding is incomplete')
  }
  return receipt
}

// A consistency fingerprint, not a signature or offline authenticity proof.
export function operationReceiptFingerprint(receipt) {
  validateOperationReceipt(receipt)
  const { checked_at: _checked, duration_ms: _duration, assurance: _assurance, coverage: _coverage, ...stable } = receipt
  return digest(canonical(stable))
}

export function verifyArtifactBytes(reference, bytes, headers) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_ARTIFACT_BYTES) fail('Artifact body is outside the receipt byte limit')
  if (reference.bytes != null && bytes.length !== reference.bytes) fail('Artifact length differs from its native record')
  same(digest(bytes), reference.sha256, 'Artifact bytes do not match the native digest')
  same(headers.get('content-type'), reference.media_type, 'Artifact media type mismatch')
  same(headers.get('content-length'), String(bytes.length), 'Artifact response length mismatch')
  same(headers.get('etag'), `"${reference.sha256}"`, 'Artifact response ETag mismatch')
  same(headers.get('x-content-type-options'), 'nosniff', 'Artifact response lacks its content-type boundary')
  same(headers.get('x-crony-artifact-role'), reference.role, 'Artifact role mismatch')
  same(headers.get('x-crony-artifact-signature'), reference.signature, 'Artifact signature header does not match its native record')
  return { id: reference.id, role: reference.role, sha256: reference.sha256, media_type: reference.media_type, bytes: bytes.length,
    source_deliverable_id: reference.source_deliverable_id, verification_sha256: reference.verification_sha256, base_commit: reference.base_commit, head_commit: reference.head_commit,
    byte_hash_verified: true, signature_header_matches_record: true, client_hmac_verified: false }
}

async function boundedBody(response, limit) {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel()
    fail('Native response exceeds its bounded byte allowance')
  }
  if (!response.body) fail('Native response body is unavailable')
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > limit) fail('Native response exceeds its bounded byte allowance')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, length)
}

export async function exportOperationReceipt({ env = process.env, runId, mode = 'current-run', timeoutMs = 30_000 } = {}) {
  runId = uuid(runId)
  if (!['current-run', 'published-result'].includes(mode)) fail('Unsupported receipt mode')
  const config = probeConfiguration(env, timeoutMs)
  const started = Date.now(), deadline = started + timeoutMs
  const remaining = () => { const value = deadline - Date.now(); if (value < 100) fail('Operation receipt timed out'); return value }
  const request = async (route, limit) => {
    let response
    try {
      response = await fetch(`${config.childEnv.CRONY_SERVER_HTTP}${route}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(remaining()),
        headers: env.CRONY_ACCESS_TOKEN ? { authorization: `Bearer ${env.CRONY_ACCESS_TOKEN}` } : {} })
    } catch { fail('Native receipt read failed or timed out; response details withheld') }
    if (!response.ok) { await response.body?.cancel(); fail(`Native receipt read returned HTTP ${response.status}; response body withheld`) }
    try { return { bytes: await boundedBody(response, limit), headers: response.headers } } catch (error) {
      if (error.message?.includes('bounded byte allowance')) throw error
      fail('Native receipt body unavailable; response details withheld')
    }
  }
  const prefix = `/api/corps/${uuid(config.corpId)}`
  const query = `?actor_id=${uuid(config.actorId)}`
  const readJson = async (route) => {
    const result = await request(route, MAX_METADATA_BYTES)
    try { return JSON.parse(result.bytes.toString('utf8')) } catch { fail('Native receipt metadata is invalid JSON; body withheld') }
  }
  const capture = async () => {
    const { payload } = await readMcpSnapshot({ env, timeoutMs: remaining() })
    const run = unique(payload?.snapshot?.runs, runId, 'Requested run unavailable or ambiguous')
    const task = unique(payload.snapshot.tasks, uuid(run.task_id), 'Run task unavailable or ambiguous')
    const mission = await readJson(`${prefix}/missions/${uuid(task.mission_id)}/context${query}`)
    const publication = mission?.origin?.kind === 'factory'
      ? await readJson(`${prefix}/factory/work-items/${uuid(mission.origin.work_item_id)}/publication-context${query}`) : null
    return projectOperationState(payload, { mission, publication }, config, runId, mode)
  }
  const before = await capture()
  const artifacts = []
  let bytesRead = 0
  for (const reference of before.artifactReferences) {
    const limit = Math.min(MAX_ARTIFACT_BYTES, MAX_TOTAL_ARTIFACT_BYTES - bytesRead)
    if (limit < 1) fail('Receipt artifact budget is exhausted')
    const response = await request(`${prefix}/artifacts/${uuid(reference.id)}${query}`, limit)
    artifacts.push(verifyArtifactBytes(reference, response.bytes, response.headers))
    bytesRead += response.bytes.length
  }
  const after = await capture()
  same(before.consistency, after.consistency, 'Native operation changed during receipt collection; retry with current authority')
  remaining()
  return validateOperationReceipt({ ...before.body, artifacts, checked_at: new Date().toISOString(), duration_ms: Date.now() - started })
}

async function main() {
  const args = process.argv.slice(2)
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const key = { '--run-id': 'runId', '--mode': 'mode', '--output': 'output', '--timeout-ms': 'timeoutMs' }[args[index]]
    if (!key || !args[index + 1] || Object.hasOwn(options, key)) fail('Usage: node tools/operation_receipt.mjs --run-id UUID --output NEW_FILE [--mode current-run|published-result] [--timeout-ms 30000]')
    options[key] = key === 'timeoutMs' ? Number(args[++index]) : args[++index]
  }
  if (!options.output) fail('A create-only output file is required')
  const receipt = await exportOperationReceipt(options)
  try { await writeFile(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) } catch {
    fail('Could not create the receipt output; existing files are never overwritten')
  }
  process.stdout.write(`${JSON.stringify({ kind: receipt.kind, run_id: receipt.scope.run_id, fingerprint: operationReceiptFingerprint(receipt), observation_only: true })}\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Operation receipt failed; native response bodies, credentials and private paths were withheld.\n'); process.exitCode = 1 })
}
