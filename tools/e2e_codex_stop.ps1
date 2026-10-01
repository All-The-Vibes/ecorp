#requires -Version 7.5
# Opt-in native acceptance. Every invocation owns a fresh source, DB and runner.
param(
    [Parameter(Mandatory)][string]$PostgresBin,
    [Parameter(Mandatory)][string]$QaParent,
    [Parameter(Mandatory)][string]$OutputRoot,
    [Parameter(Mandatory)][string]$PlaywrightModule,
    [Parameter(Mandatory)][ValidateSet('fixture-suspend','fixture-stop','provider-stop','fixture-lifecycle','fixture-completion-stop','fixture-completion-accepted','fixture-completion-lost','fixture-completion-legacy')][string]$Scenario,
    [string]$CodexCommand
)
$ErrorActionPreference = 'Stop'
$taskProduct = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskPg = (Resolve-Path -LiteralPath $PostgresBin).Path
$taskQaParent = (Resolve-Path -LiteralPath $QaParent).Path
$taskOutput = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputRoot)
$taskQa = Join-Path $taskQaParent ('issue87-stack-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
if ((Test-Path -LiteralPath $taskQa) -or (Test-Path -LiteralPath $taskOutput)) { throw 'Fresh paths required; preserve existing acceptance.' }
if ($taskQa.StartsWith($taskProduct + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture source must be outside the product checkout.' }
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskServer = (Resolve-Path -LiteralPath (Join-Path $taskProduct 'target/debug/crony-server.exe')).Path
$taskRunner = (Resolve-Path -LiteralPath (Join-Path $taskProduct 'target/debug/crony-runner.exe')).Path
$taskVite = (Resolve-Path -LiteralPath (Join-Path $taskProduct 'apps/web/node_modules/vite/bin/vite.js')).Path
$taskCompletion = $Scenario.StartsWith('fixture-completion-', [StringComparison]::Ordinal)
if ($Scenario -eq 'provider-stop') {
    if (!$CodexCommand) { throw 'Real-provider acceptance requires an explicit authenticated native Codex executable.' }
    $taskCodex = (Resolve-Path -LiteralPath $CodexCommand).Path
    $taskCodexArgs = ''
} else {
    $taskCodex = $taskNode
    $taskFixture = if ($Scenario -eq 'fixture-lifecycle' -or $taskCompletion) { 'fake-codex-app-server.mjs' } else { 'fake-codex-stop-app-server.mjs' }
    $taskCodexArgs = Join-Path $taskProduct ('scripts/' + $taskFixture)
    if ($Scenario -ne 'fixture-lifecycle' -and !$taskCompletion) {
        $taskCodexArgs += ';--scenario=' + $(if ($Scenario -eq 'fixture-suspend') { 'budget-delayed-output' } else { 'delayed-output' })
    }
}
Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force
function New-FixturePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
function Get-FixtureSourceIdentity {
    Push-Location $taskProduct
    try {
        $taskFiles = (& git ls-files -z --cached --others --exclude-standard) -split "`0" | Where-Object { $_ } | Sort-Object -Unique
        if ($LASTEXITCODE) { throw 'Source inventory failed.' }
        @($taskFiles | ForEach-Object { [ordered]@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()} })
    } finally { Pop-Location }
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
$taskState = @{schema_version=2;workspace=$taskQa;purpose='issue87-full-stack';test_owned=$true;processes=@{}}
$taskReceipt = [ordered]@{
    started_at=[DateTimeOffset]::UtcNow.ToString('o');status='starting';scenario=$Scenario
    qa_root=$taskQa;product_root=$taskProduct;output=$taskOutput;stopped=@{}
    head=(& git -C $taskProduct rev-parse HEAD);source_before=(Get-FixtureSourceIdentity)
    server_sha256=(Get-FileHash -LiteralPath $taskServer -Algorithm SHA256).Hash.ToLowerInvariant()
    runner_sha256=(Get-FileHash -LiteralPath $taskRunner -Algorithm SHA256).Hash.ToLowerInvariant()
    codex_command=$taskCodex;codex_sha256=(Get-FileHash -LiteralPath $taskCodex -Algorithm SHA256).Hash.ToLowerInvariant()
    historical_incident_reproduced=$false
}
$taskCode = 1
$taskSecretPaths = @()
try {
    New-Item -ItemType Directory -Path $taskQa,$taskOutput | Out-Null
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $taskQa /inheritance:r /grant:r "*${taskSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE) { throw 'Cannot restrict fixture storage to the current user and SYSTEM.' }
    New-Item -ItemType Directory -Path (Join-Path $taskQa 'source'),(Join-Path $taskQa 'runner') | Out-Null
    Invoke-FixtureGit -Arguments @('init','-b','main')
    Invoke-FixtureGit -Arguments @('config','user.name','ECorp acceptance fixture')
    Invoke-FixtureGit -Arguments @('config','user.email','acceptance@example.invalid')
    Invoke-FixtureGit -Arguments @('config','commit.gpgsign','false')
    Invoke-FixtureGit -Arguments @('remote','add','origin','https://github.com/All-The-Vibes/ecorp.git')
    [IO.File]::WriteAllText((Join-Path $taskQa 'source/README.md'), "Owned Codex stop acceptance source. No remote Git operations.`n")
    Invoke-FixtureGit -Arguments @('add','--','README.md')
    if ($taskCompletion) {
        # The ordinary fake writes these exact bytes. A clean worktree makes
        # premature removal observable without changing provider or verifier code.
        # Pin its checkout bytes too: Windows autocrlf can otherwise turn the
        # baseline into CRLF before the fake rewrites it with LF.
        [IO.File]::WriteAllText((Join-Path $taskQa 'source/.gitattributes'), "base.txt text eol=lf`n")
        [IO.File]::WriteAllText((Join-Path $taskQa 'source/base.txt'), "base`n")
        Invoke-FixtureGit -Arguments @('add','--','.gitattributes','base.txt')
    }
    Invoke-FixtureGit -Arguments @('commit','-m','Initialize explicitly owned stop acceptance source')
    $taskSourceHead = & git -C (Join-Path $taskQa 'source') rev-parse HEAD
    if ($LASTEXITCODE) { throw 'Cannot identify fixture source.' }
    $taskDbPort = New-FixturePort
    & (Join-Path $taskPg 'initdb.exe') -D (Join-Path $taskQa 'database') -U issue87_acceptance --auth=trust --encoding=UTF8 --locale=C *> (Join-Path $taskQa 'initdb.log')
    if ($LASTEXITCODE) { throw 'Owned PostgreSQL initialization failed.' }
    $taskState.processes.postgres = Start-LocalOwnedProcess -Role postgres -Workspace $taskQa -FilePath (Join-Path $taskPg 'postgres.exe') -ArgumentList @('-D',(Join-Path $taskQa 'database'),'-h','127.0.0.1','-p',"$taskDbPort") -WorkingDirectory $taskQa -LogDirectory (Join-Path $taskQa 'logs')
    Save-LocalStackState -Path (Join-Path $taskQa 'ownership.json') -State $taskState -Workspace $taskQa
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        & (Join-Path $taskPg 'pg_isready.exe') -h 127.0.0.1 -p $taskDbPort -U issue87_acceptance -d postgres *> $null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $taskDeadline)
    if ($LASTEXITCODE) { throw 'Owned PostgreSQL did not become ready.' }
    $taskServerPort = New-FixturePort
    $taskWebPort = New-FixturePort
    $taskServerUrl = "http://127.0.0.1:$taskServerPort"
    $taskWebUrl = "http://127.0.0.1:$taskWebPort"
    $taskState.processes.server = Start-LocalOwnedProcess -Role server -Workspace $taskQa -FilePath $taskServer -WorkingDirectory $taskProduct -LogDirectory (Join-Path $taskQa 'logs') -Environment @{
        DATABASE_URL="postgres://issue87_acceptance@127.0.0.1:$taskDbPort/postgres"
        CRONY_BIND="127.0.0.1:$taskServerPort";CRONY_CORS_ORIGINS=$taskWebUrl
        CRONY_OBJECT_STORE_LOCAL_ROOT=(Join-Path $taskQa 'objects')
    }
    Save-LocalStackState -Path (Join-Path $taskQa 'ownership.json') -State $taskState -Workspace $taskQa
    Wait-FixtureHttp "$taskServerUrl/health"
    $taskSeed = if ($Scenario -eq 'fixture-lifecycle') { 'true' } else { 'false' }
    $taskDemo = Invoke-RestMethod -Uri "$taskServerUrl/api/demo/bootstrap?seed_crew=$taskSeed" -Method Post -ContentType 'application/json' -Body '{}'
    $taskRunnerId = 'issue87-' + [guid]::NewGuid().ToString('N')
    $taskEnrollment = Invoke-RestMethod -Uri "$taskServerUrl/api/corps/$($taskDemo.corp_id)/runners/enroll" -Method Post -ContentType 'application/json' -Body (@{actor_id=$taskDemo.alice_actor_id;runner_id=$taskRunnerId;expires_in_seconds=600} | ConvertTo-Json -Compress)
    $taskTokenPath = Join-Path $taskQa 'runner-enrollment.token'
    $taskCredentialPath = Join-Path $taskQa 'runner/credential.json'
    $taskSecretPaths = @($taskTokenPath,$taskCredentialPath)
    [IO.File]::WriteAllText($taskTokenPath, $taskEnrollment.enrollment_token)
    $taskEnrollment = $null
    $taskRunnerWs = "ws://127.0.0.1:$taskServerPort/ws/runner"
    $taskGateUrl = $null
    if ($taskCompletion) {
        $taskGatePort = New-FixturePort
        $taskGateUrl = "http://127.0.0.1:$taskGatePort"
        $taskState.processes.gate = Start-LocalOwnedProcess -Role gate -Workspace $taskQa -FilePath $taskNode -ArgumentList @((Join-Path $PSScriptRoot 'e2e_codex_completion_gate.mjs')) -WorkingDirectory $taskProduct -LogDirectory (Join-Path $taskQa 'logs') -Environment @{
            CRONY_CODEX_STOP_TEST='1';CRONY_COMPLETION_GATE_PORT="$taskGatePort"
            CRONY_COMPLETION_GATE_UPSTREAM=$taskRunnerWs;CRONY_COMPLETION_GATE_SCENARIO=$Scenario
        }
        Save-LocalStackState -Path (Join-Path $taskQa 'ownership.json') -State $taskState -Workspace $taskQa
        Wait-FixtureHttp "$taskGateUrl/state"
        $taskRunnerWs = "ws://127.0.0.1:$taskGatePort/ws/runner"
    }
    $taskState.processes.runner = Start-LocalOwnedProcess -Role runner -Workspace $taskQa -FilePath $taskRunner -WorkingDirectory $taskProduct -LogDirectory (Join-Path $taskQa 'logs') -Environment @{
        CRONY_RUNNER_ENROLLMENT_TOKEN_FILE=$taskTokenPath;CRONY_RUNNER_CREDENTIAL_FILE=$taskCredentialPath
        CRONY_RUNNER_WORKSPACE=(Join-Path $taskQa 'runner');CRONY_SOURCE_REPOSITORY=(Join-Path $taskQa 'source');CRONY_SOURCE_BASE_REF='main'
        CRONY_FAKE_AGENT_SCRIPT=(Join-Path $taskProduct 'scripts/fake-agent.mjs');CRONY_CORP_ID=$taskDemo.corp_id;CRONY_RUNNER_ID=$taskRunnerId
        CRONY_SERVER_WS=$taskRunnerWs
        CRONY_CODEX_COMMAND=$taskCodex;CRONY_CODEX_COMMAND_ARGS=$taskCodexArgs
        CRONY_CLAUDE_COMMAND=(Join-Path $taskQa 'absent-claude.exe');CRONY_OPENCODE_COMMAND=(Join-Path $taskQa 'absent-opencode.exe')
        CRONY_COPILOT_CLI_PATH=(Join-Path $taskQa 'absent-copilot.exe')
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
    # Connected precedes the server's one-second reconciliation window. Preview
    # exercises real admission without persisting or dispatching a mission.
    $taskAdmissionBody = @{
        requested_by=$taskDemo.alice_actor_id;preferred_adapter='codex';strategy='single'
        title='Owned Codex acceptance admission readiness';description='Read-only fixture admission probe.'
        source=@{repository='all-the-vibes/ecorp';base_ref='main';base_commit=$taskSourceHead}
        budget_tokens=100000;budget_cost_microusd=10000000
    } | ConvertTo-Json -Depth 5 -Compress
    $taskReceipt.admission_readiness = @()
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $taskAdmission = Invoke-RestMethod -Uri "$taskServerUrl/api/corps/$($taskDemo.corp_id)/missions/preview" -Method Post -ContentType 'application/json' -Body $taskAdmissionBody -SkipHttpErrorCheck -StatusCodeVariable taskAdmissionStatus -TimeoutSec 5
        $taskReceipt.admission_readiness += @{
            observed_at=[DateTimeOffset]::UtcNow.ToString('o');status=[int]$taskAdmissionStatus
            error=if ($taskAdmissionStatus -eq 200) { $null } else { $taskAdmission.error }
        }
        if ($taskAdmissionStatus -eq 200) { break }
        if ($taskAdmissionStatus -ne 400 -or $taskAdmission.error -cne 'no connected runner can staff the selected mission runtime, model, and source') {
            throw 'Owned mission preview failed for a non-transient reason; inspect admission_readiness.'
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $taskDeadline)
    if ($taskAdmissionStatus -ne 200) { throw 'Owned runner did not become admission-ready; inspect admission_readiness and runner logs.' }
    $taskManifest = @{test_owned=$true;scenario=$Scenario;qa_root=$taskQa;product_root=$taskProduct;output=$taskOutput;source=(Join-Path $taskQa 'source');source_head=$taskSourceHead;server_url=$taskServerUrl;web_url=$taskWebUrl;gate_url=$taskGateUrl;runner_id=$taskRunnerId;processes=$taskState.processes;demo=$taskDemo}
    $taskFixturePath = Join-Path $taskOutput 'owned-fixture.json'
    $taskManifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskFixturePath -Encoding utf8
    $taskReceipt.status='running'
    $taskReceipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOutput 'driver.json') -Encoding utf8
    $taskDriver = if ($taskCompletion) { 'e2e_codex_completion_browser.mjs' } elseif ($Scenario -eq 'fixture-lifecycle') { 'e2e_codex.mjs' } else { 'e2e_codex_stop_browser.mjs' }
    $taskState.processes.acceptance = Start-LocalOwnedProcess -Role acceptance -Workspace $taskQa -FilePath $taskNode -ArgumentList @((Join-Path $PSScriptRoot $taskDriver)) -WorkingDirectory $taskProduct -LogDirectory $taskOutput -Environment @{
        CRONY_PLAYWRIGHT_MODULE=$PlaywrightModule;CRONY_CODEX_STOP_TEST='1';CRONY_CODEX_STOP_FIXTURE=$taskFixturePath
        CRONY_SERVER_HTTP=$taskServerUrl;CRONY_CODEX_E2E_OUTPUT=(Join-Path $taskOutput 'lifecycle.json')
    }
    Save-LocalStackState -Path (Join-Path $taskQa 'ownership.json') -State $taskState -Workspace $taskQa
    $taskAcceptance = Get-Process -Id $taskState.processes.acceptance.pid -ErrorAction Stop
    try {
        [void]$taskAcceptance.Handle
        $taskDeadline = [DateTime]::UtcNow.AddSeconds(240)
        while (!$taskAcceptance.WaitForExit(1000)) {
            if ([DateTime]::UtcNow -ge $taskDeadline) { throw 'Owned acceptance exceeded four minutes; preserve logs and fixtures.' }
        }
        $taskCode = $taskAcceptance.ExitCode
    } finally { $taskAcceptance.Dispose() }
    $taskReceipt.native_exit_code=$taskCode
    $taskReceipt.status = if ($taskCode -eq 0) {'passed'} else {'failed'}
} catch {
    $taskReceipt.status='failed';$taskReceipt.failure=$_.Exception.Message;$taskCode=1
} finally {
    $taskReceipt.cleanup_errors=@()
    foreach ($role in @('acceptance','web','runner','gate','server')) {
        if ($taskState.processes[$role]) {
            try {
                $record = $taskState.processes[$role]
                if (Test-LocalOwnedProcess -Record $record -Workspace $taskQa) { $null = Stop-LocalOwnedProcess -Record $record -Workspace $taskQa }
                $taskReceipt.stopped[$role] = !(Test-LocalOwnedProcess -Record $record -Workspace $taskQa)
            } catch { $taskReceipt.stopped[$role]=$false;$taskReceipt.cleanup_errors += "${role}: $($_.Exception.Message)" }
        }
    }
    if ($taskState.processes.postgres) {
        try {
            if (Test-LocalOwnedProcess -Record $taskState.processes.postgres -Workspace $taskQa) {
                & (Join-Path $taskPg 'pg_ctl.exe') -D (Join-Path $taskQa 'database') -m fast -w -t 30 stop *> (Join-Path $taskQa 'shutdown.log')
                $taskReceipt.database_stop_exit_code=$LASTEXITCODE
            }
            $taskReceipt.stopped.postgres = !(Test-LocalOwnedProcess -Record $taskState.processes.postgres -Workspace $taskQa)
        } catch { $taskReceipt.stopped.postgres=$false;$taskReceipt.cleanup_errors += "postgres: $($_.Exception.Message)" }
    }
    foreach ($secretPath in $taskSecretPaths) {
        try { if (Test-Path -LiteralPath $secretPath) { Remove-Item -LiteralPath $secretPath } }
        catch { $taskReceipt.cleanup_errors += 'Temporary runner credential cleanup failed.' }
    }
    $taskEnrollment = $null
    try {
        $taskReceipt.source_after=Get-FixtureSourceIdentity
        $taskReceipt.source_unchanged=(ConvertTo-Json -InputObject $taskReceipt.source_before -Depth 5 -Compress) -ceq (ConvertTo-Json -InputObject $taskReceipt.source_after -Depth 5 -Compress)
        $taskReceipt.head_after=& git -C $taskProduct rev-parse HEAD
        if ($LASTEXITCODE -or $taskReceipt.head_after -cne $taskReceipt.head) { $taskReceipt.source_unchanged=$false }
        if ($taskSourceHead) {
            $taskReceipt.fixture_source_head_after=& git -C (Join-Path $taskQa 'source') rev-parse HEAD
            if ($LASTEXITCODE -or $taskReceipt.fixture_source_head_after -cne $taskSourceHead) { $taskReceipt.source_unchanged=$false }
            $taskReceipt.fixture_source_status=@(& git -C (Join-Path $taskQa 'source') status --porcelain)
            if ($LASTEXITCODE -or $taskReceipt.fixture_source_status.Count) { $taskReceipt.source_unchanged=$false }
        }
    } catch { $taskReceipt.source_unchanged=$null;$taskReceipt.cleanup_errors += 'Final source identity unavailable.' }
    $taskReceipt.finished_at=[DateTimeOffset]::UtcNow.ToString('o')
    $taskState.stopped_at_utc=$taskReceipt.finished_at
    if (!$taskReceipt.source_unchanged -or @($taskReceipt.stopped.Values | Where-Object { !$_ }).Count -or $taskReceipt.cleanup_errors.Count) { $taskReceipt.status='failed';$taskCode=1 }
    try { if (Test-Path -LiteralPath $taskQa) { Save-LocalStackState -Path (Join-Path $taskQa 'ownership.json') -State $taskState -Workspace $taskQa } }
    catch { $taskReceipt.status='failed';$taskCode=1;$taskReceipt.cleanup_errors += 'Final ownership checkpoint failed.' }
    if (Test-Path -LiteralPath $taskOutput) { $taskReceipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOutput 'driver.json') -Encoding utf8 }
}
[pscustomobject]$taskReceipt | Select-Object scenario,status,native_exit_code,source_unchanged,qa_root,output,stopped,failure | ConvertTo-Json -Depth 8
exit $taskCode
