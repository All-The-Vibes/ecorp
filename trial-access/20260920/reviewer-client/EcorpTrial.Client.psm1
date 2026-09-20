Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Tenant = '16b3c013-d300-468d-ac64-7eda0820b6d3'
$script:Owner = 'b56dbcfe-2876-4ab9-9294-e3cebfae0490'
$script:Reviewer = '28b60676-5c28-4a32-ba00-476a6338ba45'
$script:Audience = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2'

function Stop-EcorpTrial([string]$Code) {
    $safe = [InvalidOperationException]::new('ECorp connection refused.')
    $safe.Data['EcorpTrialCode'] = $Code
    throw $safe
}

function Convert-EcorpJson([string]$Text, [string]$ErrorCode) {
    try {
        $document = [System.Text.Json.JsonDocument]::Parse($Text)
        try {
            if ($document.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { Stop-EcorpTrial $ErrorCode }
            $keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            foreach ($property in $document.RootElement.EnumerateObject()) {
                if (!$keys.Add($property.Name)) { Stop-EcorpTrial $ErrorCode }
            }
        } finally { $document.Dispose() }
        return ConvertFrom-Json -InputObject $Text -AsHashtable -Depth 32 -ErrorAction Stop
    } catch { Stop-EcorpTrial $ErrorCode }
}

function Read-EcorpTrialConfig([string]$Path) {
    try {
        $file = Get-Item -LiteralPath $Path -ErrorAction Stop
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 8192) { Stop-EcorpTrial 'CONFIG_INVALID' }
        return Convert-EcorpJson ([IO.File]::ReadAllText($file.FullName)) 'CONFIG_INVALID'
    } catch { Stop-EcorpTrial 'CONFIG_INVALID' }
}

function Assert-EcorpTrialConfig([Collections.IDictionary]$Config) {
    $allowed = @('schemaVersion','tenantId','ownerObjectId','reviewerObjectId','tunnelId','clusterId','webPort','apiPort')
    if ($Config.Count -ne $allowed.Count -or @($Config.Keys | Where-Object { $_ -cnotin $allowed }).Count) { Stop-EcorpTrial 'CONFIG_INVALID' }
    foreach ($name in @('tenantId','ownerObjectId','reviewerObjectId','tunnelId','clusterId')) { if ($Config[$name] -isnot [string]) { Stop-EcorpTrial 'CONFIG_INVALID' } }
    if ($Config.schemaVersion -isnot [long] -and $Config.schemaVersion -isnot [int]) { Stop-EcorpTrial 'CONFIG_INVALID' }
    if ($Config.schemaVersion -ne 1 -or $Config.tenantId -cne $script:Tenant -or $Config.ownerObjectId -cne $script:Owner -or $Config.reviewerObjectId -cne $script:Reviewer) { Stop-EcorpTrial 'CONFIG_INVALID' }
    if ($Config.tunnelId -isnot [string] -or $Config.tunnelId -cnotmatch '^[a-z0-9][a-z0-9-]{0,63}$' -or $Config.clusterId -isnot [string] -or $Config.clusterId -cnotmatch '^[a-z0-9]{1,16}$') { Stop-EcorpTrial 'CONFIG_INVALID' }
    if ($Config.webPort -isnot [long] -and $Config.webPort -isnot [int]) { Stop-EcorpTrial 'CONFIG_INVALID' }
    if ($Config.apiPort -isnot [long] -and $Config.apiPort -isnot [int]) { Stop-EcorpTrial 'CONFIG_INVALID' }
    if ($Config.webPort -notin @(5187,5188) -or $Config.apiPort -ne 8791) { Stop-EcorpTrial 'CONFIG_INVALID' }
}

function Assert-EcorpPortsFree([int[]]$Ports) {
    try { $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() }
    catch { Stop-EcorpTrial 'PORT_BUSY' }
    if (@($listeners | Where-Object { $_.Port -in $Ports }).Count) { Stop-EcorpTrial 'PORT_BUSY' }
}

