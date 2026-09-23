#requires -Version 7.5
$ErrorActionPreference='Stop'
$repo='C:\Users\shyamsridhar\code\ecorp-pr293-completion-20260922'
$run=Join-Path $PSScriptRoot 'pr293-full-native-r5'
$pg='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$node='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe'
$hostRoot=Join-Path $env:USERPROFILE '.copilot/session-state/ecorp-pr293-20260923-r5/files/native'
$output=Join-Path $repo 'output/native-qualification/phase2-r5'
$cluster=Join-Path $run 'postgres'
$receiptPath=Join-Path $run 'acceptance-run.json'
$stack=Join-Path $run 'native_qualification_stack.ps1'
if((Test-Path -LiteralPath $receiptPath) -or (Test-Path -LiteralPath $cluster) -or (Test-Path -LiteralPath $output) -or (Test-Path -LiteralPath $hostRoot)) {throw 'Preserve prior fixtures; this attempt requires fresh paths.'}
Import-Module (Join-Path $repo 'tools/local_stack.psm1') -Force -DisableNameChecking
$build=Get-Content -LiteralPath (Join-Path $run 'build-receipt.json') -Raw|ConvertFrom-Json
if($build.status -ne 'passed' -or (& git -C $repo write-tree).Trim() -cne $build.staged_tree -or (& git -C $repo diff --name-only)) {throw 'Native source changed after build.'}
foreach($binary in $build.binaries){
  $file=Join-Path $repo "target-native-qualification/debug/$($binary.name).exe"
  if((Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant() -cne $binary.sha256){throw 'Native binary changed after build.'}
}
$adaptations=Get-Content -LiteralPath (Join-Path $run 'driver-adaptations.json') -Raw|ConvertFrom-Json
foreach($file in $adaptations.files){
  if((Get-FileHash -LiteralPath (Join-Path $repo $file.source)).Hash.ToLowerInvariant() -cne $file.source_sha256 -or
     (Get-FileHash -LiteralPath (Join-Path $run $file.adapted)).Hash.ToLowerInvariant() -cne $file.adapted_sha256){throw 'Reviewed driver adaptation changed.'}
}
$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -in @(8992,5298,55483,18557,18558,18559,18560))
if($listeners.Count){throw 'A qualification port is occupied; preserve the existing service.'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $run /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if($LASTEXITCODE){throw 'Cannot restrict the local evidence fixture.'}
$env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
$env:CRONY_NATIVE_QUALIFICATION='1'
$env:CRONY_SERVER_HTTP='http://127.0.0.1:8992'
$env:CRONY_NATIVE_WEB='http://127.0.0.1:5298'
$env:CRONY_NATIVE_HOST_DIRECTORY=$hostRoot
$env:CRONY_NATIVE_OUTPUT=$output
$env:CRONY_PLAYWRIGHT_MODULE='C:\Users\shyamsridhar\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
foreach($name in @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGPASSFILE','PGSERVICE','PGSERVICEFILE','PGOPTIONS')){
  Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}
$receipt=[ordered]@{schema_version=1;pr=293;source_head=$build.head;staged_tree=$build.staged_tree;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');status='running';steps=@();docker_executed=$false;fixture='Owned portable PostgreSQL 17.10, loopback trust authentication (reduced assurance), development actors, deterministic runner, local Anvil, memory signer, synthetic fee oracle and GitHub; no production qualification.'}
function Save { $receipt|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
function Step([string]$Name,[scriptblock]$Command){
  $log=Join-Path $run "$Name.log"
  if(Test-Path -LiteralPath $log){throw 'Preserve prior step evidence.'}
  $entry=[ordered]@{name=$Name;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');status='running';log=$log}
  $receipt.steps+=@($entry)
  Save
  Write-Output "PR #293 native acceptance: $Name"
  $global:LASTEXITCODE=0
  try {
    & $Command *> $log
    $entry.exit_code=$LASTEXITCODE
    if($LASTEXITCODE){throw "$Name returned nonzero exit."}
    $entry.status='passed'
  }catch{
    $entry.status='failed'
    $entry.reason=$_.Exception.Message
    throw
  }finally{
    $entry.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    if(Test-Path -LiteralPath $log){$entry.sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()}
    Save
  }
}
function Capture-Restart([string]$Stage,[string]$Boundary){
  $state=Get-Content -LiteralPath (Join-Path $output 'processes.json') -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  foreach($role in @('server','runner','gateway','anvilNode','github','web')){
    if(!(Test-LocalOwnedProcess -Record $state.processes[$role] -Workspace $repo)){throw 'Restart capture requires exact live ownership.'}
  }
  $record=[ordered]@{captured_at_utc=[DateTimeOffset]::UtcNow.ToString('o');processes=$state.processes}
  if($Stage -eq 'signing'){
    $metrics=Invoke-RestMethod 'http://127.0.0.1:18560/qualification/metrics' -TimeoutSec 5
    $record.gateway=@{journal_committed=$metrics.journal_committed;response_held=$metrics.response_held;signatures=$metrics.signatures}
    $count=& (Join-Path $pg 'psql.exe') -XwqAt -h 127.0.0.1 -p 55483 -U postgres -d native_foreground_runtime_20260917 -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM base_audit_signed_results'
    if($LASTEXITCODE -or $count -notmatch '^\d+$'){throw 'Cannot read application signed-result count.'}
    $record.application_signed_results=[int]$count
    if($Boundary -eq 'before' -and ($record.application_signed_results -ne 0 -or !$metrics.journal_committed -or !$metrics.response_held -or $metrics.signatures -ne 1)){throw 'The native lost-reply boundary was not observed.'}
  }
  if($Stage -eq 'broadcast'){
    $runtime=Get-Content -LiteralPath (Join-Path $output 'runtime-qualification.json') -Raw|ConvertFrom-Json -AsHashtable -DateKind String
    $record.pending=$runtime.pending_broadcast
    $rpc=@{jsonrpc='2.0';id=1;method='eth_getTransactionByHash';params=@($record.pending.hash)}|ConvertTo-Json -Compress
    $tx=(Invoke-RestMethod 'http://127.0.0.1:18557' -Method Post -ContentType 'application/json' -Body $rpc -TimeoutSec 5).result
    $rpc=@{jsonrpc='2.0';id=1;method='eth_getTransactionReceipt';params=@($record.pending.hash)}|ConvertTo-Json -Compress
    $txReceipt=(Invoke-RestMethod 'http://127.0.0.1:18557' -Method Post -ContentType 'application/json' -Body $rpc -TimeoutSec 5).result
    $metrics=Invoke-RestMethod 'http://127.0.0.1:18560/qualification/metrics' -TimeoutSec 5
    if(!$tx -or $tx.hash -cne $record.pending.hash -or $tx.nonce -cne $record.pending.nonce -or $null -ne $tx.blockHash -or $null -ne $txReceipt -or $metrics.signatures -ne 1){throw 'Pending transaction boundary changed.'}
  }
  $directory=Join-Path $output 'restart-evidence'
  New-Item -ItemType Directory -Path $directory -Force|Out-Null
  $file=Join-Path $directory "$Stage-restart-$Boundary.json"
  if(Test-Path -LiteralPath $file){throw 'Preserve earlier restart evidence.'}
  $record|ConvertTo-Json -Depth 30|Set-Content -LiteralPath $file -Encoding utf8
}
Save
try{
  Step 'initialize-postgres' {
    & (Join-Path $pg 'initdb.exe') -D $cluster -U postgres --auth=trust --encoding=UTF8 --locale=C
    if($LASTEXITCODE){throw 'Fresh owned PostgreSQL initialization failed.'}
    $record=Start-LocalOwnedProcess -Role 'postgres-pr293-native-r5' -Workspace $run -FilePath (Join-Path $pg 'postgres.exe') -ArgumentList @('-D',$cluster,'-h','127.0.0.1','-p','55483','-c','timezone=UTC') -WorkingDirectory $run -LogDirectory (Join-Path $run 'postgres-logs') -Environment @{}
    $record|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $run 'postgres-ownership.json') -Encoding utf8
    $deadline=[DateTimeOffset]::UtcNow.AddSeconds(45)
    do{
      & (Join-Path $pg 'pg_isready.exe') -h 127.0.0.1 -p 55483 -U postgres *> $null
      if($LASTEXITCODE -eq 0){break}
      Start-Sleep -Milliseconds 250
    }while([DateTimeOffset]::UtcNow -lt $deadline)
    if($LASTEXITCODE -or !(Test-LocalOwnedProcess -Record $record -Workspace $run)){throw 'Exact PostgreSQL owner did not become ready.'}
    $owners=@(Get-NetTCPConnection -State Listen -LocalPort 55483 -ErrorAction Stop|Select-Object -ExpandProperty OwningProcess -Unique)
    if($owners.Count -ne 1 -or $owners[0] -ne $record.pid){throw 'Unexpected PostgreSQL listener owner.'}
  }
  Step 'stack-start' { & $stack -Action start -HostDirectory $hostRoot }
  Step 'browser-prepare' { & $node (Join-Path $run 'e2e_native_qualification_browser.mjs') --phase prepare }
  Step 'runtime-audit' { & $node (Join-Path $run 'e2e_native_qualification.mjs') --phase audit }
  Step 'fixture-start' { & $stack -Action fixture -HostDirectory $hostRoot }
  Step 'configuration-restart' { & $stack -Action restart -HostDirectory $hostRoot }
  Step 'runtime-request' { & $node (Join-Path $run 'e2e_native_qualification.mjs') --phase request }
  Step 'signing-restart' { Capture-Restart signing before; & $stack -Action restart -HostDirectory $hostRoot; Capture-Restart signing after }
  Step 'runtime-broadcast' { & $node (Join-Path $run 'e2e_native_qualification.mjs') --phase broadcast }
  Step 'broadcast-restart' { Capture-Restart broadcast before; & $stack -Action restart -HostDirectory $hostRoot; Capture-Restart broadcast after }
  Step 'runtime-recover' { & $node (Join-Path $run 'e2e_native_qualification.mjs') --phase recover }
  Step 'final-restart' { Capture-Restart final before; & $stack -Action restart -HostDirectory $hostRoot; Capture-Restart final after }
  Step 'begin-readbacks' { & $node (Join-Path $run 'native_qualification_attempt.mjs') --begin }
  Step 'runtime-readback' { & $node (Join-Path $run 'e2e_native_qualification.mjs') --phase readback }
  Step 'archive-readback' { & $node (Join-Path $run 'e2e_native_archive.mjs') }
  Step 'browser-readback' { & $node (Join-Path $run 'e2e_native_qualification_browser.mjs') --phase readback }
  Step 'acceptance' { & $node (Join-Path $run 'native_qualification_acceptance.mjs') }
  if((& git -C $repo write-tree).Trim() -cne $build.staged_tree -or (& git -C $repo diff --name-only)){throw 'Source changed during native acceptance.'}
  $receipt.acceptance_sha256=(Get-FileHash -LiteralPath (Join-Path $output 'acceptance.json')).Hash.ToLowerInvariant()
  $receipt.status='passed'
}catch{
  $receipt.status='failed'
  $receipt.reason=$_.Exception.Message
  Write-Output 'Native qualification stopped at a failed step; all fixture resources and evidence are retained.'
}finally{
  $receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
  Save
}
[ordered]@{status=$receipt.status;last_step=$receipt.steps[-1].name;receipt=$receiptPath}|ConvertTo-Json -Compress
if($receipt.status -ne 'passed'){exit 1}
