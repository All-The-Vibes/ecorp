#requires -Version 7.5
# Reuse the explicitly owned PostgreSQL/server/runner/browser fixture lifecycle.
param(
    [Parameter(Mandatory)][string]$PostgresBin,
    [Parameter(Mandatory)][string]$QaParent,
    [Parameter(Mandatory)][string]$OutputRoot,
    [Parameter(Mandatory)][string]$PlaywrightModule
)
& (Join-Path $PSScriptRoot 'e2e_factory_base_refresh.ps1') @PSBoundParameters -Scenario review-revision
exit $LASTEXITCODE