function Resolve-AzureCliPython {
    $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles) | Where-Object { $_ }
    foreach ($root in $roots) {
        $install = Join-Path $root 'Microsoft SDKs\Azure\CLI2'
        $wrapper = Join-Path $install 'wbin\az.cmd'
        $python = Join-Path $install 'python.exe'
        if (!(Test-Path -LiteralPath $wrapper -PathType Leaf) -or !(Test-Path -LiteralPath $python -PathType Leaf)) { continue }
        try {
            $wrapperFile = Get-Item -LiteralPath $wrapper
            $pythonFile = Get-Item -LiteralPath $python
            if (($wrapperFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($pythonFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Stop-EcorpTrial 'AZURE_CLI_ENTRYPOINT' }
            $wrapperText = [IO.File]::ReadAllText($wrapper)
            if ($wrapperText -notmatch '(?m)^\s*"%~dp0\\\.\.\\python\.exe"\s+-IBm\s+azure\.cli\s+%\*\s*$') { Stop-EcorpTrial 'AZURE_CLI_ENTRYPOINT' }
            return $pythonFile.FullName
        } catch { Stop-EcorpTrial 'AZURE_CLI_ENTRYPOINT' }
    }
    Stop-EcorpTrial 'AZURE_CLI_MISSING'
}

function Add-EcorpCapturedOutput([Text.StringBuilder]$Target,[char[]]$Buffer,[int]$Count,[int]$Limit=131072) {
    if ($Count -lt 0 -or $Target.Length + $Count -gt $Limit) { Stop-EcorpTrial 'AZURE_CLI_FAILED' }
    [void]$Target.Append($Buffer,0,$Count)
}

function Invoke-AzureCliPrivate([string]$Python, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($Python)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    foreach ($argument in (@('-IBm','azure.cli') + $Arguments + @('--output','json','--only-show-errors'))) { $info.ArgumentList.Add($argument) }
    # Native auth stays with Azure CLI. Disable command-file logging and telemetry
    # for this child; do not copy or replace the user's credential/config files.
    $info.Environment['AZ_INSTALLER'] = 'MSI'
    $info.Environment['AZURE_LOGGING_ENABLE_LOG_FILE'] = 'false'
    $info.Environment['AZURE_CORE_ENABLE_LOG_FILE'] = 'false'
    $info.Environment['AZURE_CORE_COLLECT_TELEMETRY'] = 'false'
    $info.Environment['AZURE_CORE_ONLY_SHOW_ERRORS'] = 'true'
    $info.Environment['AZURE_EXTENSION_USE_DYNAMIC_INSTALL'] = 'no'
    [void]$info.Environment.Remove('AZ_LOGFILE_DIR')
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    $stdout = $null; $started = $false; $capture = [Text.StringBuilder]::new(); $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        [void]$process.Start(); $started = $true
        $outBuffer=[char[]]::new(4096); $errBuffer=[char[]]::new(4096); $errorCharacters=0
        $outTask=$process.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length); $errTask=$process.StandardError.ReadAsync($errBuffer,0,$errBuffer.Length)
        while (!$process.HasExited -or $outTask -or $errTask) {
            if ($clock.ElapsedMilliseconds -gt 90000) { Stop-EcorpTrial 'AZURE_CLI_FAILED' }
            if ($outTask -and $outTask.IsCompleted) {
                $count=$outTask.GetAwaiter().GetResult(); Add-EcorpCapturedOutput $capture $outBuffer $count
                [Array]::Clear($outBuffer); $outTask=if($count -gt 0){$process.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length)}else{$null}
            }
            if ($errTask -and $errTask.IsCompleted) {
                $count=$errTask.GetAwaiter().GetResult(); $errorCharacters+=$count
                if ($errorCharacters -gt 131072) { Stop-EcorpTrial 'AZURE_CLI_FAILED' }
                [Array]::Clear($errBuffer); $errTask=if($count -gt 0){$process.StandardError.ReadAsync($errBuffer,0,$errBuffer.Length)}else{$null}
            }
            Start-Sleep -Milliseconds 10
        }
        if ($process.ExitCode -ne 0) { Stop-EcorpTrial 'AZURE_CLI_FAILED' }
        $stdout=$capture.ToString()
        return Convert-EcorpJson $stdout 'AZURE_CLI_FAILED'
    } catch { Stop-EcorpTrial 'AZURE_CLI_FAILED' }
    finally {
        $stdout=$null; [void]$capture.Clear(); $clock.Stop()
        if ($started -and !$process.HasExited) { try { $process.Kill($true); [void]$process.WaitForExit(5000) } catch {} }
        $process.Dispose()
    }
}

