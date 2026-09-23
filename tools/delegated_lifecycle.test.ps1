#requires -Version 7.4
param([Parameter(Mandatory)][string]$NodePath)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force -DisableNameChecking
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'fixtures/delegated-keycloak/Stop.ps1'),
    [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'The delegated stop script does not parse.' }
$function = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Stop-DelegatedNode'
}, $true))
if ($function.Count -ne 1) { throw 'Expected one production stop function.' }
# Exercise the production function without running the Docker entrypoint.
. ([scriptblock]::Create($function[0].Extent.Text))
$root = Join-Path ([IO.Path]::GetTempPath()) ('ecorp-delegated-lifecycle-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root '.private') | Out-Null
$children = [Collections.Generic.List[Diagnostics.Process]]::new()
$cases = [Collections.Generic.List[object]]::new()
function New-FixtureProcess {
    $start = [Diagnostics.ProcessStartInfo]::new($NodePath)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WorkingDirectory = $root
    $start.Environment.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'TEMP', 'TMP')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) { $start.Environment[$name] = $value }
    }
    $start.ArgumentList.Add('-e')
    $start.ArgumentList.Add('setInterval(() => {}, 1000)')
    $process = [Diagnostics.Process]::Start($start)
    [void]$process.Handle
    $children.Add($process)
    return $process
}
function Write-Record([Diagnostics.Process]$Process, [hashtable]$Changes = @{}) {
    $record = Get-LocalProcessIdentity -ProcessId $Process.Id
    $record.root = $root
    $record.entrypoint = Join-Path $root 'server.mjs'
    $record.platform = 'win32'
    foreach ($key in $Changes.Keys) { $record[$key] = $Changes[$key] }
    $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root '.private/server-runtime.json') -Encoding utf8
}
function Check([string]$Name, [scriptblock]$Body) {
    try { & $Body; $cases.Add(@{name=$Name;passed=$true}) }
    catch { $cases.Add(@{name=$Name;passed=$false;error=$_.Exception.Message}) }
}
function Assert-Live([Diagnostics.Process]$Process) {
    if ($Process.HasExited) { throw 'An unrelated or unverifiable fixture was stopped.' }
}
try {
    $sentinel = New-FixtureProcess
    $target = New-FixtureProcess
    foreach ($invalid in @(
        @{name='stale creation time';changes=@{started_utc=[DateTimeOffset]::UtcNow.AddDays(-1).ToString('o')}},
        @{name='wrong executable';changes=@{executable=(Join-Path $root 'other-node.exe')}},
        @{name='wrong lab root';changes=@{root=(Join-Path $root 'other-lab')}},
        @{name='legacy incomplete identity';changes=@{started_utc=$null}},
        @{name='noninteger PID';changes=@{pid=[string]$target.Id}}
    )) {
        Check "rejects $($invalid.name) and preserves both live processes" {
            Write-Record $target $invalid.changes
            $rejected = $false
            try { Stop-DelegatedNode -LabRoot $root } catch { $rejected = $true }
            if (!$rejected) { throw 'Invalid ownership record was accepted.' }
            Assert-Live $target
            Assert-Live $sentinel
        }
    }
    Check 'exact identity stops only its recorded process; repeated stop is harmless' {
        Write-Record $target
        Stop-DelegatedNode -LabRoot $root
        if (!$target.WaitForExit(5000)) { throw 'Exact owned process is still running.' }
        Stop-DelegatedNode -LabRoot $root
        Assert-Live $sentinel
    }
    Check 'exit during inspection never reacquires a numeric PID or stops a replacement' {
        $script:racing = New-FixtureProcess
        $replacement = New-FixtureProcess
        Write-Record $script:racing
        $script:lookups = 0
        function Get-Process {
            param([int]$Id, [string]$ErrorAction)
            $script:lookups++
            Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction Stop
        }
        function Get-CimInstance {
            param([string]$ClassName, [string]$Filter)
            $script:racing.Kill()
            if (!$script:racing.WaitForExit(5000)) { throw 'Could not trigger the owned exit race.' }
            return $null
        }
        try { Stop-DelegatedNode -LabRoot $root }
        finally {
            Remove-Item Function:Get-Process
            Remove-Item Function:Get-CimInstance
        }
        if ($script:lookups -ne 1) { throw 'Stop reopened the numeric PID.' }
        Assert-Live $replacement
        Assert-Live $sentinel
    }
} finally {
    foreach ($child in $children) {
        try {
            if (!$child.HasExited) { $child.Kill(); [void]$child.WaitForExit(5000) }
        } finally { $child.Dispose() }
    }
}
$result = @{scope='owned synthetic Node processes; production stop function';cases=@($cases);fixture=$root;created_processes=$children.Count}
Write-Output ('ECORP_DELEGATED_LIFECYCLE_RESULT=' + ($result | ConvertTo-Json -Depth 8 -Compress))
if (@($cases | Where-Object { !$_.passed }).Count) { exit 1 }
