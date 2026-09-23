param([Parameter(Mandatory)][ValidatePattern('^r[0-9]+$')][string]$Revision)
$ErrorActionPreference='Stop'
$product='<reviewed-worktree>'
$qa="<local-user>\code\qa\pr283-state-audit-20260923-$Revision"
$pg='<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$target='<local-user>\code\ecorp-pr324-completion-20260922\target-validation'
$prefix="pr283-native-20260923-$Revision"
$receiptPath=Join-Path $PSScriptRoot "$prefix-lifecycle.json"
$binaries=Join-Path $PSScriptRoot "$prefix-binaries"
$validation=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pr283-validation-r2/validation.json') -Raw | ConvertFrom-Json
$tree=(& git -C $product write-tree).Trim()
if($validation.status -ne 'passed' -or $validation.staged_tree -ne $tree -or (& git -C $product diff --name-only)){throw 'Source must match passing validation.'}
foreach($existing in @($qa,$binaries,$receiptPath)){if(Test-Path -LiteralPath $existing){throw 'Preserve all previous fixtures and attempts.'}}
foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)){
  if($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
}
$env:PATH='<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64;'+$pg+';'+$env:PATH
$env:CARGO_TARGET_DIR=$target
$env:CARGO_BUILD_JOBS='2'
$env:RUST_TEST_THREADS='1'
$receipt=[ordered]@{pr=283;tested_staged_tree=$tree;source_head=(& git -C $product rev-parse HEAD).Trim();qa_root=$qa;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');status='running';cleanup='pending';checks=@();binaries=@()}
function Save-Receipt {$receipt | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $receiptPath -Encoding utf8}
function Check([string]$Name,[string]$Log,[int]$Code){
  $receipt.checks+=@{name=$Name;exit_code=$Code;log=$Log;sha256=(Get-FileHash -LiteralPath $Log).Hash.ToLowerInvariant()}
  Save-Receipt
  Write-Output "$Name exit=$Code"
  if($Code){throw "$Name failed; preserve all evidence."}
}
$supervisor=Join-Path $PSScriptRoot 'qa-pr283-stack-20260923-r1.ps1'
$key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())))
Save-Receipt
try{
  Set-Location -LiteralPath $product
  $mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
  $held=$false
  try{
    try{$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
    $log=Join-Path $PSScriptRoot "$prefix-workspace-refresh.log"
    & cargo clean --workspace --target-dir $target *> $log
    Check 'workspace-cache-refresh' $log $LASTEXITCODE
    $log=Join-Path $PSScriptRoot "$prefix-build.log"
    & cargo build --locked -p crony-server -p crony-runner -p crony-cli --bins *> $log
    Check 'matching-source-native-build' $log $LASTEXITCODE
    New-Item -ItemType Directory -Path $binaries | Out-Null
    foreach($name in @('crony-server.exe','crony-runner.exe','crony-cli.exe')){
      $destination=Join-Path $binaries $name
      Copy-Item -LiteralPath (Join-Path $target "debug/$name") -Destination $destination
      $receipt.binaries+=@{file=$destination;sha256=(Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant()}
    }
  }finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
  Save-Receipt
  & $supervisor -Phase Start -QaRoot $qa -PostgresBin $pg -BinaryDirectory $binaries *> (Join-Path $PSScriptRoot "$prefix-stack-start.log")
  & $supervisor -Phase Status -QaRoot $qa -PostgresBin $pg -BinaryDirectory $binaries *> (Join-Path $PSScriptRoot "$prefix-stack-status.log")
  $env:ECORP_COMPLETION_QA_ROOT=$qa
  $env:ECORP_COMPLETION_PRODUCT=$product
  $env:ECORP_COMPLETION_BINARIES=$binaries
  $env:ECORP_COMPLETION_TESTED_TREE=$tree
  $env:CRONY_PLAYWRIGHT_MODULE='<local-user>\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
  $log=Join-Path $PSScriptRoot "$prefix-browser.log"
  & node (Join-Path $PSScriptRoot 'pr283-browser-state-audit-20260923-r1.mjs') *> $log
  Check 'browser-server-runner-audit-acceptance' $log $LASTEXITCODE
  $receipt.source_unchanged=((& git -C $product write-tree).Trim() -eq $tree -and -not (& git -C $product diff --name-only))
  if(!$receipt.source_unchanged){throw 'Reviewed source changed during acceptance.'}
  $receipt.status='passed'
}catch{
  $receipt.status='failed'
  $receipt.failure=[regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')
}finally{
  if(Test-Path -LiteralPath (Join-Path $qa 'ownership.json')){
    try{
      & $supervisor -Phase Stop -QaRoot $qa -PostgresBin $pg -BinaryDirectory $binaries *> (Join-Path $PSScriptRoot "$prefix-stack-stop.log")
      $receipt.cleanup='Only recorded owned processes stopped; all fixture data and evidence retained.'
    }catch{$receipt.cleanup='Failed; inspect retained ownership records.';$receipt.status='failed'}
  }
  $receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
  Save-Receipt
}
$receipt | ConvertTo-Json -Depth 12
if($receipt.status -ne 'passed'){exit 1}
