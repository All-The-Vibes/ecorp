#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (!$IsWindows) { throw 'This native startup handoff regression requires Windows.' }

# Run in a dedicated PowerShell process. Never send ambient credentials to fixtures.
$osNames = @('SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec')
foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    if ($name -notin $osNames) { [Environment]::SetEnvironmentVariable($name, [NullString]::Value, 'Process') }
}
$node = (Resolve-Path -LiteralPath $NodePath).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Choose a new output directory; previous evidence is never overwritten.' }
$null = [IO.Directory]::CreateDirectory($output)
Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force

# Parse, never dot-source/run startup. Execute only these inspected native bytes.
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'local_stack_start.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Startup must parse before behavioral extraction.' }
$selector = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Explicit-Environment'
})
$assignment = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.AssignmentStatementAst] -and
    $_.Left -is [Management.Automation.Language.VariableExpressionAst] -and
    $_.Left.VariablePath.UserPath -eq 'runnerEnvironment'
})
if ($selector.Count -ne 1 -or $assignment.Count -ne 1) { throw 'Expected one native selector and runner assignment.' }
$call = $assignment[0].Right.PipelineElements
if ($call.Count -ne 1 -or $call[0].GetCommandName() -ne 'Explicit-Environment' -or
    $call[0].CommandElements.Count -ne 2) { throw 'Expected a literal explicit-environment selection.' }
$null = $call[0].CommandElements[1].SafeGetValue()
[IO.File]::WriteAllText((Join-Path $output 'extracted-startup.ps1'),
    $selector[0].Extent.Text + "`n" + $assignment[0].Extent.Text)
. ([scriptblock]::Create($selector[0].Extent.Text))
$selectRunner = [scriptblock]::Create($assignment[0].Extent.Text)

