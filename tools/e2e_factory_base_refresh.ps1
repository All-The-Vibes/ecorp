#requires -Version 7.5
# Standalone Windows acceptance. Preserve every source/result/database fixture.
param(
    [Parameter(Mandatory)][string]$PostgresBin,
    [Parameter(Mandatory)][string]$QaParent,
    [Parameter(Mandatory)][string]$OutputRoot,
    [Parameter(Mandatory)][string]$PlaywrightModule
)
$ErrorActionPreference = 'Stop'
$taskProduct = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskPg = (Resolve-Path -LiteralPath $PostgresBin).Path
$taskQaParent = (Resolve-Path -LiteralPath $QaParent).Path
$taskOutput = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputRoot)
$taskQa = Join-Path $taskQaParent ('issue84-stack-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
if ((Test-Path -LiteralPath $taskQa) -or (Test-Path -LiteralPath $taskOutput)) { throw 'Fresh paths required; preserve existing validation.' }
if ($taskQa.StartsWith($taskProduct + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture source must be outside the product checkout.' }
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskServer = (Resolve-Path -LiteralPath (Join-Path $taskProduct 'target/debug/crony-server.exe')).Path
$taskRunner = (Resolve-Path -LiteralPath (Join-Path $taskProduct 'target/debug/crony-runner.exe')).Path
$taskVite = (Resolve-Path -LiteralPath (Join-Path $taskProduct 'apps/web/node_modules/vite/bin/vite.js')).Path
Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force
function New-FixturePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
function Invoke-FixtureGit {
    param([string[]]$Arguments)
    & git -C (Join-Path $taskQa 'source') @Arguments *> (Join-Path $taskQa 'git-last.log')
    if ($LASTEXITCODE) { throw 'Owned fixture Git command failed; inspect git-last.log.' }
}
function Wait-FixtureHttp {
    param([string]$Url)
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        try { $null = Invoke-RestMethod -Uri $Url -TimeoutSec 2; return } catch { Start-Sleep -Milliseconds 250 }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Owned HTTP process did not become ready; preserve its logs.'
}
$taskState = @{schema_version=2;workspace=$taskQa;purpose='issue84-full-stack';test_owned=$true;processes=@{}}
$taskReceipt = [ordered]@{started_at=[DateTimeOffset]::UtcNow.ToString('o');status='starting';qa_root=$taskQa;product_root=$taskProduct;output=$taskOutput;stopped=@{}}
$taskCode = 1
$taskSecretPaths = @()
try {
    New-Item -ItemType Directory -Path $taskQa,$taskOutput | Out-Null
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $taskQa /inheritance:r /grant:r "*${taskSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE) { throw 'Cannot restrict fixture storage to the current user and SYSTEM.' }
    New-Item -ItemType Directory -Path (Join-Path $taskQa 'source'),(Join-Path $taskQa 'runner'),(Join-Path $taskQa 'profile') | Out-Null
    Invoke-FixtureGit @('init','-b','main')
    Invoke-FixtureGit @('config','user.name','ECorp acceptance fixture')
    Invoke-FixtureGit @('config','user.email','acceptance@example.invalid')
    Invoke-FixtureGit @('config','commit.gpgsign','false')
    Invoke-FixtureGit @('remote','add','origin','https://github.com/All-The-Vibes/ecorp.git')
    [IO.File]::WriteAllText((Join-Path $taskQa 'source/README.md'), "Owned source fixture.`n")
    Invoke-FixtureGit @('add','--','README.md')
    Invoke-FixtureGit @('commit','-m','Initialize explicitly owned acceptance source')
    & git init --bare --initial-branch=main (Join-Path $taskQa 'publication.git') *> (Join-Path $taskQa 'git-init-bare.log')
    if ($LASTEXITCODE) { throw 'Cannot initialize owned local publication remote.' }
    Invoke-FixtureGit @('push',(Join-Path $taskQa 'publication.git'),'main:main')
    $taskDbPort = New-FixturePort
    & (Join-Path $taskPg 'initdb.exe') -D (Join-Path $taskQa 'database') -U issue84_acceptance --auth=trust --encoding=UTF8 --locale=C *> (Join-Path $taskQa 'initdb.log')
    if ($LASTEXITCODE) { throw 'Owned PostgreSQL initialization failed.' }
    $taskState.processes.postgres = Start-LocalOwnedProcess -Role postgres -Workspace $taskQa -FilePath (Join-Path $taskPg 'postgres.exe') -ArgumentList @('-D',(Join-Path $taskQa 'database'),'-h','127.0.0.1','-p',"$taskDbPort") -WorkingDirectory $taskQa -LogDirectory (Join-Path $taskQa 'logs')
    Save-LocalStackState -Path (Join-Path $taskQa 'ownership.json') -State $taskState -Workspace $taskQa
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        & (Join-Path $taskPg 'pg_isready.exe') -h 127.0.0.1 -p $taskDbPort -U issue84_acceptance -d postgres *> $null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $taskDeadline)
    if ($LASTEXITCODE) { throw 'Owned PostgreSQL did not become ready.' }
    $taskServerPort = New-FixturePort
    $taskWebPort = New-FixturePort
    $taskServerUrl = "http://127.0.0.1:$taskServerPort"
    $taskWebUrl = "http://127.0.0.1:$taskWebPort"
    $taskDatabaseUrl = "postgres://issue84_acceptance@127.0.0.1:$taskDbPort/postgres"
    $taskState.processes.server = Start-LocalOwnedProcess -Role server -Workspace $taskQa -FilePath $taskServer -WorkingDirectory $taskProduct -LogDirectory (Join-Path $taskQa 'logs') -Environment @{
        DATABASE_URL=$taskDatabaseUrl;CRONY_BIND="127.0.0.1:$taskServerPort";CRONY_CORS_ORIGINS=$taskWebUrl
        CRONY_OBJECT_STORE_LOCAL_ROOT=(Join-Path $taskQa 'objects')
    }
    Save-LocalStackState -Path (Join-Path $taskQa 'ownership.json') -State $taskState -Workspace $taskQa
    Wait-FixtureHttp "$taskServerUrl/health"
    $taskDemo = Invoke-RestMethod -Uri "$taskServerUrl/api/demo/bootstrap?seed_crew=true" -Method Post -ContentType 'application/json' -Body '{}'
    $taskRunnerId = 'issue84-' + [guid]::NewGuid().ToString('N')
    $taskEnrollment = Invoke-RestMethod -Uri "$taskServerUrl/api/corps/$($taskDemo.corp_id)/runners/enroll" -Method Post -ContentType 'application/json' -Body (@{actor_id=$taskDemo.alice_actor_id;runner_id=$taskRunnerId;expires_in_seconds=3600} | ConvertTo-Json -Compress)
    $taskTokenPath = Join-Path $taskQa 'runner-enrollment.token'
    $taskCredentialPath = Join-Path $taskQa 'runner/credential.json'
    $taskSecretPaths = @($taskTokenPath,$taskCredentialPath,(Join-Path $taskQa 'publisher.credential'))
    [IO.File]::WriteAllText($taskTokenPath, $taskEnrollment.enrollment_token)
    $taskEnrollment = $null
    $taskState.processes.runner = Start-LocalOwnedProcess -Role runner -Workspace $taskQa -FilePath $taskRunner -WorkingDirectory $taskProduct -LogDirectory (Join-Path $taskQa 'logs') -Environment @{
        CRONY_RUNNER_ENROLLMENT_TOKEN_FILE=$taskTokenPath;CRONY_RUNNER_CREDENTIAL_FILE=$taskCredentialPath
        CRONY_RUNNER_WORKSPACE=(Join-Path $taskQa 'runner');CRONY_SOURCE_REPOSITORY=(Join-Path $taskQa 'source');CRONY_SOURCE_BASE_REF='main'
        CRONY_FAKE_AGENT_SCRIPT=(Join-Path $taskProduct 'scripts/fake-agent.mjs');CRONY_CORP_ID=$taskDemo.corp_id;CRONY_RUNNER_ID=$taskRunnerId
        CRONY_SERVER_WS="ws://127.0.0.1:$taskServerPort/ws/runner"
        CRONY_CODEX_COMMAND=(Join-Path $taskQa 'absent-codex.exe');CRONY_CLAUDE_COMMAND=(Join-Path $taskQa 'absent-claude.exe')
        CRONY_OPENCODE_COMMAND=(Join-Path $taskQa 'absent-opencode.exe');CRONY_COPILOT_CLI_PATH=(Join-Path $taskQa 'absent-copilot.exe')
    }
    $taskState.processes.web = Start-LocalOwnedProcess -Role web -Workspace $taskQa -FilePath $taskNode -ArgumentList @($taskVite,'--host','127.0.0.1','--port',"$taskWebPort",'--strictPort') -WorkingDirectory (Join-Path $taskProduct 'apps/web') -LogDirectory (Join-Path $taskQa 'logs') -Environment @{VITE_CRONY_SERVER_HTTP=$taskServerUrl}
    Save-LocalStackState -Path (Join-Path $taskQa 'ownership.json') -State $taskState -Workspace $taskQa
    Wait-FixtureHttp $taskWebUrl
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $taskSnapshot = Invoke-RestMethod -Uri "$taskServerUrl/api/corps/$($taskDemo.corp_id)/snapshot?actor_id=$($taskDemo.alice_actor_id)" -TimeoutSec 5
        $taskReady = @($taskSnapshot.runners | Where-Object { $_.id -eq $taskRunnerId -and $_.connected -and $_.status -eq 'connected' }).Count -eq 1
        if (!$taskReady) { Start-Sleep -Milliseconds 300 }
    } while (!$taskReady -and [DateTime]::UtcNow -lt $taskDeadline)
    if (!$taskReady) { throw 'Owned runner did not connect; inspect server/runner logs.' }
    $taskManifest = @{test_owned=$true;qa_root=$taskQa;product_root=$taskProduct;output=$taskOutput;source=(Join-Path $taskQa 'source');remote=(Join-Path $taskQa 'publication.git');server_url=$taskServerUrl;web_url=$taskWebUrl;processes=$taskState.processes;demo=$taskDemo}
    $taskFixturePath = Join-Path $taskOutput 'owned-fixture.json'
    $taskManifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskFixturePath -Encoding utf8
    $taskReceipt.status='running'
    $taskReceipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOutput 'driver.json') -Encoding utf8
    $taskState.processes.acceptance = Start-LocalOwnedProcess -Role acceptance -Workspace $taskQa -FilePath $taskNode -ArgumentList @((Join-Path $PSScriptRoot 'e2e_factory_base_refresh.mjs')) -WorkingDirectory $taskProduct -LogDirectory $taskOutput -Environment @{
        CRONY_BASE_REFRESH_TEST='1';CRONY_BASE_REFRESH_FIXTURE=$taskFixturePath;CRONY_PLAYWRIGHT_MODULE=$PlaywrightModule
    }
    Save-LocalStackState -Path (Join-Path $taskQa 'ownership.json') -State $taskState -Workspace $taskQa
    $taskAcceptance = Get-Process -Id $taskState.processes.acceptance.pid -ErrorAction Stop
    try {
        [void]$taskAcceptance.Handle
        if (!$taskAcceptance.WaitForExit(600000)) { throw 'Owned acceptance exceeded its ten-minute limit; preserve logs and fixtures.' }
        $taskCode = $taskAcceptance.ExitCode
    } finally { $taskAcceptance.Dispose() }
    $taskReceipt.status = if ($taskCode -eq 0) {'passed'} else {'failed'}
} catch {
    $taskReceipt.status='failed';$taskReceipt.failure=$_.Exception.Message
} finally {
    foreach ($role in @('acceptance','web','runner','server')) {
        if ($taskState.processes[$role]) {
            $record = $taskState.processes[$role]
            if (Test-LocalOwnedProcess -Record $record -Workspace $taskQa) { $null = Stop-LocalOwnedProcess -Record $record -Workspace $taskQa }
            $taskReceipt.stopped[$role] = !(Test-LocalOwnedProcess -Record $record -Workspace $taskQa)
        }
    }
    if ($taskState.processes.postgres) {
        if (Test-LocalOwnedProcess -Record $taskState.processes.postgres -Workspace $taskQa) {
            & (Join-Path $taskPg 'pg_ctl.exe') -D (Join-Path $taskQa 'database') -m fast -w -t 30 stop *> (Join-Path $taskQa 'shutdown.log')
            $taskReceipt.database_stop_exit_code=$LASTEXITCODE
        }
        $taskReceipt.stopped.postgres = !(Test-LocalOwnedProcess -Record $taskState.processes.postgres -Workspace $taskQa)
    }
    foreach ($secretPath in $taskSecretPaths) {
        if (Test-Path -LiteralPath $secretPath) { Remove-Item -LiteralPath $secretPath }
    }
    $taskEnrollment = $null
    $taskReceipt.finished_at=[DateTimeOffset]::UtcNow.ToString('o')
    $taskState.stopped_at_utc=$taskReceipt.finished_at
    if (@($taskReceipt.stopped.Values | Where-Object { !$_ }).Count) { $taskReceipt.status='failed';$taskCode=1 }
    if (Test-Path -LiteralPath $taskQa) { Save-LocalStackState -Path (Join-Path $taskQa 'ownership.json') -State $taskState -Workspace $taskQa }
    if (Test-Path -LiteralPath $taskOutput) { $taskReceipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOutput 'driver.json') -Encoding utf8 }
}
$taskReceipt | ConvertTo-Json -Depth 8
exit $taskCode
