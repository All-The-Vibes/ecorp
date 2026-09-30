#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue262-recovery\ecorp'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot 'issue262-source-guard-focused-r1.json'
$logPath=Join-Path $PSScriptRoot 'issue262-source-guard-focused-r1.log'
foreach($path in @($receiptPath,$logPath)){if(Test-Path -LiteralPath $path){throw 'Preserve prior regression evidence.'}}
$record=[ordered]@{issue=262;pr=389;comments=@(4146642007,4146642079,4146642119,4146642183);status='starting';kind='fresh_regression_with_native_source_alias_guard';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');worktree=$issueWorktree;command=@('node','--test','--test-concurrency=2','--test-timeout=180000','--test-reporter=tap','apps/web/src/contractRevision.test.mjs','apps/web/src/contractRevisionLifecycle.test.mjs');log=$logPath;exit_code=$null}
$record.drivers=@{}
foreach($name in @('run-issue262-source-guard-focused-r1.ps1','capture-issue262-source-r3.py','issue262_source_guard_r2.py')) {
    $record.drivers[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant()
}
function Save-Record {$record|ConvertTo-Json -Depth 15|Set-Content -LiteralPath $receiptPath -Encoding utf8}
$greenExit=1
$issue262PriorBytecode=$env:PYTHONDONTWRITEBYTECODE
$env:PYTHONDONTWRITEBYTECODE='1'
Push-Location -LiteralPath $issueWorktree
try {
    Save-Record
    & $issuePython -B -X utf8 (Join-Path $PSScriptRoot 'capture-issue262-source-r3.py') --phase focused-before-r1
    if($LASTEXITCODE -ne 0){throw 'Source capture failed before regressions.'}
    $record.source_before=Join-Path $PSScriptRoot 'issue262-source-focused-before-r1.json'
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
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'issue262-source-focused-before-r1.json')){
        & $issuePython -B -X utf8 (Join-Path $PSScriptRoot 'capture-issue262-source-r3.py') --phase focused-after-r1 --equals focused-before-r1
        if($LASTEXITCODE -eq 0){$record.physical_source_unchanged=$true;$record.source_after=Join-Path $PSScriptRoot 'issue262-source-focused-after-r1.json'}
        else{$record.status='failed';$record.source_error='Source changed during regressions.';$greenExit=1}
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
exit $greenExit
