param([Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Label)
$ErrorActionPreference='Stop'
$repo='<reviewed-worktree>'
$out=Join-Path $PSScriptRoot "pr353-startup-review-r1-$Label"
if(Test-Path -LiteralPath $out){throw 'Preserve the previous startup review attempt.'}
if((& git -C $repo diff --name-only)){throw 'Stage the exact source and regression driver first.'}
[IO.Directory]::CreateDirectory($out)|Out-Null
$receipt=[ordered]@{
    pr=353;label=$Label;status='running';scope='synthetic owned Windows startup/restart regressions; no product service or provider inference'
    started_at=[DateTimeOffset]::UtcNow.ToString('o');source_head=(& git -C $repo rev-parse HEAD).Trim()
    source_tree=(& git -C $repo write-tree).Trim();target_main=(& git -C $repo rev-parse origin/main).Trim()
    source_files=@();node='<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe'
}
foreach($relative in @('tools/local_stack_start.ps1','tools/local_stack.psm1','tools/local_stack_lifecycle.test.ps1')){
    $receipt.source_files+=@{path=$relative;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $relative)).Hash.ToLowerInvariant()}
}
$receiptPath=Join-Path $out 'receipt.json'
$receipt|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $receiptPath -Encoding utf8
$mutex=[Threading.Mutex]::new($false,'Local\ECorpCompletionNodeFixtures')
$held=$false
$code=1
try {
    try {$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
    $log=Join-Path $out 'startup.log'
    & pwsh -NoLogo -NoProfile -NonInteractive -File (Join-Path $repo 'tools/local_stack_lifecycle.test.ps1') -Suite Startup -NodePath $receipt.node -RetainFixtures *> $log
    $code=$LASTEXITCODE
    $receipt.native_exit=$code
    $receipt.log_sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()
    $reports=@(Get-Content -LiteralPath $log|Where-Object {$_.StartsWith('ECORP_LOCAL_STACK_TEST_RESULT=')})
    if($reports.Count -ne 1){throw 'Expected one actual structured startup result.'}
    $receipt.result=$reports[0].Substring('ECORP_LOCAL_STACK_TEST_RESULT='.Length)|ConvertFrom-Json
    if(($receipt.source_tree -cne (& git -C $repo write-tree).Trim()) -or (& git -C $repo diff --name-only)){throw 'Source changed during startup regression execution.'}
    if($receipt.result.cleanup.remaining_processes -ne 0){throw 'Owned fixture cleanup is not verified.'}
    $receipt.status=if($code -eq 0 -and !@($receipt.result.cases|Where-Object {!$_.passed}).Count){'passed'}else{'failed'}
}catch{
    $receipt.status='failed';$receipt.failure=$_.Exception.Message;$code=1
}finally{
    if($held){$mutex.ReleaseMutex()};$mutex.Dispose()
    $receipt.finished_at=[DateTimeOffset]::UtcNow.ToString('o')
    $receipt|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $receiptPath -Encoding utf8
}
[pscustomobject]@{pr=353;label=$Label;status=$receipt.status;exit=$code;failed_cases=@($receipt.result.cases|Where-Object {!$_.passed}|Select-Object name,error);receipt=$receiptPath}|ConvertTo-Json -Depth 8
exit $code
