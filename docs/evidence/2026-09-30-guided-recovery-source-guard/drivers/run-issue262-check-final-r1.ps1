#requires -Version 7.5
[CmdletBinding()]
param([ValidatePattern('^r[0-9]+$')][string]$NativeAttempt='r12')
$ErrorActionPreference='Stop'
$priorEvidenceRoot='<USERPROFILE>\code\ecorp\output\issue-completion\20260926T112626Z'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue262-recovery\ecorp'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$issuePythonDir=Split-Path -Parent $issuePython
$logPath=Join-Path $PSScriptRoot 'issue262-check-final-r1.log'
$receiptPath=Join-Path $PSScriptRoot 'issue262-check-final-r1.json'
foreach($path in @($logPath,$receiptPath)){if(Test-Path -LiteralPath $path){throw 'Preserve this final canonical validation attempt.'}}
$baselinePath=Join-Path $PSScriptRoot 'issue262-source-guard-focused-r1.json'
$coveragePath=Join-Path $PSScriptRoot 'issue262-coverage-r1.json'
$nativePath=Join-Path $PSScriptRoot "issue262-native-$NativeAttempt.json"
$baseline=Get-Content -LiteralPath $baselinePath -Raw|ConvertFrom-Json
$coverage=Get-Content -LiteralPath $coveragePath -Raw|ConvertFrom-Json
$native=Get-Content -LiteralPath $nativePath -Raw|ConvertFrom-Json
if($baseline.status -cne 'passed' -or !$baseline.physical_source_unchanged){throw 'Focused regression validation has not finished successfully.'}
if($coverage.status -cne 'passed' -or $coverage.exit_code -ne 0 -or !$coverage.physical_source_unchanged){throw 'Model coverage has not passed on stable source.'}
if($native.status -cne 'accepted' -or !$native.physical_source_unchanged -or !$native.stopped){throw 'Native acceptance must finish and stop its owned services before final validation.'}
$webPath=Join-Path $priorEvidenceRoot 'issue262-dependencies-r1.json'
$stewardPath=Join-Path $priorEvidenceRoot 'issue262-steward-dependencies-r1.json'
$web=Get-Content -LiteralPath $webPath -Raw|ConvertFrom-Json
$steward=Get-Content -LiteralPath $stewardPath -Raw|ConvertFrom-Json
if($web.exit_code -ne 0 -or !$web.lock_unchanged -or $steward.exit_code -ne 0 -or !$steward.lock_unchanged){throw 'Locked dependencies are required.'}
if((Get-FileHash -LiteralPath (Join-Path $issueWorktree 'pnpm-lock.yaml')).Hash -cne $web.lock_after){throw 'Web lock changed.'}
if((Get-FileHash -LiteralPath (Join-Path $issueWorktree 'scenarios/repo-steward/package-lock.json')).Hash -cne $steward.lock_after){throw 'Steward lock changed.'}
$record=[ordered]@{
    issue=262;status='starting';command='pnpm check';worktree=$issueWorktree
    started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');exit_code=$null
    rust_test_threads=1;all_named_gates_enabled=$true
    dependency_receipts=@($webPath,$stewardPath)
    baseline_receipt=$baselinePath;coverage_receipt=$coveragePath;native_receipt=$nativePath
    log=$logPath;canonical_report=$null
    note='Fresh complete canonical plan on unchanged PR389 source with native canonical-path and single-link checks at both boundaries. Frozen dependencies, all eleven named gates, full Node discovery, serial unfiltered Rust workspace tests. This does not replace hosted CI or authorize issue closure before merge.'
}
$record.drivers=@{}
foreach($name in @('run-issue262-check-final-r1.ps1','capture-issue262-source-r3.py','issue262_source_guard_r2.py')) {
    $record.drivers[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant()
}
function Save-Record {$record|ConvertTo-Json -Depth 15|Set-Content -LiteralPath $receiptPath -Encoding utf8}
$priorIssue262Path=$env:PATH
$priorIssue262Python=$env:PYTHON
$priorIssue262Threads=$env:RUST_TEST_THREADS
$checkExit=1
$issue262PriorBytecode=$env:PYTHONDONTWRITEBYTECODE
$env:PYTHONDONTWRITEBYTECODE='1'
Push-Location -LiteralPath $issueWorktree
try {
    $env:PATH="$issuePythonDir;$priorIssue262Path"
    $env:PYTHON=$issuePython
    $env:RUST_TEST_THREADS='1'
    if((Get-Command python.exe).Source -cne $issuePython){throw 'Python resolution is incorrect.'}
    $record.python=@{path=$issuePython;version=(& python --version);sha256=(Get-FileHash -LiteralPath $issuePython).Hash.ToLowerInvariant()}
    $record.versions=@{node=(& node --version);pnpm=(& pnpm --version);cargo=(& cargo --version)}
    $record.lock_sha256=@{}
    foreach($relative in @('pnpm-lock.yaml','scenarios/repo-steward/package-lock.json','Cargo.lock')){
        $record.lock_sha256[$relative]=(Get-FileHash -LiteralPath (Join-Path $issueWorktree $relative)).Hash.ToLowerInvariant()
    }
    Save-Record
    & $issuePython -B -X utf8 (Join-Path $PSScriptRoot 'capture-issue262-source-r3.py') --phase before-check-final-r1 --equals "after-native-$NativeAttempt"
    if($LASTEXITCODE -ne 0){throw 'Final source does not match the completed native acceptance source.'}
    $record.source_receipt=Join-Path $PSScriptRoot 'issue262-source-before-check-final-r1.json'
    $record.status='running';Save-Record
    & pnpm check *> $logPath
    $checkExit=$LASTEXITCODE
    $record.exit_code=$checkExit
    $record.log_sha256=(Get-FileHash -LiteralPath $logPath).Hash.ToLowerInvariant()
    $reportLine=Get-Content -LiteralPath $logPath|Where-Object {$_ -like 'Validation report: *'}|Select-Object -Last 1
    if(!$reportLine){throw 'Canonical report path was not recorded; inspect the retained log.'}
    $reportPath=$reportLine.Substring('Validation report: '.Length)
    $record.canonical_report=$reportPath
    $canonical=Get-Content -LiteralPath $reportPath -Raw|ConvertFrom-Json
    $record.canonical_sha256=(Get-FileHash -LiteralPath $reportPath).Hash.ToLowerInvariant()
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
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'issue262-source-before-check-final-r1.json')){
        & $issuePython -B -X utf8 (Join-Path $PSScriptRoot 'capture-issue262-source-r3.py') --phase after-check-final-r1 --equals before-check-final-r1
        if($LASTEXITCODE -eq 0){$record.physical_source_unchanged=$true}
        else{$record.status='failed';$record.source_error='Final physical source equality failed.';$checkExit=1}
    }
    $record.completed_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Record
    $env:PATH=$priorIssue262Path
    $env:PYTHON=$priorIssue262Python
    $env:RUST_TEST_THREADS=$priorIssue262Threads
    foreach($name in $record.drivers.Keys) {
        if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant() -cne $record.drivers[$name]) {
            $record.status='failed';$record.driver_error='Validation driver changed.';Save-Record
            throw 'Validation driver changed.'
        }
    }
    $env:PYTHONDONTWRITEBYTECODE=$issue262PriorBytecode
    Pop-Location
}
exit $checkExit
