import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { applyOperationFeedback, buildFeedbackProposal, feedbackCommandExitCode, main, prepareOperationFeedback, projectFeedbackTarget,
  readFeedbackFile, renderFeedbackProposal } from './operation_feedback.mjs'
import { audit } from '../scenarios/repo-steward/lib/steward.mjs'
import { fixtureSnapshot } from '../scenarios/repo-steward/fixtures/demo.mjs'
import { createFeedbackCorpus, createFeedbackEvidence, proposeFeedback, reviewFeedback, validateFeedbackCorpus } from '../scenarios/repo-steward/lib/feedback.mjs'

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const clone = value => structuredClone(value)
const now = new Date('2026-09-18T12:00:00.000Z'), time = now.toISOString()
const origin = 'http://127.0.0.1:19871'
const env = { CRONY_MCP_BINARY: process.execPath, CRONY_SERVER_HTTP: origin, CRONY_CORP_ID: id(1), CRONY_ACTOR_ID: id(2) }

function fixture({ guidance = 'Inspect the evidence before proposing a label.', expiresAt = '2026-09-19T12:00:00.000Z' } = {}) {
  const snapshot = fixtureSnapshot(now)
  const report = audit(snapshot, { now, source: 'synthetic-fixture' })
  const reviewBytes = Buffer.from('Local synthetic advisory review. No identity or independent-review assertion.\n')
  const evidence = report.findings.filter(item => item.rule === 'WORKSTREAM_UNTAGGED').slice(0, 2)
    .map(item => createFeedbackEvidence({ snapshot, findingId: item.id, now, source: 'synthetic-fixture' }))
  const proposed = proposeFeedback({ corpus: createFeedbackCorpus({ scope: snapshot.scope, now }), rule: 'WORKSTREAM_UNTAGGED',
    guidance: { text: guidance, route: 'inspect-evidence' }, evidence, expiresAt, now })
  const active = reviewFeedback({ corpus: proposed.corpus, candidateId: proposed.record.id, expectedCandidateDigest: proposed.recordDigest,
    decision: 'activate', reviewEvidence: { sha256: hash(reviewBytes), reason: 'Retain the original findings and policy.' }, now })
  const corpusBytes = bytes(active.corpus)
  const receipt = {
    schema_version: 1, kind: 'ecorp-operation-receipt', mode: 'current-run', checked_at: time, duration_ms: 1,
    scope: { server_origin_sha256: hash(origin), corp_id: id(1), actor_id: id(2), room_id: id(3), mission_id: id(4), task_id: id(5), run_id: id(6) },
    source: { repository: 'all-the-vibes/ecorp', base_ref: 'main', base_commit: 'a'.repeat(40) },
    mission: { status: 'completed', specification_version: 1, updated_at: time },
    task: { status: 'completed', contract_version: 1, attempt_count: 1, max_attempts: 2, assigned_agent_id: id(7), updated_at: time },
    run: { status: 'completed', verification_status: 'passed', agent_id: id(7), runner_id: 'fixture-runner', model: null, execution_mode: 'provider',
      created_at: time, updated_at: time, resumed_from_run_id: null, verification_sha256: 'b'.repeat(64), deliverable_sha256: null, is_latest_task_run: true },
    origin: { kind: 'direct', work_item_id: null, repository: null, issue_number: null }, factory: null, publication: null,
    verification: { persisted_acceptance_observed: true, expected_check_count: 1, automated_checks_complete: true, automated_checks_passed: true,
      evidence: [{ id: id(8), check_index: 0, kind: 'artifact', status: 'passed', exit_code: null }], manual_gate: null },
    artifacts: [{ id: id(9), role: 'provider_evidence', sha256: hash(corpusBytes), media_type: 'application/json', bytes: corpusBytes.length,
      source_deliverable_id: null, verification_sha256: null, base_commit: null, head_commit: null,
      byte_hash_verified: true, signature_header_matches_record: true, client_hmac_verified: false }],
    lineage: { resume_run_ids: [], resume_chain_complete: true, recovery_ids: [] },
    coverage: { verification_evidence: 'bounded_excerpt', events: 'bounded_excerpt', recoveries: 'bounded_excerpt', source_deliverables: 'bounded_excerpt' },
    assurance: { read_only: true, non_atomic: true, observation_only: true, authenticity_claim: false, offline_authority: false,
      production_identity_verified: false, credential_delivery: 'not_supplied', server_hmac_verification: 'server_download_boundary',
      client_hmac_verified: false, remote_pr_rechecked: false, future_authority_granted: false },
  }
  const description = 'Read the current repository evidence.'
  const contract = { objective: `${description}\n\nTASK-SPECIFIC OBJECTIVE:\nInspect the saved repository scope`, expected_output: 'A review-only result',
    source_repository: receipt.source.repository, source_base_ref: 'main', source_base_commit: receipt.source.base_commit,
    workspace_connection_id: id(30), acceptance_tests: ['Keep source scope fixed'], allowed_tools: ['filesystem'], prohibited_actions: ['No external writes'],
    references: ['Existing operator reference'], write_scope: ['result.md'], budget_tokens: 10000, budget_cost_microusd: 1000,
    deadline_at: null, escalation: 'Ask the owner', secret_refs: [], model: null, reasoning_effort: null,
    deliverable: { form: 'review_only_report', commit_after_verification: false, paths: [] } }
  const target = { corp_id: id(1), room_id: id(3), actor_id: id(2), origin: 'direct', run_history_coverage: 'bounded_snapshot',
    mission: { id: id(10), corp_id: id(1), room_id: id(3), requested_by: id(2), status: 'ready', description,
      specification_version: 1, budget_tokens: 10000, budget_cost_microusd: 1000, original_budget_tokens: 10000, original_budget_cost_microusd: 1000, updated_at: time },
    task: { id: id(11), corp_id: id(1), mission_id: id(10), status: 'pending', objective: contract.objective, contract, contract_version: 1,
      verification_policy: { checks: [{ type: 'artifact', min_bytes: 1 }], manual_gate: { type: 'human_approval', roles: ['owner'] } },
      verification_status: 'pending', required_adapter: 'fake-process', max_attempts: 1, attempt_count: 0, depends_on: [], updated_at: time },
    run_ids: [], revisions: [] }
  const options = { corpusBytes, reviewBytes, receiptBytes: bytes(receipt), sourceArtifactBytes: corpusBytes, artifactId: id(9),
    selectedRuleIds: [active.record.id], target, now, idempotencyKey: id(20), env, missionId: id(10), taskId: id(11) }
  const validateCorpus = validateFeedbackCorpus
  return { options, receipt, target, validateCorpus }
}

