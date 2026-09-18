#requires -Version 7.4
[CmdletBinding()]
param(
    [switch]$Restart,
    [switch]$PrepareProvider,
    [string]$LabPath = $env:ECORP_DELEGATED_LAB,
    [string]$DatabaseComposePath
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$lab = if ($LabPath) { (Resolve-Path $LabPath).Path } else { Join-Path $PSScriptRoot 'fixtures\delegated-keycloak' }
if (!$DatabaseComposePath) {
    $existing = Join-Path $root 'output\obo-postgres.compose.yml'
    $DatabaseComposePath = if (Test-Path $existing) { $existing } else { Join-Path $PSScriptRoot 'fixtures\delegated-postgres.compose.yml' }
}
$private = Join-Path $root 'output\delegated-private'
New-Item -ItemType Directory -Force $private | Out-Null
$account = (& whoami).Trim()
& icacls $private /inheritance:r /grant:r "${account}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE) { throw 'Private directory ACL failed' }
# Read only into this trusted process. Never echo config, identity credentials or tokens.
$config = Get-Content -Raw (Join-Path $lab '.private\config.json') | ConvertFrom-Json
if ($PrepareProvider) {
    $realmPath = Join-Path $lab '.private\realm.json'
    $realm = Get-Content -Raw $realmPath | ConvertFrom-Json
    $interactive = $realm.clients | Where-Object clientId -eq 'interactive'
    $callback = 'http://127.0.0.1:8791/api/delegated/callback'
    if ($callback -notin $interactive.redirectUris) {
        Copy-Item $realmPath (Join-Path $private 'realm-before-285.json') -ErrorAction Stop
        $interactive.redirectUris = @($interactive.redirectUris) + @($callback)
        $realm | ConvertTo-Json -Depth 40 | Set-Content $realmPath
        Push-Location $lab
        try {
            & docker compose stop keycloak | Out-Null
            if ($LASTEXITCODE) { throw 'Owned fixture provider stop failed' }
            & docker compose run --rm --no-deps keycloak import --file=/opt/keycloak/data/import/realm.json --override=true *> (Join-Path $private 'provider-import.log')
            if ($LASTEXITCODE) { throw 'Owned fixture provider import failed; inspect private log' }
            & docker compose up -d keycloak | Out-Null
            if ($LASTEXITCODE) { throw 'Owned fixture provider restart failed' }
        } finally { Pop-Location }
    }
}
$ready = $false
for ($attempt=0; $attempt -lt 90; $attempt++) {
    try {
        $null = Invoke-RestMethod "$($config.issuer)/.well-known/openid-configuration" -TimeoutSec 2
        $ready=$true; break
    } catch { Start-Sleep -Seconds 1 }
}
if (!$ready) { throw 'Local fixture provider not ready' }
try {
$env:CRONY_DELEGATED_PROVIDER='keycloak-test'
$env:CRONY_DELEGATED_ISSUER=$config.issuer
$env:CRONY_DELEGATED_INTERACTIVE_CLIENT_ID='interactive'
$env:CRONY_DELEGATED_BROKER_CLIENT_ID='connector'
$env:CRONY_DELEGATED_BROKER_CLIENT_SECRET=$config.connectorSecret
$env:CRONY_DELEGATED_REDIRECT_URI='http://127.0.0.1:8791/api/delegated/callback'
$env:CRONY_DELEGATED_INITIAL_SCOPES='openid'
$env:CRONY_DELEGATED_DOWNSTREAM_SCOPE='openid'
$env:CRONY_DELEGATED_DOWNSTREAM_AUDIENCE='flag-api'
$env:CRONY_DELEGATED_RESOURCE_URL='http://127.0.0.1:18883/flag'
$env:CRONY_DELEGATED_EXPECTED_SHA256=[Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($config.flag))).ToLowerInvariant()
$env:CRONY_DELEGATED_BROWSER_BASE='http://127.0.0.1:8791'
$env:CRONY_DELEGATED_UI_URL='http://127.0.0.1:5187'
$env:PATH="$(Join-Path $root 'output\tool-bin');$env:PATH"
# A development actor link is explicit fixture provisioning, never callback first-login binding.
$link=@{actor_id='00000000-0000-4000-8000-000000000011';issuer=$config.issuer;subject=$config.reader.subject}
$secretKeyPath=Join-Path $private 'master-key.txt'
if (!(Test-Path $secretKeyPath)) {
    [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() |
        Set-Content $secretKeyPath -NoNewline
}
$env:CRONY_SECRET_MASTER_KEY_HEX=Get-Content -Raw $secretKeyPath
$compose = (& docker compose -f $DatabaseComposePath config --format json | ConvertFrom-Json)
if ($LASTEXITCODE) { throw 'Delegated database configuration unavailable' }
$db = $compose.services.postgres.environment
$env:DATABASE_URL="postgres://$([uri]::EscapeDataString($db.POSTGRES_USER)):$([uri]::EscapeDataString($db.POSTGRES_PASSWORD))@127.0.0.1:54330/$($db.POSTGRES_DB)"
    & (Join-Path $PSScriptRoot 'start_local.ps1') -SkipInstall -SkipBuild -SkipFactoryController -Restart:$Restart -ServerPort 8791 -WebPort 5187
    $null=Invoke-RestMethod 'http://127.0.0.1:8791/api/demo/oidc-link' -Method Post -ContentType 'application/json' -Body ($link|ConvertTo-Json)
    Write-Output 'Delegated fixture configured. Human credentials remain in the existing lab .private\config.json.'
} finally {
    Get-ChildItem Env: | Where-Object Name -like 'CRONY_DELEGATED_*' | ForEach-Object { Remove-Item "Env:$($_.Name)" }
    Remove-Item Env:CRONY_SECRET_MASTER_KEY_HEX,Env:DATABASE_URL -ErrorAction SilentlyContinue
}
