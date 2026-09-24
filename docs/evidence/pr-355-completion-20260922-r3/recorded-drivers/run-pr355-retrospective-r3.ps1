#requires -Version 7.4
$ErrorActionPreference='Stop'
$product='C:\Users\shyamsridhar\code\ecorp-pr355-completion-20260922'
$baseline='C:\Users\shyamsridhar\code\ecorp-pr355-retrospective-20260922-r1'
$pg='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$target='C:\Users\shyamsridhar\code\ecorp-pr338-completion-20260922\target-validation'
$root=Join-Path $PSScriptRoot 'pr355-retrospective-r2'
$qa='C:\Users\shyamsridhar\code\qa\pr355-retrospective-20260922-r2'
$receiptPath=Join-Path $root 'receipt.json'
$manifestPath=Join-Path $root 'source-manifest.json'
$manifest=Get-Content -Raw -LiteralPath $manifestPath|ConvertFrom-Json
$port=59476
if((Test-Path -LiteralPath $qa) -or (Test-Path -LiteralPath $receiptPath)){throw 'Preserve earlier fixtures and receipts.'}
foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)){
  if($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
}
$env:CARGO_TARGET_DIR=$target
$env:CARGO_BUILD_JOBS='2'
$env:RUST_TEST_THREADS='1'
$env:PATH=$pg+';'+$env:PATH
if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq $port).Count){throw 'Selected port is occupied.'}
foreach($entry in @(@{repo=$baseline;tree=$manifest.baseline_tested_tree},@{repo=$product;tree=$manifest.candidate_tested_tree})){
  if((& git -C $entry.repo write-tree).Trim() -cne $entry.tree -or (& git -C $entry.repo diff --name-only)){throw 'Prepared source changed.'}
}
New-Item -ItemType Directory -Path $qa|Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $qa /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if($LASTEXITCODE){throw 'Cannot protect fixture credentials.'}
Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force -DisableNameChecking
$receipt=[ordered]@{
 status='running';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');source_manifest_sha256=(Get-FileHash -LiteralPath $manifestPath).Hash.ToLowerInvariant()
 scope='Retrospective behavioral comparison on a new, owned loopback SCRAM PostgreSQL instance. Not original TDD chronology.'
 driver_sha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant();baseline_tested_tree=$manifest.baseline_tested_tree;candidate_tested_tree=$manifest.candidate_tested_tree
 commands=@();cleanup='pending';postgres_version=((& (Join-Path $pg 'postgres.exe') --version) -join '')
}
function Save-Receipt{$receipt|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $receiptPath -Encoding utf8}
function Test-Case([string]$Repository,[string]$Name,[string]$Filter,[string]$Expected){
  $log=Join-Path $root "$Name.log"
  if(Test-Path -LiteralPath $log){throw 'Preserve previous test log.'}
  $arguments=@('test','--locked','-p','crony-store',$Filter,'--','--ignored','--nocapture','--test-threads=1')
  if($Expected -ne 'three-pass'){$arguments+= '--exact'}
  $psi=[Diagnostics.ProcessStartInfo]::new()
  $psi.FileName=(Get-Command cargo).Source;$psi.WorkingDirectory=$Repository;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $psi.Environment['DATABASE_URL']="postgres://issue89:${databasePassword}@127.0.0.1:$port/postgres"
  foreach($argument in $arguments){$psi.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::Start($psi)
  try{
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $text=($stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult()).Replace($databasePassword,'[ephemeral database credential]')
    [IO.File]::WriteAllText($log,$text,[Text.UTF8Encoding]::new($false))
    $exitCode=$process.ExitCode
  }finally{$process.Dispose()}
  $observed=switch($Expected){
    'one-pass' {$exitCode -eq 0 -and $text -match 'test result: ok\. 1 passed; 0 failed; 0 ignored;'}
    'three-pass' {$exitCode -eq 0 -and $text -match 'test result: ok\. 3 passed; 0 failed; 0 ignored;'}
    'behavioral-red' {$exitCode -ne 0 -and $text -match 'test result: FAILED\. 0 passed; 1 failed;' -and $text -match 'left: String\("ready"\)' -and $text -match 'right: "failed"' -and $text -match 'deliverable_failure_tests\.rs:178:5:'}
  }
  $receipt.commands+=@{name=$Name;repository=$Repository;tested_tree=(& git -C $Repository write-tree).Trim();program='cargo';arguments=$arguments;exit_code=$exitCode;expected=$Expected;expected_behavior_observed=[bool]$observed;log=$log;sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()}
  Save-Receipt
  Write-Output "$Name exit=$exitCode expected_behavior=$observed"
  if(!$observed){throw "$Name did not establish its expected behavioral result; logs retained."}
}
$key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())))
$mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
$held=$false;$record=$null;$databasePassword=$null
Save-Receipt
try{
  try{$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
  $databasePassword=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
  $passwordPath=Join-Path $qa 'postgres-password.txt'
  [IO.File]::WriteAllText($passwordPath,$databasePassword,[Text.UTF8Encoding]::new($false))
  & (Join-Path $pg 'initdb.exe') -D (Join-Path $qa 'database') -U issue89 --auth=scram-sha-256 --pwfile=$passwordPath *> (Join-Path $root 'initdb.log')
  $receipt.initdb_exit=$LASTEXITCODE
  if($LASTEXITCODE){throw 'Owned SCRAM database initialization failed.'}
  $record=Start-LocalOwnedProcess -Role postgres -Workspace $qa -FilePath (Join-Path $pg 'postgres.exe') -ArgumentList @('-D',(Join-Path $qa 'database'),'-h','127.0.0.1','-p',"$port") -WorkingDirectory $qa -LogDirectory (Join-Path $qa 'logs') -Environment @{}
  $receipt.process=$record;Save-Receipt
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds(30)
  do{
    & (Join-Path $pg 'pg_isready.exe') -h 127.0.0.1 -p $port -U issue89 *> $null
    if($LASTEXITCODE -eq 0){break}
    Start-Sleep -Milliseconds 100
  }while([DateTimeOffset]::UtcNow -lt $deadline)
  if($LASTEXITCODE -ne 0){throw 'Owned PostgreSQL readiness failed.'}
  $owners=@(Get-NetTCPConnection -State Listen -LocalPort $port|Select-Object -ExpandProperty OwningProcess -Unique)
  if($owners.Count -ne 1 -or $owners[0] -ne $record.pid -or !(Test-LocalOwnedProcess -Record $record -Workspace $qa)){throw 'Owned listener verification failed.'}
  Push-Location -LiteralPath $baseline
  try{& cargo clean --workspace --target-dir $target *> (Join-Path $root 'baseline-cache-refresh.log');if($LASTEXITCODE){throw 'Baseline cache refresh failed.'}}finally{Pop-Location}
  Test-Case $baseline 'baseline-ordinary-failure-control' 'deliverable_failure_tests::issue89_untyped_execution_failure_keeps_existing_retry_policy' 'one-pass'
  Test-Case $baseline 'baseline-export-failure-regression' 'deliverable_failure_tests::issue89_export_failure_retains_history_and_cannot_schedule_fresh_retry' 'behavioral-red'
  Push-Location -LiteralPath $product
  try{& cargo clean --workspace --target-dir $target *> (Join-Path $root 'candidate-cache-refresh.log');if($LASTEXITCODE){throw 'Candidate cache refresh failed.'}}finally{Pop-Location}
  Test-Case $product 'candidate-deliverable-failure-suite' 'deliverable_failure_tests::' 'three-pass'
  foreach($entry in @(@{repo=$baseline;tree=$manifest.baseline_tested_tree},@{repo=$product;tree=$manifest.candidate_tested_tree})){
    if((& git -C $entry.repo write-tree).Trim() -cne $entry.tree -or (& git -C $entry.repo diff --name-only)){throw 'Source changed during comparison.'}
  }
  $receipt.source_unchanged=$true;$receipt.status='passed'
}catch{$receipt.status='failed';$receipt.error=[regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')}
finally{
  if($record){
    try{
      if(!(Test-LocalOwnedProcess -Record $record -Workspace $qa)){throw 'Owned PostgreSQL identity no longer matches.'}
      & (Join-Path $pg 'pg_ctl.exe') -D (Join-Path $qa 'database') -m fast -w stop *> (Join-Path $root 'cleanup.log')
      if($LASTEXITCODE -or (Test-LocalOwnedProcess -Record $record -Workspace $qa) -or @(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq $port).Count){throw 'Owned cleanup could not be verified.'}
      $receipt.cleanup='Exact owned PostgreSQL stopped; listener absent. Private data, credentials, source overlays and logs preserved.'
    }catch{$receipt.cleanup=$_.Exception.Message;$receipt.status='failed'}
  }
  $databasePassword=$null
  if($held){$mutex.ReleaseMutex()};$mutex.Dispose()
  $receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Receipt
}
Write-Output "retrospective status=$($receipt.status)"
if($receipt.status -ne 'passed'){exit 1}
