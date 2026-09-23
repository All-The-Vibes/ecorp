import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyFinalityObservations } from './native_qualification_finality.mjs'

const block = (number) => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}` })
function fixture() {
  return {
    included: block(67),
    observations: [388, 404].map((number, index) => ({
      provider_identity: `provider-${index}`, finalized: block(number),
      retained_ancestry: { header_count: number - 67 + 1, segments: 1 },
    })),
  }
}
test('advancing provider tips pass only with matching canonical readback', async () => {
  const checks = await verifyFinalityObservations(fixture(), async (_, number) => block(number))
  assert.equal(checks.length, 6)
})
test('different canonical ancestry is rejected', async () => {
  await assert.rejects(verifyFinalityObservations(fixture(), async (provider, number) =>
    provider === 'provider-1' && number === 388 ? block(387) : block(number)))
})
test('missing recorded block is rejected', async () => {
  await assert.rejects(verifyFinalityObservations(fixture(), async () => null))
})
test('duplicate provider identity is rejected', async () => {
  const evidence = fixture()
  evidence.observations[1].provider_identity = evidence.observations[0].provider_identity
  await assert.rejects(verifyFinalityObservations(evidence, async (_, number) => block(number)))
})
test('incomplete retained ancestry is rejected', async () => {
  const evidence = fixture()
  evidence.observations[0].retained_ancestry.header_count -= 1
  await assert.rejects(verifyFinalityObservations(evidence, async (_, number) => block(number)))
})
