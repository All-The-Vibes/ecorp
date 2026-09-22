# Fresh owned acceptance of PR353's real Windows entry points.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$product = $env:ECORP_COMPLETION_PRODUCT
$qa = $env:ECORP_COMPLETION_QA_ROOT
if ($env:ECORP_COMPLETION_PR -ne '353' -or
    $product -ne '<reviewed-worktree>' -or
    (Split-Path -Leaf $qa) -notmatch '^pr265-run-activity-pr353-20260922-r[0-9]+$') { throw 'Unexpected acceptance scope.' }
Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force -DisableNameChecking
$qaState = Read-LocalStackState -Path (Join-Path $qa 'ownership.json') -Workspace $qa
if (!$qaState.test_owned -or $qaState.purpose -ne 'pr265-run-activity') { throw 'Exact fresh fixture required.' }
$start = Join-Path $product 'tools/start_local.ps1'
$stop = Join-Path $product 'tools/stop_local.ps1'
$stateFile = Join-Path $product 'output/local-pids.json'
$credential = Join-Path $product 'output/runner/credential.json'
$evidence = Join-Path $qa 'evidence/startup'
if ((Test-Path -LiteralPath $stateFile) -or (Test-Path -LiteralPath $credential) -or (Test-Path -LiteralPath $evidence)) {
    throw 'Preserve previous startup state and credentials.'
}
New-Item -ItemType Directory -Path $evidence | Out-Null
$report = [ordered]@{schema_version=1;scenario='actual Windows startup and recovery';new_run=$true;status='running';
    product=$product;source_head=(& git -C $product rev-parse HEAD).Trim();tested_staged_tree=(& git -C $product write-tree).Trim();
    started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');checks=@();cleanup='pending';
    provider='native deterministic fake-process, no provider calls';initial_provisioning='new owned QA database and enrollment; no production identity'}
function Save-Report { $report | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding utf8 }
function Hash-Text([string]$Value) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant() }
function Check([string]$Name,[bool]$Pass,$Details) {
    $report.checks += [ordered]@{name=$Name;passed=$Pass;details=$Details}
    Save-Report
    if (!$Pass) { throw "Acceptance failed: $Name" }
    Write-Output "PASS $Name"
}
function Git-Read([string[]]$Arguments) {
    $result = & git --no-optional-locks -C (Join-Path $qa 'source') @Arguments
    if ($LASTEXITCODE) { throw 'Synthetic source read failed.' }
    @($result) -join "`n"
}
function Source-Snapshot {
    [ordered]@{head=(Git-Read @('rev-parse','HEAD'));refs=(Git-Read @('show-ref'));
        status=(Git-Read @('status','--porcelain=v1','--untracked-files=all'));
        index_sha256=(Get-FileHash -LiteralPath (Join-Path $qa 'source/.git/index')).Hash.ToLowerInvariant()}
}
function Files-Snapshot {
    $rows = @()
    foreach ($root in @((Join-Path $product 'output'),(Join-Path $qa 'runner'),(Join-Path $qa 'connections'))) {
        if (!(Test-Path -LiteralPath $root)) { $rows += "absent:$root"; continue }
        foreach ($item in @((Get-Item -LiteralPath $root)) + @(Get-ChildItem -LiteralPath $root -Force -Recurse | Sort-Object FullName)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected redirected fixture file.' }
            $row = [ordered]@{path=$item.FullName;directory=$item.PSIsContainer;acl=(Get-Acl -LiteralPath $item.FullName).Sddl}
            if (!$item.PSIsContainer) { $row.sha256=(Get-FileHash -LiteralPath $item.FullName).Hash.ToLowerInvariant();$row.length=$item.Length }
            $rows += ($row | ConvertTo-Json -Compress)
        }
    }
    Hash-Text ($rows -join "`n")
}
function Database-Snapshot {
    $query = @'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object('sha256', encode(sha256(convert_to(coalesce(string_agg(
  schemaname || '.' || tablename || ':' || encode(sha256(convert_to(query_to_xml(
    format('SELECT row_to_json(t)::text AS row FROM %I.%I AS t ORDER BY row_to_json(t)::text', schemaname, tablename),
    true, true, '')::text, 'UTF8')), 'hex'), E'\n' ORDER BY schemaname, tablename), ''), 'UTF8')), 'hex'),
  'tables', count(*)) FROM pg_tables WHERE schemaname = 'public';
