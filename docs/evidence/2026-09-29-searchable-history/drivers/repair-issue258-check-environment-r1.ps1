#requires -Version 7.5
$ErrorActionPreference = 'Stop'
$issueWorktree = '<USERPROFILE>\.codex\worktrees\issue258-history\ecorp'
$issuePython = '<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$issueNodeDir = '<USERPROFILE>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64'
$receiptPath = Join-Path $PSScriptRoot 'issue258-check-environment-repair-r1.json'
$installLog = Join-Path $PSScriptRoot 'issue258-check-environment-repair-r1-install.log'
$focusedLog = Join-Path $PSScriptRoot 'issue258-check-environment-repair-r1-focused.log'
foreach ($path in @($receiptPath, $installLog, $focusedLog)) {
    if (Test-Path -LiteralPath $path) { throw 'Preserve the prior repair attempt.' }
}
$failedPath = Join-Path $PSScriptRoot 'issue258-check-r1.json'
$failed = Get-Content -LiteralPath $failedPath -Raw | ConvertFrom-Json
if ($failed.status -cne 'failed' -or $failed.exit_code -ne 1 -or $failed.source_changed -ne $false) { throw 'Unexpected original check result.' }
$canonical = Get-Content -LiteralPath $failed.canonical_report -Raw | ConvertFrom-Json
$nodeGate = @($canonical.checks | Where-Object { $_.name -ceq 'node-tests' })
if ($nodeGate.Count -ne 1 -or $nodeGate[0].counts.node.failed -ne 2) { throw 'Unexpected failed test count.' }
$failedLog = Get-Content -LiteralPath $failed.log -Raw
if ([regex]::Matches($failedLog, '(?m)^not ok ').Count -ne 2 -or [regex]::Matches($failedLog, "Cannot find package '@microsoft/teams.apps'").Count -ne 2) { throw 'Unexpected original failure diagnosis.' }
$record = [ordered]@{
    issue = 258; status = 'starting'; started_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    worktree = $issueWorktree; original_receipt = $failedPath
    original_receipt_sha256 = (Get-FileHash -LiteralPath $failedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    original_node_counts = $nodeGate[0].counts.node
    diagnosis = 'Both failed Node tests could not import the scenario-local locked @microsoft/teams.apps package. No implementation failure was established by these two import errors.'
    install = $null; focused = $null; physical_source_unchanged = $false
    note = 'Install the existing scenario lockfile with lifecycle scripts disabled and npm audit reporting retained. No source, lockfile, TLS, pnpm protection, hosted-check policy or test discovery change is authorized by this repair.'
}
function Save-Repair { $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $receiptPath -Encoding utf8 }
$priorIssuePath = $env:PATH
Push-Location -LiteralPath $issueWorktree
try {
    $env:PATH = "$issueNodeDir;$(Split-Path -Parent $issuePython);$priorIssuePath"
    Save-Repair
    & $issuePython -X utf8 (Join-Path $PSScriptRoot 'capture-issue258-source-r1.py') --phase after-check-r1-failed --equals before-check-r1
    if ($LASTEXITCODE -ne 0) { throw 'Failed-run source equality check did not pass.' }
    $record.lock_sha256_before = (Get-FileHash -LiteralPath (Join-Path $issueWorktree 'scenarios\repo-steward\package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    Push-Location -LiteralPath (Join-Path $issueWorktree 'scenarios\repo-steward')
    try {
        & (Join-Path $issueNodeDir 'npm.cmd') ci --ignore-scripts --no-fund --workspaces=false *> $installLog
        $installExit = $LASTEXITCODE
    } finally { Pop-Location }
    $record.install = @{ command = 'npm ci --ignore-scripts --no-fund --workspaces=false'; exit_code = $installExit; log = $installLog; log_sha256 = (Get-FileHash -LiteralPath $installLog -Algorithm SHA256).Hash.ToLowerInvariant() }
    Save-Repair
    if ($installExit -ne 0) { throw 'Locked scenario dependency installation failed.' }
    $record.lock_sha256_after = (Get-FileHash -LiteralPath (Join-Path $issueWorktree 'scenarios\repo-steward\package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($record.lock_sha256_after -cne $record.lock_sha256_before) { throw 'Scenario lockfile changed.' }
    & (Join-Path $issueNodeDir 'node.exe') --test --test-concurrency=1 --test-timeout=180000 --test-reporter=tap scenarios/repo-steward/teams-host.test.mjs *> $focusedLog
    $focusedExit = $LASTEXITCODE
    $focusedText = Get-Content -LiteralPath $focusedLog -Raw
    $counts = [ordered]@{}
    foreach ($name in @('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')) {
        $matches = [regex]::Matches($focusedText, "(?m)^# $name (\d+)\s*$")
        if ($matches.Count -ne 1) { throw "Expected one focused $name summary." }
        $counts[$name] = [int]$matches[0].Groups[1].Value
    }
    $record.focused = @{ command = 'node --test --test-concurrency=1 --test-timeout=180000 --test-reporter=tap scenarios/repo-steward/teams-host.test.mjs'; exit_code = $focusedExit; counts = $counts; log = $focusedLog; log_sha256 = (Get-FileHash -LiteralPath $focusedLog -Algorithm SHA256).Hash.ToLowerInvariant() }
    Save-Repair
    if ($focusedExit -ne 0 -or $counts.fail -ne 0 -or $counts.cancelled -ne 0 -or $counts.skipped -ne 0 -or $counts.todo -ne 0) { throw 'Focused scenario tests failed or were not fully exercised.' }
    & $issuePython -X utf8 (Join-Path $PSScriptRoot 'capture-issue258-source-r1.py') --phase after-check-environment-repair-r1 --equals before-check-r1
    if ($LASTEXITCODE -ne 0) { throw 'Post-repair physical source equality did not pass.' }
    $record.physical_source_unchanged = $true
    $record.status = 'passed'
    $record.completed_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    Save-Repair
    [ordered]@{ status = $record.status; install_exit = $installExit; focused = $counts; source_unchanged = $record.physical_source_unchanged; receipt = $receiptPath } | ConvertTo-Json -Depth 4
} catch {
    $record.status = 'failed'; $record.error = $_.Exception.Message
    $record.completed_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    Save-Repair
    throw
} finally {
    $env:PATH = $priorIssuePath
    Pop-Location
}
