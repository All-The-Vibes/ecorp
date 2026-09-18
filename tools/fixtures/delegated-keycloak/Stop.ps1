$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$runtimePath = Join-Path $PSScriptRoot '.private\server-runtime.json'
if (Test-Path $runtimePath) {
    $runtime = Get-Content $runtimePath -Raw | ConvertFrom-Json
    $owned = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.pid)"
    if ($owned) {
        $started = [DateTimeOffset]$runtime.startedAt
        $created = [DateTimeOffset]$owned.CreationDate
        if ($runtime.root -ne $PSScriptRoot -or $owned.Name -ne 'node.exe' -or
            $owned.CommandLine -notmatch 'server\.mjs' -or
            [Math]::Abs(($started - $created).TotalSeconds) -gt 30) {
            throw 'Recorded PID no longer matches this lab. No process was stopped.'
        }
        Stop-Process -Id $runtime.pid
    }
}
docker compose stop keycloak
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the task-owned provider.' }
Write-Output 'Local proof stopped; synthetic private state and task-owned volume retained.'
