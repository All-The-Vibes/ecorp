param([Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Label)
$ErrorActionPreference='Stop'
$repo='<reviewed-worktree>'
$out=Join-Path $PSScriptRoot "pr319-source-$Label"
if(Test-Path -LiteralPath $out){throw 'Preserve the previous execution.'}
if(& git -C $repo diff --name-only){throw 'Stage reviewed inputs first.'}
[IO.Directory]::CreateDirectory($out)|Out-Null
$receipt=[ordered]@{label=$Label;status='running';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');repository=$repo;head=(& git -C $repo rev-parse HEAD).Trim();staged_tree=(& git -C $repo write-tree).Trim();inputs=@();scope='native Windows synthetic source attestation; no multiplayer runtime acceptance'}
foreach($relative in @('tools/qa_multiplayer_preflight.ps1','tools/qa_multiplayer_preflight.test.ps1')){
  $receipt.inputs+=@{path=$relative;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $relative)).Hash.ToLowerInvariant();index_blob=(& git -C $repo rev-parse ":$relative").Trim();raw_git_blob=(& git -C $repo hash-object --no-filters -- $relative).Trim()}
}
$receiptPath=Join-Path $out 'receipt.json'
$receipt|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receiptPath -Encoding utf8
$mutex=[Threading.Mutex]::new($false,'Local\ECorpCompletionNodeFixtures')
$held=$false
try{
  try{$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
  $log=Join-Path $out 'native.log'
  & pwsh -NoLogo -NoProfile -NonInteractive -File (Join-Path $repo 'tools/qa_multiplayer_preflight.test.ps1') *> $log
  $receipt.native_exit=$LASTEXITCODE
  $receipt.log_sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()
  $receipt.source_unchanged=((& git -C $repo write-tree).Trim() -ceq $receipt.staged_tree -and !(& git -C $repo diff --name-only))
  $receipt.status=if($receipt.native_exit -eq 0 -and $receipt.source_unchanged){'passed'}else{'failed'}
}finally{
  if($held){$mutex.ReleaseMutex()};$mutex.Dispose()
  $receipt.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
  $receipt|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receiptPath -Encoding utf8
}
$receipt|Select-Object label,status,staged_tree,native_exit,source_unchanged|ConvertTo-Json
exit $receipt.native_exit