function typedFixture(configuration = {}) {
  const f = fixture(configuration)
  const patch = Buffer.from('diff --git a/corpus.json b/corpus.json\n')
  const document = { schema_version: 1, form: 'typed_artifact_set', base_commit: f.receipt.source.base_commit, head_commit: null,
    branch: 'crony/task-fixture/run-fixture', verification_sha256: f.receipt.run.verification_sha256,
    patch_sha256: hash(patch), patch_base64: patch.toString('base64'), git_bundle_sha256: null, git_bundle_base64: null,
    changes: [{ path: 'corpus.json', status: 'A', mode: '100644', sha256: hash(f.options.corpusBytes), bytes: f.options.corpusBytes.length,
      media_type: 'application/json', content_base64: f.options.corpusBytes.toString('base64') }] }
  const refresh = (encoded = bytes(document)) => {
    f.receipt.artifacts[0] = { ...f.receipt.artifacts[0], role: 'source_deliverable', sha256: hash(encoded), bytes: encoded.length,
      media_type: 'application/vnd.ecorp.deliverable+json', source_deliverable_id: id(19),
      verification_sha256: f.receipt.run.verification_sha256, base_commit: f.receipt.source.base_commit, head_commit: null }
    f.receipt.run.deliverable_sha256 = hash(encoded)
    Object.assign(f.options, { receiptBytes: bytes(f.receipt), sourceArtifactBytes: encoded, artifactPath: 'corpus.json' })
  }
  refresh()
  return { ...f, document, refresh }
}

function harness(configuration = {}) {
  const f = configuration.typed ? typedFixture(configuration) : fixture(configuration)
  let target = clone(f.target), source = clone(f.receipt), sourceBytes = Buffer.from(f.options.sourceArtifactBytes)
  const calls = { reads: 0, targetReads: 0, posts: [], revisions: [] }
  let loseResponse = false
  const native = {
    validateCorpus: f.validateCorpus,
    async readSource(options) {
      assert.equal(options.env, env)
      assert.equal(options.runId, id(6))
      assert.deepEqual(options.artifactIds, [id(9)])
      calls.reads++
      return { receipt: clone(source), artifactBytes: [{ id: id(9), bytes: Buffer.from(sourceBytes) }] }
    },
    async readTarget(options) { assert.equal(options.env, env); calls.targetReads++; return clone(target) },
    async revise({ corpId, missionId, body }) {
      calls.posts.push(clone(body))
      assert.equal(corpId, id(1)); assert.equal(missionId, id(10))
      const existing = calls.revisions.find(item => item.key === body.idempotency_key)
      if (existing) { assert.deepEqual(existing.body, body); return { revision: clone(existing.revision), replayed: true } }
      const revision = { id: id(40), corp_id: id(1), mission_id: id(10), task_id: id(11), version: 2, revised_by: id(2), next_action: 'redispatch',
        source_run_id: null, reason: body.reason, previous_description: target.mission.description, replacement_description: body.description,
        previous_contract: clone(target.task.contract), replacement_contract: clone(body.contract),
        previous_verification_policy: clone(target.task.verification_policy), replacement_verification_policy: clone(body.verification_policy), created_at: time }
      calls.revisions.push({ key: body.idempotency_key, body: clone(body), revision: clone(revision) })
      target.mission.specification_version = 2
      target.task.contract_version = 2
      target.task.contract = clone(body.contract)
      target.task.objective = body.contract.objective
      target.task.verification_status = 'pending'
      target.revisions.push(revision)
      if (loseResponse) { loseResponse = false; throw new Error('PRIVATE_LOST_RESPONSE_BODY') }
      return { revision, replayed: false }
    },
  }
  const proposal = buildFeedbackProposal(f.options, native)
  assert.equal(proposal.state, 'ready-for-review', proposal.reasons.join(','))
  const apply = (overrides = {}, dependencies = {}) => applyOperationFeedback({ ...f.options, proposalBytes: bytes(proposal), expectedSha256: hash(bytes(proposal)), ...overrides }, { ...native, ...dependencies })
  return { ...f, native, proposal, calls, apply, currentTarget: () => target, currentSource: () => source,
    changeTarget: fn => fn(target), changeSource: fn => fn(source), changeArtifact: fn => { sourceBytes = fn(sourceBytes) }, loseNextResponse: () => { loseResponse = true } }
}

