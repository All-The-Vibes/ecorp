#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Workspace,
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$SkipFactoryController,
    [switch]$Preflight,
    [switch]$Restart,
    [ValidateRange(0,65535)][int]$ServerPort = 0,
    [ValidateRange(0,65535)][int]$WebPort = 0
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force
$root = (Resolve-Path -LiteralPath $Workspace).Path
$output = Join-Path $root 'output'
$stateFile = Join-Path $output 'local-pids.json'
Assert-LocalStackPath -Path $stateFile
$state = Read-LocalStackState -Path $stateFile -Workspace $root
if ($state -and ($state.schema_version -ne 2 -or
    !$state.ContainsKey('configuration') -or $state.configuration -isnot [hashtable] -or
    !$state.ContainsKey('corp_id') -or !$state.ContainsKey('actor_id') -or
    !$state.ContainsKey('identity_initialized') -or $state.identity_initialized -isnot [bool])) {
    throw "Retained startup schema/identity is unverifiable: $stateFile. Restore the original configuration; no legacy record was upgraded."
}
$saved = if ($state) { $state.configuration } else { @{} }
if ($state) {
    foreach ($key in @('server_port','web_port','source_repository','source_base_ref',
        'runner_id','runner_workspace','copilot_home','database_identity')) {
        if (!$saved.ContainsKey($key) -or [string]::IsNullOrWhiteSpace([string]$saved[$key])) {
            throw "Retained configuration is missing $key in $stateFile. Restore the original setting before startup."
        }
    }
}
if (!$state) {
    $state = @{
        schema_version=2; workspace=$root; configuration=@{}; processes=@{}; previous_processes=@()
        server=$null; runner=$null; factoryController=$null; web=$null
        corp_id=$null; actor_id=$null; identity_initialized=$false
    }
}
Assert-LocalStackProcesses -State $state -Workspace $root

