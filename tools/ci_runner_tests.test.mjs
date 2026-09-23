import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

for (const [job, runner, stepName, suites] of [
  ['quality', 'ubuntu-latest', 'Test platform-specific CI fixture contracts',
    ['e2e_factory_budget_recovery', 'factory_budget_provenance']],
  ['external-adapters-windows', 'windows-latest', 'Verify Windows owned-server receipts and restart',
    ['ci_external_adapters_windows', 'e2e_predispatch_failure', 'factory_budget_provenance']],
]) {
  test(`${job} runs the recovery regressions on their supported platform without filtering`, () => {
    const workflow = readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
      .replace(/\r\n/gu, '\n')
    const section = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/u)[0]
    assert.ok(section, `missing existing ${job} job`)
    assert.ok(section.startsWith(`    runs-on: ${runner}\n`), 'use the actual supported runner, not a skipped foreign-platform suite')
    const step = section.split(`      - name: ${stepName}\n`)[1]?.split('\n      - ')[0]
    assert.ok(step, 'retain the existing Node test step')
    assert.doesNotMatch(step, /^\s+if:|continue-on-error|--test-(?:name|skip)-pattern|--test-only/mu)
    assert.equal(step.split('        run:')[0], "        env:\n          ECORP_OWNED_PROCESS_TEST: '1'\n",
      'retain process-only opt-in; do not enable a real-stack driver')
    const command = step.match(/^        run: node --test ([^\n]+)$/mu)?.[1]
    assert.ok(command, 'invoke the Node test runner, not the E2E service entrypoints')
    const selected = command.split(' ')
    for (const file of selected) assert.match(file, /^tools\/[\w.]+\.test\.mjs$/u)
    for (const suite of suites) {
      assert.equal(selected.filter(file => file === `tools/${suite}.test.mjs`).length, 1, suite)
    }
    if (job === 'quality') assert.ok(!selected.includes('tools/e2e_predispatch_failure.test.mjs'),
      'the native win32 regression must execute in Windows, not silently skip in Linux')
  })
}

