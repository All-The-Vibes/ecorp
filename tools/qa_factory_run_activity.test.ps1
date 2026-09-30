#requires -Version 7.4
$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'These path regressions require native Windows filesystem semantics.' }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('ecorp-activity-paths-' + [guid]::NewGuid().ToString('N'))
$product = Join-Path $fixture 'product [literal] with spaces'
$cases = [Collections.Generic.List[object]]::new()
$directories = [Collections.Generic.List[string]]::new()
$files = [Collections.Generic.List[string]]::new()
$junctions = [Collections.Generic.List[object]]::new()
function Owned([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ne $fixture -and !$full.StartsWith($fixture+'\',[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refuse a fixture path outside the exact owned temporary directory.'
    }
    return $full
}
function Directory([string]$Path) {
    $full = Owned $Path
    New-Item -ItemType Directory -Path $full | Out-Null
    $directories.Add($full)
}
function Check([string]$Name,[scriptblock]$Action) {
    try { & $Action; $cases.Add(@{name=$Name;passed=$true}) }
    catch { $cases.Add(@{name=$Name;passed=$false;error=$_.Exception.Message}) }
}
function Rejection([string]$Root,[string]$Phase,[string]$Pattern) {
    $caught = $null
    try { & $entrypoint -Phase $Phase -QaRoot $Root -PostgresBin $missingPostgres | Out-Null }
    catch { $caught = $_.Exception.Message }
    if (!$caught -or $caught -notmatch $Pattern) { throw "Unexpected entrypoint result: $caught" }
}
function Junction([string]$Path,[string]$Target) {
    $full = Owned $Path
    [void](Owned $Target)
    New-Item -ItemType Junction -Path $full -Target $Target | Out-Null
    $junctions.Add(@{path=$full;target=$Target})
}
$cleaned = $false
try {
    Directory $fixture
    Directory $product
    Directory (Join-Path $product 'tools')
    Directory (Join-Path $fixture 'qa')
    Directory (Join-Path $fixture 'outside')
    foreach ($name in @('qa_factory_run_activity.ps1','qa_multiplayer_preflight.ps1')) {
        $copy = Join-Path $product ('tools\'+$name)
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $copy
        $files.Add($copy)
        if ((Get-FileHash -LiteralPath $copy).Hash -ne (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash) {
            throw 'The synthetic product must execute the exact current entrypoint bytes.'
        }
    }
    $entrypoint = Join-Path $product 'tools\qa_factory_run_activity.ps1'
    $missingPostgres = Join-Path $fixture 'postgres-is-intentionally-absent'
    $sentinel = Join-Path $product 'sentinel.txt'
    [IO.File]::WriteAllText($sentinel,'protected synthetic checkout; never write a fixture here')
    $files.Add($sentinel)
    $sentinelHash = (Get-FileHash -LiteralPath $sentinel).Hash
    # A missing dependency stops valid admissions before process reads, launches
    # or writes. Invalid paths must fail earlier, with the path-specific error.
    foreach ($valid in @((Join-Path $fixture 'qa\pr265-run-activity-new'),
        (Join-Path ($product+'-peer') 'qa\pr265-run-activity-new'))) {
        Check ('admits an independent path: '+$valid) {
            Rejection $valid 'DryRun' 'postgres-is-intentionally-absent'
        }
    }
    foreach ($phase in @('DryRun','Start','Status','Stop')) {
        Check ("$phase rejects a lexical product descendant") {
            Rejection (Join-Path $product 'qa\pr265-run-activity-inside') $phase 'outside the product'
        }
    }
    Junction (Join-Path $fixture 'outside\qa') $product
    Junction (Join-Path $fixture 'redirected') $product
    Junction (Join-Path $fixture 'qa\pr265-run-activity-leaf') $product
    foreach ($shape in @(
        @{name='qa parent junction';path=(Join-Path $fixture 'outside\qa\pr265-run-activity-new')},
        @{name='higher ancestor junction with missing descendants';path=(Join-Path $fixture 'redirected\missing\qa\pr265-run-activity-new')},
        @{name='existing QA leaf junction';path=(Join-Path $fixture 'qa\pr265-run-activity-leaf')}
    )) {
        foreach ($phase in @('DryRun','Start','Status','Stop')) {
            Check ("$phase rejects $($shape.name)") { Rejection $shape.path $phase 'Reparse points' }
        }
    }
    foreach ($path in @('qa\pr265-run-activity-relative', '\\invalid.example\share\qa\pr265-run-activity-network',
        (Join-Path $fixture 'trailing.\qa\pr265-run-activity-new'),
        (Join-Path $fixture 'qa\pr265-run-activity-new:stream'))) {
        Check ('rejects noncanonical input: '+$path) {
            Rejection $path 'Start' 'absolute local drive|Trailing dots or spaces'
        }
    }
    Check 'all admissions preserve the protected sentinel and create no fixture descendants' {
        if ((Get-FileHash -LiteralPath $sentinel).Hash -ne $sentinelHash -or
            (Test-Path -LiteralPath (Join-Path $product 'qa')) -or
            (Test-Path -LiteralPath (Join-Path $product 'missing')) -or
            (Test-Path -LiteralPath (Join-Path $product 'pr265-run-activity-new')) -or
            (Test-Path -LiteralPath (Join-Path $fixture 'qa\pr265-run-activity-new'))) {
            throw 'Admission changed protected fixture state.'
        }
    }
} finally {
    # Only remove exact owned links/files/directories, never recurse through a
    # junction or delete an unexpected entry. Preserve failed cases for diagnosis.
    if ($cases.Count -gt 0 -and !@($cases | Where-Object { !$_.passed }).Count) {
        foreach ($link in $junctions) {
            $item = Get-Item -LiteralPath (Owned $link.path) -Force
            if (!($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Target -ne $link.target) {
                throw 'Junction identity changed; retain the fixture.'
            }
            [IO.Directory]::Delete($link.path)
        }
        foreach ($file in $files) { [IO.File]::Delete((Owned $file)) }
        for ($index=$directories.Count-1; $index -ge 0; $index--) {
            $path = Owned $directories[$index]
            if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Directory identity changed; retain the fixture.'
            }
            [IO.Directory]::Delete($path)
        }
        $cleaned = $true
    }
    $report = @{cases=@($cases);fixture=$fixture;fixture_removed=$cleaned;services_started=0;
        scope='Native admission of the exact entrypoint in a synthetic product; missing PostgreSQL prevents any launch.'}
    Write-Output ('ECORP_ACTIVITY_PATH_RESULT='+($report | ConvertTo-Json -Depth 5 -Compress))
}
if (@($cases | Where-Object { !$_.passed }).Count) { exit 1 }
