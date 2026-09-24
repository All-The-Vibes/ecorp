#requires -Version 7.4
[CmdletBinding()]
param(
    [string]$Repository = 'C:\Users\shyamsridhar\code\ecorp-pr255-completion-20260922',
    [string]$Target = 'C:\Users\shyamsridhar\code\ecorp-pr362-completion-20260922\target-validation',
    [string]$QaRoot = 'C:\Users\shyamsridhar\code\qa\issue-161-pr255-20260922-r4',
    [string]$PgBin = 'C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin',
    [string]$ValidationPath = (Join-Path $PSScriptRoot 'pr255-validation-r1/validation.json'),
    [string]$DriverDirectory = (Join-Path $PSScriptRoot 'pr255-native-r3-drivers'),
    [string]$EvidenceRoot = $PSScriptRoot,
    [string]$EvidencePacket = '',
    [ValidatePattern('^[a-z0-9-]+$')][string]$Label = 'pr255-native-r4'
)
$ErrorActionPreference='Stop'
$Repository=(Resolve-Path -LiteralPath $Repository).Path
$EvidenceRoot=(Resolve-Path -LiteralPath $EvidenceRoot).Path
$DriverDirectory=(Resolve-Path -LiteralPath $DriverDirectory).Path
$receiptPath=Join-Path $EvidenceRoot "$Label-lifecycle.json"
$proof=Get-Content -LiteralPath $ValidationPath -Raw|ConvertFrom-Json
$testedTree=if($proof.staged_tree){[string]$proof.staged_tree}else{[string]$proof.tested_staged_tree}
$currentTree=(& git -C $Repository write-tree).Trim()
$expectedChecks=@('migrations','documentation','rust-format','rust-clippy','rust-workspace','node-unit','steward','web-build','web-lint')
if($proof.status -ne 'passed' -or $testedTree -notmatch '^[a-f0-9]{40}$' -or @($proof.checks).Count -ne 9 -or @($proof.checks|Where-Object exit_code -ne 0).Count){throw 'Nine passing source-bound validation gates are required.'}
if(@(Compare-Object $expectedChecks @($proof.checks.name)).Count){throw 'Validation gate names do not match the complete required lane.'}
foreach($check in $proof.checks){
    $log=if([IO.Path]::IsPathRooted($check.log)){$check.log}else{Join-Path (Split-Path $ValidationPath -Parent) $check.log}
    if(!(Test-Path -LiteralPath $log) -or (Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant() -cne $check.sha256){throw 'Validation log hash mismatch.'}
}
if((& git -C $Repository diff --name-only)){throw 'Unstaged product changes must be validated before acceptance.'}
if($currentTree -cne $testedTree){
    if($EvidencePacket -notmatch '^docs/evidence/pr-255-completion-[a-z0-9-]+$'){throw 'Replay on a published tree requires the explicit new evidence packet.'}
    $differences=@(& git -C $Repository diff --name-only $testedTree $currentTree)
    if($LASTEXITCODE -or @($differences|Where-Object {!$_.StartsWith("$EvidencePacket/",[StringComparison]::Ordinal)}).Count){throw 'Candidate product source differs from the validated tree.'}
}
if((Test-Path -LiteralPath $QaRoot) -or (Test-Path -LiteralPath $receiptPath)){throw 'Preserve existing fixtures and receipts; supply unused paths.'}
$qa=[IO.Path]::GetFullPath($QaRoot)
if(!(Split-Path $qa -Leaf).StartsWith('issue-161-') -or (Split-Path (Split-Path $qa -Parent) -Leaf) -ne 'qa' -or $qa.StartsWith($Repository+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'QA must be a separate explicitly owned issue-161 directory.'}
foreach($port in @(55461,18971,18972,15471)){
    if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq $port).Count){throw "Required fixture port $port is occupied; no adoption is permitted."}
}
foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)){
    if($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or $name -in @('DATABASE_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','COPILOT_GITHUB_TOKEN','NODE_OPTIONS')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
}
$env:PATH='C:\Users\shyamsridhar\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64;'+$PgBin+';'+$env:PATH
$env:CARGO_TARGET_DIR=$Target
$env:CARGO_BUILD_JOBS='2'
$env:RUST_TEST_THREADS='1'
$env:ECORP_ISSUE161_QA=$qa
$env:ECORP_ISSUE161_REPOSITORY=$Repository
$env:ECORP_ISSUE161_PG_BIN=$PgBin
$env:ECORP_QA_PWSH=(Get-Command pwsh.exe).Source
$env:CRONY_PLAYWRIGHT_MODULE='C:\Users\shyamsridhar\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
$pwsh=$env:ECORP_QA_PWSH
$python='C:\Users\shyamsridhar\AppData\Local\Programs\Python\Python312\python.exe'
$record=[ordered]@{
    pr=255;status='running';started_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    tested_staged_tree=$testedTree;candidate_staged_tree=$currentTree
    head=(& git -C $Repository rev-parse HEAD).Trim();qa_root=$qa
    source_scope='Fresh native source build; same-host development identity; deterministic providers; no physical multi-host or production-provider claim.'
    credential_assurance='Disposable SCRAM PostgreSQL credential in an ACL-restricted fixture; server and SQLx receive it through environment-only reduced-assurance delivery. Browser/runner child environments exclude it.'
    toolchain=@{node=(& node --version).Trim();rust=(& rustc --version).Trim();node_repository_pin='24.19.0'}
    checks=@();binaries=@();drivers=@()
}
function Save-Receipt {$record|ConvertTo-Json -Depth 30|Set-Content -LiteralPath $receiptPath -Encoding utf8}
function Run-Checked([string]$Name,[string]$Program,[string[]]$Arguments){
    $log=Join-Path $EvidenceRoot "$Label-$Name.log"
    if(Test-Path -LiteralPath $log){throw 'Never overwrite an earlier validation log.'}
    & $Program @Arguments *> $log
    $code=$LASTEXITCODE
    $record.checks+=@{name=$Name;exit_code=$code;log=$log;sha256=(Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()}
    Save-Receipt
    Write-Output "$Name exit=$code"
    if($code){throw "Native lane $Name failed; preserve its IDs, resources and evidence."}
}
function Host-Action([string]$Name,[string]$Action,[string[]]$Extra=@()){
    # Invoke the trusted host script in this process so a long-lived PostgreSQL
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
        [regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')|Add-Content -LiteralPath $log
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
    if($code){throw "Native lane $Name failed; preserve its IDs, resources and evidence."}
}
function Node-Action([string]$Name,[string]$File,[string[]]$Extra=@()){
    Run-Checked $Name 'node' (@((Join-Path $DriverDirectory $File))+$Extra)
}
Save-Receipt
$fixtureCreated=$false
$apisAttempted=$false
try{
    Set-Location -LiteralPath $Repository
    foreach($file in @(Get-ChildItem -LiteralPath $DriverDirectory -File)){
        $record.drivers+=@{file=$file.Name;sha256=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()}
    }
    $key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Target.ToLowerInvariant())))
    $mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
    $held=$false
    try{
        try{$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
        Run-Checked 'build' 'cargo' @('build','--locked','-p','crony-server','-p','crony-runner','-p','crony-cli','--bins')
        $backup=Join-Path $EvidenceRoot "$Label-prior-binaries"
        if(Test-Path -LiteralPath $backup){throw 'Preserve earlier binary backups.'}
        New-Item -ItemType Directory -Path $backup|Out-Null
        $preserved=@()
        foreach($name in @('crony-server.exe','crony-runner.exe','crony-cli.exe')){
            $destination=Join-Path $Repository "target/debug/$name"
            New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force|Out-Null
            if(Test-Path -LiteralPath $destination){
                $preserved+=@{file=$name;sha256=(Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant()}
                Move-Item -LiteralPath $destination -Destination (Join-Path $backup $name)
            }
            Copy-Item -LiteralPath (Join-Path $Target "debug/$name") -Destination $destination
            $record.binaries+=@{file=$name;sha256=(Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant()}
        }
        $preserved|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $backup 'preservation.json') -Encoding utf8
    }finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
    New-Item -ItemType Directory -Path $qa|Out-Null
    $fixtureCreated=$true
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
        $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $qa -AclObject $acl
    $secrets=Join-Path $qa 'secrets'
    New-Item -ItemType Directory -Path $secrets|Out-Null
    $password=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $secrets 'pg-password.txt'),$password+"`n",[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $secrets 'pgpass.conf'),"127.0.0.1:55461:*:ecorp_qa161:"+$password+"`n",[Text.UTF8Encoding]::new($false))
    $password=$null
    $record.fixture_acl=(Get-Acl -LiteralPath $qa).Sddl
    Save-Receipt
    Run-Checked 'helper-reconstruction' $python @((Join-Path $PSScriptRoot 'prepare-pr255-dependency-r1.py'),$Repository,$qa)
    Host-Action 'postgres-init' 'InitPg'
    $mutex=[Threading.Mutex]::new($false,"Local\ECorpCompletionCargo$key")
    $held=$false
    try{
        try{$held=$mutex.WaitOne()}catch [Threading.AbandonedMutexException]{$held=$true}
        Host-Action 'sqlx-authority' 'DbTests'
    }finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
    $apisAttempted=$true
    Node-Action 'api-start' 'qa-api.mjs' @('start')
    Node-Action 'prepare-cases' 'qa-scenarios.mjs' @('prepare')
    Host-Action 'runners-start' 'StartRunners'
    Node-Action 'runners-ready' 'qa-wait.mjs' @('runners')
    Node-Action 'independent-ledger' 'qa-scenarios.mjs' @('negative')
    Host-Action 'controllers-preview' 'Controllers' @('-Issue','9161','-DryRun')
    Node-Action 'controllers-preview-result' 'qa-wait.mjs' @('preview','9161')
    Host-Action 'controllers-race' 'Controllers' @('-Issue','9161')
    Node-Action 'controllers-race-result' 'qa-wait.mjs' @('verified','9161')
    Node-Action 'controllers-summary' 'qa-scenarios.mjs' @('summarize')
    Node-Action 'api-reconnect' 'qa-reconnect.mjs' @('9163')
    Node-Action 'runner-b-case' 'qa-scenarios.mjs' @('add-runner-b-case')
    Host-Action 'runner-a-stop' 'StopRunnerA'
    Host-Action 'runner-b-controller' 'Controllers' @('-Issue','9165')
    Node-Action 'runner-b-result' 'qa-wait.mjs' @('verified','9165')
    Host-Action 'web-build-start' 'StartWeb'
    Node-Action 'browser-authority' 'qa-browser.mjs'
    Node-Action 'artifact-verification' 'qa-evidence.mjs'
    Node-Action 'snapshot' 'qa-scenarios.mjs' @('snapshot')
    if((& git -C $Repository write-tree).Trim() -cne $currentTree -or (& git -C $Repository diff --name-only)){throw 'Product source changed during native acceptance.'}
    $sourceHead=(& git -C (Join-Path $qa 'source') rev-parse HEAD).Trim()
    $baseline=Get-Content -LiteralPath (Join-Path $qa 'authority-baseline.json') -Raw|ConvertFrom-Json
    if($sourceHead -cne $baseline.source_commit -or (& git -C (Join-Path $qa 'source') status --porcelain)){throw 'Synthetic source changed during acceptance.'}
    $record.product_source_unchanged=$true
    $record.fixture_source_unchanged=$true
    $record.status='passed'
}catch{
    $record.status='failed'
    $record.failure=[regex]::Replace($_.Exception.Message,'\bpostgres(?:ql)?://\S+','[database URL withheld]')
}finally{
    $cleanup=@()
    if($apisAttempted){
        try{
            Node-Action 'api-stop' 'qa-api.mjs' @('stop')
            $cleanup+='Both receipt-owned APIs stopped.'
        }catch{$record.status='failed';$cleanup+='API cleanup incomplete; preserve manifests and exact identities.'}
    }
    if($fixtureCreated -and (Test-Path -LiteralPath (Join-Path $qa 'host-state.json'))){
        try{
            Host-Action 'host-stop' 'Stop'
            $cleanup+='Receipt-owned host processes stopped; database, credentials, helper, workspaces, and evidence preserved.'
        }catch{$record.status='failed';$cleanup+='Host cleanup incomplete; preserve ownership records.'}
    }
    $record.cleanup=$cleanup
    $record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    Save-Receipt
}
$record|ConvertTo-Json -Depth 12
if($record.status -ne 'passed'){exit 1}
