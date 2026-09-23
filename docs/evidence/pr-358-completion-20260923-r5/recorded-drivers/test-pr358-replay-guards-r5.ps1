# Synthetic guard admission only; no product validation or service acceptance is inferred.
$ErrorActionPreference='Stop'
$product='C:\Users\shyamsridhar\code\ecorp-pr358-completion-20260922'
$root=Join-Path $PSScriptRoot 'pr358-replay-guards-r5'
if(Test-Path -LiteralPath $root){throw 'Preserve existing guard evidence.'}
New-Item -ItemType Directory -Path $root|Out-Null
$replay=Join-Path $product 'docs/evidence/pr-358-completion-20260922-r4/replay'
$driver=Join-Path $replay 'run-pr358-native-first-run-r9.ps1'
$supervisor=Join-Path $replay 'qa-pr358-stack-r4.ps1'
$aggregate=Join-Path $replay 'qa-pr358-aggregate-r4.ps1'
$pg='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$node='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64'
$playwright='C:\Users\shyamsridhar\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
$source=Join-Path $root 'producer'
$clone=Join-Path $root 'fresh-clone'
$packet='docs/evidence/pr-358-synthetic-guard'
$hadPriorIndex=Test-Path -LiteralPath Env:GIT_INDEX_FILE
$priorIndex=[Environment]::GetEnvironmentVariable('GIT_INDEX_FILE','Process')
$priorDirectory=(Get-Location).Path
$priorAggregate=@{}
foreach($key in @('ECORP_COMPLETION_PR','ECORP_COMPLETION_PRODUCT','ECORP_COMPLETION_QA_ROOT')){
    $priorAggregate[$key]=[Environment]::GetEnvironmentVariable($key,'Process')
}
$productTree=(& git.exe -C $product write-tree).Trim()
if($LASTEXITCODE){throw 'Cannot identify product tree.'}
$productDiff=@(& git.exe -C $product diff --name-only)
$results=[Collections.Generic.List[object]]::new()
function Invoke-FixtureGit([string]$Repo,[string[]]$Arguments){
    $output=& git.exe -C $Repo @Arguments 2>&1
    if($LASTEXITCODE){throw "Synthetic Git command failed: $($Arguments[0]): $output"}
    return ($output -join "`n").Trim()
}
function Write-Record([string]$Path,$Record){
    [IO.File]::WriteAllText($Path,($Record|ConvertTo-Json -Depth 30)+"`n",[Text.UTF8Encoding]::new($false))
}
function Observe-Guard([string]$Name,[scriptblock]$Action,[string]$Expected){
    $log=Join-Path $root "$Name.log"
    $caught=$null
    try { & $Action *> $log } catch { $caught=$_.Exception.Message }
    if($caught -cne $Expected){throw "Unexpected $Name guard: $caught; expected $Expected"}
    $results.Add(@{name=$Name;status='passed';observed_guard=$caught;log=(Split-Path -Leaf $log);log_sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()})
}
try {
    Remove-Item -LiteralPath Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $source|Out-Null
    Invoke-FixtureGit $source @('init','-b','main')|Out-Null
    [IO.File]::WriteAllText((Join-Path $source 'source.txt'),"synthetic guarded source`n")
    Invoke-FixtureGit $source @('add','--','source.txt')|Out-Null
    $unreachableTree=Invoke-FixtureGit $source @('write-tree')
    $checks=@('migrations','documentation','rust-format','rust-clippy','rust-workspace','node-unit','steward','web-build','web-lint')|ForEach-Object {@{name=$_;exit_code=0}}
    $receipt=@{status='passed';tested_staged_tree=$unreachableTree;checks=$checks;scope='Synthetic guard-test input only; these are not execution receipts.'}
    New-Item -ItemType Directory -Path (Join-Path $source $packet)|Out-Null
    Write-Record (Join-Path $source "$packet/validation.json") $receipt
    Invoke-FixtureGit $source @('add','--',$packet)|Out-Null
    Invoke-FixtureGit $source @('-c','user.name=ECorp QA','-c','user.email=qa@ecorp.invalid','-c','commit.gpgsign=false','commit','-m','Publish synthetic guard fixture')|Out-Null
    & git.exe clone --no-local $source $clone *> (Join-Path $root 'clone.log')
    if($LASTEXITCODE){throw 'Fresh reachable-object clone failed.'}
    & git.exe -C $clone cat-file -e "$unreachableTree^{tree}" *> (Join-Path $root 'missing-pre-evidence-tree.log')
    $missingExit=$LASTEXITCODE
    if($missingExit -eq 0){throw 'Fresh clone unexpectedly received the unreachable pre-evidence tree.'}
    $publishedTree=Invoke-FixtureGit $clone @('write-tree')
    $originalHead=Invoke-FixtureGit $clone @('rev-parse','HEAD')
    $originalIndex=Join-Path $clone '.git/index'
    $originalHash=(Get-FileHash -LiteralPath $originalIndex).Hash
    $callerIndex=Join-Path $root 'caller-index'
    Copy-Item -LiteralPath $originalIndex -Destination $callerIndex
    $callerHash=(Get-FileHash -LiteralPath $callerIndex).Hash
    $qa=Join-Path $root 'qa/pr265-run-activity-pr358-20260923-r999'
    New-Item -ItemType Directory -Path $qa|Out-Null
    [IO.File]::WriteAllText((Join-Path $qa 'sentinel.txt'),'existing fixture must remain unchanged')
    $sentinelHash=(Get-FileHash -LiteralPath (Join-Path $qa 'sentinel.txt')).Hash
    $parameters=@{Revision='r999';ValidationDirectory=(Join-Path $clone $packet);Repository=$clone;QaRoot=$qa;PostgresBin=$pg;CargoTargetDirectory=(Join-Path $root 'unused-target');NodeDirectory=$node;PlaywrightModule=$playwright;OutputDirectory=$root}
    Observe-Guard 'published-fresh-clone' { & $driver @parameters } 'Preserve existing fixture and receipts.'
    if([Environment]::GetEnvironmentVariable('GIT_INDEX_FILE','Process') -or (Get-FileHash -LiteralPath $originalIndex).Hash -cne $originalHash){throw 'Default source index was changed.'}
    [Environment]::SetEnvironmentVariable('GIT_INDEX_FILE',$callerIndex,'Process')
    Observe-Guard 'published-caller-index' { & $driver @parameters } 'Preserve existing fixture and receipts.'
    if([Environment]::GetEnvironmentVariable('GIT_INDEX_FILE','Process') -cne $callerIndex -or (Get-FileHash -LiteralPath $originalIndex).Hash -cne $originalHash -or (Get-FileHash -LiteralPath $callerIndex).Hash -cne $callerHash){throw 'Caller source index or environment was changed.'}
    Remove-Item -LiteralPath Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    foreach($case in @(
        @{name='raw-matching';tree=$publishedTree;failed=$false;expected='Preserve existing fixture and receipts.'},
        @{name='raw-mismatching';tree=('0'*40);failed=$false;expected='Different source tree without the exact published evidence packet.'},
        @{name='failed-gate';tree=$publishedTree;failed=$true;expected='Source must match all nine passing validation gates.'}
    )){
        $vdir=Join-Path $root $case.name
        New-Item -ItemType Directory -Path $vdir|Out-Null
        $raw=$receipt|ConvertTo-Json -Depth 20|ConvertFrom-Json -AsHashtable
        $raw.Remove('tested_staged_tree')|Out-Null
        $raw.staged_tree=$case.tree
        if($case.failed){$raw.checks[0].exit_code=1}
        Write-Record (Join-Path $vdir 'validation.json') $raw
        $parameters.ValidationDirectory=$vdir
        Observe-Guard $case.name { & $driver @parameters } $case.expected
    }
    $parameters.ValidationDirectory=Join-Path $clone $packet
    [IO.File]::WriteAllText((Join-Path $clone 'source.txt'),"deliberately changed synthetic source`n")
    Invoke-FixtureGit $clone @('add','--','source.txt')|Out-Null
    $changedIndex=(Get-FileHash -LiteralPath $originalIndex).Hash
    Observe-Guard 'changed-published-source' { & $driver @parameters } 'Product source changed since the published validation.'
    if((Get-FileHash -LiteralPath $originalIndex).Hash -cne $changedIndex){throw 'Rejected source projection changed the index.'}
    if(Test-Path -LiteralPath (Join-Path $root 'pr358-native-r999-lifecycle.json')){throw 'A source guard crossed the provisioning boundary.'}
    if((Get-FileHash -LiteralPath (Join-Path $qa 'sentinel.txt')).Hash -cne $sentinelHash -or (Invoke-FixtureGit $clone @('rev-parse','HEAD')) -cne $originalHead){throw 'Synthetic retained state changed.'}
    $grammarCases=@(
        @{name='date-r1';leaf='pr265-run-activity-pr358-20260923-r1';valid=$true},
        @{name='next-date-r10';leaf='pr265-run-activity-pr358-20260924-r10';valid=$true},
        @{name='wrong-pr';leaf='pr265-run-activity-pr359-20260923-r1';valid=$false},
        @{name='missing-date';leaf='pr265-run-activity-pr358-r1';valid=$false},
        @{name='bad-revision';leaf='pr265-run-activity-pr358-20260923-rx';valid=$false},
        @{name='trailing-suffix';leaf='pr265-run-activity-pr358-20260923-r1-extra';valid=$false}
    )
    foreach($case in $grammarCases){
        $grammarQa=Join-Path $root ('qa/'+$case.leaf)
        New-Item -ItemType Directory -Path $grammarQa|Out-Null
        $ownership=@{schema_version=2;workspace=$grammarQa;test_owned=$false;purpose='synthetic-guard-only';plan=@{product=$product;server='http://127.0.0.1:59111'};processes=@{}}
        Write-Record (Join-Path $grammarQa 'ownership.json') $ownership
        $ownershipHash=(Get-FileHash -LiteralPath (Join-Path $grammarQa 'ownership.json')).Hash
        $parameters.Repository=$clone
        $parameters.ValidationDirectory=Join-Path $root 'raw-matching'
        $parameters.QaRoot=$grammarQa
        # Use the caller index captured before the intentional source change.
        [Environment]::SetEnvironmentVariable('GIT_INDEX_FILE',$callerIndex,'Process')
        $expected=if($case.valid){'Source must match all nine passing validation gates.'}else{'Use a dedicated absolute qa/pr265-run-activity-pr358-YYYYMMDD-rN directory outside the product.'}
        Observe-Guard ('driver-grammar-'+$case.name) { & $driver @parameters } $expected
        Remove-Item -LiteralPath Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
        $expected=if($case.valid){'Occupied QA directory: preserve it; never reset or adopt it.'}else{'Use a dedicated absolute qa/pr265-run-activity-pr358-YYYYMMDD-rN directory outside the product.'}
        Observe-Guard ('supervisor-grammar-'+$case.name) { & $supervisor -Phase DryRun -Repository $product -QaRoot $grammarQa -PostgresBin $pg } $expected
        $env:ECORP_COMPLETION_PR='358'
        $env:ECORP_COMPLETION_PRODUCT=$product
        $env:ECORP_COMPLETION_QA_ROOT=$grammarQa
        $expected=if($case.valid){'Aggregate acceptance requires its exact new owned server.'}else{'Unexpected owned aggregate-budget fixture scope.'}
        Observe-Guard ('aggregate-grammar-'+$case.name) { & $aggregate } $expected
        if((Get-FileHash -LiteralPath (Join-Path $grammarQa 'ownership.json')).Hash -cne $ownershipHash -or (Test-Path -LiteralPath (Join-Path $grammarQa 'server-process.json'))){throw 'Grammar test crossed ownership guard.'}
    }
    if((Get-FileHash -LiteralPath $callerIndex).Hash -cne $callerHash){throw 'Caller index changed in grammar tests.'}
    if((Invoke-FixtureGit $product @('write-tree')) -cne $productTree -or (Compare-Object $productDiff @(& git.exe -C $product diff --name-only))){throw 'Guard tests changed product source.'}
    $record=@{status='passed';scope='Synthetic source/fixture admission only; no services started and no validation results fabricated.';source_head=(Invoke-FixtureGit $product @('rev-parse','HEAD'));staged_tree=$productTree;recorded_pre_evidence_tree=$unreachableTree;fresh_clone_missing_tree_exit=$missingExit;source_index_preserved=$true;caller_index_preserved=$true;caller_environment_restored=$true;source_unchanged=$true;scripts=@{};cases=$results.ToArray()}
    foreach($file in @($driver,$supervisor,$aggregate)){$record.scripts[(Split-Path -Leaf $file)]=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
    Write-Record (Join-Path $root 'receipt.json') $record
    $record|Select-Object status,@{n='passed_cases';e={$_.cases.Count}},fresh_clone_missing_tree_exit|ConvertTo-Json -Compress
} finally {
    if ($hadPriorIndex) { [Environment]::SetEnvironmentVariable('GIT_INDEX_FILE',$priorIndex,'Process') } else { Remove-Item -LiteralPath Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue }
    foreach($key in $priorAggregate.Keys){if ($null -eq $priorAggregate[$key]) { Remove-Item -LiteralPath ('Env:'+$key) -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($key,$priorAggregate[$key],'Process') }}
    Set-Location -LiteralPath $priorDirectory
}
