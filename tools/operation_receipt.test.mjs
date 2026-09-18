import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { exportOperationEvidence, exportOperationReceipt, operationReceiptFingerprint, projectOperationState, validateOperationReceipt, verifyArtifactBytes } from './operation_receipt.mjs'

const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const sha = (value) => createHash('sha256').update(value).digest('hex')
const time = '2026-09-17T12:00:00.123456789Z'
const PRIVATE = 'PRIVATE_NATIVE_PAYLOAD_MUST_NOT_APPEAR'
const BYTES = Buffer.from('controlled fixture artifact\n')
const binary = process.env.CRONY_MCP_TEST_BINARY
const nativeOptions = { skip: !binary && 'Set CRONY_MCP_TEST_BINARY to the compiled native MCP gateway' }
function configuration(origin = 'http://127.0.0.1:19871') {
  return { corpId: id(1), actorId: id(2), childEnv: { CRONY_SERVER_HTTP: origin } }
}
function environment(origin) {
  return { ...process.env, CRONY_SERVER_HTTP: origin, CRONY_CORP_ID: id(1), CRONY_ACTOR_ID: id(2),
    CRONY_MCP_BINARY: binary, CRONY_ACCESS_TOKEN: 'synthetic-receipt-fixture-token' }
}
function fixture(factory = false) {
  const run = { id: id(6), corp_id: id(1), task_id: id(5), agent_id: id(7), runner_id: 'fixture-runner',
    model: 'anthropic/claude-fixture', execution_mode: 'fresh', status: 'completed', verification_status: 'passed',
    verification_sha256: null, deliverable_sha256: null, created_at: time, updated_at: time, resumed_from_run_id: null,
    source_repository: 'example/receipt', source_base_ref: 'main', source_base_commit: 'a'.repeat(40),
    artifact_id: id(9), artifact_sha256: sha(BYTES), artifact_media_type: 'text/plain', artifact_signature: 'b'.repeat(64),
    artifact_uri: `https://untrusted.example.test/${PRIVATE}`, provider_session_id: PRIVATE, workspace_path: PRIVATE, summary: PRIVATE }
  const task = { id: id(5), corp_id: id(1), mission_id: id(4), status: 'completed', contract_version: 1,
    attempt_count: 1, max_attempts: 2, assigned_agent_id: id(7), updated_at: time,
    verification_policy: { checks: [{ kind: 'invented-current-policy' }, {}, {}] }, objective: PRIVATE }
  const mission = { id: id(4), corp_id: id(1), room_id: id(3), status: 'completed', specification_version: 1, updated_at: time, prompt: PRIVATE }
  const evidence = { id: id(8), corp_id: id(1), task_id: id(5), run_id: id(6), check_index: 0, kind: 'command', status: 'passed',
    payload: { exit_code: 0, stdout: PRIVATE }, summary: PRIVATE }
  const event = { id: id(10), corp_id: id(1), room_id: id(3), type: 'run.verification_started', aggregate_type: 'run', aggregate_id: id(6), payload: { check_count: 1 } }
  const payload = { snapshot: { corp: { id: id(1) }, actors: [{ id: id(2) }], rooms: [{ id: id(3), corp_id: id(1) }],
    agents: [{ id: id(7), corp_id: id(1) }], missions: [mission], tasks: [task], runs: [run], verification_evidence: [evidence], events: [event],
    verification_requests: [], factory_verification_recoveries: [], source_deliverables: [], pull_request_publications: [] }, runners: [] }
  const contexts = { mission: { corp_id: id(1), actor_id: id(2), room_id: id(3), mission_id: id(4), origin: { kind: 'direct' } }, publication: null }
  if (factory) {
    contexts.mission.origin = { kind: 'factory', work_item_id: id(11), source_repository: 'example/receipt', source_issue_number: 42, source_issue_url: 'https://github.com/example/receipt/issues/42' }
    const deliverable = { id: id(12), corp_id: id(1), task_id: id(5), run_id: id(6), artifact_id: id(13), form: 'commit_branch',
      sha256: sha(BYTES), media_type: 'application/octet-stream', bytes: BYTES.length, provenance_signature: 'c'.repeat(64),
      verification_sha256: 'd'.repeat(64), base_commit: 'a'.repeat(40), head_commit: 'e'.repeat(40), branch: 'codex/fixture', uri: `https://untrusted.example.test/${PRIVATE}` }
    const publication = { id: id(14), corp_id: id(1), factory_work_item_id: id(11), mission_id: id(4), task_id: id(5), run_id: id(6),
      source_deliverable_id: id(12), artifact_id: id(13), source_issue_number: 42, source_issue_url: contexts.mission.origin.source_issue_url,
      target_repository: 'example/receipt', base_ref: 'main', branch: 'codex/published', commit_sha: 'e'.repeat(40), state: 'published', version: 5, updated_at: time,
      pull_request_number: 43, pull_request_url: 'https://github.com/example/receipt/pull/43', pull_request_head_sha: 'e'.repeat(40), pull_request_state: 'open',
      pull_request_head_repository_owner: 'example', pull_request_is_cross_repository: false, pull_request_base_ref: 'main', pull_request_draft: true,
      provenance: { schema_version: 2, factory_work_item_id: id(11), mission_id: id(4), task_ids: [id(5)], run_ids: [id(6)], verification_sha256: 'd'.repeat(64),
        deliverable: { id: id(12), artifact_id: id(13), sha256: sha(BYTES), base_commit: 'a'.repeat(40), head_commit: 'e'.repeat(40), source_branch: 'codex/fixture' },
        target: { repository: 'example/receipt', base_ref: 'main', branch: 'codex/published', commit: 'e'.repeat(40) },
        source_issue: { number: 42, url: contexts.mission.origin.source_issue_url },
        pull_request: { url: 'https://github.com/example/receipt/pull/43', number: 43, state: 'open', draft: true, head_sha: 'e'.repeat(40), base_ref: 'main', head_repository_owner: 'example', is_cross_repository: false } } }
    contexts.publication = { work_item: { id: id(11), corp_id: id(1), mission_id: id(4), source_repository_owner: 'example', source_repository_name: 'receipt',
      source_issue_number: 42, source_issue_url: contexts.mission.origin.source_issue_url, version: 5, state: 'published', source_revision: `revision-1-${PRIVATE}`, updated_at: time },
      publication, source_deliverables: [deliverable] }
  }
  return { payload, contexts, run, task, mission, evidence, event }
}
function project(value, mode = 'current-run', config = configuration()) {
  return projectOperationState(value.payload, value.contexts, config, id(6), mode)
}
function headers(reference) {
  return new Headers({ 'content-type': reference.media_type, 'content-length': String(BYTES.length), 'etag': `"${sha(BYTES)}"`,
    'x-content-type-options': 'nosniff', 'x-crony-artifact-role': reference.role, 'x-crony-artifact-signature': reference.signature })
}
function receipt(value = fixture(), mode = 'current-run') {
  const projected = project(value, mode)
  return validateOperationReceipt({ ...projected.body, checked_at: time, duration_ms: 0,
    artifacts: projected.artifactReferences.map((entry) => verifyArtifactBytes(entry, BYTES, headers(entry))) })
}