COMMIT;
'@
    & (Get-Module local_stack) { param($Connection,$Sql) Invoke-LocalDatabaseRead -DatabaseUrl $Connection -Query $Sql } $env:DATABASE_URL $query
}
function Stable-Snapshot {
    [ordered]@{database=Database-Snapshot;files_sha256=Files-Snapshot;source=Source-Snapshot;
        credential_sha256=(Get-FileHash -LiteralPath $credential).Hash.ToLowerInvariant()}
}
function Enrollment-Snapshot {
    Assert-LocalRunnerIdentity -RunnerId $env:CRONY_RUNNER_ID
    $runner = $env:CRONY_RUNNER_ID.Replace("'", "''")
    $corp = [guid]$env:CRONY_CORP_ID
    $query = @"
BEGIN READ ONLY;
SELECT json_build_object('id', id, 'runner_id', runner_id, 'corp_id', corp_id,
  'enrolled_by', enrolled_by, 'enrollment_count',
  (SELECT count(*) FROM runner_enrollment_tokens WHERE runner_id='$runner' AND corp_id='$corp'::uuid))
FROM runner_credentials WHERE runner_id='$runner' AND corp_id='$corp'::uuid;
ROLLBACK;
"@
    & (Get-Module local_stack) { param($Connection,$Sql) Invoke-LocalDatabaseRead -DatabaseUrl $Connection -Query $Sql } $env:DATABASE_URL $query
}
function Fingerprint($Value) { Hash-Text ($Value | ConvertTo-Json -Depth 40 -Compress) }
function Live-Identities {
    $current = Read-LocalStackState -Path $stateFile -Workspace $product
    $identities = [ordered]@{}
    foreach ($role in @('server','runner','web')) {
        $record = $current.processes[$role]
        if (!(Test-LocalOwnedProcess -Record $record -Workspace $product)) { throw "Missing actual-startup $role identity." }
        $identities[$role] = [ordered]@{pid=$record.pid;started_utc=$record.started_utc;executable=$record.executable}
    }
    $identities
}
function Invoke-Entry([string]$Name,[switch]$Preflight,[switch]$Restart) {
    $entryLog = Join-Path $evidence "$Name.log"
    if (Test-Path -LiteralPath $entryLog) { throw 'Preserve command evidence.' }
    $result = & $start -SkipInstall -SkipBuild -SkipFactoryController -Preflight:$Preflight -Restart:$Restart *>&1
    $result | Out-String -Width 240 | Set-Content -LiteralPath $entryLog -Encoding utf8
    if ($Preflight) {
        $ready = @($result | Where-Object { $_.PSObject.Properties['read_only'] -and $_.read_only })
        if ($ready.Count -ne 1 -or $ready[0].status -ne 'ready') { throw 'Actual preflight did not report read-only readiness.' }
    }
}
function Refusal([string]$Name,[scriptblock]$Action,[string]$Pattern) {
    $caught = $null
    try { & $Action } catch { $caught = $_ }
    $message = if ($caught) { $caught.Exception.Message } else { 'Unexpected success' }
    $message | Set-Content -LiteralPath (Join-Path $evidence "$Name-refusal.log") -Encoding utf8
    Check $Name ($null -ne $caught -and $message -match $Pattern) @{expected=$Pattern;message=$message}
}
Save-Report
try {
    foreach ($role in @('web','runner','server')) {
        if (!(Test-LocalOwnedProcess -Record $qaState.processes[$role] -Workspace $qa) -or
            !(Stop-LocalOwnedProcess -Record $qaState.processes[$role] -Workspace $qa)) { throw "Owned provisioning $role stop failed." }
    }
    Check 'only provisioning application processes stopped' (Test-LocalOwnedProcess -Record $qaState.processes.postgres -Workspace $qa) @{}
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
    if (Test-Path -LiteralPath (Join-Path $fixtureSource 'fixture.test.mjs')) { throw 'Preserve earlier fixture input.' }
    [IO.File]::WriteAllText((Join-Path $fixtureSource 'fixture.test.mjs'),$fixtureTest+"`n",[Text.UTF8Encoding]::new($false))
    & git -C $fixtureSource add -- fixture.test.mjs
    if ($LASTEXITCODE) { throw 'Fixture staging failed.' }
    & git -C $fixtureSource -c user.name='ECorp QA' -c user.email='qa@ecorp.invalid' commit -m 'Prepare deterministic startup acceptance inputs'
    if ($LASTEXITCODE) { throw 'Fixture input commit failed.' }
    $commit=(Git-Read @('rev-parse','HEAD')).Trim()
    New-Item -ItemType Directory -Path (Split-Path -Parent $credential) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $qa 'credential.json') -Destination $credential
    $configuration=@{
        DATABASE_URL="postgres://pr265_qa@127.0.0.1:$($qaState.plan.database.port)/pr265_activity";
        CRONY_CORP_ID=$qaState.demo.corp_id;CRONY_ACTOR_ID=$qaState.demo.alice_actor_id;CRONY_RUNNER_ID=$qaState.plan.runner_id;
        CRONY_SOURCE_REPOSITORY=$fixtureSource;CRONY_SOURCE_BASE_REF=$commit;CRONY_RUNNER_WORKSPACE=(Join-Path $qa 'runner');
        CRONY_COPILOT_HOME=(Join-Path $qa 'copilot-home');CRONY_CONNECTIONS_DIRECTORY=(Join-Path $qa 'connections');
        CRONY_SERVER_PORT=([uri]$qaState.plan.server).Port;CRONY_WEB_PORT=([uri]$qaState.plan.web).Port;
        CARGO_TARGET_DIR=(Join-Path $product 'target');ECORP_FACTORY_WATCH='0';CRONY_MODE='development';
        CRONY_CODEX_COMMAND=(Join-Path $qa 'disabled-codex.exe');CRONY_CLAUDE_COMMAND=(Join-Path $qa 'disabled-claude.exe');
        CRONY_OPENCODE_COMMAND=(Join-Path $qa 'disabled-opencode.exe');CRONY_GITHUB_COMMAND=(Join-Path $qa 'disabled-github.exe');
        CRONY_COPILOT_FIXTURE='true';CRONY_COPILOT_USE_LOGGED_IN_USER='false';CRONY_OBJECT_STORE_LOCAL_ROOT=(Join-Path $qa 'objects-startup');
        CRONY_SECRET_MASTER_KEY_HEX=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32));
        CRONY_ARTIFACT_SIGNING_KEY_HEX=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    }
    foreach($name in $configuration.Keys){[Environment]::SetEnvironmentVariable($name,[string]$configuration[$name],'Process')}
    $configuration=$null
    $before=Stable-Snapshot
    $enrollmentBefore=Enrollment-Snapshot
    Invoke-Entry 'preflight-valid' -Preflight
    Check 'preflight preserves database files ACLs source and credential' ((Fingerprint $before) -ceq (Fingerprint (Stable-Snapshot))) $before
    $savedActor=$env:CRONY_ACTOR_ID
    try {
        $env:CRONY_ACTOR_ID='not-an-actor'
        Refusal 'preflight-invalid-actor' {Invoke-Entry 'preflight-invalid-actor' -Preflight} 'existing CRONY_ACTOR_ID'
    } finally {$env:CRONY_ACTOR_ID=$savedActor}
    $savedRef=$env:CRONY_SOURCE_BASE_REF
    try {
        $env:CRONY_SOURCE_BASE_REF='refs/heads/does-not-exist-startup-qa'
        Refusal 'preflight-missing-source-ref' {Invoke-Entry 'preflight-missing-source-ref' -Preflight} 'source|Git'
    } finally {$env:CRONY_SOURCE_BASE_REF=$savedRef}
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    try {
        $listener.Start();$savedPort=$env:CRONY_SERVER_PORT;$env:CRONY_SERVER_PORT=[string]$listener.LocalEndpoint.Port
        Refusal 'preflight-occupied-port' {Invoke-Entry 'preflight-occupied-port' -Preflight} 'occupied'
    } finally {$env:CRONY_SERVER_PORT=$savedPort;$listener.Stop()}
    Check 'rejected preflights preserve database files ACLs source and credential' ((Fingerprint $before) -ceq (Fingerprint (Stable-Snapshot))) @{}
    Invoke-Entry 'start-initial'
    $initial=Live-Identities
    Check 'actual startup owns ready server runner and web' $true $initial
    Invoke-Entry 'start-idempotent'
    Check 'second start retains all three process identities' ((Fingerprint $initial) -ceq (Fingerprint (Live-Identities))) @{}
    try {
        $env:CRONY_ACTOR_ID='not-an-actor'
        Refusal 'invalid-restart-retains-live-stack' {Invoke-Entry 'invalid-restart' -Restart} 'identity mismatch|existing CRONY_ACTOR_ID'
    } finally {$env:CRONY_ACTOR_ID=$savedActor}
    Check 'invalid restart preserves exact process identities' ((Fingerprint $initial) -ceq (Fingerprint (Live-Identities))) @{}
    $current=Read-LocalStackState -Path $stateFile -Workspace $product
    if (!(Stop-LocalOwnedProcess -Record $current.processes.web -Workspace $product)) {throw 'Owned missing-web injection failed.'}
    Invoke-Entry 'start-recover-missing-web'
    $recovered=Live-Identities
    Check 'start recovers only missing web' ((Fingerprint $initial.server) -ceq (Fingerprint $recovered.server) -and
        (Fingerprint $initial.runner) -ceq (Fingerprint $recovered.runner) -and
        (Fingerprint $initial.web) -cne (Fingerprint $recovered.web)) $recovered
    $current=Read-LocalStackState -Path $stateFile -Workspace $product
    $setup=@{test_owned=$true;qa_root=$qa;output=(Join-Path $qa 'evidence');server_url=$qaState.plan.server;web_url=$qaState.plan.web;
        source_repository=$qaState.source.repository;source_commit=$commit;source=$fixtureSource;workspace=(Join-Path $qa 'runner');
        runner_id=$qaState.plan.runner_id;processes=$current.processes;tested_staged_tree=$report.tested_staged_tree;fixture_inputs_prepared=$true}
    $setupPath=Join-Path $evidence 'browser-setup.json'
    [IO.File]::WriteAllText($setupPath,($setup|ConvertTo-Json -Depth 40),[Text.UTF8Encoding]::new($false))
    $env:ECORP_POLICY_TEST='1';$env:ECORP_POLICY_SETUP=$setupPath;$env:CRONY_BROWSER_CHANNEL='msedge'
    & node (Join-Path $product 'tools/e2e_verification_policy_browser.mjs') *> (Join-Path $evidence 'browser.log')
    Check 'actual-startup browser server runner policy acceptance' ($LASTEXITCODE -eq 0) @{log='browser.log';setup='browser-setup.json'}
    $afterSource = Source-Snapshot
    Check 'source checkout HEAD index and worktree remain unchanged' ($before.source.head -ceq $afterSource.head -and
        $before.source.index_sha256 -ceq $afterSource.index_sha256 -and $before.source.status -ceq $afterSource.status) @{before=$before.source;after=$afterSource}
    $beforeRefs = @($before.source.refs -split "`n" | Where-Object {$_})
    $afterRefs = @($afterSource.refs -split "`n" | Where-Object {$_})
    $snapshot = (Invoke-RestMethod "$($qaState.plan.server)/api/corps/$($qaState.demo.corp_id)/snapshot?actor_id=$($qaState.demo.alice_actor_id)").snapshot
    $allowedRefs = @($snapshot.runs | Where-Object {$_.runner_id -ceq $qaState.plan.runner_id} | ForEach-Object {
        "$($before.source.head) refs/heads/crony/task-$(([guid]$_.task_id).ToString('N'))/run-$(([guid]$_.id).ToString('N'))"
    })
    $addedRefs = @($afterRefs | Where-Object {$_ -cnotin $beforeRefs})
    Check 'original refs preserved and new refs belong to observed isolated runs' (@($beforeRefs | Where-Object {$_ -cnotin $afterRefs}).Count -eq 0 -and
        @($addedRefs | Where-Object {$_ -cnotin $allowedRefs}).Count -eq 0 -and $addedRefs.Count -ge 2) @{added_refs=$addedRefs;observed_run_refs=$allowedRefs}
    Assert-LocalDatabaseIdentity -DatabaseUrl $env:DATABASE_URL -CorpId $env:CRONY_CORP_ID -ActorId $env:CRONY_ACTOR_ID -RunnerId $env:CRONY_RUNNER_ID -CredentialPath $credential
    $enrollmentAfter=Enrollment-Snapshot
    Check 'rotated credential remains scoped to the original authorized enrollment' ((Fingerprint $enrollmentBefore) -ceq (Fingerprint $enrollmentAfter)) @{before=$enrollmentBefore;after=$enrollmentAfter;database_token_match=$true}
    $beforeRestart=Live-Identities
    Invoke-Entry 'restart-valid' -Restart
    $afterRestart=Live-Identities
    Check 'explicit restart replaces all three owned application processes' ((Fingerprint $beforeRestart.server) -cne (Fingerprint $afterRestart.server) -and
        (Fingerprint $beforeRestart.runner) -cne (Fingerprint $afterRestart.runner) -and
        (Fingerprint $beforeRestart.web) -cne (Fingerprint $afterRestart.web)) @{before=$beforeRestart;after=$afterRestart}
    Assert-LocalDatabaseIdentity -DatabaseUrl $env:DATABASE_URL -CorpId $env:CRONY_CORP_ID -ActorId $env:CRONY_ACTOR_ID -RunnerId $env:CRONY_RUNNER_ID -CredentialPath $credential
    Check 'restart retains enrollment and source state' ((Fingerprint $enrollmentBefore) -ceq (Fingerprint (Enrollment-Snapshot)) -and
        (Fingerprint $afterSource) -ceq (Fingerprint (Source-Snapshot))) @{}
    $report.status='passed'
} catch {
    $report.status='failed';$report.failure=[regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')
    Write-Output $report.failure
} finally {
    if (Test-Path -LiteralPath $stateFile) {
        try {
            & $stop *> (Join-Path $evidence 'stop-local.log')
            $final=Read-LocalStackState -Path $stateFile -Workspace $product
            $live=@($final.processes.Values | Where-Object {Test-LocalOwnedProcess -Record $_ -Workspace $product})
            if ($live.Count) {throw 'Actual startup cleanup left owned application processes.'}
            if (!(Test-LocalOwnedProcess -Record $qaState.processes.postgres -Workspace $qa)) {throw 'Startup stop affected separately owned PostgreSQL.'}
            $report.cleanup='Actual stop_local.ps1 verified application shutdown; outer supervisor retains database and stops its owned PostgreSQL.'
        } catch {$report.status='failed';$report.cleanup='Unverified; preserve exact process receipts and logs.'}
    } else {$report.cleanup='No actual-startup ownership was published; outer supervisor handles only its owned fixture.'}
    $report.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Report
}
if ($report.status -ne 'passed') {exit 1}
