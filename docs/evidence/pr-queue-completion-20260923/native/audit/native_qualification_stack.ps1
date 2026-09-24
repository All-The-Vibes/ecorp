#requires -Version 7.5
[CmdletBinding()]
param(
    [ValidateSet('start','restart','fixture','stop-runtime','stop','status')][string]$Action = 'status',
    [Parameter(Mandatory)][string]$HostDirectory
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path '<reviewed-worktree>\tools' 'local_stack.psm1') -Force
$root = (Resolve-Path (Join-Path '<reviewed-worktree>\tools' '..')).Path
$hostRoot = [IO.Path]::GetFullPath($HostDirectory)
if (!$hostRoot.StartsWith([IO.Path]::GetFullPath("$env:USERPROFILE\.copilot\session-state\"), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture secrets must be under the user session files directory, outside the source checkout.'
}
$output = Join-Path $root 'output\native-qualification\phase2-queue-r471'
$statePath = Join-Path $output 'processes.json'
$binary = Join-Path $root 'target-native-qualification\debug'
$databaseName = 'native_foreground_runtime_20260917'
$journalName = 'native_foreground_journal_20260917'
$container = 'ecorp-foreground287-20260917-postgres'
$database = 'postgres://' + 'postgres@127.0.0.1:55483/' + $databaseName
$journal = 'postgres://' + 'postgres@127.0.0.1:55483/' + $journalName
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable -DateKind String } else { @{ processes=@{}; previous=@(); restarts=@(); factory_enabled=$false } }
function Save { $state | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $statePath }
function Launch([string]$Role,[string]$Exe,[string[]]$Arguments,[string]$Cwd,[hashtable]$Environment) {
    if ($state.processes.ContainsKey($Role) -and (Test-LocalOwnedProcess -Record $state.processes[$Role] -Workspace $root)) { return }
    $record = Start-LocalOwnedProcess -Role $Role -Workspace $root -FilePath $Exe -ArgumentList $Arguments `
        -WorkingDirectory $Cwd -LogDirectory (Join-Path $output 'logs') -Environment $Environment
    $state.processes[$Role]=$record
    Save
}
function Stop-Role([string]$Role) {
    if ($state.processes.ContainsKey($Role)) {
        $record = $state.processes[$Role]
        if (Test-LocalOwnedProcess -Record $record -Workspace $root) {
            if (!(Stop-LocalOwnedProcess -Record $record -Workspace $root)) { throw "Could not stop exact owned $Role" }
        }
        $state.previous += @($record)
        $state.processes.Remove($Role)
        Save
    }
}
function Retain-AnvilChild {
    if (!$state.processes.ContainsKey('anvil')) { return }
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18557 -State Listen -ErrorAction SilentlyContinue
    if (!$listener) { return }
    $child = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
    $expected = Join-Path '<reviewed-worktree>\tools' 'registry-toolchain\node_modules\@foundry-rs\anvil-win32-amd64\bin\anvil.exe'
    if ($child.ParentProcessId -ne $state.processes.anvil.pid -or !(Test-LocalPathEqual $child.ExecutablePath $expected) -or
        !(Test-LocalOwnedProcess -Record $state.processes.anvil -Workspace $root)) { throw 'Anvil listener ancestry does not match the owned pinned launcher.' }
    $record = Get-LocalProcessIdentity -ProcessId $listener.OwningProcess
    $record.workspace=$root
    $state.processes.anvilNode=$record
    Save
}
function Wait-Ready([string]$Role,[scriptblock]$Probe) {
    for ($attempt=0;$attempt -lt 120;$attempt++) {
        if (!(Test-LocalOwnedProcess -Record $state.processes[$Role] -Workspace $root)) {
            # Windows may briefly withhold process identity while the image loads.
            # Never accept readiness until exact PID/path/start-time ownership matches.
            Start-Sleep -Milliseconds 500
            continue
        }
        try { if (& $Probe) { return } } catch [System.Net.Http.HttpRequestException] { }
        Start-Sleep -Milliseconds 500
    }
    throw "$Role readiness timed out; no completion claimed."
}
function Post-Json([string]$Route,$Body) {
    Invoke-RestMethod "http://127.0.0.1:8992$Route" -Method Post -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 25)
}
if ($Action -eq 'status') {
    $state.processes.GetEnumerator() | ForEach-Object { [pscustomobject]@{role=$_.Key;pid=$_.Value.pid;owned_alive=(Test-LocalOwnedProcess -Record $_.Value -Workspace $root)} }
    return
}
if ($Action -eq 'stop') {
    foreach ($role in @('runner','server','web','gateway','github','anvilNode','anvil')) { Stop-Role $role }
    return
}
if ($Action -eq 'stop-runtime') {
    Stop-Role 'runner'
    Stop-Role 'server'
    return
}
New-Item -ItemType Directory -Path $hostRoot,$output -Force | Out-Null
$principal = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $hostRoot /inheritance:r /grant:r "${principal}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict host secret ACLs.' }
$guard = Join-Path $hostRoot '.env'
if (!(Test-Path $guard)) { [IO.File]::WriteAllText($guard,'') }
if ((Get-Item $guard).Length -ne 0) { throw 'Fixture dotenv guard must be empty.' }
$node = (Get-Command node.exe).Source
if ($Action -eq 'fixture') {
    Launch 'gateway' (Join-Path $binary 'crony-native-fixture.exe') @() $hostRoot @{
        CRONY_NATIVE_QUALIFICATION='1'; CRONY_NATIVE_FIXTURE_CONFIG_FILE=(Join-Path $hostRoot 'fixture-input.json');
        DATABASE_URL=$database; CRONY_NATIVE_JOURNAL_DATABASE_URL=$journal
    }
    Wait-Ready 'gateway' { (Invoke-RestMethod 'http://127.0.0.1:18560/qualification/metrics' -TimeoutSec 3).signatures -eq 0 }
    Write-Output 'Local gateway/native journal/secondary RPC ready.'
    return
}
if ($Action -eq 'start') {
    Retain-AnvilChild
    foreach ($port in @(8992,5298,18557,18558,18559,18560)) {
        $listener = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        if ($listener.Count -and !@($state.processes.Values | Where-Object { $_.pid -in $listener.OwningProcess -and (Test-LocalOwnedProcess -Record $_ -Workspace $root) }).Count) {
            throw "Port $port already in use without exact fixture ownership."
        }
    }
    foreach ($name in @($databaseName,$journalName)) {
        $found = & '<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin\psql.exe' -h 127.0.0.1 -p 55483 -U postgres -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$name';"
        if ($LASTEXITCODE -ne 0) { throw 'Owned PostgreSQL unavailable.' }
        if ($found -ne '1') {
            & '<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin\createdb.exe' -h 127.0.0.1 -p 55483 -U postgres $name *> $null
            if ($LASTEXITCODE -ne 0) { throw 'Cannot create owned fixture database.' }
        }
    }
    $source = Join-Path $output 'source-fixture'
    if (!(Test-Path (Join-Path $source '.git'))) {
        & git clone --quiet --no-hardlinks --no-checkout $root $source
        if ($LASTEXITCODE -ne 0) { throw 'Local fixture clone failed.' }
        # Qualify only this fresh synthetic clone for nested Windows Git paths.
        & git -C $source config --local core.longpaths true
        if ($LASTEXITCODE -ne 0) { throw 'Cannot qualify the owned fixture for Windows long paths.' }
        & git -C $source switch --quiet -c main c55b66067372ee5db9c6c06ba9acb8d913b59b05
        if ($LASTEXITCODE -ne 0) { throw 'Local fixture source selection failed.' }
    }
    $keyPath = Join-Path $hostRoot 'audit.key'
    if (!(Test-Path $keyPath)) { [IO.File]::WriteAllBytes($keyPath,[Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) }
    $secretsPath = Join-Path $hostRoot 'server-secrets.json'
    if (!(Test-Path $secretsPath)) {
        @{ CRONY_SECRET_MASTER_KEY_HEX=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32));
           CRONY_ARTIFACT_SIGNING_KEY_HEX=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        } | ConvertTo-Json | Set-Content -LiteralPath $secretsPath
    }
    Launch 'anvil' (Get-Command pwsh.exe).Source @('-NoProfile','-File',(Join-Path '<reviewed-worktree>\tools' 'start_base_registry_anvil.ps1'),'-Port','18557','-ChainId','84532','-CacheDirectory',(Join-Path $hostRoot 'anvil-cache')) $hostRoot @{}
    Wait-Ready 'anvil' {
        (Invoke-RestMethod 'http://127.0.0.1:18557' -Method Post -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' -TimeoutSec 3).result -eq '0x14a34'
    }
    Retain-AnvilChild
    Launch 'github' $node @((Join-Path '<reviewed-worktree>\tools' 'native_qualification_github.mjs')) $hostRoot @{CRONY_NATIVE_QUALIFICATION='1';CRONY_NATIVE_OUTPUT=$output}
    Wait-Ready 'github' { (Invoke-RestMethod 'http://127.0.0.1:18558/qualification/objects' -TimeoutSec 3).commit.Length -eq 40 }
} else {
    $state.restarts += @{at=[DateTime]::UtcNow.ToString('o');server_pid=$state.processes.server.pid;runner_pid=$state.processes.runner.pid}
    Stop-Role 'runner'
    Stop-Role 'server'
}
$serverEnvironment = Get-Content (Join-Path $hostRoot 'server-secrets.json') -Raw | ConvertFrom-Json -AsHashtable -DateKind String
$serverEnvironment.DATABASE_URL=$database
$serverEnvironment.CRONY_MODE='development'
$serverEnvironment.CRONY_NATIVE_QUALIFICATION='1'
$serverEnvironment.CRONY_STATE_AUDIT_SIGNING_KEY_FILE=Join-Path $hostRoot 'audit.key'
$serverEnvironment.CRONY_STATE_AUDIT_KEY_ID='native-qualification-checkpoint'
$serverEnvironment.CRONY_STATE_AUDIT_CHECKPOINT_SECONDS='2'
$serverEnvironment.CRONY_OBJECT_STORE_BACKEND='local'
$serverEnvironment.CRONY_OBJECT_STORE_LOCAL_ROOT=Join-Path $output 'objects'
$serverEnvironment.CRONY_RUNNER_STARTUP_RECOVERY='false'
if (Test-Path (Join-Path $hostRoot 'witnesses.json')) {
    $serverEnvironment.CRONY_STATE_AUDIT_RETAINED_WITNESSES_FILE=Join-Path $hostRoot 'witnesses.json'
    $serverEnvironment.CRONY_STATE_AUDIT_GITHUB_TOKEN_FILE=Join-Path $hostRoot 'github.token'
}
if (Test-Path (Join-Path $hostRoot 'base-worker.json')) { $serverEnvironment.CRONY_BASE_WORKER_CONFIG_FILE=Join-Path $hostRoot 'base-worker.json' }
Launch 'server' (Join-Path $binary 'crony-server.exe') @('--bind','127.0.0.1:8992') $hostRoot $serverEnvironment
Wait-Ready 'server' { (Invoke-RestMethod 'http://127.0.0.1:8992/health' -TimeoutSec 3).status -eq 'ok' }
$demo = Post-Json '/api/demo/bootstrap' @{}
$state.corp_id=$demo.corp_id
$state.alice_actor_id=$demo.alice_actor_id
$state.bob_actor_id=$demo.bob_actor_id
$state.eve_actor_id=$demo.eve_actor_id
Save
$credential = Join-Path $hostRoot 'runner-credential.json'
$enrollment = Join-Path $hostRoot 'runner-enrollment.token'
if (!(Test-Path $credential)) {
    $token = Post-Json "/api/corps/$($demo.corp_id)/runners/enroll" @{actor_id=$demo.alice_actor_id;runner_id='native-phase2-runner';expires_in_seconds=600}
    [IO.File]::WriteAllText($enrollment,$token.enrollment_token)
    $token=$null
}
Launch 'runner' (Join-Path $binary 'crony-runner.exe') @('--server-ws','ws://127.0.0.1:8992/ws/runner',
    '--runner-id','native-phase2-runner','--corp-id',$demo.corp_id,'--credential-file',$credential,'--enrollment-token-file',$enrollment,
    '--workspace',(Join-Path $output 'runner-workspaces'),'--source-repository',(Join-Path $output 'source-fixture'),
    '--source-base-ref','main','--fake-agent-script',(Join-Path $root 'scripts\fake-agent.mjs')) $hostRoot @{}
Wait-Ready 'runner' { (Invoke-RestMethod 'http://127.0.0.1:8992/health' -TimeoutSec 3).runners -eq 1 }
Launch 'web' $node @((Join-Path $root 'apps\web\node_modules\vite\bin\vite.js'),'--host','127.0.0.1','--port','5298','--strictPort') `
    (Join-Path $root 'apps\web') @{VITE_CRONY_SERVER_HTTP='http://127.0.0.1:8992'}
Wait-Ready 'web' { (Invoke-WebRequest 'http://127.0.0.1:5298' -TimeoutSec 3).StatusCode -eq 200 }
Write-Output 'Native qualification API8992/UI5298/runner ready; Factory disabled.'