test('receipt whitelists metadata and distinguishes persisted acceptance from optional verifier digests', () => {
  const result = receipt()
  assert.equal(result.verification.persisted_acceptance_observed, true)
  assert.equal(result.verification.automated_checks_complete, true)
  assert.equal(result.run.verification_sha256, null)
  assert.equal(result.artifacts[0].client_hmac_verified, false)
  assert.equal(result.assurance.offline_authority, false)
  assert.equal(JSON.stringify(result).includes(PRIVATE), false)
  assert.equal(JSON.stringify(result).includes('untrusted.example.test'), false)
  assert.equal(JSON.stringify(result).includes('b'.repeat(64)), false)
})

test('native runner, model and ref metadata preserves valid punctuation, spaces, Unicode and UTF-8 limits', () => {
  for (const [runner, model, ref] of [
    ['QA Laptop', 'vendor/model:west v2', '_release'],
    ['runner:west', 'model+preview', 'release+hotfix'],
    ['実行端末', 'モデル選択', '機能/更新'],
    ['r'.repeat(128), 'm'.repeat(128), 'r'.repeat(240)],
    ['é'.repeat(64), '💡'.repeat(32), '機'.repeat(80)],
  ]) {
    const value = fixture()
    Object.assign(value.run, { runner_id: runner, model, source_base_ref: ref })
    const result = receipt(value)
    assert.equal(result.run.runner_id, runner)
    assert.equal(result.run.model, model)
    assert.equal(result.source.base_ref, ref)
    assert.equal(JSON.stringify(result).includes(PRIVATE), false)
  }
})