test('CI remote actions use the accepted target immutable SHA pins', () => {
  const workflow = readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
  // Accepted main 39632b957819012721c90902925d8fa7a9c7e873; repository requires SHA pinning.
  const pins = {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'dtolnay/rust-toolchain': '6bed0761d98439e5a578e2877258200ad565ba87',
    'pnpm/action-setup': 'ea17c68df8912ef543352723c149a84f56e3d413',
    'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
    'Swatinem/rust-cache': '6323deb102c322ba6fcbdcafc7e3dddab59af2b6',
    'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
  }
  const uses = [...workflow.matchAll(/^[ \t]+(?:- )?uses: ([^\s#]+)/gmu)].map(match => match[1])
  for (const jobName of ['quality', 'integration', 'external-adapters-windows', 'runner-platforms', 'desktop-windows']) {
    const section = job(jobName)
    assert.match(section, /uses: actions\/checkout@/u, `${jobName} checks out reviewed source`)
    assert.match(section, /uses: Swatinem\/rust-cache@/u, `${jobName} retains its Rust cache`)
  }
  for (const artifact of ['validation-report', 'runner-platform-windows-readiness-', 'runner-platform-browser-policy-handoff-']) {
    assert.ok(workflow.includes(`name: ${artifact}`), `retain ${artifact} evidence upload`)
  }
  assert.deepEqual(uses, uses.map(ref => {
    const action = ref.split('@')[0]
    assert.ok(Object.hasOwn(pins, action), `unreviewed action: ${action}`)
    return `${action}@${pins[action]}`
  }))
})

test('every pinned Rust action explicitly retains toolchain 1.98.1', () => {
  const workflow = readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    .replace(/\r\n/gu, '\n')
  const rustSteps = [...workflow.matchAll(/^      - uses: dtolnay\/rust-toolchain@[^\n]+\n((?: {8,}[^\n]*\n)*)/gmu)]
  for (const jobName of ['quality', 'integration', 'external-adapters-windows', 'runner-platforms', 'desktop-windows']) {
    assert.match(job(jobName), /uses: dtolnay\/rust-toolchain@/u, `${jobName} retains Rust setup`)
  }
  assert.ok(rustSteps.length >= 5)
  for (const [, inputs] of rustSteps) assert.match(inputs, /^        with:\n          toolchain: 1\.98\.1\n/u)
})

test('Windows runner tests are serialized without filtering tests or changing Unix scheduling', () => {
  const workflow = readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    .replace(/\r\n/gu, '\n')
  const matrix = workflow.split('  runner-platforms:')[1].split('  desktop-windows:')[0]
  assert.match(matrix, /os: \[ubuntu-latest, windows-latest, macos-latest\]/u)
  assert.match(matrix, /fail-fast: false/u)
  assert.match(matrix, /name: Run Windows runner tests serially\n\s+if: runner.os == 'Windows'\n\s+run: cargo test --locked -p crony-runner -- --test-threads=1\n/u)
  assert.match(matrix, /name: Run Unix runner tests\n\s+if: runner.os != 'Windows'\n\s+run: cargo test --locked -p crony-runner\n/u)
  assert.match(matrix, /run: node tools\/platform_runner_contract\.mjs/u)
  assert.doesNotMatch(matrix, /--skip|--ignored|--exclude|continue-on-error|RUST_TEST_THREADS/u)
  assert.equal((matrix.match(/--test-threads=1/gu) ?? []).length, 1)
})

test('Windows primary ACL path runs before explicit readiness and the complete serial suite', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/gu, '\n')
  const matrix = workflow.split('  runner-platforms:')[1].split('  desktop-windows:')[0]
  const primaryName = '      - name: Test Windows primary ACL path before explicit readiness\n'
  const warmName = '      - name: Verify Windows PowerShell connection ACL readiness\n'
  const primaryIndex = matrix.indexOf(primaryName)
  const warmIndex = matrix.indexOf(warmName)
  assert.ok(primaryIndex >= 0, 'exercise PrivateRoot::open before paying the native ACL startup cost')
  assert.ok(primaryIndex < warmIndex, 'primary ACL regression must precede explicit readiness')
  const primary = matrix.slice(primaryIndex + primaryName.length, warmIndex)
  const testName = 'windows_private_root_primary_path_enforces_acl'
  assert.equal(primary.trim(), [
    "if: runner.os == 'Windows'",
    `        run: cargo test --locked -p crony-runner connections::storage::tests::${testName} -- --exact --nocapture`,
  ].join('\n'))
  const before = matrix.slice(0, primaryIndex)
  assert.doesNotMatch(before, /shell: powershell|DirectorySecurity|WindowsIdentity|windows_connection_acl_readiness/u)
  for (const command of before.matchAll(/run: (cargo test[^\n]*)/gu)) {
    assert.match(command[1], / --no-run(?: |$)/u, 'only compilation may precede the primary native ACL test')
  }
  const storage = readFileSync(path.join(root, 'crates', 'crony-runner', 'src', 'connection_setup', 'storage.rs'), 'utf8')
  assert.match(storage, new RegExp(`#\\[cfg\\(windows\\)\\]\\s+#\\[tokio::test\\]\\s+async fn ${testName}\\(\\)`, 'u'))
  const connections = readFileSync(path.join(root, 'crates', 'crony-runner', 'src', 'connections.rs'), 'utf8')
  assert.match(connections, /#\[path = "connection_setup\/storage.rs"\]\s+mod storage;/u)
  const main = readFileSync(path.join(root, 'crates', 'crony-runner', 'src', 'main.rs'), 'utf8')
  assert.match(main, /^mod connections;/mu)
})

test('Windows readiness uses the native bounded probe and leaves runner ACL enforcement unchanged', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/gu, '\n')
  const matrix = workflow.split('  runner-platforms:')[1].split('  desktop-windows:')[0]
  const preflight = matrix.split('      - name: Verify Windows PowerShell connection ACL readiness\n')[1]
    ?.split('      - name: Run Windows runner tests serially\n')[0]
  assert.ok(preflight, 'verify the exact Windows PowerShell host before running the complete test binary')
  assert.ok(matrix.indexOf('name: Verify Windows PowerShell connection ACL readiness') <
    matrix.indexOf('name: Run Windows runner tests serially'))
  assert.match(preflight, /if: runner.os == 'Windows'/u)
  assert.match(preflight, /tools\/windows_connection_acl_readiness\.ps1/u)
  assert.doesNotMatch(preflight, /continue-on-error/u)
  const probe = readFileSync(path.join(root, 'tools', 'windows_connection_acl_readiness.ps1'), 'utf8')
  assert.match(probe, /System32\/WindowsPowerShell\/v1\.0\/powershell\.exe/u)
  assert.match(probe, /WaitForExit\(60000\)/u)
  assert.match(probe, /ecorp-acl-readiness-.*Guid/u)
  assert.match(probe, /\[System.IO.Directory\]::SetAccessControl\(\$env:ECORP_CONNECTION_ACL_TARGET,\$acl\)/u)
  assert.match(probe, /finally \{/u)
  const storage = readFileSync(path.join(root, 'crates', 'crony-runner', 'src', 'connection_setup', 'storage.rs'), 'utf8')
  assert.match(storage, /Utc::now\(\) \+ chrono::Duration::seconds\(10\)/u)
  assert.match(storage, /\[System.IO.Directory\]::SetAccessControl\(\$env:ECORP_CONNECTION_ACL_TARGET,\$acl\)/u)
})

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const job = name => {
  const body = workflow.split(new RegExp(`^  ${name}:\\r?\\n`, 'm'))[1]?.split(/^  [\w-]+:/m)[0]
  assert.ok(body, `missing ${name} job`)
  return body
}

test('quality selects existing contracts and PR255 pure frontend/QA regressions', () => {
  const quality = job('quality')
  const commands = [...quality.matchAll(/^        run: node --test (.+)$/gm)]
    .flatMap(match => match[1].trim().split(/\s+/))
  for (const file of [
    'tools/e2e_external_adapters.test.mjs',
    'tools/fixture_source_identity.test.mjs',
    'tools/owned_test_stack.test.mjs',
    'apps/web/src/factoryAuthority.test.mjs',
    'apps/web/src/factoryAuthorityConnection.test.mjs',
    'apps/web/src/snapshotRefresh.test.mjs',
    'tools/issue161/qa-api-provenance.test.mjs',
    'tools/ci_runner_tests.test.mjs',
  ]) assert.ok(commands.includes(file), `${file} must run in quality`)
})

test('quality provisions the exact QA source before the provenance test, outside test code', () => {
  const quality = job('quality')
  const fetch = quality.indexOf('run: git fetch --no-tags origin b31a38a62330aacba80c3953142e1da957a63ecd')
  assert.ok(fetch >= 0, 'shallow checkout needs an explicit native fetch of the pinned QA commit')
  assert.ok(fetch < quality.indexOf('tools/issue161/qa-api-provenance.test.mjs'))
  const source = readFileSync(new URL('./issue161/qa-api-provenance.test.mjs', import.meta.url), 'utf8')
  assert.match(source, /const baseCommit = 'b31a38a62330aacba80c3953142e1da957a63ecd'/)
  assert.match(source, /\['show', `\$\{baseCommit\}:\$\{helper\}`\]/)
  assert.doesNotMatch(source, /['"]fetch['"]/)
})

test('identity regression runs only in the existing Windows matrix lane before lifecycle checks', () => {
  const lane = job('runner-platforms')
  assert.match(lane, /os: \[ubuntu-latest, windows-latest, macos-latest\]/)
  assert.match(lane, /if: runner\.os == 'Windows'\r?\n        shell: pwsh\r?\n        run: \.\/tools\/local_stack_identity\.test\.ps1/)
  for (const name of ['Run Windows runner tests serially', 'Run Unix runner tests']) {
    const position = lane.indexOf(`      - name: ${name}`)
    assert.ok(position >= 0, 'both supported native runner suites must execute')
    assert.ok(lane.indexOf('./tools/local_stack_identity.test.ps1') < position)
  }
  assert.equal(workflow.match(/run: \.\/tools\/local_stack_identity\.test\.ps1/g)?.length, 1)
})

test('remote actions use immutable SHAs under the repository Actions policy', () => {
  const actions = [...workflow.matchAll(/^\s+(?:- )?uses: (\S+)/gm)]
  assert.ok(actions.length > 0)
  for (const [, action] of actions) assert.match(action, /^[\w./-]+@[a-f0-9]{40}$/)
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m)
})
