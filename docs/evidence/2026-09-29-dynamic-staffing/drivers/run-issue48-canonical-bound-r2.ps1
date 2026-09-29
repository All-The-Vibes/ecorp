#requires -Version 7.5
param(
    [Parameter(Mandatory)][ValidatePattern('^r[0-9]+$')][string]$Revision,
    [Parameter(Mandatory)][ValidatePattern('^[a-z]+-r[0-9]+$')][string]$SqlRevision
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repo = '<USERPROFILE>\.codex\worktrees\issue48-retirement\ecorp'
$expected = '878a1774774b0630c904cbaf4b05e1b346777817'
$prefix = "issue48-canonical-bound-$Revision"
$receiptPath = Join-Path $PSScriptRoot "$prefix.json"
$canonicalPath = Join-Path $PSScriptRoot "issue48-canonical-$Revision.json"
foreach ($path in @($receiptPath,$canonicalPath)) {
    if (Test-Path -LiteralPath $path) { throw 'Preserve existing validation evidence.' }
}
foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    if ($name -match '^(GIT_|CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS','CARGO_TARGET_DIR','RUSTUP_TOOLCHAIN')) {
        [Environment]::SetEnvironmentVariable($name,$null,'Process')
    }
}
$env:GIT_OPTIONAL_LOCKS = '0'
$env:GIT_TERMINAL_PROMPT = '0'
$env:CARGO_BUILD_JOBS = '2'
$env:CARGO_NET_OFFLINE = 'true'
$record = [ordered]@{
    issue=48;repository=$repo;head=$expected;status='preparing'
    started_at_utc=[DateTime]::UtcNow.ToString('o');source_unchanged=$false
    purpose='Complete canonical contributor checks and native acceptance binaries for safe crew retirement, bound to every physical source file.'
    limitations=@('Native Windows Rust tests use RUST_TEST_THREADS=1; parallel Windows issue 213 remains unresolved.', 'Local validation does not replace required hosted CI, CodeQL, security or quality gates.', 'Browser and native runtime acceptance are recorded separately.')
}
function Save { [IO.File]::WriteAllText($receiptPath,($record | ConvertTo-Json -Depth 18)+[Environment]::NewLine) }
function SourceBinding {
    if ((& git -C $repo rev-parse HEAD).Trim() -cne $expected -or (& git -C $repo branch --show-current).Trim() -cne 'codex/issue48-safe-crew-retirement') { throw 'Candidate branch or head changed.' }
    $paths = @(& git -C $repo ls-files --cached --others --exclude-standard | Sort-Object -Unique)
    if ($LASTEXITCODE) { throw 'Cannot read complete physical source inventory.' }
    $files = @($paths | ForEach-Object { [ordered]@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_)).Hash.ToLowerInvariant()} })
    $status = @(& git -C $repo status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE) { throw 'Cannot read worktree state.' }
    [ordered]@{head=$expected;parent_tree=(& git -C $repo rev-parse 'HEAD^{tree}').Trim();files=$files;status=$status}
}
$target = Join-Path $repo 'target'
$key = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())))
$mutex = [Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (!$locked) { throw 'An active validation owns this target; preserve it.' }
    $record.source_before = SourceBinding
    $record.source_file_count = $record.source_before.files.Count
    $sqlPath = Join-Path $PSScriptRoot "issue48-sql-$SqlRevision.json"
    $sql = Get-Content -LiteralPath $sqlPath -Raw | ConvertFrom-Json
    if ($sql.status -cne 'passed' -or !$sql.source_unchanged -or $sql.source_head -cne $expected) { throw 'Prior SQL regression receipt is not valid for this base.' }
    $prior = @{}
    foreach ($file in $sql.source_files) { $prior[$file.path] = $file.sha256 }
    $changed = @()
    foreach ($file in $record.source_before.files) {
        if ($prior[$file.path] -cne $file.sha256) {
            $changed += [ordered]@{path=$file.path;prior_sha256=$prior[$file.path];sha256=$file.sha256}
        }
    }
    $missing = @($prior.Keys | Where-Object { $_ -notin $record.source_before.files.path })
    $record.prior_sql_source_delta = $changed
    $record.prior_sql_removed_paths = $missing
    $record.prior_sql_code_matches = @($changed | Where-Object { $_.path -notlike 'docs/*' }).Count -eq 0 -and $missing.Count -eq 0
    if (!$record.prior_sql_code_matches) { throw 'Current implementation differs from the completed SQL regression source.' }
    $record.prior_sql_receipt = $sqlPath
    $record.prior_sql_receipt_sha256 = (Get-FileHash -LiteralPath $sqlPath).Hash.ToLowerInvariant()
    $record.canonical_helper_sha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'run-canonical-r4.ps1')).Hash.ToLowerInvariant()
    $record.target_mutex = "Local\ECorpCompletionCargo$key"
    $record.status = 'running-canonical'
    Save
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'run-canonical-r4.ps1') -RepositoryPath $repo -Issue 48 -Revision $Revision
    $record.canonical_exit_code = $LASTEXITCODE
    if (!(Test-Path -LiteralPath $canonicalPath)) { throw 'Canonical execution did not produce its receipt.' }
    $canonical = Get-Content -Raw -LiteralPath $canonicalPath | ConvertFrom-Json
    $record.canonical_receipt = $canonicalPath
    $record.canonical_receipt_sha256 = (Get-FileHash -LiteralPath $canonicalPath).Hash.ToLowerInvariant()
    if ($record.canonical_exit_code -or $canonical.status -cne 'passed') { throw 'Canonical validation failed; preserve observed results.' }
    $record.status = 'building-native-acceptance'
    Save
    $buildLog = Join-Path $PSScriptRoot "$prefix-native-build.log"
    if (Test-Path -LiteralPath $buildLog) { throw 'Preserve the existing build log.' }
    Push-Location -LiteralPath $repo
    try {
        & cargo build --locked --offline -p crony-cli -p crony-server -p crony-runner *> $buildLog
        $buildCode = $LASTEXITCODE
    } finally { Pop-Location }
    $record.native_build = [ordered]@{exit_code=$buildCode;log=$buildLog;sha256=(Get-FileHash -LiteralPath $buildLog).Hash.ToLowerInvariant()}
    if ($buildCode) { throw 'Native acceptance build failed.' }
    $record.binaries = @('crony-cli.exe','crony-server.exe','crony-runner.exe' | ForEach-Object {
        $file = Join-Path $target "debug/$_"
        [ordered]@{path=$file;sha256=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
    })
    $record.status = 'passed'
} catch {
    $record.status = 'failed'
    $record.failure = $_.Exception.Message
} finally {
    if ($locked -and $record.Contains('source_before')) {
        try {
            $record.source_after = SourceBinding
            $record.source_unchanged = ($record.source_before | ConvertTo-Json -Depth 12 -Compress) -ceq ($record.source_after | ConvertTo-Json -Depth 12 -Compress)
            if (!$record.source_unchanged) { throw 'Complete source changed during validation.' }
        } catch {
            $record.status = 'failed'
            $record.source_binding_failure = $_.Exception.Message
        }
    }
    $record.finished_at_utc = [DateTime]::UtcNow.ToString('o')
    Save
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
[pscustomobject]$record | Select-Object issue,status,head,source_file_count,canonical_exit_code,source_unchanged,prior_sql_code_matches,failure,source_binding_failure | ConvertTo-Json
if ($record.status -cne 'passed') { exit 1 }
