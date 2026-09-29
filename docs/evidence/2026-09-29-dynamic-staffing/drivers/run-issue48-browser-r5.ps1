#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$QaRoot)
$ErrorActionPreference = 'Stop'
$repo = '<USERPROFILE>\.codex\worktrees\issue48-retirement\ecorp'
& (Join-Path $PSScriptRoot 'issue48-native-supervisor-r1.ps1') -Phase Status -QaRoot $QaRoot
if ($LASTEXITCODE) { throw 'Fixture ownership is not ready.' }
Import-Module (Join-Path $repo 'tools/local_stack.psm1') -Force
$qa = (Resolve-Path -LiteralPath $QaRoot).Path
$output = Join-Path $qa 'evidence/browser-r5'
if (Test-Path -LiteralPath $output) { throw 'Preserve existing browser evidence and native fixture.' }
$node = '<USERPROFILE>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe'
$pg = '<USERPROFILE>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$parameters = @{
    ISSUE48_QA_ROOT=$qa;ISSUE48_PRODUCT=$repo;CRONY_PIN_TEST='1'
    CRONY_SERVER_HTTP='http://127.0.0.1:59031';CRONY_PIN_WEB='http://127.0.0.1:59032'
    CRONY_PIN_SOURCE=(Join-Path $qa 'source');CRONY_PIN_OUTPUT=(Join-Path $qa 'evidence/pin')
    CRONY_PIN_PRIVATE=(Join-Path $qa 'private/pin')
    CRONY_CLI_BINARY=(Join-Path $repo 'target/debug/crony-cli.exe')
    ECORP_PSQL_BINARY=(Join-Path $pg 'psql.exe');PGHOST='127.0.0.1';PGPORT='59030'
    PGUSER='issue48';PGDATABASE='issue48_app_r1';PGPASSFILE=(Join-Path $qa 'credentials/pgpass.conf')
    CRONY_PLAYWRIGHT_MODULE='<USERPROFILE>\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
    GIT_OPTIONAL_LOCKS='0';GIT_TERMINAL_PROMPT='0'
}
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $node
$start.WorkingDirectory = $qa
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.ArgumentList.Add((Join-Path $PSScriptRoot 'issue48-browser-native-r5.mjs'))
$start.Environment.Clear()
$environment = New-LocalProcessEnvironment -Environment $parameters
foreach ($name in $environment.Keys) {
    if ($null -ne $environment[$name]) { $start.Environment[$name] = [string]$environment[$name] }
}
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
try {
    if (!$process.Start()) { throw 'Browser driver did not start.' }
    $record = Get-LocalProcessIdentity -ProcessId $process.Id
    $record.workspace = $qa
    $record.purpose = 'issue48-browser-native-r5'
    $record.helper_sha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'issue48-browser-native-r5.mjs')).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $qa 'evidence/browser-driver-ownership-r5.json'),($record | ConvertTo-Json -Depth 5))
    $process.WaitForExit()
    if ($process.ExitCode) { throw 'Browser acceptance failed; preserve fixture and evidence.' }
} finally { $process.Dispose() }
