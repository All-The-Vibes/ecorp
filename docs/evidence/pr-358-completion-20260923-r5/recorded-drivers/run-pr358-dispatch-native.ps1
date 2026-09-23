param([Parameter(Mandatory)][ValidatePattern('^r[0-9]+$')][string]$Revision)
$ErrorActionPreference='Stop'
$product='C:\Users\shyamsridhar\code\ecorp-pr358-completion-20260922'
$qa="C:\Users\shyamsridhar\code\qa\pr358-dispatch-store-20260923-$Revision"
$target='C:\Users\shyamsridhar\code\ecorp-pr338-completion-20260922\target-validation'
$pg='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$prefix="pr358-dispatch-native-$Revision"
$receiptPath=Join-Path $PSScriptRoot "$prefix.json"
$port=59110
if((Test-Path -LiteralPath $qa) -or (Test-Path -LiteralPath $receiptPath)){throw 'Preserve earlier fixture and evidence.'}
if((& git -C $product diff --name-only) -or (& git -C $product diff --name-only --diff-filter=U)){throw 'Stage source before testing.'}
$tree=(& git -C $product write-tree).Trim()
if($LASTEXITCODE){throw 'Cannot bind the staged source.'}
if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq $port).Count){throw 'Fixture port occupied; nothing stopped.'}
foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)){
    if($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS')){
        [Environment]::SetEnvironmentVariable($name,$null,'Process')
    }
}
$env:PATH=$pg+';'+$env:PATH
$env:CARGO_TARGET_DIR=$target
$env:CARGO_BUILD_JOBS='2'
$env:RUST_TEST_THREADS='1'
Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force -DisableNameChecking
New-Item -ItemType Directory -Path $qa|Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $qa /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if($LASTEXITCODE){throw 'Cannot protect the owned fixture.'}
foreach($directory in @('logs','credentials')){New-Item -ItemType Directory -Path (Join-Path $qa $directory)|Out-Null}
$receipt=[ordered]@{pr=358;purpose='Aggregate/source-correction owned PostgreSQL regressions';source_head=(& git -C $product rev-parse HEAD).Trim();tested_staged_tree=$tree;qa_root=$qa;target=$target;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');status='running';checks=@();cleanup='pending'}
$state=@{schema_version=2;workspace=$qa;purpose='pr358-dispatch-store';test_owned=$true;processes=@{};plan=@{database=@{host='127.0.0.1';port=$port;user='dispatch358';name='postgres'}}}
$record=Join-Path $qa 'ownership.json'
function Save-Receipt{$receipt|ConvertTo-Json -Depth 24|Set-Content -LiteralPath $receiptPath -Encoding utf8}
function Check([string]$Name,[string]$Log,[int]$Code){
    $receipt.checks+=@{name=$Name;exit_code=$Code;log=$Log;sha256=(Get-FileHash -LiteralPath $Log).Hash.ToLowerInvariant()}
    Save-Receipt
    Write-Output "$Name exit=$Code"
    if($Code){throw "$Name failed; retained the fixture and logs."}
}
Save-Receipt
$secret=$null
$mutex=$null
$held=$false
try{
    $secret=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $passwordPath=Join-Path $qa 'credentials/postgres-password.txt'
    $passfile=Join-Path $qa 'credentials/pgpass.conf'
    [IO.File]::WriteAllText($passwordPath,$secret,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($passfile,"127.0.0.1:${port}:*:dispatch358:$secret`n",[Text.UTF8Encoding]::new($false))
    $log=Join-Path $PSScriptRoot "$prefix-initdb.log"
    & (Join-Path $pg 'initdb.exe') -D (Join-Path $qa 'database') -U dispatch358 --auth=scram-sha-256 --encoding=UTF8 --locale=C --pwfile=$passwordPath *> $log
    Check 'owned-postgresql-initialization' $log $LASTEXITCODE
    $state.processes.postgres=Start-LocalOwnedProcess -Role 'postgres' -Workspace $qa -FilePath (Join-Path $pg 'postgres.exe') -ArgumentList @('-D',(Join-Path $qa 'database'),'-h','127.0.0.1','-p',"$port") -WorkingDirectory $qa -LogDirectory (Join-Path $qa 'logs') -Environment @{}
    Save-LocalStackState -Path $record -State $state -Workspace $qa
    $ready=$false
    $deadline=[DateTimeOffset]::UtcNow.AddSeconds(30)
    do{
        & (Join-Path $pg 'pg_isready.exe') -h 127.0.0.1 -p $port -U dispatch358 *> $null
        if($LASTEXITCODE -eq 0){$ready=$true;break}
        Start-Sleep -Milliseconds 200
    }while([DateTimeOffset]::UtcNow -lt $deadline)
    if(!$ready -or !(Test-LocalOwnedProcess -Record $state.processes.postgres -Workspace $qa)){throw 'Owned PostgreSQL readiness failed.'}
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port|Select-Object -ExpandProperty OwningProcess -Unique)
    if($listeners.Count -ne 1 -or $listeners[0] -ne $state.processes.postgres.pid){throw 'Listener does not match exact owned PostgreSQL.'}
    $env:PGPASSFILE=Join-Path $qa 'credentials/nonexistent.pgpass'
    $env:PGPASSWORD='invalid-owned-fixture-probe'
    & (Join-Path $pg 'psql.exe') -X -w -h 127.0.0.1 -p $port -U dispatch358 -d postgres -c 'SELECT 1' *> $null
    if($LASTEXITCODE -eq 0){throw 'Incorrect database password was accepted.'}
    Remove-Item -LiteralPath Env:PGPASSWORD
    $env:PGPASSFILE=$passfile
    & (Join-Path $pg 'psql.exe') -X -w -h 127.0.0.1 -p $port -U dispatch358 -d postgres -c 'SELECT 1' *> $null
    if($LASTEXITCODE){throw 'Owned database authentication failed.'}
    $receipt.authentication=@{method='scram-sha-256';wrong_password_rejected=$true;authenticated_query=$true;delivery='Private PGPASSFILE for native clients; SQLx environment-only delivery is reduced assurance.'}
    Save-Receipt
    $key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($target).ToLowerInvariant())))
    $mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
    try{$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
    Set-Location -LiteralPath $product
    $log=Join-Path $PSScriptRoot "$prefix-workspace-cache-refresh.log"
    & cargo clean --workspace --target-dir $target *> $log
    Check 'workspace-cache-refresh' $log $LASTEXITCODE
    $env:DATABASE_URL="postgres://dispatch358:${secret}@127.0.0.1:$port/postgres"
    foreach($check in @(
        @{name='source-correction-enqueue';arguments=@('test','--locked','-p','crony-store','issue56_source_correction_','--','--ignored','--test-threads=1');expected=3},
        @{name='aggregate';arguments=@('test','--locked','-p','crony-store','issue56_','--','--ignored','--test-threads=1');expected=31},
        @{name='correction-authority';arguments=@('test','--locked','-p','crony-store','issue210_dispatch_','--','--ignored','--test-threads=1')},
        @{name='source-only-publication';arguments=@('test','--locked','-p','crony-store','issue216_ordinary_source_only_predecessor_correction_stop_checkpoint_publication_succeeds','--','--ignored','--test-threads=1');expected=1},
        @{name='exhausted-retry';arguments=@('test','--locked','-p','crony-store','issue221_retry_does_not_reset_exhausted_','--','--ignored','--test-threads=1');expected=2},
        @{name='correction-usage';arguments=@('test','--locked','-p','crony-store','issue210_correction_provider_usage_consumes_allocation_without_zero_exemption','--','--ignored','--test-threads=1');expected=1},
        @{name='resume-budget';arguments=@('test','--locked','-p','crony-store','issue169_resume_rejects_accounted_budget_exhaustion','--','--ignored','--test-threads=1');expected=1}
    )){
        $log=Join-Path $PSScriptRoot "$prefix-$($check.name).log"
        $arguments=$check.arguments
        & cargo @arguments 2>&1 | ForEach-Object{([string]$_).Replace($secret,'[ephemeral database credential]')} | Set-Content -LiteralPath $log -Encoding utf8
        Check "owned-postgresql-$($check.name)" $log $LASTEXITCODE
        $result=Get-Content -LiteralPath $log -Raw
        if($result -notmatch 'test result: ok\. ([1-9][0-9]*) passed; 0 failed; 0 ignored;') { throw 'The selected local regression did not execute.' }
        if($check.expected -and [int]$Matches[1] -ne $check.expected) { throw "Unexpected executed count for $($check.name)." }
    }
    if((& git -C $product write-tree).Trim() -ne $tree -or (& git -C $product diff --name-only)){throw 'Source changed during the native tests.'}
    $receipt.source_unchanged=$true
    $receipt.status='passed'
}catch{
    $receipt.status='failed'
    $receipt.failure=[regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')
}finally{
    if($held){$mutex.ReleaseMutex()}
    if($null -ne $mutex){$mutex.Dispose()}
    Remove-Item -LiteralPath Env:DATABASE_URL,Env:PGPASSFILE,Env:PGPASSWORD -ErrorAction SilentlyContinue
    $secret=$null
    if($state.processes.postgres){
        try{
            if(!(Test-LocalOwnedProcess -Record $state.processes.postgres -Workspace $qa)){throw 'Ownership cannot be verified.'}
            $log=Join-Path $PSScriptRoot "$prefix-stop.log"
            & (Join-Path $pg 'pg_ctl.exe') -D (Join-Path $qa 'database') -m fast -w stop *> $log
            if($LASTEXITCODE){throw 'Owned PostgreSQL stop failed.'}
            $state.stopped_at=[DateTimeOffset]::UtcNow.ToString('o')
            Save-LocalStackState -Path $record -State $state -Workspace $qa
            $receipt.cleanup='Only the exact owned PostgreSQL stopped; data, credentials and logs retained.'
        }catch{$receipt.status='failed';$receipt.cleanup='Could not verify cleanup; exact ownership records retained.'}
    }else{$receipt.cleanup='No PostgreSQL process created; all fixture files retained.'}
    $receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    Save-Receipt
}
$receipt|ConvertTo-Json -Depth 12
if($receipt.status -ne 'passed'){exit 1}
