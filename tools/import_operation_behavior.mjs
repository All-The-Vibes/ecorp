import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNativeBehaviorEvidence, feedbackDigest, proposeFeedback, FEEDBACK_LIMITS } from '../scenarios/repo-steward/lib/feedback.mjs'
import { saveNew } from '../scenarios/repo-steward/feedback.mjs'

export const BEHAVIOR_IMPORT_LIMITS = Object.freeze({ fileBytes: 1024 * 1024, manifestBytes: 65536,
  totalBytes: 8 * 1024 * 1024, manifests: FEEDBACK_LIMITS.maxEvidence })
const FILES = ['terminal', 'resume_intent', 'before_attestation', 'after_attestation', 'before_target', 'after_target', 'external_failure', 'external_checker']
const SELECTION = ['server_origin_sha256', 'corp_id', 'room_id', 'mission_id', 'task_id', 'run_id', 'connection_id',
  'repository', 'base_ref', 'base_commit', 'target', 'resume_event_id']
const HASH = /^[a-f0-9]{64}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
export class BehaviorImportError extends Error { constructor(code) { super(code); this.code = code } }
function need(condition, code) { if (!condition) throw new BehaviorImportError(code) }
function equal(a, b, code) { need(feedbackDigest(a) === feedbackDigest(b), code) }
function keys(value, expected) {
  need(object(value) && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k)), 'invalid_schema')
}
function validTime(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/u.test(value) && Number.isFinite(Date.parse(value)) }
function parse(bytes, maximum = BEHAVIOR_IMPORT_LIMITS.fileBytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, 'input_unbounded')
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value = JSON.parse(text)
    feedbackDigest(value)
    const stack = []
    for (const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/gu)) {
      if (token[0] === '{') stack.push(new Set())
      else if (token[0] === '[') stack.push(null)
      else if (token[0] === '}' || token[0] === ']') stack.pop()
      else if (/^\s*:/u.test(text.slice(token.index + token[0].length))) {
        const names = stack.at(-1), key = JSON.parse(token[0])
        need(names && !names.has(key), 'duplicate_json_key'); names.add(key)
      }
    }
    return value
  } catch (error) { if (error instanceof BehaviorImportError) throw error; throw new BehaviorImportError('invalid_json') }
}
function relative(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1000
    && value.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) && !part.endsWith('.')
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}
const normalized = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
function ordinaryParents(root) {
  need(typeof root === 'string' && path.isAbsolute(root), 'invalid_evidence_root')
  let current = path.resolve(root)
  for (;;) {
    const stat = lstatSync(current)
    need(stat.isDirectory() && !stat.isSymbolicLink() && normalized(realpathSync(current)) === normalized(current), 'redirected_evidence_path')
    const next = path.dirname(current); if (next === current) break; current = next
  }
}
function readPinned(root, ref, budget) {
  keys(ref, ['path', 'sha256'])
  need(relative(ref.path) && typeof ref.sha256 === 'string' && HASH.test(ref.sha256), 'invalid_file_pin')
  ordinaryParents(root)
  const resolved = path.resolve(root, ...ref.path.split('/'))
  need(path.relative(root, resolved) !== '' && !path.relative(root, resolved).startsWith('..'), 'file_outside_evidence_root')
  ordinaryParents(path.dirname(resolved))
  const before = lstatSync(resolved)
  need(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= BEHAVIOR_IMPORT_LIMITS.fileBytes
    && normalized(realpathSync(resolved)) === normalized(resolved), 'file_unbounded_or_redirected')
  budget.bytes += before.size; need(budget.bytes <= BEHAVIOR_IMPORT_LIMITS.totalBytes, 'total_input_unbounded')
  let fd
  try {
    fd = openSync(resolved, 'r')
    const opened = fstatSync(fd)
    need(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, 'file_changed')
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0, count
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count
    const after = fstatSync(fd), named = lstatSync(resolved)
    need(length === before.size && after.size === before.size && after.mtimeMs === opened.mtimeMs
      && named.dev === opened.dev && named.ino === opened.ino && !named.isSymbolicLink(), 'file_changed')
    const bytes = buffer.subarray(0, length)
    need(sha(bytes) === ref.sha256, 'file_hash_mismatch')
    return bytes
  } finally { if (fd !== undefined) closeSync(fd) }
}
function one(rows, predicate, code) {
  need(Array.isArray(rows) && rows.length <= 10000, code)
  const matches = rows.filter(predicate); need(matches.length === 1, code); return matches[0]
}

