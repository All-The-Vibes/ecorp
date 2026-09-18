#requires -Version 7.4
[CmdletBinding()]
param(
    [string]$QaRoot,
    [string[]]$ProtectedRoot,
    [int]$ServerPort,
    [int]$WebPort,
    [int]$DatabasePort,
    [int[]]$ProtectedPort = @(),
    [string]$ApprovedNpmRegistry
)

function Get-U1LocalPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]' -or
        $Value.Substring(2).Contains(':')) {
        throw 'Use an absolute local drive path, not a relative, UNC, device or stream path.'
    }
    foreach ($component in $Value.Replace('/', '\').Substring(3).Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
        if ($component -match '[ .]$') { throw 'Trailing dots or spaces in path components are not supported.' }
    }
    $full = [IO.Path]::GetFullPath($Value)
    if ($full.Length -eq 3) { return $full }
    return $full.TrimEnd('\', '/')
}

function Test-U1PathOverlap([string]$Left, [string]$Right) {
    return $Left.Equals($Right, [StringComparison]::OrdinalIgnoreCase) -or
        $Left.StartsWith($Right.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $Right.StartsWith($Left.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-U1NoReparseAncestor([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        try {
            $entry = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Reparse points are not supported in fixture or protected paths.'
            }
            if (!$entry.PSIsContainer) { throw 'An existing path ancestor is not a directory.' }
        } catch [System.Management.Automation.ItemNotFoundException] {
            # Missing fixture directories are expected; inspect every existing ancestor.
        }
        $cursor = Split-Path -Parent $cursor
    }
}

function Get-U1FixturePlan {
    param(
        [string]$Product, [string]$Root, [string[]]$Protected,
        [int[]]$Ports, [int[]]$AdditionalProtectedPorts = @()
    )
    $productPath = Get-U1LocalPath $Product
    $rootPath = Get-U1LocalPath $Root
    if ((Split-Path -Leaf $rootPath) -notmatch '^u1-[a-zA-Z0-9-]+$' -or
        (Split-Path -Leaf (Split-Path -Parent $rootPath)) -ne 'qa') {
        throw 'Use a new dedicated qa\u1-<name> directory.'
    }
    if (!$Protected -or $Protected.Count -eq 0) {
        throw 'Explicit protected office/source roots are required; none are inferred.'
    }
    $protectedPaths = @($productPath) + @($Protected | ForEach-Object { Get-U1LocalPath $_ })
    foreach ($entry in $protectedPaths) {
        Assert-U1NoReparseAncestor $entry
        if (!(Test-Path -LiteralPath $entry -PathType Container -ErrorAction Stop)) {
            throw 'Every protected root must be an existing directory.'
        }
        if (Test-U1PathOverlap $rootPath $entry) {
            throw 'The fixture must be disjoint from product and protected roots.'
        }
    }
    Assert-U1NoReparseAncestor $rootPath
    if (Test-Path -LiteralPath $rootPath -ErrorAction Stop) {
        throw 'The QA root is occupied; preserve it, never reset or adopt it.'
    }
    $reserved = @(8791, 8793, 5187, 5291, 15191, 15193, 5432, 54329) + $AdditionalProtectedPorts
    if (@($AdditionalProtectedPorts | Where-Object { $_ -lt 1 -or $_ -gt 65535 }).Count -or
        $Ports.Count -ne 3 -or @($Ports | Select-Object -Unique).Count -ne 3 -or
        @($Ports | Where-Object { $_ -lt 10000 -or $_ -gt 65535 -or $_ -in $reserved }).Count) {
        throw 'Use three distinct high ports outside the known and explicitly protected ports.'
    }
    return [ordered]@{
        product = $productPath
        qa_root = $rootPath
        protected_roots = $protectedPaths
        server = "http://127.0.0.1:$($Ports[0])"
        web = "http://127.0.0.1:$($Ports[1])"
        database = @{ host = '127.0.0.1'; port = $Ports[2] }
        directories = @('database', 'source', 'runner', 'artifacts', 'browser', 'credentials', 'evidence') |
            ForEach-Object { Join-Path $rootPath $_ }
    }
}

function Assert-U1PortsAvailable([int[]]$Ports, [int[]]$ListeningPorts) {
    foreach ($port in $Ports) {
        if ($port -in $ListeningPorts) { throw "Requested port $port is occupied; nothing was stopped." }
    }
}

function ConvertTo-U1Registry([string]$Value) {
    $uri = $null
    if (![uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or !$uri.Host -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'An explicit credential-free HTTPS approved registry is required.'
    }
    return $uri.AbsoluteUri.TrimEnd('/')
}

function Invoke-U1ReadCommand([string]$Name, [string[]]$Arguments) {
    $command = Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $result = & $command.Source @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Read-only prerequisite command failed.' }
    return ($result -join "`n").Trim()
}

function Assert-U1CommandAvailable([string]$Name) {
    Get-Command $Name -CommandType Application -ErrorAction Stop | Out-Null
}

function Invoke-U1Preflight {
    param([string]$Product, [hashtable]$Options)
    $checks = [Collections.Generic.List[object]]::new()
    $report = [ordered]@{
        schema_version = 1
        scope = 'u1-fresh-fixture-preparation-only'
        observed_at = [DateTime]::UtcNow.ToString('o')
        status = 'blocked'
        acceptance = 'not-run'
        effects = 'none'
        plan = $null
        source_commit = $null
        required_toolchain = @{ rust = '>=1.94.0'; node = '>=22.12.0'; pnpm = $null }
        checks = $checks
        remaining_gates = @(
            'Recover the reviewed R1-R14 / M01-M37 handoff or adopt the replacement in docs/MULTIPLAYER_ACCEPTANCE_V1.md.',
            'Verify pinned toolchain versions and approved package acquisition; command presence is not version validation.',
            'Provision private database/artifacts and independent identities under explicit ownership.',
            'Run current-source OIDC, sandboxed-browser and owner-only full-stack acceptance.',
            'Qualify every required M34 adapter/platform/executable-surface cell.',
            'Verify configuration-bound runtime readiness, source preservation and exact owned shutdown.'
        )
    }
    function Check([string]$Name, [scriptblock]$Action, [string]$Failure) {
        try {
            & $Action | Out-Null
            $checks.Add(@{ name = $Name; status = 'passed' })
        } catch {
            # Never serialize command stderr, registry credentials or inherited environment values.
            $checks.Add(@{ name = $Name; status = 'blocked'; detail = $Failure })
        }
    }
    Check 'windows' { if (!$IsWindows) { throw 'Windows required.' } } 'This fixture preflight requires Windows.'
    Check 'fixture-plan' {
        if (!$IsWindows) { throw 'Windows required.' }
        $report.plan = Get-U1FixturePlan -Product $Product -Root $Options.QaRoot `
            -Protected $Options.ProtectedRoot -Ports @($Options.ServerPort, $Options.WebPort, $Options.DatabasePort) `
            -AdditionalProtectedPorts $Options.ProtectedPort
    } 'Use a fresh qa\u1-* root disjoint from existing protected roots, without reparse ancestors, and three distinct unprotected high ports.'
    Check 'listeners' {
        if (!$report.plan) { throw 'A valid plan is required.' }
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort)
        Assert-U1PortsAvailable @($Options.ServerPort, $Options.WebPort, $Options.DatabasePort) $listeners
    } 'Listener inventory failed, fixture plan is invalid, or a requested port is occupied; no port is reserved by preflight.'
    Check 'source' {
        $head = Invoke-U1ReadCommand 'git' @('-C', $Product, 'rev-parse', 'HEAD')
        if ($head -notmatch '^[0-9a-f]{40,64}$') { throw 'Invalid source revision.' }
        $report.source_commit = $head
        $status = Invoke-U1ReadCommand 'git' @('--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', $Product, 'status', '--porcelain', '--untracked-files=all')
        if ($status) { throw 'Unrecorded source changes.' }
    } 'Source revision could not be read or the candidate has tracked/untracked changes; commit the intended candidate before runtime acceptance.'
    Check 'rust-commands' {
        Assert-U1CommandAvailable 'rustc'
        Assert-U1CommandAvailable 'cargo'
    } 'Rust/Cargo commands are missing. Presence only is checked; rustup is never invoked or allowed to install a toolchain.'
    Check 'node' {
        $version = Invoke-U1ReadCommand 'node' @('--version')
        if ($version -notmatch '^v(\d+\.\d+\.\d+)$' -or [version]$Matches[1] -lt [version]'22.12.0') {
            throw 'Node 22.12+ required for the repository web toolchain.'
        }
    } 'Node 22.12+ must be available for the repository web toolchain.'
    Check 'pnpm-command' {
        $manifest = Get-Content -LiteralPath (Join-Path $Product 'package.json') -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($manifest.packageManager -notmatch '^pnpm@(\d+\.\d+\.\d+)$') { throw 'Unknown package-manager pin.' }
        $report.required_toolchain.pnpm = $Matches[1]
        Assert-U1CommandAvailable 'pnpm'
    } 'pnpm command or package.json pin is missing. Installed version is not checked: package-manager shims are never invoked.'
    Check 'approved-registry' {
        $approved = ConvertTo-U1Registry $Options.ApprovedNpmRegistry
        Push-Location -LiteralPath $Product
        try { $configured = ConvertTo-U1Registry (Invoke-U1ReadCommand 'npm' @('config', 'get', 'registry')) }
        finally { Pop-Location }
        if ($approved -cne $configured) { throw 'Registry mismatch.' }
    } 'Explicit approved HTTPS registry and effective npm registry must match; neither registry value is emitted.'
    Check 'docker' {
        $version = Invoke-U1ReadCommand 'docker' @('info', '--format', '{{.ServerVersion}}')
        if ($version -notmatch '^\d+\.\d+\.\d+') { throw 'Docker unavailable.' }
    } 'Docker must be reachable for the standard disposable-database lane; no container or image is created.'
    if (@($checks | Where-Object status -eq 'blocked').Count -eq 0) { $report.status = 'preparation-checks-passed' }
    return $report
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    $product = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $report = Invoke-U1Preflight -Product $product -Options @{
        QaRoot = $QaRoot; ProtectedRoot = $ProtectedRoot
        ServerPort = $ServerPort; WebPort = $WebPort; DatabasePort = $DatabasePort
        ProtectedPort = $ProtectedPort; ApprovedNpmRegistry = $ApprovedNpmRegistry
    }
    $report | ConvertTo-Json -Depth 8
    if ($report.status -ne 'preparation-checks-passed') { exit 2 }
}
