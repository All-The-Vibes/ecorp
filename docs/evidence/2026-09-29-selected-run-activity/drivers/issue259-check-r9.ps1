#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue136-browser-docs\ecorp'
$issuePythonDir='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python'
$issuePython=Join-Path $issuePythonDir 'python.exe'
$logPath=Join-Path $PSScriptRoot 'issue259-check-r9.log'
$receiptPath=Join-Path $PSScriptRoot 'issue259-check-r9.json'
foreach($path in @($logPath,$receiptPath)){if(Test-Path -LiteralPath $path){throw 'Preserve this canonical validation attempt.'}}
$nativePath=Join-Path $PSScriptRoot 'issue259-native-r8.json'
$native=Get-Content -LiteralPath $nativePath -Raw|ConvertFrom-Json
if($native.status -cne 'accepted' -or !$native.stopped){throw 'Native acceptance and exact owned stack shutdown must pass first.'}
$record=[ordered]@{
    issue=259;status='starting';command='pnpm check';worktree=$issueWorktree
    started_at=[DateTimeOffset]::UtcNow.ToString('o');exit_code=$null
    rust_test_threads=1;all_named_gates_enabled=$true
    native_receipt=$nativePath;native_receipt_sha256=(Get-FileHash -LiteralPath $nativePath -Algorithm SHA256).Hash.ToLowerInvariant()
    log=$logPath;canonical_report=$null
    note='Canonical full plan with frozen installed dependencies. Serial Rust execution is explicit; no tests filtered out. Bundled Python is first on process PATH to avoid the Windows Store alias. No TLS, pnpm or security protection is changed.'
}
function Save-Record { $record|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
$priorIssue259Path=$env:PATH
$priorIssue259Python=$env:PYTHON
$priorIssue259Threads=$env:RUST_TEST_THREADS
$checkExit=1
Push-Location -LiteralPath $issueWorktree
try {
    $env:PATH="$issuePythonDir;$priorIssue259Path"
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
    & $issuePython (Join-Path $PSScriptRoot 'capture-issue259-source-r9.py') --phase before-check
    if($LASTEXITCODE -ne 0){throw 'Pre-check physical source capture failed.'}
    $record.source_receipt=Join-Path $PSScriptRoot 'issue259-source-before-check-r9.json'
    $record.status='running';Save-Record
    & pnpm check *> $logPath
    $checkExit=$LASTEXITCODE
    $record.exit_code=$checkExit
    $record.completed_at=[DateTimeOffset]::UtcNow.ToString('o')
    $record.log_sha256=(Get-FileHash -LiteralPath $logPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $reportLine=Get-Content -LiteralPath $logPath|Where-Object {$_ -like 'Validation report: *'}|Select-Object -Last 1
    if(!$reportLine){throw 'Canonical report path not recorded; inspect the retained log.'}
    $reportPath=$reportLine.Substring('Validation report: '.Length)
    $record.canonical_report=$reportPath
    $canonical=Get-Content -LiteralPath $reportPath -Raw|ConvertFrom-Json
    $record.canonical_sha256=(Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $record.canonical_status=$canonical.status
    $record.source_changed=$canonical.sourceChangedDuringValidation
    $record.checks=@($canonical.checks|Select-Object name,argv,passed,exitCode,durationMs,counts,errorCode)
    $record.not_run=@($canonical.notRun)
    $expectedGates=@('migrations','state-audit-compatibility','state-audit-evm','docs','repository-docs','node-tests','format','clippy','rust-tests','web-build','web-lint')
    $observedGates=@($canonical.checks|ForEach-Object{$_.name})
    $failedGates=@($canonical.checks|Where-Object{!$_.passed -or $_.exitCode -ne 0 -or $_.errorCode})
    $record.status=if($checkExit -eq 0 -and $canonical.status -ceq 'passed' -and $canonical.sourceChangedDuringValidation -eq $false -and !$canonical.notRun.Count -and ($observedGates -join '|') -ceq ($expectedGates -join '|') -and !$failedGates.Count){'passed'}else{'failed'}
    Save-Record
    if($record.status -ceq 'passed'){
        & $issuePython (Join-Path $PSScriptRoot 'capture-issue259-source-r9.py') --phase after-check
        if($LASTEXITCODE -ne 0){throw 'Post-check physical source equality failed.'}
        $record.physical_source_unchanged=$true
        Save-Record
    } else { $checkExit=1 }
    Get-Content -LiteralPath $logPath -Tail 28
} catch {
    $record.status='failed'
    $record.error=$_.Exception.Message
    $record.completed_at=[DateTimeOffset]::UtcNow.ToString('o')
    Save-Record
    throw
} finally {
    $env:PATH=$priorIssue259Path
    $env:PYTHON=$priorIssue259Python
    $env:RUST_TEST_THREADS=$priorIssue259Threads
    Pop-Location
}
exit $checkExit
