$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$product=$env:ECORP_COMPLETION_PRODUCT
$qa=$env:ECORP_COMPLETION_QA_ROOT
if($env:ECORP_COMPLETION_PR -ne '358' -or
   $product -ne '<reviewed-worktree>' -or
   (Split-Path -Leaf $qa) -notmatch '^pr265-run-activity-pr358-20260922-r[0-9]+$'){
    throw 'Unexpected owned aggregate-budget fixture scope.'
}
Import-Module (Join-Path $product 'tools/local_stack.psm1') -Force -DisableNameChecking
$state=Read-LocalStackState -Path (Join-Path $qa 'ownership.json') -Workspace $qa
if(!$state.test_owned -or $state.plan.server -ne 'http://127.0.0.1:59018' -or
   !(Test-LocalOwnedProcess -Record $state.processes.server -Workspace $qa)){
    throw 'Aggregate acceptance requires its exact new owned server.'
}
$owner=[ordered]@{test_owned=$true;server=$state.plan.server;root=$qa;
    path=$state.processes.server.executable;pid=$state.processes.server.pid;
    started_at=$state.processes.server.started_utc}
$ownerPath=Join-Path $qa 'server-process.json'
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($owner|ConvertTo-Json -Depth 6)+[char]10)
$stream=[IO.File]::Open($ownerPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
$env:CRONY_SERVER_HTTP=$state.plan.server
$env:ECORP_AGGREGATE_FIXTURE_ROOT=$qa
& node (Join-Path $product 'tools/e2e_aggregate_budgets.mjs')
if($LASTEXITCODE){throw 'Native aggregate-budget acceptance failed; preserve all artifacts.'}
$result=Join-Path $qa 'native-aggregate-results.json'
$cases=@(Get-Content -LiteralPath $result -Raw|ConvertFrom-Json)
if($cases.Count -ne 3 -or @($cases|Where-Object {$_.late_artifacts_accepted -ne 0 -or $_.late_completions_accepted -ne 0}).Count){
    throw 'Aggregate completion results are incomplete.'
}
Copy-Item -LiteralPath $result -Destination (Join-Path $qa 'evidence/native-aggregate-results.json')
# Preserve the last scenario's database. Explicitly restore ample budgets for
# the separate verifier-policy flow, after confirming all test runs are terminal.
$snapshot=Invoke-RestMethod "$($state.plan.server)/api/corps/$($state.demo.corp_id)/snapshot?actor_id=$($state.demo.alice_actor_id)"
if(@($snapshot.snapshot.runs|Where-Object {$_.status -notin @('completed','failed','cancelled')}).Count){
    throw 'Active runs remain; preserve them and stop before the next scenario.'
}
$policy=@{actor_id=$state.demo.alice_actor_id;actor_tokens_per_24h=1000000;
    actor_cost_microusd_per_24h=1000000000;corp_tokens_per_24h=1000000;
    corp_cost_microusd_per_24h=1000000000;no_progress_event_limit=100;repeated_tool_limit=100}
Invoke-RestMethod "$($state.plan.server)/api/corps/$($state.demo.corp_id)/budget-policy" -Method Post -ContentType 'application/json' -Body ($policy|ConvertTo-Json)|Out-Null
[ordered]@{test_owned=$true;source_tree=(& git -C $product write-tree).Trim();
    aggregate_cases=3;late_artifacts_accepted=0;late_completions_accepted=0;
    result_sha256=(Get-FileHash -LiteralPath $result).Hash.ToLowerInvariant();
    server_owner_sha256=(Get-FileHash -LiteralPath $ownerPath).Hash.ToLowerInvariant();
    generic_policy_preparation='Preserved final aggregate database; raised explicit owned-fixture budget policy after all native runs terminated.';
    finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')}|
    ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $qa 'evidence/aggregate-summary.json') -Encoding utf8
Write-Output 'Three native aggregate-budget scopes passed; last scenario database and workspaces retained.'
