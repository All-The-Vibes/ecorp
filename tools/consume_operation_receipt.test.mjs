import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { consumeOperationReceipt, readOperationReceipt } from './consume_operation_receipt.mjs'

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const hash = value => createHash('sha256').update(value).digest('hex')
const time = '2026-09-17T12:00:00.000Z'
const runId = id(6)
const clone = value => structuredClone(value)

function receipt() {
  return {
    schema_version: 1, kind: 'ecorp-operation-receipt', mode: 'current-run', checked_at: time, duration_ms: 1,
    scope: { server_origin_sha256: hash('http://127.0.0.1:19871'), corp_id: id(1), actor_id: id(2), room_id: id(3), mission_id: id(4), task_id: id(5), run_id: runId },
    source: { repository: 'ecorp-fixture/receipt', base_ref: 'main', base_commit: 'a'.repeat(40) },
    mission: { status: 'completed', specification_version: 1, updated_at: time },
    task: { status: 'completed', contract_version: 1, attempt_count: 1, max_attempts: 2, assigned_agent_id: id(7), updated_at: time },
    run: { status: 'completed', verification_status: 'passed', agent_id: id(7), runner_id: 'fixture-runner', model: null, execution_mode: 'fresh', created_at: time, updated_at: time, resumed_from_run_id: null, verification_sha256: 'b'.repeat(64), deliverable_sha256: null, is_latest_task_run: true },
    origin: { kind: 'direct', work_item_id: null, repository: null, issue_number: null },
    factory: null, publication: null,
    verification: { persisted_acceptance_observed: true, expected_check_count: 1, automated_checks_complete: true, automated_checks_passed: true, evidence: [{ id: id(8), check_index: 0, kind: 'file', status: 'passed', exit_code: null }], manual_gate: null },
    artifacts: [{ id: id(9), role: 'provider_evidence', sha256: hash('fixture bytes'), media_type: 'application/json', bytes: 13, source_deliverable_id: null, verification_sha256: null, base_commit: null, head_commit: null, byte_hash_verified: true, signature_header_matches_record: true, client_hmac_verified: false }],
    lineage: { resume_run_ids: [], resume_chain_complete: true, recovery_ids: [] },
    coverage: { verification_evidence: 'bounded_excerpt', events: 'bounded_excerpt', recoveries: 'bounded_excerpt', source_deliverables: 'bounded_excerpt' },
    assurance: { read_only: true, non_atomic: true, observation_only: true, authenticity_claim: false, offline_authority: false, production_identity_verified: false, credential_delivery: 'not_supplied', server_hmac_verification: 'server_download_boundary', client_hmac_verified: false, remote_pr_rechecked: false, future_authority_granted: false },
  }
}

test('consumer rereads native state using trusted routing and tolerates only observation timing changes', async () => {
  const original = receipt()
  const current = clone(original)
  current.checked_at = '2026-09-17T12:01:00.000Z'
  current.duration_ms = 42
  const env = { CRONY_SERVER_HTTP: 'https://selected.example.test', CRONY_CORP_ID: id(1) }
  let reads = 0
  const readCurrent = async options => {
    reads += 1
    assert.equal(options.env, env)
    assert.equal(options.runId, runId)
    assert.equal(options.mode, 'current-run')
    assert.equal(options.timeoutMs, 5000)
    return clone(current)
  }
  const first = await consumeOperationReceipt({ receipt: original, runId, env, timeoutMs: 5000, readCurrent })
  const second = await consumeOperationReceipt({ receipt: original, runId, env, timeoutMs: 5000, readCurrent })
  assert.equal(reads, 2, 'each repetition must revalidate against native authority')
  assert.deepEqual(first, second)
  assert.equal(first.persisted_acceptance_observed, true)
  assert.equal(first.read_only, true)
  assert.equal(first.artifact_count, 1)
  assert.equal(first.checked_at, current.checked_at)
  assert.equal(Object.hasOwn(first, 'token'), false)
  assert.equal(JSON.stringify(first).includes('selected.example.test'), false)
})

for (const [label, change] of [
  ['task contract revision', value => { value.task.contract_version += 1 }],
  ['source base commit', value => { value.source.base_commit = 'c'.repeat(40) }],
  ['verifier digest', value => { value.run.verification_sha256 = 'd'.repeat(64) }],
  ['another actor scope', value => { value.scope.actor_id = id(22) }],
]) {
  test(`consumer refuses ${label} drift in a fresh observation`, async () => {
    const old = receipt()
    const current = clone(old)
    change(current)
    await assert.rejects(consumeOperationReceipt({ receipt: old, runId, readCurrent: async () => current }), { code: 'stale_or_mismatched_receipt' })
  })
}

test('explicit run and mode selections fail before contacting a server', async () => {
  let reads = 0
  const readCurrent = async () => { reads += 1; return receipt() }
  await assert.rejects(consumeOperationReceipt({ receipt: receipt(), runId: id(99), readCurrent }), { code: 'selected_run_mismatch' })
  await assert.rejects(consumeOperationReceipt({ receipt: receipt(), runId, mode: 'published-result', readCurrent }), { code: 'selected_mode_mismatch' })
  assert.equal(reads, 0)
})

test('denied or unavailable current data does not fall back to a previously passing receipt', async () => {
  const error = await consumeOperationReceipt({ receipt: receipt(), runId, readCurrent: async () => { throw new Error('PRIVATE_BODY_SENTINEL') } }).then(() => null, value => value)
  assert.equal(error.code, 'current_observation_unavailable')
  assert.equal(error.message.includes('PRIVATE_BODY_SENTINEL'), false)
})

test('a matching failed native outcome cannot be consumed as accepted completion', async () => {
  const failed = receipt()
  failed.run.status = 'failed'
  failed.run.verification_status = 'failed'
  failed.task.status = 'verification_failed'
  failed.verification.persisted_acceptance_observed = false
  failed.verification.automated_checks_passed = false
  failed.verification.evidence[0].status = 'failed'
  await assert.rejects(consumeOperationReceipt({ receipt: failed, runId, readCurrent: async () => clone(failed) }), { code: 'native_acceptance_not_observed' })
})

test('file consumption requires the exact expected byte hash and a bounded valid receipt', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ecorp-receipt-consumer-'))
  const file = path.join(directory, 'receipt.json')
  const bytes = Buffer.from(`${JSON.stringify(receipt(), null, 2)}\n`)
  writeFileSync(file, bytes)
  assert.deepEqual(readOperationReceipt(file, hash(bytes)), receipt())
  assert.throws(() => readOperationReceipt(file, 'e'.repeat(64)), { code: 'receipt_integrity_mismatch' })
  writeFileSync(file, 'PRIVATE_BODY_SENTINEL')
  assert.throws(() => readOperationReceipt(file, hash('PRIVATE_BODY_SENTINEL')), error => error.code === 'invalid_receipt' && !error.message.includes('PRIVATE_BODY_SENTINEL'))
  writeFileSync(file, Buffer.alloc(1024 * 1024 + 1))
  assert.throws(() => readOperationReceipt(file, 'f'.repeat(64)), { code: 'receipt_unreadable_or_unbounded' })
})
