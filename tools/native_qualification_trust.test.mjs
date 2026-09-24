import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { ensureOriginalTrustInputs } from './native_qualification_trust.mjs'

const output = path.resolve(import.meta.dirname, '..', 'output', 'native-qualification', 'harness-fixes')
const hash = `0x${'12'.repeat(32)}`
const otherHash = `0x${'34'.repeat(32)}`
const canary = 'synthetic-credential-must-not-appear-in-errors'
function original() {
  return {
    config: { manifest_digest: hash, primary_rpc_secret: canary },
    trust_pin: { authority: Array(32).fill(7), initial_manifest_digest: hash },
    manifests: [{
      manifest: { schema_version: 1, manifest_version: 1, previous_manifest_digest: null },
      canonical: [1, 2, 3],
      signature: Array(64).fill(9),
      digest: hash,
      successor_countersignature: null,
    }],
  }
}

async function fixture(t, value = original()) {
  await fs.mkdir(output, { recursive: true })
  const dir = await fs.mkdtemp(path.join(output, 'trust-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, 'destination.json'), JSON.stringify(value))
  return dir
}
const read = (dir, name) => fs.readFile(path.join(dir, name), 'utf8')
const write = (dir, name, value) => fs.writeFile(path.join(dir, name), JSON.stringify(value))
const absent = (dir, name) => assert.rejects(fs.stat(path.join(dir, name)), { code: 'ENOENT' })
const safeFailure = (pattern) => (error) => {
  assert.match(error.message, pattern)
  assert.ok(!error.stack.includes(canary), 'Failure must not disclose credential-like input')
  assert.equal(error.cause, undefined)
  if (error instanceof assert.AssertionError) {
    assert.equal(typeof error.actual, 'boolean')
    assert.equal(typeof error.expected, 'boolean')
  }
  return true
}

test('fresh fixture destination alone creates both independent trust inputs', async (t) => {
  const dir = await fixture(t)
  const before = await read(dir, 'destination.json')
  await absent(dir, 'manifests.json')
  await absent(dir, 'trust-pin.json')
  const result = await ensureOriginalTrustInputs(dir)
  assert.equal(result.destinationPath, path.join(dir, 'destination.json'))
  assert.equal(result.manifestsPath, path.join(dir, 'manifests.json'))
  assert.equal(result.trustPinPath, path.join(dir, 'trust-pin.json'))
  assert.equal(result.manifestDigest, hash)
  assert.deepEqual(result.manifests, original().manifests)
  assert.deepEqual(result.trustPin, original().trust_pin)
  for (const [name, expected] of [
    ['manifests.json', original().manifests], ['trust-pin.json', original().trust_pin],
  ]) {
    const contents = await read(dir, name)
    assert.deepEqual(JSON.parse(contents), expected)
    assert.equal(result.sha256[name], createHash('sha256').update(contents).digest('hex'))
    assert.ok(!contents.includes(canary))
  }
  assert.equal(await read(dir, 'destination.json'), before)
})

test('repeated call preserves bytes and hashes', async (t) => {
  const dir = await fixture(t)
  const first = await ensureOriginalTrustInputs(dir)
  const before = await Promise.all(['manifests.json', 'trust-pin.json'].map((name) => read(dir, name)))
  assert.deepEqual(await ensureOriginalTrustInputs(dir), first)
  assert.deepEqual(await Promise.all(['manifests.json', 'trust-pin.json'].map((name) => read(dir, name))), before)
})

for (const [name, value] of [
  ['trust-pin.json', { ...original().trust_pin, initial_manifest_digest: otherHash, secret: canary }],
  ['manifests.json', [{ ...original().manifests[0], digest: otherHash, secret: canary }]],
]) {
  test(`mismatched retained ${name} rejects before any write`, async (t) => {
    const dir = await fixture(t)
    await write(dir, name, value)
    const before = await read(dir, name)
    await assert.rejects(ensureOriginalTrustInputs(dir), safeFailure(/does not match original/))
    assert.equal(await read(dir, name), before)
    await absent(dir, name === 'trust-pin.json' ? 'manifests.json' : 'trust-pin.json')
  })
}

test('semantic equality ignores whitespace and object key order without rewriting', async (t) => {
  const dir = await fixture(t)
  const reverse = (value) => Array.isArray(value) ? value.map(reverse)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverse(value[key])])) : value
  for (const [name, value] of [
    ['manifests.json', original().manifests], ['trust-pin.json', original().trust_pin],
  ]) {
    await fs.writeFile(path.join(dir, name), ` \n${JSON.stringify(reverse(value))}\n\n`)
  }
  const before = await Promise.all(['manifests.json', 'trust-pin.json'].map((name) => read(dir, name)))
  await ensureOriginalTrustInputs(dir)
  assert.deepEqual(await Promise.all(['manifests.json', 'trust-pin.json'].map((name) => read(dir, name))), before)
})

