$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$forge = Join-Path $PSScriptRoot 'registry-toolchain\node_modules\@foundry-rs\forge-win32-amd64\bin\forge.exe'
$compiler = Join-Path $PSScriptRoot 'registry-toolchain\solc-0.8.30.exe'
$pins = Get-Content (Join-Path $PSScriptRoot 'registry-toolchain\toolchain.json') -Raw | ConvertFrom-Json
if (!(Test-Path $forge) -or !(Test-Path $compiler)) {
    throw 'Missing pinned build tools; run tools\setup_base_registry.ps1'
}
$version = & $forge --version
if ($LASTEXITCODE -ne 0 -or $version[0] -ne "forge Version: $($pins.foundry.version)" -or
    $version[1] -ne "Commit SHA: $($pins.foundry.commit)") { throw 'Unpinned Forge' }
if ((Get-FileHash $compiler -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pins.solc_native.sha256) {
    throw 'Unpinned native solc'
}
& node tools\build_base_registry.mjs --check
if ($LASTEXITCODE -ne 0) { throw 'Registry artifact is not reproducible' }
& $forge test --use $compiler --match-path 'contracts/test/ECorpCheckpointRegistryV1.t.sol' --gas-report -vv
if ($LASTEXITCODE -ne 0) { throw 'Registry Foundry execution failed' }
& node tools\build_base_registry.mjs --check --check-foundry
if ($LASTEXITCODE -ne 0) { throw 'Native and solc-js bytecode differ' }
& cargo test --locked -p crony-audit --test base_registry_local_chain -- --nocapture
if ($LASTEXITCODE -ne 0) { throw 'Registry REVM execution failed' }