test('native metadata keeps bounded invalid text and malformed source tuples out of receipts', () => {
  for (const [field, invalid] of [
    ['runner_id', ''], ['runner_id', '   '], ['runner_id', 'é'.repeat(65)], ['runner_id', 'r'.repeat(129)], ['runner_id', '\uD800'],
    ['model', ''], ['model', '\t'], ['model', '💡'.repeat(33)], ['model', 'm'.repeat(129)], ['model', {}],
    ['source_base_ref', ''], ['source_base_ref', ' '], ['source_base_ref', '機'.repeat(81)], ['source_base_ref', 'r'.repeat(241)],
    ['source_repository', `${'r'.repeat(101)}/repo`], ['source_repository', `owner/${'r'.repeat(101)}`],
    ['source_repository', 'Kelvin/repo'], ['source_repository', 'owner/repo/extra'], ['source_base_commit', 'a'.repeat(39)],
  ]) {
    const value = fixture()
    value.run[field] = invalid
    assert.throws(() => project(value), undefined, field)
  }
  const value = fixture(true)
  value.contexts.publication.work_item.source_revision = 'é'.repeat(81)
  assert.throws(() => project(value), /source revision/u)
})

test('native source identity accepts uppercase hexadecimal commits and full bounded repository components', () => {
  const value = fixture()
  value.run.source_base_commit = 'A'.repeat(40)
  value.run.source_repository = `${'A'.repeat(100)}/${'b'.repeat(100)}`
  const result = receipt(value)
  assert.equal(result.source.base_commit, 'A'.repeat(40))
  assert.equal(result.source.repository, value.run.source_repository.toLowerCase())
})

test('published native refs and native MIME token punctuation are observed without a custom identifier alphabet', () => {
  const value = fixture(true)
  value.contexts.publication.publication.base_ref = '_機能+hotfix'
  value.contexts.publication.publication.provenance.target.base_ref = '_機能+hotfix'
  value.run.artifact_media_type = 'text/x_fixture'
  const result = receipt(value, 'published-result')
  assert.equal(result.publication.base_ref, '_機能+hotfix')
  assert.equal(result.artifacts.find(entry => entry.role === 'provider_evidence').media_type, 'text/x_fixture')
})

test('historical evidence never borrows the current task verifier policy count', () => {
  const value = fixture()
  value.payload.snapshot.events = []
  assert.equal(receipt(value).verification.expected_check_count, null)
  assert.equal(receipt(value).verification.automated_checks_passed, false)
  assert.equal(receipt(value).verification.persisted_acceptance_observed, true)
})

test('conflicting or invalid run-bound check counts remain unknown', () => {
  for (const count of [0, 2, '1', 1.5, null]) {
    const value = fixture()
    value.payload.snapshot.events.push({ ...value.event, id: id(30), payload: { check_count: count } })
    assert.equal(receipt(value).verification.expected_check_count, null)
    assert.equal(receipt(value).verification.automated_checks_complete, false)
  }
})

test('missing and duplicate check indices cannot establish completeness; malformed indices fail', () => {
  const value = fixture()
  value.event.payload.check_count = 2
  assert.equal(receipt(value).verification.automated_checks_complete, false)
  value.payload.snapshot.verification_evidence.push({ ...value.evidence, id: id(30) })
  assert.equal(receipt(value).verification.automated_checks_complete, false)
  value.evidence.check_index = -1
  assert.throws(() => receipt(value), /check_index/u)
})

for (const [label, change] of [
  ['run Corp', value => { value.run.corp_id = id(90) }],
  ['task Corp', value => { value.task.corp_id = id(90) }],
  ['mission Corp', value => { value.mission.corp_id = id(90) }],
  ['room Corp', value => { value.payload.snapshot.rooms[0].corp_id = id(90) }],
  ['exact actor', value => { value.contexts.mission.actor_id = id(90) }],
  ['exact room', value => { value.contexts.mission.room_id = id(90) }],
  ['exact mission', value => { value.contexts.mission.mission_id = id(90) }],
  ['evidence task', value => { value.evidence.task_id = id(90) }],
  ['event room', value => { value.event.room_id = id(90) }],
  ['partial source', value => { value.run.source_base_commit = null }],
]) test(`receipt rejects mismatched ${label}`, () => { const value = fixture(); change(value); assert.throws(() => project(value)) })

