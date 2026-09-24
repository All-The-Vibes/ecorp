$ErrorActionPreference='Stop'
$repo='C:\Users\shyamsridhar\code\ecorp-pr305-completion-20260922'
$target='C:\Users\shyamsridhar\code\ecorp-pr324-completion-20260922\target-validation'
$build=Join-Path $PSScriptRoot 'pr305-native-r2-build'
$output=Join-Path $PSScriptRoot 'pr305-native-r2'
if((Test-Path -LiteralPath $build) -or (Test-Path -LiteralPath $output)){throw 'Preserve prior attempts.'}
$validation=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pr305-validation-r6/validation.json') -Raw|ConvertFrom-Json
$tree=(& git -C $repo write-tree).Trim()
if($validation.status -ne 'passed' -or $validation.staged_tree -cne $tree -or (& git -C $repo diff --name-only)){throw 'Source differs from passing validation.'}
New-Item -ItemType Directory -Path $build|Out-Null
foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
  if($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS')){Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue}
}
$env:PATH='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64;'+$env:PATH
$env:CARGO_TARGET_DIR=$target
$env:CARGO_BUILD_JOBS='2'
$env:RUST_TEST_THREADS='1'
Set-Location -LiteralPath $repo
$key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())))
$mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
$held=$false
try {
  try{$held=$mutex.WaitOne()} catch [Threading.AbandonedMutexException] {$held=$true}
  & cargo clean --workspace --target-dir $target *> (Join-Path $build 'workspace-cache-refresh.log')
  if($LASTEXITCODE){throw 'Cache refresh failed.'}
  & cargo test --locked -p crony-runner -p crony-server --no-run --message-format=json 1> (Join-Path $build 'cargo-test.jsonl') 2> (Join-Path $build 'cargo-test.log')
  if($LASTEXITCODE){throw 'Native fixture build failed.'}
  & cargo build --locked -p crony-runner -p crony-server --message-format=json 1> (Join-Path $build 'cargo-build.jsonl') 2> (Join-Path $build 'cargo-build.log')
  if($LASTEXITCODE){throw 'Production binary build failed.'}
  $native=Join-Path $repo 'target/debug'
  New-Item -ItemType Directory -Path $native -Force|Out-Null
  foreach($file in @('crony-server.exe','crony-runner.exe')) {
    $destination=Join-Path $native $file
    if(Test-Path -LiteralPath $destination){throw 'Preserve existing candidate binaries before copying.'}
    Copy-Item -LiteralPath (Join-Path $target "debug/$file") -Destination $destination
  }
  if((& git write-tree).Trim() -cne $tree -or (& git diff --name-only)){throw 'Source changed during native build.'}
  & node (Join-Path $PSScriptRoot 'prepare-pr305-native-manifest-r1.mjs') *> (Join-Path $build 'manifest.log')
  if($LASTEXITCODE){throw 'Native manifest admission failed.'}
  & node tools/research_handoff_native.mjs (Join-Path $PSScriptRoot 'pr305-native-r2-manifest.json') $output *> (Join-Path $PSScriptRoot 'pr305-native-r2-driver.log')
  $code=$LASTEXITCODE
  Write-Output "Native fixture command exit=$code; this tool deliberately exits 1 even for complete offline coverage. Inspect its recorded coverage and failures."
} finally {
  if($held){$mutex.ReleaseMutex()};$mutex.Dispose()
}