test('prepare is read-only and exposes the exact reference-only change for review', async () => {
  const h = harness()
  const original = clone(h.options.target)
  const result = await prepareOperationFeedback(h.options, h.native)
  assert.equal(result.state, 'ready-for-review')
  assert.equal(h.calls.posts.length, 0)
  assert.equal(h.calls.reads, 1)
  const replacement = clone(result.request.contract)
  replacement.references = original.task.contract.references
  assert.deepEqual(replacement, original.task.contract)
  assert.deepEqual(result.request.verification_policy, original.task.verification_policy)
  assert.deepEqual(h.options.target, original)
  assert.equal(result.request.next_action, 'redispatch')
  assert.equal(result.request.source_run_id, null)
  assert.match(renderFeedbackProposal(result), /Expected contract version: 1/)
  assert.match(renderFeedbackProposal(result), /Only these references will be appended/)
  assert.equal(result.assurance.zero_historical_runs_verified, false)
  assert.equal(result.assurance.native_pre_execution_admission_required, true)
})

test('an unprefixed objective stays candidate because native composition would change it', async () => {
  const h = harness()
  h.changeTarget(target => { target.task.objective = target.task.contract.objective = 'Inspect the saved repository scope' })
  const candidate = await prepareOperationFeedback(h.options, h.native)
  assert.equal(candidate.state, 'candidate')
  assert.equal(candidate.request, null)
  assert.deepEqual(candidate.reasons, ['target_objective_not_native_fixed_point'])
  assert.equal(h.calls.posts.length, 0)
  const direct = await h.apply()
  assert.equal(direct.status, 'refused-before-effect')
  assert.equal(direct.error, 'target_objective_not_native_fixed_point')
  assert.equal(h.calls.posts.length, 0)
})

test('native normalization fixed points retain description and objective exactly', () => {
  const h = harness()
  for (const [description, objective, expected] of [
    ['', 'Standalone task', 'ready-for-review'],
    ['Shared description', 'Shared description', 'ready-for-review'],
    ['Shared description', 'Shared description\n\nTASK-SPECIFIC OBJECTIVE:\nTask details', 'ready-for-review'],
    [' Shared description ', ' Shared description ', 'candidate'],
    ['Shared\r\ndescription', 'Shared\r\ndescription', 'candidate'],
    ['', ' Task details ', 'candidate'],
    ['', '\u0085Task details', 'candidate'],
    ['Shared description', 'Shared description\n\nTASK-SPECIFIC OBJECTIVE:\n', 'candidate'],
    ['', '語'.repeat(33334), 'candidate'],
    ['', 'x'.repeat(100000), 'ready-for-review'],
  ]) {
    const target = clone(h.target)
    target.mission.description = description
    target.task.objective = target.task.contract.objective = objective
    const proposal = buildFeedbackProposal({ ...h.options, target }, h.native)
    assert.equal(proposal.state, expected)
    if (expected === 'ready-for-review') {
      assert.equal(proposal.request.description, description)
      assert.equal(proposal.request.contract.objective, objective)
    }
  }
})

test('public identifiers and digest selectors reject coercible arrays and objects before effects', async () => {
  const h = harness()
  for (const field of ['artifactId', 'idempotencyKey']) {
    const value = h.options[field]
    for (const invalid of [[value], new String(value), { toString: () => value }, 7, null]) {
      assert.throws(() => buildFeedbackProposal({ ...h.options, [field]: invalid }, h.native), { code: 'invalid_identity' })
    }
  }
  const candidate = buildFeedbackProposal({ ...h.options, selectedRuleIds: [[h.options.selectedRuleIds[0]]] }, h.native)
  assert.deepEqual(candidate.reasons, ['invalid_rule_selection'])
  const target = clone(h.target); target.task.id = [target.task.id]
  assert.deepEqual(buildFeedbackProposal({ ...h.options, target }, h.native).reasons, ['invalid_target_identity'])
  const refused = await h.apply({ expectedSha256: [hash(bytes(h.proposal))] })
  assert.equal(refused.error, 'proposal_byte_hash_mismatch')
  assert.equal(h.calls.reads, 0)
  assert.equal(h.calls.posts.length, 0)
})

test('time, timeout and trusted routing fields require their declared primitive types', async () => {
  const h = harness()
  for (const invalid of [[time], new String(time), now.getTime(), true, new Date('invalid')]) {
    assert.throws(() => buildFeedbackProposal({ ...h.options, now: invalid }, h.native), { code: 'invalid_time' })
  }
  for (const ttlMs of ['1000', [1000], true, NaN]) assert.throws(() => buildFeedbackProposal({ ...h.options, ttlMs }, h.native), { code: 'invalid_expiry' })
  await assert.rejects(h.apply({ timeoutMs: [30000] }), { code: 'invalid_timeout' })
  for (const key of ['CRONY_MCP_BINARY', 'CRONY_SERVER_HTTP', 'CRONY_CORP_ID', 'CRONY_ACTOR_ID', 'CRONY_ACCESS_TOKEN']) {
    const result = await prepareOperationFeedback({ ...h.options, env: { ...env, [key]: [env[key] ?? 'not-a-real-token'] } }, h.native)
    assert.equal(result.state, 'candidate')
    assert.deepEqual(result.reasons, ['invalid_trusted_configuration'])
  }
  await assert.rejects(main([['prepare']], h.native), { code: 'invalid_arguments' })
  assert.equal(h.calls.reads, 0)
  assert.equal(h.calls.posts.length, 0)
})

