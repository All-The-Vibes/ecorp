import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('native evidence launch admits only the verified executable across filesystem races', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecorp-evidence-launch-')))
  let completed = false
  t.after(() => { if (completed) rmSync(root, { recursive: true }) })
  mkdirSync(join(root, 'build'))
  const suffix = process.platform === 'win32' ? '.exe' : ''
  for (const [name, source] of [
    ['good', 'fn main() { println!("{}", r#"{"files":["trusted-image"],"directories":[]}"#); }'],
    ['poison', 'fn main() { std::fs::write(std::env::var("ECORP_LAUNCH_POISON_MARKER").unwrap(), "unverified code executed").unwrap(); println!("{}", r#"{"files":[],"directories":[]}"#); }'],
  ]) {
    const path = join(root, 'build', name + '.rs')
    writeFileSync(path, source + '\n')
    const result = spawnSync('rustc', ['--edition=2024', path, '-o', join(root, name + suffix)], {
      encoding: 'utf8', windowsHide: true, timeout: 90_000,
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  }
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', '-S',
    fileURLToPath(new URL('./verified_evidence_launch_fixture.py', import.meta.url)), root], {
    encoding: 'utf8', windowsHide: true, timeout: 150_000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr || result.error?.message)
  const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(receipt.status, 'passed')
  assert.ok(receipt.checks.length >= (process.platform === 'win32' ? 10 : 5))
  console.log(JSON.stringify(receipt))
  completed = true
})
