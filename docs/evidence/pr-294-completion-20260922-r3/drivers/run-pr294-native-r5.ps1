#requires -Version 7.4
# Both raw validation and the published tested_staged_tree schema are supported.
# Rebuild current native source and replay the real cache-policy browser lane.
param(
  [ValidateSet(294)][int]$Number = 294,
  [Parameter(Mandatory)][ValidatePattern('^r[0-9]+$')][string]$Revision,
  [Parameter(Mandatory)][string]$ValidationDirectory,
  [Parameter(Mandatory)][string]$Repository,
  [Parameter(Mandatory)][string]$QaRoot,
  [Parameter(Mandatory)][string]$PostgresBin,
  [Parameter(Mandatory)][string]$CargoTargetDirectory,
  [Parameter(Mandatory)][string]$NodeDirectory,
  [Parameter(Mandatory)][string]$PlaywrightModule,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [int]$ServerPort = 59014,
  [int]$WebPort = 26294,
  [int]$DatabasePort = 25294
)
$ErrorActionPreference = 'Stop'
$product = (Resolve-Path -LiteralPath $Repository).Path
$qa = [IO.Path]::GetFullPath($QaRoot)
$pg = (Resolve-Path -LiteralPath $PostgresBin).Path
$target = [IO.Path]::GetFullPath($CargoTargetDirectory)
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$browserScript = Join-Path $PSScriptRoot 'qa-pr294-cache-browser-r5.mjs'
$prefix = "pr$Number-native-$Revision"
$lifecyclePath = Join-Path $OutputDirectory "$prefix-lifecycle.json"
$validationPath = Join-Path $ValidationDirectory 'validation.json'
$validation = Get-Content -LiteralPath $validationPath -Raw | ConvertFrom-Json
$tree = (& git -C $product write-tree).Trim()
$validationTree = if ($validation.staged_tree) { $validation.staged_tree } else { $validation.tested_staged_tree }
$expectedChecks = @('migrations','documentation','rust-format','rust-clippy','rust-workspace','node-unit','steward','web-build','web-lint')
if ($validation.status -ne 'passed' -or !$validationTree -or @($validation.checks).Count -ne 9 -or
    @($validation.checks | Where-Object exit_code -ne 0).Count -or
    (Compare-Object @($validation.checks.name | Sort-Object) @($expectedChecks | Sort-Object)) -or
    (& git -C $product diff --name-only)) { throw 'Source must match all nine passing validation gates.' }
