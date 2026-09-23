#requires -Version 7.4
param([Parameter(Mandatory)][string]$QaRoot)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force -DisableNameChecking
$product = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'delegated_qa_root.ps1')
$qa = Resolve-DelegatedQaRoot -QaRoot $QaRoot -ProductRoot $product -RequireExists
$state = Read-LocalStackState -Path (Join-Path $qa 'ownership.json') -Workspace $qa
if (!$state -or $state.schema_version -ne 2 -or $state.test_owned -ne $true -or
    $state.purpose -ne 'delegated-keycloak-acceptance' -or
    !(Test-LocalPathEqual $state.plan.product $product)) {
    throw 'Missing exact delegated acceptance ownership.'
}
foreach ($role in @('postgres', 'server', 'runner', 'web', 'provider', 'labServer')) {
    if (!(Test-LocalOwnedProcess -Record $state.processes[$role] -Workspace $qa)) {
        throw 'An exact owned fixture process is absent or changed.'
    }
}
$lab = Join-Path $qa 'fixtures/delegated-keycloak'
$evidence = Join-Path $qa 'evidence'
$passfile = Join-Path $qa 'credentials/pgpass.conf'
foreach ($entry in @($lab, $evidence, (Split-Path -Parent $passfile), $passfile)) {
    $cursor = Get-Item -LiteralPath $entry -Force
    while ($cursor -and !(Test-LocalPathEqual $cursor.FullName $qa)) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Acceptance paths must remain inside the owned fixture.'
        }
        $cursor = $cursor.Parent
        if (!$cursor) { $cursor = (Get-Item -LiteralPath $entry).Directory }
    }
}
$database = $state.plan.database
if ($database.host -ne '127.0.0.1' -or $database.user -ne 'delegated320' -or
    $database.name -ne 'delegated320_app' -or !$state.database_authentication.wrong_password_rejected) {
    throw 'Unexpected delegated database scope or authentication.'
}
$endpoints = @(
    @{role='server';value=$state.plan.server}, @{role='web';value=$state.plan.web},
    @{role='provider';value=$state.plan.issuer}, @{role='labServer';value=$state.plan.resource}
)
$ports = [Collections.Generic.HashSet[int]]::new()
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
foreach ($endpoint in $endpoints) {
    $url = [uri]$endpoint.value
    if ($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or $url.UserInfo -or
        $url.Query -or $url.Fragment -or $url.Port -lt 10000 -or
        $url.Port -in @(15191, 15193) -or !$ports.Add($url.Port)) {
        throw 'Unexpected delegated fixture endpoint.'
    }
    $owners = @($listeners | Where-Object LocalPort -eq $url.Port | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1 -or $owners[0] -ne $state.processes[$endpoint.role].pid) {
        throw 'A listener does not belong to its exact fixture process.'
    }
}
if ($database.port -lt 10000 -or !$ports.Add([int]$database.port)) { throw 'Invalid database port.' }
$owners = @($listeners | Where-Object LocalPort -eq $database.port | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -ne 1 -or $owners[0] -ne $state.processes.postgres.pid) { throw 'Database listener ownership changed.' }
$pg = Split-Path -Parent $state.processes.postgres.executable
if ((Split-Path -Leaf $state.processes.postgres.executable) -ne 'postgres.exe') { throw 'Unexpected database executable.' }
$psql = Join-Path $pg 'psql.exe'
$env:PGPASSFILE = $passfile
Remove-Item -LiteralPath Env:PGPASSWORD,Env:PGSERVICE,Env:PGSERVICEFILE,Env:PGOPTIONS -ErrorAction SilentlyContinue
$query = "SELECT json_build_object('database',current_database(),'user',current_user,'port',current_setting('port'),'directory',current_setting('data_directory'));"
$metadata = $query | & $psql -XwqAt -h 127.0.0.1 -p $database.port -U $database.user -d $database.name -v ON_ERROR_STOP=1
if ($LASTEXITCODE) { throw 'Cannot verify owned database metadata.' }
$metadata = $metadata | ConvertFrom-Json
if ($metadata.database -ne $database.name -or $metadata.user -ne $database.user -or
    [int]$metadata.port -ne $database.port -or !(Test-LocalPathEqual $metadata.directory (Join-Path $qa 'database'))) {
    throw 'Database metadata does not match the owned fixture.'
}
@{
    root=$qa;lab=$lab;evidence=$evidence;base=$state.plan.server;web=$state.plan.web
    resource=$state.plan.resource;issuer=$state.plan.issuer;psql=$psql;database=$database
    passfile=$passfile;playwright=$state.plan.playwright;demo=$state.demo
} | ConvertTo-Json -Depth 8 -Compress
