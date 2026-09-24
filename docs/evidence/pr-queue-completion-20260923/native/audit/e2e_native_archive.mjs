// Native publication only; recovery uses immutable GitHub reads and the existing offline CLI.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureOriginalTrustInputs } from "file:///<reviewed-worktree>/tools/native_qualification_trust.mjs"
import { startSurface, supplementalState } from "file:///<private-evidence>/queue-audit-native-r471/native_qualification_attempt.mjs"

const attempt = await startSurface('archive')
assert.equal(process.env.CRONY_NATIVE_QUALIFICATION, '1')
assert.equal(process.env.CRONY_SERVER_HTTP, 'http://127.0.0.1:8992')
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && ['--publish', '--republish'].includes(process.argv[2])))
const root = "<reviewed-worktree>"
const output = path.join(root, 'output', 'native-qualification', 'phase2-queue-r471')
const load = async (name) => JSON.parse(await readFile(path.join(output, name), 'utf8'))
const runtime = await load('runtime-qualification.json')
const browser = await load('browser-qualification.json')
const identities = await load('processes.json')
const destination = await load('destination.json')
const report = { schema_version: 1, complete: false, started_at: new Date().toISOString(), checks: [], commands: [] }
attempt.prepare(report)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const blobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const equal = (a, b, label) => {
  assert.ok(JSON.stringify(sort(a)) === JSON.stringify(sort(b)), label)
  report.checks.push(label)
}
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]))
  return value
}
async function audit(command) {
  const response = await fetch(`${process.env.CRONY_SERVER_HTTP}/api/corps/${runtime.corp_id}/state-audit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
    body: JSON.stringify({ actor_id: identities.alice_actor_id, command }), signal: AbortSignal.timeout(90_000),
  })
  assert.equal(response.status, 200, `Native audit ${command.action} status`)
  return response.json()
}
async function immutable(file, commit, expectedBlob) {
  assert.match(commit, /^[0-9a-f]{40}$/)
  assert.ok(file.startsWith(`audit/${runtime.ledger_id}/`) && !file.includes('..'))
  const response = await fetch(`http://127.0.0.1:18558/repos/qualification/native-audit/contents/${file}?ref=${commit}`,
    { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, 'Immutable GitHub file must exist')
  const content = await response.json()
  assert.equal(content.path, file)
  assert.equal(content.encoding, 'base64')
  const bytes = Buffer.from(content.content, 'base64')
  assert.ok(bytes.length <= 262144)
  assert.equal(blobSha(bytes), content.sha, 'Actual returned Git blob identity')
  if (expectedBlob) assert.equal(content.sha, expectedBlob, 'Native durable blob identity')
  return bytes
}
function query(sql) {
  assert.match(sql, /^SELECT /)
  assert.ok(!/raw_tx|signed_bytes/i.test(sql))
  const result = spawnSync("<local-user>\\AppData\\Local\\Programs\\ecorp-tools\\postgresql-17.10\\pgsql\\bin\\psql.exe", ['-h', '127.0.0.1', '-p', '55483', '-U', 'postgres', '-d', 'native_foreground_runtime_20260917', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(result.status, 0, 'Read-only durable evidence query')
  return JSON.parse(result.stdout.trim())
}
function verify(file, expectedExit = 0) {
  const args = ['base-audit-verify', path.join(output, file),
    '--manifests', path.join(output, 'manifests.json'), '--trust-pin', path.join(output, 'trust-pin.json'),
    '--expected-manifest-version', '1', '--expected-manifest-digest', destination.config.manifest_digest,
    '--expected-checkpoint', `0x${runtime.checkpoint.digest}`]
  const result = spawnSync(path.join(root, 'target-native-qualification', 'debug', 'crony-cli.exe'), args, {
    encoding: 'utf8', timeout: 90_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  report.commands.push({ executable: 'crony-cli', arguments: args, exit_code: result.status, expected_exit: expectedExit })
  assert.equal(result.status, expectedExit, 'Existing native offline verifier exit')
}
try {
  report.original_evidence_checkpoint = runtime.checkpoint.digest
  assert.equal(runtime.native_event.call.checkpoint_digest, `0x${runtime.checkpoint.digest}`)
  report.original_trust = (await ensureOriginalTrustInputs(output)).sha256
  const originalCheckpoint = await immutable(runtime.github_checkpoint.path, runtime.github_checkpoint.commit, runtime.github_checkpoint.blob_sha)
  const missing = await fetch(`http://127.0.0.1:18558/repos/qualification/native-audit/contents/${runtime.github_checkpoint.path.slice(0, -5)}/archive.json?ref=${runtime.github_checkpoint.commit}`)
  if (runtime.legacy_checkpoint_only_receipt || !runtime.github_receipt.witness.archive_publication) {
    assert.equal(missing.status, 404, 'Explicit historical checkpoint-only commit lacks archive')
    report.historical_checkpoint_only = { commit: runtime.github_checkpoint.commit, archive_index_status: 404 }
  } else {
    assert.equal(missing.status, 200, 'Fresh native full publication already includes archive')
    report.initial_complete_publication = { commit: runtime.github_checkpoint.commit, archive_index_status: 200 }
  }
  const objectsBefore = await (await fetch('http://127.0.0.1:18558/qualification/objects')).json()
  if (process.argv[2]) {
    await audit({ action: 'publish', destination_id: runtime.github_destination_id })
    if (process.argv[2] === '--republish') {
      const deadline = Date.now() + 90_000
      let published = false
      while (Date.now() < deadline) {
        const status = await audit({ action: 'status' })
        const current = status.destinations.find((item) => item.id === runtime.github_destination_id)
        if (Date.parse(current.last_successful_publication) >= Date.parse(report.started_at)) {
          published = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      assert.ok(published, 'Native duplicate publication actually completed')
    }
  }
  let receipt
  const deadline = Date.now() + 180_000
  do {
    const status = await audit({ action: 'status' })
    receipt = status.receipts.find((r) => r.destination_id === runtime.github_destination_id && r.checkpoint_digest === runtime.checkpoint.digest)
    if (receipt?.witness?.archive_publication) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  } while (Date.now() < deadline)
  assert.ok(receipt?.witness?.archive_publication, 'Native publisher must persist complete archive receipt')
  const publication = receipt.witness.archive_publication
  assert.equal(receipt.status, 'published')
  assert.equal(receipt.witness.commit, publication.commit)
  const indexBytes = await immutable(publication.index_path, publication.commit, publication.index_git_blob_sha1)
  assert.equal(sha256(indexBytes), publication.index_sha256)
  const index = JSON.parse(indexBytes.toString())
  equal(index, publication.archive, 'Remote index equals native authoritative receipt')
  assert.equal(index.checkpoint_digest, runtime.checkpoint.digest)
  assert.equal(index.ledger_id, runtime.ledger_id)
  assert.ok(index.parts.length >= 1 && index.parts.length <= 128)
  assert.ok(index.byte_count <= 32 * 1024 * 1024)
  const parts = []
  for (const [number, part] of index.parts.entries()) {
    assert.equal(part.path, `${publication.index_path.slice(0, -12)}archive-${String(number).padStart(5, '0')}.json`)
    const bytes = await immutable(part.path, publication.commit, part.git_blob_sha1)
    assert.equal(bytes.length, part.byte_count)
    assert.equal(sha256(bytes), part.sha256)
    parts.push(bytes)
  }
  const bytes = Buffer.concat(parts)
  assert.equal(bytes.length, index.byte_count)
  assert.equal(sha256(bytes), index.sha256)
  await writeFile(path.join(output, 'github-native-archive.json'), bytes)
  // Verification and task resolution occur before any PostgreSQL/archive export read.
  verify('github-native-archive.json')
  const archive = JSON.parse(bytes.toString())
  equal(archive.checkpoints.at(-1), runtime.checkpoint, 'Recovered exact signed checkpoint')
  const checkpointBytes = await immutable(runtime.github_checkpoint.path, publication.commit, runtime.github_checkpoint.blob_sha)
  assert.ok(checkpointBytes.equals(originalCheckpoint), 'Frozen V1 checkpoint envelope remains byte-identical')
  for (const [extension, expected] of [['cbor', Buffer.from(runtime.checkpoint.payload)], ['ed25519', Buffer.from(runtime.checkpoint.signature)]]) {
    assert.ok((await immutable(`${runtime.github_checkpoint.path.slice(0, -5)}.${extension}`, publication.commit)).equals(expected),
      'Frozen V1 payload/signature remains byte-identical')
  }
  const resource = `mission/${browser.mission_id}/governance`
  const [versionHash, revision] = archive.refs[resource]
  const objects = archive.rows.flatMap((row) => row.objects)
  const version = objects.find((object) => object.hash === versionHash && object.kind === 'version')
  assert.ok(version)
  const content = objects.find((object) => object.hash === version.value.content_hash && object.kind === 'content')
  assert.ok(content)
  assert.equal(content.value.mission_id, browser.mission_id)
  const task = content.value.tasks.find((item) => item.task_id === browser.task_id)
  assert.ok(task, 'Signed native governance archive independently resolves exact ECorp task')
  assert.equal(task.contract_version, browser.contract_version)
  report.task_binding = { resource, revision, version_hash: versionHash, content_hash: content.hash,
    mission_id: content.value.mission_id, task, execution_run_not_in_v1_governance_archive: true }
  const tampered = structuredClone(archive)
  tampered.rows.flatMap((row) => row.objects).find((object) => object.hash === content.hash).value.tasks[0].task_id = '00000000-0000-4000-8000-000000000099'
  await writeFile(path.join(output, 'github-archive-tampered-negative.json'), JSON.stringify(tampered))
  verify('github-archive-tampered-negative.json', 1)
  const incomplete = structuredClone(archive)
  incomplete.rows[0].objects = incomplete.rows[0].objects.filter((object) => object.hash !== content.hash)
  await writeFile(path.join(output, 'github-archive-incomplete-negative.json'), JSON.stringify(incomplete))
  verify('github-archive-incomplete-negative.json', 1)
  const pgReceipt = query(`SELECT to_jsonb(r) FROM state_audit_anchor_receipts r WHERE destination_id='${runtime.github_destination_id}' AND checkpoint_digest='${runtime.checkpoint.digest}'`)
  equal(pgReceipt, receipt, 'Actual API receipt equals durable native PG receipt')
  const exported = await audit({ action: 'export' })
  if (exported.checkpoints.length === archive.checkpoints.length) {
    equal(archive, exported, 'Recovered archive equals native API export')
  } else {
    assert.ok(exported.checkpoints.length > archive.checkpoints.length)
    equal(archive.rows, exported.rows.slice(0, archive.rows.length), 'Current native export retains exact original signed rows')
    equal(archive.checkpoints, exported.checkpoints.slice(0, archive.checkpoints.length),
      'Current native export retains exact original checkpoint prefix')
    report.current_export_scope = 'Later supplemental checkpoints exist; complete original bytes equal original archive and native worker-retained archive, not the entire newer API export.'
  }
  const retained = query(`SELECT archive FROM base_audit_retained_history WHERE destination_id='${runtime.destination_id}' AND checkpoint_digest='${runtime.checkpoint.digest}'`)
  equal(archive, retained, 'Recovered archive equals worker-retained native archive')
  equal(archive, runtime.archive, 'Recovered archive equals original qualified native archive')
  assert.equal(runtime.native_event.call.checkpoint_digest, `0x${index.checkpoint_digest}`)
  const afterObjects = await (await fetch('http://127.0.0.1:18558/qualification/objects')).json()
  if (process.argv[2] === '--republish') {
    equal(afterObjects, objectsBefore, 'Actual native duplicate archive publication created no Git objects or commits')
    report.duplicate_publication_no_writes = true
  }
  const metrics = await (await fetch('http://127.0.0.1:18560/qualification/metrics')).json()
  const supplemental = await supplementalState()
  assert.equal(metrics.signatures, supplemental?.total_gateway_signatures ?? 1)
  report.complete = true
  report.receipt = receipt
  report.archive_bytes = bytes.length
  report.archive_sha256 = sha256(bytes)
  report.immutable_objects = afterObjects
  report.anchor_transaction = runtime.local_transaction_receipt.transactionHash
  report.checkpoint_digest = runtime.checkpoint.digest
  report.signatures = metrics.signatures
  report.independent_recovery = 'Immutable GitHub objects + original independent trust pin + native offline CLI; no PG/API archive used to reconstruct or verify.'
  report.byte_equality = 'Every returned immutable blob and concatenated archive equals the hashes/lengths computed from native selected bytes in the durable receipt; V1 envelope/payload/signature byte equality also proved.'
  report.limits = ['Local GitHub fixture, not real GitHub infrastructure.', 'Governance archive resolves task and contract digests; V1 does not include run transcript/artifact contents.', 'Original local anchor/finality evidence reused, no additional signing/broadcast.', 'Two RPC endpoints share one local Anvil.']
  report.finished_at = new Date().toISOString()
  const phaseFile = process.argv[2] === '--publish' ? 'github-archive-publication.json'
    : process.argv[2] === '--republish' ? 'github-archive-duplicate-readback.json' : 'github-archive-restart-readback.json'
  await writeFile(path.join(output, phaseFile), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(output, 'github-archive-qualification.json'), `${JSON.stringify(report, null, 2)}\n`)
  await attempt.succeed(report)
  console.log(JSON.stringify({ complete: true, commit: publication.commit, archive_bytes: bytes.length, archive_sha256: index.sha256, task_id: task.task_id }))
} catch (error) {
  report.failure = { name: error.name, message: error.message }
  await writeFile(path.join(output, `github-archive-failure-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`)
  console.error(JSON.stringify({ complete: false, error: error.message }))
  process.exitCode = 1
}
