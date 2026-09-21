import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)
const bytes = (value, length) => Array.isArray(value) && value.length === length
  && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function parse(bytes, name) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    // JSON parser errors can include input excerpts; never propagate them.
    throw new Error(`Invalid JSON in original trust input ${name}`)
  }
}

function validate(destination) {
  assert.ok(record(destination) && record(destination.config)
    && digest(destination.config.manifest_digest), 'Invalid original destination manifest digest')
  const pin = destination.trust_pin
  assert.ok(record(pin) && bytes(pin.authority, 32) && digest(pin.initial_manifest_digest),
    'Invalid original destination trust pin')
  // This helper materializes the fixture's V1 bootstrap, not a regenerated trust chain.
  assert.ok(Array.isArray(destination.manifests) && destination.manifests.length === 1,
    'Original destination must contain one bootstrap manifest')
  const signed = destination.manifests[0]
  assert.ok(record(signed) && digest(signed.digest) && record(signed.manifest)
    && signed.manifest.schema_version === 1 && signed.manifest.manifest_version === 1
    && signed.manifest.previous_manifest_digest === null
    && Array.isArray(signed.canonical) && signed.canonical.length > 0
    && signed.canonical.length <= 65536 && bytes(signed.canonical, signed.canonical.length)
    && bytes(signed.signature, 64) && signed.successor_countersignature === null,
  'Invalid original signed bootstrap manifest')
  assert.ok(pin.initial_manifest_digest === signed.digest
    && destination.config.manifest_digest === signed.digest,
  'Original destination trust pin, manifest and config digests must agree')
  // Cryptographic signature/canonical-payload verification remains the native CLI's job.
}

async function readExisting(file, name, expected) {
  let contents
  try {
    contents = await fs.readFile(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`Cannot read original trust input ${name}`)
  }
  assert.ok(canonical(parse(contents, name)) === canonical(expected),
    `Existing ${name} does not match original destination trust input`)
  return contents
}

export async function ensureOriginalTrustInputs(outputDir) {
  const destinationPath = path.resolve(outputDir, 'destination.json')
  let destinationBytes
  try {
    destinationBytes = await fs.readFile(destinationPath)
  } catch {
    throw new Error('Cannot read original destination.json')
  }
  const destination = parse(destinationBytes, 'destination.json')
  validate(destination)
  const inputs = [
    { name: 'manifests.json', value: destination.manifests },
    { name: 'trust-pin.json', value: destination.trust_pin },
  ]
  // Check both before creating either, so a retained mismatch causes no new writes.
  for (const input of inputs) {
    input.path = path.resolve(outputDir, input.name)
    input.bytes = await readExisting(input.path, input.name, input.value)
  }
  for (const input of inputs) {
    if (input.bytes !== null) continue
    const contents = Buffer.from(`${JSON.stringify(input.value, null, 2)}\n`)
    try {
      await fs.writeFile(input.path, contents, { flag: 'wx', mode: 0o600 })
      input.bytes = contents
    } catch (error) {
      if (error.code !== 'EEXIST') {
        // Do not unlink or replace anything, even after an interrupted/partial write.
        throw new Error(`Cannot exclusively create original trust input ${input.name}`)
      }
      input.bytes = await readExisting(input.path, input.name, input.value)
      assert.ok(input.bytes !== null, `Concurrent original trust input ${input.name} disappeared`)
    }
  }
  return {
    destinationPath,
    manifestsPath: inputs[0].path,
    trustPinPath: inputs[1].path,
    manifestDigest: destination.config.manifest_digest,
    manifests: destination.manifests,
    trustPin: destination.trust_pin,
    sha256: Object.fromEntries(inputs.map((input) => [
      input.name, createHash('sha256').update(input.bytes).digest('hex'),
    ])),
  }
}
