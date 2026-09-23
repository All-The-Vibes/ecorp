param(
  [Parameter(Mandatory)][ValidateSet(237)][int]$Number,
  [Parameter(Mandatory)][ValidatePattern('^r[0-9]+$')][string]$Revision,
  [Parameter(Mandatory)][string]$ValidationDirectory,
  [string]$FocusedScript = '',
  [switch]$FocusedCompletesBrowser
)
$ErrorActionPreference = 'Stop'
if ($FocusedCompletesBrowser -and ($Number -ne 353 -or [IO.Path]::GetExtension($FocusedScript) -ne '.ps1')) {
  throw 'The startup-specific driver must supply its own actual browser acceptance.'
}
$product = "<local-user>\code\ecorp-pr$Number-completion-20260922"
$qa = "<local-user>\code\qa\pr265-run-activity-pr$Number-20260922-$Revision"
$pg = '<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$target = '<local-user>\code\ecorp-pr-completion-20260922\target'
$prefix = "pr$Number-native-$Revision"
$lifecyclePath = Join-Path $PSScriptRoot "$prefix-lifecycle.json"
$validation = Get-Content -LiteralPath (Join-Path $ValidationDirectory 'validation.json') -Raw | ConvertFrom-Json
$tree = (& git -C $product write-tree).Trim()
if ($validation.status -ne 'passed' -or $validation.staged_tree -ne $tree -or (& git -C $product diff --name-only)) { throw 'Source must match passing validation.' }
if ((Test-Path -LiteralPath $qa) -or (Test-Path -LiteralPath $lifecyclePath)) { throw 'Preserve existing fixture and receipts.' }
foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
  if ($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS')) {
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
  }
}
$env:PATH = '<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64;' + $pg + ';' + $env:PATH
$receipt = [ordered]@{pr=$Number;tested_staged_tree=$tree;source_head=(& git -C $product rev-parse HEAD).Trim();qa_root=$qa;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');status='running';cleanup='pending';checks=@()}
function Save-Receipt { $receipt | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $lifecyclePath -Encoding utf8 }
function Record-Check([string]$Name,[string]$Log,[int]$Code) {
  $receipt.checks += @{name=$Name;exit_code=$Code;log=$Log;sha256=(Get-FileHash -LiteralPath $Log).Hash.ToLowerInvariant()}
  Save-Receipt
  Write-Output "$Name exit=$Code"
  if ($Code) { throw "$Name failed; preserve logs and fixture." }
}
$key = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($target).ToLowerInvariant())))
function With-Cargo([scriptblock]$Action) {
  $mutex = [Threading.Mutex]::new($false, "Local\ECorpCompletionCargo$key")
  $held = $false
  try {
    try { $held = $mutex.WaitOne() } catch [Threading.AbandonedMutexException] { $held=$true }
    & $Action
  } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
Save-Receipt
$supervisor = Join-Path $PSScriptRoot 'qa-pr237-stack-r4.ps1'
$serverPort = 29000 + $Number
$webPort = 26000 + $Number
$databasePort = 25000 + $Number
try {
  Set-Location -LiteralPath $product
  $env:CARGO_TARGET_DIR = $target
  $env:CARGO_BUILD_JOBS = '2'
  $env:RUST_TEST_THREADS = '1'
  With-Cargo {
    $refreshLog = Join-Path $PSScriptRoot "$prefix-workspace-cache-refresh.log"
    & cargo clean --workspace --target-dir $target *> $refreshLog
    Record-Check 'workspace-cache-refresh' $refreshLog $LASTEXITCODE
    $log = Join-Path $PSScriptRoot "$prefix-build.log"
    $buildArgs=@('build','--locked','-p','crony-server','-p','crony-runner','--bins')
    if ($Number -eq 237) {$buildArgs+=@('-p','crony-cli')}
    & cargo @buildArgs *> $log
    Record-Check 'native-build' $log $LASTEXITCODE
    $native = Join-Path $product 'target/debug'
    New-Item -ItemType Directory -Path $native -Force | Out-Null
    $receipt.binaries = @()
    $binaryNames=@('crony-server.exe','crony-runner.exe')
    if($Number -eq 237){$binaryNames+='crony-cli.exe'}
    foreach ($name in $binaryNames) {
      $destination = Join-Path $native $name
      if (Test-Path -LiteralPath $destination) { throw 'Preserve a prior binary and use its verified build receipt instead.' }
      Copy-Item -LiteralPath (Join-Path $target "debug/$name") -Destination $destination
      $receipt.binaries += @{file=$name;sha256=(Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant()}
    }
  }
  Save-Receipt
  & $supervisor -Phase Start -QaRoot $qa -PostgresBin $pg -ServerPort $serverPort -WebPort $webPort -DatabasePort $databasePort *> (Join-Path $PSScriptRoot "$prefix-stack-start.log")
  & $supervisor -Phase Status -QaRoot $qa -PostgresBin $pg *> (Join-Path $PSScriptRoot "$prefix-stack-status.log")
  $state = Get-Content -LiteralPath (Join-Path $qa 'ownership.json') -Raw | ConvertFrom-Json -AsHashtable
  $env:PGPASSFILE=Join-Path $qa 'credentials/pgpass.conf'
  $env:ECORP_COMPLETION_QA_ROOT=$qa
  $env:ECORP_COMPLETION_PRODUCT=$product
  $env:ECORP_COMPLETION_PR=[string]$Number
  $env:ECORP_COMPLETION_PSQL=Join-Path $pg 'psql.exe'
  $env:CRONY_PLAYWRIGHT_MODULE='<local-user>\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
  if ($FocusedScript) {
    $log = Join-Path $PSScriptRoot "$prefix-focused.log"
    if ([IO.Path]::GetExtension($FocusedScript) -eq '.ps1') {
      & pwsh -NoProfile -File $FocusedScript *> $log
    } else {
      & node $FocusedScript *> $log
    }
    Record-Check 'focused-native-acceptance' $log $LASTEXITCODE
  }
  if (!$FocusedCompletesBrowser) {
  # Prepare only new deterministic verifier programs in this fixture's source.
  Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force -DisableNameChecking
  $snapshot = Invoke-RestMethod "$($state.plan.server)/api/corps/$($state.demo.corp_id)/snapshot?actor_id=$($state.demo.alice_actor_id)"
  if (@($snapshot.snapshot.runs | Where-Object {$_.status -notin @('completed','failed','cancelled')}).Count) { throw 'Preserve active runs before verifier fixture preparation.' }
  if (!(Test-LocalOwnedProcess -Record $state.processes.runner -Workspace $qa) -or !(Stop-LocalOwnedProcess -Record $state.processes.runner -Workspace $qa)) { throw 'Owned runner stop failed.' }
  $fixtureSource = Join-Path $qa 'source'
  $fixtureTest = @'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
test('deterministic verifier inputs', async () => {
  assert.equal(await readFile('verify.txt', 'utf8'), 'VERIFIED\n')
  assert.deepEqual(JSON.parse(await readFile('schema.json', 'utf8')), { status: 'ok', count: 1 })
})
'@
  $testPath = Join-Path $fixtureSource 'fixture.test.mjs'
  if (Test-Path -LiteralPath $testPath) { throw 'Preserve previous verifier input.' }
  [IO.File]::WriteAllText($testPath,$fixtureTest+"`n",[Text.UTF8Encoding]::new($false))
  & git -C $fixtureSource add -- fixture.test.mjs
  if ($LASTEXITCODE) { throw 'Fixture input staging failed.' }
  & git -C $fixtureSource -c user.name='ECorp QA' -c user.email='qa@ecorp.invalid' commit -m 'Prepare deterministic verification policy input' *> (Join-Path $PSScriptRoot "$prefix-fixture-input.log")
  if ($LASTEXITCODE) { throw 'Fixture input commit failed.' }
  $state.source.base_commit=(& git -C $fixtureSource rev-parse HEAD).Trim()
  $runnerEnvironment = @{
    CRONY_SERVER_WS="ws://127.0.0.1:$serverPort/ws/runner";CRONY_RUNNER_ID=$state.plan.runner_id
    CRONY_CORP_ID=$state.demo.corp_id;CRONY_RUNNER_CREDENTIAL_FILE=(Join-Path $qa 'credential.json')
    CRONY_RUNNER_WORKSPACE=(Join-Path $qa 'runner');CRONY_SOURCE_REPOSITORY=$fixtureSource;CRONY_SOURCE_BASE_REF='HEAD'
    CRONY_FAKE_AGENT_SCRIPT=(Join-Path $product 'scripts/fake-agent.mjs')
    CRONY_CODEX_COMMAND=(Join-Path $qa 'disabled-codex.exe');CRONY_CLAUDE_COMMAND=(Join-Path $qa 'disabled-claude.exe')
    CRONY_OPENCODE_COMMAND=(Join-Path $qa 'disabled-opencode.exe');CRONY_COPILOT_FIXTURE='true';CRONY_COPILOT_USE_LOGGED_IN_USER='false'
    CRONY_CONNECTIONS_DIRECTORY=(Join-Path $qa 'connections');CRONY_GITHUB_COMMAND=(Join-Path $qa 'disabled-github.exe');ECORP_FACTORY_WATCH='0'
  }
  $state.processes.runner = Start-LocalOwnedProcess -Role 'runner-verifier-fixture' -Workspace $qa -FilePath (Join-Path $product 'target/debug/crony-runner.exe') -ArgumentList @() -WorkingDirectory $product -LogDirectory (Join-Path $qa 'logs') -Environment $runnerEnvironment
  Save-LocalStackState -Path (Join-Path $qa 'ownership.json') -State $state -Workspace $qa
  $setup = @{test_owned=$true;qa_root=$qa;output=(Join-Path $qa 'evidence');server_url=$state.plan.server;web_url=$state.plan.web
    source_repository=$state.source.repository;source_commit=$state.source.base_commit;source=$fixtureSource;workspace=(Join-Path $qa 'runner')
    runner_id=$state.plan.runner_id;processes=$state.processes;tested_staged_tree=$tree;fixture_inputs_prepared=$true}
  $setupPath = Join-Path $PSScriptRoot "$prefix-browser-setup.json"
  [IO.File]::WriteAllText($setupPath,($setup|ConvertTo-Json -Depth 50),[Text.UTF8Encoding]::new($false))
  & $supervisor -Phase Status -QaRoot $qa -PostgresBin $pg *> (Join-Path $PSScriptRoot "$prefix-prepared-stack-status.log")
  $env:ECORP_POLICY_TEST='1'
  $env:ECORP_POLICY_SETUP=$setupPath
  Remove-Item -LiteralPath Env:PGPASSFILE -ErrorAction SilentlyContinue
  $env:CRONY_BROWSER_CHANNEL='msedge'
  $log = Join-Path $PSScriptRoot "$prefix-browser.log"
  & node (Join-Path $product 'tools/e2e_verification_policy_browser.mjs') *> $log
  Record-Check 'browser-server-runner-policy-acceptance' $log $LASTEXITCODE
  }
  $receipt.status='passed'
} catch {
  $receipt.status='failed'
  $receipt.failure=[regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')
} finally {
  if (Test-Path -LiteralPath (Join-Path $qa 'ownership.json')) {
    try {
      & $supervisor -Phase Stop -QaRoot $qa -PostgresBin $pg *> (Join-Path $PSScriptRoot "$prefix-stack-stop.log")
      $receipt.cleanup='Only owned processes stopped; database, source, credentials, workspaces and logs retained.'
    } catch { $receipt.cleanup='Failed; inspect retained exact ownership records.';$receipt.status='failed' }
  }
  Remove-Item -LiteralPath Env:DATABASE_URL,Env:PGPASSFILE -ErrorAction SilentlyContinue
  $databasePassword=$null
  $receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
  Save-Receipt
}
$receipt | ConvertTo-Json -Depth 12
if ($receipt.status -ne 'passed') { exit 1 }