$playwright = Join-Path $output 'launch-observer'
$null = [IO.Directory]::CreateDirectory($playwright)
# This is deliberately not a browser: observe the production launch options and stop.
[IO.File]::WriteAllText((Join-Path $playwright 'index.mjs'), @'
export const chromium = {
  executablePath() { return 'unused-managed-browser'; },
  async launch(options) {
    console.log(JSON.stringify({ launchObserved: options }));
    throw new Error('F01_LAUNCH_OBSERVED_NO_BROWSER_STARTED');
  },
};
'@)
$executable = Join-Path $output 'msedge.exe'
[IO.File]::WriteAllText($executable, 'F01 synthetic pinned bytes; never executable or launched')
$policyPath = Join-Path $output 'valid policy.json'
# Node's hostname is used by the actual resolver; Windows DNS host casing can differ.
$hostnameFile = Join-Path $output 'hostname.mjs'
[IO.File]::WriteAllText($hostnameFile, "import { hostname } from 'node:os'; console.log(hostname());")
$hostNameValue = & $node $hostnameFile
if ($LASTEXITCODE -ne 0) { throw 'Could not read the native Node hostname.' }
[IO.File]::WriteAllText($policyPath, (@{
    version = 1; host = $hostNameValue; platform = 'win32'; browser = 'edge'
    executable = $executable; sha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
} | ConvertTo-Json))
$invalidPath = Join-Path $output 'invalid policy.json'
[IO.File]::WriteAllText($invalidPath, '{"not-valid-json":')
$shim = Join-Path $output 'runner-handoff.mjs'
[IO.File]::WriteAllText($shim, @'
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const [verifier, resultPath, releasePath, delayText] = process.argv.slice(2);
const readinessDelayMilliseconds = Number(delayText);
const started = Date.now();
await delay(readinessDelayMilliseconds);
// Inherited environment models verifier.rs's command (no env_clear/env override).
// This shim is not the Rust runner or its job-object/verification-policy machinery.
const child = spawnSync(process.execPath, [verifier, 'arcade'], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 10000, windowsHide: true,
});
const policy = process.env.CRONY_VERIFIER_BROWSER_POLICY;
const result = {
  pid: process.pid, executable: process.execPath,
  readinessDelayMilliseconds, readyElapsedMilliseconds: Date.now() - started,
  policyPresent: policy !== undefined, policy: policy ?? null,
  playwright: process.env.CRONY_PLAYWRIGHT_MODULE,
  leakedCanaries: ['GH_TOKEN', 'AZURE_CLIENT_SECRET', 'F01_UNLISTED'].filter(k => process.env[k] !== undefined),
  status: child.status, signal: child.signal, error: child.error?.message ?? null,
  stdout: child.stdout, stderr: child.stderr,
};
writeFileSync(resultPath + '.tmp', JSON.stringify(result, null, 2));
renameSync(resultPath + '.tmp', resultPath);
const deadline = Date.now() + 20000;
const timer = setInterval(() => {
  if (existsSync(releasePath) || Date.now() >= deadline) {
    clearInterval(timer);
    process.exitCode = existsSync(releasePath) ? 0 : 2;
  }
}, 25);
'@)
$env:CRONY_PLAYWRIGHT_MODULE = $playwright
foreach ($name in @('GH_TOKEN', 'AZURE_CLIENT_SECRET', 'F01_UNLISTED')) {
    [Environment]::SetEnvironmentVariable($name, 'F01-synthetic-not-a-credential', 'Process')
}
$cases = [Collections.Generic.List[object]]::new()
# Both native module routes: ordinary Start-Process and the literal-path launcher.
# Repeat cold launches, including a delayed child readiness publication.
foreach ($readinessDelayMilliseconds in @(0, 250)) {
foreach ($route in @('normal spaces', 'literal [brackets]')) {
    foreach ($kind in @('valid', 'invalid', 'empty', 'absent')) {
        $workspace = Join-Path $output "$route $kind delay-$readinessDelayMilliseconds"
        $null = [IO.Directory]::CreateDirectory((Join-Path $workspace 'arcade'))
        # A filesystem marker for the verifier's lstat guard, NOT an actual Git checkout.
        [IO.File]::WriteAllText((Join-Path $workspace '.git'), 'F01 synthetic worktree marker')
        $value = switch ($kind) { valid { $policyPath } invalid { $invalidPath } empty { '' } absent { $null } }
        # NullString preserves absence across PowerShell's .NET string binding;
        # ordinary $null binds as "" on runtimes that support empty env values.
        if ($kind -eq 'absent') {
            [Environment]::SetEnvironmentVariable('CRONY_VERIFIER_BROWSER_POLICY', [NullString]::Value, 'Process')
        } else {
            [Environment]::SetEnvironmentVariable('CRONY_VERIFIER_BROWSER_POLICY', $value, 'Process')
        }
        $operatorValue = [Environment]::GetEnvironmentVariable('CRONY_VERIFIER_BROWSER_POLICY', 'Process')
        if (($kind -eq 'absent' -and $null -ne $operatorValue) -or
            ($kind -ne 'absent' -and ($null -eq $operatorValue -or $operatorValue -cne $value))) {
            throw "This runtime cannot represent the requested operator state: $kind"
        }
        . $selectRunner
        $resultPath = Join-Path $workspace 'child.json'
        $releasePath = Join-Path $workspace 'release'
        $record = Start-LocalOwnedProcess -Role 'F01-handoff' -Workspace $workspace -FilePath $node `
            -ArgumentList @($shim, (Join-Path $PSScriptRoot 'verify_arcade_browser.mjs'), $resultPath, $releasePath, [string]$readinessDelayMilliseconds) `
            -WorkingDirectory $workspace -LogDirectory (Join-Path $workspace 'logs') -Environment $runnerEnvironment
        [IO.File]::WriteAllText((Join-Path $workspace 'ownership.json'), ($record | ConvertTo-Json))
        $process = [Diagnostics.Process]::GetProcessById($record.pid)
        $null = $process.Handle
        $creationTicks = $process.StartTime.ToUniversalTime().Ticks
        $owned = $false
        $failures = [Collections.Generic.List[string]]::new()
        try {
            if ($process.Id -ne $record.pid -or $creationTicks -ne ([DateTimeOffset]$record.started_utc).UtcTicks) {
                throw 'Owned fixture identity mismatch; no process was controlled.'
            }
            $deadline = [DateTime]::UtcNow.AddSeconds(15)
            while (!(Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) {
                if ($process.HasExited) { throw 'Owned fixture exited before publishing readiness.' }
                Start-Sleep -Milliseconds 25
            }
            if (!(Test-Path -LiteralPath $resultPath)) { throw 'Owned fixture readiness exceeded 15 seconds.' }
            $observed = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
            if ($observed.pid -ne $record.pid -or
                ![string]::Equals($observed.executable, $node, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Child result does not match owned process.'
            }
            # Windows can expose a null or loader image before readiness. Keep
            # the held handle, then refresh and require the exact ready image.
            $process.Refresh()
            $image = $process.MainModule
            $identity = @{
                expected_pid = $record.pid; observed_pid = $process.Id
                expected_ticks = ([DateTimeOffset]$record.started_utc).UtcTicks
                observed_ticks = $process.StartTime.ToUniversalTime().Ticks
                expected_executable = $node; observed_executable = $image.FileName
            }
            [IO.File]::WriteAllText((Join-Path $workspace 'identity.json'), ($identity | ConvertTo-Json))
            $owned = !$process.HasExited -and $identity.observed_ticks -eq $creationTicks -and
                [string]::Equals($identity.observed_executable, $node, [StringComparison]::OrdinalIgnoreCase)
            if (!$owned) { throw 'Ready fixture identity mismatch; no process was controlled.' }
            if ($observed.readinessDelayMilliseconds -ne $readinessDelayMilliseconds -or
                $observed.readyElapsedMilliseconds -lt $readinessDelayMilliseconds) {
                $failures.Add('The child did not observe its configured readiness delay.')
            }
            if ($observed.policyPresent -ne ($kind -ne 'absent') -or $observed.policy -cne $value) {
                $failures.Add('Explicit policy presence/value was lost at the native runner handoff.')
            }
            if ($observed.leakedCanaries.Count -or $observed.playwright -cne $playwright) {
                $failures.Add('Allowlist isolation or existing Playwright handoff regressed.')
            }
            if ($observed.status -ne 1 -or $observed.signal -or $observed.error) {
                $failures.Add('Verifier must exit 1 at policy rejection or the intentional launch observer.')
            }
            if ($kind -in @('valid', 'absent')) {
                $launch = $observed.stdout | ConvertFrom-Json
                $expected = if ($kind -eq 'valid') {
                    @{ executablePath = $executable; headless = $true; timeout = 30000 }
                } else { @{ channel = 'chrome'; headless = $true } }
                $actual = $launch.launchObserved | ConvertTo-Json -Compress
                $expectedJson = [pscustomobject]$expected | ConvertTo-Json -Compress
                # Compare members independent of hashtable serialization order.
                if (@($launch.launchObserved.PSObject.Properties).Count -ne $expected.Count -or
                    @($expected.Keys | Where-Object { $launch.launchObserved.$_ -cne $expected[$_] }).Count -or
                    $observed.stderr -notmatch 'F01_LAUNCH_OBSERVED_NO_BROWSER_STARTED') {
                    $failures.Add("Unexpected launch selection: $actual (expected $expectedJson).")
                }
            } else {
                $reason = if ($kind -eq 'empty') { 'a local absolute policy path of at most 1024 characters is required' } else { 'invalid policy JSON' }
                if ($observed.stdout -ne '' -or $observed.stderr -notmatch [regex]::Escape($reason) -or
                    $observed.stderr -match 'F01_LAUNCH_OBSERVED_NO_BROWSER_STARTED') {
                    $failures.Add('Explicit invalid/empty policy must reject before launch, never use legacy Chrome.')
                }
            }
        } catch {
            $failures.Add($_.Exception.Message)
        } finally {
            if ($owned) {
                [IO.File]::WriteAllText($releasePath, 'release this owned fixture')
                if (!$process.WaitForExit(15000)) {
                    $process.Kill() # Exact held and identity-verified fixture handle, never a process tree.
                    $null = $process.WaitForExit(5000)
                    $failures.Add('Owned fixture required forced termination.')
                }
                if ($process.ExitCode -ne 0) { $failures.Add("Owned fixture exit: $($process.ExitCode)") }
            }
            # An unverified child retains its bounded lease and is never controlled.
            $process.Dispose()
        }
        $case = @{ name = "$route/$kind/delay-$readinessDelayMilliseconds"; passed = $failures.Count -eq 0; failures = @($failures)
            result = $resultPath; ownership = (Join-Path $workspace 'ownership.json') }
        $cases.Add($case)
        $case | ConvertTo-Json -Compress
    }
}
}
[IO.File]::WriteAllText((Join-Path $output 'cases.json'), (ConvertTo-Json -InputObject @($cases) -Depth 8))
if (@($cases | Where-Object { !$_.passed }).Count) { exit 1 }
exit 0
