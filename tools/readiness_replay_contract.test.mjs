import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { evidenceTextDigest, serializeReadinessEvidence, validateReadinessFixture } from './readiness_replay_contract.mjs'

test('readiness follows a fresh fixture name and its selected ports, rejecting scope or endpoint drift', t => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'ecorp-readiness-contract-'))
  let passed = false
  t.after(() => { if (passed) rmSync(temporary, { recursive: true }) })
  const root = path.join(temporary, 'qa', 'pr265-run-activity-independent-replay')
  const product = path.join(temporary, 'arbitrary-checkout')
  mkdirSync(root, { recursive: true })
  mkdirSync(product)
  const sourceHead = 'a'.repeat(40)
  const ownership = { test_owned: true, purpose: 'pr265-run-activity', workspace: root,
    plan: { qa_root: root, product, product_commit: sourceHead,
      server: 'http://127.0.0.1:29454', web: 'http://127.0.0.1:26454',
      database: { host: '127.0.0.1', port: 25454, name: 'pr265_activity', fresh: true } },
    demo: { corp_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    source: { repository: 'ecorp-fixture/readiness', base_commit: 'b'.repeat(40) } }
  const validate = candidate => validateReadinessFixture({ root, product, sourceHead, ownership: candidate })
  assert.deepEqual(validate(ownership), { server: ownership.plan.server, databasePort: 25454 })
  for (const mutate of [
    value => { value.test_owned = false },
    value => { value.workspace = product },
    value => { value.plan.product = root },
    value => { value.plan.product_commit = 'c'.repeat(40) },
    value => { value.plan.server = 'http://example.invalid:29454' },
    value => { value.plan.server = 'http://127.0.0.1:29454/other' },
    value => { value.plan.web = value.plan.server },
    value => { value.plan.database.port = '25454' },
    value => { value.plan.database.port = 9999 },
    value => { value.plan.database.port = 65536 },
    value => { value.plan.database.host = 'localhost' },
    value => { value.plan.database.fresh = false },
  ]) {
    const candidate = structuredClone(ownership)
    mutate(candidate)
    assert.throws(() => validate(candidate))
  }
  passed = true
})

test('failure evidence redacts unexpected claim capabilities and never serializes CLI text', () => {
  const report = { status: 'failed', failure: { kind: 'assertion', stage: 'claim' },
    assertions: [{ response: { status: 409, payload: { claim_capability: 'unexpected-claim-canary',
      nested: { approval_token: 'nested-approval-canary' } } } }],
    cli_cases: [{ stdout: '{"claim_token":"stdout-authority-canary"}',
      stderr: 'failure details with stderr-authority-canary',
      routes: [{ response: { credential: 'route-authority-canary' } }] }] }
  const original = structuredClone(report)
  const serialized = serializeReadinessEvidence(report)
  for (const marker of ['unexpected-claim-canary', 'nested-approval-canary',
    'stdout-authority-canary', 'stderr-authority-canary', 'route-authority-canary']) {
    assert.equal(serialized.includes(marker), false)
  }
  const evidence = JSON.parse(serialized)
  assert.equal(evidence.assertions[0].response.status, 409)
  assert.deepEqual(evidence.cli_cases[0].stderr, evidenceTextDigest(report.cli_cases[0].stderr))
  assert.deepEqual(report, original, 'full in-memory values remain available for assertions')
  report.assertions[0].response.payload.claim_capability = 'different-claim-canary'
  assert.notEqual(serializeReadinessEvidence(report), serialized, 'capability changes remain observable')
})
