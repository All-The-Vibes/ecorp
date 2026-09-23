import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { defaultEvidenceDirectories, findPersonalPathFiles, hasPersonalUserPath } from './check_evidence_personal_paths.mjs'
import * as evidencePaths from './check_evidence_personal_paths.mjs'

test('personal paths include drive-relative, prefixed, escaped and alternate separators', () => {
  for (const path of [
    String.raw`\Users\fixture-user`, String.raw`C:\Users\fixture-user\source`,
    String.raw`D:\\Users\\fixture-user`, String.raw`\\Users\\fixture-user`,
    '/Users/fixture-user', 'd:/users/fixture-user/source',
    String.raw`c:\uSeRs/fixture-user`, JSON.stringify({ HOMEPATH: String.raw`\Users\fixture-user` }),
    '/Users/\u0085name',
  ]) assert.equal(hasPersonalUserPath(path), true, 'personal path was not detected')
})

test('normalized placeholders and ordinary prose remain valid', () => {
  for (const text of [
    '<original-user>', '<local-user>/source', String.raw`C:\Users\<original-user>\source`,
    'Users can review evidence.', 'source/users.test.mjs', 'C:/Users/',
    '/Users/\ufeffname', '/Users/\u00a0name', '/Users/\u2003name',
  ]) assert.equal(hasPersonalUserPath(text), false)
})

test('recursive packet scan and CLI reject a leak without printing its value', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecorp-evidence-path-')))
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

test('every retained PR226 packet including the latest correction is scanned', () => {
  const parent = fileURLToPath(new URL('../docs/evidence/', import.meta.url))
  const expected = fs.readdirSync(parent).filter(name => name.startsWith('pr-226-completion-')
    || name === 'pr226-integration-20260921' || name === 'pr226-local-validation').sort()
  assert(expected.includes('pr-226-completion-20260922-r4'), 'retain the latest correction packet')
  assert.deepEqual(defaultEvidenceDirectories().map(name => basename(name)).sort(), expected)
  assert.deepEqual(findPersonalPathFiles(), [])
})

test('root and ancestor directory links cannot redirect an evidence scan', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecorp-evidence-root-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = join(root, 'original')
  const child = join(target, 'packet')
  mkdirSync(child, { recursive: true })
  const file = join(child, 'safe.txt')
  writeFileSync(file, 'retained fixture bytes\n')
  const direct = join(root, 'direct-link')
  const ancestor = join(root, 'parent-link')
  symlinkSync(child, direct, process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(target, ancestor, process.platform === 'win32' ? 'junction' : 'dir')
  for (const redirected of [direct, join(ancestor, 'packet')]) {
    assert.throws(() => findPersonalPathFiles([redirected]), /regular files and directories/)
  }
  assert.equal(readFileSync(file, 'utf8'), 'retained fixture bytes\n')
  assert.deepEqual(findPersonalPathFiles([child]), [])
})

test('nested and dangling directory links fail closed', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecorp-evidence-link-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packet = join(root, 'packet')
  const outside = join(root, 'outside')
  mkdirSync(packet)
  mkdirSync(outside)
  const link = join(packet, 'redirect')
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => findPersonalPathFiles([packet]), /regular files and directories/)
  rmSync(outside, { recursive: true })
  assert.throws(() => findPersonalPathFiles([link]), /regular files and directories/)
})

test('canonical containment rejects absolute cross-drive and UNC relative results', () => {
  const inside = evidencePaths.isContainedEvidencePath
  assert.equal(typeof inside, 'function')
  for (const [root, candidate] of [
    ['C:\\root', 'D:\\outside'], ['C:\\root', '\\\\server\\share\\outside'],
    ['\\\\server\\share\\root', '\\\\other\\share\\outside'],
    ['\\\\server\\share\\root', '\\\\server\\different\\outside'],
    ['C:\\root', 'C:\\root-other'], ['C:\\root', 'C:\\outside'],
  ]) assert.equal(inside(root, candidate, win32), false, 'outside canonical path admitted')
  for (const [root, candidate] of [
    ['C:\\root', 'C:\\root'], ['C:\\root', 'C:\\root\\nested'],
    ['\\\\server\\share\\root', '\\\\server\\share\\root\\nested'],
  ]) assert.equal(inside(root, candidate, win32), true, 'contained canonical path rejected')
})

test('actual Windows short alias succeeds while a linked ancestor still fails', { skip: process.platform !== 'win32' }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecorp-real-short-path-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packet = join(root, 'retained-evidence-with-a-long-name')
  mkdirSync(packet)
  writeFileSync(join(packet, 'safe.txt'), 'retained fixture bytes\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $fs=New-Object -ComObject Scripting.FileSystemObject; try { [Console]::Out.Write($fs.GetFolder($env:ECORP_TEST_SHORT_ROOT).ShortPath) } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($fs) }'],
  { env: { ...process.env, ECORP_TEST_SHORT_ROOT: packet }, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, 'native short-path lookup failed')
  const short = result.stdout.trim()
  if (short.toLowerCase() === packet.toLowerCase()) {
    t.skip('This Windows volume does not provide an actual 8.3 alias')
    return
  }
  assert.match(short, /~[0-9a-z]/i, 'native lookup must supply an actual short alias')
  assert.equal(realpathSync.native(short), realpathSync.native(packet))
  assert.deepEqual(findPersonalPathFiles([short]), [])
  const link = join(root, 'linked-parent')
  symlinkSync(packet, link, 'junction')
  assert.throws(() => findPersonalPathFiles([link]), /regular files and directories/)
})

// Native replacement-window and read-admission controls live beside the Rust scanner.
test('native scanner rejects oversize sparse evidence', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecorp-evidence-size-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'oversize.bin')
  writeFileSync(file, '')
  fs.truncateSync(file, 16 * 1024 * 1024 + 1)
  assert.throws(() => findPersonalPathFiles([root]), /byte limit/)
})

test('empty evidence and a file at the byte limit are accepted', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ecorp-evidence-boundary-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'empty.txt'), '')
  const boundary = join(root, 'boundary.bin')
  writeFileSync(boundary, '')
  fs.truncateSync(boundary, 16 * 1024 * 1024)
  assert.deepEqual(findPersonalPathFiles([root]), [])
})

test('native scanner rejects hard-linked evidence and preserves the shared file', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ecorp-evidence-hardlink-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packet = join(root, 'packet'), outside = join(root, 'outside.txt')
  mkdirSync(packet)
  writeFileSync(outside, 'owned outside fixture\n')
  fs.linkSync(outside, join(packet, 'alias.txt'))
  assert.throws(() => findPersonalPathFiles([packet]), /regular files and directories/)
  assert.equal(readFileSync(outside, 'utf8'), 'owned outside fixture\n')
})