function Setting([string]$Name, [string]$Key, $Default) {
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if (![string]::IsNullOrWhiteSpace($value)) { return $value }
    if ($saved.ContainsKey($Key)) { return $saved[$Key] }
    $Default
}
function Port([int]$Explicit, [string]$Name, [string]$Key, [int]$Default) {
    $value = if ($Explicit) { $Explicit } else { Setting $Name $Key $Default }
    $parsed = 0
    if (![int]::TryParse([string]$value, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
        throw "$Name must be a valid TCP port. No fallback port will be selected."
    }
    $parsed
}
function Role-Record([string]$Role) {
    if ($state.processes.ContainsKey($Role)) { return $state.processes[$Role] }
    $null
}
function Role-Live([string]$Role) {
    Test-LocalOwnedProcess -Record (Role-Record $Role) -Workspace $root
}
function Save-State {
    Save-LocalStackState -Path $stateFile -State $state -Workspace $root
}
function Ensure-FreePort([int]$Number, [string]$Role) {
    try {
        $listeners = @(Get-NetTCPConnection -LocalPort $Number -State Listen -ErrorAction Stop)
    } catch {
        # Only the cmdlet's exact no-match result means free. Permission/CIM
        # failures are not evidence that a requested port is available.
        if ($_.FullyQualifiedErrorId -ne 'CmdletizationQuery_NotFound,Get-NetTCPConnection') { throw }
        $listeners = @()
    }
    if (!$listeners.Count) { return }
    $record = Role-Record $Role
    if (!(Role-Live $Role) -or @($listeners | Where-Object OwningProcess -ne $record.pid).Count) {
        throw "Port $Number is occupied without matching $Role ownership. Nothing was stopped; no fallback port will be used."
    }
}
function Wait-Service([string]$Role, [scriptblock]$Probe, [int]$Seconds = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (!(Role-Live $Role)) {
            throw "$Role exited or changed identity. Its state and unique logs were retained; start can recover missing services without resetting data."
        }
        try { if (& $Probe) { return } } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Role is still not ready. Its live process was not restarted or replaced. Inspect the recorded logs, then retry the same start command."
}
function Launch([string]$Role, [string]$Executable, [string[]]$Arguments, [string]$Directory, [hashtable]$Environment) {
    Assert-LocalStackProcesses -State $state -Workspace $root
    if (Role-Live $Role) { return }
    if ($Role -eq 'server') { Ensure-FreePort $serverPortValue $Role }
    if ($Role -eq 'web') { Ensure-FreePort $webPortValue $Role }
    if ($state.processes.ContainsKey($Role)) {
        $state.previous_processes = @($state.previous_processes) + @($state.processes[$Role])
        # Bound the in-record index. Actual logs are retained, never blindly
        # deleted as part of start/stop or confused with user worktree files.
        $state.previous_processes = @($state.previous_processes | Select-Object -Last 20)
    }
    $record = Start-LocalOwnedProcess -Role $Role -Workspace $root -FilePath $Executable `
        -ArgumentList $Arguments -WorkingDirectory $Directory -LogDirectory $logs -Environment $Environment
    $state.processes[$Role] = $record
    $state[$Role] = $record.pid
    try {
        Save-State
    } catch {
        $persistenceFailure = $_
        $persistenceFailure.Exception.Data['LocalStackNewProcessRecord'] = $record
        $rolledBack = $false
        try { $rolledBack = Stop-LocalOwnedProcess -Record $record -Workspace $root }
        catch {
            $persistenceFailure.Exception.Data['LocalStackPersistenceRollbackError'] = $_.Exception
        }
        $persistenceFailure.Exception.Data['LocalStackPersistenceRollbackVerified'] = $rolledBack
        if ($rolledBack) {
            $record.stop_outcome = 'startup_persistence_rollback'
            $state[$Role] = $null
        } else {
            Write-Warning -WarningAction Continue "The new $Role ownership record could not be saved and cleanup is unverified. Its exact record is retained on the original exception; existing services were not stopped."
        }
        throw $persistenceFailure
    }
}
function Test-LocalSettingChanged([string]$Name, [string]$Before, [string]$After) {
    if ($Name -in @('source_base_ref','factory_source_base_ref')) {
        # Git refs are exact strings even on a case-insensitive Windows host.
        return ![string]::Equals($Before, $After, [StringComparison]::Ordinal)
    }
    return $Before -ne $After
}
function Explicit-Environment([string[]]$Names) {
    $values = @{}
    foreach ($name in $Names) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($null -ne $value) { $values[$name] = $value }
    }
    $values
}

$serverPortValue = Port $ServerPort 'CRONY_SERVER_PORT' 'server_port' 8791
$webPortValue = Port $WebPort 'CRONY_WEB_PORT' 'web_port' 5187
if ($serverPortValue -eq $webPortValue) { throw 'API and UI ports must be different.' }
$serverUrl = "http://127.0.0.1:$serverPortValue"
$webUrl = "http://127.0.0.1:$webPortValue"
$source = [string](Setting 'CRONY_SOURCE_REPOSITORY' 'source_repository' $root)
$sourceRef = [string](Setting 'CRONY_SOURCE_BASE_REF' 'source_base_ref' 'HEAD')
Assert-LocalRunnerSourceRef -Repository $source -Ref $sourceRef
$sourceCommit = Get-LocalSourceCommit -Repository $source -Ref $sourceRef
$source = (Resolve-Path -LiteralPath $source).Path
if ($saved.ContainsKey('source_commit') -and
    (Test-LocalPathEqual $saved.source_repository $source) -and
    [string]::Equals($saved.source_base_ref, $sourceRef, [StringComparison]::Ordinal) -and
    $saved.source_commit -cne $sourceCommit) {
    throw "Retained source commit no longer matches the configured ref in $source. Review source alignment before startup."
}
$runnerWorkspace = [IO.Path]::GetFullPath([string](Setting 'CRONY_RUNNER_WORKSPACE' 'runner_workspace' (Join-Path $output 'runner')))
$copilotHome = [IO.Path]::GetFullPath([string](Setting 'CRONY_COPILOT_HOME' 'copilot_home' (Join-Path $runnerWorkspace 'copilot-home')))
Assert-LocalStackPath -Path $runnerWorkspace -Directory
Assert-LocalStackPath -Path (Join-Path $runnerWorkspace 'worktrees') -Directory
Assert-LocalStackPath -Path $copilotHome -Directory
$runnerId = [string](Setting 'CRONY_RUNNER_ID' 'runner_id' 'runner-local')
Assert-LocalRunnerIdentity -RunnerId $runnerId
if ($saved.ContainsKey('runner_id') -and $saved.runner_id -cne $runnerId) {
    throw "Runner identity mismatch in $stateFile. Startup cannot replace an enrolled runner."
}
foreach ($identity in @('corp','actor')) {
    $requested = [Environment]::GetEnvironmentVariable("CRONY_$($identity.ToUpperInvariant())_ID", 'Process')
    $key = "${identity}_id"
    if ($requested -and $state[$key] -and $state[$key] -ne $requested) {
        throw "Retained $identity identity mismatch in $stateFile."
    }
    if (!$state[$key]) { $state[$key] = $requested }
    $parsed = [guid]::Empty
    if (![guid]::TryParse([string]$state[$key], [ref]$parsed) -or $parsed -eq [guid]::Empty) {
        throw "Supply the existing CRONY_$($identity.ToUpperInvariant())_ID for $stateFile. Startup does not bootstrap identities."
    }
    $state[$key] = $parsed.ToString('D')
}
$connectionsDirectory = [string](Setting 'CRONY_CONNECTIONS_DIRECTORY' 'connections_directory' '')
$repositoryRoots = [string](Setting 'CRONY_REPOSITORY_ROOTS' 'repository_roots' '')
$githubCommand = [string](Setting 'CRONY_GITHUB_COMMAND' 'github_command' 'gh')
$watchSetting = [string](Setting 'ECORP_FACTORY_WATCH' 'factory_enabled' '0')
if ($watchSetting -notin @('0','1','False','True')) { throw 'ECORP_FACTORY_WATCH must be 0 or 1.' }
$factoryEnabled = $watchSetting -in @('1','True')
$factory = @{
    adapter = [string](Setting 'ECORP_FACTORY_ADAPTER' 'factory_adapter' 'github-copilot')
    budget_tokens = [long](Setting 'ECORP_FACTORY_BUDGET_TOKENS' 'factory_budget_tokens' 1000000)
    budget_cost_microusd = [long](Setting 'ECORP_FACTORY_BUDGET_COST_MICROUSD' 'factory_budget_cost_microusd' 1000000)
    controller_id = [string](Setting 'ECORP_FACTORY_CONTROLLER_ID' 'factory_controller_id' '00000000-0000-4000-8000-000000000051')
    project_owner = [string](Setting 'ECORP_GITHUB_PROJECT_OWNER' 'factory_project_owner' 'shyamsridhar123')
    project_number = [uint32](Setting 'ECORP_GITHUB_PROJECT_NUMBER' 'factory_project_number' 3)
    repository = [string](Setting 'ECORP_FACTORY_REPOSITORY' 'factory_repository' 'shyamsridhar123/ecorp')
    source_base_ref = [string](Setting 'ECORP_FACTORY_SOURCE_BASE_REF' 'factory_source_base_ref' $sourceRef)
    github_cli = [string](Setting 'ECORP_GITHUB_CLI' 'factory_github_cli' 'gh')
    publication_base_ref = [string](Setting 'ECORP_FACTORY_PUBLICATION_BASE_REF' 'factory_publication_base_ref' '')
    verification_policy_file = [string](Setting 'ECORP_FACTORY_VERIFICATION_POLICY_FILE' 'factory_verification_policy_file' '')
    workspace_connection_id = [string](Setting 'ECORP_FACTORY_WORKSPACE_CONNECTION_ID' 'factory_workspace_connection_id' '')
}
if ($factoryEnabled) {
    $controllerId = [guid]::Empty
    if (![guid]::TryParse($factory.controller_id, [ref]$controllerId) -or
        !$factory.project_number -or [string]::IsNullOrWhiteSpace($factory.project_owner) -or
        [string]::IsNullOrWhiteSpace($factory.repository) -or
        $factory.budget_tokens -le 0 -or $factory.budget_cost_microusd -le 0) {
        throw 'Factory needs its existing controller ID, Project, repository and positive limits. No service was changed.'
    }
    $factory.controller_id = $controllerId.ToString('D')
    if ([string]::IsNullOrWhiteSpace($factory.source_base_ref)) {
        throw 'Factory source ref cannot be empty. No service was changed.'
    }
    if ((Test-LocalSettingChanged 'factory_source_base_ref' $sourceRef $factory.source_base_ref) -and
        (Role-Live 'factoryController') -and !$Restart -and !$saved.ContainsKey('factory_source_base_ref')) {
        throw 'Use explicit restart to change the running Factory source ref. No service was changed.'
    }
    if ($factory.workspace_connection_id) {
        $connectionId = [guid]::Empty
        if (![guid]::TryParse($factory.workspace_connection_id, [ref]$connectionId) -or
            $connectionId -eq [guid]::Empty) {
            throw 'Factory workspace connection must be an existing non-empty connection ID. No service was changed.'
        }
        if ((Role-Live 'factoryController') -and !$Restart -and !$saved.ContainsKey('factory_workspace_connection_id')) {
            throw 'Use explicit restart to bind the running Factory controller to a saved connection. No service was changed.'
        }
        $factory.workspace_connection_id = $connectionId.ToString('D')
    }
    if ($factory.verification_policy_file) {
        $policyPath = [IO.Path]::GetFullPath($factory.verification_policy_file, $root)
        if (!(Test-Path -LiteralPath $policyPath -PathType Leaf)) {
            throw 'The configured Factory verification-policy file is missing. No service was changed.'
        }
        $factory.verification_policy_file = (Resolve-Path -LiteralPath $policyPath).Path
    }
}
$configuration = @{
    server_port=$serverPortValue; web_port=$webPortValue
    source_repository=$source; source_base_ref=$sourceRef; source_commit=$sourceCommit
    runner_workspace=$runnerWorkspace; runner_id=$runnerId
    copilot_home=$copilotHome
    connections_directory=$connectionsDirectory; repository_roots=$repositoryRoots; github_command=$githubCommand
    factory_enabled=$factoryEnabled; factory_adapter=$factory.adapter
    factory_budget_tokens=$factory.budget_tokens; factory_budget_cost_microusd=$factory.budget_cost_microusd
}
foreach ($key in $factory.Keys) { $configuration["factory_$key"] = $factory[$key] }

if (!$state.ContainsKey('previous_processes')) { $state.previous_processes = @() }
$anyLive = @($state.processes.Values | Where-Object { Test-LocalOwnedProcess -Record $_ -Workspace $root }).Count -gt 0
foreach ($key in $configuration.Keys) {
    # Adding a missing Factory worker must not restart the healthy API, runner
    # or UI. Changes to an already running worker still require explicit restart.
    $affectedProcessLive = if ($key.StartsWith('factory_')) { Role-Live 'factoryController' } else { $anyLive }
    if (!$Restart -and $affectedProcessLive -and $saved.ContainsKey($key) -and
        (Test-LocalSettingChanged $key ([string]$saved[$key]) ([string]$configuration[$key]))) {
        throw 'A live owned stack has different requested settings. Use explicit restart to apply configuration changes; start will not replace it.'
    }
}

# Secret-bearing connection strings are never stored in the ownership record,
# displayed, or passed through --database-url process arguments.
$databaseUrl = [Environment]::GetEnvironmentVariable('DATABASE_URL', 'Process')
$dbIdentity = Get-LocalDatabaseIdentity -DatabaseUrl $databaseUrl
if ($saved.ContainsKey('database_identity') -and $saved.database_identity -cne $dbIdentity) {
    throw "Database identity mismatch in $stateFile. Existing credentials/data were not replaced."
}
$configuration.database_identity = $dbIdentity
$configuration.database_mode = 'external'
$state.configuration = $configuration
$state.server_url = $serverUrl
$state.web_url = $webUrl
Ensure-FreePort $serverPortValue 'server'
Ensure-FreePort $webPortValue 'web'

$runtime = Join-Path $output 'local-stack'
$logs = Join-Path $runtime 'logs'
$guardDirectory = Join-Path $runtime 'process-cwd'
$credentialDirectory = Join-Path $output 'runner'
$credential = Join-Path $credentialDirectory 'credential.json'
$guard = Join-Path $guardDirectory '.env'
foreach ($path in @($runtime,$logs,$guardDirectory,$credentialDirectory)) {
    Assert-LocalStackPath -Path $path -Directory
}
Assert-LocalStackPath -Path $credential -Required
Assert-LocalStackPath -Path $guard
if ((Test-Path -LiteralPath $guard) -and (Get-Item -LiteralPath $guard).Length -ne 0) {
    throw "The owned process dotenv guard must stay empty: $guard"
}
if ((Test-LocalPathEqual $runnerWorkspace $source) -or (Test-LocalPathEqual $copilotHome $source) -or
    (Test-LocalPathEqual $runnerWorkspace $copilotHome)) {
    throw "Source, runner workspace and provider home must be distinct directories: $source"
}
$target = [Environment]::GetEnvironmentVariable('CARGO_TARGET_DIR','Process')
if (!$target) { $target = Join-Path $root 'target' }
$target = [IO.Path]::GetFullPath($target, $root)
$serverExe = Join-Path $target 'debug\crony-server.exe'
$runnerExe = Join-Path $target 'debug\crony-runner.exe'
$controllerExe = Join-Path $target 'debug\crony-cli.exe'
$needsServer = $Restart -or !(Role-Live 'server')
$needsRunner = $Restart -or !(Role-Live 'runner')
$needsWeb = $Restart -or !(Role-Live 'web')
$needsController = $factoryEnabled -and !$SkipFactoryController -and ($Restart -or !(Role-Live 'factoryController'))
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$vite = Join-Path $root 'apps\web\node_modules\vite\bin\vite.js'
if ($needsWeb) {
    # pnpm's supported isolated linker uses junctions to its verified package store.
    if ($SkipInstall) { Assert-LocalStackPath -Path $vite -Required -AllowDependencyLink }
    else { $null = Get-Command pnpm -ErrorAction Stop }
}
if ($needsServer -or $needsRunner -or $needsController) {
    if ($SkipBuild) {
        if ($needsServer) { Assert-LocalStackPath -Path $serverExe -Required }
        if ($needsRunner) { Assert-LocalStackPath -Path $runnerExe -Required }
        if ($needsController) { Assert-LocalStackPath -Path $controllerExe -Required }
    } else { $null = Get-Command cargo -ErrorAction Stop }
}
if ($factoryEnabled -and !$SkipFactoryController) {
    $null = Get-LocalSourceCommit -Repository $source -Ref $factory.source_base_ref
    $null = Get-Command $factory.github_cli -ErrorAction Stop
}
Assert-LocalDatabaseIdentity -DatabaseUrl $databaseUrl -CorpId $state.corp_id -ActorId $state.actor_id `
    -RunnerId $runnerId -CredentialPath $credential
if ($Preflight) {
    [pscustomobject]@{
        schema_version=1; status='ready'; read_only=$true; workspace=$root
        corp_id=$state.corp_id; actor_id=$state.actor_id; runner_id=$runnerId
        source_repository=$source; source_base_ref=$sourceRef; source_commit=$sourceCommit
        server_url=$serverUrl; web_url=$webUrl
        checks=@('retained_state','identity','database','source','credential','ownership','ports','dependencies','paths')
    }
    return
}

# No process control, filesystem/ACL change, enrollment or database provisioning
# is reachable until the same read-only validation above succeeds.
Assert-LocalStackProcesses -State $state -Workspace $root
if ($Restart) {
    foreach ($role in @('factoryController','runner','server','web')) {
        $record = Role-Record $role
        if (!$record) { continue }
        if (Stop-LocalOwnedProcess -Record $record -Workspace $root) {
            $record.stopped_at = [DateTime]::UtcNow.ToString('o')
            $record.stop_outcome = 'verified_root_stopped'
            $state[$role] = $null
            Save-State
        } elseif (Get-LocalProcessIdentity -ProcessId ([int]$record.pid)) {
            throw "The $role process changed identity before restart; it was preserved."
        }
    }
}
Ensure-FreePort $serverPortValue 'server'
Ensure-FreePort $webPortValue 'web'
New-Item -ItemType Directory -Path $guardDirectory, $logs, $credentialDirectory, $runnerWorkspace -Force | Out-Null
if (!(Test-Path -LiteralPath $guard)) { [IO.File]::WriteAllText($guard, '') }
if ((Get-Item -LiteralPath $guard).Length -ne 0) { throw 'The owned process dotenv guard must stay empty.' }
$principal = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $runtime /inheritance:r /grant:r "${principal}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the operator log/state directory.' }
& icacls.exe $credentialDirectory /inheritance:r /grant:r "${principal}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect runner identity files.' }
Save-State

Push-Location $root
try {
    if ($needsWeb -and !$SkipInstall) {
        & pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Workspace dependency installation failed; existing services were not stopped.' }
    }
    $buildPackages = @()
    if ($needsServer) { $buildPackages += 'crony-server' }
    if ($needsRunner) { $buildPackages += 'crony-runner' }
    if ($needsController) { $buildPackages += 'crony-cli' }
    if ($buildPackages.Count -and !$SkipBuild) {
        $arguments = @('build')
        foreach ($package in $buildPackages) { $arguments += @('-p',$package) }
        & cargo @arguments
        if ($LASTEXITCODE -ne 0) { throw 'The required local binaries did not build. Partial ownership/log records remain available.' }
    }
} finally { Pop-Location }

$serverEnvironment = Explicit-Environment @('CRONY_MODE','CRONY_OIDC_ISSUER','CRONY_ALLOW_INSECURE_OIDC',
    'CRONY_RUNNER_STARTUP_RECOVERY',
    'CRONY_SECRET_MASTER_KEY_HEX','CRONY_ARTIFACT_SIGNING_KEY_HEX','CRONY_OBJECT_STORE_BACKEND',
    'CRONY_OBJECT_STORE_LOCAL_ROOT','CRONY_OBJECT_STORE_ENDPOINT','CRONY_OBJECT_STORE_BUCKET',
    'CRONY_OBJECT_STORE_REGION','CRONY_OBJECT_STORE_ACCESS_KEY','CRONY_OBJECT_STORE_SECRET_KEY',
    'CRONY_OBJECT_STORE_ALLOW_HTTP','RUST_LOG')
if ($databaseUrl) { $serverEnvironment.DATABASE_URL = $databaseUrl }
Launch 'server' $serverExe @('--bind',"127.0.0.1:$serverPortValue") $root $serverEnvironment
$databaseUrl = $null
$serverEnvironment = $null
Wait-Service 'server' { (Invoke-RestMethod "$serverUrl/health" -TimeoutSec 3).status -eq 'ok' }

$snapshotUrl = "$serverUrl/api/corps/$($state.corp_id)/snapshot?actor_id=$($state.actor_id)"
$snapshot = Invoke-RestMethod $snapshotUrl -TimeoutSec 10
if ($snapshot.snapshot.corp.id -ne $state.corp_id) { throw 'The retained Corp does not match this server.' }

$runnerEnvironment = Explicit-Environment @('CRONY_COPILOT_CLI_PATH','CRONY_COPILOT_HOME',
    'CRONY_COPILOT_GITHUB_TOKEN_FILE','CRONY_COPILOT_CONNECTION_TOKEN_FILE','CRONY_COPILOT_RUNTIME_URL',
    'CRONY_COPILOT_USE_LOGGED_IN_USER','CRONY_COPILOT_FIXTURE','CRONY_COPILOT_LOG_LEVEL',
    'CRONY_CODEX_COMMAND','CRONY_CLAUDE_COMMAND','CRONY_OPENCODE_COMMAND','CRONY_PLAYWRIGHT_MODULE','RUST_LOG')
$runnerEnvironment.CRONY_COPILOT_HOME = $copilotHome
$runnerEnvironment.CRONY_GITHUB_COMMAND = $githubCommand
if ($connectionsDirectory) { $runnerEnvironment.CRONY_CONNECTIONS_DIRECTORY = $connectionsDirectory }
if ($repositoryRoots) { $runnerEnvironment.CRONY_REPOSITORY_ROOTS = $repositoryRoots }
$runnerArguments = @('--server-ws',"$($serverUrl.Replace('http:','ws:'))/ws/runner",
    '--runner-id',$runnerId,'--corp-id',$state.corp_id,'--credential-file',$credential,
    '--workspace',$runnerWorkspace,
    '--source-repository',$source,'--source-base-ref',$sourceRef,
    '--fake-agent-script',(Join-Path $root 'scripts\fake-agent.mjs'))
Launch 'runner' $runnerExe $runnerArguments $guardDirectory $runnerEnvironment
Wait-Service 'runner' {
    $current = Invoke-RestMethod $snapshotUrl -TimeoutSec 5
    @($current.runners | Where-Object { $_.id -eq $runnerId -and $_.connected }).Count -eq 1
}
$state.identity_initialized = $true
Save-State

if ($needsController) {
    $arguments = @('--server',$serverUrl,'factory-watch',$state.corp_id,$state.actor_id,
        '--controller-id',$factory.controller_id,'--owner',$factory.project_owner,
        '--project-number',[string]$factory.project_number,'--repository',$factory.repository,
        '--github-cli',$factory.github_cli,
        '--adapter',$factory.adapter,'--budget-tokens',[string]$factory.budget_tokens,
        '--budget-cost-microusd',[string]$factory.budget_cost_microusd,
        '--source-repository-path',$source,'--source-base-ref',$factory.source_base_ref)
    if ($factory.publication_base_ref) { $arguments += @('--publication-base-ref',$factory.publication_base_ref) }
    if ($factory.verification_policy_file) { $arguments += @('--verification-policy-file',$factory.verification_policy_file) }
    if ($factory.workspace_connection_id) { $arguments += @('--workspace-connection-id',$factory.workspace_connection_id) }
    $controllerEnvironment = Explicit-Environment @('GH_TOKEN','GITHUB_TOKEN','GH_HOST','CRONY_ACCESS_TOKEN',
        'ECORP_GITHUB_CLI_PREFIX_ARGS_JSON','ECORP_FAKE_GITHUB_STATE','ECORP_FAKE_GITHUB_EXPECT_TOKEN','RUST_LOG')
    Launch 'factoryController' $controllerExe $arguments $guardDirectory $controllerEnvironment
    # Register through the existing native watcher; never call pause/resume or
    # change its persisted desired state merely because the host restarted.
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$vite = Join-Path $root 'apps\web\node_modules\vite\bin\vite.js'
Launch 'web' $node @($vite,'--host','127.0.0.1','--port',[string]$webPortValue,'--strictPort') `
    (Join-Path $root 'apps\web') @{VITE_CRONY_SERVER_HTTP=$serverUrl}
Wait-Service 'web' { (Invoke-WebRequest $webUrl -TimeoutSec 3).StatusCode -eq 200 }
if ($factoryEnabled -and !$SkipFactoryController) {
    Wait-Service 'factoryController' {
        $current = Invoke-RestMethod $snapshotUrl -TimeoutSec 5
        @($current.snapshot.factory_controllers | Where-Object {
            $_.id -eq $factory.controller_id -and $_.status -ne 'offline'
        }).Count -eq 1
    }
}
Ensure-FreePort $serverPortValue 'server'
Ensure-FreePort $webPortValue 'web'
$state.ready_at = [DateTime]::UtcNow.ToString('o')
Save-State
Write-Host "ECorp server: $serverUrl"
Write-Host "ECorp web:    $webUrl"
Write-Host "Source repo:  $source ($sourceRef)"
Write-Host "Worktrees:    $runnerWorkspace"
Write-Host "Logs:         $logs"
Write-Host 'Existing credentials, data, provider homes and controller pause state were retained.'
Write-Host 'Credential delivery through trusted process environments is reduced assurance; values are not arguments or logs.'