test('current-run rejects later same-task runs and tied times, retaining nanosecond ordering', () => {
  for (const created_at of ['2026-09-17T12:00:00.123456790Z', time]) {
    const value = fixture()
    value.payload.snapshot.runs.push({ ...value.run, id: id(30), created_at })
    assert.throws(() => project(value), /unambiguous current/u)
  }
  const value = fixture()
  value.payload.snapshot.runs.push({ ...value.run, id: id(30), created_at: '2026-09-17T12:00:00.123456788Z' })
  assert.equal(receipt(value).run.is_latest_task_run, true)
  value.payload.snapshot.runs[1].task_id = id(90)
  value.payload.snapshot.runs[1].created_at = '2026-09-17T13:00:00Z'
  assert.equal(receipt(value).run.is_latest_task_run, true)
})

test('typed resume lineage requires same task and producer, and records unavailable ancestors honestly', () => {
  const value = fixture()
  value.run.resumed_from_run_id = id(30)
  assert.equal(receipt(value).lineage.resume_chain_complete, false)
  const ancestor = { ...value.run, id: id(30), resumed_from_run_id: null, created_at: '2026-09-17T11:00:00Z' }
  value.payload.snapshot.runs.push(ancestor)
  assert.deepEqual(receipt(value).lineage.resume_run_ids, [id(30)])
  assert.equal(receipt(value).lineage.resume_chain_complete, true)
  ancestor.resumed_from_run_id = id(6)
  assert.throws(() => project(value), /resume lineage/u)
  ancestor.resumed_from_run_id = null
  ancestor.task_id = id(90)
  assert.throws(() => project(value), /task scope/u)
})

test('exact recovery count is run-bound; private policy and notes are omitted', () => {
  const value = fixture()
  value.payload.snapshot.events = []
  value.payload.snapshot.factory_verification_recoveries.push({ id: id(30), corp_id: id(1), mission_id: id(4), task_id: id(5), source_run_id: id(31),
    replacement_run_id: id(6), replacement_verification_policy: { checks: [{ command: PRIVATE }] }, reason: PRIVATE })
  value.payload.snapshot.verification_requests.push({ run_id: id(6), corp_id: id(1), task_id: id(5), gate_type: 'human_review', status: 'approved', decided_by: id(2), decided_at: time, decision_note: PRIVATE })
  const result = receipt(value)
  assert.equal(result.verification.expected_check_count, 1)
  assert.deepEqual(result.lineage.recovery_ids, [id(30)])
  assert.equal(JSON.stringify(result).includes(PRIVATE), false)
})

test('published-result binds its exact source artifact and hashes opaque source revisions', () => {
  const result = receipt(fixture(true), 'published-result')
  assert.equal(result.publication.matches_selected_run, true)
  assert.equal(result.publication.recorded_pr_state, 'OPEN')
  assert.equal(result.factory.source_revision_sha256, sha(`revision-1-${PRIVATE}`))
  assert.equal(result.artifacts.length, 2)
  assert.equal(JSON.stringify(result).includes(PRIVATE), false)
})

test('published-result accepts an exact historical publication despite a later same-task run', () => {
  const value = fixture(true)
  value.payload.snapshot.runs.push({ ...value.run, id: id(30), created_at: '2026-09-17T13:00:00Z' })
  const result = receipt(value, 'published-result')
  assert.equal(result.run.is_latest_task_run, false)
  assert.equal(result.publication.matches_selected_run, true)
})