test('array order remains significant', async (t) => {
  const dir = await fixture(t)
  const manifests = original().manifests
  manifests[0].canonical.reverse()
  await write(dir, 'manifests.json', manifests)
  await assert.rejects(ensureOriginalTrustInputs(dir), safeFailure(/does not match original/))
  assert.deepEqual(JSON.parse(await read(dir, 'manifests.json')), manifests)
  await absent(dir, 'trust-pin.json')
})

for (const [name, change] of [
  ['missing pin', (value) => { delete value.trust_pin }],
  ['invalid authority bytes', (value) => { value.trust_pin.authority[0] = 256 }],
  ['missing manifests', (value) => { delete value.manifests }],
  ['empty manifests', (value) => { value.manifests = [] }],
  ['unsigned manifest', (value) => { delete value.manifests[0].signature }],
  ['invalid canonical bytes', (value) => { value.manifests[0].canonical = [canary] }],
  ['wrong manifest version', (value) => { value.manifests[0].manifest.manifest_version = 2 }],
  ['not bootstrap', (value) => { value.manifests[0].manifest.previous_manifest_digest = otherHash }],
  ['invalid config digest', (value) => { value.config.manifest_digest = canary }],
  ['inconsistent config digest', (value) => { value.config.manifest_digest = otherHash }],
  ['inconsistent pinned digest', (value) => { value.trust_pin.initial_manifest_digest = otherHash }],
]) {
  test(`invalid original input: ${name}`, async (t) => {
    const value = original()
    change(value)
    const dir = await fixture(t, value)
    await assert.rejects(ensureOriginalTrustInputs(dir), safeFailure(/original|Original/))
    await absent(dir, 'manifests.json')
    await absent(dir, 'trust-pin.json')
  })
}

test('invalid original JSON rejects without exposing parser input', async (t) => {
  const dir = await fixture(t)
  await fs.writeFile(path.join(dir, 'destination.json'), `{"secret":"${canary}",`)
  await assert.rejects(ensureOriginalTrustInputs(dir), safeFailure(/Invalid JSON/))
  await absent(dir, 'manifests.json')
  await absent(dir, 'trust-pin.json')
})

test('missing original destination is never recovered from other files', async (t) => {
  const dir = await fixture(t)
  await fs.unlink(path.join(dir, 'destination.json'))
  await write(dir, 'github-native-archive.json', original())
  await assert.rejects(ensureOriginalTrustInputs(dir), safeFailure(/Cannot read original destination/))
  await absent(dir, 'manifests.json')
  await absent(dir, 'trust-pin.json')
})

