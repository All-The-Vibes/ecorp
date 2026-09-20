#requires -Version 7.4
$ErrorActionPreference='Stop'
$clientModule=Import-Module (Join-Path $PSScriptRoot 'EcorpTrial.Client.psm1') -Force -PassThru
$results=[Collections.Generic.List[object]]::new()
function Assert-Check([bool]$Condition,[string]$Label) { if(!$Condition){throw $Label} }
function New-Configuration {
    return @{schemaVersion=1;tenantId='16b3c013-d300-468d-ac64-7eda0820b6d3';ownerObjectId='b56dbcfe-2876-4ab9-9294-e3cebfae0490';reviewerObjectId='28b60676-5c28-4a32-ba00-476a6338ba45';tunnelId='mock-reviewed-tunnel';clusterId='use2';webPort=5188;apiPort=8791}
}
function Invoke-MockCase([string]$Name,[scriptblock]$Change,[string]$ExpectedCode='') {
    $config=New-Configuration
    $state=@{identity=@{tenantId=$config.tenantId;userType='user';objectId=$config.reviewerObjectId};aad='opaque-mock-aad';metadata=@{tunnelId=$config.tunnelId;clusterId=$config.clusterId;ports=@(@{portNumber=5188},@{portNumber=8791});accessTokens=@{connect='opaque-mock-connect'}};checks=0;aadCalls=0;requests=0;starts=0;stops=0;waits=0;failPortAt=0;badClient=$false;requestError=$false;waitError=$false;selector=$null;receivedConnect=$null;url=$null;receivedAad=$null}
    & $Change $config $state
    $operations=@{
        CheckPorts={param($ports) $state.checks++;if($state.failPortAt -eq $state.checks){$e=[Exception]::new('Refused.');$e.Data['EcorpTrialCode']='PORT_BUSY';throw $e}}.GetNewClosure()
        VerifyClient={param($path) if($state.badClient){$e=[Exception]::new('Refused.');$e.Data['EcorpTrialCode']='CLIENT_SIGNATURE';throw $e};return @{Path=$path;Sha256='mock-hash'}}.GetNewClosure()
        GetIdentity={param($context) return $state.identity}.GetNewClosure()
        GetAadToken={param($context) $state.aadCalls++;return $state.aad}.GetNewClosure()
        GetTunnel={param($uri,$token) $state.requests++;$state.url=$uri.AbsoluteUri;$state.receivedAad=$token;if($state.requestError){throw 'opaque-mock-aad forbidden body opaque-mock-connect'};return $state.metadata}.GetNewClosure()
        StartTunnel={param($client,$selector,$token) $state.starts++;$state.selector=$selector;$state.receivedConnect=$token;return @{mockProcess=$true}}.GetNewClosure()
        WaitTunnel={param($process,$ports) $state.waits++;if($state.waitError){throw 'opaque-mock-connect child error'}}.GetNewClosure()
        StopTunnel={param($process) $state.stops++}.GetNewClosure()
    }
    $observed='';$output=@()
    try { $output=@(& $clientModule {param($c,$o) Invoke-EcorpTrialConnectCore $c 'C:\mock\devtunnel.exe' $o} $config $operations *>&1) }
    catch { $observed=[string]$_.Exception.Data['EcorpTrialCode'];Assert-Check (!$_.Exception.Message.Contains('opaque-mock')) 'Raw token-bearing failure escaped' }
    Assert-Check ($observed -eq $ExpectedCode) ('Unexpected refusal in '+$Name+': '+$observed)
    Assert-Check (!(($output|Out-String) -match 'opaque-mock')) 'Token reached output'
    if ($ExpectedCode -in @('CONFIG_INVALID','CLIENT_SIGNATURE','SIGN_IN_TENANT','SIGN_IN_USER','USER_NOT_ALLOWED') -or $state.failPortAt -eq 1) {
        Assert-Check ($state.aadCalls -eq 0 -and $state.requests -eq 0) 'Rejected preflight reached token/service calls'
    }
    if ($state.waitError) { Assert-Check ($state.starts -eq 1 -and $state.stops -eq 1) 'Owned mock child not stopped after failure' }
    if ($state.requestError) { Assert-Check ($state.starts -eq 0) 'Request failure started a child' }
    if(!$ExpectedCode){
        Assert-Check ($state.requests -eq 1 -and $state.aadCalls -eq 1 -and $state.starts -eq 1 -and $state.stops -eq 1 -and $state.waits -eq 1) 'Incorrect success sequence'
        Assert-Check ($state.url -eq 'https://use2.rel.tunnels.api.visualstudio.com/tunnels/mock-reviewed-tunnel?tokenScopes=connect&includePorts=true&api-version=2023-09-27-preview') 'URL broadened'
        Assert-Check ($state.selector -eq 'mock-reviewed-tunnel.use2' -and $state.receivedConnect -eq 'opaque-mock-connect' -and $state.receivedAad -eq 'opaque-mock-aad') 'Token/selector mixed'
    }elseif($ExpectedCode -ne 'NATIVE_OPERATION_FAILED') {Assert-Check ($state.starts -eq 0) 'Refusal started tunnel'}
    $results.Add(@{name=$Name;passed=$true;expected_code=$ExpectedCode;mock_requests=$state.requests;mock_starts=$state.starts})
}

