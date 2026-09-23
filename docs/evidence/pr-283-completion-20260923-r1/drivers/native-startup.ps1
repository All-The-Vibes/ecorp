param([Parameter(Mandatory)][ValidatePattern('^r[0-9]+$')][string]$Revision)
$ErrorActionPreference='Stop'
$product='<reviewed-worktree>'
$qa="<local-user>\code\qa\pr283-startup-20260922-$Revision"
$target='<local-user>\code\ecorp-pr324-completion-20260922\target-validation'
$pg='<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$python='<local-user>\AppData\Local\Programs\Python\Python312\python.exe'
$openssl='C:\Program Files\Git\mingw64\bin\openssl.exe'
$prefix="pr283-native-startup-$Revision"
$receiptPath=Join-Path $PSScriptRoot "$prefix.json"
$port=59061
if((Test-Path -LiteralPath $qa) -or (Test-Path -LiteralPath $receiptPath)){throw 'Preserve previous fixture and evidence.'}
if((& git -C $product diff --name-only) -or (& git -C $product diff --name-only --diff-filter=U)){throw 'Stage source before testing.'}
$tree=(& git -C $product write-tree).Trim()
if($LASTEXITCODE){throw 'Cannot bind staged source.'}
if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq $port).Count){throw 'Fixture port occupied; nothing stopped.'}
foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)){
    if($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS','PYTHONOPTIMIZE','PYTHONPATH','OPENSSL_CONF')){
        [Environment]::SetEnvironmentVariable($name,$null,'Process')
    }
}
$env:PATH=$pg+';'+$env:PATH
$env:OPENSSL_CONF='C:\Program Files\Git\mingw64\etc\ssl\openssl.cnf'
$env:CARGO_TARGET_DIR=$target
$env:CARGO_BUILD_JOBS='2'
$env:RUST_TEST_THREADS='1'
Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force -DisableNameChecking
New-Item -ItemType Directory -Path $qa|Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $qa /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if($LASTEXITCODE){throw 'Cannot protect owned fixture.'}
foreach($directory in @('logs','credentials','binaries')){New-Item -ItemType Directory -Path (Join-Path $qa $directory)|Out-Null}
$driver=Join-Path $product 'tools/test_startup_validation.py'
$adapter=Join-Path $PSScriptRoot 'pr283-native-startup.py'
$receipt=[ordered]@{pr=283;purpose='real-binary startup assertions on owned native PostgreSQL';source_head=(& git -C $product rev-parse HEAD).Trim();tested_staged_tree=$tree;driver_sha256=(Get-FileHash -LiteralPath $driver).Hash.ToLowerInvariant();adapter_sha256=(Get-FileHash -LiteralPath $adapter).Hash.ToLowerInvariant();qa_root=$qa;target=$target;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');status='running';checks=@();cleanup='pending'}
$state=@{schema_version=2;workspace=$qa;purpose='pr283-startup-validation';test_owned=$true;processes=@{};plan=@{database=@{host='127.0.0.1';port=$port;user='fixture';name='fixture_admin'}}}
$record=Join-Path $qa 'ownership.json'
function Save-Receipt{$receipt|ConvertTo-Json -Depth 24|Set-Content -LiteralPath $receiptPath -Encoding utf8}
function Check([string]$Name,[string]$Log,[int]$Code){
    $receipt.checks+=@{name=$Name;exit_code=$Code;log=$Log;sha256=(Get-FileHash -LiteralPath $Log).Hash.ToLowerInvariant()}
    Save-Receipt
    Write-Output "$Name exit=$Code"
    if($Code){throw "$Name failed; fixture and logs retained."}
}
Save-Receipt
$secret=$null
$mutex=$null
$held=$false
try{
    $key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($target).ToLowerInvariant())))
    $mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
    try{$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
    Set-Location -LiteralPath $product
    $log=Join-Path $PSScriptRoot "$prefix-workspace-cache-refresh.log"
    & cargo clean --workspace --target-dir $target *> $log
    Check 'workspace-cache-refresh' $log $LASTEXITCODE
    # Build the server alone: workspace feature unification changes TLS behavior.
    $log=Join-Path $PSScriptRoot "$prefix-server-build.log"
    & cargo build --locked -p crony-server --bin crony-server *> $log
    Check 'standalone-server-build' $log $LASTEXITCODE
    $binary=Join-Path $qa 'binaries/crony-server.exe'
    Copy-Item -LiteralPath (Join-Path $target 'debug/crony-server.exe') -Destination $binary
    $receipt.binary_sha256=(Get-FileHash -LiteralPath $binary).Hash.ToLowerInvariant()
    $mutex.ReleaseMutex()
    $held=$false
    Save-Receipt
    $secret=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $passwordPath=Join-Path $qa 'credentials/postgres-password.txt'
    $passfile=Join-Path $qa 'credentials/pgpass.conf'
    [IO.File]::WriteAllText($passwordPath,$secret,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($passfile,"127.0.0.1:${port}:*:fixture:$secret`n",[Text.UTF8Encoding]::new($false))
    $log=Join-Path $PSScriptRoot "$prefix-initdb.log"
    & (Join-Path $pg 'initdb.exe') -D (Join-Path $qa 'database') -U fixture --auth=scram-sha-256 --encoding=UTF8 --locale=C --pwfile=$passwordPath *> $log
    Check 'owned-postgresql-initialization' $log $LASTEXITCODE
    $state.processes.postgres=Start-LocalOwnedProcess -Role 'postgres' -Workspace $qa -FilePath (Join-Path $pg 'postgres.exe') -ArgumentList @('-D',(Join-Path $qa 'database'),'-h','127.0.0.1','-p',"$port") -WorkingDirectory $qa -LogDirectory (Join-Path $qa 'logs') -Environment @{}
    Save-LocalStackState -Path $record -State $state -Workspace $qa
    $ready=$false
    $deadline=[DateTimeOffset]::UtcNow.AddSeconds(30)
    do{
        & (Join-Path $pg 'pg_isready.exe') -h 127.0.0.1 -p $port -U fixture *> $null
        if($LASTEXITCODE -eq 0){$ready=$true;break}
        Start-Sleep -Milliseconds 200
    }while([DateTimeOffset]::UtcNow -lt $deadline)
    if(!$ready -or !(Test-LocalOwnedProcess -Record $state.processes.postgres -Workspace $qa)){throw 'Owned PostgreSQL readiness failed.'}
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port|Select-Object -ExpandProperty OwningProcess -Unique)
    if($listeners.Count -ne 1 -or $listeners[0] -ne $state.processes.postgres.pid){throw 'Listener does not match exact owned PostgreSQL.'}
    $env:PGPASSFILE=Join-Path $qa 'credentials/nonexistent.pgpass'
    $env:PGPASSWORD='invalid-owned-fixture-probe'
    & (Join-Path $pg 'psql.exe') -X -w -h 127.0.0.1 -p $port -U fixture -d postgres -c 'SELECT 1' *> $null
    if($LASTEXITCODE -eq 0){throw 'Incorrect password accepted.'}
    Remove-Item -LiteralPath Env:PGPASSWORD
    $env:PGPASSFILE=$passfile
    & (Join-Path $pg 'createdb.exe') -w -h 127.0.0.1 -p $port -U fixture fixture_admin *> $null
    if($LASTEXITCODE){throw 'Owned maintenance database initialization failed.'}
    $receipt.authentication=@{method='scram-sha-256';wrong_password_rejected=$true;delivery='Native clients use private PGPASSFILE; isolated server child environment delivery is reduced assurance.'}
    $config=@{qa_root=$qa;product=$product;driver_sha256=$receipt.driver_sha256;binary=$binary;binary_sha256=$receipt.binary_sha256;postgres_pid=$state.processes.postgres.pid;port=$port;postgres_bin=$pg;openssl=$openssl;nonce=[guid]::NewGuid().ToString('N')}
    $configPath=Join-Path $qa 'startup-fixture.json'
    $config|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $configPath -Encoding utf8
    $env:ECORP_STARTUP_FIXTURE_CONFIG=$configPath
    Save-Receipt
    $log=Join-Path $PSScriptRoot "$prefix-assertions.log"
    & $python -X utf8 -B $adapter 2>&1 | ForEach-Object{([string]$_).Replace($secret,'[ephemeral database credential]')} | Set-Content -LiteralPath $log -Encoding utf8
    Check 'unchanged-startup-assertions-native-transport' $log $LASTEXITCODE
    if((& git -C $product write-tree).Trim() -ne $tree -or (& git -C $product diff --name-only)){throw 'Source changed during startup validation.'}
    $receipt.source_unchanged=$true
    $receipt.status='passed'
}catch{
    $receipt.status='failed'
    $receipt.failure=[regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')
}finally{
    if($held){$mutex.ReleaseMutex()}
    if($null -ne $mutex){$mutex.Dispose()}
    Remove-Item -LiteralPath Env:PGPASSFILE,Env:PGPASSWORD,Env:ECORP_STARTUP_FIXTURE_CONFIG -ErrorAction SilentlyContinue
    $secret=$null
    if($state.processes.postgres){
        try{
            if(!(Test-LocalOwnedProcess -Record $state.processes.postgres -Workspace $qa)){throw 'Ownership cannot be verified.'}
            $log=Join-Path $PSScriptRoot "$prefix-stop.log"
            & (Join-Path $pg 'pg_ctl.exe') -D (Join-Path $qa 'database') -m fast -w stop *> $log
            if($LASTEXITCODE){throw 'Owned PostgreSQL stop failed.'}
            $state.stopped_at=[DateTimeOffset]::UtcNow.ToString('o')
            Save-LocalStackState -Path $record -State $state -Workspace $qa
            $receipt.cleanup='Only the exact owned PostgreSQL stopped; database, credentials, binaries, cases and logs retained.'
        }catch{$receipt.status='failed';$receipt.cleanup='Could not verify cleanup; exact ownership records retained.'}
    }else{$receipt.cleanup='No PostgreSQL process created; files and build logs retained.'}
    $receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    Save-Receipt
}
$receipt|ConvertTo-Json -Depth 12
if($receipt.status -ne 'passed'){exit 1}
