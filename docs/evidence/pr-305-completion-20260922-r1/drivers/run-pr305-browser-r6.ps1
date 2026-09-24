$ErrorActionPreference='Stop'
$product='C:\Users\shyamsridhar\code\ecorp-pr305-completion-20260922'
$target='C:\Users\shyamsridhar\code\ecorp-pr324-completion-20260922\target-validation'
$qa='C:\Users\shyamsridhar\code\qa\pr265-run-activity-pr305-20260922-browser-r6'
$pg='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$prefix='pr305-browser-r6'
$receiptPath=Join-Path $PSScriptRoot "$prefix-lifecycle.json"
$validation=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pr305-validation-r3/validation.json') -Raw|ConvertFrom-Json
$tree=(& git -C $product write-tree).Trim()
# This is a diagnostic browser iteration; final full gates are required before publishing.
if($validation.status -ne 'passed' -or @($validation.checks).Count -ne 9 -or @($validation.checks|Where-Object exit_code -ne 0).Count -or (& git -C $product diff --name-only)){throw 'Prior passing gates and staged current source are required.'}
$sourceDelta=@(& git -C $product diff --name-only $validation.staged_tree $tree)
if($LASTEXITCODE -or @($sourceDelta|Where-Object {$_ -cnotin @('tools/research_handoff_browser.mjs','tools/e2e_research_handoff.mjs')}).Count){throw 'Only the reviewed browser-driver correction may differ from the prior full validation.'}
if((Test-Path -LiteralPath $qa) -or (Test-Path -LiteralPath $receiptPath)){throw 'Preserve earlier fixture and evidence.'}
foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
  if($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
}
$env:PATH='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64;'+$pg+';'+$env:PATH
$env:CARGO_TARGET_DIR=$target
$env:CARGO_BUILD_JOBS='2'
$env:RUST_TEST_THREADS='1'
$receipt=[ordered]@{validation_scope='Diagnostic browser iteration; final complete gate receipt required before publication.';prior_gate_tree=$validation.staged_tree;source_delta=$sourceDelta;pr=305;tested_staged_tree=$tree;head=(& git -C $product rev-parse HEAD).Trim();started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');status='running';qa_root=$qa;checks=@();binaries=@()}
function Save-Receipt {$receipt|ConvertTo-Json -Depth 25|Set-Content -LiteralPath $receiptPath -Encoding utf8}
function Record-Check([string]$name,[string]$log,[int]$code) {
  $receipt.checks+=@{name=$name;log=$log;exit_code=$code;sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()};Save-Receipt
  Write-Output "$name exit=$code"
  if($code){throw "$name failed; preserve the fixture and recorded IDs."}
}
Save-Receipt
$supervisor=Join-Path $PSScriptRoot 'qa-pr305-stack-r1.ps1'
try {
  Set-Location -LiteralPath $product
  $key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())))
  $mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
  $held=$false
  try {
    try {$held=$mutex.WaitOne()} catch [Threading.AbandonedMutexException] {$held=$true}
    $log=Join-Path $PSScriptRoot "$prefix-build.log"
    & cargo build --locked -p crony-server -p crony-runner --bins *> $log
    Record-Check 'current-source-native-build' $log $LASTEXITCODE
    $prior=Join-Path $PSScriptRoot "$prefix-prior-binaries"
    if(Test-Path -LiteralPath $prior){throw 'Preserve prior binary backup.'}
    New-Item -ItemType Directory -Path $prior|Out-Null
    $preserved=@()
    foreach($name in @('crony-server.exe','crony-runner.exe')) {
      $destination=[IO.Path]::GetFullPath((Join-Path $product "target/debug/$name"))
      $expected=[IO.Path]::GetFullPath((Join-Path $product 'target/debug'))+[IO.Path]::DirectorySeparatorChar
      if(!$destination.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){throw 'Binary path escaped owned checkout.'}
      if(Test-Path -LiteralPath $destination) {
        $preserved+=@{file=$name;sha256=(Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant()}
        Move-Item -LiteralPath $destination -Destination (Join-Path $prior $name)
      }
      Copy-Item -LiteralPath (Join-Path $target "debug/$name") -Destination $destination
      $receipt.binaries+=@{file=$name;sha256=(Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant()}
    }
    $preserved|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $prior 'preservation.json') -Encoding utf8
  } finally {if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
  Save-Receipt
  & $supervisor -Phase Start -QaRoot $qa -PostgresBin $pg -ServerPort 59305 -WebPort 26305 -DatabasePort 25305 *> (Join-Path $PSScriptRoot "$prefix-stack-start.log")
  & $supervisor -Phase Status -QaRoot $qa -PostgresBin $pg *> (Join-Path $PSScriptRoot "$prefix-stack-status.log")
  $context=Join-Path $PSScriptRoot "$prefix-context.json"
  $log=Join-Path $PSScriptRoot "$prefix-context.log"
  & node (Join-Path $PSScriptRoot 'prepare-pr305-browser-context-r2.mjs') $product $qa $context *> $log
  Record-Check 'owned-static-app-admission' $log $LASTEXITCODE
  $env:CRONY_RESEARCH_HANDOFF_TEST='1'
  $env:CRONY_SERVER_HTTP='http://127.0.0.1:59305'
  $env:CRONY_RESEARCH_HANDOFF_OUTPUT=Join-Path $qa 'evidence/browser-consumption'
  $env:ECORP_ISSUE297_QA_CONTEXT=$context
  $env:CRONY_PLAYWRIGHT_MODULE='C:\Users\shyamsridhar\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
  $env:CRONY_BROWSER_CHANNEL='msedge'
  $log=Join-Path $PSScriptRoot "$prefix-browser.log"
  & node tools/e2e_research_handoff.mjs --case browser-consumption --require-owned-qa *> $log
  Record-Check 'actual-browser-native-handoff-consumption' $log $LASTEXITCODE
  if((& git write-tree).Trim() -cne $tree -or (& git diff --name-only)){throw 'Source changed during acceptance.'}
  $receipt.source_unchanged=$true
  $receipt.status='passed'
} catch {$receipt.status='failed';$receipt.failure=[regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')}
finally {
  if(Test-Path -LiteralPath (Join-Path $qa 'ownership.json')) {
    try {& $supervisor -Phase Stop -QaRoot $qa -PostgresBin $pg *> (Join-Path $PSScriptRoot "$prefix-stack-stop.log");$receipt.cleanup='Only owned processes stopped; all source, database, workspaces and evidence retained.'}
    catch {$receipt.status='failed';$receipt.cleanup='Stop failed; preserve exact ownership records.'}
  }
  $receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Receipt
}
$receipt|ConvertTo-Json -Depth 12
if($receipt.status -ne 'passed'){exit 1}
