#requires -Version 7.5
<# Fresh owned Issue48 native/browser fixture. Never resets or adopts a fixture.
Reuses the product's process ownership helper. Stop preserves all files and data. #>
[CmdletBinding()]
param(
    [ValidateSet('DryRun','Start','Status','Stop')][string]$Phase = 'DryRun',
    [Parameter(Mandatory)][string]$QaRoot,
    [ValidateSet('fake-and-copilot','fake-only')][string]$ProviderMode = 'fake-and-copilot',
    [ValidatePattern('^r[0-9]+$')][string]$ValidationRevision = 'r2',
    [string]$PostgresBin = '<USERPROFILE>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$product = '<USERPROFILE>\.codex\worktrees\issue48-retirement\ecorp'
$expected = '878a1774774b0630c904cbaf4b05e1b346777817'
$qa = [IO.Path]::GetFullPath($QaRoot).TrimEnd('\')
$qaParent = '<USERPROFILE>\code\qa'
if (![IO.Path]::IsPathFullyQualified($QaRoot) -or
    (Split-Path -Leaf $qa) -notmatch '^issue48-native-20260929-r[0-9]+$' -or
    !(Split-Path -Parent $qa).Equals($qaParent,[StringComparison]::OrdinalIgnoreCase) -or
    (Get-Item -LiteralPath $qaParent).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
    throw 'Use a new literal code/qa/issue48-native-20260929-rN directory.'
}
$pg = (Resolve-Path -LiteralPath $PostgresBin).Path
Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force
$recordPath = Join-Path $qa 'ownership.json'
if ($Phase -in @('Status','Stop')) {
    $state = Read-LocalStackState -Path $recordPath -Workspace $qa
    if (!$state -or $state.purpose -cne 'issue48-native-acceptance' -or !$state.test_owned) {
        throw 'Missing exact Issue48 fixture ownership.'
    }
    if ($Phase -eq 'Status') {
        foreach ($role in @('postgres','server','runner','web')) {
            if (!(Test-LocalOwnedProcess -Record $state.processes[$role] -Workspace $qa)) {
                throw "Exact $role identity is absent or changed."
            }
        }
        foreach ($entry in @(@('server',59031),@('web',59032),@('postgres',59030))) {
            $owners = @(Get-NetTCPConnection -State Listen -LocalPort $entry[1] | Select-Object -ExpandProperty OwningProcess -Unique)
            if ($owners.Count -ne 1 -or $owners[0] -ne $state.processes[$entry[0]].pid) {
                throw 'Listener ownership changed; preserve all processes.'
            }
        }
        [ordered]@{status='ready';qa=$qa;source=$state.source;ready_at=$state.ready_at} | ConvertTo-Json -Depth 5
        return
    }
    $stopped = @()
    foreach ($role in @('web','runner','server')) {
        if (Test-LocalOwnedProcess -Record $state.processes[$role] -Workspace $qa) {
            if (!(Stop-LocalOwnedProcess -Record $state.processes[$role] -Workspace $qa)) {
                throw "Could not verify stop of $role; preserve fixture."
            }
            $stopped += $role
        }
    }
    if (Test-LocalOwnedProcess -Record $state.processes.postgres -Workspace $qa) {
        & (Join-Path $pg 'pg_ctl.exe') -D (Join-Path $qa 'database') -m fast -w stop
        if ($LASTEXITCODE) { throw 'Owned PostgreSQL shutdown failed.' }
        $stopped += 'postgres'
    }
    $state.stopped_at = [DateTime]::UtcNow.ToString('o')
    $state.stopped_roles = $stopped
    Save-LocalStackState -Path $recordPath -State $state -Workspace $qa
    Write-Output 'Only verified owned processes stopped; fixture, worktrees and evidence retained.'
    return
}
if (Test-Path -LiteralPath $qa) { throw 'Occupied fixture: preserve it and use a new revision.' }
foreach ($port in @(59030,59031,59032)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Required fixture port $port is occupied. No process was touched."
    }
}
$node = '<USERPROFILE>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe'
$serverExe = Join-Path $product 'target/debug/crony-server.exe'
$runnerExe = Join-Path $product 'target/debug/crony-runner.exe'
$vite = Join-Path $product 'apps/web/node_modules/vite/bin/vite.js'
$validationPath = Join-Path $PSScriptRoot "issue48-canonical-bound-$ValidationRevision.json"
$plan = [ordered]@{
    phase=$Phase;product=$product;expected_head=$expected;qa_root=$qa
    server='http://127.0.0.1:59031';web='http://127.0.0.1:59032'
    database=@{host='127.0.0.1';port=59030;user='issue48';name='issue48_app_r1';fresh=$true}
    runner_id='runner-issue48-42269426';provider_mode=$ProviderMode
    provider=$(if ($ProviderMode -eq 'fake-only') { 'Native deterministic fake-process only; other providers explicitly unavailable' } else { 'Native deterministic fake-process and Copilot fixture; no vendor inference' })
    source='Fresh independent synthetic Git repository with committed seed.txt'
    factory_watcher=$false;github_effects=$false;existing_state_touched=$false
    validation_receipt=$validationPath
}
$plan | ConvertTo-Json -Depth 6
if ($Phase -eq 'DryRun') { return }
$validation = Get-Content -LiteralPath $validationPath -Raw | ConvertFrom-Json
if ($validation.status -cne 'passed' -or !$validation.source_unchanged -or $validation.head -cne $expected) {
    throw 'Canonical checks and matching native build must finish successfully before Start.'
}
if ((& git -C $product rev-parse HEAD).Trim() -cne $expected) { throw 'Product head changed.' }
$currentPaths = @(& git -C $product ls-files --cached --others --exclude-standard | Sort-Object -Unique)
if ($currentPaths.Count -ne $validation.source_after.files.Count) { throw 'Product source inventory changed.' }
foreach ($file in $validation.source_after.files) {
    if ($file.path -notin $currentPaths -or
        (Get-FileHash -LiteralPath (Join-Path $product $file.path)).Hash.ToLowerInvariant() -cne $file.sha256) {
        throw "Source changed since canonical validation: $($file.path)"
    }
}
foreach ($binary in $validation.binaries) {
    if ((Get-FileHash -LiteralPath $binary.path).Hash.ToLowerInvariant() -cne $binary.sha256) { throw 'Native binary changed.' }
}
foreach ($file in @($node,$vite,$serverExe,$runnerExe,(Join-Path $pg 'initdb.exe'),(Join-Path $pg 'postgres.exe'),(Join-Path $pg 'createdb.exe'))) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing fixture prerequisite: $file" }
}
New-Item -ItemType Directory -Path $qa | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $qa /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) { throw 'Cannot restrict the new fixture directory.' }
foreach ($directory in @('logs','source','runner','connections','evidence','credentials','private','empty-hooks')) {
    New-Item -ItemType Directory -Path (Join-Path $qa $directory) | Out-Null
}
$source = Join-Path $qa 'source'
[IO.File]::WriteAllText((Join-Path $source 'seed.txt'),"Owned Issue48 acceptance seed.`n",[Text.UTF8Encoding]::new($false))
& git -C $source init -b main
if ($LASTEXITCODE) { throw 'Synthetic Git initialization failed.' }
& git -C $source add seed.txt
if ($LASTEXITCODE) { throw 'Synthetic seed staging failed.' }
& git -C $source -c user.name='ECorp synthetic fixture' -c user.email='fixture@example.test' -c commit.gpgsign=false -c "core.hooksPath=$(Join-Path $qa 'empty-hooks')" commit -m 'Initialize isolated Issue48 acceptance fixture'
if ($LASTEXITCODE) { throw 'Synthetic fixture commit failed.' }
& git -C $source remote add origin https://github.com/ecorp-fixture/issue48-retirement.git
if ($LASTEXITCODE) { throw 'Synthetic origin configuration failed.' }
$databasePassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$passwordPath = Join-Path $qa 'credentials/postgres-password.txt'
$pgpassPath = Join-Path $qa 'credentials/pgpass.conf'
[IO.File]::WriteAllText($passwordPath,$databasePassword,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($pgpassPath,"127.0.0.1:59030:*:issue48:$databasePassword`n",[Text.UTF8Encoding]::new($false))
& (Join-Path $pg 'initdb.exe') -D (Join-Path $qa 'database') -U issue48 --auth=scram-sha-256 --encoding=UTF8 --locale=C --pwfile=$passwordPath
if ($LASTEXITCODE) { throw 'Fresh PostgreSQL initialization failed; preserve root.' }
$state = @{
    schema_version=2;workspace=$qa;purpose='issue48-native-acceptance';test_owned=$true;processes=@{};plan=$plan
    canonical_receipt_sha256=(Get-FileHash -LiteralPath $validationPath).Hash.ToLowerInvariant()
    binaries=$validation.binaries;source_file_count=$currentPaths.Count
    helper_sha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant()
    created_at=[DateTime]::UtcNow.ToString('o')
}
Save-LocalStackState -Path $recordPath -State $state -Workspace $qa
function Launch([string]$Role,[string]$Executable,[string[]]$Arguments,[string]$Cwd,[hashtable]$Environment) {
    $state.processes[$Role] = Start-LocalOwnedProcess -Role $Role -Workspace $qa -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $Cwd -LogDirectory (Join-Path $qa 'logs') -Environment $Environment
    Save-LocalStackState -Path $recordPath -State $state -Workspace $qa
}
function Wait-Ready([scriptblock]$Probe,[string]$Description) {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        try { if (& $Probe) { return } } catch { }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Description was not ready; preserve fixture and ownership."
}
$priorPgpass = $env:PGPASSFILE
$priorPgpassword = $env:PGPASSWORD
$serverEnv = $null
try {
    Launch 'postgres' (Join-Path $pg 'postgres.exe') @('-D',(Join-Path $qa 'database'),'-h','127.0.0.1','-p','59030') $qa @{}
    Wait-Ready { & (Join-Path $pg 'pg_isready.exe') -h 127.0.0.1 -p 59030 -U issue48 *> $null; $LASTEXITCODE -eq 0 } 'PostgreSQL'
    $env:PGPASSFILE = Join-Path $qa 'credentials/intentionally-absent.pgpass'
    $env:PGPASSWORD = 'invalid-owned-fixture-probe'
    & (Join-Path $pg 'psql.exe') -X -w -h 127.0.0.1 -p 59030 -U issue48 -d postgres -c 'SELECT 1' *> $null
    if (!$LASTEXITCODE) { throw 'Fresh PostgreSQL accepted an incorrect password.' }
    Remove-Item -LiteralPath Env:PGPASSWORD -ErrorAction SilentlyContinue
    $env:PGPASSFILE = $pgpassPath
    & (Join-Path $pg 'createdb.exe') -w -h 127.0.0.1 -p 59030 -U issue48 issue48_app_r1
    if ($LASTEXITCODE) { throw 'Authenticated fixture database creation failed.' }
    $state.database_authentication = @{
        method='scram-sha-256';wrong_password_rejected=$true;authenticated_creation=$true
        credential_delivery='Private PGPASSFILE for fixture SQL. Server environment-only delivery is reduced assurance.'
        credentials_outside_source_and_runner_workspaces=$true;runner_and_web_environment_secrets_removed=$true
    }
    $serverEnv = @{
        DATABASE_URL="postgres://issue48:${databasePassword}@127.0.0.1:59030/issue48_app_r1"
        CRONY_BIND='127.0.0.1:59031';CRONY_MODE='development';CRONY_RUNNER_GRACE_SECS='30'
        CRONY_RUNNER_CREDENTIAL_TTL_SECS='7200';ECORP_FACTORY_WATCH='0'
        CRONY_OBJECT_STORE_LOCAL_ROOT=(Join-Path $qa 'objects')
        CRONY_SECRET_MASTER_KEY_HEX=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        CRONY_ARTIFACT_SIGNING_KEY_HEX=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    }
    Launch 'server' $serverExe @() $product $serverEnv
    $serverEnv.Clear()
    $databasePassword = $null
    Wait-Ready { (Invoke-RestMethod "$($plan.server)/health" -TimeoutSec 2).status -eq 'ok' } 'Server'
    $demo = Invoke-RestMethod "$($plan.server)/api/demo/bootstrap?seed_crew=false" -Method Post -ContentType 'application/json' -Body '{}'
    $enrollment = Invoke-RestMethod "$($plan.server)/api/corps/$($demo.corp_id)/runners/enroll" -Method Post -ContentType 'application/json' -Body (@{
        actor_id=$demo.alice_actor_id;runner_id=$plan.runner_id;expires_in_seconds=900
    } | ConvertTo-Json)
    $enrollmentPath = Join-Path $qa 'private/enrollment.txt'
    [IO.File]::WriteAllText($enrollmentPath,$enrollment.enrollment_token)
    $enrollment = $null
    $runnerEnv = @{
        CRONY_SERVER_WS='ws://127.0.0.1:59031/ws/runner';CRONY_RUNNER_ID=$plan.runner_id
        CRONY_CORP_ID=$demo.corp_id;CRONY_RUNNER_CREDENTIAL_FILE=(Join-Path $qa 'private/credential.json')
        CRONY_RUNNER_ENROLLMENT_TOKEN_FILE=$enrollmentPath;CRONY_RUNNER_WORKSPACE=(Join-Path $qa 'runner')
        CRONY_SOURCE_REPOSITORY=$source;CRONY_SOURCE_BASE_REF='HEAD'
        CRONY_FAKE_AGENT_SCRIPT=(Join-Path $product 'scripts/fake-agent.mjs')
        CRONY_CODEX_COMMAND=(Join-Path $qa 'disabled-codex.exe');CRONY_CLAUDE_COMMAND=(Join-Path $qa 'disabled-claude.exe')
        CRONY_OPENCODE_COMMAND=(Join-Path $qa 'disabled-opencode.exe')
        CRONY_COPILOT_FIXTURE=$(if ($ProviderMode -eq 'fake-only') { 'false' } else { 'true' })
        CRONY_COPILOT_USE_LOGGED_IN_USER='false';CRONY_CONNECTIONS_DIRECTORY=(Join-Path $qa 'connections')
        CRONY_GITHUB_COMMAND=(Join-Path $qa 'disabled-github.exe');ECORP_FACTORY_WATCH='0'
    }
    if ($ProviderMode -eq 'fake-only') {
        $runnerEnv.CRONY_COPILOT_CLI_PATH = Join-Path $qa 'disabled-copilot.exe'
    }
    Launch 'runner' $runnerExe @() $product $runnerEnv
    Launch 'web' $node @($vite,'--host','127.0.0.1','--port','59032','--strictPort') (Join-Path $product 'apps/web') @{
        VITE_CRONY_SERVER_HTTP=$plan.server;ECORP_FACTORY_WATCH='0'
    }
    Wait-Ready { (Invoke-RestMethod "$($plan.server)/health" -TimeoutSec 2).runners -eq 1 } 'Runner'
    Wait-Ready { (Invoke-WebRequest $plan.web -TimeoutSec 2).StatusCode -eq 200 } 'Web'
    $state.demo=$demo
    $state.source=@{repository='ecorp-fixture/issue48-retirement';path=$source;base_ref='HEAD';base_commit=(& git -C $source rev-parse HEAD).Trim()}
    $state.ready_at=[DateTime]::UtcNow.ToString('o')
    Save-LocalStackState -Path $recordPath -State $state -Workspace $qa
    Write-Output "Owned Issue48 native stack ready. Non-secret ownership receipt: $recordPath"
} catch {
    $state.failure=@{at=[DateTime]::UtcNow.ToString('o');message=$_.Exception.Message}
    Save-LocalStackState -Path $recordPath -State $state -Workspace $qa
    throw
} finally {
    $databasePassword=$null
    $enrollment=$null
    if ($serverEnv) { $serverEnv.Clear() }
    $env:PGPASSFILE=$priorPgpass
    $env:PGPASSWORD=$priorPgpassword
}
