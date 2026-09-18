#requires -Version 7.4
$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'Run the U1 preflight regression on Windows.' }
. (Join-Path $PSScriptRoot 'qa_multiplayer_preflight.ps1')

function Assert([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}
function Reject([scriptblock]$Action, [string]$Pattern) {
    $caught = $false
    try { & $Action | Out-Null } catch {
        $caught = $true
        Assert ($_.Exception.Message -match $Pattern) "Unexpected rejection: $($_.Exception.Message)"
    }
    Assert $caught "Expected rejection matching $Pattern"
}

$fixture = Join-Path ([IO.Path]::GetTempPath()) "ecorp-u1-preflight-$([guid]::NewGuid().ToString('N'))"
$product = Join-Path $fixture 'product [literal] with spaces'
$office = Join-Path $fixture 'retained-office'
$qa = Join-Path $fixture 'qa\u1-new'
$completed = $false
New-Item -ItemType Directory -Path $product, $office | Out-Null
[IO.File]::WriteAllText((Join-Path $product 'package.json'), '{"packageManager":"pnpm@11.19.0"}')
[IO.File]::WriteAllText((Join-Path $office 'sentinel'), 'untouched')
try {
    $planArgs = @{ Product = $product; Root = $qa; Protected = @($office); Ports = @(18870, 15870, 15470) }
    $plan = Get-U1FixturePlan @planArgs
    Assert ($plan.qa_root -eq $qa) 'Expected literal-path support.'
    Assert ($plan.directories.Count -eq 7) 'Expected separately named planned storage roots.'
    Assert (!(Test-Path -LiteralPath $qa)) 'Planning must not create the fixture.'
    foreach ($bad in @('', '.', 'C:relative', '\\host\share\qa\u1-new', '\\?\C:\qa\u1-new', 'C:\qa\u1-new:stream')) {
        Reject { Get-U1LocalPath $bad } 'absolute local drive'
    }
    foreach ($bad in @('C:\office.\qa\u1-new', 'C:\office \qa\u1-new', 'C:\qa\u1-new.')) {
        Reject { Get-U1LocalPath $bad } 'Trailing dots or spaces'
    }
    Assert ((Get-U1LocalPath 'C:\') -eq 'C:\') 'A protected drive root must not become a drive-relative path.'
    Assert (Test-U1PathOverlap 'C:\' 'C:\qa\u1-new') 'A protected drive root overlaps descendants.'
    Assert (!(Test-U1PathOverlap 'C:\' 'D:\qa\u1-new')) 'Different drives do not overlap.'
    Assert (Test-U1PathOverlap 'C:\office' 'c:\OFFICE\child') 'Windows path comparison must ignore case.'
    Assert (Test-U1PathOverlap 'C:\office\child' 'C:\office') 'Ancestor overlap must be denied.'
    Assert (!(Test-U1PathOverlap 'C:\office' 'C:\office-two')) 'Sibling prefix is not overlap.'
    Reject { Get-U1FixturePlan @planArgs -AdditionalProtectedPorts @(15470) } 'distinct high ports'
    Reject { Get-U1FixturePlan @planArgs -AdditionalProtectedPorts @(-1) } 'distinct high ports'
    foreach ($port in @(0, 9999, 65536, 8791, 8793, 5187, 5291, 15191, 15193, 5432, 54329, 18870, 15870)) {
        $bad = $planArgs.Clone(); $bad.Ports = @(18870, 15870, $port)
        Reject { Get-U1FixturePlan @bad } 'distinct high ports'
    }
    $bad = $planArgs.Clone(); $bad.Protected = @()
    Reject { Get-U1FixturePlan @bad } 'Explicit protected'
    $bad.Protected = @((Join-Path $fixture 'absent-office'))
    Reject { Get-U1FixturePlan @bad } 'existing directory'
    $bad = $planArgs.Clone(); $bad.Root = Join-Path $office 'qa\u1-new'
    Reject { Get-U1FixturePlan @bad } 'disjoint'
    $bad.Root = Join-Path $product 'qa\u1-new'
    Reject { Get-U1FixturePlan @bad } 'disjoint'
    $bad.Root = Join-Path $fixture 'qa\other'
    Reject { Get-U1FixturePlan @bad } 'dedicated'
    New-Item -ItemType Directory -Path $qa | Out-Null
    [IO.File]::WriteAllText((Join-Path $qa 'retained-failure'), 'keep')
    Reject { Get-U1FixturePlan @planArgs } 'occupied'
    Assert ((Get-Content -LiteralPath (Join-Path $qa 'retained-failure') -Raw) -eq 'keep') 'Occupied fixture must be preserved.'
    $planArgs.Root = Join-Path $fixture 'qa\u1-next'
    $junction = Join-Path $fixture 'qa\u1-link'
    New-Item -ItemType Junction -Path $junction -Target $office | Out-Null
    $bad = $planArgs.Clone(); $bad.Root = $junction
    Reject { Get-U1FixturePlan @bad } 'Reparse'
    $bad.Root = Join-Path $junction 'qa\u1-nested'
    Reject { Get-U1FixturePlan @bad } 'Reparse'
    $bad = $planArgs.Clone(); $bad.Protected = @($junction)
    Reject { Get-U1FixturePlan @bad } 'Reparse'
    Remove-Item -LiteralPath $junction
    Assert-U1PortsAvailable @(18870, 15870, 15470) @(443, 5432)
    Reject { Assert-U1PortsAvailable @(18870, 15870, 15470) @(15870) } 'occupied'
    foreach ($registry in @('', 'http://registry.invalid', 'https://user:secret@registry.invalid', 'https://registry.invalid/?secret=x', 'https://registry.invalid/#x')) {
        Reject { ConvertTo-U1Registry $registry } 'credential-free HTTPS'
    }
    Assert ((ConvertTo-U1Registry 'https://registry.invalid/npm/') -eq 'https://registry.invalid/npm') 'Registry path must be preserved.'

    # Only prerequisite observations are stubbed; path/port/report guards above remain real.
    $script:dirty = $false
    $script:missing = ''
    $script:busy = $false
    $script:inventoryFailure = $false
    $script:registry = 'https://registry.invalid/npm/'
    $script:commands = [Collections.Generic.List[string]]::new()
    function Invoke-U1ReadCommand([string]$Name, [string[]]$Arguments) {
        $script:commands.Add("$Name $($Arguments -join ' ')")
        if ($Name -eq 'git') {
            if ($Arguments -contains 'rev-parse') { return 'a' * 40 }
            if ($script:dirty) { return '?? unrecorded.txt' }
            return ''
        }
        if ($Name -eq 'node') { return 'v22.14.0' }
        if ($Name -eq 'npm') { return $script:registry }
        if ($Name -eq 'docker') { return '29.8.0' }
        throw 'Unexpected command.'
    }
    function Assert-U1CommandAvailable([string]$Name) {
        if ($Name -eq $script:missing) { throw 'Missing fixture command.' }
    }
    function Get-NetTCPConnection {
        if ($script:inventoryFailure) { throw 'fixture inventory unavailable' }
        if ($script:busy) { return @{ LocalPort = 18870 } }
        return @{ LocalPort = 443 }
    }
    $options = @{
        QaRoot = $planArgs.Root; ProtectedRoot = @($office)
        ServerPort = 18870; WebPort = 15870; DatabasePort = 15470
        ProtectedPort = @(); ApprovedNpmRegistry = 'https://registry.invalid/npm'
    }
    $report = Invoke-U1Preflight -Product $product -Options $options
    Assert ($report.status -eq 'preparation-checks-passed') ($report | ConvertTo-Json -Depth 8)
    Assert ($report.acceptance -eq 'not-run' -and $report.effects -eq 'none') 'Preflight is not acceptance.'
    Assert ($report.required_toolchain.pnpm -eq '11.19.0') 'Record the repository pin without executing a package-manager shim.'
    Assert ($report.remaining_gates.Count -eq 6) 'Do not omit deferred U1 gates.'
    Assert ($report.remaining_gates[0] -match 'or adopt the replacement') 'Unavailable historical plans must allow a reviewed replacement, not an acceptance bypass.'
    Assert (@($script:commands | Where-Object { $_ -match 'install|rustup|^pnpm|^cargo|^rustc' }).Count -eq 0) 'No install-capable shim may be run.'
    Assert (@($script:commands | Where-Object { $_ -match 'core.fsmonitor=false' }).Count -eq 1) 'Source status must disable fsmonitor hooks.'
    foreach ($name in @('rustc', 'cargo', 'pnpm')) {
        $script:missing = $name
        Assert ((Invoke-U1Preflight -Product $product -Options $options).status -eq 'blocked') 'Missing tools must block.'
    }
    $script:missing = ''
    $script:dirty = $true
    $report = Invoke-U1Preflight -Product $product -Options $options
    Assert ($report.status -eq 'blocked' -and $report.source_commit -eq ('a' * 40)) 'Dirty source must not inherit clean-source acceptance.'
    $script:dirty = $false
    $script:busy = $true
    Assert ((Invoke-U1Preflight -Product $product -Options $options).status -eq 'blocked') 'Occupied ports must block.'
    $script:busy = $false
    $script:inventoryFailure = $true
    Assert ((Invoke-U1Preflight -Product $product -Options $options).status -eq 'blocked') 'Unavailable inventory must not look like free ports.'
    $script:inventoryFailure = $false
    $script:registry = 'https://user:DO_NOT_PRINT@registry.invalid/'
    $report = Invoke-U1Preflight -Product $product -Options $options
    Assert ($report.status -eq 'blocked') 'Credential-bearing registry must block.'
    Assert (($report | ConvertTo-Json -Depth 8) -notmatch 'DO_NOT_PRINT') 'Diagnostics must not expose registry credentials.'
    $script:registry = 'https://other.invalid/'
    Assert ((Invoke-U1Preflight -Product $product -Options $options).status -eq 'blocked') 'An unapproved registry must block.'
    Assert (!(Test-Path -LiteralPath $options.QaRoot)) 'Preflight must remain read-only on success and failure.'
    Assert ((Get-Content -LiteralPath (Join-Path $office 'sentinel') -Raw) -eq 'untouched') 'Retained office sentinel changed.'
    $completed = $true
    Write-Output 'U1 preflight path, port, tool, source, registry, report and read-only regressions passed.'
} finally {
    if ($completed) {
        $resolved = (Get-Item -LiteralPath $fixture -Force).FullName
        Assert ($resolved -eq $fixture -and (Split-Path -Leaf $resolved) -match '^ecorp-u1-preflight-[0-9a-f]{32}$') 'Refuse unexpected cleanup target.'
        Remove-Item -LiteralPath $resolved -Recurse
    } else {
        Write-Warning "Failed synthetic fixture retained at $fixture"
    }
}
