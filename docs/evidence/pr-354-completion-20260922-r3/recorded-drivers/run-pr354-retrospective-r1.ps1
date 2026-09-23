#requires -Version 7.4
$ErrorActionPreference='Stop'
$root=Join-Path $PSScriptRoot 'pr354-retrospective-r1'
$manifestPath=Join-Path $root 'source-manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
$receiptPath=Join-Path $root 'receipt.json'
if(Test-Path -LiteralPath $receiptPath){throw 'Preserve previous receipts.'}
$target='C:\Users\shyamsridhar\code\ecorp-pr362-completion-20260922\target-validation'
foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)){
  if($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
}
$env:CARGO_TARGET_DIR=$target
$env:CARGO_BUILD_JOBS='2'
$env:RUST_TEST_THREADS='1'
$receipt=[ordered]@{status='running';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');scope=$manifest.scope;driver_sha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant();source_manifest_sha256=(Get-FileHash -LiteralPath $manifestPath).Hash.ToLowerInvariant();commands=@()}
function Save-Receipt{$receipt|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $receiptPath -Encoding utf8}
$key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())))
$mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
$held=$false
Save-Receipt
try{
  try{$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
  foreach($case in @(@{name='baseline';repo=$manifest.baseline_repository;tree=$manifest.baseline_tested_tree;red=$true},@{name='candidate';repo=$manifest.candidate_repository;tree=$manifest.candidate_tested_tree;red=$false})){
    if((& git -C $case.repo write-tree).Trim() -cne $case.tree -or (& git -C $case.repo diff --name-only)){throw 'Prepared source changed.'}
    Push-Location -LiteralPath $case.repo
    try{
      $refresh=Join-Path $root "$($case.name)-workspace-cache-refresh.log"
      & cargo clean --workspace --target-dir $target *> $refresh
      if($LASTEXITCODE){throw 'Workspace refresh failed.'}
      $log=Join-Path $root "$($case.name)-send-guard.log"
      $arguments=@('test','--locked','-p','crony-server','tests::issue256_start_dispatch_rechecks_capabilities_after_selection','--','--exact','--nocapture','--test-threads=1')
      & cargo @arguments *> $log
      $code=$LASTEXITCODE
      $text=Get-Content -LiteralPath $log -Raw
      $observed=if($case.red){$code -ne 0 -and $text -match 'test result: FAILED\. 0 passed; 1 failed;' -and $text -match 'stale adapter capability reached enqueue'}else{$code -eq 0 -and $text -match 'test result: ok\. 1 passed; 0 failed; 0 ignored;'}
      $receipt.commands+=@{name=$case.name;repository=$case.repo;tested_tree=$case.tree;program='cargo';arguments=$arguments;exit_code=$code;expected=$(if($case.red){'behavioral-red'}else{'behavioral-green'});expected_behavior_observed=[bool]$observed;log=$log;sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant();workspace_refresh=@{log=$refresh;sha256=(Get-FileHash -LiteralPath $refresh).Hash.ToLowerInvariant()}}
      Save-Receipt
      Write-Output "$($case.name) exit=$code expected_behavior=$observed"
      if(!$observed){throw 'Focused test did not establish the expected behavior. Preserve actual result.'}
      if((& git write-tree).Trim() -cne $case.tree -or (& git diff --name-only)){throw 'Source changed during comparison.'}
    }finally{Pop-Location}
  }
  $receipt.source_unchanged=$true;$receipt.status='passed'
}catch{$receipt.status='failed';$receipt.error=$_.Exception.Message}
finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose();$receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Receipt}
Write-Output "retrospective status=$($receipt.status)"
if($receipt.status -ne 'passed'){exit 1}
