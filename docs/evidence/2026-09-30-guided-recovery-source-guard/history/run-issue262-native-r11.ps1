#requires -Version 7.5
[CmdletBinding()]
param([ValidatePattern('^r[0-9]+$')][string]$Attempt='r11')
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue262-recovery\ecorp'
$issueQa="<USERPROFILE>\qa\pr265-run-activity-issue262-alias-20260930-$Attempt"
$issuePostgres='<USERPROFILE>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot "issue262-native-$Attempt.json"
$sourceBefore=Join-Path $PSScriptRoot "issue262-source-before-native-$Attempt.json"
foreach($path in @($receiptPath,$issueQa,$sourceBefore)) {if(Test-Path -LiteralPath $path){throw 'Preserve prior acceptance attempts and QA resources.'}}
$canonical=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'issue262-coverage-r1.json') -Raw|ConvertFrom-Json
if($canonical.status -cne 'passed' -or $canonical.exit_code -ne 0 -or !$canonical.physical_source_unchanged){throw 'Require complete matching-source model coverage before native acceptance; final canonical validation remains mandatory before publication.'}
$record=[ordered]@{issue=262;status='starting';qa_root=$issueQa;worktree=$issueWorktree;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');steps=@();stopped=$false;drivers=@{};binaries=@{};final_source_canonical_validation='pending; mandatory before publication';focused_regressions='issue262-source-guard-focused-r1.json';coverage_receipt='issue262-coverage-r1.json';scope='Fresh owned browser/server/PostgreSQL/runner acceptance. Existing deterministic fake-process and synthetic Codex native-protocol fixture; no real inference, human decisions, production identity or GitHub effects. Browser-only variants are identified separately.'}
foreach($name in @('run-issue262-native-r11.ps1','issue262-native-browser-r9.mjs','issue262-native-revision-cases-r4.mjs','issue262-native-recovery-cases-r4.mjs','issue262-native-warning-cases-r1.mjs','issue262-native-codex-r1.ps1','issue264-native-admission-r1.mjs','capture-issue262-source-r3.py','issue262_source_guard_r2.py')) {
    $record.drivers[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant()
}
function Save-Record { $record|ConvertTo-Json -Depth 14|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
function Run-Step([string]$Name,[string]$Program,[string[]]$Arguments) {
    $log=Join-Path $PSScriptRoot "issue262-native-$Attempt-$Name.log"
    if(Test-Path -LiteralPath $log){throw 'Preserve existing native log.'}
    $started=[DateTimeOffset]::UtcNow.ToString('o');$stepError=$null;$global:LASTEXITCODE=0
    try {
        if ($Program.EndsWith('.ps1', [StringComparison]::OrdinalIgnoreCase)) {
            if ($Program -ceq (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1')) {
                if ($Arguments.Count -ne 6 -or $Arguments[0] -cne '-Phase' -or
                    $Arguments[2] -cne '-QaRoot' -or $Arguments[4] -cne '-PostgresBin') { throw 'Unexpected supervisor arguments.' }
                $named=@{Phase=$Arguments[1];QaRoot=$Arguments[3];PostgresBin=$Arguments[5]}
            } elseif ($Program -ceq (Join-Path $PSScriptRoot 'issue262-native-codex-r1.ps1')) {
                if ($Arguments.Count -ne 4 -or $Arguments[0] -cne '-QaRoot' -or
                    $Arguments[2] -cne '-ProductRoot') { throw 'Unexpected native adapter arguments.' }
                $named=@{QaRoot=$Arguments[1];ProductRoot=$Arguments[3]}
            } else { throw 'Unknown PowerShell validation step.' }
            # Direct script invocation matches prior successful owned-stack drivers.
            # A nested native pwsh held r2 open after its startup process exited.
            & $Program @named *> $log
            $nativeExit=0
        } else {
            & $Program @Arguments *> $log
            $nativeExit=$LASTEXITCODE
        }
    }
    catch { $nativeExit=1;$stepError=$_.Exception.Message }
    $entry=@{name=$Name;command=@($Program)+$Arguments;started_at_utc=$started;finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');exit_code=$nativeExit;log=$log}
    if(Test-Path -LiteralPath $log){$entry.sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()}
    if($stepError){$entry.error=$stepError}
    $record.steps+=@($entry);Save-Record
    [pscustomobject]@{step=$Name;exit_code=$nativeExit}|ConvertTo-Json -Compress
    if($nativeExit -ne 0){throw "Native acceptance step $Name failed with exit $nativeExit; inspect retained evidence."}
}
$failure=$null
$issue262PriorBytecode=$env:PYTHONDONTWRITEBYTECODE
$env:PYTHONDONTWRITEBYTECODE='1'
Push-Location -LiteralPath $issueWorktree
try {
    Save-Record
    Run-Step 'source-before' $issuePython @('-B','-X','utf8',(Join-Path $PSScriptRoot 'capture-issue262-source-r3.py'),'--phase',"before-native-$Attempt",'--equals','after-coverage-r1')
    Run-Step 'build' 'cargo' @('build','--locked','-p','crony-server','-p','crony-runner','--bins')
    foreach($name in @('crony-server.exe','crony-runner.exe')) {
        $binary=Join-Path $issueWorktree "target\debug\$name"
        $record.binaries[$name]=@{sha256=(Get-FileHash -LiteralPath $binary).Hash.ToLowerInvariant();length=(Get-Item -LiteralPath $binary).Length}
    }
    Save-Record
    $supervisor=Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1'
    Run-Step 'dry-run' $supervisor @('-Phase','DryRun','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'start' $supervisor @('-Phase','Start','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'native-codex' (Join-Path $PSScriptRoot 'issue262-native-codex-r1.ps1') @('-QaRoot',$issueQa,'-ProductRoot',$issueWorktree)
    Run-Step 'status' $supervisor @('-Phase','Status','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    $record.status='accepting';Save-Record
    $sourceDigest=(Get-FileHash -LiteralPath $sourceBefore).Hash.ToLowerInvariant()
    Run-Step 'browser' 'node' @((Join-Path $PSScriptRoot 'issue262-native-browser-r9.mjs'),'--qa-root',$issueQa,'--postgres-bin',$issuePostgres,'--source-receipt',$sourceBefore,'--product-root',$issueWorktree,'--source-receipt-sha256',$sourceDigest)
    $browserReportPath=Join-Path $issueQa 'evidence\issue262-native-browser.json'
    $browserReport=Get-Content -LiteralPath $browserReportPath -Raw|ConvertFrom-Json
    if($browserReport.status -cne 'accepted' -or $browserReport.failures.Count){throw 'Native browser report is not accepted.'}
    $record.browser_report=$browserReportPath
    $record.browser_report_sha256=(Get-FileHash -LiteralPath $browserReportPath).Hash.ToLowerInvariant()
    $record.checks=@($browserReport.checks.PSObject.Properties.Name)
    $record.status='accepted';Save-Record
} catch {
    $failure=$_.Exception.Message;$record.status='failed';$record.error=$failure;Save-Record
} finally {
    if(Test-Path -LiteralPath $sourceBefore) {
        try {
            Run-Step 'source-after' $issuePython @('-B','-X','utf8',(Join-Path $PSScriptRoot 'capture-issue262-source-r3.py'),'--phase',"after-native-$Attempt",'--equals',"before-native-$Attempt")
            foreach($name in $record.drivers.Keys){if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant() -cne $record.drivers[$name]){throw 'Acceptance driver changed during validation.'}}
            $record.physical_source_unchanged=$true
        } catch {$record.source_error=$_.Exception.Message;$record.status='failed';if(!$failure){$failure=$record.source_error}}
    }
    if(Test-Path -LiteralPath (Join-Path $issueQa 'ownership.json')) {
        try {
            Run-Step 'stop' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Stop','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
            $record.stopped=$true
        } catch {$record.stop_error=$_.Exception.Message;$record.status='failed';if(!$failure){$failure=$record.stop_error}}
    }
    $record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Record
    $env:PYTHONDONTWRITEBYTECODE=$issue262PriorBytecode
    Pop-Location
}
if($failure){throw $failure}
Write-Output 'Native issue262 acceptance passed; exact owned services stopped and fixture data retained.'
