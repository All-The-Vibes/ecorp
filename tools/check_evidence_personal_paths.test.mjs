import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { findPersonalPathFiles, hasPersonalUserPath } from './check_evidence_personal_paths.mjs'

test('personal paths include drive-relative, prefixed, escaped and alternate separators', () => {
  for (const path of [
    String.raw`\Users\fixture-user`, String.raw`C:\Users\fixture-user\source`,
    String.raw`D:\\Users\\fixture-user`, String.raw`\\Users\\fixture-user`,
    '/Users/fixture-user', 'd:/users/fixture-user/source',
    String.raw`c:\uSeRs/fixture-user`, JSON.stringify({ HOMEPATH: String.raw`\Users\fixture-user` }),
  ]) assert.equal(hasPersonalUserPath(path), true, 'personal path was not detected')
})

test('normalized placeholders and ordinary prose remain valid', () => {
  for (const text of [
    '<original-user>', '<local-user>/source', String.raw`C:\Users\<original-user>\source`,
    'Users can review evidence.', 'source/users.test.mjs', 'C:/Users/',
  ]) assert.equal(hasPersonalUserPath(text), false)
})

test('recursive packet scan and CLI reject a leak without printing its value', t => {
  const root = mkdtempSync(join(tmpdir(), 'ecorp-evidence-path-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'prior-attempts'))
  const receipt = join(root, 'prior-attempts', 'environment.json')
  writeFileSync(receipt, JSON.stringify({ HOMEPATH: String.raw`\Users\fixture-user` }))
  assert.equal(findPersonalPathFiles([root]).length, 1)
  const tool = fileURLToPath(new URL('./check_evidence_personal_paths.mjs', import.meta.url))
  const failed = spawnSync(process.execPath, [tool, root], { encoding: 'utf8', windowsHide: true })
  assert.equal(failed.status, 1, failed.stderr)
  assert.equal(JSON.parse(failed.stdout).status, 'failed')
  assert.equal(failed.stdout.includes('fixture-user'), false)
  writeFileSync(receipt, JSON.stringify({ HOMEPATH: '<original-user>' }))
  assert.deepEqual(findPersonalPathFiles([root]), [])
  const passed = spawnSync(process.execPath, [tool, root], { encoding: 'utf8', windowsHide: true })
  assert.equal(passed.status, 0, passed.stderr)
  assert.equal(JSON.parse(passed.stdout).status, 'passed')
})

test('both retained PR226 packets contain no personal user paths', () => {
  assert.deepEqual(findPersonalPathFiles(), [])
})
