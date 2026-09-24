import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const fixtureScript = path.join(root, 'tools', 'ci_external_adapters_windows.ps1')
const native = { skip: process.platform !== 'win32', timeout: 90_000 }

test('Windows external-adapter fixture rejects manual PostgreSQL port before creating state', native, () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'ecorp-fixture-contract-'))
  try {
    for (const option of ['-ServerPort', '-PostgresPort']) {
      const fixture = path.join(parent, `ecorp-external-adapters-${option.slice(1)}`)
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', fixtureScript,
        '-FixtureRoot', fixture, '-PgBin', path.dirname(process.execPath), option, '5432', '-DryRun'],
      { windowsHide: true, encoding: 'utf8', timeout: 30_000 })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Refusing shared\/manual stack ports/u)
      assert.equal(existsSync(fixture), false)
    }
  } finally {
    assert.equal(path.dirname(realpathSync(parent)), realpathSync(os.tmpdir()))
    assert.match(path.basename(parent), /^ecorp-fixture-contract-[a-zA-Z0-9]+$/u)
    rmSync(parent, { recursive: true })
  }
})

test('Windows bounded fixture command retains both streams after terminating its timed-out child', native, t => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ecorp-fixture-timeout-'))
  // Load only the actual command function from its AST. No full-stack driver,
  // database initialization, listeners, provider calls or service cleanup runs.
  const script = `
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $env:ECORP_TEST_REPO 'tools/local_stack.psm1') -Force -DisableNameChecking
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $env:ECORP_TEST_REPO 'tools/ci_external_adapters_windows.ps1'),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'Fixture parser failed.' }
$command=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-FixtureCommand'},$false)
if (!$command) { throw 'Fixture command missing.' }
. ([scriptblock]::Create($command.Extent.Text))
$fixture=$env:ECORP_TEST_FIXTURE
$evidence=$fixture
$childEnv=@{}
$caught=$false
try {
  Invoke-FixtureCommand -Role 'timeout' -Program $env:ECORP_TEST_NODE -Arguments @('-e',"process.stdout.write('OUT-before-timeout');process.stderr.write('ERR-before-timeout');setInterval(()=>{},1000)") -TimeoutSeconds 2
} catch {
  if ($_.Exception.Message -notmatch 'exceeded its bounded deadline') { throw }
  $caught=$true
}
if (!$caught) { throw 'The fixture did not report its timeout.' }
'timeout captured'
`
  try {
    const result = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', timeout: 45_000,
      env: { ...process.env, ECORP_TEST_REPO: root, ECORP_TEST_FIXTURE: fixture, ECORP_TEST_NODE: process.execPath },
    })
    assert.match(result, /timeout captured/u)
    assert.equal(readFileSync(path.join(fixture, 'timeout.stdout.log'), 'utf8'), 'OUT-before-timeout')
    assert.equal(readFileSync(path.join(fixture, 'timeout.stderr.log'), 'utf8'), 'ERR-before-timeout')
  } finally {
    t.diagnostic('Retained bounded-command timeout evidence ' + fixture)
  }
})
