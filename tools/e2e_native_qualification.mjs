// Drives only native administration APIs/CLI. No signing or transaction broadcast here.
import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startSurface, supplementalState } from './native_qualification_attempt.mjs'
import { verifyFinalityObservations } from './native_qualification_finality.mjs'

const attempt = process.argv[3] === 'readback' ? await startSurface('runtime') : null
assert.equal(process.env.CRONY_NATIVE_QUALIFICATION, '1')
assert.equal(process.argv[2], '--phase')
const phase = process.argv[3]
assert.ok(['audit', 'request', 'broadcast', 'recover', 'observe-finality', 'readback'].includes(phase))
assert.equal(process.env.CRONY_SERVER_HTTP, 'http://127.0.0.1:8992')
const server = process.env.CRONY_SERVER_HTTP
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'output', 'native-qualification', 'phase2')
const host = process.env.CRONY_NATIVE_HOST_DIRECTORY
assert.ok(host && path.isAbsolute(host) && !host.toLowerCase().startsWith(root.toLowerCase()))
const reportFile = path.join(output, 'runtime-qualification.json')
const browser = JSON.parse(await readFile(path.join(output, 'browser-qualification.json'), 'utf8'))
const identities = JSON.parse(await readFile(path.join(output, 'processes.json'), 'utf8'))
const corp = identities.corp_id
const actor = identities.alice_actor_id
let report = phase === 'audit' ? {
  schema_version: 1, phase: 'starting', source_commit: browser.source_commit, source_branch: browser.source_branch,
  mission_id: browser.mission_id, task_id: browser.task_id, run_id: browser.run_id,
  corp_id: corp, ledger_id: randomUUID(), github_destination_id: randomUUID(), idempotency_key: randomUUID(),
  started_at: new Date().toISOString(), commands: [], http: [],
  boundaries: { factory_enabled: false, public_chain: false, real_github: false, independent_rpc_infrastructure: false, kms: false },
} : JSON.parse(await readFile(reportFile, 'utf8'))
attempt?.prepare(report)
const save = () => writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function operation(surface, command, who = actor, expected = 200, targetCorp = corp) {
  const response = await fetch(`${server}/api/corps/${targetCorp}/${surface}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor_id: who, command }), redirect: 'error', signal: AbortSignal.timeout(90_000),
  })
  report.http.push({ phase, surface, action: command.action, status: response.status, expected })
  await save()
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status),
    `${surface}/${command.action}: unexpected HTTP status ${response.status}`)
  const value = await response.json()
  return response.status === 200 ? value : { ...value, http_status: response.status }
}
const audit = (command) => operation('state-audit', command)
const base = (command, who, expected, targetCorp) => operation('base-audit', command, who, expected, targetCorp)
function cli(args) {
  const result = spawnSync(path.join(root, 'target-native-qualification', 'debug', 'crony-cli.exe'),
    ['--server', server, 'base-audit', corp, actor, ...args], { encoding: 'utf8', timeout: 90_000, env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CRONY_SERVER_HTTP: server,
    } })
  report.commands.push({ executable: 'crony-cli', arguments: ['base-audit', corp, actor, ...args], exit_code: result.status })
  assert.equal(result.status, 0, 'Native CLI command failed (response body omitted)')
  return JSON.parse(result.stdout)
}
async function until(name, fn, timeout = 180_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await delay(1000)
  }
  throw new Error(`Native runtime timed out: ${name}`)
}
async function metrics() {
  const response = await fetch('http://127.0.0.1:18560/qualification/metrics')
  assert.equal(response.status, 200)
  return response.json()
}
async function localRpc(method, params, origin = 'http://127.0.0.1:18557') {
  assert.ok(['http://127.0.0.1:18557', 'http://127.0.0.1:18559'].includes(origin))
  const response = await fetch(origin, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  assert.equal(response.status, 200, `Owned local RPC ${method} unavailable`)
  const value = await response.json()
  assert.ok(!value.error, `Owned local RPC ${method} rejected`)
  return value.result
}
function query(sql, journal = false) {
  assert.match(sql.trim(), /^SELECT\b/i)
  assert.ok(!/raw_tx|signed_bytes/i.test(sql), 'Never read signed transaction bytes into public evidence')
  const result = spawnSync('docker', ['exec', 'ecorp-foreground287-20260917-postgres',
    'psql', '-U', 'postgres', '-d', journal ? 'native_foreground_journal_20260917' : 'native_foreground_runtime_20260917',
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(result.status, 0, 'Read-only evidence query failed; response bodies omitted')
  return JSON.parse(result.stdout.trim())
}
try {
  if (phase === 'audit') {
    await assert.rejects(readFile(reportFile), { code: 'ENOENT' }, 'Preserve existing qualification identity')
    await save()
    await audit({ action: 'initialize', ledger_id: report.ledger_id })
    report.coverage = await audit({ action: 'cover', mission_id: browser.mission_id })
    report.checkpoint = await audit({ action: 'checkpoint' })
    report.archive = await audit({ action: 'export' })
    await writeFile(path.join(output, 'native-archive.json'), `${JSON.stringify(report.archive, null, 2)}\n`)
    const raw = await readFile(path.join(host, 'audit.key'))
    assert.equal(raw.length, 32)
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]), format: 'der', type: 'pkcs8' })
    const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
    raw.fill(0)
    report.checkpoint_public_key = [...publicKey]
    await writeFile(path.join(host, 'fixture-input.json'), JSON.stringify({
      corp_id: corp, ledger_id: report.ledger_id, checkpoint_key_id: report.checkpoint.checkpoint.key_id,
      checkpoint_public_key: [...publicKey], host_directory: host, output_directory: output,
    }))
    await writeFile(path.join(host, 'witnesses.json'), JSON.stringify([{
      corp_id: corp, ledger_id: report.ledger_id, checkpoint_digest: report.checkpoint.digest,
    }]))
    await writeFile(path.join(host, 'github.token'), randomBytes(32).toString('hex'))
    report.phase = 'audit_prepared'
  } else if (phase === 'request') {
    const destination = JSON.parse(await readFile(path.join(output, 'destination.json'), 'utf8'))
    report.destination_id = destination.id
    if (!report.configured) {
      report.configured = cli(['configure', path.join(output, 'destination.json')])
      assert.equal(report.configured.enabled, false)
    }
    if (!report.enabled) {
      report.validated = await base({ action: 'validate', destination_id: destination.id })
      assert.equal(report.validated.validated, true)
      report.preview = await base({ action: 'preview', destination_id: destination.id })
      report.enabled = await base({ action: 'enable', destination_id: destination.id, expected_version: report.configured.version })
      assert.equal(report.enabled.enabled, true)
      await base({ action: 'enable', destination_id: destination.id, expected_version: report.configured.version }, actor, 400)
      await base({ action: 'request', destination_id: destination.id, idempotency_key: randomUUID() }, identities.bob_actor_id, 403)
      await base({ action: 'status' }, identities.eve_actor_id, 403)
      await base({ action: 'status' }, actor, 403, randomUUID())
    }
    report.intent = await until('stable request after worker reconciliation', async () => {
      const value = await base({ action: 'request', destination_id: destination.id, idempotency_key: report.idempotency_key }, actor, [200, 400])
      return value.intent || null
    })
    assert.equal(report.intent.state, 'archive_pending')
    assert.equal(report.intent.checkpoint_digest, report.checkpoint.digest)
    assert.equal((await metrics()).signatures, 0, 'Absent GitHub receipt must not sign')
    report.absent_archive_refused = true
    await audit({ action: 'configure_destination', destination: {
      id: report.github_destination_id, corp_id: corp, kind: 'github', interval_seconds: 31536000,
      config: { repository: 'qualification/native-audit', branch: 'audit', path: 'audit' },
    } })
    await audit({ action: 'publish', destination_id: report.github_destination_id })
    report.github_receipt = await until('native GitHub publication receipt', async () => {
      const status = await audit({ action: 'status' })
      return status.receipts?.find((item) => item.destination_id === report.github_destination_id && item.status === 'published')
    })
    assert.equal(report.github_receipt.checkpoint_digest, report.checkpoint.digest)
    const index = await (await fetch('http://127.0.0.1:18558/qualification/objects')).json()
    const checkpointFile = index.entries.find((item) => item.path.endsWith(`-${report.checkpoint.digest}.json`))
    assert.ok(checkpointFile)
    const remote = await (await fetch(`http://127.0.0.1:18558/repos/qualification/native-audit/contents/${checkpointFile.path}?ref=${report.github_receipt.witness.commit}`)).json()
    const bytes = Buffer.from(remote.content, 'base64')
    assert.deepEqual(JSON.parse(bytes.toString()), report.checkpoint)
    report.github_checkpoint = { commit: report.github_receipt.witness.commit, path: checkpointFile.path,
      blob_sha: remote.sha, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), signed_envelope_equal: true }
    report.pending_gateway = await until('committed journal with lost response', async () => {
      const state = await metrics()
      return state.journal_committed && state.response_held && state.signatures === 1 ? state : null
    })
    report.pending_history = await base({ action: 'history', destination_id: destination.id })
    const duplicate = (await base({ action: 'request', destination_id: destination.id, idempotency_key: report.idempotency_key })).intent
    assert.equal(duplicate.id, report.intent.id)
    assert.equal((await metrics()).signatures, 1)
    await base({ action: 'request', destination_id: randomUUID(), idempotency_key: report.idempotency_key }, actor, 400)
    report.duplicate_pending_id = duplicate.id
    report.phase = 'pending_restart'
  } else if (phase === 'broadcast') {
    assert.equal(report.phase, 'pending_restart')
    if (!report.history_after_pending_restart) {
      report.gateway_after_restart = await metrics()
      assert.equal(report.gateway_after_restart.signatures, 1)
      assert.equal(report.gateway_after_restart.response_held, true)
      report.history_after_pending_restart = await base({ action: 'history', destination_id: report.destination_id })
      await save()
    }
    await localRpc('evm_setAutomine', [false])
    const release = await fetch('http://127.0.0.1:18560/qualification/release', { method: 'POST' })
    assert.equal(release.status, 200)
    const hash = query("SELECT to_jsonb('0x'||encode(transaction_hash,'hex')) FROM base_gateway_results", true)
    assert.match(hash, /^0x[0-9a-f]{64}$/)
    const transaction = await until('observed native broadcast before restart', async () => {
      const value = await localRpc('eth_getTransactionByHash', [hash])
      if (!value) return null
      assert.equal(value.blockHash, null, 'Broadcast must still be pending')
      assert.equal(await localRpc('eth_getTransactionReceipt', [hash]), null)
      return value
    })
    assert.equal((await metrics()).signatures, 1)
    report.pending_broadcast = { hash, nonce: transaction.nonce, block_hash: null,
      receipt: null, signatures: 1, observed_at: new Date().toISOString() }
    report.phase = 'broadcast_restart_required'
  } else if (phase === 'recover' || phase === 'observe-finality') {
    assert.equal(report.phase, 'broadcast_restart_required')
    const hash = report.pending_broadcast.hash
    if (phase === 'recover') {
    const pending = await localRpc('eth_getTransactionByHash', [hash])
    assert.ok(pending && pending.hash === hash)
    assert.equal(pending.nonce, report.pending_broadcast.nonce)
    assert.equal(await localRpc('eth_getTransactionReceipt', [hash]), null)
    assert.equal((await metrics()).signatures, 1)
    report.pending_broadcast_after_restart = { hash, nonce: pending.nonce, receipt: null, signatures: 1 }
    await localRpc('evm_setAutomine', [true])
    await localRpc('evm_mine', [])
    } else {
      assert.equal(report.pending_broadcast_after_restart.hash, hash)
      assert.equal(report.pending_broadcast_after_restart.nonce, report.pending_broadcast.nonce)
      assert.equal(report.pending_broadcast_after_restart.receipt, null)
      assert.equal(report.pending_broadcast_after_restart.signatures, 1)
    }
    report.finalized = await until('native worker local inclusion/finality', async () => {
      const value = await base({ action: 'history', destination_id: report.destination_id })
      const finalized = value.items.find((item) => item.kind === 'finalized')
      if (finalized) {
        assert.equal(finalized.evidence.assurance, 'provider-observed-finalized')
        assert.equal(finalized.evidence.event.call.checkpoint_digest, `0x${report.checkpoint.digest}`)
        assert.equal(finalized.evidence.event.transaction_hash, report.pending_broadcast.hash)
        assert.equal(finalized.evidence.event.call.sequence, report.checkpoint.checkpoint.last_sequence)
        assert.equal(finalized.evidence.observations.length, 2)
        assert.equal(new Set(finalized.evidence.observations.map((item) => item.provider_identity)).size, 2)
        const origins = new Map([
          ['local-anvil-primary', 'http://127.0.0.1:18557'],
          ['local-proxy-same-anvil-not-independent', 'http://127.0.0.1:18559'],
        ])
        report.finality_tip_checks = await verifyFinalityObservations(finalized.evidence, (provider, number) => {
          assert.ok(origins.has(provider))
          return localRpc('eth_getBlockByNumber', [`0x${number.toString(16)}`, false], origins.get(provider))
        })
        return value
      }
      assert.notEqual(phase, 'observe-finality', 'Read-only reconciliation requires an existing native finality record')
      // Local mining is fixture infrastructure only; the driver never sends transactions.
      const mine = await fetch('http://127.0.0.1:18557', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_mine', params: ['0x10'] }) })
      assert.equal(mine.status, 200)
      return null
    }, 300_000)
    report.gateway_final = await metrics()
    assert.equal(report.gateway_final.signatures, 1)
    report.before_restart_status = await base({ action: 'status' })
    report.before_restart_cli = cli(['status'])
    assert.deepEqual(report.before_restart_cli, report.before_restart_status)
    report.phase = 'finalized_restart_required'
  } else {
    assert.ok(['finalized_restart_required', 'readback_complete'].includes(report.phase))
    report.after_restart_status = await base({ action: 'status' })
    report.after_restart_cli = cli(['status'])
    assert.deepEqual(report.after_restart_cli, report.after_restart_status)
    report.after_restart_history = await base({ action: 'history', destination_id: report.destination_id })
    const finalBefore = report.finalized.items.find((item) => item.kind === 'finalized')
    const finalAfter = report.after_restart_history.items.find((item) => item.kind === 'finalized'
      && item.evidence.event.transaction_hash === finalBefore.evidence.event.transaction_hash)
    assert.deepEqual(finalAfter, finalBefore, 'Restart must retain exact finality receipt and observations')
    const supplemental = await supplementalState()
    for (const [index, snapshot] of [report.before_restart_status, report.after_restart_status].entries()) {
      const destination = snapshot.audit.destinations.find((item) => item.id === report.destination_id)
      const current = index === 1 ? supplemental?.local_terminal_state : null
      assert.equal(destination.verified_digest, current?.verified_digest ?? report.checkpoint.digest)
      assert.equal(destination.verified_sequence, current?.verified_sequence ?? report.checkpoint.checkpoint.last_sequence)
      if (current) assert.equal(destination.enabled, false)
      assert.ok(!snapshot.audit.intents.some((item) => item.id === report.intent.id),
        'Finalized intent must no longer appear among active intents')
    }
    report.pg_receipt = query(`SELECT to_jsonb(r) FROM state_audit_anchor_receipts r WHERE destination_id='${report.github_destination_id}' AND checkpoint_digest='${report.checkpoint.digest}'`)
    if (report.pg_receipt.witness.archive_publication && !report.github_receipt.witness.archive_publication) {
      const archiveEvidence = JSON.parse(await readFile(path.join(output, 'github-archive-qualification.json'), 'utf8'))
      assert.equal(archiveEvidence.complete, true)
      assert.deepEqual(report.pg_receipt, archiveEvidence.receipt)
      report.legacy_checkpoint_only_receipt = report.github_receipt
      report.github_receipt = report.pg_receipt
    }
    assert.deepEqual(report.pg_receipt, report.github_receipt)
    report.pg_intent = query(`SELECT jsonb_build_object('id',id,'state',state,'terminal',terminal,'nonce',nonce,'fence',fence,'sequence',sequence,'checkpoint_digest',checkpoint_digest) FROM base_audit_intents WHERE id='${report.intent.id}'`)
    assert.equal(report.pg_intent.state, 'finalized')
    assert.equal(report.pg_intent.checkpoint_digest, report.checkpoint.digest)
    report.pg_attempts = query(`SELECT jsonb_agg(jsonb_build_object('id',id,'ordinal',ordinal,'intent_id',intent_id)) FROM base_audit_attempts WHERE intent_id='${report.intent.id}'`)
    assert.equal(report.pg_attempts.length, 1)
    const attemptId = report.pg_attempts[0].id
    report.journal = query(`SELECT jsonb_build_object('attempts',(SELECT count(*) FROM base_gateway_attempts WHERE attempt_id='${attemptId}'),'results',count(*),'transaction_hash',min(encode(transaction_hash,'hex')),'epoch',(SELECT epoch FROM base_gateway_identity WHERE singleton)) FROM base_gateway_results WHERE attempt_id='${attemptId}'`, true)
    report.journal_scope = 'Original retained attempt only; supplemental signatures are counted separately.'
    assert.equal(report.journal.attempts, 1)
    assert.equal(report.journal.results, 1)
    assert.equal(`0x${report.journal.transaction_hash}`, finalAfter.evidence.event.transaction_hash)
    const ancestry = query(`SELECT jsonb_agg(jsonb_build_object('key',encode(ancestry_key,'hex'),'ordinal',ordinal,'segment',segment) ORDER BY ancestry_key,ordinal) FROM base_audit_ancestry_segments WHERE destination_id='${report.destination_id}'`)
    await writeFile(path.join(output, 'retained-finality-headers.json'), `${JSON.stringify(ancestry, null, 2)}\n`)
    report.retained_ancestry = finalAfter.evidence.observations.map((observation) => {
      const segments = ancestry.filter((item) => `0x${item.key}` === observation.retained_ancestry.key)
      assert.equal(segments.length, observation.retained_ancestry.segments)
      const count = segments.reduce((sum, item) => sum + item.segment.headers.length, 0)
      assert.equal(count, observation.retained_ancestry.header_count)
      assert.ok(count >= observation.finalized.number - finalAfter.evidence.included.number + 1)
      return { provider: observation.provider_identity, finalized: observation.finalized, ...observation.retained_ancestry, actual_retained_headers: count }
    })
    report.pg_checkpoint = query(`SELECT record FROM state_audit_checkpoints WHERE corp_id='${corp}' AND digest='${report.checkpoint.digest}'`)
    assert.deepEqual(report.pg_checkpoint, report.checkpoint)
    const retainedArchive = query(`SELECT archive FROM base_audit_retained_history WHERE destination_id='${report.destination_id}' AND checkpoint_digest='${report.checkpoint.digest}'`)
    assert.deepEqual(retainedArchive, report.archive)
    report.archive_retention_equal = true
    report.github_byte_equality = []
    const stem = report.github_checkpoint.path.slice(0, -5)
    for (const [extension, expectedBytes] of [['cbor', Buffer.from(report.checkpoint.payload)], ['ed25519', Buffer.from(report.checkpoint.signature)]]) {
      const file = `${stem}.${extension}`
      const content = await (await fetch(`http://127.0.0.1:18558/repos/qualification/native-audit/contents/${file}?ref=${report.github_checkpoint.commit}`)).json()
      const bytes = Buffer.from(content.content, 'base64')
      assert.ok(bytes.equals(expectedBytes), 'Native published payload/signature bytes must be exact')
      assert.equal(createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'), content.sha)
      report.github_byte_equality.push({ path: file, blob_sha: content.sha, bytes: bytes.length, byte_equal: true })
    }
    const event = finalAfter.evidence.event
    const rpc = await fetch('http://127.0.0.1:18557', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [event.transaction_hash] }) })
    assert.equal(rpc.status, 200)
    report.local_transaction_receipt = (await rpc.json()).result
    assert.equal(report.local_transaction_receipt.blockHash, event.block_hash)
    assert.equal(report.local_transaction_receipt.status, '0x1')
    assert.equal(report.local_transaction_receipt.logs.length, 1)
    const data = report.local_transaction_receipt.logs[0].data.slice(2)
    assert.equal(data.slice(0, 64), report.checkpoint.digest)
    const chainLog = report.local_transaction_receipt.logs[0]
    const allLogs = await fetch('http://127.0.0.1:18557', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
        params: [{ address: chainLog.address, fromBlock: '0x0', toBlock: 'latest', topics: chainLog.topics }] }) })
    assert.equal(allLogs.status, 200)
    const matchingLogs = (await allLogs.json()).result
    assert.equal(matchingLogs.length, 1, 'Stable-key replay must produce exactly one Anchored event')
    report.exact_anchored_event_count = matchingLogs.length
    report.native_event = event
    const replay = (await base({ action: 'request', destination_id: report.destination_id, idempotency_key: report.idempotency_key })).intent
    assert.equal(replay.id, report.intent.id)
    report.current_gateway = await metrics()
    assert.equal(report.current_gateway.signatures, supplemental?.total_gateway_signatures ?? 1)
    report.supplemental_state = supplemental?.local_terminal_state ?? null
    if (supplemental) {
      const lowFunds = query(`SELECT jsonb_build_object('state',state,'reservation',reservation,'attempts',(SELECT count(*) FROM base_audit_attempts WHERE intent_id=i.id)) FROM base_audit_intents i WHERE id='${supplemental.local_terminal_state.awaiting_funds_intent}'`)
      assert.equal(lowFunds.state, 'awaiting_funds')
      assert.equal(String(lowFunds.reservation), '0')
      assert.equal(lowFunds.attempts, 0)
      report.current_low_funds_readback = lowFunds
    }
    report.restart_agreement = { api_cli: true, immutable_finality: true, native_pg_receipt: true }
    report.not_covered = supplemental?.residual_gaps ?? [
      'Valid changed-destination request under the same idempotency key (unknown destination was rejected instead).',
      'Separate room-coverage denial for an otherwise authorized audit administrator.',
      'Production GitHub, public Base, independent providers, KMS and production identity.',
    ]
    report.phase = 'readback_complete'
  }
  report.updated_at = new Date().toISOString()
  if (report.failure) {
    report.retained_failures = [...(report.retained_failures || []), report.failure]
    delete report.failure
  }
  await save()
  if (attempt) await attempt.succeed(report)
  console.log(JSON.stringify({ phase: report.phase, mission_id: report.mission_id, checkpoint_digest: report.checkpoint?.digest, destination_id: report.destination_id, intent_id: report.intent?.id }))
} catch (error) {
  report.failure = { phase, name: error.name, reason: 'Runtime assertion failed; inspect the phase command log. No completion claimed.' }
  await save()
  throw error
}
