$ErrorActionPreference='Stop'
$product='C:\Users\shyamsridhar\code\ecorp-pr358-completion-20260922'
$root=Join-Path $PSScriptRoot 'pr358-replay-guards-r1'
if(Test-Path -LiteralPath $root){throw 'Preserve guard-test evidence.'}
New-Item -ItemType Directory -Path $root|Out-Null
$driver=Join-Path $product 'docs/evidence/pr-358-completion-20260922-r3/drivers/run-pr358-native-r4.ps1'
$existingQa='C:\Users\shyamsridhar\code\qa\pr265-run-activity-pr358-20260922-r4'
$ownership=Join-Path $existingQa 'ownership.json'
$before=(Get-FileHash -LiteralPath $ownership).Hash
$tree=(& git -C $product write-tree).Trim()
$source=Get-Content -Raw -LiteralPath (Join-Path $product 'docs/evidence/pr-358-completion-20260922-r3/validation.json')|ConvertFrom-Json -AsHashtable
$cases=@(
  @{name='raw-matching';field='staged_tree';tree=$tree;expected='Preserve existing fixture and receipts.'},
  @{name='published-matching';field='tested_staged_tree';tree=$tree;expected='Preserve existing fixture and receipts.'},
  @{name='raw-mismatching';field='staged_tree';tree=('0'*40);expected='Different source tree without the exact published evidence packet.'},
  @{name='published-mismatching';field='tested_staged_tree';tree=('0'*40);expected='Different source tree without the exact published evidence packet.'},
  @{name='failed-gate';field='tested_staged_tree';tree=$tree;expected='Source must match all nine passing validation gates.'}
)
$outcomes=@()
foreach($case in $cases){
  $directory=Join-Path $root $case.name
  New-Item -ItemType Directory -Path $directory|Out-Null
  $inputRecord=$source|ConvertTo-Json -Depth 30|ConvertFrom-Json -AsHashtable
  $inputRecord.Remove('tested_staged_tree')|Out-Null
  $inputRecord.Remove('staged_tree')|Out-Null
  $inputRecord[$case.field]=$case.tree
  if($case.name -eq 'failed-gate'){$inputRecord.checks[0].exit_code=1}
  $inputRecord.test_fixture_only='Synthetic guard-test input, not a new validation claim.'
  $inputRecord|ConvertTo-Json -Depth 30|Set-Content -LiteralPath (Join-Path $directory 'validation.json') -Encoding utf8
  $caught=$null
  try {
    & $driver -Revision r999 -ValidationDirectory $directory -Repository $product -QaRoot $existingQa `
      -PostgresBin 'C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin' `
      -CargoTargetDirectory 'C:\Users\shyamsridhar\code\ecorp-pr338-completion-20260922\target-validation' `
      -NodeDirectory 'C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64' `
      -PlaywrightModule 'C:\Users\shyamsridhar\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright' `
      -OutputDirectory $directory *> (Join-Path $directory 'output.log')
  } catch {$caught=$_.Exception.Message}
  if($caught -cne $case.expected){throw "Unexpected guard result for $($case.name): $caught"}
  if(Test-Path -LiteralPath (Join-Path $directory 'pr358-native-r999-lifecycle.json')){throw 'Guard test crossed the fixture mutation boundary.'}
  $outcomes+=@{name=$case.name;status='passed';observed_guard=$caught;fixture_mutations=$false}
}
if((Get-FileHash -LiteralPath $ownership).Hash -cne $before -or (& git -C $product write-tree).Trim() -cne $tree -or (& git -C $product diff --name-only)){throw 'Guard tests changed retained fixture or product.'}
$report=@{status='passed';source_head=(& git -C $product rev-parse HEAD).Trim();source_tree=$tree;driver_sha256=(Get-FileHash -LiteralPath $driver).Hash.ToLowerInvariant();scope='Synthetic receipt admission tests only; successful cases deliberately stop at the occupied-fixture guard before any provisioning.';cases=$outcomes}
$report|ConvertTo-Json -Depth 15|Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8
$report|Select-Object status,@{n='passed_cases';e={$_.cases.Count}}|ConvertTo-Json -Compress