foreach($file in @('Connect-EcorpTrial.ps1','EcorpTrial.Client.psm1','Test-ReviewerClient.ps1')){
    $tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$tokens,[ref]$errors)
    Assert-Check ($errors.Count -eq 0) ('Parse failure: '+$file)
}
Assert-Check ($clientModule.ExportedFunctions.Keys.Count -eq 1 -and $clientModule.ExportedFunctions.ContainsKey('Invoke-EcorpTrialConnect')) 'Mock seam exported'
Invoke-MockCase 'reviewer, web5188' {param($c,$s)}
Invoke-MockCase 'owner, web5187' {param($c,$s) $s.identity.objectId=$c.ownerObjectId;$c.webPort=5187;$s.metadata.ports[0].portNumber=5187}
Invoke-MockCase 'wrong configured tenant' {param($c,$s) $c.tenantId='00000000-0000-0000-0000-000000000000'} 'CONFIG_INVALID'
Invoke-MockCase 'extra owner' {param($c,$s) $c.ownerObjectId=@($c.ownerObjectId,$c.reviewerObjectId)} 'CONFIG_INVALID'
Invoke-MockCase 'swapped reviewer' {param($c,$s) $c.reviewerObjectId=$c.ownerObjectId} 'CONFIG_INVALID'
Invoke-MockCase 'arbitrary API URL' {param($c,$s) $c.apiUrl='https://elsewhere.invalid'} 'CONFIG_INVALID'
Invoke-MockCase 'cached token config' {param($c,$s) $c.accessToken='opaque-mock-connect'} 'CONFIG_INVALID'
Invoke-MockCase 'cluster host injection' {param($c,$s) $c.clusterId='use2.evil.invalid'} 'CONFIG_INVALID'
Invoke-MockCase 'tunnel path injection' {param($c,$s) $c.tunnelId='../other'} 'CONFIG_INVALID'
Invoke-MockCase 'unsupported web port' {param($c,$s) $c.webPort=5189} 'CONFIG_INVALID'
Invoke-MockCase 'changed API port' {param($c,$s) $c.apiPort=8792} 'CONFIG_INVALID'
Invoke-MockCase 'textual port' {param($c,$s) $c.webPort='5188'} 'CONFIG_INVALID'
Invoke-MockCase 'textual version' {param($c,$s) $c.schemaVersion='1'} 'CONFIG_INVALID'
Invoke-MockCase 'occupied port before authentication' {param($c,$s) $s.failPortAt=1} 'PORT_BUSY'
Invoke-MockCase 'occupied port before child start' {param($c,$s) $s.failPortAt=2} 'PORT_BUSY'
Invoke-MockCase 'untrusted client' {param($c,$s) $s.badClient=$true} 'CLIENT_SIGNATURE'
Invoke-MockCase 'wrong current tenant' {param($c,$s) $s.identity.tenantId='00000000-0000-0000-0000-000000000000'} 'SIGN_IN_TENANT'
Invoke-MockCase 'service principal' {param($c,$s) $s.identity.userType='servicePrincipal'} 'SIGN_IN_USER'
Invoke-MockCase 'unlisted signed-in user' {param($c,$s) $s.identity.objectId='00000000-0000-0000-0000-000000000000'} 'USER_NOT_ALLOWED'
Invoke-MockCase 'empty AAD token' {param($c,$s) $s.aad=''} 'AAD_TOKEN_INVALID'
Invoke-MockCase 'multiline AAD token' {param($c,$s) $s.aad="opaque`nmore"} 'AAD_TOKEN_INVALID'
Invoke-MockCase 'wrong response tunnel' {param($c,$s) $s.metadata.tunnelId='other'} 'CONNECT_RESPONSE_INVALID'
Invoke-MockCase 'wrong response cluster' {param($c,$s) $s.metadata.clusterId='euw'} 'CONNECT_RESPONSE_INVALID'
Invoke-MockCase 'missing response ports' {param($c,$s) $s.metadata.Remove('ports')} 'CONNECT_RESPONSE_INVALID'
Invoke-MockCase 'extra remote port' {param($c,$s) $s.metadata.ports+=@{portNumber=22}} 'CONNECT_RESPONSE_INVALID'
Invoke-MockCase 'wrong remote port' {param($c,$s) $s.metadata.ports[0].portNumber=5187} 'CONNECT_RESPONSE_INVALID'
Invoke-MockCase 'duplicate remote port' {param($c,$s) $s.metadata.ports[0].portNumber=8791} 'CONNECT_RESPONSE_INVALID'
Invoke-MockCase 'missing connect token' {param($c,$s) $s.metadata.accessTokens=@{}} 'CONNECT_TOKEN_INVALID'
Invoke-MockCase 'host token fallback refused' {param($c,$s) $s.metadata.accessTokens=@{host='opaque-mock-host'}} 'CONNECT_TOKEN_INVALID'
Invoke-MockCase 'management token alongside connect refused' {param($c,$s) $s.metadata.accessTokens.manage='opaque-mock-manage'} 'CONNECT_TOKEN_INVALID'
Invoke-MockCase 'empty connect token' {param($c,$s) $s.metadata.accessTokens.connect=''} 'CONNECT_TOKEN_INVALID'
Invoke-MockCase 'multiline connect token' {param($c,$s) $s.metadata.accessTokens.connect="opaque`nmore"} 'CONNECT_TOKEN_INVALID'
Invoke-MockCase 'raw request error is suppressed' {param($c,$s) $s.requestError=$true} 'NATIVE_OPERATION_FAILED'
Invoke-MockCase 'raw child error is suppressed and owned child stopped' {param($c,$s) $s.waitError=$true} 'NATIVE_OPERATION_FAILED'

