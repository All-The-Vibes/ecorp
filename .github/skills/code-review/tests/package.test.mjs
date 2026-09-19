import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const walk = (path) => {
  const stat = lstatSync(path)
  assert.ok(!stat.isSymbolicLink(), `symlink in package: ${path}`)
  return stat.isDirectory()
    ? readdirSync(path).flatMap((name) => walk(resolve(path, name)))
    : [path]
}

test('every pinned upstream dependency exists and retains its exact bytes', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'upstream/manifest.json'), 'utf8'))
  assert.equal(manifest.length, 10)
  assert.equal(new Set(manifest.map(({ path }) => path)).size, manifest.length, 'duplicate dependency')
  const controlFiles = ['upstream/manifest.json', 'upstream/.gitattributes'].map((path) => resolve(root, path))
  assert.deepEqual(
    walk(resolve(root, 'upstream')).filter((path) => !controlFiles.includes(path)).sort(),
    manifest.map(({ path }) => resolve(root, path)).sort(),
    'upstream files must match manifest paths',
  )
  for (const entry of manifest) {
    const path = resolve(root, entry.path)
    assert.ok(path.startsWith(root), `dependency outside skill: ${entry.path}`)
    assert.match(entry.source, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//)
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), entry.sha256, entry.path)
  }
})

test('the entrypoint and maintained references resolve inside the package', () => {
  const files = [resolve(root, 'SKILL.md'), ...walk(resolve(root, 'references'))]
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^https:\/\//.test(href)) continue
      const target = resolve(dirname(file), href.split('#')[0])
      assert.ok(target.startsWith(root.endsWith(sep) ? root : root + sep), href)
      assert.ok(statSync(target).isFile(), `${file}: ${href}`)
    }
  }
  const entrypoint = readFileSync(resolve(root, 'SKILL.md'), 'utf8')
  assert.match(entrypoint, /^---\r?\nname: code-review\r?\ndescription: [^\r\n]+\r?\n---/)
})

const stableRustInput = /^        with:\r?\n          toolchain: (?:stable|1\.98\.1)\r?$/m

test('Rust input accepts stable or the accepted exact release, not implicit or other channels', () => {
  for (const toolchain of ['stable', '1.98.1']) {
    assert.match(`        with:\n          toolchain: ${toolchain}\n`, stableRustInput)
  }
  for (const toolchain of ['', 'nightly', 'beta', '1.98', '1.98.1-beta', '1x98x1']) {
    assert.doesNotMatch(`        with:\n          toolchain: ${toolchain}\n`, stableRustInput)
  }
  assert.doesNotMatch('        with:\n          components: rustfmt, clippy\n', stableRustInput)
})

test('CI remote actions use full commit SHAs and an explicit stable Rust channel or accepted release', () => {
  const workflow = readFileSync(resolve(root, '../../workflows/ci.yml'), 'utf8')
  const uses = [...workflow.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]+([^\s#]+)/gm)]
    .map(([, action]) => action)
    .filter((action) => !action.startsWith('./') && !action.startsWith('docker://'))
  assert.ok(uses.length > 0, 'CI remote actions must be checked')
  for (const action of uses) {
    assert.match(action, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/, `remote action must use a full commit SHA: ${action}`)
  }
  const rustSteps = workflow.split(/^      - /m).filter((step) => /^uses: dtolnay\/rust-toolchain@/.test(step))
  assert.ok(rustSteps.length > 0, 'CI Rust toolchain steps must be checked')
  for (const step of rustSteps) {
    assert.match(step, stableRustInput, 'SHA-pinned Rust action requires explicit stable or accepted 1.98.1 input')
  }
})

test('Windows runner CI compiles before ACL readiness, runs serially, and preserves readiness receipts', () => {
  const workflow = readFileSync(resolve(root, '../../workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n')
  const runner = workflow.split('  runner-platforms:\n')[1]?.split('\n  desktop-windows:')[0]
  assert.ok(runner?.includes(`      - name: Compile Windows runner tests before native host readiness
        if: runner.os == 'Windows'
        run: cargo test --locked -p crony-runner --no-run
      - name: Verify Windows PowerShell connection ACL readiness
        if: runner.os == 'Windows'
        shell: pwsh
        run: ./tools/windows_connection_acl_readiness.ps1 -ReportDirectory (Join-Path $env:GITHUB_WORKSPACE 'output/runner-platform-windows-readiness')
      - run: cargo test --locked -p crony-runner \${{ runner.os == 'Windows' && '-- --test-threads=1' || '' }}
`), 'Windows compilation and ACL readiness must precede single-thread test execution')
  assert.match(runner, /      - name: Preserve Windows connection ACL readiness receipts\n        if: always\(\) && runner\.os == 'Windows'\n        uses: actions\/upload-artifact@[a-f0-9]{40}[^\n]*\n        with:\n          name: runner-platform-windows-readiness-\$\{\{ github\.run_attempt \}\}\n          path: output\/runner-platform-windows-readiness\/\n          if-no-files-found: warn\n          retention-days: 14\n/)
  assert.ok(statSync(resolve(root, '../../../tools/windows_connection_acl_readiness.ps1')).isFile())
})
