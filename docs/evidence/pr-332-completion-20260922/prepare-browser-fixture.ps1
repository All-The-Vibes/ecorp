# Reconstructed reproduction helper, September 22, 2026.
# Based on the retained preparation script; not a historical command transcript.
param(
    [Parameter(Mandatory)][string]$Product,
    [Parameter(Mandatory)][string]$Qa,
    [Parameter(Mandatory)][string]$SetupPath,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$ExpectedHead = 'd920cf70a6205ad5e91a1f102eda06de41df1bcc'
)
$ErrorActionPreference = 'Stop'
foreach ($directory in @($Product, $Qa, $OutputDirectory)) {
    if (![IO.Path]::IsPathFullyQualified($directory) -or !(Test-Path -LiteralPath $directory -PathType Container)) {
        throw 'Use existing absolute paths for the new owned reproduction.'
    }
}
$targetReceipt = Join-Path $OutputDirectory 'pr-332.integrated.fixture-preparation.json'
if (Test-Path -LiteralPath $targetReceipt) { throw 'Fixture preparation receipt already exists.' }
Import-Module (Join-Path $product 'tools\local_stack.psm1') -Force
$state = Read-LocalStackState -Path (Join-Path $qa 'ownership.json') -Workspace $qa
if (!$state -or !$state.test_owned -or $state.purpose -ne 'pr265-run-activity' -or $state.plan.product_commit -ne $expectedHead) { throw 'Owned fixture identity differs.' }
if ((& git -C $product rev-parse HEAD) -ne $expectedHead) { throw 'Product revision changed.' }
$source = Join-Path $qa 'source'
$originalSource = $state.source.base_commit
$setup = Get-Content -LiteralPath $setupPath -Raw | ConvertFrom-Json -AsHashtable
if ($setup.fixture_inputs_prepared -or $setup.source_commit -ne $originalSource -or $setup.reviewed_product_head -ne $expectedHead) { throw 'Setup receipt differs.' }
if ((& git -C $source rev-parse HEAD) -ne $originalSource -or (& git -C $source status --porcelain=v1)) { throw 'Original synthetic source changed.' }
$snapshot = Invoke-RestMethod "$($state.plan.server)/api/corps/$($state.demo.corp_id)/snapshot?actor_id=$($state.demo.alice_actor_id)"
$active = @($snapshot.snapshot.runs | Where-Object { $_.status -notin @('completed','failed','cancelled') })
if ($active.Count) { throw 'A run is active; preserve it.' }
$state | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'pr-332.integrated.fixture-ownership.before-preparation.json') -Encoding utf8
if (!(Test-LocalOwnedProcess -Record $state.processes.runner -Workspace $qa)) { throw 'Runner identity is not owned.' }
if (!(Stop-LocalOwnedProcess -Record $state.processes.runner -Workspace $qa)) { throw 'Owned runner did not stop.' }
$command = @'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
assert.equal(await readFile('verify.txt', 'utf8'), 'VERIFIED\n')
assert.deepEqual(JSON.parse(await readFile('schema.json', 'utf8')), { status: 'ok', count: 1 })
'@
$test = @'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
test('the deterministic agent created the verification file', async () => {
  assert.equal(await readFile('verify.txt', 'utf8'), 'VERIFIED\n')
})
test('the deterministic agent created the expected structured output', async () => {
  assert.deepEqual(JSON.parse(await readFile('schema.json', 'utf8')), { status: 'ok', count: 1 })
})
'@
foreach ($entry in @(@('check.mjs',$command), @('fixture.test.mjs',$test))) {
  $file = Join-Path $source $entry[0]
  if (Test-Path -LiteralPath $file) { throw 'Source fixture input already exists.' }
  [IO.File]::WriteAllText($file, $entry[1] + "`n")
  & node --check $file
  if ($LASTEXITCODE) { throw 'Fixture syntax failed.' }
}
& git -C $source add -- check.mjs fixture.test.mjs
if ($LASTEXITCODE) { throw 'Could not stage owned synthetic inputs.' }
& git -C $source -c user.name='ECorp QA' -c user.email='qa@ecorp.invalid' commit -m 'Prepare verification policy acceptance inputs'
if ($LASTEXITCODE) { throw 'Could not commit owned synthetic inputs.' }
$newSource = (& git -C $source rev-parse HEAD).Trim()
if (& git -C $source status --porcelain=v1) { throw 'Synthetic source is not clean.' }
$serverPort = ([uri]$state.plan.server).Port
$runnerEnvironment = @{
  CRONY_SERVER_WS="ws://127.0.0.1:$serverPort/ws/runner"; CRONY_RUNNER_ID=$state.plan.runner_id
  CRONY_CORP_ID=$state.demo.corp_id; CRONY_RUNNER_CREDENTIAL_FILE=(Join-Path $qa 'credential.json')
  CRONY_RUNNER_WORKSPACE=(Join-Path $qa 'runner'); CRONY_SOURCE_REPOSITORY=$source; CRONY_SOURCE_BASE_REF='HEAD'
  CRONY_FAKE_AGENT_SCRIPT=(Join-Path $product 'scripts\fake-agent.mjs')
  CRONY_CODEX_COMMAND=(Join-Path $qa 'disabled-codex.exe'); CRONY_CLAUDE_COMMAND=(Join-Path $qa 'disabled-claude.exe')
  CRONY_OPENCODE_COMMAND=(Join-Path $qa 'disabled-opencode.exe'); CRONY_COPILOT_FIXTURE='true'
  CRONY_COPILOT_USE_LOGGED_IN_USER='false'; CRONY_CONNECTIONS_DIRECTORY=(Join-Path $qa 'connections')
  CRONY_GITHUB_COMMAND=(Join-Path $qa 'disabled-github.exe'); ECORP_FACTORY_WATCH='0'
}
$state.processes.runner = Start-LocalOwnedProcess -Role 'runner-fixture-prepared' -Workspace $qa -FilePath (Join-Path $product 'target\debug\crony-runner.exe') -ArgumentList @() -WorkingDirectory $product -LogDirectory (Join-Path $qa 'logs') -Environment $runnerEnvironment
$state.source.base_commit = $newSource
$state.fixture_prepared_at = [DateTimeOffset]::UtcNow.ToString('o')
Save-LocalStackState -Path (Join-Path $qa 'ownership.json') -State $state -Workspace $qa
$setup | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'pr-332.integrated.browser-setup.before-preparation.json') -Encoding utf8
$setup.source_commit = $newSource
$setup.processes = $state.processes
$setup.fixture_inputs_prepared = $true
$setup | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath $setupPath -Encoding utf8
$receipt = [ordered]@{
  recorded_at_utc=[DateTimeOffset]::UtcNow.ToString('o'); qa_root=$qa; product_head=$expectedHead
  original_source_commit=$originalSource; prepared_source_commit=$newSource
  files=@('check.mjs','fixture.test.mjs'); reason='Prepare the command and test programs required by the unchanged browser acceptance driver.'
  runner_restarted=$true; product_source_changed=$false; database_reset=$false
  new_runner=$state.processes.runner
}
$receipt | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $targetReceipt -Encoding utf8
$receipt | ConvertTo-Json -Depth 8