for (const [label, change] of [
  ['Factory mission', value => { value.contexts.publication.work_item.mission_id = id(90) }],
  ['deliverable task', value => { value.contexts.publication.source_deliverables[0].task_id = id(90) }],
  ['deliverable source base', value => { value.contexts.publication.source_deliverables[0].base_commit = 'f'.repeat(40) }],
  ['run deliverable digest', value => { value.run.deliverable_sha256 = 'f'.repeat(64) }],
  ['publication run', value => { value.contexts.publication.publication.run_id = id(90) }],
  ['provenance mission', value => { value.contexts.publication.publication.provenance.mission_id = id(90) }],
  ['provenance source issue', value => { value.contexts.publication.publication.provenance.source_issue.number = 99 }],
  ['provenance target', value => { value.contexts.publication.publication.provenance.target.commit = 'f'.repeat(40) }],
  ['recorded PR head', value => { value.contexts.publication.publication.pull_request_head_sha = 'f'.repeat(40) }],
  ['recorded PR repository', value => { value.contexts.publication.publication.pull_request_head_repository_owner = 'other' }],
  ['recorded PR provenance', value => { value.contexts.publication.publication.provenance.pull_request.number = 99 }],
]) test(`published-result refuses mismatched ${label}`, () => { const value = fixture(true); change(value); assert.throws(() => receipt(value, 'published-result')) })

test('byte verification rejects tampering and each missing or conflicting native response boundary', () => {
  const reference = project(fixture()).artifactReferences[0]
  assert.throws(() => verifyArtifactBytes(reference, Buffer.from('tampered'), headers(reference)), /digest/u)
  for (const name of ['content-type', 'content-length', 'etag', 'x-content-type-options', 'x-crony-artifact-role', 'x-crony-artifact-signature']) {
    const altered = headers(reference)
    altered.delete(name)
    assert.throws(() => verifyArtifactBytes(reference, BYTES, altered))
  }
  assert.throws(() => verifyArtifactBytes({ ...reference, bytes: BYTES.length + 1 }, BYTES, headers(reference)), /length/u)
})

test('receipt validator rejects extra content, contradictory acceptance, and mixed origin/artifact roles', () => {
  for (const change of [
    value => { value.private_note = PRIVATE },
    value => { value.assurance.offline_authority = true },
    value => { value.run.status = 'failed' },
    value => { value.origin.work_item_id = id(11) },
    value => { value.artifacts[0].source_deliverable_id = id(12) },
    value => { value.artifacts.push(structuredClone(value.artifacts[0])) },
    value => { value.lineage.resume_run_ids = [id(6)] },
    value => { value.verification.automated_checks_complete = false },
  ]) { const value = receipt(); change(value); assert.throws(() => validateOperationReceipt(value)) }
})

test('fingerprint tolerates observation timestamps and detects selected source, contract and artifact drift', () => {
  const original = receipt()
  const value = structuredClone(original)
  value.checked_at = '2026-09-17T13:00:00Z'
  value.duration_ms = 100
  assert.equal(operationReceiptFingerprint(original), operationReceiptFingerprint(value))
  for (const change of [
    candidate => { candidate.task.contract_version += 1 },
    candidate => { candidate.source.base_commit = 'f'.repeat(40) },
    candidate => { candidate.artifacts[0].sha256 = 'f'.repeat(64) },
    candidate => { candidate.scope.actor_id = id(90) },
  ]) { const candidate = structuredClone(original); change(candidate); assert.notEqual(operationReceiptFingerprint(candidate), operationReceiptFingerprint(original)) }
})

async function apiFixture(t, value, changeResponse) {
  const requests = []
  let snapshots = 0
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    if (changeResponse?.(request, response, ++requestCount)) return
    const url = new URL(request.url, 'http://fixture.test')
    if (url.pathname.endsWith('/snapshot')) {
      snapshots += 1
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(value.payload))
    } else if (url.pathname.endsWith('/context')) response.end(JSON.stringify(value.contexts.mission))
    else if (url.pathname.endsWith('/publication-context')) response.end(JSON.stringify(value.contexts.publication))
    else if (url.pathname.includes('/artifacts/')) {
      const reference = project(value, value.contexts.publication ? 'published-result' : 'current-run').artifactReferences.find(entry => url.pathname.endsWith(entry.id))
      if (!reference) { response.writeHead(404); response.end(PRIVATE); return }
      headers(reference).forEach((header, name) => response.setHeader(name, header))
      response.end(BYTES)
    } else { response.writeHead(404); response.end(PRIVATE) }
  })
  let requestCount = 0
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, snapshots: () => snapshots }
}

