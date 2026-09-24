#requires -Version 7.5
param(
 [string]$DatabaseReceipt,
 [string]$ValidationDirectory=(Join-Path $PSScriptRoot 'queue-validation-r454')
)
$ErrorActionPreference='Stop'
$repo='<reviewed-worktree>'
$validation=[IO.Path]::GetFullPath($ValidationDirectory)
if([IO.Path]::GetDirectoryName($validation) -ine [IO.Path]::GetFullPath($PSScriptRoot) -or [IO.Path]::GetFileName($validation) -notmatch '^queue-validation-r[0-9]+$'){throw 'Require a task-owned source-bound validation directory.'}
$receiptPath=Join-Path $PSScriptRoot 'queue-native-sequence-r477.json'
if(Test-Path -LiteralPath $receiptPath){throw 'Preserve earlier native sequence.'}
$v=Get-Content -LiteralPath (Join-Path $validation 'validation.json') -Raw|ConvertFrom-Json
if($v.status -ne 'passed' -or !$v.source_unchanged -or $v.checks.Count -ne 11 -or @($v.checks|Where-Object exit_code -ne 0).Count){throw 'Complete passing source-bound validation is required.'}
if((& git -C $repo write-tree).Trim() -cne $v.staged_tree -or (& git -C $repo diff --name-only)){throw 'Validated source changed.'}
$record=[ordered]@{status='running';tested_staged_tree=$v.staged_tree;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');steps=@()}
function Save {$record|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $receiptPath -Encoding utf8}
function Step([string]$Name,[scriptblock]$Action){
 $log=Join-Path $PSScriptRoot "queue-native-sequence-r477-$Name.log"
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

function Retain-Binaries([string]$ReceiptName,[string]$DestinationName,[string]$ExpectedStatus){
 $path=Join-Path $PSScriptRoot $ReceiptName
 $native=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
 if($native.status -ne $ExpectedStatus -or $native.cleanup -notlike 'Only owned processes stopped*' -or $native.tested_staged_tree -cne $v.staged_tree){throw 'Exact completed fixture and cleanup required.'}
 $sourceRoot=[IO.Path]::GetFullPath((Join-Path $repo 'target/debug'))
 $destination=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot $DestinationName))
 if(!$destination.StartsWith([IO.Path]::GetFullPath($PSScriptRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $destination)){throw 'Invalid or existing binary retention path.'}
 foreach($binary in $native.binaries){
  if($binary.file -notin @('crony-server.exe','crony-runner.exe','crony-cli.exe')){throw 'Unexpected binary selection.'}
  $binaryPath=[IO.Path]::GetFullPath((Join-Path $sourceRoot $binary.file))
  if([IO.Path]::GetDirectoryName($binaryPath) -cne $sourceRoot -or (Get-FileHash -LiteralPath $binaryPath).Hash.ToLowerInvariant() -cne $binary.sha256){throw 'Owned binary changed.'}
  $live=@(Get-CimInstance Win32_Process -Filter ("Name = '"+$binary.file+"'") | Where-Object {$_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $binaryPath})
  if($live.Count){throw 'Owned native binary is still in use.'}
 }
 New-Item -ItemType Directory -Path $destination|Out-Null
 foreach($binary in $native.binaries){
  Move-Item -LiteralPath (Join-Path $sourceRoot $binary.file) -Destination (Join-Path $destination $binary.file)
  if((Get-FileHash -LiteralPath (Join-Path $destination $binary.file)).Hash.ToLowerInvariant() -cne $binary.sha256){throw 'Retained binary digest changed.'}
 }
 @{status='retained';source=$sourceRoot;destination=$destination;binaries=$native.binaries;original_receipt_sha256=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $destination 'retention-receipt.json') -Encoding utf8
}

$pg='<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$target='<local-user>\code\ecorp-pr-completion-20260922\target-validation'
$node='<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64'
$playwright='<local-user>\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
try{
 Step 'verify-prior-suites' {
  $priorPath=Join-Path $PSScriptRoot 'queue-native-sequence-r471.json'
  $prior=Get-Content -LiteralPath $priorPath -Raw|ConvertFrom-Json
  if($prior.status -ne 'failed' -or $prior.tested_staged_tree -cne $v.staged_tree -or $prior.steps[-1].name -ne 'factory-readiness'){throw 'Prior sequence differs.'}
  foreach($name in @('native-build','audit','audit-owned-stop','delegated','database')){
   $step=@($prior.steps|Where-Object name -eq $name)
   if($step.Count -ne 1 -or $step[0].status -ne 'passed' -or $step[0].exit_code -ne 0 -or (Get-FileHash -LiteralPath $step[0].log).Hash.ToLowerInvariant() -cne $step[0].sha256){throw 'A reused passing step changed.'}
  }
  foreach($relative in @('queue-audit-native-r471/acceptance-run.json','queue-delegated-native-r433.json','queue-native-database-r455.json')){
   $path=Join-Path $PSScriptRoot $relative
   $native=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
   if($native.status -ne 'passed' -or $native.tested_staged_tree -cne $v.staged_tree){throw 'Matching-source native acceptance required.'}
   foreach($check in @($native.checks)+@($native.steps)){
    if(!$check){continue}
    if($check.exit_code -ne 0 -or (Get-FileHash -LiteralPath $check.log).Hash.ToLowerInvariant() -cne $check.sha256){throw 'Native log changed.'}
   }
  }
  $record.reused_sequence=@{path=$priorPath;sha256=(Get-FileHash -LiteralPath $priorPath).Hash.ToLowerInvariant();scope='Only the five completed steps; failed Factory acceptance remains failed.'}
  Write-Output 'Verified completed audit, delegated and database acceptance on the unchanged source. Their original receipts remain unchanged.'
 }
 Step 'retain-failed-factory-binaries' {
  Retain-Binaries 'pr354-native-r433-lifecycle.json' 'queue-pr354-retained-binaries-r433' 'failed'
 }
 Step 'factory-readiness' {
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'run-pr354-native-first-run-r477.ps1') -Revision r477 -ValidationDirectory $validation -Repository $repo -QaRoot '<local-user>\code\qa\pr265-run-activity-pr354-20260922-r477' -PostgresBin $pg -CargoTargetDirectory $target -NodeDirectory $node -PlaywrightModule $playwright -OutputDirectory $PSScriptRoot
 }
 Step 'retain-factory-binaries' { Retain-Binaries 'pr354-native-r477-lifecycle.json' 'queue-pr354-retained-binaries-r477' 'passed' }
 Step 'deliverable-failure' {
  & pwsh -NoProfile -File (Join-Path $repo 'docs/evidence/pr-355-completion-20260922-r3/replay/run-pr355-native-first-run-r6.ps1') -Revision r477 -ValidationDirectory $validation -Repository $repo -QaRoot '<local-user>\code\qa\pr265-run-activity-pr355-20260923-r477' -PostgresBin $pg -CargoTargetDirectory $target -NodeDirectory $node -PlaywrightModule $playwright -OutputDirectory $PSScriptRoot
 }
 if((& git -C $repo write-tree).Trim() -cne $v.staged_tree -or (& git -C $repo diff --name-only)){throw 'Native source changed.'}
 $record.status='passed'
}catch{$record.status='failed';$record.failure=$_.Exception.Message}
finally{$record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save}
[ordered]@{status=$record.status;last_step=$record.steps[-1].name;receipt=$receiptPath}|ConvertTo-Json -Compress
if($record.status -ne 'passed'){exit 1}
