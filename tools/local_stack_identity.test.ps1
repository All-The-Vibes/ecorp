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
# Exercise the real Stop body without running qa-host's service/DB setup.
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'issue161/qa-host.ps1'), [ref]$tokens, [ref]$parseErrors)
Check ($parseErrors.Count -eq 0) 'qa-host must parse before testing cleanup.'
$switch = $ast.Find({ param($node) $node -is [Management.Automation.Language.SwitchStatementAst] }, $true)
$stopClause = @($switch.Clauses | Where-Object { $_.Item1.Value -ceq 'Stop' })
Check ($stopClause.Count -eq 1) 'Expected exactly one qa-host Stop clause.'
$qaStop = [scriptblock]::Create($stopClause[0].Item2.Extent.Text.Trim().Substring(1).TrimEnd().TrimEnd('}'))
function Invoke-QaStop([hashtable]$Record) {
    $qa = $workspace
    $state = @{ processes = @{ inert = $Record.Clone() } }
    $statePath = Join-Path $workspace 'qa-host-state.json'
    Save-LocalStackState -Path $statePath -Workspace $qa -State $state
    $before = [IO.File]::ReadAllText($statePath)
    $result = @{ saves = 0; error = $null; messages = [Collections.Generic.List[object]]::new() }
    function Save-State {
        $result.saves++
        Save-LocalStackState -Path $statePath -Workspace $qa -State $state
    }
    try { & $qaStop | ForEach-Object { $result.messages.Add($_) } }
    catch { $result.error = $_.Exception.Message }
    $result.record = $state.processes.inert
    $result.unchanged = [IO.File]::ReadAllText($statePath) -ceq $before
    $result
}
function Check-QaPreserved($Result) {
    Check (![string]::IsNullOrEmpty($Result.error)) 'QA cleanup silently succeeded.'
    Check ($Result.saves -eq 0 -and $Result.unchanged) 'QA cleanup rewrote the ownership receipt.'
    Check (!$Result.record.ContainsKey('stopped_verified')) 'QA cleanup falsely marked the process stopped.'
    Check ($Result.messages.Count -eq 0) 'QA cleanup emitted a success message.'
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
        Case "$fault QA cleanup fails visibly without saving success" {
            Check-QaPreserved (Invoke-QaStop $receipt)
        }
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
        Check-QaPreserved (Invoke-QaStop $mismatch)
        Check (!$child.get_HasExited()) 'QA cleanup stopped a mismatched live child.'
    }
    Case 'exact receipt stops only the owned inert child' {
        $result = Invoke-QaStop $receipt
        Check ($null -eq $result.error) "QA cleanup failed: $($result.error)"
        Check ($child.WaitForExit(5000)) 'Owned handle did not confirm exit.'
        Check ($result.saves -eq 1 -and $result.record.stopped_verified) 'QA cleanup did not persist the verified stop.'
        Check ($result.messages.Count -eq 1) 'QA cleanup did not report the verified stop.'
    }
    Case 'confirmed native absence is distinct from uncertainty' {
        Check ($null -eq (Get-LocalProcessIdentity -ProcessId $child.Id)) 'Exited child returned an identity.'
        Check (!(Test-LocalOwnedProcess -Record $receipt -Workspace $workspace)) 'Exited receipt matched.'
        Check (!(Stop-LocalOwnedProcess -Record $receipt -Workspace $workspace)) 'Exited receipt stopped again.'
    }
    Case 'QA confirmed absence is idempotent' {
        $record = $receipt
        foreach ($attempt in 1..2) {
            $result = Invoke-QaStop $record
            Check ($null -eq $result.error) 'QA cleanup failed on confirmed absence.'
            Check ($result.saves -eq 1 -and $result.record.stopped_verified) 'Confirmed absence was not recorded.'
            Check ($result.messages.Count -eq 1) 'Confirmed absence was not reported.'
            $record = $result.record
        }
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
