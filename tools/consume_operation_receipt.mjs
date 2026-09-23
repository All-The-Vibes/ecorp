import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { exportOperationReceipt, operationReceiptFingerprint, validateOperationReceipt } from './operation_receipt.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const MAX_RECEIPT_BYTES = 1024 * 1024
const modes = new Set(['current-run', 'published-result'])

export class ReceiptCheckError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

// The caller's expected byte hash binds the file being examined. It is not a
// signature or identity claim; the consumer must still query native authority.
export function readOperationReceipt(file, expectedSha256) {
  if (!SHA256.test(expectedSha256 ?? '')) throw new ReceiptCheckError('invalid_expected_digest')
  let descriptor
  let bytes
  try {
    descriptor = openSync(file, 'r')
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RECEIPT_BYTES) throw new Error('size')
    const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1)
    let length = 0, count
    // Regular-file reads can be short; the extra byte still detects growth.
    while (length < buffer.length && (count = readSync(descriptor, buffer, length, buffer.length - length, null)) > 0) length += count
    if (length > MAX_RECEIPT_BYTES || length !== stat.size) throw new Error('changing input')
    bytes = buffer.subarray(0, length)
  } catch {
    throw new ReceiptCheckError('receipt_unreadable_or_unbounded')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256.toLowerCase()) {
    throw new ReceiptCheckError('receipt_integrity_mismatch')
  }
  try {
    const receipt = JSON.parse(bytes.toString('utf8'))
    validateOperationReceipt(receipt)
    return receipt
  } catch {
    throw new ReceiptCheckError('invalid_receipt')
  }
}

export async function consumeOperationReceipt({
  receipt, runId, mode = 'current-run', env = process.env, timeoutMs = 30_000,
  readCurrent = exportOperationReceipt,
}) {
  if (!UUID.test(runId ?? '') || !modes.has(mode)) throw new ReceiptCheckError('invalid_selection')
  try { validateOperationReceipt(receipt) } catch { throw new ReceiptCheckError('invalid_receipt') }
  if (receipt.scope.run_id !== runId.toLowerCase()) throw new ReceiptCheckError('selected_run_mismatch')
  if (receipt.mode !== mode) throw new ReceiptCheckError('selected_mode_mismatch')
  let current
  try {
    // Routing and credentials come exclusively from trusted host configuration.
    // No receipt field is used as an endpoint or an authorization decision.
    current = await readCurrent({ env, runId: runId.toLowerCase(), mode, timeoutMs })
    validateOperationReceipt(current)
  } catch {
    throw new ReceiptCheckError('current_observation_unavailable')
  }
  const fingerprint = operationReceiptFingerprint(receipt)
  if (fingerprint !== operationReceiptFingerprint(current)) throw new ReceiptCheckError('stale_or_mismatched_receipt')
  if (current.run.status !== 'completed' || current.run.verification_status !== 'passed'
    || current.verification.persisted_acceptance_observed !== true) {
    throw new ReceiptCheckError('native_acceptance_not_observed')
  }
  if (current.artifacts.some(artifact => !artifact.byte_hash_verified)) {
    throw new ReceiptCheckError('artifact_bytes_not_verified')
  }
  return {
    schema_version: 1,
    kind: 'ecorp-operation-consumption-check',
    status: 'validated-current-observation',
    checked_at: current.checked_at,
    mode,
    scope: current.scope,
    observation_fingerprint_sha256: fingerprint,
    persisted_acceptance_observed: true,
    artifact_count: current.artifacts.length,
    automated_checks_complete: current.verification.automated_checks_complete,
    read_only: true,
    authority: 'Current native state was reread; no task action, approval, signed audit or future authority is granted',
  }
}

async function main() {
  const args = process.argv.slice(2)
  const options = { mode: 'current-run', timeoutMs: 30_000 }
  const names = new Map([['--receipt', 'file'], ['--sha256', 'sha256'], ['--run-id', 'runId'], ['--mode', 'mode'], ['--timeout-ms', 'timeoutMs']])
  const seen = new Set()
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index])
    if (!key || seen.has(key) || !args[index + 1]) throw new ReceiptCheckError('invalid_arguments')
    seen.add(key)
    options[key] = key === 'timeoutMs' ? Number(args[index + 1]) : args[index + 1]
  }
  if (!options.file || !UUID.test(options.runId ?? '') || !modes.has(options.mode)
    || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000) {
    throw new ReceiptCheckError('invalid_arguments')
  }
  const receipt = readOperationReceipt(options.file, options.sha256)
  const result = await consumeOperationReceipt({ ...options, receipt })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    // Never print native response bodies, input receipt content, tokens or paths.
    const code = error instanceof ReceiptCheckError ? error.code : 'receipt_check_failed'
    process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`)
    process.exitCode = 1
  })
}