function Get-EcorpAzureIdentity([string]$Python) {
    $account = Invoke-AzureCliPrivate $Python @('account','show','--query','{tenantId:tenantId,userType:user.type}')
    if ($account.tenantId -ine $script:Tenant) { Stop-EcorpTrial 'SIGN_IN_TENANT' }
    if ($account.userType -ine 'user') { Stop-EcorpTrial 'SIGN_IN_USER' }
    $user = Invoke-AzureCliPrivate $Python @('ad','signed-in-user','show','--query','{objectId:id}')
    return @{ tenantId=$account.tenantId; userType=$account.userType; objectId=$user.objectId }
}

function Assert-EcorpDevTunnel([string]$Path) {
    try {
        if (![IO.Path]::IsPathFullyQualified($Path)) { Stop-EcorpTrial 'CLIENT_SIGNATURE' }
        $file = Get-Item -LiteralPath $Path -ErrorAction Stop
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Name -ine 'devtunnel.exe' -or $file.VersionInfo.OriginalFilename -ine 'devtunnel.dll') { Stop-EcorpTrial 'CLIENT_SIGNATURE' }
        $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName -ErrorAction Stop
        if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { Stop-EcorpTrial 'CLIENT_SIGNATURE' }
        return @{ Path=$file.FullName; Sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
    } catch { Stop-EcorpTrial 'CLIENT_SIGNATURE' }
}

function Get-EcorpConnectMetadata([Uri]$Uri, [string]$AadToken) {
    $handler = [Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect = $false; $handler.UseCookies = $false
    $client = [Net.Http.HttpClient]::new($handler); $client.Timeout = [TimeSpan]::FromSeconds(30)
    $cancellation = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(30))
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Uri)
    $response = $null; $stream = $null; $memory = $null
    try {
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$AadToken)
        $request.Headers.CacheControl = [Net.Http.Headers.CacheControlHeaderValue]::new(); $request.Headers.CacheControl.NoStore = $true
        $response = $client.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancellation.Token).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200 -or ($response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -gt 1048576)) { Stop-EcorpTrial 'CONNECT_REQUEST_FAILED' }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult(); $memory = [IO.MemoryStream]::new()
        $buffer = [byte[]]::new(8192)
        while (($count = $stream.ReadAsync($buffer,0,$buffer.Length,$cancellation.Token).GetAwaiter().GetResult()) -gt 0) {
            if ($memory.Length + $count -gt 1048576) { Stop-EcorpTrial 'CONNECT_RESPONSE_INVALID' }
            $memory.Write($buffer,0,$count)
        }
        return Convert-EcorpJson ([Text.UTF8Encoding]::new($false,$true).GetString($memory.ToArray())) 'CONNECT_RESPONSE_INVALID'
    } catch { Stop-EcorpTrial 'CONNECT_REQUEST_FAILED' }
    finally { if ($stream) { $stream.Dispose() }; if ($memory) { $memory.Dispose() }; if ($response) { $response.Dispose() }; $request.Dispose(); $client.Dispose(); $cancellation.Dispose() }
}

function Start-EcorpNativeTunnel([Collections.IDictionary]$Client, [string]$Selector, [string]$ConnectToken) {
    $process = $null
    try {
        # Check again immediately before the token is handed to the child.
        $current = Assert-EcorpDevTunnel $Client.Path
        if ($current.Sha256 -cne $Client.Sha256) { Stop-EcorpTrial 'CLIENT_SIGNATURE' }
        $info = [Diagnostics.ProcessStartInfo]::new($Client.Path)
        $info.UseShellExecute = $false; $info.CreateNoWindow = $true
        $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
        $info.Environment.Clear()
        foreach ($name in @('SystemRoot','WINDIR','TEMP','TMP')) { $value = [Environment]::GetEnvironmentVariable($name); if ($value) { $info.Environment[$name] = $value } }
        foreach ($argument in @('connect',$Selector,'--access-token','-')) { $info.ArgumentList.Add($argument) }
        $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
        [void]$process.Start()
        # Neither token ever enters argv, environment, configuration or a file.
        $process.StandardInput.WriteLine($ConnectToken); $process.StandardInput.Flush(); $process.StandardInput.Close()
        return $process
    } catch {
        if ($process) { if (!$process.HasExited) { $process.Kill($true) }; $process.Dispose() }
        Stop-EcorpTrial 'TUNNEL_START_FAILED'
    }
}

