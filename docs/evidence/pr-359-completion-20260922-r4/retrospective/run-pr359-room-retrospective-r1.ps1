#requires -Version 7.4
$ErrorActionPreference = 'Stop'
$product = '<reviewed-worktree>'
$baseline = '<local-user>\code\ecorp-pr359-room-baseline-20260923'
$pg = '<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$qa = '<local-user>\code\qa\pr359-room-retrospective-20260923-r1'
$target = '<local-user>\code\ecorp-pr338-completion-20260922\target-validation'
$port = 59480
$receiptPath = Join-Path $PSScriptRoot 'pr359-room-retrospective-r1.json'
if ((Test-Path -LiteralPath $qa) -or (Test-Path -LiteralPath $receiptPath)) { throw 'Preserve prior fixtures and receipts.' }
if (@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $port).Count) { throw 'Selected port is occupied.' }
$bindingPath = Join-Path $PSScriptRoot 'pr359-room-retrospective-source-r1.json'
$binding = Get-Content -Raw -LiteralPath $bindingPath | ConvertFrom-Json
foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    if ($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','NODE_OPTIONS')) {
        [Environment]::SetEnvironmentVariable($name,$null,'Process')
    }
}
$env:PATH = '<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64;' + $pg + ';' + $env:PATH
$env:CARGO_TARGET_DIR = $target
$env:CARGO_BUILD_JOBS = '2'
$env:RUST_TEST_THREADS = '1'
New-Item -ItemType Directory -Path $qa | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $qa /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if ($LASTEXITCODE) { throw 'Fresh fixture could not be protected.' }
$passwordPath = Join-Path $qa 'postgres-password.txt'
$password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
[IO.File]::WriteAllText($passwordPath,$password,[Text.UTF8Encoding]::new($false))
$receipt = [ordered]@{status='running';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');binding_sha256=(Get-FileHash -LiteralPath $bindingPath).Hash.ToLowerInvariant();scope='One actual saved-room SQLx scenario in two source variants on a fresh authenticated loopback PostgreSQL. No application, runner, provider or browser acceptance rerun.';cases=@();cleanup='pending'}
function Save-Receipt { $receipt | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $receiptPath -Encoding utf8 }
$record = $null
$key = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())))
$mutex = [Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
$held = $false
Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force
Save-Receipt
try {
    & (Join-Path $pg 'initdb.exe') -D (Join-Path $qa 'database') -U issue48 --auth=scram-sha-256 --pwfile=$passwordPath --encoding=UTF8 --locale=C *> (Join-Path $qa 'initdb.log')
    if ($LASTEXITCODE) { throw 'Fresh PostgreSQL initialization failed.' }
    $record = Start-LocalOwnedProcess -Role postgres -Workspace $qa -FilePath (Join-Path $pg 'postgres.exe') -ArgumentList @('-D',(Join-Path $qa 'database'),'-h','127.0.0.1','-p',"$port") -WorkingDirectory $qa -LogDirectory (Join-Path $qa 'logs') -Environment @{}
    $receipt.process = $record
    Save-Receipt
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    do {
        & (Join-Path $pg 'pg_isready.exe') -h 127.0.0.1 -p $port -U issue48 *> $null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if ($LASTEXITCODE -or !(Test-LocalOwnedProcess -Record $record -Workspace $qa)) { throw 'Owned PostgreSQL did not become ready.' }
    $owners = @(Get-NetTCPConnection -State Listen -LocalPort $port | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1 -or $owners[0] -ne $record.pid) { throw 'Unexpected listener identity.' }
    $env:DATABASE_URL = "postgres://issue48:${password}@127.0.0.1:$port/postgres"
    try { $held=$mutex.WaitOne() } catch [Threading.AbandonedMutexException] { $held=$true }
    foreach ($variant in @('baseline','candidate')) {
        $repo = if ($variant -eq 'baseline') { $baseline } else { $product }
        Set-Location -LiteralPath $repo
        $tree = (& git write-tree).Trim()
        if ((& git diff --name-only)) { throw 'Unexpected unstaged source.' }
        if ($variant -eq 'baseline' -and $tree -ne $binding.baseline_staged_tree) { throw 'Baseline source changed.' }
        if ($variant -eq 'candidate' -and (& git rev-parse HEAD).Trim() -ne $binding.candidate_head) { throw 'Candidate source changed.' }
        $refresh = Join-Path $PSScriptRoot "pr359-room-$variant-r1-refresh.log"
        & cargo clean --workspace --target-dir $target *> $refresh
        if ($LASTEXITCODE) { throw 'Workspace cache refresh failed.' }
        $log = Join-Path $PSScriptRoot "pr359-room-$variant-r1.log"
        $arguments = @('test','--locked','-p','crony-server','factory_connection_tests::issue48_planner_reuses_pins_in_the_saved_connection_room','--','--exact','--ignored','--nocapture','--test-threads=1')
        $start = [DateTimeOffset]::UtcNow
        & cargo @arguments 2>&1 | ForEach-Object { ([string]$_).Replace($password,'[ephemeral database credential]') } | Set-Content -LiteralPath $log -Encoding utf8
        $code = $LASTEXITCODE
        $logText = [IO.File]::ReadAllText($log)
        $entry = [ordered]@{variant=$variant;staged_tree=$tree;head=(& git rev-parse HEAD).Trim();command=@('cargo')+$arguments;exit_code=$code;log=$log;sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant();started_at_utc=$start.ToString('o');finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');source_unchanged=((& git write-tree).Trim() -eq $tree -and -not (& git diff --name-only))}
        $receipt.cases += $entry
        Save-Receipt
        if (!$entry.source_unchanged) { throw 'Regression source changed during execution.' }
        if ($variant -eq 'baseline') {
            if ($code -ne 101 -or $logText -notmatch 'test result: FAILED\. 0 passed; 1 failed; 0 ignored' -or $logText -notmatch 'assertion.+left == right.+failed') { throw 'Expected behavioral baseline failure was not observed.' }
        } elseif ($code -ne 0 -or $logText -notmatch 'test result: ok\. 1 passed; 0 failed; 0 ignored') { throw 'Candidate did not pass the same scenario.' }
        Write-Output "$variant exit=$code; expected behavioral result recorded"
    }
    $receipt.status='passed'
} catch {
    $receipt.status='failed'
    $receipt.error=([string]$_.Exception.Message).Replace($password,'[ephemeral database credential]')
    throw
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
    Remove-Item -LiteralPath Env:DATABASE_URL -ErrorAction SilentlyContinue
    $password=$null
    if ($record -and (Test-LocalOwnedProcess -Record $record -Workspace $qa)) {
        & (Join-Path $pg 'pg_ctl.exe') -D (Join-Path $qa 'database') -m fast -w stop *> (Join-Path $qa 'cleanup.log')
        if ($LASTEXITCODE) { $receipt.status='failed'; $receipt.cleanup='Owned PostgreSQL stop failed; exact receipt retained.' }
        elseif (@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $port).Count -or (Test-LocalOwnedProcess -Record $record -Workspace $qa)) { $receipt.status='failed'; $receipt.cleanup='Exit/listener cleanup unverified; evidence retained.' }
        else { $receipt.cleanup='Exact owned PostgreSQL stopped and listener released. Database, credentials and source variants retained.' }
    }
    $receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    Save-Receipt
}
$receipt | ConvertTo-Json -Depth 12
if ($receipt.status -ne 'passed') { exit 1 }
