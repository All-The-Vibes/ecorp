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

test('entrypoint delegates repository validation to current source AGENTS', () => {
  const entrypoint = readFileSync(resolve(root, 'SKILL.md'), 'utf8')
  const prose = entrypoint.replace(/\s+/gu, ' ')
  assert.match(prose, /Run all current-source `AGENTS\.md` `ecorp:validation-commands` gates/u)
  assert.match(prose, /package tests replace none/u)
  const agents = readFileSync(resolve(root, '../../../AGENTS.md'), 'utf8')
  const block = /<!-- ecorp:validation-commands -->\r?\n```powershell\r?\n([^`]+)\r?\n```\r?\n<!-- \/ecorp:validation-commands -->/u.exec(agents)
  assert.ok(block, 'current source AGENTS must provide the canonical validation block')
  const commands = block[1].trim().split(/\r?\n/u)
  assert.deepEqual(commands, ['pnpm check'], 'delegate to the complete current validation plan')
  const pkg = JSON.parse(readFileSync(resolve(root, '../../../package.json'), 'utf8'))
  assert.equal(pkg.scripts.check, 'node tools/run_checks.mjs --group full')
  assert.equal(pkg.scripts['test:js'], 'node tools/run_checks.mjs --group node')
  for (const command of commands) {
    assert.ok(!entrypoint.split(/\r?\n/u).includes(command), `do not duplicate canonical command: ${command}`)
  }
})

test('entrypoint stays within pinned ATV AGENT-03 effective prose limit', (t) => {
  // Same measurement as the ATV-PUB-02 audit's support.mjs; do not count raw Markdown.
  const prose = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
    .replace(/```[\s\S]*?```/g, '').split('\n')
    .filter((line) => !line.trim().startsWith('|')).join('\n')
  assert.equal(prose('---\nname: example\n---\nKeep\n```sh\nignored\n```\n| ignored |\nEnd'), '\nKeep\n\nEnd')
  const count = prose(readFileSync(resolve(root, 'SKILL.md'), 'utf8')).length
  t.diagnostic(`ATV AGENT-03 effective prose: ${count}/8000 characters`)
  assert.ok(count <= 8000, `ATV AGENT-03: ${count} effective prose characters exceeds 8000`)
})

test('maintained instructions distinguish scoped publication from full acceptance', () => {
  for (const name of ['SKILL.md', 'references/executor.md', 'references/remediation.md']) {
    const text = readFileSync(resolve(root, name), 'utf8').replace(/\s+/gu, ' ')
    assert.match(text, /SAFE_TO_PUBLISH/u, name)
    assert.match(text, /two fresh independent/iu, name)
    assert.match(text, /full.PR/iu, name)
    assert.match(text, /NICE/u, name)
  }
  const entrypoint = readFileSync(resolve(root, 'SKILL.md'), 'utf8').replace(/\s+/gu, ' ')
  for (const reference of ['dependencies', 'template-selection', 'remediation', 'executor']) {
    assert.ok(entrypoint.includes(`](references/${reference}.md)`), `missing ${reference} routing`)
  }
  assert.match(entrypoint, /two fresh independent reviewers must examine the exact remote-head → candidate correction/u)
  assert.match(entrypoint, /unsafe or unverified changes may not be published/u)
  assert.match(entrypoint, /separate full-PR Santa pair before NICE; scoped publication reviews cannot substitute/u)
  assert.match(entrypoint, /Never claim an audit, subagent, test, model selection, or automatic trigger ran without a receipt/u)
  const executor = readFileSync(resolve(root, 'references/executor.md'), 'utf8').replace(/\s+/gu, ' ')
  assert.match(executor, /Publication reviews cannot be relabeled, reused, or promoted/u)
  assert.match(executor, /After activation, an update additionally needs retained ongoing owner authority/u)
  assert.match(executor, /must not interrupt a charged executable claim/u)
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
  assert.ok(runner, 'runner platform job must exist')
  const steps = runner.split('\n      - ')
  const named = name => steps.find(step => step.startsWith(`name: ${name}\n`))
  const compile = named('Compile Windows runner tests before native host readiness')
  const readiness = named('Verify Windows PowerShell connection ACL readiness')
  const serial = named('Run Windows runner tests serially')
  for (const step of [compile, readiness, serial]) {
    assert.equal(typeof step, 'string', 'required Windows runner step must exist')
    assert.match(step, /\n        if: runner\.os == 'Windows'\n/u)
  }
  assert.ok(steps.indexOf(compile) < steps.indexOf(readiness) && steps.indexOf(readiness) < steps.indexOf(serial),
    'Windows compilation and ACL readiness must precede single-thread test execution')
  assert.match(compile, /\n        run: cargo test --locked -p crony-runner --no-run(?:\n|$)/u)
  assert.match(readiness, /\n        shell: pwsh\n        run: \.\/tools\/windows_connection_acl_readiness\.ps1 -ReportDirectory \(Join-Path \$env:GITHUB_WORKSPACE 'output\/runner-platform-windows-readiness'\)(?:\n|$)/u)
  assert.match(serial, /\n        run: cargo test --locked -p crony-runner -- --test-threads=1(?:\n|$)/u)
  assert.match(named('Run Unix runner tests'), /\n        if: runner\.os != 'Windows'\n        run: cargo test --locked -p crony-runner(?:\n|$)/u)
  assert.match(runner, /      - name: Preserve Windows connection ACL readiness receipts\n        if: always\(\) && runner\.os == 'Windows'\n        uses: actions\/upload-artifact@[a-f0-9]{40}[^\n]*\n        with:\n          name: runner-platform-windows-readiness-\$\{\{ github\.run_attempt \}\}\n          path: output\/runner-platform-windows-readiness\/\n          if-no-files-found: warn\n          retention-days: 14\n/)
  assert.ok(statSync(resolve(root, '../../../tools/windows_connection_acl_readiness.ps1')).isFile())
})
