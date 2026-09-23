from pathlib import Path

base = Path(__file__).resolve().parent
source = (base / "run-pr255-native-r1.ps1").read_bytes().decode()
old = """    Run-Checked $Name $pwsh (@('-NoProfile','-NonInteractive','-File',(Join-Path $DriverDirectory 'qa-host.ps1'),'-Action',$Action)+$Extra)"""
new = """    # Invoke the trusted host script in this process so a long-lived PostgreSQL
    # child cannot retain the intermediate pwsh capture pipe after pwsh exits.
    # Environment mutations are confined to this action and restored before any
    # browser or other child is launched. No secret values enter the receipt.
    $log=Join-Path $EvidenceRoot "$Label-$Name.log"
    if(Test-Path -LiteralPath $log){throw 'Never overwrite an earlier validation log.'}
    $savedEnvironment=[Environment]::GetEnvironmentVariables('Process')
    $savedLocation=(Get-Location).Path
    $code=0
    $hostParameters=@{Action=$Action}
    for($i=0;$i -lt $Extra.Count;$i++){
        switch($Extra[$i]){
            '-Issue' {$hostParameters.Issue=[int]$Extra[++$i]}
            '-DryRun' {$hostParameters.DryRun=$true}
            default {throw 'Unexpected private host argument.'}
        }
    }
    try{
        $global:LASTEXITCODE=0
        & (Join-Path $DriverDirectory 'qa-host.ps1') @hostParameters *> $log
        $code=$LASTEXITCODE
    }catch{
        $code=1
        [regex]::Replace($_.Exception.Message,'\\bpostgres(?:ql)?://\\S+','[database URL withheld]')|Add-Content -LiteralPath $log
    }finally{
        foreach($key in @([Environment]::GetEnvironmentVariables('Process').Keys)){
            if(!$savedEnvironment.Contains($key)){[Environment]::SetEnvironmentVariable($key,$null,'Process')}
        }
        foreach($key in $savedEnvironment.Keys){[Environment]::SetEnvironmentVariable($key,$savedEnvironment[$key],'Process')}
        Set-Location -LiteralPath $savedLocation
    }
    $record.checks+=@{name=$Name;exit_code=$code;log=$log;sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()}
    Save-Receipt
    Write-Output "$Name exit=$code"
    if($code){throw "Native lane $Name failed; preserve its IDs, resources and evidence."}"""
assert source.count(old) == 1
source = source.replace(old, new)
source = source.replace("issue-161-pr255-20260922-r1", "issue-161-pr255-20260922-r4")
source = source.replace("'pr255-native-r1-drivers'", "'pr255-native-r3-drivers'")
source = source.replace("[string]$Label = 'pr255-native-r1'", "[string]$Label = 'pr255-native-r4'")
destination = base / "run-pr255-native-r4.ps1"
with destination.open("xb") as handle:
    handle.write(source.encode())
print(destination)
