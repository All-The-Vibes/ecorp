#requires -Version 7.5
$ErrorActionPreference='Stop'
$issueWorktree='<USERPROFILE>\.codex\worktrees\issue258-history\ecorp'
$issueQa='<USERPROFILE>\qa\pr265-run-activity-issue258-20260929-r5'
$issuePostgres='<USERPROFILE>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$issuePython='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$receiptPath=Join-Path $PSScriptRoot 'issue258-native-r5.json'
$sourceBefore=Join-Path $PSScriptRoot 'issue258-source-before-native-r5.json'
$sourceAfter=Join-Path $PSScriptRoot 'issue258-source-after-native-r5.json'
foreach($path in @($receiptPath,$issueQa,$sourceBefore,$sourceAfter)){
    if(Test-Path -LiteralPath $path){throw 'Preserve prior acceptance attempts and QA resources.'}
}
$record=[ordered]@{
    issue=258;status='starting';qa_root=$issueQa;worktree=$issueWorktree
    started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');steps=@();stopped=$false
    reason='Fifth owned browser/server/native-runner history acceptance attempt. Prior attempts are retained. r4 reload replayed development bootstrap and restored revoked demo membership. r5 waits for actor-specific snapshots and reauthorizes without reloading during revocation, asserting the actual membership remains absent, saved exact selection remains unavailable and history stays denied. Seeded cancelled history is separate from genuinely prepared, launched and reviewed native tasks. No provider inference, production identity, real GitHub effects or source checkout mutation.'
    drivers=@{};binaries=@{}
}
foreach($name in @('issue258-browser-r5.mjs','capture-issue258-source-r1.py')){
    $record.drivers[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Save-Record { $record|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
function Run-Step([string]$Name,[string]$Program,[string[]]$Arguments){
    $log=Join-Path $PSScriptRoot "issue258-native-r5-$Name.log"
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
    Run-Step 'source-before' $issuePython @((Join-Path $PSScriptRoot 'capture-issue258-source-r1.py'),'--phase','before-native-r5')
    Run-Step 'build' 'cargo' @('build','--locked','-p','crony-server','-p','crony-runner','--bins')
    foreach($name in @('crony-server.exe','crony-runner.exe')){
        $binary=Join-Path $issueWorktree "target\debug\$name"
        $record.binaries[$name]=@{sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant();length=(Get-Item -LiteralPath $binary).Length}
    }
    Save-Record
    Run-Step 'dry-run' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','DryRun','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'start' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Start','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'status' (Join-Path $issueWorktree 'tools\qa_factory_run_activity.ps1') @('-Phase','Status','-QaRoot',$issueQa,'-PostgresBin',$issuePostgres)
    Run-Step 'prepare' $issuePython @('tools/e2e_factory_run_activity.py','--qa-root',$issueQa,'--postgres-bin',$issuePostgres,'--phase','prepare')
    $record.status='accepting';Save-Record
    Run-Step 'browser' 'node' @((Join-Path $PSScriptRoot 'issue258-browser-r5.mjs'),'--qa-root',$issueQa,'--postgres-bin',$issuePostgres,'--source-receipt',$sourceBefore)
    $browserReportPath=Join-Path $issueQa 'evidence\issue258-browser.json'
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
            Run-Step 'source-after' $issuePython @((Join-Path $PSScriptRoot 'capture-issue258-source-r1.py'),'--phase','after-native-r5','--equals','before-native-r5')
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
Write-Output 'Native issue258 acceptance passed; only exact owned services stopped and all fixture data retained.'
