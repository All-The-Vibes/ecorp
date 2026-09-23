#requires -Version 7.4
$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'Run the preflight mode regression on Windows.' }

# Exercise the complete script with only the native short-name observation
# replaced. These are synthetic prerequisite failures, not native 8.3 coverage.
$root = Join-Path ([IO.Path]::GetTempPath()) "ecorp-u1-modes-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $root | Out-Null
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'qa_multiplayer_preflight.test.ps1') -Raw
$probe = '    $shortLength = [U1AliasProbe]::GetShortPathName($product, $shortBuffer, $shortBuffer.Capacity)'
if (($source.Split($probe)).Count -ne 2) { throw 'Expected one native short-name observation.' }
$pwsh = (Get-Command pwsh.exe).Source
$results = @()
foreach ($case in @(
    @{ name = 'lookup-failed'; replacement = '    $shortLength = 0' },
    @{ name = 'unchanged-spelling'; replacement = '    [void]$shortBuffer.Append($product); $shortLength = $product.Length' }
)) {
    $directory = Join-Path $root $case.name
    New-Item -ItemType Directory -Path $directory | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'qa_multiplayer_preflight.ps1') -Destination $directory
    $driver = Join-Path $directory 'qa_multiplayer_preflight.test.ps1'
    [IO.File]::WriteAllText($driver, $source.Replace($probe, $case.replacement))
    foreach ($mode in @('Required', 'ReportUnavailable')) {
        $log = Join-Path $directory "$mode.log"
        & $pwsh -NoProfile -NonInteractive -File $driver -ShortAliasMode $mode *> $log
        $code = $LASTEXITCODE
        $output = Get-Content -LiteralPath $log -Raw
        $events = @(Get-Content -LiteralPath $log | Where-Object { $_.StartsWith('{') } | ForEach-Object { $_ | ConvertFrom-Json })
        $alias = @($events | Where-Object event -eq 'native-short-alias')
        if ($alias.Count -ne 1 -or $alias[0].status -ne 'blocked' -or $alias[0].executed -or $alias[0].distinctAlias -or $alias[0].mode -ne $mode) {
            throw "Missing truthful blocked result for $($case.name)/$mode; retained at $root"
        }
        if ($mode -eq 'Required') {
            if ($code -eq 0 -or $output -notmatch 'explicitly provisioned Windows volume' -or $output -match 'U1 portable preflight.*passed') {
                throw "Required mode did not fail at its native prerequisite; retained at $root"
            }
        } elseif ($code -ne 0 -or $output -notmatch 'F03 native short-alias Git identity BLOCKED' -or $output -notmatch 'U1 portable preflight.*passed\. Native 8\.3 alias lane: blocked\.') {
            throw "Portable mode failed or omitted blocked native coverage; retained at $root"
        }
        if ($output -match 'F01 native short-path overlap rejected|F03 native short-alias Git identity passed') {
            throw "Synthetic unavailable case claimed actual alias coverage; retained at $root"
        }
        $results += @{ case = $case.name; mode = $mode; exit_code = $code; native_status = $alias[0].status; log_sha256 = (Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant() }
    }
}
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'results.json') -Encoding utf8
Write-Output "All four synthetic short-alias prerequisite/mode regressions passed. Actual native 8.3 coverage is separate. Logs and failed-prerequisite fixtures are retained at $root."
