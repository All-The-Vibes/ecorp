import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

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

test('Windows cold-start preflight is bounded and leaves native ACL enforcement unchanged', () => {
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
