#requires -Version 7.4
$ErrorActionPreference = 'Stop'

function Stop-DelegatedNode {
    param([Parameter(Mandatory)][string]$LabRoot)
    $runtimePath = Join-Path $LabRoot '.private/server-runtime.json'
    if (!(Test-Path -LiteralPath $runtimePath)) { return }
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    if ($runtime.platform -ne 'win32' -or $runtime.root -ne $LabRoot -or
        $runtime.entrypoint -ne (Join-Path $LabRoot 'server.mjs') -or
        !$runtime.started_utc -or ![IO.Path]::IsPathFullyQualified([string]$runtime.executable) -or
        ($runtime.pid -isnot [long] -and $runtime.pid -isnot [int]) -or $runtime.pid -le 0) {
        throw 'The fixture ownership record is incomplete; no process was stopped.'
    }
    # ConvertFrom-Json can materialize ISO timestamps as DateTime. A string
    # round trip through the current culture would discard subsecond precision.
    $started = [DateTimeOffset]$runtime.started_utc
    # Treat only a lookup proving absence as already stopped. All access,
    # identity, termination and wait errors remain visible.
    try { $process = Get-Process -Id ([int]$runtime.pid) -ErrorAction Stop }
    catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
        if ($_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId,*') { throw }
        return
    }
    try {
        [void]$process.Handle
        $owned = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.pid)"
        if ($process.HasExited) { return }
        if (!$owned -or $process.StartTime.ToUniversalTime().Ticks -ne $started.UtcTicks -or
            ![StringComparer]::OrdinalIgnoreCase.Equals($process.Path, $runtime.executable) -or
            $owned.Name -ne 'node.exe' -or $process.ProcessName -ne 'node' -or
            ![StringComparer]::OrdinalIgnoreCase.Equals($owned.ExecutablePath, $runtime.executable) -or
            [Math]::Abs((([DateTimeOffset]$owned.CreationDate).UtcTicks - $started.UtcTicks)) -gt 10) {
            throw 'Recorded identity no longer matches this lab; no process was stopped.'
        }
        # Keep this exact kernel handle through termination. Never reopen the
        # numeric PID or infer ownership of descendants.
        $process.Kill()
        if (!$process.WaitForExit(15000)) {
            throw 'The verified fixture has not exited; its record is retained.'
        }
    } finally { $process.Dispose() }
}

Stop-DelegatedNode -LabRoot $PSScriptRoot
$providerPath = Join-Path $PSScriptRoot '.private/provider-runtime.json'
if (Test-Path -LiteralPath $providerPath) {
    $provider = Get-Content -LiteralPath $providerPath -Raw | ConvertFrom-Json
    if ($provider.container -notmatch '^[0-9a-f]{64}$' -or
        $provider.composeProject -ne 'taskrabbit-local-obo' -or
        $provider.image -ne 'quay.io/keycloak/keycloak:26.7.4') {
        throw 'The provider ownership record is incomplete; provider retained.'
    }
    $inspected = docker inspect --type container $provider.container
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the recorded provider; retained.' }
    $container = @($inspected | ConvertFrom-Json)[0]
    if ($container.Id -ne $provider.container -or $container.Config.Image -ne $provider.image -or
        $container.Config.Labels.'com.docker.compose.project' -ne $provider.composeProject -or
        $container.Config.Labels.'com.docker.compose.service' -ne 'keycloak' -or
        $container.Config.Labels.'com.docker.compose.project.working_dir' -ne $PSScriptRoot) {
        throw 'Provider identity no longer matches this lab; provider retained.'
    }
    docker stop $provider.container
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the verified provider.' }
}
Write-Output 'Local proof stopped; synthetic private state and task-owned volume retained.'