$badJson='{"schemaVersion":1,"schemaVersion":1}'
$duplicateRefused=$false
try{& $clientModule {param($json) Convert-EcorpJson $json 'CONFIG_INVALID'} $badJson|Out-Null}catch{$duplicateRefused=$_.Exception.Data['EcorpTrialCode'] -eq 'CONFIG_INVALID'}
Assert-Check $duplicateRefused 'Duplicate JSON key accepted'
$results.Add(@{name='duplicate JSON key refused';passed=$true})
& $clientModule {
    $capture=[Text.StringBuilder]::new()
    Add-EcorpCapturedOutput $capture ([char[]]'abcd') 4 4
    if($capture.Length -ne 4){throw 'Bounded capture lost content'}
    $refused=$false
    try{Add-EcorpCapturedOutput $capture ([char[]]'x') 1 4}catch{$refused=$_.Exception.Data['EcorpTrialCode'] -eq 'AZURE_CLI_FAILED'}
    if(!$refused -or $capture.Length -ne 4){throw 'Bounded capture overflow accepted'}
}
$results.Add(@{name='native output capture accepts exact bound and rejects overflow';passed=$true})
$result=@{completed_at=[DateTime]::UtcNow.ToString('o');passed=$true;tests=$results.Count;cases=$results;scope='PowerShell parser and fully mocked external boundaries only';actual_azure_cli_calls=0;actual_http_requests=0;actual_tunnel_connections=0;actual_tokens_used=0}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'MOCK_RESULTS.json'),($result|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
Write-Host "$($results.Count) mock cases passed; no Azure, service or tunnel calls."
