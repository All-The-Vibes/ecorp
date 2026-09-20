import assert from 'node:assert/strict'
import { git, sha256 } from './verify-inputs.mjs'

const revision = process.argv[2]
assert.match(revision ?? '', /^[a-f0-9]{40}$/, 'supply an immutable full commit ID')
assert.equal(git(['rev-parse', `${revision}^{commit}`]).toString().trim(), revision)
const checks = [
  ['status.mjs', 'df8af8ce2c756d230c1d303c2121c88a8495c608c3616592504b42a3d47c520b'],
  ['README.md', '123cc52972ec592813f99069b97b79423bff1b04fa9025822327190fd646fa8e'],
].map(([name, requiredSha256]) => {
  const path = `scenarios/factory-live-canary/${name}`
  const blob = git(['rev-parse', `${revision}:${path}`]).toString().trim()
  const bytes = git(['cat-file', 'blob', blob])
  const actualSha256 = sha256(bytes)
  return { path, blob, byteLength: bytes.length, requiredSha256, actualSha256,
    pass: actualSha256 === requiredSha256 }
})
console.log(JSON.stringify({ revision, method: 'raw Git blobs; historical runtime never executed', checks }, null, 2))
process.exitCode = checks.every(check => check.pass) ? 0 : 1
