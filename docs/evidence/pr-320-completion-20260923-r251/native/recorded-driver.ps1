param([Parameter(Mandatory)][ValidatePattern('^r[0-9]+$')][string]$Revision)
$ErrorActionPreference = 'Stop'
$product = '<reviewed-worktree>'
$qa = "<local-user>\code\qa\delegated-keycloak-pr320-20260923-$Revision"
$target = '<local-user>\code\ecorp-pr324-completion-20260922\target-validation'
$pg = '<local-user>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$nodeDirectory = '<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64'
$playwright = '<local-user>\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
$java = Join-Path $PSScriptRoot 'provider-runtime/jdk/jdk-21.0.12.1+1/bin/java.exe'
$keycloak = Join-Path $PSScriptRoot 'provider-runtime/keycloak/keycloak-26.7.4'
$prefix = "pr320-native-integration-$Revision"
$receiptPath = Join-Path $PSScriptRoot "$prefix.json"
$binaries = Join-Path $PSScriptRoot "$prefix-binaries"
if ((Test-Path -LiteralPath $qa) -or (Test-Path -LiteralPath $receiptPath) -or (Test-Path -LiteralPath $binaries)) {
    throw 'Preserve previous fixture, binaries and evidence.'
}
if ((& git -C $product diff --name-only) -or (& git -C $product diff --name-only --diff-filter=U)) {
    throw 'Stage source before testing.'
}
$tree = (& git -C $product write-tree).Trim()
if ($LASTEXITCODE) { throw 'Cannot bind staged source.' }
foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    if ($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or
        $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS','JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS')) {
        Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
    }
}
$env:PATH = $nodeDirectory + ';' + $pg + ';' + $env:PATH
$env:CARGO_TARGET_DIR = $target
$env:CARGO_BUILD_JOBS = '2'
New-Item -ItemType Directory -Path $binaries | Out-Null
$receipt = [ordered]@{
    pr=320;purpose='Owned native Keycloak browser/server/runner delegated acceptance'
    source_head=(& git -C $product rev-parse HEAD).Trim();tested_staged_tree=$tree
    qa_root=$qa;target=$target;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    status='running';checks=@();cleanup='pending'
    live_azure='NOT_EXECUTED';scope='Synthetic Keycloak 26.7.4; development principals; not production OIDC or OS isolation.'
}
function Save-Receipt { $receipt | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath $receiptPath -Encoding utf8 }
function Check([string]$Name,[string]$Log,[int]$Code) {
    $receipt.checks += @{name=$Name;exit_code=$Code;log=$Log;sha256=(Get-FileHash -LiteralPath $Log).Hash.ToLowerInvariant()}
    Save-Receipt
    Write-Output "$Name exit=$Code"
    if ($Code) { throw "$Name failed; exact fixture and logs retained." }
}
Save-Receipt
$mutex = $null
$held = $false
try {
    $key = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($target).ToLowerInvariant())))
    $mutex = [Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
    try { $held=$mutex.WaitOne() } catch [Threading.AbandonedMutexException] { $held=$true }
    Set-Location -LiteralPath $product
    $log = Join-Path $PSScriptRoot "$prefix-workspace-cache-refresh.log"
    & cargo clean --workspace --target-dir $target *> $log
    Check 'workspace-cache-refresh' $log $LASTEXITCODE
    foreach ($binary in @('crony-server','crony-runner')) {
        $log = Join-Path $PSScriptRoot "$prefix-$binary-build.log"
        & cargo build --locked -p $binary --bin $binary *> $log
        Check "$binary-build" $log $LASTEXITCODE
        Copy-Item -LiteralPath (Join-Path $target "debug/$binary.exe") -Destination (Join-Path $binaries "$binary.exe")
    }
    $receipt.binaries = @('crony-server','crony-runner') | ForEach-Object {
        @{name=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $binaries "$_.exe")).Hash.ToLowerInvariant()}
    }
    $mutex.ReleaseMutex()
    $held = $false
    Save-Receipt
    $log = Join-Path $PSScriptRoot "$prefix-start.log"
    & (Join-Path $product 'tools/qa_delegated.ps1') -Phase Start -QaRoot $qa -PostgresBin $pg -BinaryDirectory $binaries -JavaPath $java -KeycloakDirectory $keycloak -PlaywrightDirectory $playwright -NodePath (Join-Path $nodeDirectory 'node.exe') -FirstPort 59100 *> $log
    Check 'owned-native-stack-start-and-ownership-proof' $log $LASTEXITCODE
    $env:ECORP_SYNTHETIC_OBO_TEST = '1'
    $env:ECORP_DELEGATED_QA_ROOT = $qa
    $log = Join-Path $PSScriptRoot "$prefix-browser-driver.log"
    & (Join-Path $nodeDirectory 'node.exe') --test tools/e2e_delegated.mjs *> $log
    Check 'owned-browser-server-runner-delegated-acceptance' $log $LASTEXITCODE
    $result = Get-Content -LiteralPath (Join-Path $qa 'evidence/synthetic-integration.json') -Raw | ConvertFrom-Json
    if ($result.outcome -ne 'PASSED' -or @($result.checks).Count -lt 13) { throw 'Incomplete integrated acceptance.' }
    if ((& git -C $product write-tree).Trim() -ne $tree -or (& git -C $product diff --name-only)) {
        throw 'Source changed during integrated acceptance.'
    }
    $receipt.source_unchanged = $true
    $receipt.acceptance = $result
    $receipt.status = 'passed'
} catch {
    $receipt.status = 'failed'
    $receipt.failure = [regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    if ($null -ne $mutex) { $mutex.Dispose() }
    Remove-Item -LiteralPath Env:ECORP_SYNTHETIC_OBO_TEST,Env:ECORP_DELEGATED_QA_ROOT -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath (Join-Path $qa 'ownership.json')) {
        $log = Join-Path $PSScriptRoot "$prefix-stop.log"
        & (Join-Path $product 'tools/qa_delegated.ps1') -Phase Stop -QaRoot $qa *> $log
        $receipt.stop_exit_code = $LASTEXITCODE
        if ($LASTEXITCODE) {
            $receipt.status = 'failed'
            $receipt.cleanup = 'Exact ownership could not prove all cleanup; retained records and processes.'
        } else {
            $receipt.cleanup = 'Only exact owned fixture processes stopped; private data, credentials, source, worktrees, binaries and evidence retained.'
        }
    } else {
        $receipt.cleanup = 'No owned stack was created; prior evidence retained.'
    }
    $receipt.finished_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    Save-Receipt
}
$receipt | ConvertTo-Json -Depth 12
if ($receipt.status -ne 'passed') { exit 1 }
