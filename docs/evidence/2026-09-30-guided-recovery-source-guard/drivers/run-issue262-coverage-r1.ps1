#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue262-recovery\ecorp'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot 'issue262-coverage-r1.json'
$logPath=Join-Path $PSScriptRoot 'issue262-coverage-r1.log'
$coverageOutput=Join-Path $issueWorktree 'output\coverage\issue262-source-alias-20260930-r1'
foreach($path in @($receiptPath,$logPath,$coverageOutput)) {if(Test-Path -LiteralPath $path){throw 'Preserve prior coverage evidence.'}}
$baseline=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'issue262-source-guard-focused-r1.json') -Raw|ConvertFrom-Json
if($baseline.status -cne 'passed' -or !$baseline.physical_source_unchanged){throw 'Preserve the active baseline validation until it finishes.'}
$record=[ordered]@{issue=262;status='starting';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');worktree=$issueWorktree;command=@('pnpm','coverage:web-models','--output',$coverageOutput);log=$logPath;exit_code=$null;coverage_output=$coverageOutput;note='Fresh model coverage on unchanged PR389 product source with native canonical-path and single-link checks. Thresholds remain 99% lines, 95% functions and 97% branches. Full canonical validation and native acceptance remain separate.'}
$record.drivers=@{}
foreach($name in @('run-issue262-coverage-r1.ps1','capture-issue262-source-r3.py','issue262_source_guard_r2.py')) {
    $record.drivers[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant()
}
function Save-Record {$record|ConvertTo-Json -Depth 15|Set-Content -LiteralPath $receiptPath -Encoding utf8}
$coverageExit=1
$issue262PriorBytecode=$env:PYTHONDONTWRITEBYTECODE
$env:PYTHONDONTWRITEBYTECODE='1'
Push-Location -LiteralPath $issueWorktree
try {
    Save-Record
    & $issuePython -B -X utf8 (Join-Path $PSScriptRoot 'capture-issue262-source-r3.py') --phase before-coverage-r1 --equals focused-after-r1
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
        & $issuePython -B -X utf8 (Join-Path $PSScriptRoot 'capture-issue262-source-r3.py') --phase after-coverage-r1 --equals before-coverage-r1
        if($LASTEXITCODE -eq 0){$record.physical_source_unchanged=$true}
        else{$record.status='failed';$record.source_error='Source changed during coverage.';$coverageExit=1}
    }
    $record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Record
    foreach($name in $record.drivers.Keys) {
        if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant() -cne $record.drivers[$name]) {
            $record.status='failed';$record.driver_error='Validation driver changed.';Save-Record
            throw 'Validation driver changed.'
        }
    }
    $env:PYTHONDONTWRITEBYTECODE=$issue262PriorBytecode
    Pop-Location
}
exit $coverageExit
