import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { APPROVED_FEED_PREFIX, MAX_TOKEN_BUDGET, copyWebSource, qualifyFeedLock } from './test_token_ceiling.mjs'
import { sourceFingerprint } from './research_handoff_native.mjs'
import { tokenCeilingCreationTicks } from './e2e_token_ceiling.mjs'

test('the finite ceiling round-trips through JSON without a sentinel or rounding', () => {
  assert.equal(BigInt(MAX_TOKEN_BUDGET), 999999999999999n)
  assert.ok(Number.isSafeInteger(MAX_TOKEN_BUDGET))
  for (const value of [1, 500_000, 1_000_000, 2_000_000, MAX_TOKEN_BUDGET - 1, MAX_TOKEN_BUDGET]) {
    assert.equal(JSON.parse(JSON.stringify({ budget_tokens: value })).budget_tokens, value)
  }
})

test('feed qualification accepts only the exact prefix replacement and retains integrity and versions', () => {
  const primary = Buffer.from("lockfileVersion: '9.0'\npackages:\n  example@1.2.3:\n    resolution: {integrity: sha512-fixed, tarball: https://registry.npmjs.org/example/-/example-1.2.3.tgz}\n")
  const approved = Buffer.from(primary.toString().replaceAll('https://registry.npmjs.org/', APPROVED_FEED_PREFIX))
  assert.equal(qualifyFeedLock(primary, approved).replacements, 1)
  for (const changed of [
    approved.toString().replace('sha512-fixed', 'sha512-changed'),
    approved.toString().replaceAll('1.2.3', '1.2.4'),
    approved.toString().replace('https:', 'http:'),
    approved.toString().replace('npm-public', 'unapproved-feed'),
    approved.toString().replaceAll('\n', '\r\n'),
    `${approved.toString()}settings: {verifyStoreIntegrity: false}\n`,
  ]) assert.throws(() => qualifyFeedLock(primary, Buffer.from(changed)), /approved feed prefix/u)
})

test('integrity-only current locks require an identical descriptor, not a historical feed lock', () => {
  const primary = Buffer.from("lockfileVersion: '9.0'\npackages:\n  example@1.2.3:\n    resolution: {integrity: sha512-fixed}\n")
  const result = qualifyFeedLock(primary, primary)
  assert.equal(result.replacements, 0)
  assert.equal(result.primary_sha256, result.descriptor_sha256)
  assert.throws(() => qualifyFeedLock(primary, Buffer.from(`${primary}# historical descriptor\n`)), /approved feed prefix/u)
})

test('owned E2E keeps native process timestamp precision and rejects locale or truncated timestamps', () => {
  assert.equal(tokenCeilingCreationTicks('1970-01-01T00:00:00.0000000Z'), '621355968000000000')
  assert.equal(tokenCeilingCreationTicks('1970-01-01T00:00:00.0000001Z'), '621355968000000001')
  for (const invalid of ['10/02/2026 03:27:02', '2026-10-02T03:27:02.173Z', '2026-10-02T03:27:02.1731966-05:00']) {
    assert.throws(() => tokenCeilingCreationTicks(invalid), /original UTC native process timestamp/u)
  }
})

test('disposable web source preserves tracked files excluded by ignore rules', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ecorp-token-copy-test-'))
  const owned = await realpath(directory)
  t.after(async () => {
    assert.equal(await realpath(directory), owned)
    assert.equal(path.dirname(owned), await realpath(os.tmpdir()))
    await rm(owned, { recursive: true })
  })
  const source = path.join(directory, 'original'), destination = path.join(directory, 'copy')
  await mkdir(source)
  await mkdir(destination)
  const git = args => execFileSync('git', args, { cwd: source, windowsHide: true, stdio: 'pipe' })
  git(['init', '--quiet'])
  await writeFile(path.join(source, '.gitignore'), 'retained.txt\nignored.txt\n')
  await writeFile(path.join(source, 'retained.txt'), 'tracked despite ignore\n')
  await writeFile(path.join(source, 'ignored.txt'), 'excluded local output\n')
  await writeFile(path.join(source, 'untracked.txt'), 'new contribution\n')
  git(['add', '--force', '.gitignore', 'retained.txt'])
  assert.equal(await copyWebSource(source, destination), 3)
  assert.equal(await sourceFingerprint(destination), await sourceFingerprint(source))
})