test('apply performs one native revision, preserves authority and never launches', async () => {
  const h = harness()
  const result = await h.apply()
  assert.equal(result.status, 'applied')
  assert.equal(result.mutation_requests, 1)
  assert.equal(result.launched, false)
  assert.equal(result.native_revision_id, id(40))
  assert.equal(h.calls.posts.length, 1)
  assert.equal(h.calls.revisions.length, 1)
  assert.equal(h.calls.reads, 2)
  assert.deepEqual(h.currentTarget().task.verification_policy, h.target.task.verification_policy)
  assert.deepEqual(h.currentTarget().task.verification_policy.manual_gate, { type: 'human_approval', roles: ['owner'] })
  assert.equal(h.currentTarget().mission.status, 'ready')
  assert.equal(h.currentTarget().task.attempt_count, 0)
})

test('typed native file selection pins outer provenance and exact decoded corpus while preserving raw compatibility', async () => {
  const h = harness({ typed: true })
  const proposal = await prepareOperationFeedback(h.options, h.native)
  assert.equal(proposal.state, 'ready-for-review')
  assert.equal(proposal.inputs.artifact_path, 'corpus.json')
  assert.deepEqual(proposal.source.corpus_binding, { kind: 'typed-artifact-set-file', path: 'corpus.json',
    artifact_sha256: hash(h.options.sourceArtifactBytes), content_sha256: hash(h.options.corpusBytes), content_bytes: h.options.corpusBytes.length })
  assert.notEqual(proposal.source.corpus_binding.artifact_sha256, proposal.source.corpus_binding.content_sha256)
  const applied = await h.apply()
  assert.equal(applied.status, 'applied')
  assert.equal(h.calls.posts.length, 1)
  assert.equal(h.calls.revisions.length, 1)
  assert.equal(h.calls.reads, 3, 'prepare plus pre/post application all use native outer artifact observation')
  const raw = harness().proposal
  assert.equal(raw.inputs.artifact_path, null)
  assert.equal(raw.source.corpus_binding.kind, 'raw-artifact')
  assert.equal(raw.source.corpus_binding.artifact_sha256, raw.source.corpus_binding.content_sha256)
})

for (const [name, mutate] of [
  ['unknown schema field', doc => { doc.extra_authority = true }],
  ['missing native schema field', doc => { delete doc.patch_sha256 }],
  ['coercible version', doc => { doc.schema_version = [1] }],
  ['unsupported archive form', doc => { doc.form = 'archive' }],
  ['wrong base', doc => { doc.base_commit = 'c'.repeat(40) }],
  ['wrong verifier', doc => { doc.verification_sha256 = 'c'.repeat(64) }],
  ['wrong head', doc => { doc.head_commit = 'c'.repeat(40) }],
  ['bundle payload', doc => { doc.git_bundle_base64 = 'AA==' }],
  ['patch checksum', doc => { doc.patch_sha256 = 'c'.repeat(64) }],
  ['patch noncanonical base64', doc => { doc.patch_base64 += '\n' }],
  ['selected hash', doc => { doc.changes[0].sha256 = 'c'.repeat(64) }],
  ['selected byte count', doc => { doc.changes[0].bytes++ }],
  ['selected file size bound', doc => { doc.changes[0].bytes = 1024 * 1024 + 1 }],
  ['selected base64', doc => { doc.changes[0].content_base64 = '!'.repeat(doc.changes[0].content_base64.length) }],
  ['selected symlink', doc => { doc.changes[0].mode = '120000' }],
  ['selected submodule', doc => { doc.changes[0].mode = '160000' }],
  ['selected media', doc => { doc.changes[0].media_type = 'application/octet-stream' }],
  ['duplicate path', doc => { doc.changes.push(clone(doc.changes[0])) }],
  ['case alias', doc => { doc.changes.push({ ...clone(doc.changes[0]), path: 'CORPUS.json' }) }],
  ['file directory conflict', doc => { doc.changes.push({ ...clone(doc.changes[0]), path: 'corpus.json/child.json' }) }],
  ['traversal', doc => { doc.changes[0].path = '../corpus.json' }],
  ['absolute path', doc => { doc.changes[0].path = '/corpus.json' }],
  ['Windows stream', doc => { doc.changes[0].path = 'corpus.json:stream' }],
  ['Windows device', doc => { doc.changes[0].path = 'CON.json' }],
  ['trailing dot alias', doc => { doc.changes[0].path = 'corpus.json.' }],
  ['coercible entry path', doc => { doc.changes[0].path = ['corpus.json'] }],
  ['deleted selection', doc => { Object.assign(doc.changes[0], { status: 'D', mode: null, sha256: null, bytes: null, media_type: null, content_base64: null }) }],
]) {
  test(`native typed ${name} is refused even with matching outer artifact digest`, () => {
    const f = typedFixture(); mutate(f.document); f.refresh()
    const result = buildFeedbackProposal(f.options, f)
    assert.equal(result.state, 'candidate')
    assert.equal(result.request, null)
    assert.match(result.reasons[0], /^typed_artifact_|invalid_json_data/u)
  })
}

