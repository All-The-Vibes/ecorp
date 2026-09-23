import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkExactAppend, createOperationBehaviorEvidence, importOperationBehavior, main } from './import_operation_behavior.mjs'
import { createFeedbackCorpus, feedbackDigest, reviewFeedback, validateFeedbackCorpus } from '../scenarios/repo-steward/lib/feedback.mjs'
import { SCOPE } from '../scenarios/repo-steward/lib/common.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = '2026-09-18T12:00:00.000Z', now = new Date('2026-09-18T12:10:00.000Z'), expiresAt = '2026-09-19T12:10:00.000Z'
const guidance = { text: 'Check exact output transformations against the prospective instruction and verifier.', route: 'inspect-evidence' }

function fixture(t, { runNumber = 7, eol = '\r\n', targetHash = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ecorp-behavior-test-'))
  t.after(() => {
    const resolved = realpathSync(root)
    assert.equal(path.dirname(resolved).toLowerCase(), realpathSync(os.tmpdir()).toLowerCase())
    assert.ok(path.basename(resolved).startsWith('ecorp-behavior-test-'))
    rmSync(resolved, { recursive: true })
  })
  const target = 'src/module.mjs', marker = '// controlled append', commit = 'a'.repeat(40), source = 'local/retained-case'
  const beforeBytes = Buffer.from(`export const value = 1;${eol}`), afterBytes = Buffer.concat([beforeBytes, Buffer.from(`${eol}${marker}${eol}`)])
  const workspace = path.join(root, 'workspace'), branch = 'crony/task-fixture/run-fixture'
  const selection = { server_origin_sha256: sha('http://127.0.0.1:19999'), corp_id: id(1), room_id: id(2), mission_id: id(3),
    task_id: id(4), run_id: id(runNumber), connection_id: id(5), repository: source, base_ref: 'HEAD', base_commit: commit,
    target, resume_event_id: id(6) }
  const contract = { source_repository: source, source_base_ref: 'HEAD', source_base_commit: commit, workspace_connection_id: id(5),
    objective: 'Preserve the approved source and scoped output.', allowed_tools: ['filesystem'], write_scope: [target] }
  const policy = { checks: [{ type: 'test', program: 'node', args: ['fixed-oracle.mjs', target], timeout_ms: 30000 }], manual_gate: null }
  const oracle = { oracle: 'fixture-oracle', target: path.join(workspace, target), total: 2, passed: 2, failed: 0,
    results: [{ id: 'one', status: 'passed' }, { id: 'two', status: 'passed' }],
    ...(targetHash ? { target_sha256: sha(afterBytes), infrastructure_error: false } : {}) }
  const terminal = {
    mission: { id: id(3), corp_id: id(1), room_id: id(2), status: 'completed' },
    task: { id: id(4), mission_id: id(3), corp_id: id(1), contract, contract_version: 2, verification_policy: policy, status: 'completed' },
    run: { id: id(runNumber), corp_id: id(1), task_id: id(4), agent_id: id(8), runner_id: 'retained-runner',
      source_repository: source, source_base_ref: 'HEAD', source_base_commit: commit, workspace_connection_id: id(5),
      status: 'completed', verification_status: 'passed', execution_mode: 'provider', resumed_from_run_id: id(9),
      workspace_path: workspace, workspace_branch: branch, verification_sha256: 'b'.repeat(64), deliverable_sha256: 'c'.repeat(64), updated_at: at },
    events: [{ id: id(6), type: 'run.resume_requested', aggregate_id: id(runNumber), corp_id: id(1), room_id: id(2), actor_id: id(10),
      created_at: at, payload: { task_id: id(4), source_run_id: id(9), runner_id: 'retained-runner' } }],
    evidence: [{ id: id(11), corp_id: id(1), task_id: id(4), run_id: id(runNumber), check_index: 0, kind: 'test', status: 'passed',
      payload: { exit_code: 0, program: 'node', args: policy.checks[0].args, stdout: JSON.stringify(oracle) } }],
  }
  const intent = { method: 'POST', route: `/api/corps/${id(1)}/runs/${id(9)}/resume`, at,
    body: { requested_by: id(10), prompt: `Append ${marker} to ${target}; preserve the original bytes.` } }
  const attest = bytes => ({ workspace, branch, head_commit: commit, git_common_directory: path.join(root, 'git'),
    worktree_registration_sha256: 'd'.repeat(64), native_git_blob: sha(bytes).slice(0, 40), raw: { sha256: sha(bytes), bytes: bytes.length } })
  const documents = { terminal, resume_intent: intent, before_attestation: attest(beforeBytes), after_attestation: attest(afterBytes),
    before_target: beforeBytes, after_target: afterBytes, external_failure: { at, error: 'Stale control is not the exact authorized append', automatic_retry: false },
    external_checker: Buffer.from('throw new Error("Retained checker must never execute");\n') }
  const manifest = { schema_version: 1, kind: 'ecorp-retained-operation-behavior', scope: { repository: SCOPE.repository, repository_id: SCOPE.repository_id, project_id: SCOPE.project_id },
    rule: 'NATIVE_APPEND_CONTRACT_GAP', selection, files: {}, check: { kind: 'exact-append-v1', marker, separator_newlines: 0, instruction_alignment: 'not-reviewed' } }
  function write(name, value = documents[name]) {
    documents[name] = value
    const bytes = Buffer.isBuffer(value) ? value : encoded(value), file = `${name}.data`
    writeFileSync(path.join(root, file), bytes); manifest.files[name] = { path: file, sha256: sha(bytes) }
  }
  for (const name of Object.keys(documents)) write(name)
  const input = () => { const bytes = encoded(manifest); return { bytes, sha256: sha(bytes) } }
  const evidence = () => { const m = input(); return createOperationBehaviorEvidence({ manifestBytes: m.bytes, expectedManifestSha256: m.sha256, evidenceRoot: root }) }
  const corpus = () => createFeedbackCorpus({ scope: manifest.scope, now })
  const imported = () => importOperationBehavior({ manifests: [input()], evidenceRoot: root, corpus: corpus(), guidance, expiresAt, now })
  return { root, manifest, documents, write, input, evidence, corpus, imported, beforeBytes, afterBytes }
}

test('imports actual-shaped retained native success and reproducible external rejection as a candidate only', t => {
  const f = fixture(t), before = f.corpus(), result = importOperationBehavior({ manifests: [f.input()], evidenceRoot: f.root, corpus: before, guidance, expiresAt, now })
  assert.equal(before.records.length, 0); assert.equal(result.record.status, 'candidate'); assert.equal(result.corpus.revision, 1)
  const e = result.record.evidence[0]
  assert.equal(e.kind, 'native-behavior'); assert.equal(e.source_commit, f.manifest.selection.base_commit)
  assert.equal(e.native.repository, 'local/retained-case'); assert.equal(e.scope.repository, SCOPE.repository)
  assert.deepEqual([e.behavior.native_outcome, e.behavior.native_verification, e.behavior.external_outcome], ['completed', 'passed', 'rejected'])
  assert.equal(e.behavior.instruction_alignment, 'not-reviewed'); assert.equal(e.behavior.native_test_target_binding, 'sha256')
  assert.equal(e.native.resume_prompt_sha256, sha(f.documents.resume_intent.body.prompt))
  assert.equal(e.native.contract_sha256, feedbackDigest(f.documents.terminal.task.contract))
  assert.equal(e.native.verification_policy_sha256, feedbackDigest(f.documents.terminal.task.verification_policy))
  assert.equal(e.files_sha256.external_checker, f.manifest.files.external_checker.sha256)
  assert.equal(e.identity_verification, 'not-performed'); assert.equal(e.independent_review_verified, false); assert.equal(e.human_approval_verified, false)
  validateFeedbackCorpus(result.corpus)
})

test('old oracle without physical digest remains explicitly weaker and prompt alignment remains unreviewed', t => {
  const f = fixture(t, { targetHash: false })
  assert.equal(f.evidence().behavior.native_test_target_binding, 'retained-workspace-only')
  f.manifest.check.instruction_alignment = 'verified-explicit-contract'
  assert.throws(f.evidence, { code: 'unsupported_check' })
})

test('repeated captures and checker versions of one run do not create independent evidence identities', t => {
  const f = fixture(t), first = f.evidence()
  f.write('external_checker', Buffer.from('another retained checker build'))
  f.documents.external_failure.at = '2026-09-18T12:01:00.000Z'; f.write('external_failure')
  const second = f.evidence()
  assert.equal(first.evidence_id, second.evidence_id); assert.notEqual(first.evidence_sha256, second.evidence_sha256)
  assert.throws(() => importOperationBehavior({ manifests: [f.input(), f.input()], evidenceRoot: f.root, corpus: f.corpus(), guidance, expiresAt, now }), { code: 'FEEDBACK_EVIDENCE' })
})

test('local review digest cannot activate a candidate even with two distinct native runs', t => {
  const f = fixture(t), first = f.input()
  // Preserve the first pinned files before constructing another independent run.
  mkdirSync(path.join(f.root, 'second'))
  const old = structuredClone(f.manifest)
  for (const [name, ref] of Object.entries(old.files)) {
    const bytes = readFileSync(path.join(f.root, ref.path)); writeFileSync(path.join(f.root, 'second', ref.path), bytes)
    old.files[name].path = `second/${ref.path}`
  }
  f.manifest.selection.run_id = id(20); f.documents.terminal.run.id = id(20); f.documents.terminal.events[0].aggregate_id = id(20)
  f.documents.terminal.evidence[0].run_id = id(20); f.write('terminal')
  const oldBytes = encoded(old)
  const result = importOperationBehavior({ manifests: [{ bytes: oldBytes, sha256: sha(oldBytes) }, f.input()], evidenceRoot: f.root, corpus: f.corpus(), guidance, expiresAt, now })
  assert.equal(result.record.evidence.length, 2); assert.notEqual(first.sha256, f.input().sha256)
  assert.throws(() => reviewFeedback({ corpus: result.corpus, candidateId: result.record.id, expectedCandidateDigest: result.recordDigest,
    decision: 'activate', reviewEvidence: { sha256: 'a'.repeat(64), reason: 'A local label is not authority.' }, now }), { code: 'FEEDBACK_REVIEW_AUTHORITY' })
  const rejected = reviewFeedback({ corpus: result.corpus, candidateId: result.record.id, expectedCandidateDigest: result.recordDigest,
    decision: 'reject', reviewEvidence: { sha256: 'a'.repeat(64), reason: 'Retain the unsupported candidate.' }, now })
  assert.equal(rejected.record.status, 'retired'); assert.equal(rejected.record.retirement.disposition, 'rejected')
})

for (const [label, alter, code] of [
  ['foreign Corp', f => { f.documents.terminal.evidence[0].corp_id = id(30); f.write('terminal') }, 'native_check_mismatch'],
  ['foreign room', f => { f.documents.terminal.mission.room_id = id(30); f.write('terminal') }, 'native_lineage_mismatch'],
  ['other source', f => { f.documents.terminal.run.source_base_commit = 'f'.repeat(40); f.write('terminal') }, 'native_source_mismatch'],
  ['changed contract source', f => { f.documents.terminal.task.contract.workspace_connection_id = id(30); f.write('terminal') }, 'contract_source_mismatch'],
  ['missing native checks', f => { f.documents.terminal.evidence = []; f.write('terminal') }, 'native_checks_incomplete'],
  ['failed test under passed native label', f => { f.documents.terminal.evidence[0].payload.exit_code = 1; f.write('terminal') }, 'native_test_failed'],
  ['wrong oracle bytes', f => { const c = f.documents.terminal.evidence[0]; const o = JSON.parse(c.payload.stdout); o.target_sha256 = 'f'.repeat(64); c.payload.stdout = JSON.stringify(o); f.write('terminal') }, 'native_oracle_bytes_mismatch'],
  ['wrong resume identity', f => { f.documents.resume_intent.body.requested_by = id(30); f.write('resume_intent') }, 'resume_instruction_mismatch'],
  ['wrong resume ancestry', f => { f.documents.terminal.events[0].payload.source_run_id = id(30); f.write('terminal') }, 'resume_event_mismatch'],
  ['cancelled run', f => { f.documents.terminal.run.status = 'cancelled'; f.documents.terminal.run.verification_status = 'pending'; f.write('terminal') }, 'native_acceptance_not_observed'],
  ['substituted before bytes', f => { f.write('before_target', Buffer.from('different\r\n')) }, 'before_physical_binding_mismatch'],
  ['unknown checker', f => { f.manifest.check.kind = 'execute-path' }, 'unsupported_check'],
]) test(`refuses ${label} even with repinned retained files`, t => { const f = fixture(t); alter(f); assert.throws(f.evidence, { code }) })

test('hash pins, duplicate JSON keys and traversal are rejected before candidate output', t => {
  const f = fixture(t), input = f.input()
  assert.throws(() => createOperationBehaviorEvidence({ manifestBytes: input.bytes, expectedManifestSha256: '0'.repeat(64), evidenceRoot: f.root }), { code: 'manifest_hash_mismatch' })
  writeFileSync(path.join(f.root, f.manifest.files.external_checker.path), 'changed')
  assert.throws(f.evidence, { code: 'file_hash_mismatch' })
  f.write('external_checker'); f.manifest.files.terminal.path = '../terminal.data'
  assert.throws(f.evidence, { code: 'invalid_file_pin' })
  const duplicate = Buffer.from('{"schema_version":1,"schema_version":1}')
  assert.throws(() => createOperationBehaviorEvidence({ manifestBytes: duplicate, expectedManifestSha256: sha(duplicate), evidenceRoot: f.root }), { code: 'duplicate_json_key' })
})

test('directory redirection and oversized files fail closed', t => {
  const f = fixture(t)
  mkdirSync(path.join(f.root, 'actual'))
  symlinkSync(path.join(f.root, 'actual'), path.join(f.root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(path.join(f.root, 'actual', 'payload.data'), f.documents.before_target)
  f.manifest.files.before_target.path = 'redirect/payload.data'
  assert.throws(f.evidence, { code: 'redirected_evidence_path' })
  f.manifest.files.before_target.path = 'before_target.data'
  f.write('external_checker', Buffer.alloc(1024 * 1024 + 1, 65))
  assert.throws(f.evidence, { code: 'file_unbounded_or_redirected' })
})

test('exact append handles LF and CRLF without normalizing changed source', () => {
  for (const eol of ['\n', '\r\n']) {
    const before = Buffer.from(`one${eol}`), marker = '// marker'
    const exact = Buffer.concat([before, Buffer.from(marker + eol)])
    assert.equal(checkExactAppend({ before, after: exact, marker, separatorNewlines: 0 }).status, 'passed')
    for (const after of [Buffer.concat([before, Buffer.from(eol + marker + eol)]), Buffer.concat([exact, Buffer.from(eol)]), Buffer.from(`changed${eol}${marker}${eol}`)])
      assert.equal(checkExactAppend({ before, after, marker, separatorNewlines: 0 }).status, 'rejected')
  }
  assert.throws(() => checkExactAppend({ before: Buffer.from('one\r\ntwo\n'), after: Buffer.from('ignored'), marker: '// marker', separatorNewlines: 0 }), { code: 'mixed_or_invalid_eol' })
})

test('external rejection cannot be imported when exact output actually passes', t => {
  const f = fixture(t); f.manifest.check.separator_newlines = 1
  assert.throws(f.evidence, { code: 'external_rejection_not_reproduced' })
})

test('CLI reads pinned inputs and creates one new corpus without overwriting source files', t => {
  const f = fixture(t), corpusBytes = encoded(f.corpus()), manifest = f.input()
  writeFileSync(path.join(f.root, 'corpus.json'), corpusBytes); writeFileSync(path.join(f.root, 'manifest.json'), manifest.bytes)
  const request = encoded({ schema_version: 1, corpus: { path: 'corpus.json', sha256: sha(corpusBytes) },
    manifests: [{ path: 'manifest.json', sha256: manifest.sha256 }], guidance, expires_at: expiresAt })
  writeFileSync(path.join(f.root, 'request.json'), request)
  const output = path.join(f.root, 'new-corpus.json'), argv = ['--input', path.join(f.root, 'request.json'), '--sha256', sha(request), '--evidence-root', f.root, '--out', output]
  const result = main(argv, { now }); assert.equal(result.status, 'candidate-imported'); assert.equal(result.activation_supported, false)
  assert.equal(result.native_mutations, 0); assert.equal(result.provider_invocations, 0)
  assert.equal(JSON.parse(readFileSync(output)).records[0].status, 'candidate')
  assert.deepEqual(readFileSync(path.join(f.root, 'corpus.json')), corpusBytes)
  assert.throws(() => main(argv, { now }), { code: 'EEXIST' })
})

test('CLI has one aggregate read budget covering the request, corpus, manifests and retained files', t => {
  const f = fixture(t), before = Buffer.from('// ' + 'x'.repeat(900000) + '\r\n')
  const after = Buffer.concat([before, Buffer.from('\r\n// controlled append\r\n')])
  f.write('before_target', before); f.write('after_target', after)
  f.documents.before_attestation.raw = { sha256: sha(before), bytes: before.length }; f.write('before_attestation')
  f.documents.after_attestation.raw = { sha256: sha(after), bytes: after.length }; f.write('after_attestation')
  const oracle = JSON.parse(f.documents.terminal.evidence[0].payload.stdout); oracle.target_sha256 = sha(after)
  f.documents.terminal.evidence[0].payload.stdout = JSON.stringify(oracle); f.write('terminal')
  const pad = bytes => Buffer.concat([bytes, Buffer.alloc(1024 * 1024 - bytes.length, 32)])
  for (const name of ['terminal', 'resume_intent', 'before_attestation', 'after_attestation', 'external_failure', 'external_checker']) {
    const bytes = pad(readFileSync(path.join(f.root, f.manifest.files[name].path)))
    writeFileSync(path.join(f.root, f.manifest.files[name].path), bytes); f.manifest.files[name].sha256 = sha(bytes)
  }
  // Retained files alone fit under 8 MiB; adding the pinned corpus must not reset it.
  assert.equal(f.evidence().behavior.external_outcome, 'rejected')
  const corpusBytes = pad(encoded(f.corpus())), manifest = f.input()
  writeFileSync(path.join(f.root, 'corpus.json'), corpusBytes); writeFileSync(path.join(f.root, 'manifest.json'), manifest.bytes)
  const request = encoded({ schema_version: 1, corpus: { path: 'corpus.json', sha256: sha(corpusBytes) },
    manifests: [{ path: 'manifest.json', sha256: manifest.sha256 }], guidance, expires_at: expiresAt })
  writeFileSync(path.join(f.root, 'request.json'), request)
  assert.throws(() => main(['--input', path.join(f.root, 'request.json'), '--sha256', sha(request), '--evidence-root', f.root,
    '--out', path.join(f.root, 'bounded-corpus.json')], { now }), { code: 'total_input_unbounded' })
})