test('compiled native MCP export performs two captures and downloads only selected-origin artifact IDs', nativeOptions, async t => {
  const value = fixture(true)
  const api = await apiFixture(t, value)
  const result = await exportOperationReceipt({ env: environment(api.origin), runId: id(6), mode: 'published-result' })
  assert.equal(api.snapshots(), 2)
  assert.equal(api.requests.length, 8)
  assert.ok(api.requests.every(request => request.method === 'GET' && request.authorization === 'Bearer synthetic-receipt-fixture-token' && request.url.endsWith(`actor_id=${id(2)}`)))
  assert.equal(result.scope.server_origin_sha256, sha(api.origin))
  assert.equal(result.artifacts.length, 2)
  assert.equal(JSON.stringify(result).includes(PRIVATE), false)
})

test('artifact retention selection is bounded before reading host configuration', async () => {
  const letterId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  for (const artifactIds of [null, {}, [[id(9)]], [letterId, letterId.toUpperCase()], Array.from({ length: 9 }, (_, index) => id(index)), ['outside']]) {
    await assert.rejects(exportOperationEvidence({ env: {}, runId: id(6), artifactIds }), /Invalid retained artifact selection/u)
  }
})

test('compiled native evidence retains only explicitly selected verified bytes and preserves public receipt schema', nativeOptions, async t => {
  const api = await apiFixture(t, fixture(true))
  const options = { env: environment(api.origin), runId: id(6), mode: 'published-result' }
  const selected = await exportOperationEvidence({ ...options, artifactIds: [id(9)] })
  assert.equal(selected.receipt.artifacts.length, 2)
  assert.deepEqual(selected.artifactBytes, [{ id: id(9), bytes: BYTES }])
  assert.equal(api.snapshots(), 2)
  const unselected = await exportOperationEvidence(options)
  assert.deepEqual(unselected.artifactBytes, [])
  const publicReceipt = await exportOperationReceipt({ ...options, artifactIds: [id(9)] })
  assert.equal(Object.hasOwn(publicReceipt, 'artifactBytes'), false)
  assert.equal(operationReceiptFingerprint(publicReceipt), operationReceiptFingerprint(selected.receipt))
  assert.equal(JSON.stringify(publicReceipt).includes(BYTES.toString()), false)
  assert.ok(api.requests.every(request => request.method === 'GET'))
})

test('compiled native evidence rejects an unowned artifact selection before any artifact download', nativeOptions, async t => {
  const api = await apiFixture(t, fixture())
  await assert.rejects(exportOperationEvidence({ env: environment(api.origin), runId: id(6), artifactIds: [id(99)] }), /Selected artifact unavailable/u)
  assert.equal(api.requests.filter(request => request.url.includes('/artifacts/')).length, 0)
})

test('compiled native evidence never returns retained bytes from a tampered artifact or changed source', nativeOptions, async t => {
  const tampered = fixture()
  const badApi = await apiFixture(t, tampered, (request, response) => {
    if (!request.url.includes('/artifacts/')) return false
    const reference = project(tampered).artifactReferences[0]
    headers(reference).forEach((header, name) => response.setHeader(name, header))
    const bytes = Buffer.from(BYTES); bytes[0] ^= 1
    response.end(bytes)
    return true
  })
  await assert.rejects(exportOperationEvidence({ env: environment(badApi.origin), runId: id(6), artifactIds: [id(9)] }), /digest/u)
  const changed = fixture()
  const driftApi = await apiFixture(t, changed, request => {
    if (request.url.includes('/artifacts/')) changed.task.contract_version += 1
    return false
  })
  await assert.rejects(exportOperationEvidence({ env: environment(driftApi.origin), runId: id(6), artifactIds: [id(9)] }), /changed during receipt collection/u)
})

test('compiled native exporter keeps opaque runner/model/ref metadata out of every request route', nativeOptions, async t => {
  const value = fixture()
  Object.assign(value.run, { runner_id: 'QA Laptop:west', model: 'モデル/profile v2', source_base_ref: '_機能+hotfix' })
  const api = await apiFixture(t, value)
  const result = await exportOperationReceipt({ env: environment(api.origin), runId: id(6) })
  assert.equal(result.run.runner_id, value.run.runner_id)
  assert.equal(result.run.model, value.run.model)
  assert.equal(result.source.base_ref, value.run.source_base_ref)
  assert.deepEqual(api.requests.map(request => request.url), [
    `/api/corps/${id(1)}/snapshot?actor_id=${id(2)}`,
    `/api/corps/${id(1)}/missions/${id(4)}/context?actor_id=${id(2)}`,
    `/api/corps/${id(1)}/artifacts/${id(9)}?actor_id=${id(2)}`,
    `/api/corps/${id(1)}/snapshot?actor_id=${id(2)}`,
    `/api/corps/${id(1)}/missions/${id(4)}/context?actor_id=${id(2)}`,
  ])
})

