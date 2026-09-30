#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue261-budgets\ecorp'
$issueQa='<USERPROFILE>\qa\pr265-run-activity-issue261-20260930-r1'
$issuePostgres='<USERPROFILE>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot 'issue261-review-native-r1.json'
$sourceBefore=Join-Path $PSScriptRoot 'issue261-review-source-before-native-r1.json'
$sourceAfter=Join-Path $PSScriptRoot 'issue261-review-source-after-native-r1.json'
foreach($path in @($receiptPath,$issueQa,$sourceBefore,$sourceAfter)){
    if(Test-Path -LiteralPath $path){throw 'Preserve prior acceptance attempts and QA resources.'}
}
$canonicalPath=Join-Path $PSScriptRoot 'issue261-review-check-r1.json'
$canonical=Get-Content -LiteralPath $canonicalPath -Raw|ConvertFrom-Json
if($canonical.status -cnotin @('running','passed') -or !(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'issue261-review-source-before-check-r1.json'))){throw 'Require the existing canonical validation and its captured source; preserve any failed check.'}
$record=[ordered]@{
    issue=261;status='starting';qa_root=$issueQa;worktree=$issueWorktree
    started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');steps=@();stopped=$false
    reason='Fresh owned browser/server/native-runner budget acceptance of the integrated PR385 corrections and current budget source. A real prepared three-task graph is launched and verified through browser actions. Separate cancelled synthetic ledger rows exercise retries, resumed lineage, auditor attribution, missing history and revision display; they do not claim native provider recovery, actual human decisions or approved grants. Independent SQL aggregates, exact navigation, revoked access, stale/failed reads, keyboard and mobile are checked. No production identity, provider inference or real GitHub effects.'
    canonical_receipt=$canonicalPath;canonical_status_at_start=$canonical.status
    canonical_initial_sha256=(Get-FileHash -LiteralPath $canonicalPath -Algorithm SHA256).Hash.ToLowerInvariant()
    drivers=@{};binaries=@{}
}
foreach($name in @('issue261-review-browser-r1.mjs','capture-issue261-review-source-r1.py')){
    $record.drivers[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Save-Record { $record|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
function Run-Step([string]$Name,[string]$Program,[string[]]$Arguments){
    $log=Join-Path $PSScriptRoot "issue261-review-native-r1-$Name.log"
    if(Test-Path -LiteralPath $log){throw 'Preserve existing native log.'}
    $started=[DateTimeOffset]::UtcNow.ToString('o')
    $global:LASTEXITCODE=0
    $stepError=$null
    try {
        if($Program.EndsWith('.ps1',[StringComparison]::OrdinalIgnoreCase)){
            if($Arguments.Count -ne 12 -or $Arguments[0] -cne '-Phase' -or $Arguments[2] -cne '-QaRoot' -or $Arguments[4] -cne '-PostgresBin' -or $Arguments[6] -cne '-ServerPort' -or $Arguments[7] -cne '18867' -or $Arguments[8] -cne '-WebPort' -or $Arguments[9] -cne '15867' -or $Arguments[10] -cne '-DatabasePort' -or $Arguments[11] -cne '15467'){throw 'Unexpected supervisor arguments.'}
            $named=@{Phase=$Arguments[1];QaRoot=$Arguments[3];PostgresBin=$Arguments[5];ServerPort=[int]$Arguments[7];WebPort=[int]$Arguments[9];DatabasePort=[int]$Arguments[11]}
            & $Program @named *> $log
        } else { & $Program @Arguments *> $log }
        $nativeExit=$LASTEXITCODE
    } catch { $nativeExit=1; $stepError=$_.Exception.Message }
    $entry=@{name=$Name;command=@($Program)+$Arguments;started_at_utc=$started;finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');exit_code=$nativeExit;log=$log}
    if(Test-Path -LiteralPath $log){$entry.sha256=(Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash.ToLowerInvariant()}
    if($stepError){$entry.error=$stepError}
    $record.steps+=@($entry);Save-Record
    [pscustomobject]@{step=$Name;exit_code=$nativeExit}|ConvertTo-Json -Compress
    if($nativeExit -ne 0){throw "Native acceptance step $Name failed with exit $nativeExit; inspect retained evidence."}
}
$failure=$null
Push-Location -LiteralPath $issueWorktree
try {
    Save-Record
    Run-Step 'source-before' $issuePython @('-X','utf8',(Join-Path $PSScriptRoot 'capture-issue261-review-source-r1.py'),'--phase','before-native-r1','--equals','before-check-r1')
    Run-Step 'build' 'cargo' @('build','--locked','-p','crony-server','-p','crony-runner','--bins')
    foreach($name in @('crony-server.exe','crony-runner.exe')){
        $binary=Join-Path $issueWorktree "target\debug\$name"
        $record.binaries[$name]=@{sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant();length=(Get-Item -LiteralPath $binary).Length}
    }
    Save-Record
    Run-Step 'dry-run' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','DryRun','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres,'-ServerPort','18867','-WebPort','15867','-DatabasePort','15467')
    Run-Step 'start' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Start','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres,'-ServerPort','18867','-WebPort','15867','-DatabasePort','15467')
    Run-Step 'status' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Status','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres,'-ServerPort','18867','-WebPort','15867','-DatabasePort','15467')
    Run-Step 'prepare' $issuePython @('-X','utf8','tools/e2e_factory_run_activity.py','--qa-root',$issueQa,'--postgres-bin',$issuePostgres,'--phase','prepare')
    $record.status='accepting';Save-Record
    Run-Step 'browser' 'node' @((Join-Path $PSScriptRoot 'issue261-review-browser-r1.mjs'),'--qa-root',$issueQa,'--postgres-bin',$issuePostgres,'--source-receipt',$sourceBefore)
    $browserReportPath=Join-Path $issueQa 'evidence\issue261-browser.json'
    $browserReport=Get-Content -LiteralPath $browserReportPath -Raw|ConvertFrom-Json
    if($browserReport.status -cne 'accepted' -or $browserReport.failures.Count){throw 'Native browser report is not accepted.'}
    $record.browser_report=$browserReportPath
    $record.browser_report_sha256=(Get-FileHash -LiteralPath $browserReportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $record.checks=@($browserReport.checks.PSObject.Properties.Name)
    $record.status='accepted';Save-Record
} catch {
    $failure=$_.Exception.Message
    $record.status='failed';$record.error=$failure;Save-Record
} finally {
    if(Test-Path -LiteralPath $sourceBefore){
        try {
            Run-Step 'source-after' $issuePython @('-X','utf8',(Join-Path $PSScriptRoot 'capture-issue261-review-source-r1.py'),'--phase','after-native-r1','--equals','before-native-r1')
            foreach($name in $record.drivers.Keys){
                if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.drivers[$name]){throw 'Acceptance driver changed during validation.'}
            }
            $record.physical_source_unchanged=$true
        } catch {
            $record.source_error=$_.Exception.Message;$record.status='failed'
            if(!$failure){$failure=$record.source_error}
        }
    }
    if(Test-Path -LiteralPath (Join-Path $issueQa 'ownership.json')){
        try {
            Run-Step 'stop' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Stop','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres,'-ServerPort','18867','-WebPort','15867','-DatabasePort','15467')
            $record.stopped=$true
        } catch {
            $record.stop_error=$_.Exception.Message;$record.status='failed'
            if(!$failure){$failure=$record.stop_error}
        }
    }
    $record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Record
    Pop-Location
}
if($failure){throw $failure}
Write-Output 'Native issue261 acceptance passed; only exact owned services stopped and all fixture data retained.'