function Wait-EcorpNativeTunnel([Diagnostics.Process]$Process, [int[]]$Ports) {
    # Discard both native streams in bounded buffers. Never forward arbitrary
    # CLI messages: they may contain credentials, URI queries or error bodies.
    $outBuffer = [char[]]::new(4096); $errBuffer = [char[]]::new(4096)
    $outTask = $Process.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length)
    $errTask = $Process.StandardError.ReadAsync($errBuffer,0,$errBuffer.Length)
    Write-Host 'Private connection client started. Keep this window open; Ctrl+C disconnects this client.'
    Write-Host "Configured local web: http://127.0.0.1:$($Ports[0]); API: http://127.0.0.1:$($Ports[1]). No browser is opened automatically."
    while (!$Process.HasExited -or $outTask -or $errTask) {
        if ($outTask -and $outTask.IsCompleted) { $count=$outTask.GetAwaiter().GetResult(); [Array]::Clear($outBuffer); $outTask=if($count -gt 0){$Process.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length)}else{$null} }
        if ($errTask -and $errTask.IsCompleted) { $count=$errTask.GetAwaiter().GetResult(); [Array]::Clear($errBuffer); $errTask=if($count -gt 0){$Process.StandardError.ReadAsync($errBuffer,0,$errBuffer.Length)}else{$null} }
        Start-Sleep -Milliseconds 100
    }
    if ($Process.ExitCode -ne 0) { Stop-EcorpTrial 'TUNNEL_EXITED' }
    Write-Host 'Private connection ended.'
}

