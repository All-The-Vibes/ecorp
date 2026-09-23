$ErrorActionPreference = 'Stop'
$repo = '<reviewed-worktree>'
Set-Location -LiteralPath $repo
$log = Join-Path $PSScriptRoot 'pr237-focused-r1.log'
$output = Join-Path $PSScriptRoot 'pr237-focused-r1.json'
if ((Test-Path -LiteralPath $log) -or (Test-Path -LiteralPath $output)) { throw 'Preserve previous results.' }
$tree = (& git write-tree).Trim()
if ((& git diff --name-only)) { throw 'Stage final source before verification.' }
$env:PATH = '<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64;' + $env:PATH
$env:ECORP_OWNED_PROCESS_TEST = '1'
$args = @('--test', '--test-reporter=spec', '--test-concurrency=1',
    'tools/factory_budget_start.test.mjs', 'tools/factory_budget_git.test.mjs',
    'tools/factory_budget_process.test.mjs', 'tools/factory_budget_provenance.test.mjs',
    'tools/e2e_factory_budget_recovery.test.mjs', 'tools/owned_test_stack.test.mjs',
    'tools/local_stack_lifecycle.test.mjs')
$receipt = [ordered]@{status='running';staged_tree=$tree;head=(& git rev-parse HEAD).Trim();command=@('node')+$args;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');native_owned_process_tests=$true}
$receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $output -Encoding utf8
$mutex = [Threading.Mutex]::new($false, 'Local\ECorpCompletionNodeFixtures')
$held = $false
try {
    try { $held = $mutex.WaitOne() } catch [Threading.AbandonedMutexException] { $held = $true }
    & node @args *> $log
    $receipt.exit_code = $LASTEXITCODE
    $receipt.log_sha256 = (Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()
    $receipt.source_unchanged = ((& git write-tree).Trim() -eq $tree -and -not (& git diff --name-only))
    $receipt.status = if ($receipt.exit_code -eq 0 -and $receipt.source_unchanged) { 'passed' } else { 'failed' }
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
    $receipt.finished_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $output -Encoding utf8
}
$receipt | ConvertTo-Json -Depth 10
Get-Content -LiteralPath $log -Tail 10
if ($receipt.status -ne 'passed') { exit 1 }
