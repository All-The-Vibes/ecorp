import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Script } from 'node:vm'

const root = path.resolve(import.meta.dirname, '../..')
const baseCommit = 'b31a38a62330aacba80c3953142e1da957a63ecd'
const helper = 'tools/owned_test_stack.mjs'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const base = execFileSync('git', ['show', `${baseCommit}:${helper}`], { cwd: root, windowsHide: true })
const patch = readFileSync(new URL('./pr237-native-time.patch', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const scratchRoot = path.resolve(tmpdir())
const scratch = mkdtempSync(path.join(scratchRoot, 'ecorp-qa-pin-'))
let reconstructed
try {
  mkdirSync(path.join(scratch, 'tools'))
  writeFileSync(path.join(scratch, helper), base)
  // Native Git applies the complete patch; no Git index/repository is created or changed.
  const gitLf = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply']
  execFileSync('git', [...gitLf, '--check', '-'], { cwd: scratch, input: patch, windowsHide: true })
  execFileSync('git', [...gitLf, '-'], { cwd: scratch, input: patch, windowsHide: true })
  reconstructed = readFileSync(path.join(scratch, helper))
} finally {
  assert.equal(path.dirname(scratch), scratchRoot)
  rmSync(scratch, { recursive: true })
}

// Exercise the actual pre-import guards, never importing/executing the service helper
// or reading the historical user's QA directory. Keep the extraction fail-closed.
const source = readFileSync(new URL('./qa-api.mjs', import.meta.url), 'utf8')
const [prefix, actions] = source.split('const helpers = await import(pathToFileURL(helperPath))')
assert.ok(actions && !actions.includes('const helpers = await import'))
assert.ok(prefix.includes('const qa = '))
const guard = new Script(prefix.slice(prefix.indexOf('const qa = '))
  .replace('import.meta.dirname', JSON.stringify(import.meta.dirname)))
function verify(bytes, head = baseCommit, status = ` M ${helper}\n`) {
  const calls = []
  guard.runInNewContext({
    assert, createHash, path,
    execFileSync(command, args) {
      assert.equal(command, 'git')
      args = Array.from(args)
      calls.push(args)
      if (JSON.stringify(args) === '["rev-parse","HEAD"]') return `${head}\n`
      assert.deepEqual(args, ['status', '--porcelain'])
      return status
    },
    readFileSync(file) {
      assert.ok(file.endsWith(path.join('dependencies', 'pr237', helper)))
      return bytes
    },
  })
  assert.deepEqual(calls, [['rev-parse', 'HEAD'], ['status', '--porcelain']])
}

test('published base plus complete patch reconstructs the current driver pin (UTF-8 LF, no BOM)', t => {
  t.diagnostic(JSON.stringify({ baseCommit, baseSha256: sha256(base), patchLfSha256: sha256(patch),
    reconstructedBytes: reconstructed.length, reconstructedSha256: sha256(reconstructed) }))
  assert.equal(reconstructed.includes(13), false, 'canonical bytes must not contain CR')
  assert.notEqual(reconstructed.subarray(0, 3).toString('hex'), 'efbbbf')
  verify(reconstructed)
})

test('guard rejects unpatched, tampered and noncanonical helper bytes', () => {
  for (const bytes of [base, Buffer.concat([reconstructed, Buffer.from('\n')]),
    Buffer.from(reconstructed.toString().replace('Get-Process', 'Get-CimInstance')),
    Buffer.from(reconstructed.toString().replaceAll('\n', '\r\n')),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), reconstructed])]) {
    assert.throws(() => verify(bytes), { code: 'ERR_ASSERTION' })
  }
})

test('guard rejects the correct helper from a different source commit', () => {
  assert.throws(() => verify(reconstructed, '690ee80e692d848c4c3a371ddb31388a78b9ddf3'),
    { code: 'ERR_ASSERTION' })
})

test('guard rejects clean or additional dirty/untracked dependency files', () => {
  for (const status of ['', `MM ${helper}\n`, ` M ${helper}\n M tools/other.mjs\n`,
    ` M ${helper}\n?? unexpected.mjs\n`]) {
    assert.throws(() => verify(reconstructed, baseCommit, status), { code: 'ERR_ASSERTION' })
  }
})
