#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][string]$DevTunnelPath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    Import-Module (Join-Path $PSScriptRoot 'EcorpTrial.Client.psm1') -Force -ErrorAction Stop
    Invoke-EcorpTrialConnect -ConfigPath $ConfigPath -DevTunnelPath $DevTunnelPath
} catch {
    $safeCode = $_.Exception.Data['EcorpTrialCode']
    if ($safeCode -notin @('CONFIG_INVALID','PORT_BUSY','AZURE_CLI_MISSING','AZURE_CLI_ENTRYPOINT','AZURE_CLI_FAILED','SIGN_IN_TENANT','SIGN_IN_USER','USER_NOT_ALLOWED','CLIENT_SIGNATURE','AAD_TOKEN_INVALID','CONNECT_REQUEST_FAILED','CONNECT_RESPONSE_INVALID','CONNECT_TOKEN_INVALID','TUNNEL_START_FAILED','TUNNEL_EXITED','NATIVE_OPERATION_FAILED')) {
        $safeCode = 'NATIVE_OPERATION_FAILED'
    }
    # Never print the exception, request/response, native stdout/stderr or token.
    Write-Host "ECorp connection stopped: $safeCode. See REVIEWER.md; no token was logged."
    exit 1
}
