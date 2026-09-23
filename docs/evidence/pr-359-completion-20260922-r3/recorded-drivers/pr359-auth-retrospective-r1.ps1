#requires -Version 7.4
$ErrorActionPreference = 'Stop'
$product = '<reviewed-worktree>'
$pg = '<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$root = Join-Path $PSScriptRoot 'pr359-auth-retrospective-r1'
if (Test-Path -LiteralPath $root) { throw 'Preserve earlier retrospective evidence.' }
$ports = @(59470,59471)
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort)
if (@($ports | Where-Object { $listeners -contains $_ }).Count) { throw 'A selected port is occupied; no existing process will be touched.' }
New-Item -ItemType Directory -Path $root | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $root /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if ($LASTEXITCODE) { throw 'Cannot protect fresh fixture root.' }
Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force
$receipt = [ordered]@{
    status='running';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    tested_staged_tree=((& git -C $product write-tree).Trim())
    scope='Retrospective execution of exact historical and corrected initdb command bytes in two fresh, loopback-only owned PostgreSQL fixtures; no application, runner, provider, shared database or remote effects.'
    postgres_version=((& (Join-Path $pg 'postgres.exe') --version) -join "`n")
    cases=@()
}
function Save-Receipt { $receipt | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $root 'receipt.json') -Encoding utf8 }
function Client([string]$Name,[int]$Port,[string]$Pgpass,[string]$Password) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = Join-Path $pg 'psql.exe'
    $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true
    $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    $psi.Environment.Clear()
    foreach ($key in @('SystemRoot','windir','Path','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','ComSpec')) {
        $value = [Environment]::GetEnvironmentVariable($key,'Process')
        if ($null -ne $value) { $psi.Environment[$key]=$value }
    }
    $psi.Environment['PGPASSFILE']=$Pgpass
    if ($Password) { $psi.Environment['PGPASSWORD']=$Password }
    foreach ($arg in @('-X','-w','-h','127.0.0.1','-p',"$Port",'-U','issue48','-d','postgres','-tAc','SELECT 1')) { $psi.ArgumentList.Add($arg) }
    $process=[Diagnostics.Process]::Start($psi)
    try {
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(15000)) { $process.Kill(); throw 'Owned psql probe timed out.' }
        $log = Join-Path $qa "$Name.log"
        [IO.File]::WriteAllText($log, $stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult())
        [ordered]@{exit_code=$process.ExitCode;log=$log;sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant();query='SELECT 1';credential_delivery='private PGPASSFILE or deliberately wrong per-child environment; no credential value in arguments or logs'}
    } finally { $process.Dispose() }
}
Save-Receipt
try {
    for ($i=0;$i -lt 2;$i++) {
        $variant = @('baseline','corrected')[$i]
        $scriptPath = Join-Path $PSScriptRoot @('qa-pr359-stack-r1.ps1','qa-pr359-stack-r2.ps1')[$i]
        $tokens=$null; $parseErrors=$null
        $ast=[Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$parseErrors)
        if ($parseErrors.Count) { throw 'Fixture supervisor does not parse.' }
        $commands=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.Extent.Text.StartsWith("& (Join-Path `$pg 'initdb.exe')")},$true))
        if ($commands.Count -ne 1) { throw 'Expected one exact initdb command.' }
        $command=$commands[0].Extent.Text
        $expected=@('--auth=trust','--auth=scram-sha-256')[$i]
        if (!$command.Contains($expected)) { throw 'Unexpected historical authentication configuration.' }
        $qa=Join-Path $root $variant
        New-Item -ItemType Directory -Path $qa | Out-Null
        $commandFile=Join-Path $qa 'initdb-command.ps1'
        [IO.File]::WriteAllText($commandFile,$command,[Text.UTF8Encoding]::new($false))
        $passwordPath=Join-Path $qa 'postgres-password.txt'
        $pgpassPath=Join-Path $qa 'pgpass.conf'
        $databasePassword=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
        [IO.File]::WriteAllText($passwordPath,$databasePassword,[Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($pgpassPath,"127.0.0.1:$($ports[$i]):*:issue48:$databasePassword`n",[Text.UTF8Encoding]::new($false))
        $databasePassword=$null
        $record=$null
        $case=[ordered]@{variant=$variant;supervisor_file=[IO.Path]::GetFileName($scriptPath);supervisor_sha256=(Get-FileHash -LiteralPath $scriptPath).Hash.ToLowerInvariant();command=$command;command_sha256=(Get-FileHash -LiteralPath $commandFile).Hash.ToLowerInvariant();started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');port=$ports[$i];cleanup='pending'}
        $receipt.cases+=,$case
        try {
            $initLog=Join-Path $qa 'initdb.log'
            & ([scriptblock]::Create($command)) *> $initLog
            $case.initdb_exit=$LASTEXITCODE
            $case.initdb_log_sha256=(Get-FileHash -LiteralPath $initLog).Hash.ToLowerInvariant()
            if ($case.initdb_exit) { throw 'Exact initdb command failed; evidence retained.' }
            $record=Start-LocalOwnedProcess -Role postgres -Workspace $qa -FilePath (Join-Path $pg 'postgres.exe') -ArgumentList @('-D',(Join-Path $qa 'database'),'-h','127.0.0.1','-p',"$($ports[$i])") -WorkingDirectory $qa -LogDirectory (Join-Path $qa 'logs') -Environment @{}
            $case.process=$record
            Save-Receipt
            $deadline=[DateTimeOffset]::UtcNow.AddSeconds(30)
            do {
                & (Join-Path $pg 'pg_isready.exe') -h 127.0.0.1 -p $ports[$i] -U issue48 *> $null
                if ($LASTEXITCODE -eq 0) { break }
                Start-Sleep -Milliseconds 100
            } while ([DateTimeOffset]::UtcNow -lt $deadline)
            if ($LASTEXITCODE -ne 0) { throw 'Fresh owned PostgreSQL did not become ready.' }
            $owners=@(Get-NetTCPConnection -State Listen -LocalPort $ports[$i] | Select-Object -ExpandProperty OwningProcess -Unique)
            if ($owners.Count -ne 1 -or $owners[0] -ne $record.pid -or !(Test-LocalOwnedProcess -Record $record -Workspace $qa)) { throw 'Listener ownership mismatch.' }
            $case.wrong_password=Client 'wrong-password' $ports[$i] (Join-Path $qa 'absent.pgpass') 'wrong-owned-fixture-probe'
            $case.correct_password=Client 'correct-password' $ports[$i] $pgpassPath ''
            $case.wrong_password_accepted=($case.wrong_password.exit_code -eq 0)
            $case.expected_result_observed=($case.correct_password.exit_code -eq 0 -and $case.wrong_password_accepted -eq ($i -eq 0))
            if (!$case.expected_result_observed) { throw 'Authentication retrospective did not match expected behavior.' }
        } finally {
            if ($record -and (Test-LocalOwnedProcess -Record $record -Workspace $qa)) {
                & (Join-Path $pg 'pg_ctl.exe') -D (Join-Path $qa 'database') -m fast -w stop *> (Join-Path $qa 'cleanup.log')
                if ($LASTEXITCODE) { throw 'Owned PostgreSQL cleanup failed; fixture retained.' }
            }
            $remaining=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $ports[$i])
            if ($record -and ((Test-LocalOwnedProcess -Record $record -Workspace $qa) -or $remaining.Count)) { throw 'Cleanup could not be verified.' }
            $case.cleanup='Exact owned process stopped and port verified free; database, credentials and evidence retained in the private fixture root.'
            $case.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
            Save-Receipt
        }
    }
    $receipt.status='passed'
} catch {
    $receipt.status='failed'; $receipt.error=$_.Exception.Message
    throw
} finally { $receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o'); Save-Receipt }
$receipt | ConvertTo-Json -Depth 20
