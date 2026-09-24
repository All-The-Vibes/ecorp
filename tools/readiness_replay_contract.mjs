import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { redactEvidenceCapabilities } from './redact_evidence_capabilities.mjs'

// Match the existing native supervisor's fixture contract. The supervisor still
// verifies live process identity and listener ownership before product requests.
export function validateReadinessFixture({ root, product, ownership, sourceHead }) {
  assert.ok(path.isAbsolute(root ?? '') && path.isAbsolute(product ?? ''))
  const fixture = realpathSync(root)
  const checkout = realpathSync(product)
  const relative = path.relative(checkout, fixture)
  assert.ok(relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
  assert.equal(path.basename(path.dirname(fixture)), 'qa')
  assert.match(path.basename(fixture), /^pr265-run-activity-[a-zA-Z0-9-]+$/u)
  assert.equal(ownership.test_owned, true)
  assert.equal(ownership.purpose, 'pr265-run-activity')
  assert.equal(realpathSync(ownership.workspace), fixture)
  assert.equal(realpathSync(ownership.plan.qa_root), fixture)
  assert.equal(realpathSync(ownership.plan.product), checkout)
  assert.equal(ownership.plan.product_commit, sourceHead)
  assert.equal(ownership.plan.database.host, '127.0.0.1')
  assert.equal(ownership.plan.database.name, 'pr265_activity')
  assert.equal(ownership.plan.database.fresh, true)
  const ports = [ownership.plan.database.port]
  for (const endpoint of [ownership.plan.server, ownership.plan.web]) {
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/u)
    ports.push(Number(new URL(endpoint).port))
  }
  assert.ok(ports.every(port => Number.isInteger(port) && port >= 10000 && port <= 65535))
  assert.equal(new Set(ports).size, 3)
  assert.match(ownership.demo.corp_id, /^[0-9a-f-]{36}$/u)
  assert.match(ownership.source.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  assert.match(ownership.source.base_commit, /^[0-9a-f]{40}$/u)
  return { server: ownership.plan.server, databasePort: ownership.plan.database.port }
}

export function evidenceTextDigest(text) {
  return { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }
}

// CLI text can contain embedded JSON or arbitrary error bodies. Its bytes stay
// in memory for complete assertions; evidence records only their digests.
export function serializeReadinessEvidence(report) {
  const evidence = structuredClone(report)
  for (const result of evidence.cli_cases ?? []) {
    for (const stream of ['stdout', 'stderr']) result[stream] = evidenceTextDigest(result[stream])
  }
  return JSON.stringify(redactEvidenceCapabilities(evidence), null, 2)
}
