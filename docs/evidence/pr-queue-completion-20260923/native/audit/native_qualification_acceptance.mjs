import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { lockAcceptance, requireCurrentReports, output } from "file:///<private-evidence>/queue-audit-native-r471/native_qualification_attempt.mjs"

const release = lockAcceptance()
try {
  const { current, reports } = await requireCurrentReports()
  const { runtime, browser, archive } = reports
  const restartEvidence = {}
  const restartHashes = {}
  for (const stage of ['signing', 'broadcast', 'final']) {
    for (const boundary of ['before', 'after']) {
      const name = `${stage}-restart-${boundary}.json`
      const bytes = await readFile(path.join(output, 'restart-evidence', name))
      restartEvidence[`${stage}_${boundary}`] = JSON.parse(bytes)
      restartHashes[name] = createHash('sha256').update(bytes).digest('hex')
    }
    const before = restartEvidence[`${stage}_before`].processes
    const after = restartEvidence[`${stage}_after`].processes
    for (const role of ['server', 'runner']) {
      assert.notEqual(before[role].pid, after[role].pid, `${stage}: physical ${role} restart required`)
      assert.equal(before[role].executable, after[role].executable)
    }
    for (const role of ['gateway', 'anvilNode', 'github']) {
      assert.deepEqual(before[role], after[role], `${stage}: evidence infrastructure changed`)
    }
  }
  const held = restartEvidence.signing_before
  assert.equal(held.application_signed_results, 0)
  assert.deepEqual(held.gateway, { journal_committed: true, response_held: true, signatures: 1 })
  const pending = restartEvidence.broadcast_before.pending
  assert.equal(pending.hash, runtime.native_event.transaction_hash)
  assert.equal(pending.receipt, null)
  assert.equal(pending.block_hash, null)
  assert.equal(pending.signatures, 1)
  assert.deepEqual(runtime.pending_broadcast_after_restart,
    { hash: pending.hash, nonce: pending.nonce, receipt: null, signatures: 1 })
  for (const role of ['server', 'runner', 'gateway', 'anvilNode', 'github']) {
    assert.deepEqual(restartEvidence.signing_after.processes[role], restartEvidence.broadcast_before.processes[role])
    assert.deepEqual(restartEvidence.broadcast_after.processes[role], restartEvidence.final_before.processes[role])
    assert.deepEqual(restartEvidence.final_after.processes[role], current.identity.processes[role])
  }
  assert.equal(browser.mission_id, runtime.mission_id)
  assert.equal(browser.task_id, runtime.task_id)
  assert.equal(browser.run_id, runtime.run_id)
  assert.equal(browser.physical_artifact_equal, true)
  assert.equal(browser.restart_agreement, true)
  assert.equal(browser.review_status, 'approved')
  assert.deepEqual(browser.ui_authorization,
    { denied_status: 403, prior_viewer_evidence_absent: true, owner_projection_restored: true })
  assert.equal(browser.before_restart.verification_status, 'passed')
  assert.deepEqual(browser.visible_audit_projection, {
    checkpoint_digest: runtime.checkpoint.digest,
    transaction_hash: runtime.native_event.transaction_hash,
    commit: runtime.github_receipt.witness.commit,
  })
  assert.equal(runtime.pg_intent.terminal, true)
  assert.equal(runtime.pg_intent.state, 'finalized')
  assert.equal(runtime.pg_attempts.length, 1)
  assert.equal(runtime.current_gateway.signatures, 1)
  assert.equal(runtime.journal.attempts, 1)
  assert.equal(runtime.journal.results, 1)
  assert.equal(runtime.local_transaction_receipt.status, '0x1')
  assert.equal(runtime.exact_anchored_event_count, 1)
  assert.equal(runtime.retained_ancestry.length, 2)
  assert.equal(runtime.finality_tip_checks.length, 6)
  assert.deepEqual(archive.receipt, runtime.pg_receipt)
  assert.deepEqual(browser.archive_readback.receipt, runtime.pg_receipt)
  assert.deepEqual(runtime.restart_agreement, {
    api_cli: true, immutable_finality: true, native_pg_receipt: true,
  })
  const acceptance = {
    schema_version: 1,
    status: 'native-local-qualified',
    created_at: new Date().toISOString(),
    attempt_id: current.attempt_id,
    identity_sha256: current.identity.sha256,
    branch: current.identity.branch,
    base_commit: current.identity.base_commit,
    current_surface_hashes: Object.fromEntries(Object.entries(current.surfaces).map(([name, value]) => [name, value.report_sha256])),
    restart_evidence_hashes: restartHashes,
    task: { mission: runtime.mission_id, task: runtime.task_id, run: runtime.run_id,
      contract_version: browser.contract_version, artifact_sha256: browser.before_restart.artifact_sha256,
      verifier: browser.before_restart.verification_status, review: browser.verification_review },
    checkpoint: { ledger_id: runtime.ledger_id, digest: runtime.checkpoint.digest,
      sequence: runtime.checkpoint.checkpoint.last_sequence,
      signing_key_id: runtime.checkpoint.checkpoint.key_id, public_key: runtime.checkpoint_public_key },
    github: runtime.pg_receipt,
    base_intent: { destination: runtime.destination_id, intent: runtime.pg_intent,
      idempotency_key: runtime.idempotency_key, attempt: runtime.pg_attempts[0] },
    signing: { gateway: runtime.current_gateway, journal: runtime.journal },
    chain: { network: 'owned-local-anvil-not-public-Base', chain_id: 84532,
      event: runtime.native_event, receipt: runtime.local_transaction_receipt },
    finality: { ancestry: runtime.retained_ancestry, canonical_readbacks: runtime.finality_tip_checks },
    runtime: { ...runtime.restart_agreement, visible_ui: browser.visible_audit_projection,
      signing_restart: true, observed_pending_broadcast_restart: true, final_restart: true },
    boundaries: runtime.boundaries,
    residual_gaps: [
      'Development actors, deterministic runner fixture, memory-only signer, local GitHub fixture and synthetic fee oracle.',
      'Both RPC endpoints share one Anvil. No independent-provider, external KMS, public-GitHub or public-Base assurance.',
      'Negative component tests do not imply every negative was repeated through the full UI/runtime.',
      'Historical failures remain preserved; successful current evidence does not reconstruct their missing observations.',
      'No hardened or production qualification; public canary requires a separate approved configuration and action budget.',
    ],
    retained_runtime_failures: runtime.retained_failures ?? [],
  }
  const bytes = `${JSON.stringify(acceptance, null, 2)}\n`
  await writeFile(path.join(output, 'attempts', current.attempt_id, 'acceptance.json'), bytes, { flag: 'wx' })
  await writeFile(path.join(output, 'acceptance.json'), bytes)
  console.log(JSON.stringify({ status: acceptance.status, attempt_id: current.attempt_id,
    checkpoint: acceptance.checkpoint.digest, transaction: runtime.native_event.transaction_hash }))
} finally {
  release()
}