test('compiled native export rejects state drift during its artifact read', nativeOptions, async t => {
  const value = fixture()
  const api = await apiFixture(t, value, (request) => {
    if (request.url.includes('/artifacts/')) value.task.contract_version += 1
    return false
  })
  await assert.rejects(exportOperationReceipt({ env: environment(api.origin), runId: id(6) }), /changed during/u)
  assert.equal(api.snapshots(), 2)
})

test('compiled native export rejects mismatched context before downloading artifacts', nativeOptions, async t => {
  const value = fixture()
  value.contexts.mission.actor_id = id(90)
  const api = await apiFixture(t, value)
  await assert.rejects(exportOperationReceipt({ env: environment(api.origin), runId: id(6) }), /context mismatch/u)
  assert.equal(api.requests.some(request => request.url.includes('/artifacts/')), false)
})

test('compiled native export refuses artifact redirects without forwarding credentials', nativeOptions, async t => {
  const target = await apiFixture(t, fixture())
  const api = await apiFixture(t, fixture(), (request, response) => {
    if (!request.url.includes('/artifacts/')) return false
    response.writeHead(302, { location: `${target.origin}/private-target` })
    response.end(PRIVATE)
    return true
  })
  await assert.rejects(exportOperationReceipt({ env: environment(api.origin), runId: id(6) }), /details withheld/u)
  assert.equal(target.requests.length, 0)
})

test('compiled native export rejects oversized bodies and withholds HTTP error content', nativeOptions, async t => {
  for (const oversized of [true, false]) {
    const api = await apiFixture(t, fixture(), (request, response) => {
      if (!request.url.includes('/missions/')) return false
      response.writeHead(oversized ? 200 : 403, oversized ? { 'content-length': String(5 * 1024 * 1024) } : {})
      response.end(PRIVATE)
      return true
    })
    const error = await exportOperationReceipt({ env: environment(api.origin), runId: id(6) }).then(() => null, value => value)
    assert.ok(error instanceof Error)
    assert.equal(error.message.includes(PRIVATE), false)
    assert.equal(api.requests.some(request => request.url.includes('/artifacts/')), false)
  }
})

test('compiled native export bounds a stalled exact-context body by its whole-operation timeout', nativeOptions, async t => {
  const api = await apiFixture(t, fixture(), (request, response) => {
    if (!request.url.includes('/missions/')) return false
    response.writeHead(200)
    response.write(' ')
    return true
  })
  const started = performance.now()
  await assert.rejects(exportOperationReceipt({ env: environment(api.origin), runId: id(6), timeoutMs: 1000 }), /withheld/u)
  assert.ok(performance.now() - started < 4000)
  assert.equal(api.requests.some(request => request.url.includes('/artifacts/')), false)
})

test('receipt CLI writes a create-only metadata file and a compact redacted summary', nativeOptions, async t => {
  const api = await apiFixture(t, fixture())
  const output = path.join(await mkdtemp(path.join(tmpdir(), 'ecorp-receipt-test-')), 'receipt.json')
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tools/operation_receipt.mjs', '--run-id', id(6), '--output', output],
      { env: environment(api.origin), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value })
    child.stderr.on('data', value => { stderr += value })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
  const first = await invoke()
  assert.equal(first.code, 0)
  assert.deepEqual(Object.keys(JSON.parse(first.stdout)).sort(), ['fingerprint', 'kind', 'observation_only', 'run_id'])
  const original = await readFile(output)
  validateOperationReceipt(JSON.parse(original))
  const second = await invoke()
  assert.equal(second.code, 1)
  assert.deepEqual(await readFile(output), original)
  assert.equal((first.stdout + second.stderr + original).includes(PRIVATE), false)
})
