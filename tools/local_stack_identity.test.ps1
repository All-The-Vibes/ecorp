#requires -Version 7.4
[CmdletBinding()]
param([string]$EvidenceRoot = [IO.Path]::GetTempPath())
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force
$module = Get-Module local_stack
$workspace = Join-Path $EvidenceRoot ('ecorp-identity-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($workspace) | Out-Null
$cases = [Collections.Generic.List[object]]::new()
$report = @{ workspace = $workspace; cases = $cases; cleanup_verified = $false }
function Check([bool]$Value, [string]$Message) { if (!$Value) { throw $Message } }
function Case([string]$Name, [scriptblock]$Action) {
    try { & $Action; $cases.Add(@{ name = $Name; passed = $true }) }
    catch { $cases.Add(@{ name = $Name; passed = $false; error = $_.Exception.Message }) }
}
function Must-Throw([scriptblock]$Action) {
    $caught = $false
    try { & $Action | Out-Null } catch { $caught = $true }
    Check $caught 'Inspection uncertainty was converted to absence or a successful return.'
}
$info = [Diagnostics.ProcessStartInfo]::new((Get-Command node.exe).Source)
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.WorkingDirectory = $workspace
$info.Environment.Clear()
foreach ($key in @('SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP')) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($null -ne $value) { $info.Environment[$key] = $value }
}
$info.ArgumentList.Add('-e')
$info.ArgumentList.Add('setTimeout(()=>{},60000)')
$child = [Diagnostics.Process]::Start($info)
# Retain the exact native handle from creation, independent of the code under test.
[void]$child.get_Handle()
$creation = $child.get_StartTime()
try {
    $receipt = Get-LocalProcessIdentity -ProcessId $child.Id
    $receipt.workspace = $workspace
    $report.receipt = $receipt
    $statePath = Join-Path $workspace 'ownership.json'
    Save-LocalStackState -Path $statePath -Workspace $workspace -State @{ processes = @{ inert = $receipt } }
    $stateBytes = [IO.File]::ReadAllText($statePath)
    & $module {
        $script:InspectionFault = ''
        $script:UncertainKillAttempted = $false
        # Inject only at the native inspection boundary, never stub the shared helper.
        function script:Get-Process {
            [CmdletBinding()]param([int]$Id)
            switch ($script:InspectionFault) {
                'lookup-denied' { throw [ComponentModel.Win32Exception]::new(5) }
                'lookup-argument' { throw [ArgumentException]::new('injected lookup uncertainty') }
                'lookup-process-error' { throw [Microsoft.PowerShell.Commands.ProcessCommandException]::new('injected lookup uncertainty') }
            }
            $p = Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction Stop
            $p | Add-Member ScriptMethod Kill {
                $script:UncertainKillAttempted = $true
                throw 'Termination attempted while inspection was uncertain.'
            } -Force
            switch ($script:InspectionFault) {
                'handle' {
                    $p | Add-Member ScriptProperty Handle { throw 'injected handle uncertainty' } -Force
                    $p | Add-Member ScriptMethod get_Handle { throw 'injected handle uncertainty' } -Force
                }
                'has-exited' {
                    $p | Add-Member ScriptProperty HasExited { throw 'injected exit uncertainty' } -Force
                    $p | Add-Member ScriptMethod get_HasExited { throw 'injected exit uncertainty' } -Force
                }
                'path' {
                    $p | Add-Member ScriptProperty Path { throw 'injected path uncertainty' } -Force
                    $p | Add-Member ScriptMethod get_MainModule { throw 'injected path uncertainty' } -Force
                }
                'empty-path' {
                    $p | Add-Member ScriptProperty Path { $null } -Force
                    $p | Add-Member ScriptMethod get_MainModule { $null } -Force
                }
                'start-time' {
                    $p | Add-Member ScriptProperty StartTime { throw 'injected time uncertainty' } -Force
                    $p | Add-Member ScriptMethod get_StartTime { throw 'injected time uncertainty' } -Force
                }
            }
            $p
        }
    }
    foreach ($fault in @('lookup-denied', 'lookup-argument', 'lookup-process-error', 'handle', 'has-exited', 'path', 'empty-path', 'start-time')) {
        & $module { param($Fault) $script:InspectionFault = $Fault; $script:UncertainKillAttempted = $false } $fault
        Case "$fault identity propagates" { Must-Throw { Get-LocalProcessIdentity -ProcessId $child.Id } }
        Case "$fault ownership check propagates" { Must-Throw { Test-LocalOwnedProcess -Record $receipt -Workspace $workspace } }
        Case "$fault stop fails closed" { Must-Throw { Stop-LocalOwnedProcess -Record $receipt -Workspace $workspace } }
        Case "$fault preserves live child and receipt" {
            Check (!$child.get_HasExited()) 'The inert child was stopped under uncertainty.'
            Check (!(& $module { $script:UncertainKillAttempted })) 'Termination was attempted under uncertainty.'
            Check ([IO.File]::ReadAllText($statePath) -ceq $stateBytes) 'The ownership receipt changed.'
        }
    }
    & $module { Remove-Item Function:Get-Process; Remove-Variable InspectionFault -Scope Script }
    Case 'invalid PID is not evidence of absence' { Must-Throw { Get-LocalProcessIdentity -ProcessId 0 } }
    Case 'exact identity survives all injected uncertainty' {
        $current = Get-LocalProcessIdentity -ProcessId $child.Id
        Check ($current.started_utc -ceq $receipt.started_utc) 'Creation identity changed.'
        Check (Test-LocalOwnedProcess -Record $receipt -Workspace $workspace) 'Exact receipt did not match.'
    }
    Case 'mismatched creation identity is preserved' {
        $mismatch = $receipt.Clone()
        $mismatch.started_utc = '2000-01-01T00:00:00.0000000Z'
        Check (!(Test-LocalOwnedProcess -Record $mismatch -Workspace $workspace)) 'Mismatched receipt matched.'
        Check (!(Stop-LocalOwnedProcess -Record $mismatch -Workspace $workspace)) 'Mismatched receipt authorized stop.'
        Check (!$child.get_HasExited()) 'Mismatch stopped the live child.'
    }
    Case 'exact receipt stops only the owned inert child' {
        Check (Stop-LocalOwnedProcess -Record $receipt -Workspace $workspace) 'Exact stop failed.'
        Check ($child.WaitForExit(5000)) 'Owned handle did not confirm exit.'
    }
    Case 'confirmed native absence is distinct from uncertainty' {
        Check ($null -eq (Get-LocalProcessIdentity -ProcessId $child.Id)) 'Exited child returned an identity.'
        Check (!(Test-LocalOwnedProcess -Record $receipt -Workspace $workspace)) 'Exited receipt matched.'
        Check (!(Stop-LocalOwnedProcess -Record $receipt -Workspace $workspace)) 'Exited receipt stopped again.'
    }
} finally {
    & $module { Remove-Item Function:Get-Process -ErrorAction SilentlyContinue }
    if (!$child.get_HasExited()) {
        Check ($child.get_StartTime() -eq $creation) 'Held child identity changed; preserve it.'
        $child.Kill() # Exact retained creation handle; never a PID-only fallback.
    }
    $report.cleanup_verified = $child.WaitForExit(5000)
    $child.Dispose()
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $workspace 'report.json')
    Write-Output ('ECORP_IDENTITY_TEST_RESULT=' + ($report | ConvertTo-Json -Depth 8 -Compress))
}
if (!$report.cleanup_verified -or @($cases | Where-Object { !$_.passed }).Count) { exit 1 }
