#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue264-modes\ecorp'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot 'issue264-review-dependencies-r3.json'
if(Test-Path -LiteralPath $receiptPath){throw 'Preserve existing web validation.'}
$record=[ordered]@{issues=@(263,264);status='starting';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');worktree=$issueWorktree;steps=@();scope='Frozen workspace and repo-steward dependencies for the pending integration; no tests, native acceptance or hosted CI are implied.'}
function Save-Record { $record|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
function Run-Step([string]$Name,[string]$Program,[string[]]$Arguments){
    $log=Join-Path $PSScriptRoot "issue264-review-dependencies-r3-$Name.log"
    if(Test-Path -LiteralPath $log){throw 'Preserve existing validation log.'}
    $started=[DateTimeOffset]::UtcNow.ToString('o')
    & $Program @Arguments *> $log
    $stepExit=$LASTEXITCODE
    $record.steps+=@(@{name=$Name;command=@($Program)+$Arguments;started_at_utc=$started;completed_at_utc=[DateTimeOffset]::UtcNow.ToString('o');exit_code=$stepExit;log=$log;sha256=(Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash.ToLowerInvariant()})
    Save-Record
    [pscustomobject]@{step=$Name;exit_code=$stepExit}|ConvertTo-Json -Compress
    if($stepExit -ne 0){Get-Content -LiteralPath $log -Tail 35;throw "Web validation $Name failed."}
}
Push-Location -LiteralPath $issueWorktree
try {
    Save-Record
    Run-Step 'source-before' $issuePython @('-X','utf8',(Join-Path $PSScriptRoot 'capture-issue264-review-source-r2.py'),'--phase','before-dependencies-r3')
    Run-Step 'install' 'pnpm' @('install','--frozen-lockfile')
    Run-Step 'scenario-install' 'npm' @('ci','--prefix','scenarios/repo-steward','--ignore-scripts','--no-audit','--no-fund')
    $record.status='passed'
} catch {
    $record.status='failed';$record.error=$_.Exception.Message
    throw
} finally {
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'issue264-review-source-before-dependencies-r3.json')){
        try {
            Run-Step 'source-after' $issuePython @('-X','utf8',(Join-Path $PSScriptRoot 'capture-issue264-review-source-r2.py'),'--phase','after-dependencies-r3','--equals','before-dependencies-r3')
            $record.physical_source_unchanged=$true
        } catch { $record.status='failed';$record.source_error=$_.Exception.Message }
    }
    $record.completed_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Record
    Pop-Location
}
if($record.status -cne 'passed'){exit 1}
