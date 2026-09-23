$ErrorActionPreference='Stop'
$repo='C:\Users\shyamsridhar\code\ecorp-pr293-completion-20260922'
$target='C:\Users\shyamsridhar\code\ecorp-pr324-completion-20260922\target-validation'
$out=Join-Path $PSScriptRoot 'pr293-extra-gates-r1'
if(Test-Path -LiteralPath $out){throw 'Preserve prior extra-gate results.'}
New-Item -ItemType Directory -Path $out|Out-Null
Set-Location -LiteralPath $repo
$env:PATH='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64;'+$env:PATH
$env:CARGO_TARGET_DIR=$target
$env:CARGO_BUILD_JOBS='2'
$env:RUST_TEST_THREADS='1'
$tree=(& git write-tree).Trim()
if($LASTEXITCODE -or (& git diff --name-only)){throw 'Extra gates require unchanged staged source.'}
$record=[ordered]@{pr=293;source_head=(& git rev-parse HEAD).Trim();tested_staged_tree=$tree;scope='Two additional branch-specific contributor commands; Ethereum test uses in-memory revm, not a live chain.';status='running';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');checks=@()}
function Save-Receipt{$record|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8}
function Gate([string]$Name,[string]$Program,[string[]]$Arguments){
    $log=Join-Path $out "$Name.log"
    & $Program @Arguments *> $log
    $code=$LASTEXITCODE
    $record.checks+=@{name=$Name;command=(@($Program)+$Arguments)-join ' ';exit_code=$code;log=$log;sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()}
    Save-Receipt
    Write-Output "$Name exit=$code"
}
Save-Receipt
Gate 'state-audit-compatibility' 'node' @('tools/check_state_audit_compatibility.mjs')
$key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())))
$mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
$held=$false
try {
    try{$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
    if((& git write-tree).Trim() -cne $tree -or (& git diff --name-only)){throw 'Source changed while awaiting Cargo.'}
    Gate 'ethereum-local-chain' 'cargo' @('test','--locked','-p','crony-audit','--test','ethereum_local_chain')
} finally {if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
$record.source_unchanged=((& git write-tree).Trim() -ceq $tree -and -not (& git diff --name-only))
$record.status=if($record.source_unchanged -and !@($record.checks|Where-Object exit_code -ne 0).Count){'passed'}else{'failed'}
$record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
Save-Receipt
if($record.status -ne 'passed'){exit 1}