test('typed path selection requires one exact safe file, source role and original outer bytes', () => {
  const f = typedFixture()
  for (const artifactPath of ['missing.json', '../corpus.json', 'C:/corpus.json', 'dir\\corpus.json', '', '/corpus.json']) {
    const result = buildFeedbackProposal({ ...f.options, artifactPath }, f)
    assert.equal(result.state, 'candidate')
    assert.equal(result.request, null)
  }
  assert.throws(() => buildFeedbackProposal({ ...f.options, artifactPath: ['corpus.json'] }, f), { code: 'invalid_artifact_path' })
  const role = clone(f.receipt)
  Object.assign(role.artifacts[0], { role: 'provider_evidence', source_deliverable_id: null, verification_sha256: null, base_commit: null, head_commit: null })
  assert.deepEqual(buildFeedbackProposal({ ...f.options, receiptBytes: bytes(role) }, f).reasons, ['unsupported_corpus_binding'])
  assert.deepEqual(buildFeedbackProposal({ ...f.options, sourceArtifactBytes: Buffer.from('changed outer bytes') }, f).reasons, ['corpus_artifact_bytes_mismatch'])
  const escapedDuplicate = bytes(f.document).toString().replace('"form": "typed_artifact_set",', '"form": "archive",\n  "f\\u006frm": "typed_artifact_set",')
  f.refresh(Buffer.from(escapedDuplicate))
  assert.deepEqual(buildFeedbackProposal(f.options, f).reasons, ['invalid_json_data'])
})

test('typed decoded corpus cannot substitute a different well-hashed file or retarget a reviewed proposal', async () => {
  const f = typedFixture()
  const alternative = Buffer.from('A different artifact body')
  Object.assign(f.document.changes[0], { sha256: hash(alternative), bytes: alternative.length, content_base64: alternative.toString('base64') })
  f.refresh()
  assert.deepEqual(buildFeedbackProposal(f.options, f).reasons, ['corpus_artifact_bytes_mismatch'])
  const h = harness({ typed: true })
  const changed = clone(h.proposal); changed.inputs.artifact_path = 'different.json'
  const outcome = await h.apply({ proposalBytes: bytes(changed), expectedSha256: hash(bytes(changed)) })
  assert.equal(outcome.status, 'refused-before-effect')
  assert.equal(h.calls.posts.length, 0)
})

test('typed base64 padding bits are canonical even when permissive decoding preserves the correct bytes', () => {
  const f = typedFixture()
  while (f.options.corpusBytes.length % 3 === 0) f.options.corpusBytes = Buffer.concat([f.options.corpusBytes, Buffer.from(' ')])
  const content = f.options.corpusBytes, encoded = content.toString('base64'), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const index = encoded.length - (encoded.endsWith('==') ? 3 : 2)
  const noncanonical = encoded.slice(0, index) + alphabet[alphabet.indexOf(encoded[index]) | 1] + encoded.slice(index + 1)
  assert.deepEqual(Buffer.from(noncanonical, 'base64'), content)
  Object.assign(f.document.changes[0], { bytes: content.length, sha256: hash(content), content_base64: noncanonical })
  f.refresh()
  assert.deepEqual(buildFeedbackProposal(f.options, f).reasons, ['typed_artifact_base64_invalid'])
})

test('same byte-pinned proposal replays its native key without adding guidance or a second revision', async () => {
  const h = harness()
  assert.equal((await h.apply()).status, 'applied')
  const second = await h.apply()
  assert.equal(second.status, 'applied')
  assert.equal(second.replayed, true)
  assert.equal(h.calls.posts.length, 2)
  assert.deepEqual(h.calls.posts[0], h.calls.posts[1])
  assert.equal(h.calls.revisions.length, 1)
  assert.equal(h.currentTarget().task.contract.references.length, 3)
})

test('lost response stays unknown with no automatic retry; exact replay reconciles it', async () => {
  const h = harness(); h.loseNextResponse()
  const first = await h.apply()
  assert.equal(first.status, 'outcome-unknown')
  assert.equal(first.idempotency_key, id(20))
  assert.equal(h.calls.posts.length, 1)
  assert.equal(h.calls.revisions.length, 1)
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_LOST_RESPONSE_BODY/)
  const replay = await h.apply()
  assert.equal(replay.status, 'applied')
  assert.equal(replay.replayed, true)
  assert.equal(h.calls.revisions.length, 1)
})

test('an HTTP400 after persistence stays unknown and same-key replay confirms one revision', async () => {
  const h = harness()
  const first = await h.apply({}, { revise: async options => {
    await h.native.revise(options)
    const error = new Error('PRIVATE_AMBIGUOUS_COMMIT'); error.httpStatus = 400; throw error
  } })
  assert.equal(first.status, 'outcome-unknown')
  assert.equal(first.native_http_status, 400)
  assert.equal(first.idempotency_key, id(20))
  assert.equal(h.calls.posts.length, 1)
  assert.equal(h.calls.revisions.length, 1)
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_AMBIGUOUS_COMMIT/)
  const replay = await h.apply()
  assert.equal(replay.status, 'applied')
  assert.equal(replay.replayed, true)
  assert.equal(h.calls.revisions.length, 1)
  assert.deepEqual(h.calls.posts[0], h.calls.posts[1])
})

for (const [name, mutate] of [
  ['Corp', source => { source.scope.corp_id = id(71) }],
  ['room', source => { source.scope.room_id = id(72) }],
  ['mission', source => { source.scope.mission_id = id(73) }],
  ['task', source => { source.scope.task_id = id(74) }],
  ['run', source => { source.scope.run_id = id(75) }],
  ['actor', source => { source.scope.actor_id = id(76) }],
  ['source commit', source => { source.source.base_commit = 'e'.repeat(40) }],
  ['verifier digest', source => { source.run.verification_sha256 = 'e'.repeat(64) }],
  ['artifact digest', source => { source.artifacts[0].sha256 = 'e'.repeat(64) }],
]) {
  test(`live ${name} drift refuses before a request`, async () => {
    const h = harness(); h.changeSource(mutate)
    const result = await h.apply()
    assert.equal(result.status, 'refused-before-effect')
    assert.equal(h.calls.posts.length, 0)
  })
}

