import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

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
  assert.equal(uses.length, 26, 'retain every existing action step')
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
  assert.equal(rustSteps.length, 5, 'retain Rust setup in all five jobs')
  for (const [, inputs] of rustSteps) assert.match(inputs, /^        with:\n          toolchain: 1\.98\.1\n/u)
})

test('Windows runner tests are serialized without filtering tests or changing Unix scheduling', () => {
  const workflow = readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    .replace(/\r\n/gu, '\n')
  const matrix = workflow.split('  runner-platforms:')[1].split('  desktop-windows:')[0]
  assert.match(matrix, /os: \[ubuntu-latest, windows-latest, macos-latest\]/u)
  assert.match(matrix, /fail-fast: false/u)
  assert.match(matrix, /name: Run Windows runner tests serially\n\s+if: runner.os == 'Windows'\n\s+run: cargo test -p crony-runner -- --test-threads=1\n/u)
  assert.match(matrix, /name: Run Unix runner tests\n\s+if: runner.os != 'Windows'\n\s+run: cargo test -p crony-runner\n/u)
  assert.match(matrix, /run: node tools\/platform_runner_contract\.mjs/u)
  assert.doesNotMatch(matrix, /--skip|--ignored|--exclude|continue-on-error|RUST_TEST_THREADS/u)
  assert.equal((matrix.match(/--test-threads=1/gu) ?? []).length, 1)
})

test('Windows primary ACL path runs before explicit prewarming and the complete serial suite', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/gu, '\n')
  const matrix = workflow.split('  runner-platforms:')[1].split('  desktop-windows:')[0]
  const primaryName = '      - name: Test Windows primary ACL path before explicit prewarming\n'
  const warmName = '      - name: Warm Windows PowerShell before bounded native setup tests\n'
  const primaryIndex = matrix.indexOf(primaryName)
  const warmIndex = matrix.indexOf(warmName)
  assert.ok(primaryIndex >= 0, 'exercise PrivateRoot::open before paying the native ACL startup cost')
  assert.ok(primaryIndex < warmIndex, 'primary ACL regression must precede explicit prewarming')
  const primary = matrix.slice(primaryIndex + primaryName.length, warmIndex)
  const testName = 'windows_private_root_primary_path_enforces_acl'
  assert.equal(primary.trim(), [
    "if: runner.os == 'Windows'",
    `        run: cargo test --locked -p crony-runner connections::storage::tests::${testName} -- --exact --nocapture`,
  ].join('\n'))
  assert.doesNotMatch(matrix.slice(0, primaryIndex), /shell: powershell|DirectorySecurity|WindowsIdentity|windows_connection_acl_readiness|run:.*cargo test/u)
  const storage = readFileSync(path.join(root, 'crates', 'crony-runner', 'src', 'connection_setup', 'storage.rs'), 'utf8')
  assert.match(storage, new RegExp(`#\\[cfg\\(windows\\)\\]\\s+#\\[tokio::test\\]\\s+async fn ${testName}\\(\\)`, 'u'))
  const connections = readFileSync(path.join(root, 'crates', 'crony-runner', 'src', 'connections.rs'), 'utf8')
  assert.match(connections, /#\[path = "connection_setup\/storage.rs"\]\s+mod storage;/u)
  const main = readFileSync(path.join(root, 'crates', 'crony-runner', 'src', 'main.rs'), 'utf8')
  assert.match(main, /^mod connections;/mu)
})

test('Windows warm-up remains bounded and leaves native ACL enforcement unchanged', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/gu, '\n')
  const matrix = workflow.split('  runner-platforms:')[1].split('  desktop-windows:')[0]
  const preflight = matrix.split('      - name: Warm Windows PowerShell before bounded native setup tests\n')[1]
    ?.split('      - name: Run Windows runner tests serially\n')[0]
  assert.ok(preflight, 'warm the exact Windows PowerShell host before running the complete test binary')
  assert.ok(matrix.indexOf('name: Warm Windows PowerShell before bounded native setup tests') <
    matrix.indexOf('name: Run Windows runner tests serially'))
  assert.match(preflight, /if: runner.os == 'Windows'/u)
  assert.match(preflight, /timeout-minutes: 1\n\s+shell: powershell\n/u)
  assert.match(preflight, /\$ErrorActionPreference = 'Stop'/u)
  assert.match(preflight, /\[System.Security.AccessControl.DirectorySecurity\]::new\(\)/u)
  assert.match(preflight, /\[System.Security.Principal.WindowsIdentity\]::GetCurrent\(\).User/u)
  assert.match(preflight, /\$acl.SetAccessRuleProtection\(\$true, \$false\)/u)
  assert.doesNotMatch(preflight, /SetAccessControl|Set-Acl|icacls|Start-Process|continue-on-error/u)
  const storage = readFileSync(path.join(root, 'crates', 'crony-runner', 'src', 'connection_setup', 'storage.rs'), 'utf8')
  assert.match(storage, /Utc::now\(\) \+ chrono::Duration::seconds\(10\)/u)
  assert.match(storage, /\[System.IO.Directory\]::SetAccessControl\(\$env:ECORP_CONNECTION_ACL_TARGET,\$acl\)/u)
})
