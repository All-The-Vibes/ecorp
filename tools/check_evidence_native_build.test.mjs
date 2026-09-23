import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('native wrapper rebuilds a poisoned Cargo artifact and rejects later private-executable tampering', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecorp-evidence-build-integrity-')))
  let completed = false
  t.after(() => { if (completed) rmSync(root, { recursive: true }) })
  mkdirSync(join(root, 'tools'))
  mkdirSync(join(root, 'crates/crony-runner/src/bin'), { recursive: true })
  mkdirSync(join(root, 'temp'))
  copyFileSync(new URL('./check_evidence_personal_paths.mjs', import.meta.url), join(root, 'tools/check_evidence_personal_paths.mjs'))
  copyFileSync(new URL('../rust-toolchain.toml', import.meta.url), join(root, 'rust-toolchain.toml'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, 'Cargo.toml'), '[workspace]\nmembers = ["crates/crony-runner"]\nresolver = "2"\n')
  writeFileSync(join(root, 'crates/crony-runner/Cargo.toml'), '[package]\nname = "crony-runner"\nversion = "0.0.0"\nedition = "2024"\n')
  // These tiny real Rust executables exercise artifact provenance only. The
  // adjacent scanner tests independently exercise the production scan behavior.
  writeFileSync(join(root, 'crates/crony-runner/src/bin/crony-evidence-paths.rs'),
    'fn main() { println!("{}", r#"{"files":["rebuilt-from-current-source"],"directories":[]}"#); }\n')
  writeFileSync(join(root, 'poison.rs'),
    'fn main() { println!("{}", r#"{"files":[],"directories":[]}"#); }\n')
  const script = `
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { findPersonalPathFiles } from './tools/check_evidence_personal_paths.mjs'
const root = process.cwd()
const extension = process.platform === 'win32' ? '.exe' : ''
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const run = (program, args) => {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, timeout: 90_000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
}
run('cargo', ['generate-lockfile', '--offline'])
const build = ['build', '--locked', '--quiet', '-p', 'crony-runner', '--bin', 'crony-evidence-paths']
run('cargo', build)
const cached = join(root, 'target/debug/crony-evidence-paths' + extension)
const poison = join(root, 'poison' + extension)
run('rustc', ['--edition=2024', 'poison.rs', '-o', poison])
const retained = join(root, 'retained-originals')
mkdirSync(retained)
const artifactDirectory = join(root, 'target/debug/deps')
const artifacts = readdirSync(artifactDirectory, { withFileTypes: true })
  .filter(entry => entry.isFile() && (extension
    ? /^crony_evidence_paths(?:-[a-f0-9]+)?\\.exe$/.test(entry.name)
    : /^crony_evidence_paths(?:-[a-f0-9]+)?$/.test(entry.name)))
  .map(entry => join(artifactDirectory, entry.name))
assert.ok(artifacts.length > 0, 'retain and poison the actual Cargo compiler artifact')
for (const [index, artifact] of [cached, ...artifacts].entries()) {
  copyFileSync(artifact, join(retained, String(index) + extension))
}
for (const artifact of [cached, ...artifacts]) copyFileSync(poison, artifact)
run('cargo', build)
assert.equal(digest(cached), digest(poison), 'the real unchanged Cargo fingerprint must leave the poisoned cache intact')
assert.deepEqual(findPersonalPathFiles([root]), ['rebuilt-from-current-source'])
const directories = readdirSync(join(root, 'temp')).filter(name => name.startsWith('ecorp-evidence-executable-'))
assert.equal(directories.length, 1)
const compiled = join(root, 'temp', directories[0], 'crony-evidence-paths' + extension)
renameSync(compiled, join(root, 'retained-private-original' + extension))
copyFileSync(poison, compiled)
assert.throws(() => findPersonalPathFiles([root]), /integrity changed after compilation/)
console.log('actual cached-artifact poison ignored; private-executable tamper rejected')
`
  writeFileSync(join(root, 'exercise.mjs'), script)
  const result = spawnSync(process.execPath, ['exercise.mjs'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 150_000,
    env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target'), TMPDIR: join(root, 'temp'), TMP: join(root, 'temp'), TEMP: join(root, 'temp') },
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.match(result.stdout, /actual cached-artifact poison ignored; private-executable tamper rejected/)
  completed = true
})
