#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('InitPg','DbTests','StartRunners','StopRunnerA','StartWeb','Controllers','Inspect','Stop')][string]$Action,
    [string]$QaRoot = $env:ECORP_ISSUE161_QA,
    [string]$Repository = $env:ECORP_ISSUE161_REPOSITORY,
    [string]$PgBin = $env:ECORP_ISSUE161_PG_BIN,
    [ValidateRange(9161,9169)][int]$Issue = 9161,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($DryRun -and $Action -ne 'Controllers') { throw 'Use qa-plan.mjs --dry-run for resource setup; no resources were changed.' }
if (!$QaRoot -or !$Repository -or !$PgBin) { throw 'Explicit owned QA, product, and PostgreSQL paths are required.' }
$worktree = (Resolve-Path -LiteralPath $Repository).Path
$qa = (Resolve-Path -LiteralPath $QaRoot).Path
if (-not (Split-Path $qa -Leaf).StartsWith('issue-161-') -or
    (Split-Path (Split-Path $qa -Parent) -Leaf) -ne 'qa' -or
    $qa.StartsWith($worktree + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid owned QA root.' }
foreach ($candidate in @($qa, $PgBin)) {
    $cursor = $candidate
    while ($cursor) {
        if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'QA path redirects are forbidden.' }
        $cursor = Split-Path $cursor -Parent
    }
}
Import-Module (Join-Path $worktree 'tools\local_stack.psm1') -Force
$statePath = Join-Path $qa 'host-state.json'
$state = Read-LocalStackState -Path $statePath -Workspace $qa
if (-not $state) { $state = @{ schema_version=2; workspace=$qa; processes=@{} } }
$pgData = Join-Path $qa 'pg-data'
$logs = Join-Path $qa 'logs'
$api = 'http://127.0.0.1:18971'
$node = (Get-Command node.exe -ErrorAction Stop).Source

function Save-State { Save-LocalStackState -Path $statePath -State $state -Workspace $qa }
function Start-Owned([string]$Role, [string]$File, [string[]]$Arguments, [hashtable]$Environment) {
    if ($state.processes.ContainsKey($Role)) { throw "An ownership record for $Role already exists; inspect it before another start." }
    $record = Start-LocalOwnedProcess -Role $Role -Workspace $qa -FilePath $File -ArgumentList $Arguments `
        -WorkingDirectory $qa -LogDirectory $logs -Environment $Environment
    $state.processes[$Role] = $record
    Save-State
    return $record
}
function Set-PgEnvironment([string]$Database) {
    $env:PGHOST = '127.0.0.1'; $env:PGPORT = '55461'; $env:PGUSER = 'ecorp_qa161'; $env:PGDATABASE = $Database
    Remove-Item Env:\PGPASSWORD,Env:\PGSERVICE,Env:\PGSERVICEFILE -ErrorAction SilentlyContinue
    $env:PGPASSFILE = Join-Path $qa 'secrets/pgpass.conf'
}
function Assert-Pg {
    if (-not $state.processes.ContainsKey('postgres') -or
        -not (Test-LocalOwnedProcess -Record $state.processes.postgres -Workspace $qa)) { throw 'Owned QA PostgreSQL identity is unavailable.' }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 55461 -ErrorAction Stop)
    if (-not ($listeners | Where-Object OwningProcess -eq $state.processes.postgres.pid)) { throw 'PostgreSQL listener ownership mismatch.' }
    Set-PgEnvironment 'postgres'
    $identity = & (Join-Path $PgBin 'psql.exe') -X -At -v ON_ERROR_STOP=1 -c "SELECT current_setting('data_directory') || '|' || current_setting('port') || '|' || current_user"
    if ($LASTEXITCODE -ne 0) { throw 'QA database identity read failed.' }
    $parts = $identity.Trim().Split('|')
    if ($parts.Count -ne 3 -or -not (Test-LocalPathEqual $parts[0] $pgData) -or $parts[1] -ne '55461' -or $parts[2] -ne 'ecorp_qa161') { throw 'Wrong QA database identity; no tests may run.' }
}
function Read-Demo {
    $file = Join-Path $qa 'demo.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'QA API bootstrap receipt is missing.' }
    Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
}

switch ($Action) {
    'InitPg' {
        if (Test-Path -LiteralPath $pgData) { throw 'QA data already exists; it will not be reinitialized.' }
        if (@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 55461).Count) { throw 'QA database port is occupied.' }
        & (Join-Path $PgBin 'initdb.exe') -D $pgData -U ecorp_qa161 -A scram-sha-256 ('--pwfile='+(Join-Path $qa 'secrets/pg-password.txt')) --encoding=UTF8 --locale=C
        if ($LASTEXITCODE -ne 0) { throw 'Owned initdb failed.' }
        $null = Start-Owned 'postgres' (Join-Path $PgBin 'postgres.exe') @('-D',$pgData,'-p','55461','-h','127.0.0.1') @{}
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            & (Join-Path $PgBin 'pg_isready.exe') -h 127.0.0.1 -p 55461 -U ecorp_qa161 -d postgres | Out-Null
            if ($LASTEXITCODE -eq 0) { break }
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Owned PostgreSQL did not become ready.' }
            Start-Sleep -Milliseconds 200
        } while ($true)
        Assert-Pg
        foreach ($database in @('issue161_shared','issue161_independent','issue161_sqlx_maintenance')) {
            & (Join-Path $PgBin 'createdb.exe') $database
            if ($LASTEXITCODE -ne 0) { throw 'QA database creation failed; preserve its state.' }
        }
        'Created three owned QA databases on port 55461.'
    }
    'DbTests' {
        Assert-Pg
        # Disposable fixture secret delivered only through the child environment: reduced assurance.
        $password = [IO.File]::ReadAllText((Join-Path $qa 'secrets/pg-password.txt')).Trim()
        $env:DATABASE_URL = 'postgres://ecorp_qa161:' + [Uri]::EscapeDataString($password) + '@127.0.0.1:55461/issue161_sqlx_maintenance'
        Push-Location $worktree
        try {
            foreach ($package in @('crony-store','crony-server')) {
                & cargo test -p $package issue161_ --locked --offline -- --ignored --test-threads=1
                if ($LASTEXITCODE -ne 0) { throw "Focused $package database tests failed." }
            }
        } finally { Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue; Pop-Location }
    }
    'StartRunners' {
        Assert-Pg
        $demo = Read-Demo
        $credentials = Join-Path $qa 'credentials'
        New-Item -ItemType Directory -Path $credentials -ErrorAction Stop | Out-Null
        foreach ($letter in @('a','b')) {
            $role = 'runner-' + $letter
            $runnerId = 'issue161-runner-' + $letter
            $enrollment = Invoke-RestMethod -Method Post -MaximumRedirection 0 -Uri "$api/api/corps/$($demo.corp_id)/runners/enroll" `
                -ContentType application/json -Body (@{ actor_id=$demo.alice_actor_id; runner_id=$runnerId; expires_in_seconds=300 } | ConvertTo-Json)
            $enrollmentPath = Join-Path $credentials "$role-enrollment.token"
            [IO.File]::WriteAllText($enrollmentPath, $enrollment.enrollment_token)
            $runnerArgs = @('--server-ws','ws://127.0.0.1:18971/ws/runner','--runner-id',$runnerId,'--corp-id',$demo.corp_id,
                '--credential-file',(Join-Path $credentials "$role-credential.json"),'--enrollment-token-file',$enrollmentPath,
                '--workspace',(Join-Path $qa $role),'--source-repository',(Join-Path $qa 'source'),'--source-base-ref','HEAD',
                '--fake-agent-script',(Join-Path $worktree 'scripts\fake-agent.mjs'),
                '--codex-command',$node,'--codex-command-arg',(Join-Path $worktree 'scripts\fake-codex-app-server.mjs'),
                '--claude-command',(Join-Path $qa 'disabled-claude.exe'),'--opencode-command',(Join-Path $qa 'disabled-opencode.exe'),
                '--copilot-cli-path',(Join-Path $qa 'disabled-copilot.exe'),'--copilot-home',(Join-Path $qa "$role-copilot-home"),
                '--connections-directory',(Join-Path $qa "$role-connections"),'--github-command',(Join-Path $qa 'disabled-gh.exe'))
            $null = Start-Owned $role (Join-Path $worktree 'target\debug\crony-runner.exe') $runnerArgs @{ CRONY_COPILOT_USE_LOGGED_IN_USER='false' }
        }
        'Started two separately enrolled QA runners.'
    }
    'StartWeb' {
        if (@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 15471).Count) { throw 'QA web port is occupied.' }
        $env:VITE_CRONY_SERVER_HTTP = $api
        $env:VITE_CRONY_SERVER_WS = 'ws://127.0.0.1:18971'
        Push-Location $worktree
        try { & pnpm build:web; if ($LASTEXITCODE -ne 0) { throw 'QA web build failed.' } } finally { Pop-Location }
        $python = (Get-Command python.exe -ErrorAction Stop).Source
        $null = Start-Owned 'web' $python @('-m','http.server','15471','--bind','127.0.0.1','--directory',(Join-Path $worktree 'apps\web\dist')) @{}
        'Started the QA web client at http://127.0.0.1:15471.'
    }
    'StopRunnerA' {
        $demo = Read-Demo
        $snapshot = Invoke-RestMethod -MaximumRedirection 0 -Uri "$api/api/corps/$($demo.corp_id)/snapshot?actor_id=$($demo.alice_actor_id)"
        if (@($snapshot.snapshot.runs | Where-Object { $_.runner_id -eq 'issue161-runner-a' -and $_.status -notin @('completed','failed','cancelled','lost') }).Count) { throw 'Runner A still has active work; no stop allowed.' }
        if (-not (Test-LocalOwnedProcess -Record $state.processes['runner-a'] -Workspace $qa)) { throw 'Runner A identity is unverifiable.' }
        if (-not (Stop-LocalOwnedProcess -Record $state.processes['runner-a'] -Workspace $qa)) { throw 'Runner A did not stop.' }
        $state.processes['runner-a'].stopped_verified = $true
        Save-State
        'Stopped only idle QA runner A so the next bounded case exercises runner B.'
    }
    'Controllers' {
        Assert-Pg
        $demo = Read-Demo
        $authority = Invoke-RestMethod -MaximumRedirection 0 -Uri "$api/api/corps/$($demo.corp_id)/factory/authority?actor_id=$($demo.alice_actor_id)"
        $pin = [string]$authority.authority.claim_authority_id
        foreach ($letter in @('a','b')) {
            $actor = if ($letter -eq 'a') { $demo.alice_actor_id } else { $demo.bob_actor_id }
            $role = if ($DryRun) { "preview-$Issue-$letter" } else { "controller-$Issue-$letter" }
            $arguments = @('--server',$api,'factory',$demo.corp_id,$actor,'--claim-authority-id',$pin,
                '--owner','ecorp-qa','--project-number','161','--repository','All-The-Vibes/ecorp',
                '--source-repository-path',(Join-Path $qa 'source'),'--source-base-ref','HEAD',
                '--adapter','fake-process','--strategy','single','--budget-tokens','10000','--budget-cost-microusd','1000000',
                '--lease-seconds','300','--github-cli',$node,'--issue',[string]$Issue,'--write-scope','**')
            if ($DryRun) { $arguments += '--dry-run' }
            $environment = @{
                ECORP_GITHUB_CLI_PREFIX_ARGS_JSON = ConvertTo-Json -Compress -InputObject @((Join-Path $worktree 'tools\fake_github_cli.mjs'))
                ECORP_FAKE_GITHUB_STATE = Join-Path $qa "fake-github-$letter.json"
            }
            $null = Start-Owned $role (Join-Path $worktree 'target\debug\crony-cli.exe') $arguments $environment
        }
        'Started the bounded pair of synthetic controller processes.'
    }
    'Inspect' {
        foreach ($role in $state.processes.Keys) {
            $record = $state.processes[$role]
            [pscustomobject]@{ role=$role; pid=$record.pid; owned_alive=(Test-LocalOwnedProcess -Record $record -Workspace $qa); stdout=$record.stdout; stderr=$record.stderr }
        }
    }
    'Stop' {
        foreach ($role in @($state.processes.Keys | Where-Object { $_ -ne 'postgres' })) {
            $record = $state.processes[$role]
            # Null means confirmed absence. Inspection errors must escape before
            # saving stopped_verified; preserve the ownership receipt for retry.
            $current = Get-LocalProcessIdentity -ProcessId $record.pid
            if ($current) {
                if (-not (Test-LocalOwnedProcess -Record $record -Workspace $qa)) { throw "Ownership changed for $role; no stop was attempted." }
                if (-not (Stop-LocalOwnedProcess -Record $record -Workspace $qa)) { throw "Could not verify stop of $role." }
            }
            $record.stopped_verified = $true
            Save-State
        }
        if ($state.processes.ContainsKey('postgres') -and (Get-LocalProcessIdentity -ProcessId $state.processes.postgres.pid)) {
            Assert-Pg
            & (Join-Path $PgBin 'pg_ctl.exe') -D $pgData stop -m fast -w -t 30
            if ($LASTEXITCODE -ne 0) { throw 'Owned PostgreSQL did not stop.' }
            $state.processes.postgres.stopped_verified = $true
            Save-State
        }
        'Receipt-owned host processes stopped. Data and evidence retained.'
    }
}