// A fixed byte comparison, not a command interpreter. It preserves the original
// prefix and EOL exactly and never imports or executes the retained checker file.
export function checkExactAppend({ before, after, marker, separatorNewlines }) {
  need(Buffer.isBuffer(before) && Buffer.isBuffer(after) && before.length > 0 && after.length > 0
    && before.length <= BEHAVIOR_IMPORT_LIMITS.fileBytes && after.length <= BEHAVIOR_IMPORT_LIMITS.fileBytes, 'target_unbounded')
  need(typeof marker === 'string' && marker.startsWith('// ') && marker.isWellFormed() && Buffer.byteLength(marker) <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(marker) && marker.trim() === marker, 'invalid_append_marker')
  need(separatorNewlines === 0 || separatorNewlines === 1, 'invalid_separator')
  let hasCRLF = false, hasLF = false
  for (let i = 0; i < before.length; i++) {
    if (before[i] === 13) { need(before[i + 1] === 10, 'mixed_or_invalid_eol'); hasCRLF = true; i++ }
    else if (before[i] === 10) hasLF = true
  }
  need(hasCRLF !== hasLF, 'mixed_or_invalid_eol')
  const eol = hasCRLF ? '\r\n' : '\n'
  need(before.at(-1) === 10 || separatorNewlines === 1, 'missing_separator')
  const expected = Buffer.concat([before, Buffer.from(eol.repeat(separatorNewlines) + marker + eol)])
  need(expected.length <= BEHAVIOR_IMPORT_LIMITS.fileBytes, 'target_unbounded')
  return { status: after.equals(expected) ? 'passed' : 'rejected', expected_sha256: sha(expected),
    before_sha256: sha(before), after_sha256: sha(after), prefix_preserved: after.subarray(0, before.length).equals(before),
    eol: hasCRLF ? 'CRLF' : 'LF', separator_newlines: separatorNewlines }
}

