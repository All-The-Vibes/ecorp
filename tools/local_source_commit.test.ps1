param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Ref
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force -DisableNameChecking
$before = [Environment]::GetEnvironmentVariables('Process')
$commit = Get-LocalSourceCommit -Repository $Repository -Ref $Ref
$after = [Environment]::GetEnvironmentVariables('Process')
if ($before.Count -ne $after.Count) { throw 'Source inspection changed the caller environment.' }
foreach ($name in $before.Keys) {
    if (!$after.Contains($name) -or $before[$name] -cne $after[$name]) {
        throw 'Source inspection changed the caller environment.'
    }
}
'ECORP_SOURCE_COMMIT_RESULT=' + (@{commit=$commit; environment_unchanged=$true} | ConvertTo-Json -Compress)
