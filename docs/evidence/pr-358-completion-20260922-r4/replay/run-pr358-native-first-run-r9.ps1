#requires -Version 7.4
# Both raw validation and the published tested_staged_tree schema are supported.
# This PR always runs focused aggregate acceptance AND the real browser lane.
param(
  [ValidateSet(358)][int]$Number = 358,
  [Parameter(Mandatory)][ValidatePattern('^r[0-9]+$')][string]$Revision,
  [Parameter(Mandatory)][string]$ValidationDirectory,
  [Parameter(Mandatory)][string]$Repository,
  [Parameter(Mandatory)][string]$QaRoot,
  [Parameter(Mandatory)][string]$PostgresBin,
  [Parameter(Mandatory)][string]$CargoTargetDirectory,
  [Parameter(Mandatory)][string]$NodeDirectory,
  [Parameter(Mandatory)][string]$PlaywrightModule,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [int]$ServerPort = 59018,
  [int]$WebPort = 26358,
  [int]$DatabasePort = 25358
)
$ErrorActionPreference = 'Stop'
$product = (Resolve-Path -LiteralPath $Repository).Path
$qa = [IO.Path]::GetFullPath($QaRoot)
if (![IO.Path]::IsPathFullyQualified($QaRoot) -or
    (Split-Path -Leaf $qa) -notmatch '^pr265-run-activity-pr358-[0-9]{8}-r[0-9]+$' -or
    (Split-Path -Leaf (Split-Path -Parent $qa)) -ne 'qa' -or
    $qa.StartsWith($product, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use a dedicated absolute qa/pr265-run-activity-pr358-YYYYMMDD-rN directory outside the product.'
}
$pg = (Resolve-Path -LiteralPath $PostgresBin).Path
$target = [IO.Path]::GetFullPath($CargoTargetDirectory)
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$FocusedScript = Join-Path $PSScriptRoot 'qa-pr358-aggregate-r4.ps1'
$prefix = "pr$Number-native-$Revision"
$lifecyclePath = Join-Path $OutputDirectory "$prefix-lifecycle.json"
$validationPath = Join-Path $ValidationDirectory 'validation.json'
$validation = Get-Content -LiteralPath $validationPath -Raw | ConvertFrom-Json
$validationTree = if ($validation.staged_tree) { $validation.staged_tree } else { $validation.tested_staged_tree }
$expectedChecks = @('migrations','documentation','rust-format','rust-clippy','rust-workspace','node-unit','steward','web-build','web-lint')
# Even write-tree and diff can refresh index metadata. Run every source check
# against a private copy so success and rejection preserve the caller's bytes.
$hadPriorIndex = Test-Path -LiteralPath Env:GIT_INDEX_FILE
$priorIndex = [Environment]::GetEnvironmentVariable('GIT_INDEX_FILE', 'Process')
$sourceIndex = (& git -C $product rev-parse --path-format=absolute --git-path index).Trim()
if ($LASTEXITCODE -or !(Test-Path -LiteralPath $sourceIndex -PathType Leaf)) { throw 'Cannot locate the source index.' }
$projectionRoot = Join-Path ([IO.Path]::GetTempPath()) ("ecorp-pr358-projection-" + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $projectionRoot
$projectionIndex = Join-Path $projectionRoot 'index'
try {
    Copy-Item -LiteralPath $sourceIndex -Destination $projectionIndex
    [Environment]::SetEnvironmentVariable('GIT_INDEX_FILE', $projectionIndex, 'Process')
    $tree = (& git -C $product write-tree).Trim()
    if ($LASTEXITCODE) { throw 'Cannot read the source index tree.' }
    $unstaged = @(& git -C $product diff --name-only)
    if ($LASTEXITCODE) { throw 'Cannot inspect source differences.' }
    if ($validation.status -ne 'passed' -or !$validationTree -or @($validation.checks).Count -ne 9 -or
        @($validation.checks | Where-Object exit_code -ne 0).Count -or
        (Compare-Object @($validation.checks.name | Sort-Object) @($expectedChecks | Sort-Object)) -or
        $unstaged.Count) { throw 'Source must match all nine passing validation gates.' }
    if ($validationTree -cne $tree) {
        $packet = [IO.Path]::GetRelativePath($product, (Resolve-Path -LiteralPath $ValidationDirectory).Path).Replace('\','/')
        if ($packet -notmatch '^docs/evidence/pr-358-[a-z0-9-]+$') { throw 'Different source tree without the exact published evidence packet.' }
        # Reconstruct the tested projection from reachable published source;
        # the recorded pre-evidence tree need not exist in this object store.
        & git -C $product rm -r --cached --ignore-unmatch --quiet -- $packet
        if ($LASTEXITCODE) { throw 'Published source projection removal failed.' }
        $projectedTree = (& git -C $product write-tree).Trim()
        if ($LASTEXITCODE -or $projectedTree -cne $validationTree) { throw 'Product source changed since the published validation.' }
    }
} finally {
    if ($hadPriorIndex) {
        [Environment]::SetEnvironmentVariable('GIT_INDEX_FILE', $priorIndex, 'Process')
    } else {
        Remove-Item -LiteralPath Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    }
    foreach ($ownedFile in @($projectionIndex, "$projectionIndex.lock")) {
        if (Test-Path -LiteralPath $ownedFile) { Remove-Item -LiteralPath $ownedFile }
    }
    Remove-Item -LiteralPath $projectionRoot
}
if ((Test-Path -LiteralPath $qa) -or (Test-Path -LiteralPath $lifecyclePath)) { throw 'Preserve existing fixture and receipts.' }
foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
  if ($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS')) {
    Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
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
$supervisor = Join-Path $PSScriptRoot 'qa-pr358-stack-r4.ps1'
foreach ($dependency in @($supervisor,$FocusedScript)) { if (!(Test-Path -LiteralPath $dependency -PathType Leaf)) { throw 'Retained driver dependency is missing.' } }
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
    $binaryNames=@('crony-server.exe','crony-runner.exe')
    foreach ($name in $binaryNames) {
      $destination = Join-Path $native $name
      if (Test-Path -LiteralPath $destination) { throw 'Preserve a prior binary and use its verified build receipt instead.' }
      Copy-Item -LiteralPath (Join-Path $target "debug/$name") -Destination $destination
      $receipt.binaries += @{file=$name;sha256=(Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant()}
    }
  }
  Save-Receipt
  & $supervisor -Repository $product -Phase Start -QaRoot $qa -PostgresBin $pg -ServerPort $serverPort -WebPort $webPort -DatabasePort $databasePort *> (Join-Path $OutputDirectory "$prefix-stack-start.log")
  & $supervisor -Repository $product -Phase Status -QaRoot $qa -PostgresBin $pg *> (Join-Path $OutputDirectory "$prefix-stack-status.log")
  $state = Get-Content -LiteralPath (Join-Path $qa 'ownership.json') -Raw | ConvertFrom-Json -AsHashtable
  if ($Number -eq 358) {
    # SQLx provisions its own test databases on this new, owned maintenance server.
    $databasePassword = [IO.File]::ReadAllText((Join-Path $qa 'credentials/postgres-password.txt'))
    if ($databasePassword -notmatch '^[a-f0-9]{64}$') { throw 'Invalid owned database credential format.' }
    $env:DATABASE_URL = "postgres://pr265_qa:${databasePassword}@127.0.0.1:$databasePort/postgres"
    With-Cargo {
      $refreshLog = Join-Path $OutputDirectory "$prefix-sqlx-workspace-cache-refresh.log"
      & cargo clean --workspace --target-dir $target *> $refreshLog
      Record-Check 'sqlx-workspace-cache-refresh' $refreshLog $LASTEXITCODE
      $suites = @(
        @{package='crony-store';filter='retained_receipts::';name='retained-receipts';expected=15},
        @{package='crony-store';filter='issue56_';name='crony-store';expected=31},
        @{package='crony-server';filter='issue56_';name='crony-server';expected=2}
      )
      foreach ($suite in $suites) {
        $log = Join-Path $OutputDirectory "$prefix-sqlx-$($suite.name).log"
        & cargo test -p $suite.package $suite.filter -- --ignored --test-threads=1 2>&1 | ForEach-Object { ([string]$_).Replace($databasePassword,'[ephemeral database credential]') } | Set-Content -LiteralPath $log -Encoding utf8
        Record-Check "owned-postgresql-$($suite.name)-regressions" $log $LASTEXITCODE
        if ((Get-Content -LiteralPath $log -Raw) -notmatch "test result: ok\. $($suite.expected) passed; 0 failed;") {
          throw "The $($suite.name) suite did not execute all $($suite.expected) expected PostgreSQL regressions."
        }
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
  if ($FocusedScript) {
    $log = Join-Path $OutputDirectory "$prefix-focused.log"
    if ([IO.Path]::GetExtension($FocusedScript) -eq '.ps1') {
      & pwsh -NoProfile -File $FocusedScript *> $log
    } else {
      & node $FocusedScript *> $log
    }
    Record-Check 'focused-native-acceptance' $log $LASTEXITCODE
  }
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
  # Await authoritative registration and exact source, not merely a live process.
  $readyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
  $readyRunner = $null
  do {
    $observed = Invoke-RestMethod "$($state.plan.server)/api/corps/$($state.demo.corp_id)/snapshot?actor_id=$($state.demo.alice_actor_id)"
    $candidates = @($observed.runners | Where-Object { $_.id -ceq $state.plan.runner_id -and $_.connected -and $_.status -ceq 'connected' })
    if ($candidates.Count -eq 1) {
      $nativeCap = @($candidates[0].capabilities | Where-Object { $_.name -ceq 'fake-process' -and $_.available -and !$_.workspace_connection_id })
      $sourceCap = @($candidates[0].capabilities | Where-Object { $_.name -ceq 'workspace-isolation' -and $_.available -and $_.source_repository -ceq $state.source.repository -and $_.source_base_commit -ceq $state.source.base_commit -and !$_.workspace_connection_id })
      if ($nativeCap.Count -and $sourceCap.Count) { $readyRunner = $candidates[0]; break }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTimeOffset]::UtcNow -lt $readyDeadline)
  if (!$readyRunner) { throw 'The exact new native runner did not become selectable before approval acceptance.' }
  @{status='passed';runner=$readyRunner;source_commit=$state.source.base_commit;observed_at_utc=[DateTimeOffset]::UtcNow.ToString('o')} |
    ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $qa 'evidence/approval-runner-readiness.json') -Encoding utf8
  # Supplying the exact immutable source forces plan_mission through select_runner,
  # which checks the in-memory dispatch_ready flag after reconciliation.
  # This endpoint is read-only; do not retry an effectful mission launch.
  $previewRequest = @{
    requested_by=$state.demo.alice_actor_id;title='Observe owned runner dispatch readiness'
    preferred_adapter='fake-process';strategy='single'
    source=@{repository=$state.source.repository;base_ref='HEAD';base_commit=$state.source.base_commit}
  }
  $previewBody = $previewRequest | ConvertTo-Json -Depth 12
  $previewPath = "$($state.plan.server)/api/corps/$($state.demo.corp_id)/missions/preview"
  $dispatchDeadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
  $previewAttempts = @()
  $previewReady = $false
  do {
    $response = Invoke-WebRequest -Uri $previewPath -Method Post -ContentType 'application/json' -Body $previewBody -SkipHttpErrorCheck
    $payload = $response.Content | ConvertFrom-Json
    $previewAttempts += @{status=[int]$response.StatusCode;payload=$payload;at_utc=[DateTimeOffset]::UtcNow.ToString('o')}
    if ($response.StatusCode -eq 200) {
      if (@($payload.tasks).Count -ne 1) { throw 'Unexpected preview plan.' }
      $previewReady = $true
      break
    }
    if ($response.StatusCode -ne 400 -or $payload.error -cne 'no connected runner can staff the selected mission runtime, model, and source') {
      throw 'Unexpected failure while observing read-only dispatch readiness.'
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTimeOffset]::UtcNow -lt $dispatchDeadline)
  @{status=$(if($previewReady){'passed'}else{'failed'});request=$previewRequest;attempts=$previewAttempts;read_only=$true} |
    ConvertTo-Json -Depth 24 | Set-Content -LiteralPath (Join-Path $qa 'evidence/approval-dispatch-readiness.json') -Encoding utf8
  if (!$previewReady) { throw 'Owned runner failed actual dispatch readiness before acceptance.' }
  # The owned fake-agent runner now supports the actual approval E2E protocol.
  # This regression resets only this newly created, verified fixture database.
  $approvalReport = Join-Path $product 'output/e2e-approvals.json'
  if (Test-Path -LiteralPath $approvalReport) { throw 'Preserve earlier approval E2E output before this run.' }
  $env:CRONY_SERVER_HTTP=$state.plan.server
  $env:CRONY_SKIP_SERVER_RESTART='1'
  Remove-Item -LiteralPath Env:PGPASSFILE -ErrorAction SilentlyContinue
  $log = Join-Path $OutputDirectory "$prefix-approval-expiry.log"
  & node (Join-Path $product 'tools/e2e_approvals.mjs') *> $log
  Record-Check 'native-approval-decision-rejection-expiry' $log $LASTEXITCODE
  Copy-Item -LiteralPath $approvalReport -Destination (Join-Path $qa 'evidence/approval-e2e.json')
  Remove-Item -LiteralPath Env:CRONY_SERVER_HTTP,Env:CRONY_SKIP_SERVER_RESTART
  $env:ECORP_POLICY_TEST='1'
  $env:ECORP_POLICY_SETUP=$setupPath
  Remove-Item -LiteralPath Env:PGPASSFILE -ErrorAction SilentlyContinue
  $env:CRONY_BROWSER_CHANNEL='msedge'
  $log = Join-Path $OutputDirectory "$prefix-browser.log"
  & node (Join-Path $product 'tools/e2e_verification_policy_browser.mjs') *> $log
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