function createEvidence(options, budget) {
  const { manifestBytes, expectedManifestSha256, evidenceRoot } = options
  need(typeof expectedManifestSha256 === 'string' && HASH.test(expectedManifestSha256), 'invalid_manifest_pin')
  const manifest = parse(manifestBytes, BEHAVIOR_IMPORT_LIMITS.manifestBytes)
  need(sha(manifestBytes) === expectedManifestSha256, 'manifest_hash_mismatch')
  keys(manifest, ['schema_version', 'kind', 'scope', 'rule', 'selection', 'files', 'check'])
  need(manifest.schema_version === 1 && manifest.kind === 'ecorp-retained-operation-behavior', 'unsupported_manifest')
  keys(manifest.selection, SELECTION); keys(manifest.files, FILES)
  keys(manifest.check, ['kind', 'marker', 'separator_newlines', 'instruction_alignment'])
  need(manifest.check.kind === 'exact-append-v1' && manifest.check.instruction_alignment === 'not-reviewed', 'unsupported_check')
  const s = manifest.selection
  for (const k of ['corp_id', 'room_id', 'mission_id', 'task_id', 'run_id', 'connection_id', 'resume_event_id'])
    need(typeof s[k] === 'string' && UUID.test(s[k]), 'invalid_native_selection')
  need(typeof s.server_origin_sha256 === 'string' && HASH.test(s.server_origin_sha256) && relative(s.target), 'invalid_native_selection')
  const bytes = Object.fromEntries(FILES.map(name => [name, readPinned(evidenceRoot, manifest.files[name], budget)]))
  const terminal = parse(bytes.terminal), intent = parse(bytes.resume_intent), before = parse(bytes.before_attestation), after = parse(bytes.after_attestation), external = parse(bytes.external_failure)
  const { mission, task, run } = terminal
  need(object(mission) && object(task) && object(run), 'missing_native_records')
  equal([mission.corp_id, task.corp_id, run.corp_id], [s.corp_id, s.corp_id, s.corp_id], 'native_corp_mismatch')
  equal([mission.id, mission.room_id, task.mission_id, task.id, run.task_id, run.id],
    [s.mission_id, s.room_id, s.mission_id, s.task_id, s.task_id, s.run_id], 'native_lineage_mismatch')
  equal([run.source_repository, run.source_base_ref, run.source_base_commit, run.workspace_connection_id],
    [s.repository, s.base_ref, s.base_commit, s.connection_id], 'native_source_mismatch')
  const contract = task.contract, policy = task.verification_policy
  need(object(contract) && object(policy) && Array.isArray(policy.checks) && policy.checks.length > 0 && policy.checks.length <= 16, 'native_contract_unavailable')
  equal([contract.source_repository, contract.source_base_ref, contract.source_base_commit, contract.workspace_connection_id],
    [s.repository, s.base_ref, s.base_commit, s.connection_id], 'contract_source_mismatch')
  need(run.status === 'completed' && run.verification_status === 'passed' && run.execution_mode === 'provider', 'native_acceptance_not_observed')
  need(Array.isArray(contract.write_scope) && contract.write_scope.includes(s.target), 'target_outside_contract')
  const event = one(terminal.events, e => e.id === s.resume_event_id, 'resume_event_unavailable')
  need(event.type === 'run.resume_requested' && event.aggregate_id === s.run_id && event.corp_id === s.corp_id
    && event.room_id === s.room_id && event.payload?.task_id === s.task_id
    && event.payload.source_run_id === run.resumed_from_run_id && event.payload.runner_id === run.runner_id, 'resume_event_mismatch')
  need(typeof run.resumed_from_run_id === 'string' && UUID.test(run.resumed_from_run_id), 'resume_source_missing')
  need(intent.method === 'POST' && intent.route === `/api/corps/${s.corp_id}/runs/${run.resumed_from_run_id}/resume`
    && intent.body?.requested_by === event.actor_id && typeof intent.body.prompt === 'string' && intent.body.prompt.length > 0
    && Buffer.byteLength(intent.body.prompt) <= 100000 && intent.body.prompt.includes(manifest.check.marker)
    && intent.body.prompt.includes(s.target), 'resume_instruction_mismatch')
  need(validTime(intent.at) && validTime(event.created_at) && Date.parse(event.created_at) >= Date.parse(intent.at), 'resume_time_mismatch')
  for (const [name, attestation, target] of [['before', before, bytes.before_target], ['after', after, bytes.after_target]]) {
    need(attestation.workspace === run.workspace_path && attestation.branch === run.workspace_branch
      && attestation.head_commit === s.base_commit && typeof attestation.native_git_blob === 'string'
      && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(attestation.native_git_blob), `${name}_source_binding_mismatch`)
    need(attestation.raw?.sha256 === sha(target) && attestation.raw?.bytes === target.length, `${name}_physical_binding_mismatch`)
  }
  equal([before.git_common_directory, before.worktree_registration_sha256], [after.git_common_directory, after.worktree_registration_sha256], 'workspace_identity_changed')
  const checks = terminal.evidence
  need(Array.isArray(checks) && checks.length === policy.checks.length, 'native_checks_incomplete')
  let targetBinding = 'retained-workspace-only', sawTargetCheck = false
  for (let index = 0; index < policy.checks.length; index++) {
    const check = one(checks, c => c.check_index === index, 'native_check_ambiguous')
    need(check.run_id === s.run_id && check.task_id === s.task_id && check.corp_id === s.corp_id
      && check.status === 'passed' && check.kind === policy.checks[index].type, 'native_check_mismatch')
    if (check.kind === 'test') {
      need(check.payload?.exit_code === 0, 'native_test_failed')
      equal(check.payload.args, policy.checks[index].args, 'native_test_policy_mismatch')
      equal(check.payload.program, policy.checks[index].program, 'native_test_policy_mismatch')
      if (check.payload.args.includes(s.target)) {
        sawTargetCheck = true
        const result = parse(Buffer.from(check.payload.stdout ?? ''))
        need(Number.isSafeInteger(result.total) && result.total > 0 && result.total <= 10000
          && result.passed === result.total && result.failed === 0 && Array.isArray(result.results)
          && result.results.length === result.total && result.results.every(r => r.status === 'passed')
          && new Set(result.results.map(r => r.id)).size === result.total, 'native_oracle_incomplete')
        need(typeof result.target === 'string' && normalized(result.target) === normalized(path.join(run.workspace_path, s.target)), 'native_oracle_target_mismatch')
        if (Object.hasOwn(result, 'infrastructure_error')) need(result.infrastructure_error === false, 'native_oracle_infrastructure_error')
        if (Object.hasOwn(result, 'target_sha256')) { need(result.target_sha256 === sha(bytes.after_target), 'native_oracle_bytes_mismatch'); targetBinding = 'sha256' }
      }
    }
  }
  need(sawTargetCheck, 'native_target_check_unavailable')
  need(external.error === 'Stale control is not the exact authorized append' && external.automatic_retry === false
    && validTime(external.at) && validTime(run.updated_at) && Date.parse(external.at) >= Date.parse(run.updated_at), 'external_failure_unavailable')
  const checked = checkExactAppend({ before: bytes.before_target, after: bytes.after_target, marker: manifest.check.marker, separatorNewlines: manifest.check.separator_newlines })
  need(checked.status === 'rejected', 'external_rejection_not_reproduced')
  return createNativeBehaviorEvidence({ scope: manifest.scope, rule: manifest.rule, capturedAt: external.at,
    native: { ...s, resumed_from_run_id: run.resumed_from_run_id, actor_id: event.actor_id, agent_id: run.agent_id, runner_id: run.runner_id,
      contract_version: task.contract_version, contract_sha256: feedbackDigest(contract), verification_policy_sha256: feedbackDigest(policy),
      resume_prompt_sha256: sha(Buffer.from(intent.body.prompt)), verification_sha256: run.verification_sha256,
      deliverable_sha256: run.deliverable_sha256, native_check_count: checks.length },
    behavior: { check: 'exact-append-v1', manifest_sha256: expectedManifestSha256, expected_sha256: checked.expected_sha256,
      native_outcome: 'completed', native_verification: 'passed', external_outcome: 'rejected', instruction_alignment: 'not-reviewed',
      native_test_target_binding: targetBinding, before_git_blob: before.native_git_blob, after_git_blob: after.native_git_blob,
      worktree_registration_sha256: before.worktree_registration_sha256 }, filesSha256: Object.fromEntries(FILES.map(name => [name, sha(bytes[name])])) })
}