function Invoke-EcorpTrialConnectCore([Collections.IDictionary]$Config, [string]$DevTunnelPath, [hashtable]$Operations) {
    # Only the public entrypoint constructs native operations. Tests invoke this
    # private function with a complete mock set; there is no CLI/env mock switch.
    $aadToken=$null; $connectToken=$null; $metadata=$null; $process=$null
    try {
        Assert-EcorpTrialConfig $Config
        foreach ($operation in @('CheckPorts','VerifyClient','GetIdentity','GetAadToken','GetTunnel','StartTunnel','WaitTunnel','StopTunnel')) {
            if (!$Operations.ContainsKey($operation) -or $Operations[$operation] -isnot [scriptblock]) { Stop-EcorpTrial 'CONFIG_INVALID' }
        }
        $ports=@([int]$Config.webPort,[int]$Config.apiPort)
        & $Operations.CheckPorts $ports
        $client=& $Operations.VerifyClient $DevTunnelPath
        $identity=& $Operations.GetIdentity $Operations['Context']
        if ($identity -isnot [Collections.IDictionary] -or $identity['tenantId'] -isnot [string] -or $identity['userType'] -isnot [string] -or $identity['objectId'] -isnot [string]) { Stop-EcorpTrial 'SIGN_IN_USER' }
        if ($identity.tenantId -ine $script:Tenant) { Stop-EcorpTrial 'SIGN_IN_TENANT' }
        if ($identity.userType -ine 'user') { Stop-EcorpTrial 'SIGN_IN_USER' }
        if ($identity.objectId -inotIn @($script:Owner,$script:Reviewer)) { Stop-EcorpTrial 'USER_NOT_ALLOWED' }
        $aadToken=& $Operations.GetAadToken $Operations['Context']
        if ($aadToken -isnot [string] -or [string]::IsNullOrWhiteSpace($aadToken) -or $aadToken.Length -gt 131072 -or $aadToken.Contains("`r") -or $aadToken.Contains("`n")) { Stop-EcorpTrial 'AAD_TOKEN_INVALID' }
        $uri=[Uri]::new('https://'+$Config.clusterId+'.rel.tunnels.api.visualstudio.com/tunnels/'+$Config.tunnelId+'?tokenScopes=connect&includePorts=true&api-version=2023-09-27-preview')
        $metadata=& $Operations.GetTunnel $uri $aadToken
        $aadToken=$null
        if ($metadata -isnot [Collections.IDictionary] -or $metadata['tunnelId'] -cne $Config.tunnelId -or $metadata['clusterId'] -cne $Config.clusterId -or $metadata['accessTokens'] -isnot [Collections.IDictionary]) { Stop-EcorpTrial 'CONNECT_RESPONSE_INVALID' }
        if ($metadata['ports'] -isnot [array] -or $metadata['ports'].Count -ne 2) { Stop-EcorpTrial 'CONNECT_RESPONSE_INVALID' }
        $observedPorts=@(foreach ($port in $metadata['ports']) {
            if ($port -isnot [Collections.IDictionary] -or ($port['portNumber'] -isnot [int] -and $port['portNumber'] -isnot [long])) { Stop-EcorpTrial 'CONNECT_RESPONSE_INVALID' }
            $port['portNumber']
        })
        if (@($observedPorts | Sort-Object -Unique).Count -ne 2 -or @($observedPorts | Where-Object { $_ -notin $ports }).Count) { Stop-EcorpTrial 'CONNECT_RESPONSE_INVALID' }
        if ($metadata.accessTokens.Count -ne 1 -or !$metadata.accessTokens.Contains('connect')) { Stop-EcorpTrial 'CONNECT_TOKEN_INVALID' }
        $connectToken=$metadata.accessTokens['connect']
        if ($connectToken -isnot [string] -or [string]::IsNullOrWhiteSpace($connectToken) -or $connectToken.Length -gt 131072 -or $connectToken.Contains("`r") -or $connectToken.Contains("`n")) { Stop-EcorpTrial 'CONNECT_TOKEN_INVALID' }
        & $Operations.CheckPorts $ports
        $process=& $Operations.StartTunnel $client ($Config.tunnelId+'.'+$Config.clusterId) $connectToken
        $connectToken=$null; $metadata.accessTokens.Clear(); $metadata=$null
        & $Operations.WaitTunnel $process $ports
    } catch {
        if ($_.Exception.Data['EcorpTrialCode']) { throw }
        Stop-EcorpTrial 'NATIVE_OPERATION_FAILED'
    } finally {
        $aadToken=$null; $connectToken=$null
        if ($metadata -is [Collections.IDictionary] -and $metadata['accessTokens'] -is [Collections.IDictionary]) { $metadata['accessTokens'].Clear() }
        if ($process) { & $Operations.StopTunnel $process }
    }
}

function Invoke-EcorpTrialConnect {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ConfigPath,[Parameter(Mandatory)][string]$DevTunnelPath)
    $config=Read-EcorpTrialConfig $ConfigPath
    $python=Resolve-AzureCliPython
    $operations=@{
        Context=$python
        CheckPorts={param($ports) Assert-EcorpPortsFree $ports}
        VerifyClient={param($path) Assert-EcorpDevTunnel $path}
        GetIdentity={param($context) Get-EcorpAzureIdentity $context}
        GetAadToken={param($context) (Invoke-AzureCliPrivate $context @('account','get-access-token','--resource',$script:Audience,'--tenant',$script:Tenant)).accessToken}
        GetTunnel={param($uri,$token) Get-EcorpConnectMetadata $uri $token}
        StartTunnel={param($client,$selector,$token) Start-EcorpNativeTunnel $client $selector $token}
        WaitTunnel={param($process,$ports) Wait-EcorpNativeTunnel $process $ports}
        StopTunnel={param($process) try { if (!$process.HasExited) { $process.Kill($true); $process.WaitForExit() } } finally { $process.Dispose() }}
    }
    Invoke-EcorpTrialConnectCore $config $DevTunnelPath $operations
}
Export-ModuleMember -Function Invoke-EcorpTrialConnect
