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
    $invalidComponents = @('*', '?', '<', '>', '|', '"', 'CONIN$', 'conout$') + @(0..31 | ForEach-Object { "bad$([char]$_)name" })
    $deviceNames = @('CON', 'PRN', 'AUX', 'NUL') + @(
        foreach ($prefix in @('COM', 'LPT')) {
            foreach ($digit in @(1..9) + @([char]0xB9, [char]0xB2, [char]0xB3)) { "$prefix$digit" }
        }
    )
    $invalidComponents += @(
        foreach ($device in $deviceNames) {
            $device
            "$($device.ToLowerInvariant()).txt"
            "$device.tar.gz"
        }
    )
    foreach ($component in $invalidComponents) {
        # An absent ancestor must not hide invalid components in any caller's input.
        $invalidPath = "$fixture\missing\$component\qa\u1-invalid"
        foreach ($field in @('Root', 'Product', 'Protected')) {
            $bad = $planArgs.Clone(); $bad[$field] = $invalidPath
            Reject { Get-U1FixturePlan @bad } 'Invalid or reserved Windows path component'
        }
        Reject { Get-U1LocalPath $invalidPath.Replace('\', '/') } 'Invalid or reserved Windows path component'
    }
    foreach ($component in @('literal [brackets] with spaces', 'CONSOLE', 'aux-data', 'NUL-file.txt',
        'COM0', 'COM10', 'LPT0', 'LPT10', 'COM1x', 'LPT9x', 'file.NUL', ' CON', '.config',
        'CONIN$.txt', 'CONOUT$.txt')) {
        $validPath = "$fixture\missing\$component\qa\u1-valid"
        $valid = $planArgs.Clone(); $valid.Root = $validPath
        Assert ((Get-U1FixturePlan @valid).qa_root -eq $validPath) 'Valid non-device components must remain literal.'
        Assert ((Get-U1LocalPath $validPath.Replace('\', '/')) -eq $validPath) 'Forward separators must remain supported.'
    }
    Assert (!(Test-Path -LiteralPath "$fixture\missing")) 'Component validation must not create missing ancestors.'
    Write-Output "F02 component regressions passed: $($invalidComponents.Count) invalid/reserved cases across all three plan inputs and forward separators."
    Assert ((Get-U1LocalPath 'C:\') -eq 'C:\') 'A protected drive root must not become a drive-relative path.'
    Assert (Test-U1PathOverlap 'C:\' 'C:\qa\u1-new') 'A protected drive root overlaps descendants.'
    Assert (!(Test-U1PathOverlap 'C:\' 'D:\qa\u1-new')) 'Different drives do not overlap.'
    Assert (Test-U1PathOverlap 'C:\office' 'c:\OFFICE\child') 'Windows path comparison must ignore case.'
    Assert (Test-U1PathOverlap 'C:\office\child' 'C:\office') 'Ancestor overlap must be denied.'
    Assert (!(Test-U1PathOverlap 'C:\office' 'C:\office-two')) 'Sibling prefix is not overlap.'
    # Native setup is mandatory: inability to create an owned alias is not a test pass.
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class U1AliasProbe {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint QueryDosDevice(string name, StringBuilder target, int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetShortPathName(string path, StringBuilder target, int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DefineDosDevice(uint flags, string name, string target);
}
'@
    function Get-ProbeDriveTarget([string]$Drive) {
        $buffer = [Text.StringBuilder]::new(32768)
        if ([U1AliasProbe]::QueryDosDevice($Drive, $buffer, $buffer.Capacity)) { return $buffer.ToString() }
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -ne 2) { throw "Drive inventory failed: $errorCode" }
        return $null
    }
    $drive = $null
    foreach ($letter in @('Q','R','S','T','U','V','W','X','Y','Z','P','O','N','M','L','K','J','I','H','G','F','E','D')) {
        if (!(Get-ProbeDriveTarget "${letter}:") -and !(Get-PSDrive -Name $letter -ErrorAction SilentlyContinue)) {
            $drive = "${letter}:"
            break
        }
    }
    Assert ($null -ne $drive) 'Native alias setup unavailable: no unused drive letter.'
    $subst = Join-Path $env:SystemRoot 'System32\subst.exe'
    $expectedTarget = "\??\$office"
    $mapped = $false
    try {
        Assert ($null -eq (Get-ProbeDriveTarget $drive)) 'Chosen drive became occupied; do not replace it.'
        Write-Output (@{ event = 'alias-before'; drive = $drive; mapping = $null; fixture = $fixture } | ConvertTo-Json -Compress)
        & $subst $drive $office
        Assert ($LASTEXITCODE -eq 0) 'Native SUBST setup failed; not a behavioral test result.'
        $mapped = $true
        Assert ((Get-ProbeDriveTarget $drive) -ceq $expectedTarget) 'Native mapping does not match the owned synthetic office.'
        Assert ((Get-Content -LiteralPath "$drive\sentinel" -Raw) -eq 'untouched') 'Alias must reach the synthetic sentinel.'
        Write-Output (@{ event = 'alias-created'; drive = $drive; target = $expectedTarget; sameSentinel = $true } | ConvertTo-Json -Compress)
        foreach ($field in @('Root', 'Product', 'Protected')) {
            $bad = $planArgs.Clone()
            $bad[$field] = if ($field -eq 'Root') { "$drive\qa\u1-new" } else { "$drive\" }
            Reject {
                $accepted = Get-U1FixturePlan @bad
                Write-Host (@{ event = 'alias-incorrectly-accepted'; field = $field; qa_root = $accepted.qa_root } | ConvertTo-Json -Compress)
            } 'Substituted, mapped or unverifiable drives'
            Write-Output "F01 native alias rejected in $field."
        }
        Reject { Get-U1LocalPath "$drive/qa/u1-new" } 'Substituted, mapped or unverifiable drives'
        $bad = $planArgs.Clone(); $bad.Root = "$drive\qa\u1-new"; $bad.Protected = @([IO.Path]::GetPathRoot($office))
        Reject { Get-U1FixturePlan @bad } 'Substituted, mapped or unverifiable drives'
        Assert (!(Test-Path -LiteralPath "$office\qa")) 'Alias planning must not create directories.'
    } finally {
        if ($mapped) {
            Assert ((Get-ProbeDriveTarget $drive) -ceq $expectedTarget) 'Mapping changed; refuse to remove a mapping no longer owned.'
            & $subst $drive /D
            Assert ($LASTEXITCODE -eq 0) 'Owned mapping removal failed.'
            Assert ($null -eq (Get-ProbeDriveTarget $drive)) 'Owned mapping remains after cleanup.'
            Write-Output (@{ event = 'alias-cleanup'; drive = $drive; removedTarget = $expectedTarget; mapping = $null } | ConvertTo-Json -Compress)
        }
    }
    $shortBuffer = [Text.StringBuilder]::new(32768)
    $shortLength = [U1AliasProbe]::GetShortPathName($product, $shortBuffer, $shortBuffer.Capacity)
    Assert ($shortLength -gt 0 -and $shortLength -lt $shortBuffer.Capacity) 'Native short-path lookup failed.'
    $shortProduct = $shortBuffer.ToString()
    $valid = $planArgs.Clone(); $valid.Product = $shortProduct
    Assert ((Get-U1FixturePlan @valid).product -eq [IO.Path]::GetFullPath($shortProduct)) 'Ordinary short paths must remain supported.'
    Write-Output (@{ event = 'short-path'; distinctAlias = ($shortProduct -ne $product); accepted = $true } | ConvertTo-Json -Compress)
    Assert (!$shortProduct.Equals($product, [StringComparison]::OrdinalIgnoreCase)) 'This regression requires an actual distinct Windows short alias; unchanged spelling is not coverage.'
    Assert ([IO.Path]::GetFullPath($shortProduct).Equals([IO.Path]::GetFullPath($product), [StringComparison]::OrdinalIgnoreCase)) 'The supported Windows runtime must expand the existing short alias.'
    foreach ($case in @(
        @{ name = 'short fixture ancestor'; Product = $product; Root = "$shortProduct\qa\u1-short"; Protected = @($office) },
        @{ name = 'short product'; Product = $shortProduct; Root = "$product\qa\u1-long"; Protected = @($office) },
        @{ name = 'short protected ancestor'; Product = $office; Root = "$product\qa\u1-long"; Protected = @($shortProduct) },
        @{ name = 'multiple missing descendants'; Product = $product; Root = "$shortProduct\missing\deeper\qa\u1-short"; Protected = @($office) }
    )) {
        $bad = $planArgs.Clone()
        foreach ($field in @('Root', 'Product', 'Protected')) { $bad[$field] = $case[$field] }
        Reject { Get-U1FixturePlan @bad } 'disjoint'
        Write-Output "F01 native short-path overlap rejected: $($case.name)."
    }
    Assert (!(Test-Path -LiteralPath "$product\qa") -and !(Test-Path -LiteralPath "$product\missing")) 'Short-path planning must not create directories.'
    $bad = $planArgs.Clone(); $bad.Protected = @([IO.Path]::GetPathRoot($office))
    Reject { Get-U1FixturePlan @bad } 'disjoint'
    Reject { Get-U1LocalPath "$drive\qa\u1-new" } 'Substituted, mapped or unverifiable drives'
    # Network/unknown device responses are simulated; no SMB share or mapping is created.
    $nativeDriveTarget = (Get-Item Function:\Get-U1DriveTarget).ScriptBlock
    try {
        foreach ($unsupportedTarget in @('\Device\LanmanRedirector\server\share', '\Device\Mup\server\share',
            '\??\C:\elsewhere', '\Device\Unknown', '')) {
            function Get-U1DriveTarget([string]$Drive) { return $unsupportedTarget }
            Reject { Get-U1LocalPath $qa } 'Substituted, mapped or unverifiable drives'
        }
    } finally { Set-Item Function:\Get-U1DriveTarget -Value $nativeDriveTarget }
    Assert ((Get-U1FixturePlan @planArgs).qa_root -eq $qa) 'Native local-drive validation must be restored.'
    Write-Output 'F01 native SUBST/unmapped-drive and simulated mapped/unknown-drive regressions passed.'
    # Two direct DOS drive letters can name the same volume without being SUBST paths.
    $volumeDrive = $null
    $volumeTarget = Get-ProbeDriveTarget ([IO.Path]::GetPathRoot($fixture).Substring(0, 2))
    Assert ($volumeTarget -match '^\\Device\\HarddiskVolume[0-9]+$') 'Native volume-alias setup requires a direct local temp volume.'
    foreach ($letter in @('Q','R','S','T','U','V','W','X','Y','Z','P','O','N','M','L','K','J','I','H','G','F','E','D')) {
        if (!(Get-ProbeDriveTarget "${letter}:") -and !(Get-PSDrive -Name $letter -ErrorAction SilentlyContinue)) {
            $volumeDrive = "${letter}:"
            break
        }
    }
    Assert ($null -ne $volumeDrive) 'Native volume-alias setup unavailable: no unused drive.'
    $volumeMapped = $false
    try {
        Assert ($null -eq (Get-ProbeDriveTarget $volumeDrive)) 'Volume-alias drive became occupied; do not replace it.'
        Write-Output (@{ event = 'volume-before'; drive = $volumeDrive; mapping = $null; target = $volumeTarget; fixture = $fixture } | ConvertTo-Json -Compress)
        # RAW_TARGET_PATH | NO_BROADCAST_SYSTEM; only the unused DOS name is created.
        Assert ([U1AliasProbe]::DefineDosDevice(9, $volumeDrive, $volumeTarget)) 'Native raw-volume setup failed; not a behavioral result.'
        $volumeMapped = $true
        Assert ((Get-ProbeDriveTarget $volumeDrive) -ceq $volumeTarget) 'Raw-volume mapping does not match the exact owned definition.'
        $aliasOffice = $volumeDrive + $office.Substring(2)
        $aliasProduct = $volumeDrive + $product.Substring(2)
        $aliasQa = $volumeDrive + $qa.Substring(2)
        Assert ((Get-Content -LiteralPath "$aliasOffice\sentinel" -Raw) -eq 'untouched') 'Both volume letters must reach the same synthetic sentinel.'
        Write-Output (@{ event = 'volume-created'; drive = $volumeDrive; target = $volumeTarget; sameSentinel = $true } | ConvertTo-Json -Compress)
        foreach ($field in @('Root', 'Product', 'Protected')) {
            $positive = $planArgs.Clone()
            $positive[$field] = switch ($field) { Root { $aliasQa } Product { $aliasProduct } Protected { @($aliasOffice) } }
            $control = Get-U1FixturePlan @positive
            Assert ($control.qa_root -eq $positive.Root -and $control.product -eq $positive.Product) 'Disjoint alias control must preserve normal DOS output paths.'
            Assert ($control.protected_roots[-1] -eq @($positive.Protected)[-1]) 'Protected output must remain a DOS path.'
            Assert ($control.directories[0] -eq (Join-Path $positive.Root 'database')) 'Planned directories must not use native comparison keys.'
            Write-Output "F01 native same-volume disjoint control passed: $field."
        }
        $volumeCases = @(
            @{ name = 'Root'; Product = $product; Root = "$aliasOffice\qa\u1-new"; Protected = @($office) },
            @{ name = 'Protected'; Product = $product; Root = "$office\qa\u1-new"; Protected = @($aliasOffice) },
            @{ name = 'Product'; Product = $aliasProduct; Root = "$product\qa\u1-new"; Protected = @($office) },
            @{ name = 'protected drive root'; Product = $product; Root = $aliasQa; Protected = @([IO.Path]::GetPathRoot($office)) },
            @{ name = 'aliased protected drive root'; Product = $product; Root = $qa; Protected = @("$volumeDrive\") }
        )
        foreach ($case in $volumeCases) {
            $bad = $planArgs.Clone()
            foreach ($field in @('Root', 'Product', 'Protected')) { $bad[$field] = $case[$field] }
            Reject {
                $accepted = Get-U1FixturePlan @bad
                Write-Host (@{ event = 'volume-incorrectly-accepted'; case = $case.name; qa_root = $accepted.qa_root } | ConvertTo-Json -Compress)
            } 'disjoint'
            Write-Output "F01 native same-volume overlap rejected: $($case.name)."
        }
        Assert (!(Test-Path -LiteralPath $qa) -and !(Test-Path -LiteralPath "$office\qa") -and !(Test-Path -LiteralPath "$product\qa")) 'Volume-alias planning must not create directories.'
    } finally {
        if ($volumeMapped) {
            Assert ((Get-ProbeDriveTarget $volumeDrive) -ceq $volumeTarget) 'Volume mapping changed; refuse to remove an unowned definition.'
            # RAW_TARGET_PATH | REMOVE_DEFINITION | EXACT_MATCH_ON_REMOVE | NO_BROADCAST_SYSTEM.
            Assert ([U1AliasProbe]::DefineDosDevice(15, $volumeDrive, $volumeTarget)) 'Exact raw-volume mapping cleanup failed.'
            Assert ($null -eq (Get-ProbeDriveTarget $volumeDrive)) 'Raw-volume mapping remains after cleanup.'
            Write-Output (@{ event = 'volume-cleanup'; drive = $volumeDrive; removedTarget = $volumeTarget; mapping = $null; exactMatch = $true } | ConvertTo-Json -Compress)
        }
    }
    Assert ((Get-U1FixturePlan @planArgs).qa_root -eq $qa) 'Ordinary disjoint planning must remain unchanged after alias cleanup.'
    Write-Output 'F01 native same-volume aliases, disjoint DOS-path controls and drive-root ancestry regressions passed.'
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

    # F03: real Git owns the source boundary; unrelated prerequisites stay offline.
    & {
        $nativeReadCommand = (Get-Item Function:\Invoke-U1ReadCommand).ScriptBlock
        $savedEnvironment = @{}
        foreach ($entry in Get-ChildItem Env:) {
            if ($entry.Name -like 'GIT_*' -or $entry.Name -in @('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME')) {
                $savedEnvironment[$entry.Name] = $entry.Value
            }
        }
        $homeRoot = Join-Path $fixture 'git-home'
        $other = Join-Path $fixture 'other-clean-source'
        $emptyTemplate = Join-Path $fixture 'empty-git-template'
        New-Item -ItemType Directory -Path $homeRoot, $other, $emptyTemplate | Out-Null
        try {
            foreach ($entry in @(Get-ChildItem Env:GIT_*)) { Remove-Item -LiteralPath "Env:$($entry.Name)" }
            foreach ($name in @('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME')) { [Environment]::SetEnvironmentVariable($name, $homeRoot) }
            function Invoke-FixtureGit([string]$Root, [string[]]$Arguments) {
                & $nativeReadCommand 'git' (@('--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', "core.hooksPath=$emptyTemplate", '-C', $Root) + $Arguments)
            }
            foreach ($root in @($product, $other)) {
                Invoke-FixtureGit $root @('init', '--initial-branch=f03-fixture', "--template=$emptyTemplate") | Out-Null
                [IO.File]::WriteAllText((Join-Path $root 'source.txt'), "fixture source: $(Split-Path -Leaf $root)")
                [IO.File]::WriteAllText((Join-Path $root 'package.json'), '{"packageManager":"pnpm@11.19.0"}')
                Invoke-FixtureGit $root @('add', '--', 'source.txt', 'package.json') | Out-Null
                # Synthetic authorship only; never use the operator or PR author's identity.
                Invoke-FixtureGit $root @('-c', 'user.name=F03 Fixture', '-c', 'user.email=f03-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'owned synthetic source') | Out-Null
            }
            function Invoke-U1ReadCommand([string]$Name, [string[]]$Arguments) {
                if ($Name -eq 'git') { return & $nativeReadCommand $Name $Arguments }
                if ($Name -eq 'node') { return 'v22.14.0' }
                if ($Name -eq 'npm') { return 'https://registry.invalid/npm' }
                if ($Name -eq 'docker') { return '29.8.0' }
                throw 'Unexpected non-Git prerequisite.'
            }
            function Assert-U1CommandAvailable([string]$Name) {}
            function Get-NetTCPConnection { return @{ LocalPort = 443 } }
            $gitOptions = @{
                QaRoot = $planArgs.Root; ProtectedRoot = @($office)
                ServerPort = 18870; WebPort = 15870; DatabasePort = 15470
                ProtectedPort = @(); ApprovedNpmRegistry = 'https://registry.invalid/npm'
            }
            $candidateHead = Invoke-FixtureGit $product @('rev-parse', 'HEAD')
            $otherHead = Invoke-FixtureGit $other @('rev-parse', 'HEAD')
            Assert ($candidateHead -ne $otherHead) 'Real fixture repositories must have distinct commits.'
            Assert (!(Invoke-FixtureGit $other @('status', '--porcelain', '--untracked-files=all'))) 'Foreign control must be clean.'
            $control = Invoke-U1Preflight -Product $product -Options $gitOptions
            Assert ($control.status -eq 'preparation-checks-passed' -and $control.source_commit -eq $candidateHead) 'Real clean Product must attest its own commit.'
            $shortControl = Invoke-U1Preflight -Product $shortProduct -Options $gitOptions
            Assert ($shortControl.status -eq 'preparation-checks-passed' -and $shortControl.source_commit -eq $candidateHead) 'An actual short alias must bind to the same clean Git source.'
            Write-Output 'F03 native clean control passed with distinct candidate/foreign identities.'
            $untracked = Join-Path $product 'untracked.txt'
            [IO.File]::WriteAllText($untracked, 'preserve untracked source')
            $report = Invoke-U1Preflight -Product $product -Options $gitOptions
            Assert (($report.checks | Where-Object name -eq 'source').status -eq 'blocked') 'Real untracked Product must block.'
            Assert ([IO.File]::ReadAllText($untracked) -eq 'preserve untracked source') 'Preflight must preserve untracked source.'
            Remove-Item -LiteralPath $untracked
            $sourceFile = Join-Path $product 'source.txt'
            $originalSource = [IO.File]::ReadAllText($sourceFile)
            [IO.File]::WriteAllText($sourceFile, 'preserve dirty expected Product')
            $report = Invoke-U1Preflight -Product $product -Options $gitOptions
            Assert (($report.checks | Where-Object name -eq 'source').status -eq 'blocked' -and $report.source_commit -eq $candidateHead) 'Real tracked dirt must block at the correct candidate identity.'
            Write-Output 'F03 native tracked/untracked dirty controls passed; source bytes preserved.'
            $foreignConfig = Join-Path $fixture 'foreign-git-config'
            [IO.File]::WriteAllText($foreignConfig, "[core]`nworktree = $($other.Replace('\', '/'))`n")
            $overrides = @(
                @{ GIT_DIR = (Join-Path $other '.git'); GIT_WORK_TREE = $other },
                @{ GIT_DIR = (Join-Path $other '.git') },
                @{ GIT_WORK_TREE = $other },
                @{ GIT_COMMON_DIR = (Join-Path $other '.git') },
                @{ GIT_INDEX_FILE = (Join-Path $other '.git\index') },
                @{ GIT_CONFIG = $foreignConfig },
                @{ GIT_CONFIG_GLOBAL = $foreignConfig },
                @{ GIT_CONFIG_SYSTEM = $foreignConfig },
                @{ GIT_CONFIG_PARAMETERS = "'core.worktree=$($other.Replace('\', '/'))'" },
                @{ GIT_CONFIG_COUNT = '1'; GIT_CONFIG_KEY_0 = 'core.worktree'; GIT_CONFIG_VALUE_0 = $other },
                @{ GIT_CONFIG_VALUE_77 = 'F03_ENV_VALUE_MUST_NOT_APPEAR' },
                @{ GIT_OBJECT_DIRECTORY = (Join-Path $other '.git\objects') },
                @{ GIT_ALTERNATE_OBJECT_DIRECTORIES = (Join-Path $other '.git\objects') }
            )
            $beforeFiles = @(Get-ChildItem -LiteralPath $product, $other -Recurse -Force -File | Get-FileHash | Select-Object Path, Hash)
            foreach ($selection in $overrides) {
                try {
                    foreach ($name in $selection.Keys) { [Environment]::SetEnvironmentVariable($name, $selection[$name]) }
                    Assert (@(Get-ChildItem Env:GIT_*).Count -eq $selection.Count) 'Each Git selection case must start with only its own overrides.'
                    $report = Invoke-U1Preflight -Product $product -Options $gitOptions
                    $label = ($selection.Keys | Sort-Object) -join '+'
                    if (($report.checks | Where-Object name -eq 'source').status -eq 'passed') {
                        Write-Output (@{ event = 'f03-foreign-source-incorrectly-accepted'; candidateMatches = ($report.source_commit -eq $candidateHead); foreignMatches = ($report.source_commit -eq $otherHead) } | ConvertTo-Json -Compress)
                    }
                    Assert (($report.checks | Where-Object name -eq 'source').status -eq 'blocked' -and $null -eq $report.source_commit) "Inherited $label must reject before attesting a source commit."
                    $json = $report | ConvertTo-Json -Depth 8
                    Assert (!$json.Contains(($other | ConvertTo-Json -Compress)) -and !$json.Contains(($foreignConfig | ConvertTo-Json -Compress)) -and !$json.Contains('F03_ENV_VALUE_MUST_NOT_APPEAR')) 'Source diagnostics must not serialize selection values.'
                    Write-Output "F03 native selection rejected: $label"
                } finally {
                    foreach ($name in $selection.Keys) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
                }
            }
            $afterFiles = @(Get-ChildItem -LiteralPath $product, $other -Recurse -Force -File | Get-FileHash | Select-Object Path, Hash)
            Assert (($beforeFiles | ConvertTo-Json -Compress) -ceq ($afterFiles | ConvertTo-Json -Compress)) 'Rejected source reads must preserve both real repositories, including indexes and dirty bytes.'
            [IO.File]::WriteAllText($sourceFile, $originalSource)
            $nested = Join-Path $product 'not-the-repository-root'
            New-Item -ItemType Directory -Path $nested | Out-Null
            $report = Invoke-U1Preflight -Product $nested -Options $gitOptions
            Assert (($report.checks | Where-Object name -eq 'source').status -eq 'blocked' -and $null -eq $report.source_commit) 'Git discovery of a parent must not attest the intended Product.'
            Invoke-FixtureGit $product @('config', 'core.worktree', $other) | Out-Null
            try {
                $report = Invoke-U1Preflight -Product $product -Options $gitOptions
                Assert (($report.checks | Where-Object name -eq 'source').status -eq 'blocked' -and $null -eq $report.source_commit) 'Repository-local core.worktree must not attest a foreign root.'
            } finally { Invoke-FixtureGit $product @('config', '--unset', 'core.worktree') | Out-Null }
            $control = Invoke-U1Preflight -Product $product -Options $gitOptions
            Assert ($control.status -eq 'preparation-checks-passed' -and $control.source_commit -eq $candidateHead) 'Clean Product must remain admissible after scoped selection tests.'
            Assert (!(Test-Path -LiteralPath $gitOptions.QaRoot)) 'Native source checks must not provision the QA root.'
            Write-Output 'F03 native Git selection, identity binding, value non-disclosure and preservation regressions passed.'
        } finally {
            foreach ($entry in @(Get-ChildItem Env:GIT_*)) { Remove-Item -LiteralPath "Env:$($entry.Name)" }
            foreach ($name in @('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
            foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
        }
    }

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
            if ($Arguments -contains '--show-toplevel') { return $product }
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
    foreach ($requirement in @('Inventory', 'source hashes', 'crosswalk and differences', 'adoption alone is insufficient')) {
        Assert ($report.remaining_gates[0].Contains($requirement)) 'G0 requires the retained-original inventory, reviewed reconciliation and exact adoption together.'
    }
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
        # Native Git metadata is hidden/read-only on Windows; remove only owned fixture metadata.
        foreach ($gitRoot in @($product, (Join-Path $fixture 'other-clean-source'))) {
            $gitDirectory = [IO.Path]::GetFullPath((Join-Path $gitRoot '.git'))
            Assert ($gitDirectory.StartsWith($resolved + '\', [StringComparison]::OrdinalIgnoreCase)) 'Refuse Git metadata cleanup outside the owned root.'
            Assert-U1NoReparseAncestor $gitDirectory
            Remove-Item -LiteralPath $gitDirectory -Recurse -Force
        }
        Remove-Item -LiteralPath $resolved -Recurse
    } else {
        Write-Warning "Failed synthetic fixture retained at $fixture"
    }
}
