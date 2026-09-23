param(
    [ValidateRange(1024, 65535)][int]$Port = 18545,
    [ValidateSet(8453, 84532)][int]$ChainId = 84532,
    [string]$CacheDirectory = (Join-Path ([IO.Path]::GetTempPath()) ("ecorp-anvil-" + [Guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$binary = Join-Path $PSScriptRoot 'registry-toolchain\node_modules\@foundry-rs\anvil-win32-amd64\bin\anvil.exe'
if (!(Test-Path $binary)) { throw 'Missing Anvil; run tools\setup_base_registry.ps1' }
$pins = Get-Content (Join-Path $PSScriptRoot 'registry-toolchain\toolchain.json') -Raw | ConvertFrom-Json
$version = & $binary --version
if ($LASTEXITCODE -ne 0 -or $version[0] -ne "anvil Version: $($pins.foundry.version)" -or
    $version[1] -ne "Commit SHA: $($pins.foundry.commit)") { throw 'Unpinned Anvil' }
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } finally { $listener.Stop() }
Write-Output "Starting local-only Anvil at http://127.0.0.1:$Port (chain $ChainId)."
if (![IO.Path]::IsPathFullyQualified($CacheDirectory)) { throw 'Use an absolute, separately owned Anvil cache directory.' }
New-Item -ItemType Directory -Path $CacheDirectory -ErrorAction Stop | Out-Null
# Quiet suppresses Anvil's deterministic fixture private-key banner.
& $binary --host 127.0.0.1 --port $Port --chain-id $ChainId --quiet --cache-path $CacheDirectory --max-persisted-states 10000
if ($LASTEXITCODE -ne 0) { throw "Anvil exited with code $LASTEXITCODE" }
