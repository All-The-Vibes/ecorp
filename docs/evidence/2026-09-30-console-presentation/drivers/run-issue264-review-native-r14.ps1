#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue264-modes\ecorp'
$issueQa='<USERPROFILE>\qa\pr265-run-activity-issue264-20260930-r14'
$issuePostgres='<USERPROFILE>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot 'issue264-review-native-r14.json'
$sourceBefore=Join-Path $PSScriptRoot 'issue264-review-source-before-native-r14.json'
$sourceAfter=Join-Path $PSScriptRoot 'issue264-review-source-after-native-r14.json'
foreach($path in @($receiptPath,$issueQa,$sourceBefore,$sourceAfter)){
    if(Test-Path -LiteralPath $path){throw 'Preserve prior acceptance attempts and QA resources.'}
}
$record=[ordered]@{
    issues=@(263,264);status='starting';qa_root=$issueQa;worktree=$issueWorktree
    started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');steps=@();stopped=$false
    reason='Fresh development acceptance of the combined presentation source, including the later PR385 history correction and semantic root/office theme fixes. Source capture must bind the actual pending merge and physical bytes. Fresh owned browser/server/PostgreSQL/native-runner acceptance. Real signed provider and source artifacts, manifest/text/diff reads, exact identities, authorization denial, reviewer eligibility, historical selection, mobile keyboard, reconnect and original downloads. Two scripted development Bob decisions are not human reviews. Separate synthetic browser states are explicitly identified and must leave native records unchanged. No provider inference, production identity or real GitHub effects.'
    drivers=@{};binaries=@{}
}
foreach($name in @('issue264-native-browser-r14.mjs','issue264-native-admission-r1.mjs','issue264-native-mission-create-r2.mjs','issue260-browser-variants-r4.mjs','capture-issue264-review-source-r2.py','issue264-presentation-browser-r12.mjs','issue264-presentation-variants-r13.mjs')){
    $record.drivers[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Save-Record { $record|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
function Run-Step([string]$Name,[string]$Program,[string[]]$Arguments){
    $log=Join-Path $PSScriptRoot "issue264-review-native-r14-$Name.log"
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
    $record.steps+=@($entry);Save-Record
    [pscustomobject]@{step=$Name;exit_code=$nativeExit}|ConvertTo-Json -Compress
    if($nativeExit -ne 0){throw "Native acceptance step $Name failed with exit $nativeExit; inspect retained evidence."}
}
$failure=$null
Push-Location -LiteralPath $issueWorktree
try {
    Save-Record
    Run-Step 'source-before' $issuePython @('-X','utf8',(Join-Path $PSScriptRoot 'capture-issue264-review-source-r2.py'),'--phase','before-native-r14','--equals','after-dependencies-r2')
    Run-Step 'build' 'cargo' @('build','--locked','-p','crony-server','-p','crony-runner','--bins')
    foreach($name in @('crony-server.exe','crony-runner.exe')){
        $binary=Join-Path $issueWorktree "target\debug\$name"
        $record.binaries[$name]=@{sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant();length=(Get-Item -LiteralPath $binary).Length}
    }
    Save-Record
    Run-Step 'dry-run' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','DryRun','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'start' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Start','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'status' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Status','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'prepare' $issuePython @('-X','utf8','tools/e2e_factory_run_activity.py','--qa-root',$issueQa,'--postgres-bin',$issuePostgres,'--phase','prepare')
    $record.status='accepting';Save-Record
    $sourceDigest=(Get-FileHash -LiteralPath $sourceBefore -Algorithm SHA256).Hash.ToLowerInvariant()
    Run-Step 'browser' 'node' @((Join-Path $PSScriptRoot 'issue264-native-browser-r14.mjs'),'--qa-root',$issueQa,'--postgres-bin',$issuePostgres,'--source-receipt',$sourceBefore,'--product-root',$issueWorktree,'--source-receipt-sha256',$sourceDigest)
    $browserReportPath=Join-Path $issueQa 'evidence\issue264-native-browser.json'
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
            Run-Step 'source-after' $issuePython @('-X','utf8',(Join-Path $PSScriptRoot 'capture-issue264-review-source-r2.py'),'--phase','after-native-r14','--equals','before-native-r14')
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
            Run-Step 'stop' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Stop','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
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
Write-Output 'Native issue264 acceptance passed; only exact owned services stopped and all fixture data retained.'
