$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# All downloads are public build tools, never chain RPCs or signing material.
Push-Location (Join-Path $PSScriptRoot 'registry-toolchain')
try {
    & npm ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Pinned registry toolchain installation failed' }
} finally {
    Pop-Location
}
$pins = Get-Content (Join-Path $PSScriptRoot 'registry-toolchain\toolchain.json') -Raw | ConvertFrom-Json
$compiler = Join-Path $PSScriptRoot 'registry-toolchain\solc-0.8.30.exe'
if (!(Test-Path $compiler)) {
    Invoke-WebRequest $pins.solc_native.url -OutFile $compiler
}
if ((Get-FileHash $compiler -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pins.solc_native.sha256) {
    throw 'Pinned native solc SHA256 mismatch'
}
& $compiler --version
if ($LASTEXITCODE -ne 0) { throw 'Pinned solc failed' }
foreach ($tool in @('forge', 'anvil')) {
    $binary = Join-Path $PSScriptRoot "registry-toolchain\node_modules\@foundry-rs\$tool-win32-amd64\bin\$tool.exe"
    $version = & $binary --version
    if ($LASTEXITCODE -ne 0 -or $version[0] -ne "$tool Version: $($pins.foundry.version)" -or
        $version[1] -ne "Commit SHA: $($pins.foundry.commit)") { throw "Unpinned $tool" }
    $version
}
