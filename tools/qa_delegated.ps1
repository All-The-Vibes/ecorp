#requires -Version 7.4
<# Owned native PostgreSQL/Keycloak acceptance. Never adopts an existing stack. #>
[CmdletBinding()]
param(
    [ValidateSet('Start','Status','Stop')][string]$Phase = 'Status',
    [Parameter(Mandatory)][string]$QaRoot,
    [string]$PostgresBin, [string]$BinaryDirectory, [string]$JavaPath,
    [string]$KeycloakDirectory, [string]$PlaywrightDirectory,
    [string]$NodePath = (Get-Command node.exe).Source,
    [int]$FirstPort = 59100
)
$ErrorActionPreference = 'Stop'
$product = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$qa = [IO.Path]::GetFullPath($QaRoot).TrimEnd('\')
if (![IO.Path]::IsPathFullyQualified($QaRoot) -or
    (Split-Path -Leaf $qa) -notmatch '^delegated-keycloak-[a-zA-Z0-9-]+$' -or
    $qa.StartsWith($product, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use a new absolute delegated-keycloak-* QA directory outside the product.'
}
Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force -DisableNameChecking
$recordPath = Join-Path $qa 'ownership.json'
if ($Phase -eq 'Status') {
    & (Join-Path $PSScriptRoot 'verify_delegated_stack.ps1') -QaRoot $qa
    return
}
if ($Phase -eq 'Stop') {
    $state = Read-LocalStackState -Path $recordPath -Workspace $qa
    if (!$state -or $state.purpose -ne 'delegated-keycloak-acceptance' -or !$state.test_owned) {
        throw 'Missing exact delegated fixture ownership.'
    }
    foreach ($role in @('web','runner','server','labServer','provider','postgres')) {
        $record = $state.processes[$role]
        if (!$record) { continue }
        if (!(Test-LocalOwnedProcess -Record $record -Workspace $qa)) {
            try { $remaining = Get-Process -Id $record.pid -ErrorAction Stop }
            catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
                if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') { continue }
                throw
            }
            $remaining.Dispose()
            throw 'A recorded process identity changed; retained without termination.'
        }
        if ($role -eq 'postgres') {
            & (Join-Path (Split-Path -Parent $record.executable) 'pg_ctl.exe') -D (Join-Path $qa 'database') -m fast -w stop
            if ($LASTEXITCODE) { throw 'Owned PostgreSQL stop failed; retained.' }
        } elseif (!(Stop-LocalOwnedProcess -Record $record -Workspace $qa)) {
            throw 'Could not confirm exact fixture process termination.'
        }
    }
    $state.stopped_at = [DateTimeOffset]::UtcNow.ToString('o')
    Save-LocalStackState -Path $recordPath -State $state -Workspace $qa
    Write-Output 'Stopped the exact owned fixture; all private state, source, worktrees and evidence retained.'
    return
}
if (Test-Path -LiteralPath $qa) { throw 'Occupied QA directory; never reset or adopt it.' }
$javaTemp = Join-Path $qa 'java-tmp'
if ([Text.Encoding]::UTF8.GetByteCount($javaTemp) -gt 78) {
    throw 'Use a shorter QA root so the owned Java Unix-domain socket paths fit on Windows.'
}
if ($FirstPort -lt 20000 -or $FirstPort -gt 65527) { throw 'Eight fresh high ports are required.' }
$ports = $FirstPort..($FirstPort + 7)
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort)
if (@($ports | Where-Object { $listeners -contains $_ }).Count) { throw 'QA port occupied; nothing stopped.' }
$pg = (Resolve-Path -LiteralPath $PostgresBin).Path
$node = (Resolve-Path -LiteralPath $NodePath).Path
$java = (Resolve-Path -LiteralPath $JavaPath).Path
$keycloak = (Resolve-Path -LiteralPath $KeycloakDirectory).Path
if ((Get-Content -LiteralPath (Join-Path $keycloak 'version.txt') -Raw).Trim() -ne 'Keycloak - Version 26.7.4') {
    throw 'This fixture pins Keycloak 26.7.4.'
}
$playwright = (Resolve-Path -LiteralPath $PlaywrightDirectory).Path
foreach ($file in @((Join-Path $pg 'initdb.exe'), (Join-Path $pg 'postgres.exe'),
    (Join-Path $pg 'psql.exe'), (Join-Path $BinaryDirectory 'crony-server.exe'),
    (Join-Path $BinaryDirectory 'crony-runner.exe'), (Join-Path $playwright 'index.mjs'))) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'A required native fixture dependency is absent.' }
}
New-Item -ItemType Directory -Path $qa | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $qa /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if ($LASTEXITCODE) { throw 'Cannot protect the private QA root.' }
foreach ($directory in @('logs','source','runner','connections','evidence','credentials','binaries','java-tmp','fixtures/delegated-keycloak/.private')) {
    New-Item -ItemType Directory -Path (Join-Path $qa $directory) | Out-Null
}
$lab = Join-Path $qa 'fixtures/delegated-keycloak'
foreach ($file in (& git -C $product ls-files tools/fixtures/delegated-keycloak)) {
    $relative = $file.Substring('tools/fixtures/delegated-keycloak/'.Length)
    $destination = Join-Path $lab $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $product $file) -Destination $destination
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'local_stack.psm1') -Destination (Join-Path $qa 'local_stack.psm1')
Copy-Item -LiteralPath $keycloak -Destination (Join-Path $qa 'provider') -Recurse
foreach ($binary in @('crony-server.exe','crony-runner.exe')) {
    Copy-Item -LiteralPath (Join-Path $BinaryDirectory $binary) -Destination (Join-Path $qa "binaries/$binary")
}
$plan = @{
    product=$product;source_head=(& git -C $product rev-parse HEAD).Trim()
    server="http://127.0.0.1:$($FirstPort + 5)";web="http://127.0.0.1:$($FirstPort + 6)"
    issuer="http://127.0.0.1:$($FirstPort + 1)/realms/local-obo"
    resource="http://127.0.0.1:$($FirstPort + 4)/flag";playwright=$playwright
    database=@{host='127.0.0.1';port=$FirstPort;user='delegated320';name='delegated320_app'}
    provider='Keycloak 26.7.4; synthetic local users; no Entra/Azure acceptance'
    runner_id=('delegated-fixture-' + [guid]::NewGuid().ToString('N'))
}
$state = @{schema_version=2;workspace=$qa;purpose='delegated-keycloak-acceptance';test_owned=$true;processes=@{};plan=$plan}
function Save { Save-LocalStackState -Path $recordPath -State $state -Workspace $qa }
function Launch([string]$Role,[string]$Executable,[string[]]$ArgumentList,[string]$Directory,[hashtable]$Environment) {
    $state.processes[$Role] = Start-LocalOwnedProcess -Role $Role -Workspace $qa -FilePath $Executable -ArgumentList $ArgumentList -WorkingDirectory $Directory -LogDirectory (Join-Path $qa 'logs') -Environment $Environment
    Save
}
function Wait-Ready([scriptblock]$Probe,[string]$Description,[int]$Seconds=60) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
    do {
        try { if (& $Probe) { return } } catch { }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "$Description did not become ready; preserve fixture and logs."
}
function Secret { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() }
Save
$config = @{
    issuer=$plan.issuer;redirectUri="http://127.0.0.1:$($FirstPort + 2)/callback"
    additionalRedirectUris=@("$($plan.server)/api/delegated/callback")
    ports=@(($FirstPort + 2),($FirstPort + 3),($FirstPort + 4))
    reader=@{username='synthetic-reader';password=(Secret);subject=[guid]::NewGuid().ToString()}
    nonreader=@{username='synthetic-nonreader';password=(Secret);subject=[guid]::NewGuid().ToString()}
    connectorSecret=(Secret);flag=('LOCAL_SYNTHETIC_' + (Secret))
}
[IO.File]::WriteAllText((Join-Path $lab '.private/config.json'),($config | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
& $node (Join-Path $lab 'setup.mjs') --prepare-only *> (Join-Path $qa 'logs/prepare-realm.log')
if ($LASTEXITCODE) { throw 'Realm preparation failed.' }
New-Item -ItemType Directory -Path (Join-Path $qa 'provider/data/import') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $lab '.private/realm.json') -Destination (Join-Path $qa 'provider/data/import/realm.json')
Push-Location -LiteralPath $lab
try {
    & $node (Join-Path (Split-Path -Parent $node) 'node_modules/npm/bin/npm-cli.js') ci --omit=dev --ignore-scripts --no-audit --no-fund *> (Join-Path $qa 'logs/lab-dependencies.log')
    if ($LASTEXITCODE) { throw 'Pinned lab dependency installation failed.' }
} finally { Pop-Location }
$providerRoot = Join-Path $qa 'provider'
$javaArgs = @('-Xms64m','-Xmx512m','-Dfile.encoding=UTF-8','-Djava.util.logging.manager=org.jboss.logmanager.LogManager',
    "-Djdk.net.unixdomain.tmpdir=$javaTemp",
    '-Dquarkus-log-max-startup-records=10000','-Dpicocli.disable.closures=true',
    '--add-opens=java.base/java.util=ALL-UNNAMED','--add-opens=java.base/java.util.concurrent=ALL-UNNAMED',
    '--add-opens=java.base/java.security=ALL-UNNAMED','--add-opens=java.base/java.lang=ALL-UNNAMED','--enable-native-access=ALL-UNNAMED',
    '-Djava.util.concurrent.ForkJoinPool.common.threadFactory=io.quarkus.bootstrap.forkjoin.QuarkusForkJoinWorkerThreadFactory',
    "-Dkc.home.dir=$providerRoot","-Djboss.server.config.dir=$(Join-Path $providerRoot 'conf')","-Dkeycloak.theme.dir=$(Join-Path $providerRoot 'themes')",
    '-cp',(Join-Path $providerRoot 'lib/quarkus-run.jar'),'io.quarkus.bootstrap.runner.QuarkusEntryPoint',
    'start-dev','--http-host=127.0.0.1',"--http-port=$($FirstPort + 1)","--hostname=http://127.0.0.1:$($FirstPort + 1)",
    '--features=token-exchange-standard:v2','--import-realm','--http-access-log-enabled=false')
Launch 'provider' $java $javaArgs $providerRoot @{}
$providerProcess = Get-Process -Id $state.processes.provider.pid -ErrorAction Stop
[void]$providerProcess.Handle
try {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(180)
    $relaunched = $false
    $ready = $false
    do {
        if ($providerProcess.HasExited) {
            if (!$relaunched -and $providerProcess.ExitCode -eq 10) {
                $providerProcess.Dispose()
                Launch 'provider' $java (@('-Dkc.config.built=true') + $javaArgs) $providerRoot @{}
                $providerProcess = Get-Process -Id $state.processes.provider.pid -ErrorAction Stop
                [void]$providerProcess.Handle
                $relaunched = $true
            } else { throw 'The owned provider exited before readiness; inspect its retained logs.' }
        }
        try { $ready = (Invoke-RestMethod "$($plan.issuer)/.well-known/openid-configuration" -TimeoutSec 2).issuer -eq $plan.issuer } catch { }
        if ($ready) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if (!$ready) { throw 'Owned Keycloak did not become ready.' }
} finally { $providerProcess.Dispose() }
Launch 'labServer' $node @((Join-Path $lab 'server.mjs')) $lab @{}
Wait-Ready { (Invoke-RestMethod "http://127.0.0.1:$($FirstPort + 4)/health" -TimeoutSec 2).ready } 'Protected resource'
$source = Join-Path $qa 'source'
[IO.File]::WriteAllText((Join-Path $source 'seed.txt'),"Independent delegated acceptance source`n")
& git -C $source init -b main *> (Join-Path $qa 'logs/source.log')
& git -C $source add seed.txt >> (Join-Path $qa 'logs/source.log')
& git -C $source -c user.name='ECorp QA' -c user.email='qa@ecorp.invalid' commit -m 'Initialize independent delegated fixture' >> (Join-Path $qa 'logs/source.log')
if ($LASTEXITCODE) { throw 'Independent source initialization failed.' }
$databasePassword = Secret
$passwordPath = Join-Path $qa 'credentials/postgres-password.txt'
$pgpassPath = Join-Path $qa 'credentials/pgpass.conf'
[IO.File]::WriteAllText($passwordPath,$databasePassword,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($pgpassPath,"127.0.0.1:${FirstPort}:*:delegated320:$databasePassword`n",[Text.UTF8Encoding]::new($false))
& (Join-Path $pg 'initdb.exe') -D (Join-Path $qa 'database') -U delegated320 --auth=scram-sha-256 --encoding=UTF8 --locale=C --pwfile=$passwordPath *> (Join-Path $qa 'logs/initdb.log')
if ($LASTEXITCODE) { throw 'Owned database initialization failed.' }
Launch 'postgres' (Join-Path $pg 'postgres.exe') @('-D',(Join-Path $qa 'database'),'-h','127.0.0.1','-p',"$FirstPort") $qa @{}
Wait-Ready { & (Join-Path $pg 'pg_isready.exe') -h 127.0.0.1 -p $FirstPort -U delegated320 *> $null; $LASTEXITCODE -eq 0 } 'PostgreSQL'
$env:PGPASSFILE = Join-Path $qa 'credentials/absent.pgpass'
$env:PGPASSWORD = 'invalid-owned-fixture-probe'
& (Join-Path $pg 'psql.exe') -Xw -h 127.0.0.1 -p $FirstPort -U delegated320 -d postgres -c 'SELECT 1' *> $null
if ($LASTEXITCODE -eq 0) { throw 'Incorrect PostgreSQL password accepted.' }
Remove-Item -LiteralPath Env:PGPASSWORD
$env:PGPASSFILE = $pgpassPath
& (Join-Path $pg 'createdb.exe') -w -h 127.0.0.1 -p $FirstPort -U delegated320 delegated320_app
if ($LASTEXITCODE) { throw 'Authenticated database creation failed.' }
Remove-Item -LiteralPath Env:PGPASSFILE
$state.database_authentication = @{method='scram-sha-256';wrong_password_rejected=$true;delivery='Private PGPASSFILE for fixture clients; scoped server environment delivery is reduced assurance.'}
$serverEnv = @{
    DATABASE_URL="postgres://delegated320:${databasePassword}@127.0.0.1:$FirstPort/delegated320_app"
    CRONY_BIND="127.0.0.1:$($FirstPort + 5)";CRONY_MODE='development';CRONY_RUNNER_CREDENTIAL_TTL_SECS='7200'
    CRONY_OBJECT_STORE_LOCAL_ROOT=(Join-Path $qa 'objects');CRONY_SECRET_MASTER_KEY_HEX=(Secret);CRONY_ARTIFACT_SIGNING_KEY_HEX=(Secret)
    CRONY_DELEGATED_PROVIDER='keycloak-test';CRONY_DELEGATED_ISSUER=$plan.issuer
    CRONY_DELEGATED_INTERACTIVE_CLIENT_ID='interactive';CRONY_DELEGATED_BROKER_CLIENT_ID='connector'
    CRONY_DELEGATED_BROKER_CLIENT_SECRET=$config.connectorSecret;CRONY_DELEGATED_INITIAL_SCOPES='openid'
    CRONY_DELEGATED_DOWNSTREAM_SCOPE='openid';CRONY_DELEGATED_DOWNSTREAM_AUDIENCE='flag-api'
    CRONY_DELEGATED_RESOURCE_URL=$plan.resource;CRONY_DELEGATED_BROWSER_BASE=$plan.server;CRONY_DELEGATED_UI_URL=$plan.web
    CRONY_DELEGATED_REDIRECT_URI="$($plan.server)/api/delegated/callback"
    CRONY_DELEGATED_EXPECTED_SHA256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($config.flag))).ToLowerInvariant()
    ECORP_FACTORY_WATCH='0'
}
Launch 'server' (Join-Path $qa 'binaries/crony-server.exe') @() $product $serverEnv
$serverEnv.Clear()
$databasePassword = $null
Wait-Ready { (Invoke-RestMethod "$($plan.server)/health" -TimeoutSec 2).status -eq 'ok' } 'Server'
$demo = Invoke-RestMethod "$($plan.server)/api/demo/bootstrap?seed_crew=false" -Method Post -ContentType 'application/json' -Body '{}'
Invoke-WebRequest "$($plan.server)/api/demo/delegated-link" -Method Post -ContentType 'application/json' -Body (@{
    corp_id=$demo.corp_id;actor_id=$demo.alice_actor_id;issuer=$plan.issuer;subject=$config.reader.subject
} | ConvertTo-Json) | Out-Null
$config = $null
$enrollment = Invoke-RestMethod "$($plan.server)/api/corps/$($demo.corp_id)/runners/enroll" -Method Post -ContentType 'application/json' -Body (@{
    actor_id=$demo.alice_actor_id;runner_id=$plan.runner_id;expires_in_seconds=900
} | ConvertTo-Json)
$enrollmentPath = Join-Path $qa 'credentials/enrollment.txt'
[IO.File]::WriteAllText($enrollmentPath,$enrollment.enrollment_token)
$enrollment = $null
$runnerEnv = @{
    CRONY_SERVER_WS="ws://127.0.0.1:$($FirstPort + 5)/ws/runner";CRONY_RUNNER_ID=$plan.runner_id;CRONY_CORP_ID=$demo.corp_id
    CRONY_RUNNER_CREDENTIAL_FILE=(Join-Path $qa 'credentials/runner.json');CRONY_RUNNER_ENROLLMENT_TOKEN_FILE=$enrollmentPath
    CRONY_RUNNER_WORKSPACE=(Join-Path $qa 'runner');CRONY_SOURCE_REPOSITORY=$source;CRONY_SOURCE_BASE_REF='HEAD'
    CRONY_FAKE_AGENT_SCRIPT=(Join-Path $product 'scripts/fake-agent.mjs');CRONY_CONNECTIONS_DIRECTORY=(Join-Path $qa 'connections')
    CRONY_CODEX_COMMAND=(Join-Path $qa 'disabled-codex.exe');CRONY_CLAUDE_COMMAND=(Join-Path $qa 'disabled-claude.exe')
    CRONY_OPENCODE_COMMAND=(Join-Path $qa 'disabled-opencode.exe');CRONY_GITHUB_COMMAND=(Join-Path $qa 'disabled-github.exe')
    CRONY_COPILOT_FIXTURE='true';CRONY_COPILOT_USE_LOGGED_IN_USER='false';ECORP_FACTORY_WATCH='0'
}
Launch 'runner' (Join-Path $qa 'binaries/crony-runner.exe') @() $product $runnerEnv
Launch 'web' $node @((Join-Path $product 'apps/web/node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',"$($FirstPort + 6)",'--strictPort') (Join-Path $product 'apps/web') @{VITE_CRONY_SERVER_HTTP=$plan.server;ECORP_FACTORY_WATCH='0'}
Wait-Ready { (Invoke-RestMethod "$($plan.server)/health" -TimeoutSec 2).runners -eq 1 } 'Runner'
Wait-Ready { (Invoke-WebRequest $plan.web -TimeoutSec 2).StatusCode -eq 200 } 'Web'
$state.demo = $demo
$state.ready_at = [DateTimeOffset]::UtcNow.ToString('o')
Save
& (Join-Path $PSScriptRoot 'verify_delegated_stack.ps1') -QaRoot $qa