test('an accepted receipt with incomplete bounded evidence remains candidate', async () => {
  const h = harness()
  const receipt = clone(h.receipt)
  receipt.verification.expected_check_count = null
  receipt.verification.automated_checks_complete = false
  receipt.verification.automated_checks_passed = false
  const result = await prepareOperationFeedback({ ...h.options, receiptBytes: bytes(receipt) }, h.native)
  assert.equal(result.state, 'candidate')
  assert.deepEqual(result.reasons, ['source_checks_incomplete'])
  assert.equal(result.request, null)
  assert.equal(h.calls.posts.length, 0)
  assert.equal(h.calls.reads, 0)
})

test('an observed manual gate must retain its native decision and decider', async () => {
  const h = harness()
  const receipt = clone(h.receipt)
  receipt.verification.manual_gate = { gate_type: 'human_review', status: 'approved', decided_by: null, decided_at: null }
  const result = await prepareOperationFeedback({ ...h.options, receiptBytes: bytes(receipt) }, h.native)
  assert.equal(result.state, 'candidate')
  assert.deepEqual(result.reasons, ['source_gate_not_approved'])
  assert.equal(h.calls.posts.length, 0)
  assert.equal(h.calls.reads, 0)
})

test('missing native corpus evidence or mismatched actual bytes never borrows an unrelated accepted run', async () => {
  const h = harness()
  h.changeArtifact(() => Buffer.from('unrelated actual artifact bytes'))
  const result = await prepareOperationFeedback(h.options, h.native)
  assert.equal(result.state, 'candidate')
  assert.deepEqual(result.reasons, ['corpus_artifact_bytes_mismatch'])
  assert.equal(h.calls.posts.length, 0)
})

test('typed envelopes, missing review bytes and requested independent review remain explicit candidates', () => {
  const h = harness()
  for (const [override, expected] of [
    [{ reviewBytes: Buffer.from('different local review') }, 'review_bytes_mismatch'],
    [{ requireIndependentReview: true }, 'independent_review_not_proven'],
    [{ sourceArtifactBytes: undefined }, 'corpus_artifact_unavailable'],
  ]) {
    const result = buildFeedbackProposal({ ...h.options, ...override }, h.native)
    assert.equal(result.state, 'candidate')
    assert.deepEqual(result.reasons, [expected])
    assert.equal(result.request, null)
  }
  const receipt = clone(h.receipt); receipt.artifacts[0].media_type = 'application/vnd.ecorp.deliverable+json'
  assert.deepEqual(buildFeedbackProposal({ ...h.options, receiptBytes: bytes(receipt) }, h.native).reasons, ['unsupported_corpus_binding'])
})

test('UTF-8 reference bounds do not silently truncate valid longer advisory guidance', () => {
  const f = fixture({ guidance: '語'.repeat(160) })
  const result = buildFeedbackProposal(f.options, f)
  assert.equal(result.state, 'candidate')
  assert.deepEqual(result.reasons, ['reference_bounds_exceeded'])
  assert.equal(result.request, null)
})

for (const [name, change] of [
  ['ready status', target => { target.mission.status = 'running' }],
  ['existing run', target => { target.run_ids.push(id(90)) }],
  ['contract version', target => { target.task.contract_version++ }],
  ['budget', target => { target.task.contract.budget_tokens++ }],
  ['verifier', target => { target.task.verification_policy.manual_gate = null }],
  ['source', target => { target.task.contract.source_base_commit = 'f'.repeat(40) }],
  ['source connection', target => { target.task.contract.workspace_connection_id = id(66) }],
  ['tools', target => { target.task.contract.allowed_tools.push('shell') }],
  ['Corp', target => { target.corp_id = id(66) }],
  ['room', target => { target.room_id = id(66) }],
  ['origin', target => { target.origin = 'factory' }],
]) {
  test(`changed target ${name} cannot be overwritten`, async () => {
    const h = harness(); h.changeTarget(change)
    const result = await h.apply()
    assert.equal(result.status, 'refused-before-effect')
    assert.equal(h.calls.posts.length, 0)
  })
}

test('repinned unauthorized proposal changes cannot alter anything except selected references', async () => {
  const h = harness()
  for (const mutate of [
    proposal => { proposal.request.contract.allowed_tools.push('shell') },
    proposal => { proposal.request.verification_policy.manual_gate = null },
    proposal => { proposal.request.contract.budget_tokens++ },
    proposal => { proposal.extra_approval = true },
    proposal => { proposal.request.source_run_id = id(6) },
    proposal => { proposal.request.reason += ' Additional instruction' },
  ]) {
    const proposal = clone(h.proposal); mutate(proposal)
    const result = await h.apply({ proposalBytes: bytes(proposal), expectedSha256: hash(bytes(proposal)) })
    assert.equal(result.status, 'refused-before-effect')
    assert.equal(h.calls.posts.length, 0)
  }
})

test('wrong proposal hash, edited corpus/review/receipt, future or expired proposal fails before POST', async () => {
  const h = harness()
  for (const change of [
    { expectedSha256: 'f'.repeat(64) }, { corpusBytes: Buffer.from('changed corpus') },
    { reviewBytes: Buffer.from('changed review') }, { receiptBytes: Buffer.from('changed receipt') },
    { now: new Date('2026-09-18T12:05:00.000Z') }, { now: new Date('2026-09-18T11:59:59.000Z') },
  ]) assert.equal((await h.apply(change)).status, 'refused-before-effect')
  assert.equal(h.calls.posts.length, 0)
})

