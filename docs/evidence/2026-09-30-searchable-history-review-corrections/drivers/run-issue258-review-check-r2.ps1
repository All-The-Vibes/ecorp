#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue258-history\ecorp'
$issuePythonDir='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python'
$issuePython=Join-Path $issuePythonDir 'python.exe'
$logPath=Join-Path $PSScriptRoot 'issue258-review-check-r2.log'
$receiptPath=Join-Path $PSScriptRoot 'issue258-review-check-r2.json'
foreach($path in @($logPath,$receiptPath)){if(Test-Path -LiteralPath $path){throw 'Preserve this canonical validation attempt.'}}
$webPath=Join-Path $PSScriptRoot 'issue258-review-web-r2.json'
$web=Get-Content -LiteralPath $webPath -Raw|ConvertFrom-Json
if($web.status -cne 'passed' -or !$web.physical_source_unchanged){throw 'Frozen dependency and web validation must pass first.'}
$record=[ordered]@{
    issue=258;status='starting';command='pnpm check';worktree=$issueWorktree
    started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');exit_code=$null
    rust_test_threads=1;all_named_gates_enabled=$true
    dependency_receipt=$webPath;dependency_receipt_sha256=(Get-FileHash -LiteralPath $webPath -Algorithm SHA256).Hash.ToLowerInvariant()
    log=$logPath;canonical_report=$null
    note='Complete canonical plan with frozen dependencies. Serial Rust execution filters no tests. Bundled Python is first on process PATH. This is not native acceptance, hosted CI or issue completion.'
}
function Save-Record { $record|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
$priorIssue258ReviewPath=$env:PATH
$priorIssue258ReviewPython=$env:PYTHON
$priorIssue258ReviewThreads=$env:RUST_TEST_THREADS
$checkExit=1
Push-Location -LiteralPath $issueWorktree
try {
    $env:PATH="$issuePythonDir;$priorIssue258ReviewPath"
    $env:PYTHON=$issuePython
    $env:RUST_TEST_THREADS='1'
    if((Get-Command python.exe).Source -cne $issuePython){throw 'Python resolution is incorrect.'}
    $record.python=@{path=$issuePython;version=(& python --version);sha256=(Get-FileHash -LiteralPath $issuePython -Algorithm SHA256).Hash.ToLowerInvariant()}
    $record.versions=@{node=(& node --version);pnpm=(& pnpm --version);cargo=(& cargo --version)}
    $record.lock_sha256=@{}
    foreach($relative in @('pnpm-lock.yaml','scenarios/repo-steward/package-lock.json','Cargo.lock')){
        $record.lock_sha256[$relative]=(Get-FileHash -LiteralPath (Join-Path $issueWorktree $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    Save-Record
    & $issuePython -X utf8 (Join-Path $PSScriptRoot 'capture-issue258-review-source-r1.py') --phase before-check-r2 --equals after-web-r2
    if($LASTEXITCODE -ne 0){throw 'Pre-check physical source capture failed.'}
    $record.source_receipt=Join-Path $PSScriptRoot 'issue258-review-source-before-check-r2.json'
    $record.status='running';Save-Record
    & pnpm check *> $logPath
    $checkExit=$LASTEXITCODE
    $record.exit_code=$checkExit
    $record.log_sha256=(Get-FileHash -LiteralPath $logPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $reportLine=Get-Content -LiteralPath $logPath|Where-Object {$_ -like 'Validation report: *'}|Select-Object -Last 1
    if(!$reportLine){throw 'Canonical report path was not recorded; inspect retained log.'}
    $reportPath=$reportLine.Substring('Validation report: '.Length)
    $record.canonical_report=$reportPath
    $canonical=Get-Content -LiteralPath $reportPath -Raw|ConvertFrom-Json
    $record.canonical_sha256=(Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $record.canonical_status=$canonical.status
    $record.source_changed=$canonical.sourceChangedDuringValidation
    $record.checks=@($canonical.checks|Select-Object name,argv,passed,exitCode,durationMs,counts,errorCode)
    $record.not_run=@($canonical.notRun)
    $expected=@('migrations','state-audit-compatibility','state-audit-evm','docs','repository-docs','node-tests','format','clippy','rust-tests','web-build','web-lint')
    $observed=@($canonical.checks|ForEach-Object{$_.name})
    $failed=@($canonical.checks|Where-Object{!$_.passed -or $_.exitCode -ne 0 -or $_.errorCode})
    $record.status=if($checkExit -eq 0 -and $canonical.status -ceq 'passed' -and $canonical.sourceChangedDuringValidation -eq $false -and !$canonical.notRun.Count -and ($observed -join '|') -ceq ($expected -join '|') -and !$failed.Count){'passed'}else{'failed'}
    if($record.status -cne 'passed'){$checkExit=1}
    Save-Record
    Get-Content -LiteralPath $logPath -Tail 20
} catch {
    $record.status='failed';$record.error=$_.Exception.Message;$checkExit=1
    Save-Record
} finally {
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'issue258-review-source-before-check-r2.json')){
        & $issuePython -X utf8 (Join-Path $PSScriptRoot 'capture-issue258-review-source-r1.py') --phase after-check-r2 --equals before-check-r2
        if($LASTEXITCODE -eq 0){$record.physical_source_unchanged=$true}
        else{$record.status='failed';$record.source_error='Post-check physical source equality failed.';$checkExit=1}
    }
    $record.completed_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Record
    $env:PATH=$priorIssue258ReviewPath
    $env:PYTHON=$priorIssue258ReviewPython
    $env:RUST_TEST_THREADS=$priorIssue258ReviewThreads
    Pop-Location
}
exit $checkExit
