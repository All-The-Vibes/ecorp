#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue262-recovery\ecorp'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot 'issue262-coverage-r1.json'
$logPath=Join-Path $PSScriptRoot 'issue262-coverage-r1.log'
$coverageOutput=Join-Path $issueWorktree 'output\coverage\issue262-refresh-warning-r1'
foreach($path in @($receiptPath,$logPath,$coverageOutput)) {if(Test-Path -LiteralPath $path){throw 'Preserve prior coverage evidence.'}}
$baseline=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'refresh-warning-green-r1.json') -Raw|ConvertFrom-Json
if($baseline.status -cne 'passed' -or !$baseline.physical_source_unchanged){throw 'Preserve the active baseline validation until it finishes.'}
$record=[ordered]@{issue=262;status='starting';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');worktree=$issueWorktree;command=@('pnpm','coverage:web-models','--output',$coverageOutput);log=$logPath;exit_code=$null;coverage_output=$coverageOutput;note='Model coverage after the saved refreshWarning schema correction and focused green regressions. Thresholds remain 99% lines, 95% functions and 97% branches. Full canonical validation and native acceptance remain separate.'}
function Save-Record {$record|ConvertTo-Json -Depth 15|Set-Content -LiteralPath $receiptPath -Encoding utf8}
$coverageExit=1
Push-Location -LiteralPath $issueWorktree
try {
    Save-Record
    & $issuePython -X utf8 (Join-Path $PSScriptRoot 'capture-issue262-source-r1.py') --phase before-coverage-r1 --equals refresh-warning-green-after
    if($LASTEXITCODE -ne 0){throw 'Cannot bind current source before coverage.'}
    $record.source_before=Join-Path $PSScriptRoot 'issue262-source-before-coverage-r1.json'
    $record.status='running';Save-Record
    & pnpm coverage:web-models --output $coverageOutput *> $logPath
    $coverageExit=$LASTEXITCODE
    $record.exit_code=$coverageExit
    $record.log_sha256=(Get-FileHash -LiteralPath $logPath).Hash.ToLowerInvariant()
    $summaryPath=Join-Path $coverageOutput 'summary.json'
    if(Test-Path -LiteralPath $summaryPath){
        $summary=Get-Content -LiteralPath $summaryPath -Raw|ConvertFrom-Json
        $record.summary_path=$summaryPath
        $record.summary_sha256=(Get-FileHash -LiteralPath $summaryPath).Hash.ToLowerInvariant()
        $record.summary=$summary
    }
    if($coverageExit -ne 0 -or !$summary.ok){throw 'Full model coverage failed; preserve and inspect the evidence.'}
    $record.status='passed';Save-Record
    Get-Content -LiteralPath $logPath -Tail 30
} catch {
    $record.status='failed';$record.error=$_.Exception.Message;$coverageExit=1;Save-Record
} finally {
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'issue262-source-before-coverage-r1.json')){
        & $issuePython -X utf8 (Join-Path $PSScriptRoot 'capture-issue262-source-r1.py') --phase after-coverage-r1 --equals before-coverage-r1
        if($LASTEXITCODE -eq 0){$record.physical_source_unchanged=$true}
        else{$record.status='failed';$record.source_error='Source changed during coverage.';$coverageExit=1}
    }
    $record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Record
    Pop-Location
}
exit $coverageExit
