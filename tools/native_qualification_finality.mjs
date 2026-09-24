import assert from 'node:assert/strict'

// Recorded finality tips may advance between providers; require the same canonical ancestry,
// not simultaneous tips. This online readback is not an offline proof of public-chain finality.
export async function verifyFinalityObservations(evidence, readBlock) {
  assert.equal(evidence.observations.length, 2)
  const providers = evidence.observations.map((observation) => observation.provider_identity)
  assert.equal(new Set(providers).size, 2)
  for (const observation of evidence.observations) {
    assert.ok(observation.finalized.number >= evidence.included.number)
    assert.equal(observation.retained_ancestry.header_count,
      observation.finalized.number - evidence.included.number + 1)
    assert.ok(observation.retained_ancestry.segments > 0)
  }
  const checks = []
  for (const provider of providers) {
    for (const expected of [evidence.included, ...evidence.observations.map((item) => item.finalized)]) {
      const actual = await readBlock(provider, expected.number)
      assert.ok(actual, 'Recorded canonical block missing')
      assert.equal(actual.hash, expected.hash, 'Providers disagree on recorded canonical ancestry')
      assert.equal(BigInt(actual.number), BigInt(expected.number))
      checks.push({ provider, number: expected.number, hash: expected.hash })
    }
  }
  return checks
}