test('expired selected guidance is not rescued by the remaining proposal lifetime', async () => {
  const h = harness({ expiresAt: '2026-09-18T12:00:30.000Z' })
  const result = await h.apply({ now: new Date('2026-09-18T12:00:31.000Z') })
  assert.equal(result.status, 'refused-before-effect')
  assert.equal(result.error, 'rule_expired')
  assert.equal(h.calls.posts.length, 0)
})

test('expiry crossing during live prechecks is repeated immediately before mutation', async () => {
  const h = harness({ expiresAt: '2026-09-18T12:00:30.000Z' })
  let clockReads = 0
  const result = await h.apply({}, { clock: () => ++clockReads === 1 ? now : new Date('2026-09-18T12:00:31.000Z') })
  assert.equal(result.status, 'refused-before-effect')
  assert.equal(result.error, 'expired_before_revision')
  assert.equal(h.calls.posts.length, 0)
})

test('one total operation deadline cannot be renewed by a slow target precheck', async () => {
  const h = harness()
  const result = await h.apply({ timeoutMs: 200 }, { readTarget: async options => {
    await new Promise(resolve => setTimeout(resolve, 210))
    return h.native.readTarget(options)
  } })
  assert.equal(result.status, 'refused-before-effect')
  assert.equal(result.error, 'operation_deadline_exhausted')
  assert.equal(h.calls.posts.length, 0)
})

test('duplicate-key or reformatted proposal JSON cannot masquerade as the prepared byte representation', async () => {
  const h = harness()
  const reformatted = Buffer.from(JSON.stringify(h.proposal))
  assert.equal((await h.apply({ proposalBytes: reformatted, expectedSha256: hash(reformatted) })).error, 'proposal_encoding_changed')
  const duplicated = Buffer.from(bytes(h.proposal).toString().replace('"schema_version": 1,', '"schema_version": 99,\n  "schema_version": 1,'))
  assert.equal((await h.apply({ proposalBytes: duplicated, expectedSha256: hash(duplicated) })).error, 'invalid_json_data')
  assert.equal(h.calls.posts.length, 0)
})

test('source drift after successful mutation is accurately retained as applied', async () => {
  const h = harness()
  const result = await h.apply({}, { readSource: async options => {
    if (h.calls.posts.length) h.changeSource(source => { source.task.contract_version++ })
    return h.native.readSource(options)
  } })
  assert.equal(result.status, 'applied-but-source-changed')
  assert.equal(result.native_revision_id, id(40))
  assert.equal(h.calls.posts.length, 1)
  assert.equal(h.calls.revisions.length, 1)
  assert.equal(result.launched, false)
})

test('source access loss after mutation is never mislabeled refusal-before-effects', async () => {
  const h = harness()
  const result = await h.apply({}, { readSource: options => {
    if (h.calls.posts.length) throw new Error('PRIVATE_AUTH_RESPONSE')
    return h.native.readSource(options)
  } })
  assert.equal(result.status, 'applied-but-source-changed')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AUTH_RESPONSE/)
  assert.equal(h.calls.posts.length, 1)
})

test('an HTTP error after a request is unknown without transaction-stage evidence and is not retried', async () => {
  const h = harness(); let attempts = 0
  const result = await h.apply({}, { revise: async () => { attempts++; const error = new Error('PRIVATE_CONFLICT'); error.httpStatus = 409; throw error } })
  assert.equal(result.status, 'outcome-unknown')
  assert.equal(result.native_http_status, 409)
  assert.equal(result.error, 'native_revision_not_confirmed')
  assert.equal(result.mutation_requests, 1)
  assert.equal(attempts, 1)
  assert.equal(h.calls.revisions.length, 0)
})

test('a contradictory successful response or changed native readback stays unknown', async () => {
  const h = harness()
  const result = await h.apply({}, { revise: async options => {
    const response = await h.native.revise(options)
    response.revision.replacement_verification_policy.manual_gate = null
    return response
  } })
  assert.equal(result.status, 'outcome-unknown')
  assert.equal(h.calls.posts.length, 1)
  assert.equal(h.calls.revisions.length, 1)
})

test('exact native target projection refuses filtered context and preserves whole scope', () => {
  const f = fixture()
  const payload = { snapshot: { corp: { id: id(1) }, missions: [f.target.mission], tasks: [f.target.task], runs: [], mission_contract_revisions: [] } }
  const context = { corp_id: id(1), actor_id: id(2), room_id: id(3), mission_id: id(10), origin: { kind: 'direct' } }
  const selection = { corpId: id(1), actorId: id(2), missionId: id(10), taskId: id(11) }
  assert.deepEqual(projectFeedbackTarget(payload, context, selection), f.target)
  assert.throws(() => projectFeedbackTarget(payload, null, selection), { code: 'target_origin_or_scope_mismatch' })
  assert.throws(() => projectFeedbackTarget(payload, { ...context, corp_id: id(99) }, selection), { code: 'target_origin_or_scope_mismatch' })
})

test('file input requires selected exact bytes and fails closed on an oversized or malformed input', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ecorp-feedback-input-'))
  const file = path.join(directory, 'proposal.json'), input = bytes({ selected: true })
  writeFileSync(file, input)
  assert.deepEqual(readFeedbackFile(file, hash(input)), input)
  assert.throws(() => readFeedbackFile(file, 'f'.repeat(64)), { code: 'input_byte_hash_mismatch' })
  writeFileSync(file, Buffer.alloc(1024 * 1024 + 1))
  assert.throws(() => readFeedbackFile(file), { code: 'unbounded_input' })
  assert.throws(() => readFeedbackFile('relative.json'), { code: 'absolute_input_path_required' })
  assert.equal(readFileSync(file).length, 1024 * 1024 + 1, 'failed input remains available')
})

