import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { redactEvidenceCapabilities } from './redact_evidence_capabilities.mjs'

test('ledger snapshots and equality hashes never contain raw nested capabilities', () => {
  const input = { factory_work_items: [{ claim_token: 'qa-claim-canary', claim_capability: 'qa-capability-canary',
    contract: { approval_token: 'nested-authority-canary' }, budget_tokens: 42, state: 'claimed' }],
  factory_operations: [{ token: null }], events: [{ payload: { runner_capabilities: ['native-canary'] } }] }
  const original = JSON.stringify(input)
  const redacted = redactEvidenceCapabilities(input)
  const serialized = JSON.stringify(redacted)
  for (const canary of ['qa-claim-canary', 'qa-capability-canary', 'nested-authority-canary', 'native-canary']) {
    assert.equal(serialized.includes(canary), false)
  }
  assert.equal(redacted.factory_work_items[0].budget_tokens, 42)
  assert.equal(redacted.factory_operations[0].token, null)
  assert.equal(JSON.stringify(input), original, 'custody bytes are not rewritten in memory')
  assert.deepEqual(redactEvidenceCapabilities(input), redacted)
  input.factory_work_items[0].claim_token = 'different-authority-canary'
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  assert.notEqual(hash(redacted), hash(redactEvidenceCapabilities(input)), 'a capability mutation still changes equality evidence')
})