test('changed bootstrap cannot override either retained trust input', async (t) => {
  const dir = await fixture(t)
  await ensureOriginalTrustInputs(dir)
  const before = await Promise.all(['manifests.json', 'trust-pin.json'].map((name) => read(dir, name)))
  const changed = original()
  changed.config.manifest_digest = otherHash
  changed.trust_pin.initial_manifest_digest = otherHash
  changed.manifests[0].digest = otherHash
  await write(dir, 'destination.json', changed)
  await assert.rejects(ensureOriginalTrustInputs(dir), safeFailure(/does not match original/))
  assert.deepEqual(await Promise.all(['manifests.json', 'trust-pin.json'].map((name) => read(dir, name))), before)
})

test('one complete input from an interrupted call is preserved while the other is created', async (t) => {
  const dir = await fixture(t)
  await write(dir, 'manifests.json', original().manifests)
  const before = await read(dir, 'manifests.json')
  await ensureOriginalTrustInputs(dir)
  assert.equal(await read(dir, 'manifests.json'), before)
  assert.deepEqual(JSON.parse(await read(dir, 'trust-pin.json')), original().trust_pin)
})

test('partial existing JSON fails closed and is never repaired or overwritten', async (t) => {
  const dir = await fixture(t)
  const partial = `{"secret":"${canary}",`
  await fs.writeFile(path.join(dir, 'trust-pin.json'), partial)
  await assert.rejects(ensureOriginalTrustInputs(dir), safeFailure(/Invalid JSON/))
  assert.equal(await read(dir, 'trust-pin.json'), partial)
  await absent(dir, 'manifests.json')
})

for (const partial of [false, true]) {
  test(`second write failure ${partial ? 'retains partial bytes and fails closed on retry' : 'allows retry without rewriting the first input'}`, async (t) => {
    const dir = await fixture(t)
    const nativeWrite = fs.writeFile.bind(fs)
    const writer = t.mock.method(fs, 'writeFile', async (file, contents, options) => {
      if (file === path.join(dir, 'trust-pin.json') && options?.flag === 'wx') {
        if (partial) await nativeWrite(file, '{', options)
        throw Object.assign(new Error(canary), { code: 'EIO' })
      }
      return nativeWrite(file, contents, options)
    })
    await assert.rejects(ensureOriginalTrustInputs(dir), safeFailure(/Cannot exclusively create/))
    const first = await read(dir, 'manifests.json')
    assert.deepEqual(JSON.parse(first), original().manifests)
    writer.mock.restore()
    if (partial) {
      await assert.rejects(ensureOriginalTrustInputs(dir), safeFailure(/Invalid JSON/))
      assert.equal(await read(dir, 'trust-pin.json'), '{')
    } else {
      await absent(dir, 'trust-pin.json')
      await ensureOriginalTrustInputs(dir)
      assert.deepEqual(JSON.parse(await read(dir, 'trust-pin.json')), original().trust_pin)
    }
    assert.equal(await read(dir, 'manifests.json'), first)
  })
}

for (const mismatch of [false, true]) {
  test(`exclusive-create EEXIST ${mismatch ? 'rejects a conflicting winner' : 'compares an equivalent winner'}`, async (t) => {
    const dir = await fixture(t)
    const nativeWrite = fs.writeFile.bind(fs)
    let raced = false
    t.mock.method(fs, 'writeFile', async (file, contents, options) => {
      if (!raced && file === path.join(dir, 'manifests.json') && options?.flag === 'wx') {
        raced = true
        const winner = original().manifests
        if (mismatch) winner[0].digest = otherHash
        await nativeWrite(file, JSON.stringify(winner), { flag: 'wx' })
      }
      return nativeWrite(file, contents, options)
    })
    if (mismatch) {
      await assert.rejects(ensureOriginalTrustInputs(dir), safeFailure(/does not match original/))
      await absent(dir, 'trust-pin.json')
    } else {
      await ensureOriginalTrustInputs(dir)
      assert.deepEqual(JSON.parse(await read(dir, 'trust-pin.json')), original().trust_pin)
    }
    assert.ok(raced)
    assert.equal(JSON.parse(await read(dir, 'manifests.json'))[0].digest, mismatch ? otherHash : hash)
  })
}