test('CLI preparation writes new review artifacts and an existing apply receipt refuses before network or effects', async () => {
  const h = harness()
  const directory = mkdtempSync(path.join(tmpdir(), 'ecorp-feedback-command-'))
  const corpus = path.join(directory, 'corpus.json'), review = path.join(directory, 'review.txt'), receipt = path.join(directory, 'source.json')
  for (const [file, value] of [[corpus, h.options.corpusBytes], [review, h.options.reviewBytes], [receipt, h.options.receiptBytes]]) writeFileSync(file, value)
  const out = path.join(directory, 'proposal.json')
  const prepare = await main(['--corpus', corpus, '--corpus-sha256', hash(h.options.corpusBytes), '--review', review,
    '--review-sha256', hash(h.options.reviewBytes), '--receipt', receipt, '--receipt-sha256', hash(h.options.receiptBytes),
    '--artifact-id', id(9), '--rule-ids', h.options.selectedRuleIds.join(','), '--mission-id', id(10), '--task-id', id(11), '--out', out],
  { ...h.native, env, clock: () => now })
  assert.equal(prepare.status, 'ready-for-review')
  assert.equal(prepare.exit_code, 0)
  assert.equal(hash(readFileSync(out)), prepare.output_sha256)
  assert.match(readFileSync(`${out}.md`, 'utf8'), /Existing references/)
  assert.equal(h.calls.posts.length, 0)
  const saved = path.join(directory, 'application.json')
  writeFileSync(saved, 'Existing receipt must survive')
  const before = h.calls.reads
  await assert.rejects(main(['apply', '--proposal', out, '--sha256', prepare.output_sha256, '--corpus', corpus,
    '--review', review, '--receipt', receipt, '--out', saved], { ...h.native, env, clock: () => now }))
  assert.equal(h.calls.reads, before)
  assert.equal(h.calls.posts.length, 0)
  assert.equal(readFileSync(saved, 'utf8'), 'Existing receipt must survive')
})

test('CLI exits nonzero for refused adoption while preserving its JSON receipt', () => {
  const h = harness()
  const directory = mkdtempSync(path.join(tmpdir(), 'ecorp-feedback-exit-'))
  const proposal = { ...h.proposal, state: 'candidate', reasons: ['independent_review_not_proven'], request: null }
  const files = { proposal: path.join(directory, 'proposal.json'), corpus: path.join(directory, 'corpus.json'),
    review: path.join(directory, 'review.txt'), receipt: path.join(directory, 'source.json'), out: path.join(directory, 'apply.json') }
  for (const [file, value] of [[files.proposal, bytes(proposal)], [files.corpus, h.options.corpusBytes], [files.review, h.options.reviewBytes], [files.receipt, h.options.receiptBytes]]) writeFileSync(file, value)
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./operation_feedback.mjs', import.meta.url)), 'apply',
    '--proposal', files.proposal, '--sha256', hash(bytes(proposal)), '--corpus', files.corpus, '--review', files.review,
    '--receipt', files.receipt, '--out', files.out], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 2)
  assert.equal(JSON.parse(child.stdout).status, 'refused-before-effect')
  const retained = JSON.parse(readFileSync(files.out, 'utf8'))
  assert.equal(retained.status, 'refused-before-effect')
  assert.equal(retained.mutation_requests, 0)
  assert.equal(feedbackCommandExitCode('apply', { status: 'applied' }), 0)
  assert.equal(feedbackCommandExitCode('apply', { status: 'outcome-unknown' }), 3)
  assert.equal(feedbackCommandExitCode('apply', { status: 'applied-but-source-changed' }), 3)
  assert.equal(feedbackCommandExitCode('apply', { status: 'unrecognized' }), 3)
  assert.equal(feedbackCommandExitCode('prepare', { state: 'candidate' }), 0)
})

test('CLI typed prepare explicitly selects the native file and apply has no path override', async () => {
  const h = harness({ typed: true })
  const directory = mkdtempSync(path.join(tmpdir(), 'ecorp-feedback-typed-command-'))
  const corpus = path.join(directory, 'corpus.json'), review = path.join(directory, 'review.txt'), receipt = path.join(directory, 'receipt.json')
  for (const [file, value] of [[corpus, h.options.corpusBytes], [review, h.options.reviewBytes], [receipt, h.options.receiptBytes]]) writeFileSync(file, value)
  const output = path.join(directory, 'proposal.json')
  const result = await main(['prepare', '--corpus', corpus, '--corpus-sha256', hash(h.options.corpusBytes), '--review', review,
    '--review-sha256', hash(h.options.reviewBytes), '--receipt', receipt, '--receipt-sha256', hash(h.options.receiptBytes), '--artifact-id', id(9),
    '--artifact-path', 'corpus.json', '--rule-ids', h.options.selectedRuleIds[0], '--mission-id', id(10), '--task-id', id(11), '--out', output],
  { ...h.native, env, clock: () => now })
  assert.equal(result.status, 'ready-for-review')
  assert.equal(result.exit_code, 0)
  const proposal = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(proposal.inputs.artifact_path, 'corpus.json')
  assert.equal(proposal.source.corpus_binding.kind, 'typed-artifact-set-file')
  assert.equal(h.calls.posts.length, 0)
  await assert.rejects(main(['apply', '--artifact-path', 'different.json'], h.native), { code: 'invalid_arguments' })
})
