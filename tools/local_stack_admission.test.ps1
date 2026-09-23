#requires -Version 7.4
param([Parameter(Mandatory)][string]$NodePath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (!$IsWindows) { throw 'This regression requires Windows.' }
$module = Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force -PassThru -DisableNameChecking
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('ecorp-admission-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$report = @{ fixture = $fixture; cases = @(); cleanup_verified = $true }
foreach ($fault in @('metadata', 'metadata-and-stop')) {
    $state = @{ fault = $fault; launched = $null; observed = $null }
    & $module {
        param($State)
        $script:AdmissionTestState = $State
        function script:Start-Process {
            [CmdletBinding()]
            param($FilePath, $WorkingDirectory, [switch]$PassThru, $WindowStyle,
                $RedirectStandardOutput, $RedirectStandardError, $Environment, $ArgumentList)
            $process = Microsoft.PowerShell.Management\Start-Process @PSBoundParameters
            # Retain the real launch and a verified handle before fault injection.
            [void]$process.Handle
            $script:AdmissionTestState.launched = $process
            $observed = [Diagnostics.Process]::GetProcessById($process.Id)
            [void]$observed.Handle
            $script:AdmissionTestState.observed = $observed
            if ($observed.StartTime.ToUniversalTime().Ticks -ne $process.StartTime.ToUniversalTime().Ticks -or
                $observed.MainModule.FileName -cne $process.MainModule.FileName) { throw 'Native fixture identity changed.' }
            $process | Add-Member -MemberType ScriptProperty -Name StartTime -Value {
                throw [InvalidOperationException]::new('Synthetic post-spawn identity failure')
            } -Force
            if ($script:AdmissionTestState.fault -eq 'metadata-and-stop') {
                $process | Add-Member -MemberType ScriptMethod -Name Kill -Value {
                    throw [InvalidOperationException]::new('Synthetic retained-handle stop failure')
                } -Force
            }
            $process
        }
    } $state
    $case = @{ name = $fault; passed = $false; error = $null }
    try {
        $failure = $null
        try {
            Start-LocalOwnedProcess -Role inert -Workspace $fixture -FilePath $NodePath `
                -ArgumentList @('-e', 'setTimeout(()=>{},45000)') -WorkingDirectory $fixture `
                -LogDirectory (Join-Path $fixture $fault) -Environment @{} | Out-Null
        } catch { $failure = $_.Exception }
        if (!$state.observed -or !$failure) { throw 'Expected a real launched child and metadata exception.' }
        if ($fault -eq 'metadata') {
            if (!$state.observed.HasExited) { throw 'Record construction rejected while its owned child remained alive.' }
            if (!$failure.Data['LocalStackRollbackVerified']) { throw 'Verified rollback evidence was not retained.' }
        } else {
            if ($state.observed.HasExited) { throw 'The injected stop failure did not exercise a live child.' }
            if ($failure.Data['LocalStackRollbackVerified'] -ne $false -or
                ![object]::ReferenceEquals($failure.Data['LocalStackRollbackProcess'], $state.launched)) {
                throw 'Unconfirmed rollback lost the exact retained process capability.'
            }
            if ($state.launched.SafeHandle.IsClosed) { throw 'Unconfirmed rollback disposed its last native capability.' }
        }
        if (!(Test-Path -LiteralPath $failure.Data['LocalStackRollbackStdout']) -or
            !(Test-Path -LiteralPath $failure.Data['LocalStackRollbackStderr'])) { throw 'Diagnostic log paths were lost.' }
        $case.passed = $true
    } catch { $case.error = $_.Exception.Message }
    finally {
        if ($state.observed) {
            try {
                if (!$state.observed.HasExited) { $state.observed.Kill() }
                if (!$state.observed.WaitForExit(5000)) { throw 'Exact test-child cleanup timeout.' }
            } catch { $report.cleanup_verified = $false }
            $state.observed.Dispose()
        }
        if ($state.launched) { $state.launched.Dispose() }
        $report.cases += $case
    }
}
'ECORP_ADMISSION_RESULT=' + ($report | ConvertTo-Json -Compress -Depth 8)
if (!$report.cleanup_verified -or @($report.cases | Where-Object { !$_.passed }).Count) { exit 1 }
