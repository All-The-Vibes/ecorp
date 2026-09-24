#requires -Version 7.4
<#
Owned Windows supervisor for PR359's deterministic browser acceptance.
Reuses local_stack.psm1; never starts a watcher, borrows a DB, or resets a fixture.
DryRun is read-only. Start requires a NEW QA directory. Stop retains all data.
#>
[CmdletBinding()]
param(
    [ValidateSet('DryRun','Start','Status','Stop')][string]$Phase = 'DryRun',
    [Parameter(Mandatory)][string]$QaRoot,
    [Parameter(Mandatory)][string]$PostgresBin,
    [int]$ServerPort = 59031,
    [int]$WebPort = 59032,
    [int]$DatabasePort = 59030
)
$ErrorActionPreference = 'Stop'
$product = '<reviewed-worktree>'
$qa = [IO.Path]::GetFullPath($QaRoot).TrimEnd('\')
if (![IO.Path]::IsPathFullyQualified($QaRoot) -or
    (Split-Path -Leaf $qa) -notmatch '^pr359-agent-pinning-[a-zA-Z0-9-]+$' -or
    (Split-Path -Leaf (Split-Path -Parent $qa)) -ne 'qa' -or
    $qa.StartsWith($product, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use a dedicated absolute qa/pr359-agent-pinning-* directory outside the product.'
}
$pg = (Resolve-Path -LiteralPath $PostgresBin).Path
Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force
$recordPath = Join-Path $qa 'ownership.json'
if ($Phase -in @('Status','Stop')) {
    $state = Read-LocalStackState -Path $recordPath -Workspace $qa
    if (!$state -or $state.purpose -ne 'pr359-agent-pinning') { throw 'Missing exact fixture ownership.' }
    if ($Phase -eq 'Status') {
        foreach ($role in @('postgres','server','runner','web')) {
            if (!(Test-LocalOwnedProcess -Record $state.processes[$role] -Workspace $qa)) {
                throw "Exact $role process identity is absent or changed."
            }
        }
        foreach ($entry in @(@('server',([uri]$state.plan.server).Port), @('web',([uri]$state.plan.web).Port), @('postgres',$state.plan.database.port))) {
            $owners = @(Get-NetTCPConnection -State Listen -LocalPort $entry[1] | Select-Object -ExpandProperty OwningProcess -Unique)
            if ($owners.Count -ne 1 -or $owners[0] -ne $state.processes[$entry[0]].pid) { throw 'Listener ownership changed.' }
        }
        Write-Output 'Exact fixture process identities and listener ownership verified.'
        return
    }
    foreach ($role in @('web','runner','server')) {
        if (Test-LocalOwnedProcess -Record $state.processes[$role] -Workspace $qa) {
            if (!(Stop-LocalOwnedProcess -Record $state.processes[$role] -Workspace $qa)) {
                throw "Could not verify stop of $role; all records retained."
            }
        }
    }
    if (Test-LocalOwnedProcess -Record $state.processes.postgres -Workspace $qa) {
        & (Join-Path $pg 'pg_ctl.exe') -D (Join-Path $qa 'database') -m fast -w stop
        if ($LASTEXITCODE) { throw 'Owned PostgreSQL shutdown failed; retained.' }
    }
    $state.stopped_at = [DateTime]::UtcNow.ToString('o')
    Save-LocalStackState -Path $recordPath -State $state -Workspace $qa
    Write-Output 'Stopped only recorded fixture processes; database, source, credentials and evidence retained.'
    return
}
$ports = @($ServerPort,$WebPort,$DatabasePort)
if (@($ports | Select-Object -Unique).Count -ne 3 -or @($ports | Where-Object { $_ -lt 10000 -or $_ -gt 65535 }).Count) {
    throw 'Three distinct high ports are required.'
}
if (Test-Path -LiteralPath $qa) { throw 'Occupied QA directory: preserve it; never reset or adopt it.' }
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort)
foreach ($port in $ports) { if ($listeners -contains $port) { throw "QA port $port is occupied; nothing stopped." } }
$serverExe = Join-Path $product 'target\debug\crony-server.exe'
$runnerExe = Join-Path $product 'target\debug\crony-runner.exe'
$node = (Get-Command node.exe).Source
$vite = Join-Path $product 'apps\web\node_modules\vite\bin\vite.js'
foreach ($file in @($vite, (Join-Path $pg 'initdb.exe'), (Join-Path $pg 'postgres.exe'), (Join-Path $pg 'createdb.exe'))) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing prerequisite: $file" }
}
$plan = [ordered]@{
    phase=$Phase; product=$product; product_commit=(& git -C $product rev-parse HEAD)
    qa_root=$qa; server="http://127.0.0.1:$ServerPort"; web="http://127.0.0.1:$WebPort"
    database=@{host='127.0.0.1';port=$DatabasePort;name='issue48_app';fresh=$true}
    runner_id='runner-issue48-42269426'; provider='native deterministic fake-process; no AI inference'
    source='new independent synthetic Git repository, never the product checkout'
    factory_watcher=$false; github_effects=$false; existing_state_touched=$false
    build_required=(!(Test-Path -LiteralPath $serverExe) -or !(Test-Path -LiteralPath $runnerExe))
}
$plan | ConvertTo-Json -Depth 5
if ($Phase -eq 'DryRun') { return }
if ($plan.build_required) { throw 'Build matching-source server and runner before Start.' }
New-Item -ItemType Directory -Path $qa | Out-Null
# Private fixture credentials are never under the synthetic source or agent worktrees.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $qa /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) { throw 'Cannot make the new QA root private.' }
foreach ($dir in @('logs','source','runner','connections','evidence')) {
    New-Item -ItemType Directory -Path (Join-Path $qa $dir) | Out-Null
}
$source = Join-Path $qa 'source'
[IO.File]::WriteAllText((Join-Path $source 'seed.txt'), "# PR359 deterministic source fixture`n")
& git -C $source init -b main
& git -C $source add seed.txt
& git -C $source -c user.name='ECorp QA' -c user.email='qa@ecorp.invalid' commit -m 'Initialize isolated acceptance fixture'
if ($LASTEXITCODE) { throw 'Synthetic source initialization failed.' }
& git -C $source remote add origin https://github.com/ecorp-fixture/pr359-agent-pinning.git
& (Join-Path $pg 'initdb.exe') -D (Join-Path $qa 'database') -U issue48 --auth=trust --encoding=UTF8 --locale=C
if ($LASTEXITCODE) { throw 'Fresh PostgreSQL initialization failed; preserve this root.' }
$state = @{schema_version=2;workspace=$qa;purpose='pr359-agent-pinning';test_owned=$true;processes=@{};plan=$plan}
function Launch([string]$Role,[string]$Exe,[string[]]$ArgumentList,[string]$Cwd,[hashtable]$Environment) {
    $state.processes[$Role] = Start-LocalOwnedProcess -Role $Role -Workspace $qa -FilePath $Exe `
        -ArgumentList $ArgumentList -WorkingDirectory $Cwd -LogDirectory (Join-Path $qa 'logs') -Environment $Environment
    Save-LocalStackState -Path $recordPath -State $state -Workspace $qa
}
function Wait-Ready([scriptblock]$Probe,[string]$Description) {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        try { if (& $Probe) { return } } catch { }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Description did not become ready; preserve logs and ownership."
}
Launch 'postgres' (Join-Path $pg 'postgres.exe') @('-D',(Join-Path $qa 'database'),'-h','127.0.0.1','-p',"$DatabasePort") $qa @{}
Wait-Ready { & (Join-Path $pg 'pg_isready.exe') -h 127.0.0.1 -p $DatabasePort -U issue48 *> $null; $LASTEXITCODE -eq 0 } 'PostgreSQL'
& (Join-Path $pg 'createdb.exe') -h 127.0.0.1 -p $DatabasePort -U issue48 issue48_app
if ($LASTEXITCODE) { throw 'Could not create fresh acceptance database.' }
$serverEnv = @{
    DATABASE_URL="postgres://issue48@127.0.0.1:$DatabasePort/issue48_app"
    CRONY_BIND="127.0.0.1:$ServerPort"; CRONY_MODE='development'; CRONY_RUNNER_GRACE_SECS='30'
    CRONY_RUNNER_CREDENTIAL_TTL_SECS='7200'; ECORP_FACTORY_WATCH='0'
    CRONY_OBJECT_STORE_LOCAL_ROOT=(Join-Path $qa 'objects')
    CRONY_SECRET_MASTER_KEY_HEX=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    CRONY_ARTIFACT_SIGNING_KEY_HEX=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
}
Launch 'server' $serverExe @() $product $serverEnv
Wait-Ready { (Invoke-RestMethod "$($plan.server)/health" -TimeoutSec 2).status -eq 'ok' } 'Server'
$demo = Invoke-RestMethod "$($plan.server)/api/demo/bootstrap?seed_crew=false" -Method Post -ContentType 'application/json' -Body '{}'
$enrollment = Invoke-RestMethod "$($plan.server)/api/corps/$($demo.corp_id)/runners/enroll" -Method Post -ContentType 'application/json' -Body (@{
    actor_id=$demo.alice_actor_id;runner_id=$plan.runner_id;expires_in_seconds=900
} | ConvertTo-Json)
$enrollmentPath = Join-Path $qa 'enrollment.txt'
[IO.File]::WriteAllText($enrollmentPath,$enrollment.enrollment_token)
$runnerEnv = @{
    CRONY_SERVER_WS="ws://127.0.0.1:$ServerPort/ws/runner"; CRONY_RUNNER_ID=$plan.runner_id
    CRONY_CORP_ID=$demo.corp_id; CRONY_RUNNER_CREDENTIAL_FILE=(Join-Path $qa 'credential.json')
    CRONY_RUNNER_ENROLLMENT_TOKEN_FILE=$enrollmentPath; CRONY_RUNNER_WORKSPACE=(Join-Path $qa 'runner')
    CRONY_SOURCE_REPOSITORY=$source; CRONY_SOURCE_BASE_REF='HEAD'
    CRONY_FAKE_AGENT_SCRIPT=(Join-Path $product 'scripts\fake-agent.mjs')
    CRONY_CODEX_COMMAND=(Join-Path $qa 'disabled-codex.exe'); CRONY_CLAUDE_COMMAND=(Join-Path $qa 'disabled-claude.exe')
    CRONY_OPENCODE_COMMAND=(Join-Path $qa 'disabled-opencode.exe'); CRONY_COPILOT_FIXTURE='true'
    CRONY_COPILOT_USE_LOGGED_IN_USER='false'; CRONY_CONNECTIONS_DIRECTORY=(Join-Path $qa 'connections')
    CRONY_GITHUB_COMMAND=(Join-Path $qa 'disabled-github.exe'); ECORP_FACTORY_WATCH='0'
}
Launch 'runner' $runnerExe @() $product $runnerEnv
Launch 'web' $node @($vite,'--host','127.0.0.1','--port',"$WebPort",'--strictPort') (Join-Path $product 'apps\web') @{
    VITE_CRONY_SERVER_HTTP=$plan.server; ECORP_FACTORY_WATCH='0'
}
Wait-Ready { (Invoke-RestMethod "$($plan.server)/health" -TimeoutSec 2).runners -eq 1 } 'Runner'
Wait-Ready { (Invoke-WebRequest $plan.web -TimeoutSec 2).StatusCode -eq 200 } 'Web'
$state.demo=$demo
$state.source=@{repository='ecorp-fixture/pr359-agent-pinning';base_ref='HEAD';base_commit=(& git -C $source rev-parse HEAD)}
$state.ready_at=[DateTime]::UtcNow.ToString('o')
Save-LocalStackState -Path $recordPath -State $state -Workspace $qa
Write-Output "Owned deterministic stack ready. Non-secret receipt: $recordPath"
