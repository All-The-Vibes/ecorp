$ErrorActionPreference='Stop'
$repo='C:\Users\shyamsridhar\code\ecorp-pr293-completion-20260922'
$output=Join-Path $PSScriptRoot 'pr293-full-native-r1'
if(Test-Path -LiteralPath $output){throw 'Preserve earlier attempt.'}
New-Item -ItemType Directory -Path $output|Out-Null
$target='C:\Users\shyamsridhar\code\ecorp-pr324-completion-20260922\target-validation'
$env:PATH='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64;'+$env:PATH
$env:CARGO_TARGET_DIR=$target
$env:CARGO_BUILD_JOBS='2'
$env:CRONY_NATIVE_QUALIFICATION='1'
Set-Location -LiteralPath $repo
if((& git diff --name-only)){throw 'Freeze and stage source before native build.'}
$record=[ordered]@{started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');head=(& git rev-parse HEAD).Trim();staged_tree=(& git write-tree).Trim();status='building';node=(& node --version);rustc=(& rustc --version);target=$target;feature='crony-server/native-qualification';binaries=@()}
$key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())))
$mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
$held=$false
try {
  try{$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
  & cargo clean --workspace --target-dir $target *> (Join-Path $output 'workspace-cache-refresh.log')
  if($LASTEXITCODE){throw 'Workspace cache refresh failed.'}
  & cargo build --locked -p crony-server -p crony-runner -p crony-cli --features crony-server/native-qualification --bins *> (Join-Path $output 'build.log')
  $record.build_exit=$LASTEXITCODE
  if($LASTEXITCODE){throw 'Native qualification build failed.'}
  if((& git write-tree).Trim() -cne $record.staged_tree -or (& git diff --name-only)){throw 'Source changed during build.'}
  $destination=Join-Path $repo 'target-native-qualification\debug'
  if(Test-Path -LiteralPath $destination){throw 'Preserve prior native binaries.'}
  New-Item -ItemType Directory -Path $destination|Out-Null
  foreach($name in @('crony-server','crony-base-worker','crony-runner','crony-cli','crony-native-fixture')){
    $source=Join-Path $target "debug\$name.exe"
    $copy=Join-Path $destination "$name.exe"
    Copy-Item -LiteralPath $source -Destination $copy
    $record.binaries+=@{name=$name;sha256=(Get-FileHash -LiteralPath $copy).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $copy).Length}
  }
  $record.status='passed'
}catch{$record.status='failed';throw}finally{
  $record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
  $record|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $output 'build-receipt.json') -Encoding utf8
  if($held){$mutex.ReleaseMutex()};$mutex.Dispose()
}
$record|ConvertTo-Json -Depth 12
