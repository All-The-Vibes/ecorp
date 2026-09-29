#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue136-browser-docs\ecorp'
$issueQa='<USERPROFILE>\qa\pr265-run-activity-issue259-20260929-r8'
$issuePostgres='<USERPROFILE>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot 'issue259-native-r8.json'
if((Test-Path -LiteralPath $receiptPath) -or (Test-Path -LiteralPath $issueQa)){throw 'Preserve existing acceptance attempt or QA resources.'}
$record=[ordered]@{
    issue=259;status='starting';qa_root=$issueQa;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    steps=@();stopped=$false
    reason='New owned fixture after correcting the quarantine driver to distinguish the optional exported-head API guard from the observed Git HEAD. Require the archive/no-commit null guard, preserve it in authorization, and verify the actual pinned HEAD before mutation and after quarantine. All native lifecycle, fingerprint, sentinel and browser assertions remain. Product source and primary browser driver are unchanged; earlier attempts remain intact.'
    drivers=@{}
}
foreach($name in @('issue259-browser-r3.mjs','issue259-native-edges-r6.mjs','capture-issue259-source-r8.py')){
    $record.drivers[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Save-Record { $record|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
function Run-Step([string]$Name,[string]$Program,[string[]]$Arguments){
    $log=Join-Path $PSScriptRoot "issue259-native-r8-$Name.log"
    if(Test-Path -LiteralPath $log){throw 'Preserve existing native log.'}
    $started=[DateTimeOffset]::UtcNow.ToString('o')
    $global:LASTEXITCODE=0
    $stepError=$null
    try {
        if($Program.EndsWith('.ps1',[StringComparison]::OrdinalIgnoreCase)){
            if($Arguments.Count -ne 6 -or $Arguments[0] -cne '-Phase' -or $Arguments[2] -cne '-QaRoot' -or $Arguments[4] -cne '-PostgresBin'){throw 'Unexpected supervisor arguments.'}
            $named=@{Phase=$Arguments[1];QaRoot=$Arguments[3];PostgresBin=$Arguments[5]}
            & $Program @named *> $log
        } else { & $Program @Arguments *> $log }
        $nativeExit=$LASTEXITCODE
    } catch { $nativeExit=1; $stepError=$_.Exception.Message }
    $entry=@{name=$Name;command=@($Program)+$Arguments;started_at_utc=$started;finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');exit_code=$nativeExit;log=$log}
    if(Test-Path -LiteralPath $log){$entry.sha256=(Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash.ToLowerInvariant()}
    if($stepError){$entry.error=$stepError}
    $record.steps+=@($entry)
    Save-Record
    [pscustomobject]@{step=$Name;exit_code=$nativeExit}|ConvertTo-Json -Compress
    if($nativeExit -ne 0){throw "Native acceptance step $Name failed with exit $nativeExit; inspect retained evidence."}
}
$failure=$null
Push-Location -LiteralPath $issueWorktree
try {
    Save-Record
    Run-Step 'source-before' $issuePython @((Join-Path $PSScriptRoot 'capture-issue259-source-r8.py'),'--phase','before-native')
    Run-Step 'dry-run' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','DryRun','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'start' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Start','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'status' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Status','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'prepare' $issuePython @('tools/e2e_factory_run_activity.py','--qa-root',$issueQa,'--postgres-bin',$issuePostgres,'--phase','prepare')
    $record.status='accepting';Save-Record
    Run-Step 'browser' 'node' @((Join-Path $PSScriptRoot 'issue259-browser-r3.mjs'),'--qa-root',$issueQa,'--postgres-bin',$issuePostgres)
    $main=Get-Content -LiteralPath (Join-Path $issueQa 'evidence\issue259-browser.json') -Raw|ConvertFrom-Json
    if($main.status -cne 'accepted' -or $main.failures.Count){throw 'Main native report is not accepted.'}
    foreach($nativeCase in @('offline','suspension','quarantine')){
        Run-Step $nativeCase 'node' @((Join-Path $PSScriptRoot 'issue259-native-edges-r6.mjs'),'--qa-root',$issueQa,'--postgres-bin',$issuePostgres,'--case',$nativeCase)
        $caseReport=Get-Content -LiteralPath (Join-Path $issueQa "evidence\issue259-native-$nativeCase-r6.json") -Raw|ConvertFrom-Json
        if($caseReport.status -cne 'accepted' -or $caseReport.failures.Count){throw "Native $nativeCase report is not accepted."}
    }
    Run-Step 'source-after' $issuePython @((Join-Path $PSScriptRoot 'capture-issue259-source-r8.py'),'--phase','after-native')
    foreach($name in $record.drivers.Keys){
        if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.drivers[$name]){throw 'Acceptance driver changed during validation.'}
    }
    $record.status='accepted';Save-Record
} catch {
    $failure=$_.Exception.Message
    $record.status='failed';$record.error=$failure;Save-Record
} finally {
    if(Test-Path -LiteralPath (Join-Path $issueQa 'ownership.json')){
        try {
            Run-Step 'stop' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Stop','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
            $record.stopped=$true
        } catch {
            $record.stop_error=$_.Exception.Message
            $record.status='failed'
            if(!$failure){$failure=$record.stop_error}
        }
    }
    $record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Record
    Pop-Location
}
if($failure){throw $failure}
Write-Output 'Native issue259 acceptance passed; only exact owned services stopped and all fixture data retained.'