if ($validationTree -cne $tree) {
    $packet = [IO.Path]::GetRelativePath($product, (Resolve-Path -LiteralPath $ValidationDirectory).Path).Replace('\','/')
    if ($packet -notmatch '^docs/evidence/pr-294-[a-z0-9-]+$') { throw 'Different source tree without the exact published evidence packet.' }
    $driverPacket = [IO.Path]::GetRelativePath($product, (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path).Replace('\','/')
    if ($driverPacket -cne 'docs/evidence/pr-294-completion-20260922-r3') { throw 'Use the retained replacement driver packet.' }
    $delta = @(& git -C $product diff --name-only $validationTree $tree -- . ":(exclude)$packet/**" ":(exclude)$driverPacket/**")
    if ($LASTEXITCODE -or $delta.Count) { throw 'Product source changed since the published validation.' }
}
if ((Test-Path -LiteralPath $qa) -or (Test-Path -LiteralPath $lifecyclePath)) { throw 'Preserve existing fixture and receipts.' }
foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
  if ($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS')) {
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
  }
}
$env:PATH = (Resolve-Path -LiteralPath $NodeDirectory).Path + ';' + $pg + ';' + $env:PATH
$receipt = [ordered]@{pr=$Number;validation_source_tree=$validationTree;validation_receipt_sha256=(Get-FileHash -LiteralPath $validationPath).Hash.ToLowerInvariant();tested_staged_tree=$tree;source_head=(& git -C $product rev-parse HEAD).Trim();qa_root=$qa;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');status='running';cleanup='pending';checks=@()}
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
$supervisor = Join-Path $PSScriptRoot 'qa-pr294-stack-r5.ps1'
foreach ($dependency in @($supervisor,$browserScript)) { if (!(Test-Path -LiteralPath $dependency -PathType Leaf)) { throw 'Retained driver dependency is missing.' } }
try {
  Set-Location -LiteralPath $product
  $env:CARGO_TARGET_DIR = $target
  $env:CARGO_BUILD_JOBS = '2'
  $env:RUST_TEST_THREADS = '1'
  With-Cargo {
    $refreshLog = Join-Path $OutputDirectory "$prefix-workspace-cache-refresh.log"
    & cargo clean --workspace --target-dir $target *> $refreshLog
    Record-Check 'workspace-cache-refresh' $refreshLog $LASTEXITCODE
    $log = Join-Path $OutputDirectory "$prefix-build.log"
    $buildArgs=@('build','--locked','-p','crony-server','-p','crony-runner','--bins')
    & cargo @buildArgs *> $log
    Record-Check 'native-build' $log $LASTEXITCODE
    $native = Join-Path $product 'target/debug'
    New-Item -ItemType Directory -Path $native -Force | Out-Null
    $receipt.binaries = @()
    $receipt.preserved_binaries = @()
    $binaryNames=@('crony-server.exe','crony-runner.exe')
    foreach ($name in $binaryNames) {
      $destination = Join-Path $native $name
      if (Test-Path -LiteralPath $destination) {
        $backup = Join-Path $OutputDirectory "$prefix-prior-binaries"
        if (!(Test-Path -LiteralPath $backup)) { New-Item -ItemType Directory -Path $backup | Out-Null }
        $saved = Join-Path $backup $name
        if (Test-Path -LiteralPath $saved) { throw 'Preserve previous binary backup.' }
        $receipt.preserved_binaries += @{file=$name;sha256=(Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant()}
        Move-Item -LiteralPath $destination -Destination $saved
      }
      Copy-Item -LiteralPath (Join-Path $target "debug/$name") -Destination $destination
      $receipt.binaries += @{file=$name;sha256=(Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant()}
    }
  }
  Save-Receipt
  & $supervisor -Repository $product -Phase Start -QaRoot $qa -PostgresBin $pg -ServerPort $serverPort -WebPort $webPort -DatabasePort $databasePort *> (Join-Path $OutputDirectory "$prefix-stack-start.log")
  & $supervisor -Repository $product -Phase Status -QaRoot $qa -PostgresBin $pg *> (Join-Path $OutputDirectory "$prefix-stack-status.log")
  $state = Get-Content -LiteralPath (Join-Path $qa 'ownership.json') -Raw | ConvertFrom-Json -AsHashtable
  if ($Number -eq 294) {
    # SQLx provisions its own test databases on this new, owned maintenance server.
    $databasePassword = [IO.File]::ReadAllText((Join-Path $qa 'credentials/postgres-password.txt'))
    if ($databasePassword -notmatch '^[a-f0-9]{64}$') { throw 'Invalid owned database credential format.' }
    $env:DATABASE_URL = "postgres://pr265_qa:${databasePassword}@127.0.0.1:$databasePort/postgres"
    With-Cargo {
      $refreshLog = Join-Path $OutputDirectory "$prefix-sqlx-workspace-cache-refresh.log"
      & cargo clean --workspace --target-dir $target *> $refreshLog
      Record-Check 'sqlx-workspace-cache-refresh' $refreshLog $LASTEXITCODE
      foreach ($package in @('crony-server')) {
        $log = Join-Path $OutputDirectory "$prefix-sqlx-$package.log"
        & cargo test --locked -p $package issue140_ -- --ignored --test-threads=1 2>&1 | ForEach-Object { ([string]$_).Replace($databasePassword,'[ephemeral database credential]') } | Set-Content -LiteralPath $log -Encoding utf8
        Record-Check "owned-postgresql-$package-regressions" $log $LASTEXITCODE
      }
    }
    Remove-Item -LiteralPath Env:DATABASE_URL
    $databasePassword = $null
  }
  $env:PGPASSFILE=Join-Path $qa 'credentials/pgpass.conf'
  $env:ECORP_COMPLETION_QA_ROOT=$qa
  $env:ECORP_COMPLETION_PRODUCT=$product
  $env:ECORP_COMPLETION_PR=[string]$Number
  $env:ECORP_COMPLETION_PSQL=Join-Path $pg 'psql.exe'
  $env:CRONY_PLAYWRIGHT_MODULE=$PlaywrightModule
  # The browser lane is mandatory; there is no skip switch.
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
  & git -C $fixtureSource -c user.name='ECorp QA' -c user.email='qa@ecorp.invalid' commit -m 'Prepare deterministic verification policy input' *> (Join-Path $OutputDirectory "$prefix-fixture-input.log")
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
  $setupPath = Join-Path $OutputDirectory "$prefix-browser-setup.json"
  [IO.File]::WriteAllText($setupPath,($setup|ConvertTo-Json -Depth 50),[Text.UTF8Encoding]::new($false))
  & $supervisor -Repository $product -Phase Status -QaRoot $qa -PostgresBin $pg *> (Join-Path $OutputDirectory "$prefix-prepared-stack-status.log")
  $env:ECORP_POLICY_TEST='1'
  $env:ECORP_POLICY_SETUP=$setupPath
  Remove-Item -LiteralPath Env:PGPASSFILE -ErrorAction SilentlyContinue
  $env:CRONY_BROWSER_CHANNEL='msedge'
  $log = Join-Path $OutputDirectory "$prefix-browser.log"
  & node $browserScript *> $log
  Record-Check 'browser-server-runner-policy-acceptance' $log $LASTEXITCODE
  if ((& git -C $product write-tree).Trim() -cne $tree -or (& git -C $product diff --name-only)) { throw 'Source changed during native acceptance.' }
  $receipt.source_unchanged=$true
  $receipt.status='passed'
} catch {
  $receipt.status='failed'
  $receipt.failure=[regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')
} finally {
  if (Test-Path -LiteralPath (Join-Path $qa 'ownership.json')) {
    try {
      & $supervisor -Repository $product -Phase Stop -QaRoot $qa -PostgresBin $pg *> (Join-Path $OutputDirectory "$prefix-stack-stop.log")
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
