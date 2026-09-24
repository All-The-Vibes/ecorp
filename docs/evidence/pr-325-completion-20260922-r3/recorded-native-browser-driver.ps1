$ErrorActionPreference = 'Stop'
$product = '<reviewed-worktree>'
$fixture = '<local-user>\code\qa\pr325-browser-fixture-20260922-r5'
$output = Join-Path $PSScriptRoot 'pr325-native-browser-r5'
$receiptPath = Join-Path $PSScriptRoot 'pr325-browser-receipt-r5.json'
$policy = Join-Path $PSScriptRoot 'pr325-browser-policy.json'
if ((Test-Path -LiteralPath $fixture) -or (Test-Path -LiteralPath $output) -or (Test-Path -LiteralPath $receiptPath)) { throw 'Preserve existing fixtures and receipts.' }
$tree = (& git -C $product write-tree).Trim()
if ($LASTEXITCODE -or (& git -C $product diff --name-only)) { throw 'A staged reviewed source tree is required.' }
$selected = Get-Content -LiteralPath $policy -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $selected.executable).Hash.ToLowerInvariant() -ne $selected.sha256) { throw 'Browser pin changed; inspect before running.' }
& git -C $product worktree add --detach $fixture origin/main
if ($LASTEXITCODE) { throw 'Fresh owned fixture worktree could not be created.' }
foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
  if ($key -match '^(CRONY_|ECORP_|GIT_TRACE|GIT_CONFIG)' -or $key -eq 'NODE_OPTIONS') { [Environment]::SetEnvironmentVariable($key,$null,'Process') }
}
$env:CRONY_BROWSER_TEST_WORKTREE = $fixture
$env:CRONY_BROWSER_TEST_OUTPUT = $output
$env:CRONY_PLAYWRIGHT_MODULE = '<local-user>\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
$env:CRONY_VERIFIER_BROWSER_POLICY = $policy
$receipt = [ordered]@{started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');tested_staged_tree=$tree;source_head=(& git -C $product rev-parse HEAD).Trim();fixture=$fixture;output=$output;policy_sha256=(Get-FileHash -LiteralPath $policy).Hash.ToLowerInvariant();browser_sha256=$selected.sha256;scope='Actual module and CLI verifier browser acceptance; no application-server or provider acceptance';status='running'}
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
Set-Location -LiteralPath $product
& node tools/e2e_verifier_browser.mjs *> (Join-Path $PSScriptRoot 'pr325-browser-r5.log')
$receipt.exit_code = $LASTEXITCODE
$receipt.source_tree_after = (& git -C $product write-tree).Trim()
$receipt.unstaged_source = @(& git -C $product diff --name-only)
$receipt.fixture_status = @(& git -C $fixture status --porcelain=v1)
$receipt.finished_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
$receipt.status = if ($receipt.exit_code -eq 0 -and $receipt.source_tree_after -eq $tree -and -not $receipt.unstaged_source.Count -and -not $receipt.fixture_status.Count) { 'passed' } else { 'failed' }
$receipt | ConvertTo-Json -Depth 8 | Tee-Object -FilePath $receiptPath
if ($receipt.status -ne 'passed') { exit 1 }
