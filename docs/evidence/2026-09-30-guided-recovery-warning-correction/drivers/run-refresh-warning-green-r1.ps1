#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue262-recovery\ecorp'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot 'refresh-warning-green-r1.json'
$logPath=Join-Path $PSScriptRoot 'refresh-warning-green-r1.log'
foreach($path in @($receiptPath,$logPath)){if(Test-Path -LiteralPath $path){throw 'Preserve prior regression evidence.'}}
$red=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'refresh-warning-red.json') -Raw|ConvertFrom-Json
if($red.exit_code -ne 1 -or !$red.physical_source_unchanged){throw 'Retain the observed red regression before checking the fix.'}
$record=[ordered]@{issue=262;pr=389;comment=4145802423;status='starting';kind='retrospective_regression_after_guard_fix';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');worktree=$issueWorktree;command=@('node','--test','--test-concurrency=2','--test-timeout=180000','--test-reporter=tap','apps/web/src/contractRevision.test.mjs','apps/web/src/contractRevisionLifecycle.test.mjs');log=$logPath;exit_code=$null}
function Save-Record {$record|ConvertTo-Json -Depth 15|Set-Content -LiteralPath $receiptPath -Encoding utf8}
$greenExit=1
Push-Location -LiteralPath $issueWorktree
try {
    Save-Record
    & $issuePython -X utf8 (Join-Path $PSScriptRoot 'capture-issue262-source-r1.py') --phase refresh-warning-green-before
    if($LASTEXITCODE -ne 0){throw 'Source capture failed before regressions.'}
    $record.source_before=Join-Path $PSScriptRoot 'issue262-source-refresh-warning-green-before.json'
    $record.status='running';Save-Record
    & node --test --test-concurrency=2 --test-timeout=180000 --test-reporter=tap apps/web/src/contractRevision.test.mjs apps/web/src/contractRevisionLifecycle.test.mjs *> $logPath
    $greenExit=$LASTEXITCODE
    $record.exit_code=$greenExit
    $record.log_sha256=(Get-FileHash -LiteralPath $logPath).Hash.ToLowerInvariant()
    $lines=Get-Content -LiteralPath $logPath
    $record.summary=@($lines|Where-Object{$_ -match '^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) |^not ok '})
    $record.status=if($greenExit -eq 0){'passed'}else{'failed'}
    Save-Record
    $record.summary
} catch {
    $record.status='failed';$record.error=$_.Exception.Message;$greenExit=1;Save-Record
} finally {
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'issue262-source-refresh-warning-green-before.json')){
        & $issuePython -X utf8 (Join-Path $PSScriptRoot 'capture-issue262-source-r1.py') --phase refresh-warning-green-after --equals refresh-warning-green-before
        if($LASTEXITCODE -eq 0){$record.physical_source_unchanged=$true;$record.source_after=Join-Path $PSScriptRoot 'issue262-source-refresh-warning-green-after.json'}
        else{$record.status='failed';$record.source_error='Source changed during regressions.';$greenExit=1}
    }
    $record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Record
    Pop-Location
}
exit $greenExit
