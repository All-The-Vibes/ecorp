#requires -Version 7.4
$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'Run native source-object regressions on Windows.' }
. (Join-Path $PSScriptRoot 'qa_multiplayer_preflight.ps1')
$nativeReadCommand = (Get-Item Function:\Invoke-U1ReadCommand).ScriptBlock
$nativeGit = (Get-Command git -CommandType Application | Select-Object -First 1).Source
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('ecorp-u1-objects-' + [guid]::NewGuid().ToString('N'))
$template = Join-Path $fixture 'empty-template'
$product = Join-Path $fixture 'owned source'
$office = Join-Path $fixture 'protected-office'
$remote = Join-Path $fixture 'owned-promisor.git'
$saved = @{}
$cases = [Collections.Generic.List[object]]::new()
$gitCalls = [Collections.Generic.List[object]]::new()
function Assert([bool]$Value, [string]$Message) { if (!$Value) { throw $Message } }
function Record([string]$Name, [bool]$Passed, [hashtable]$Details) {
    $item = @{ event = 'object-source-case'; name = $Name; passed = $Passed; details = $Details }
    $cases.Add($item)
    Write-Output ($item | ConvertTo-Json -Depth 8 -Compress)
}
function FixtureGit([string]$Root, [string[]]$Arguments) {
    $result = & $nativeGit --no-optional-locks -c core.fsmonitor=false -c "core.hooksPath=$template" -C $Root @Arguments 2>&1
    if ($LASTEXITCODE) { throw "Owned fixture Git failed: $($result -join [Environment]::NewLine)" }
    return ($result -join [Environment]::NewLine).Trim()
}
function Snapshot([string]$Root) {
    return (@(Get-ChildItem -LiteralPath $Root -Force -Recurse -File | Sort-Object FullName | ForEach-Object {
        @{ path = [IO.Path]::GetRelativePath($Root, $_.FullName); sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash }
    }) | ConvertTo-Json -Depth 4 -Compress)
}
function RetainMove([string]$Source, [string]$Destination) {
    foreach ($path in @($Source, $Destination)) {
        Assert ([IO.Path]::GetFullPath($path).StartsWith($fixture + '\', [StringComparison]::OrdinalIgnoreCase)) 'Fixture move escaped its owned root.'
    }
    Assert (!(Test-Path -LiteralPath $Destination)) 'Preserve prior fixture metadata.'
    Move-Item -LiteralPath $Source -Destination $Destination
}
try {
    foreach ($entry in Get-ChildItem Env:) {
        if ($entry.Name -like 'GIT_*' -or $entry.Name -in @('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME')) {
            $saved[$entry.Name] = $entry.Value
        }
    }
    foreach ($entry in @(Get-ChildItem Env:GIT_*)) { Remove-Item -LiteralPath "Env:$($entry.Name)" }
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    foreach ($path in @($template, $product, $office, (Join-Path $fixture 'isolated-home'))) {
        [IO.Directory]::CreateDirectory($path) | Out-Null
    }
    foreach ($name in @('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME')) {
        [Environment]::SetEnvironmentVariable($name, (Join-Path $fixture 'isolated-home'), 'Process')
    }
    # Native controls may use only owned local file transport, never network.
    $env:GIT_ALLOW_PROTOCOL = 'file'
    FixtureGit $product @('init', '--initial-branch=fixture', "--template=$template") | Out-Null
    [IO.File]::WriteAllText((Join-Path $product 'source.txt'), 'owned source-object regression')
    [IO.File]::WriteAllText((Join-Path $product 'package.json'), '{"packageManager":"pnpm@11.19.0"}')
    [IO.File]::WriteAllText((Join-Path $office 'sentinel'), 'preserved')
    FixtureGit $product @('add', '--', 'source.txt', 'package.json') | Out-Null
    FixtureGit $product @('-c', 'user.name=Object Source Fixture', '-c', 'user.email=object-source@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'owned synthetic source') | Out-Null
    $head = FixtureGit $product @('rev-parse', 'HEAD')
    $tree = FixtureGit $product @('rev-parse', 'HEAD^{tree}')
    FixtureGit $fixture @('clone', '--bare', '--no-hardlinks', '--', $product, $remote) | Out-Null
    function Invoke-U1ReadCommand([string]$Name, [string[]]$Arguments) {
        if ($Name -eq 'git') {
            $gitCalls.Add(@{ arguments = $Arguments; no_lazy_fetch = [Environment]::GetEnvironmentVariable('GIT_NO_LAZY_FETCH', 'Process') })
            return & $nativeReadCommand $Name $Arguments
        }
        if ($Name -eq 'node') { return 'v22.14.0' }
        if ($Name -eq 'npm') { return 'https://registry.invalid/npm' }
        if ($Name -eq 'docker') { return '29.8.0' }
        throw 'Unexpected prerequisite in native Git regression.'
    }
    function Assert-U1CommandAvailable([string]$Name) {}
    function Get-NetTCPConnection { return @{ LocalPort = 443 } }
    $options = @{
        QaRoot = Join-Path $fixture 'qa/u1-new'; ProtectedRoot = @($office)
        ServerPort = 18870; WebPort = 15870; DatabasePort = 15470
        ProtectedPort = @(); ApprovedNpmRegistry = 'https://registry.invalid/npm'
    }
    foreach ($inherited in @('0', $null)) {
        if ($null -eq $inherited) { Remove-Item -LiteralPath Env:GIT_NO_LAZY_FETCH -ErrorAction SilentlyContinue }
        else { $env:GIT_NO_LAZY_FETCH = $inherited }
        $gitCalls.Clear()
        $before = Snapshot $product
        $report = Invoke-U1Preflight -Product $product -Options $options
        $isolated = $gitCalls.Count -gt 0 -and @($gitCalls | Where-Object no_lazy_fetch -CNE '1').Count -eq 0
        $restored = if ($null -eq $inherited) { !(Test-Path -LiteralPath Env:GIT_NO_LAZY_FETCH) } else { $env:GIT_NO_LAZY_FETCH -ceq $inherited }
        $passed = $report.status -eq 'preparation-checks-passed' -and $report.source_commit -ceq $head -and $isolated -and $restored -and (Snapshot $product) -ceq $before
        Record "clean source; inherited lazy setting [$inherited]" $passed @{ git_calls = $gitCalls.Count; every_command_isolated = $isolated; environment_restored = $restored; source_preserved = ((Snapshot $product) -ceq $before) }
    }
    # Three independent no-hardlink clones start with the same actual missing tree.
    # The ordinary Git control must fetch it from the owned local promisor.
    foreach ($name in @('native-fetch-control', 'preflight-inherited-zero', 'preflight-absent')) {
        Remove-Item -LiteralPath Env:GIT_NO_LAZY_FETCH -ErrorAction SilentlyContinue
        $clone = Join-Path $fixture $name
        FixtureGit $fixture @('clone', '--no-hardlinks', "--template=$template", '--', $remote, $clone) | Out-Null
        FixtureGit $clone @('config', 'remote.origin.promisor', 'true') | Out-Null
        FixtureGit $clone @('config', 'remote.origin.partialclonefilter', 'blob:none') | Out-Null
        $object = Join-Path $clone ('.git/objects/' + $tree.Substring(0, 2) + '/' + $tree.Substring(2))
        Assert (Test-Path -LiteralPath $object -PathType Leaf) 'The genuine loose root tree is required.'
        RetainMove $object (Join-Path $fixture ($name + '-retained-tree'))
        $before = Snapshot $clone
        if ($name -eq 'native-fetch-control') {
            $fetched = FixtureGit $clone @('cat-file', '-p', $tree)
            $env:GIT_NO_LAZY_FETCH = '1'
            FixtureGit $clone @('cat-file', '-e', $tree) | Out-Null
            $materialized = (Snapshot $clone) -cne $before
            Assert ($fetched -match 'source.txt' -and $materialized) 'Native control must actually fetch and persist the missing root tree.'
            Record 'native local promisor fetch control' $true @{ missing_tree = $tree; objects_materialized = $materialized; network_transport_allowed = $false }
        } else {
            if ($name -eq 'preflight-inherited-zero') { $env:GIT_NO_LAZY_FETCH = '0' }
            else { Remove-Item -LiteralPath Env:GIT_NO_LAZY_FETCH -ErrorAction SilentlyContinue }
            $gitCalls.Clear()
            $report = Invoke-U1Preflight -Product $clone -Options $options
            $blocked = ($report.checks | Where-Object name -eq 'source').status -eq 'blocked' -and $null -eq $report.source_commit
            $preserved = (Snapshot $clone) -ceq $before
            $isolated = $gitCalls.Count -gt 0 -and @($gitCalls | Where-Object no_lazy_fetch -CNE '1').Count -eq 0
            $restored = if ($name -eq 'preflight-inherited-zero') { $env:GIT_NO_LAZY_FETCH -ceq '0' } else { !(Test-Path -LiteralPath Env:GIT_NO_LAZY_FETCH) }
            Record $name ($blocked -and $preserved -and $isolated -and $restored) @{ blocked = $blocked; source_commit = $report.source_commit; entire_source_preserved = $preserved; every_command_isolated = $isolated; environment_restored = $restored; git_calls = $gitCalls.Count }
        }
    }
    Remove-Item -LiteralPath Env:GIT_NO_LAZY_FETCH -ErrorAction SilentlyContinue
    # A linked worktree must inspect alternates in its common object directory.
    $linked = Join-Path $fixture 'linked-source'
    FixtureGit $product @('worktree', 'add', '--detach', '--', $linked, $head) | Out-Null
    foreach ($kind in @('alternates', 'http-alternates')) {
        $pointer = Join-Path $product ('.git/objects/info/' + $kind)
        Assert (!(Test-Path -LiteralPath $pointer)) 'The pointer fixture must start absent.'
        [IO.File]::WriteAllText($pointer, (Join-Path $remote 'objects').Replace('\', '/') + [Environment]::NewLine)
        $pointerHash = (Get-FileHash -LiteralPath $pointer).Hash
        try {
            foreach ($source in @($product, $linked)) {
                $gitCalls.Clear()
                $before = Snapshot $product
                $report = Invoke-U1Preflight -Product $source -Options $options
                $blocked = ($report.checks | Where-Object name -eq 'source').status -eq 'blocked' -and $null -eq $report.source_commit
                $preserved = (Snapshot $product) -ceq $before -and (Get-FileHash -LiteralPath $pointer).Hash -ceq $pointerHash
                Record "$kind; $([IO.Path]::GetFileName($source))" ($blocked -and $gitCalls.Count -eq 0 -and $preserved) @{ blocked = $blocked; git_calls = $gitCalls.Count; metadata_preserved = $preserved }
            }
        } finally {
            RetainMove $pointer (Join-Path $fixture ('retained-' + $kind))
        }
    }
    # A repository-controlled ancestor must be rejected without traversing it.
    $junctionSource = Join-Path $fixture 'junction-source'
    FixtureGit $fixture @('clone', '--no-hardlinks', "--template=$template", '--', $remote, $junctionSource) | Out-Null
    $info = Join-Path $junctionSource '.git/objects/info'
    RetainMove $info (Join-Path $fixture 'retained-original-info')
    $junctionTarget = Join-Path $fixture 'owned-info-target'
    [IO.Directory]::CreateDirectory($junctionTarget) | Out-Null
    [IO.File]::WriteAllText((Join-Path $junctionTarget 'alternates'), (Join-Path $remote 'objects').Replace('\', '/'))
    New-Item -ItemType Junction -Path $info -Target $junctionTarget | Out-Null
    Assert ((Get-Item -LiteralPath $info -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) 'The native junction is required.'
    $targetBefore = Snapshot $junctionTarget
    $gitCalls.Clear()
    $report = Invoke-U1Preflight -Product $junctionSource -Options $options
    $blocked = ($report.checks | Where-Object name -eq 'source').status -eq 'blocked' -and $null -eq $report.source_commit
    Record 'object info junction' ($blocked -and $gitCalls.Count -eq 0 -and (Snapshot $junctionTarget) -ceq $targetBefore) @{ blocked = $blocked; git_calls = $gitCalls.Count; owned_target_preserved = ((Snapshot $junctionTarget) -ceq $targetBefore) }
    # Native Git follows pack and loose-object directory junctions even without
    # alternates. Both normal and linked worktrees must reject before any Git call.
    foreach ($kind in @('pack', 'loose')) {
        $aliasSource = Join-Path $fixture ("$kind-junction-source")
        FixtureGit $fixture @('clone', '--no-hardlinks', "--template=$template", '--', $remote, $aliasSource) | Out-Null
        $aliasLinked = Join-Path $fixture ("$kind-linked-source")
        FixtureGit $aliasSource @('worktree', 'add', '--detach', '--', $aliasLinked, $head) | Out-Null
        if ($kind -eq 'pack') {
            FixtureGit $aliasSource @('repack', '-a', '-d') | Out-Null
            $directory = 'pack'
            $looseHead = Join-Path $aliasSource ('.git/objects/' + $head.Substring(0, 2) + '/' + $head.Substring(2))
            if (Test-Path -LiteralPath $looseHead) {
                RetainMove $looseHead (Join-Path $fixture 'retained-packed-head')
            }
        } else { $directory = $head.Substring(0, 2) }
        $aliasPath = Join-Path $aliasSource ('.git/objects/' + $directory)
        $aliasTarget = Join-Path $fixture ("retained-$kind-objects")
        RetainMove $aliasPath $aliasTarget
        New-Item -ItemType Junction -Path $aliasPath -Target $aliasTarget | Out-Null
        Assert ((Get-Item -LiteralPath $aliasPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) 'The actual object directory junction is required.'
        Assert ((FixtureGit $aliasSource @('cat-file', '-t', $head)) -ceq 'commit') 'Native Git must dereference the original commit through the object junction.'
        foreach ($source in @($aliasSource, $aliasLinked)) {
            $targetBefore = Snapshot $aliasTarget
            $sourceBefore = Snapshot $aliasSource
            $gitCalls.Clear()
            $report = Invoke-U1Preflight -Product $source -Options $options
            $blocked = ($report.checks | Where-Object name -eq 'source').status -eq 'blocked' -and $null -eq $report.source_commit
            $preserved = (Snapshot $aliasTarget) -ceq $targetBefore -and (Snapshot $aliasSource) -ceq $sourceBefore
            Record "$kind object junction; $([IO.Path]::GetFileName($source))" ($blocked -and $gitCalls.Count -eq 0 -and $preserved) @{ blocked = $blocked; git_calls = $gitCalls.Count; native_commit_dereference = $true; source_and_target_preserved = $preserved }
        }
    }
    # Native object aliases without alternates: first prove the object disappears
    # without the alias, then that real Git reads it through the owned alias.
    foreach ($kind in @('pack-directory', 'loose-directory', 'pack-file', 'index-file', 'loose-file')) {
        $aliasSource = if ($kind -eq 'loose-directory') { $product } else { Join-Path $fixture $kind }
        if ($aliasSource -ne $product) {
            FixtureGit $fixture @('clone', '--no-hardlinks', "--template=$template", '--', $remote, $aliasSource) | Out-Null
        }
        if ($kind -in @('pack-directory', 'pack-file', 'index-file')) {
            FixtureGit $aliasSource @('repack', '-a', '-d') | Out-Null
        }
        $expectedTree = FixtureGit $aliasSource @('cat-file', '-p', $tree)
        $before = Snapshot $aliasSource
        $gitCalls.Clear()
        $report = Invoke-U1Preflight -Product $aliasSource -Options $options
        Record "$kind regular control" ($report.status -eq 'preparation-checks-passed' -and
            $report.source_commit -ceq $head -and (Snapshot $aliasSource) -ceq $before) @{
            status = $report.status; source_commit = $report.source_commit; git_calls = $gitCalls.Count
        }
        $objects = Join-Path $aliasSource '.git/objects'
        $alias = switch ($kind) {
            'pack-directory' { Join-Path $objects 'pack' }
            'loose-directory' { Join-Path $objects $tree.Substring(0, 2) }
            'pack-file' { (Get-ChildItem -LiteralPath (Join-Path $objects 'pack') -Filter '*.pack' -ErrorAction Stop).FullName }
            'index-file' { (Get-ChildItem -LiteralPath (Join-Path $objects 'pack') -Filter '*.idx' -ErrorAction Stop).FullName }
            'loose-file' { Join-Path $objects ($tree.Substring(0, 2) + '/' + $tree.Substring(2)) }
        }
        $target = Join-Path $fixture "$kind-owned-target"
        Assert (!(Test-U1PathOverlap $aliasSource $target)) 'Object alias target must be outside Product, inside the owned fixture.'
        RetainMove $alias $target
        $env:GIT_NO_LAZY_FETCH = '1'
        & $nativeGit --no-optional-locks -c "core.hooksPath=$template" -C $aliasSource cat-file -e $tree 2>$null
        $missingExit = $LASTEXITCODE
        Assert ($missingExit -ne 0) 'Native Git must actually lose the tree without the object path; setup failure is not RED.'
        if ($kind.EndsWith('-directory')) {
            New-Item -ItemType Junction -Path $alias -Target $target -ErrorAction Stop | Out-Null
        } else {
            # Native .NET requests unprivileged symlink creation. No elevation or
            # simulated fallback: unavailable host support is a setup failure.
            [IO.File]::CreateSymbolicLink($alias, $target) | Out-Null
        }
        Assert ((Get-Item -LiteralPath $alias -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) 'The actual native object reparse point is required.'
        $targetBefore = if ($kind.EndsWith('-directory')) { Snapshot $target } else { (Get-FileHash -LiteralPath $target).Hash }
        Assert ((FixtureGit $aliasSource @('cat-file', '-p', $tree)) -ceq $expectedTree) 'Native positive control must read the exact tree through the alias.'
        Remove-Item -LiteralPath Env:GIT_NO_LAZY_FETCH
        $sources = @($aliasSource)
        if ($kind -eq 'loose-directory') { $sources += $linked }
        foreach ($source in $sources) {
            $gitCalls.Clear()
            $before = Snapshot $aliasSource
            $environmentBefore = @(Get-ChildItem Env: | Sort-Object Name | Select-Object Name, Value) | ConvertTo-Json -Compress
            $report = Invoke-U1Preflight -Product $source -Options $options
            $environmentAfter = @(Get-ChildItem Env: | Sort-Object Name | Select-Object Name, Value) | ConvertTo-Json -Compress
            $targetAfter = if ($kind.EndsWith('-directory')) { Snapshot $target } else { (Get-FileHash -LiteralPath $target).Hash }
            $blocked = ($report.checks | Where-Object name -eq 'source').status -eq 'blocked' -and $null -eq $report.source_commit
            $preserved = (Snapshot $aliasSource) -ceq $before -and $targetAfter -ceq $targetBefore -and $environmentBefore -ceq $environmentAfter
            Record "$kind alias; $([IO.Path]::GetFileName($source))" ($blocked -and $gitCalls.Count -eq 0 -and $preserved -and $report.effects -eq 'none') @{
                blocked = $blocked; status = $report.status; source_commit = $report.source_commit; git_calls = $gitCalls.Count
                missing_object_exit = $missingExit; native_alias_read = $true; source_target_environment_preserved = $preserved
                alias = $alias; target = $target; source = $source; effects = $report.effects
            }
        }
    }
    Assert (!(Test-Path -LiteralPath $options.QaRoot)) 'Source inspection must not provision a QA root.'
    Assert ([IO.File]::ReadAllText((Join-Path $office 'sentinel')) -ceq 'preserved') 'Protected office changed.'
    $failed = @($cases | Where-Object { !$_.passed })
    Write-Output (@{ event = 'object-source-summary'; cases = $cases.Count; passed = $cases.Count - $failed.Count; failed = $failed.Count; fixture = $fixture } | ConvertTo-Json -Compress)
    Assert ($failed.Count -eq 0) 'Native source-object regression failed; all owned fixtures are retained.'
} finally {
    foreach ($entry in @(Get-ChildItem Env:GIT_*)) { Remove-Item -LiteralPath "Env:$($entry.Name)" }
    foreach ($name in @('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    Write-Output (@{ event = 'retained-object-source-fixture'; path = $fixture; recursive_cleanup = $false } | ConvertTo-Json -Compress)
}
