#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$QaRoot)
$ErrorActionPreference = 'Stop'
$repo = '<USERPROFILE>\.codex\worktrees\issue48-retirement\ecorp'
& (Join-Path $PSScriptRoot 'issue48-native-supervisor-r1.ps1') -Phase Status -QaRoot $QaRoot
Import-Module (Join-Path $repo 'tools/local_stack.psm1') -Force
$qa = (Resolve-Path -LiteralPath $QaRoot).Path
$owner = Get-Content -LiteralPath (Join-Path $qa 'ownership.json') -Raw | ConvertFrom-Json
if ($owner.plan.provider_mode -cne 'fake-only' -or !$owner.ready_at -or $owner.stopped_at) {
    throw 'Staffing acceptance requires a ready, owned fake-only fixture.'
}
$output = Join-Path $qa 'evidence/staffing-r2'
$processRecord = Join-Path $qa 'evidence/staffing-driver-ownership-r2.json'
if ((Test-Path -LiteralPath $output) -or (Test-Path -LiteralPath $processRecord)) {
    throw 'Preserve existing staffing evidence and use a fresh native fixture.'
}
$driver = Join-Path $PSScriptRoot 'issue48-staffing-native-r2.mjs'
$node = '<USERPROFILE>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe'
$parameters = @{
    ISSUE48_QA_ROOT=$qa;ISSUE48_PRODUCT=$repo
    CRONY_PLAYWRIGHT_MODULE='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
    GIT_OPTIONAL_LOCKS='0';GIT_TERMINAL_PROMPT='0'
}
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $node
$start.WorkingDirectory = $qa
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.ArgumentList.Add($driver)
$start.Environment.Clear()
$environment = New-LocalProcessEnvironment -Environment $parameters
foreach ($name in $environment.Keys) {
    if ($null -ne $environment[$name]) { $start.Environment[$name] = [string]$environment[$name] }
}
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
try {
    if (!$process.Start()) { throw 'Staffing driver did not start.' }
    $record = Get-LocalProcessIdentity -ProcessId $process.Id
    $record.workspace = $qa
    $record.purpose = 'issue48-staffing-native-r2'
    $record.helper_sha256 = (Get-FileHash -LiteralPath $driver).Hash.ToLowerInvariant()
    $record.launcher_sha256 = (Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($processRecord,($record | ConvertTo-Json -Depth 5))
    $process.WaitForExit()
    if ($process.ExitCode) { throw 'Staffing acceptance failed; preserve the fixture and evidence.' }
} finally { $process.Dispose() }