export function createOperationBehaviorEvidence(options) { return createEvidence(options, { bytes: 0 }) }
function importWithBudget({ manifests, evidenceRoot, corpus, guidance, expiresAt, now = new Date() }, budget, manifestsCounted = false) {
  need(Array.isArray(manifests) && manifests.length > 0 && manifests.length <= BEHAVIOR_IMPORT_LIMITS.manifests, 'manifest_count_unbounded')
  const evidence = manifests.map(m => {
    keys(m, ['bytes', 'sha256'])
    need(Buffer.isBuffer(m.bytes), 'input_unbounded')
    if (!manifestsCounted) { budget.bytes += m.bytes.length; need(budget.bytes <= BEHAVIOR_IMPORT_LIMITS.totalBytes, 'total_input_unbounded') }
    return createEvidence({ manifestBytes: m.bytes, expectedManifestSha256: m.sha256, evidenceRoot }, budget)
  })
  need(evidence.every(e => e.rule === evidence[0].rule), 'behavior_rule_mismatch')
  return proposeFeedback({ corpus, rule: evidence[0].rule, guidance, evidence, expiresAt, now })
}
export function importOperationBehavior(options) { return importWithBudget(options, { bytes: 0 }) }

// The input request pins an existing corpus and one to eight manifests relative
// to the selected root: {schema_version:1, corpus:{path,sha256}, manifests:[...],
// guidance:{text,route}, expires_at}. Only a new candidate corpus is written.
export function main(argv = process.argv.slice(2), { now = new Date() } = {}) {
  const args = {}, names = new Set(['input', 'sha256', 'evidence-root', 'out'])
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.slice(2)
    need(argv[i]?.startsWith('--') && names.has(name) && !Object.hasOwn(args, name) && typeof argv[i + 1] === 'string' && argv[i + 1].length > 0, 'invalid_arguments')
    args[name] = argv[i + 1]
  }
  need(Object.keys(args).length === names.size && path.isAbsolute(args.input) && path.isAbsolute(args.out) && path.isAbsolute(args['evidence-root']), 'invalid_arguments')
  const evidenceRoot = path.resolve(args['evidence-root']), budget = { bytes: 0 }
  const inputRelative = path.relative(evidenceRoot, args.input).split(path.sep).join('/')
  const request = parse(readPinned(evidenceRoot, { path: inputRelative, sha256: args.sha256 }, budget), BEHAVIOR_IMPORT_LIMITS.manifestBytes)
  keys(request, ['schema_version', 'corpus', 'manifests', 'guidance', 'expires_at'])
  need(request.schema_version === 1 && Array.isArray(request.manifests) && request.manifests.length > 0
    && request.manifests.length <= BEHAVIOR_IMPORT_LIMITS.manifests, 'invalid_request')
  const corpus = parse(readPinned(evidenceRoot, request.corpus, budget))
  const manifests = request.manifests.map(ref => ({ bytes: readPinned(evidenceRoot, ref, budget), sha256: ref.sha256 }))
  const result = importWithBudget({ manifests, evidenceRoot, corpus, guidance: request.guidance, expiresAt: request.expires_at, now }, budget, true)
  const destination = saveNew(args.out, result.corpus)
  return { status: 'candidate-imported', output_file: destination, corpus_digest: result.corpusDigest,
    record_id: result.record.id, record_digest: result.recordDigest, evidence_ids: result.record.evidence.map(e => e.evidence_id),
    authority: 'none', activation_supported: false, native_mutations: 0, provider_invocations: 0 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(main(), null, 2) + '\n') }
  catch (error) { process.stderr.write(JSON.stringify({ error: error instanceof BehaviorImportError ? error.code : 'behavior_import_failed', detail: 'No native action performed; input details withheld.' }) + '\n'); process.exitCode = 1 }
}
