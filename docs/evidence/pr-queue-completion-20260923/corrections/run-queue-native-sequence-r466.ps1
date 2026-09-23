#requires -Version 7.5
param(
 [string]$DatabaseReceipt,
 [string]$ValidationDirectory=(Join-Path $PSScriptRoot 'queue-validation-r454')
)
$ErrorActionPreference='Stop'
$repo='<reviewed-worktree>'
$validation=[IO.Path]::GetFullPath($ValidationDirectory)
if([IO.Path]::GetDirectoryName($validation) -ine [IO.Path]::GetFullPath($PSScriptRoot) -or [IO.Path]::GetFileName($validation) -notmatch '^queue-validation-r[0-9]+$'){throw 'Require a task-owned source-bound validation directory.'}
$receiptPath=Join-Path $PSScriptRoot 'queue-native-sequence-r466.json'
if(Test-Path -LiteralPath $receiptPath){throw 'Preserve earlier native sequence.'}
$v=Get-Content -LiteralPath (Join-Path $validation 'validation.json') -Raw|ConvertFrom-Json
if($v.status -ne 'passed' -or !$v.source_unchanged -or $v.checks.Count -ne 11 -or @($v.checks|Where-Object exit_code -ne 0).Count){throw 'Complete passing source-bound validation is required.'}
if((& git -C $repo write-tree).Trim() -cne $v.staged_tree -or (& git -C $repo diff --name-only)){throw 'Validated source changed.'}
$record=[ordered]@{status='running';tested_staged_tree=$v.staged_tree;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');steps=@()}
function Save {$record|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $receiptPath -Encoding utf8}
function Step([string]$Name,[scriptblock]$Action){
 $log=Join-Path $PSScriptRoot "queue-native-sequence-r466-$Name.log"
 if(Test-Path -LiteralPath $log){throw 'Preserve earlier step evidence.'}
 Write-Output "Starting $Name"
 $entry=[ordered]@{name=$Name;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');log=$log;status='running'}
 $record.steps+=@($entry);Save
 $global:LASTEXITCODE=0
 try{& $Action *> $log;$entry.exit_code=$LASTEXITCODE;if($LASTEXITCODE){throw "$Name failed."};$entry.status='passed'}
 catch{$entry.status='failed';throw}
 finally{$entry.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');if(Test-Path -LiteralPath $log){$entry.sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()};Save}
 Write-Output "$Name passed"
}
$pg='<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$target='<local-user>\code\ecorp-pr-completion-20260922\target-validation'
$node='<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64'
$playwright='<local-user>\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
try{
 Step 'native-build' {
  $priorPath=Join-Path $PSScriptRoot 'queue-native-sequence-r433.json'
  $prior=Get-Content -LiteralPath $priorPath -Raw|ConvertFrom-Json
  $buildStep=@($prior.steps|Where-Object name -eq 'native-build')
  if($buildStep.Count -ne 1 -or $buildStep[0].status -ne 'passed' -or $buildStep[0].exit_code -ne 0 -or (Get-FileHash -LiteralPath $buildStep[0].log).Hash.ToLowerInvariant() -cne $buildStep[0].sha256){throw 'Matching prior build log required.'}
  $buildPath=Join-Path $PSScriptRoot 'queue-audit-native-r466/build-receipt.json'
  $build=Get-Content -LiteralPath $buildPath -Raw|ConvertFrom-Json
  if($build.status -ne 'passed' -or $build.staged_tree -cne $v.staged_tree){throw 'Exact-source passing native build required.'}
  foreach($binary in $build.binaries){
    if((Get-FileHash -LiteralPath (Join-Path $repo "target-native-qualification/debug/$($binary.name).exe")).Hash.ToLowerInvariant() -cne $binary.sha256){throw 'Native binary changed.'}
  }
  $record.reused_native_build=@{path=$buildPath;sha256=(Get-FileHash -LiteralPath $buildPath).Hash.ToLowerInvariant();prior_sequence=$priorPath;prior_sequence_sha256=(Get-FileHash -LiteralPath $priorPath).Hash.ToLowerInvariant()}
  Write-Output 'Reused passing exact-source native build after verifying every binary and the original build log.'
 }
 Step 'audit' { & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'run-queue-audit-native-r466.ps1') }
 Step 'audit-owned-stop' {
  $cleanup=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'queue-audit-native-r466/cleanup-r466.json') -Raw|ConvertFrom-Json
  if($cleanup.status -ne 'passed' -or $cleanup.tested_staged_tree -cne $v.staged_tree){throw 'Audit owned cleanup must pass on the exact tested source.'}
  Write-Output 'Verified audit cleanup completed inside the native supervisor; all fixture evidence is retained.'
 }
 Step 'delegated' { & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'run-queue-delegated-native-r412.ps1') -Revision r433 }
 Step 'database' {
  if(!$DatabaseReceipt){
   & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'run-queue-native-database-r412.ps1') -Revision r433
  }else{
   $dbPath=[IO.Path]::GetFullPath($DatabaseReceipt)
   if([IO.Path]::GetDirectoryName($dbPath) -ine [IO.Path]::GetFullPath($PSScriptRoot) -or [IO.Path]::GetFileName($dbPath) -notmatch '^queue-native-database-r[0-9]+\.json$'){throw 'Only an explicit task-owned database receipt may be reused.'}
   $db=Get-Content -LiteralPath $dbPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
   if($db.status -ne 'passed' -or !$db.source_unchanged -or $db.tested_staged_tree -cne $v.staged_tree -or $db.cleanup -notlike 'Only the exact owned PostgreSQL stopped*'){throw 'Database acceptance must pass on exactly the current source with owned cleanup confirmed.'}
   foreach($check in $db.checks){
    if($check.exit_code -ne 0 -or (Get-FileHash -LiteralPath $check.log).Hash.ToLowerInvariant() -cne $check.sha256){throw 'Database evidence changed or failed.'}
   }
   foreach($name in @('base-v2','worker-observation','worker-terminal-fees','native-archive','delegated-authorization')){
    $check=@($db.checks|Where-Object name -eq "owned-postgresql-$name")
    $minimum=if($name -eq 'worker-terminal-fees'){2}else{1}
    if($check.Count -ne 1 -or $check[0].passed_tests -lt $minimum){throw 'Database acceptance omitted a required nonzero test family.'}
   }
   $record.reused_database_receipt=@{path=$dbPath;sha256=(Get-FileHash -LiteralPath $dbPath).Hash.ToLowerInvariant();tested_staged_tree=$db.tested_staged_tree}
   Write-Output 'Reused exact-source passing database acceptance; all original log hashes and required test counts verified.'
  }
 }
 Step 'factory-readiness' {
  & pwsh -NoProfile -File (Join-Path $repo 'docs/evidence/pr-354-completion-20260922-r3/replay/run-pr354-native-first-run-r9.ps1') -Revision r433 -ValidationDirectory $validation -Repository $repo -QaRoot '<local-user>\code\qa\pr265-run-activity-pr354-20260922-r433' -PostgresBin $pg -CargoTargetDirectory $target -NodeDirectory $node -PlaywrightModule $playwright -OutputDirectory $PSScriptRoot
 }
 Step 'retain-factory-binaries' {
  $receipt=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pr354-native-r433-lifecycle.json') -Raw|ConvertFrom-Json
  if($receipt.status -ne 'passed' -or $receipt.cleanup -notlike 'Only owned processes stopped*' -or $receipt.tested_staged_tree -cne $v.staged_tree){throw 'Exact completed fixture receipt required.'}
  $sourceRoot=[IO.Path]::GetFullPath((Join-Path $repo 'target/debug'))
  $destination=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'queue-pr354-retained-binaries-r433'))
  if(!$destination.StartsWith([IO.Path]::GetFullPath($PSScriptRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $destination)){throw 'Invalid or existing binary retention path.'}
  foreach($binary in $receipt.binaries){
   if($binary.file -notin @('crony-server.exe','crony-runner.exe','crony-cli.exe')){throw 'Unexpected binary selection.'}
   $path=[IO.Path]::GetFullPath((Join-Path $sourceRoot $binary.file))
   if([IO.Path]::GetDirectoryName($path) -cne $sourceRoot -or (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() -cne $binary.sha256){throw 'Owned binary changed.'}
   $live=@(Get-CimInstance Win32_Process -Filter ("Name = '"+$binary.file+"'") | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $path })
   if($live.Count){throw 'Owned native binary is still in use.'}
  }
  New-Item -ItemType Directory -Path $destination|Out-Null
  foreach($binary in $receipt.binaries){
   Move-Item -LiteralPath (Join-Path $sourceRoot $binary.file) -Destination (Join-Path $destination $binary.file)
   if((Get-FileHash -LiteralPath (Join-Path $destination $binary.file)).Hash.ToLowerInvariant() -cne $binary.sha256){throw 'Retained binary digest changed.'}
  }
  @{status='retained';source=$sourceRoot;destination=$destination;binaries=$receipt.binaries}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $destination 'retention-receipt.json') -Encoding utf8
 }
 Step 'deliverable-failure' {
  & pwsh -NoProfile -File (Join-Path $repo 'docs/evidence/pr-355-completion-20260922-r3/replay/run-pr355-native-first-run-r6.ps1') -Revision r433 -ValidationDirectory $validation -Repository $repo -QaRoot '<local-user>\code\qa\pr265-run-activity-pr355-20260923-r433' -PostgresBin $pg -CargoTargetDirectory $target -NodeDirectory $node -PlaywrightModule $playwright -OutputDirectory $PSScriptRoot
 }
 if((& git -C $repo write-tree).Trim() -cne $v.staged_tree -or (& git -C $repo diff --name-only)){throw 'Native source changed.'}
 $record.status='passed'
}catch{$record.status='failed';$record.failure=$_.Exception.Message}
finally{$record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save}
[ordered]@{status=$record.status;last_step=$record.steps[-1].name;receipt=$receiptPath}|ConvertTo-Json -Compress
if($record.status -ne 'passed'){exit 1}
