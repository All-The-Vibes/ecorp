#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue258-history\ecorp'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot 'issue258-review-web-r2.json'
if(Test-Path -LiteralPath $receiptPath){throw 'Preserve existing web validation.'}
$record=[ordered]@{issue=258;status='starting';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');worktree=$issueWorktree;steps=@();scope='Frozen dependency installation, web build and lint; not native acceptance or hosted CI.'}
function Save-Record { $record|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
function Run-Step([string]$Name,[string]$Program,[string[]]$Arguments){
    $log=Join-Path $PSScriptRoot "issue258-review-web-r2-$Name.log"
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
    Run-Step 'source-before' $issuePython @('-X','utf8',(Join-Path $PSScriptRoot 'capture-issue258-review-source-r1.py'),'--phase','before-web-r2')
    Run-Step 'install' 'pnpm' @('install','--frozen-lockfile')
    Run-Step 'scenario-install' 'npm' @('ci','--prefix','scenarios/repo-steward','--ignore-scripts','--no-audit','--no-fund')
    Run-Step 'build' 'pnpm' @('build:web')
    Run-Step 'lint' 'pnpm' @('lint:web')
    $record.status='passed'
} catch {
    $record.status='failed';$record.error=$_.Exception.Message
    throw
} finally {
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'issue258-review-source-before-web-r2.json')){
        try {
            Run-Step 'source-after' $issuePython @('-X','utf8',(Join-Path $PSScriptRoot 'capture-issue258-review-source-r1.py'),'--phase','after-web-r2','--equals','before-web-r2')
            $record.physical_source_unchanged=$true
        } catch { $record.status='failed';$record.source_error=$_.Exception.Message }
    }
    $record.completed_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Record
    Pop-Location
}
if($record.status -cne 'passed'){exit 1}
