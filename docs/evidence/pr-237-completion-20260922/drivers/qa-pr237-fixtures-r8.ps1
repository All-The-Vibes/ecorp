$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$product=$env:ECORP_COMPLETION_PRODUCT
$qa=$env:ECORP_COMPLETION_QA_ROOT
if($env:ECORP_COMPLETION_PR -ne '237' -or
   $product -ne '<reviewed-worktree>' -or
   (Split-Path -Leaf $qa) -notmatch '^pr265-run-activity-pr237-20260922-r[0-9]+$'){throw 'Unexpected owned fixture scope.'}
$revision=(Split-Path -Leaf $qa).Split('-')[-1]
$scope="<local-user>\code\qa\p237-$revision"
$pg='<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
if(Test-Path -LiteralPath $scope){throw 'Preserve all prior native scenario attempts.'}
New-Item -ItemType Directory -Path $scope|Out-Null
$report=[ordered]@{schema_version=1;pr=237;status='running';new_current_source_runs=$true;
    source_head=(& git -C $product rev-parse HEAD).Trim();tested_staged_tree=(& git -C $product write-tree).Trim();
    started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');scope=$scope;commands=@();
    provider='Native Rust services and deterministic protocol fixtures; no real provider accounts';
    historical_evidence='Original receipts and report graphics remain unchanged. These are new runs, not reconstructed original evidence.'}
$destination=Join-Path $qa 'evidence/pr237-native-scenarios.json'
function Save-Report{$report|ConvertTo-Json -Depth 30|Set-Content -LiteralPath $destination -Encoding utf8}
function Run-Check([string]$Name,[string]$Program,[string[]]$Arguments){
    $log=Join-Path $scope "$Name.log"
    $started=[DateTimeOffset]::UtcNow.ToString('o')
    $configuration=Join-Path $scope "$Name.command.json"
    @{repository=$product;name=$Name;program=$Program;arguments=$Arguments;log=$log;
      outputDirectory=$scope;stagedTree=$report.tested_staged_tree} |
      ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configuration -Encoding utf8
    & node (Join-Path $PSScriptRoot 'live-command-capture-r2.mjs') $configuration *> (Join-Path $scope "$Name.capture-driver.log")
    $code=$LASTEXITCODE
    $executionPath=Join-Path $scope "$Name.execution.json"
    $execution=Get-Content -LiteralPath $executionPath -Raw | ConvertFrom-Json
    if($execution.exit_code -ne $code -or !$execution.source_unchanged -or
       $execution.tested_staged_tree -ne $report.tested_staged_tree){throw 'Live command receipt does not match execution.'}
    $report.commands+=[ordered]@{name=$Name;program=$Program;arguments=$Arguments;started_at_utc=$started;
       finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');exit_code=$code;log=$log;
       sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant();
       execution_receipt=$executionPath;execution_sha256=(Get-FileHash -LiteralPath $executionPath).Hash.ToLowerInvariant();
       captures=$execution.captures}
    Save-Report
    Write-Output "$Name exit=$code"
    if($code){throw "$Name failed; preserve its native report and process cleanup records."}
}
Save-Report
try{
    $external=Join-Path $scope 'ecorp-external-adapters-pr237'
    Run-Check 'windows-external-adapters' (Get-Command pwsh.exe).Source @('-NoProfile','-File',
       (Join-Path $product 'tools/ci_external_adapters_windows.ps1'),'-FixtureRoot',$external,
       '-PgBin',$pg,'-ServerPort','28437','-PostgresPort','55437','-Execute')
    $env:ECORP_ISSUE50_PG_BIN=$pg
    Remove-Item Env:ECORP_ISSUE50_REFERENCE_SNAPSHOT_URL -ErrorAction SilentlyContinue
    foreach($scenario in @('bounded-recovery','revised-budget-hard-stop','native-missing-checkpoint')){
        $scenarioFolder = @{ 'bounded-recovery'='b'; 'revised-budget-hard-stop'='o'; 'native-missing-checkpoint'='m' }[$scenario]
        $parent=Join-Path $scope "$scenarioFolder/qa"
        New-Item -ItemType Directory -Path $parent|Out-Null
        $env:ECORP_ISSUE50_QA_ROOT=Join-Path $parent 'issue-50-factory-recovery'
        $arguments=@((Join-Path $product 'tools/e2e_factory_budget_recovery.mjs'),'--execute')
        if($scenario -eq 'revised-budget-hard-stop'){$arguments+='--overrun'}
        if($scenario -eq 'native-missing-checkpoint'){$arguments+='--missing-checkpoint'}
        Run-Check $scenario (Get-Command node.exe).Source $arguments
        $nativeReports=@(Get-ChildItem -LiteralPath (Join-Path $env:ECORP_ISSUE50_QA_ROOT 'attempts') -Directory |
          ForEach-Object {Join-Path $_.FullName 'report.json'})
        if($nativeReports.Count -ne 1){throw 'Expected exactly one new, unreplayed native attempt.'}
        $native=Get-Content -LiteralPath $nativeReports[0] -Raw|ConvertFrom-Json
        if($native.scenario -ne $scenario -or !$native.provenance.consistent -or $native.ports_after.Count -or
           @($native.cleanup|Where-Object status -eq 'unverified_preserved').Count){throw 'Native scenario provenance or cleanup is incomplete.'}
        $report.commands[-1].native_report=$nativeReports[0]
        $report.commands[-1].native_report_sha256=(Get-FileHash -LiteralPath $nativeReports[0]).Hash.ToLowerInvariant()
        Save-Report
    }
    if((& git -C $product write-tree).Trim() -ne $report.tested_staged_tree -or (& git -C $product diff --name-only)){
        throw 'Source changed during native scenario acceptance.'
    }
    $report.status='passed'
}catch{
    $report.status='failed';$report.failure=$_.Exception.Message;Write-Output $report.failure
}finally{
    $report.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Report
}
if($report.status -ne 'passed'){exit 1}
