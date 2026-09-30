#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$QaRoot,[Parameter(Mandatory)][string]$ProductRoot)
$ErrorActionPreference='Stop'
$issueQa=(Resolve-Path -LiteralPath $QaRoot).Path
$issueProduct=(Resolve-Path -LiteralPath $ProductRoot).Path
if($issueProduct -cne '<USERPROFILE>\.codex\worktrees\issue262-recovery\ecorp' -or
   (Split-Path -Leaf $issueQa) -notmatch '^pr265-run-activity-issue262-alias-20260930-r[0-9]+$' -or
   (Split-Path -Parent $issueQa) -cne '<USERPROFILE>\qa') { throw 'Unexpected fixture ownership scope.' }
Import-Module (Join-Path $issueProduct 'tools\local_stack.psm1') -Force
$statePath=Join-Path $issueQa 'ownership.json'
$state=Read-LocalStackState -Path $statePath -Workspace $issueQa
if(!$state -or $state.test_owned -ne $true -or $state.purpose -cne 'pr265-run-activity' -or
   $state.plan.product -cne $issueProduct -or $state.ContainsKey('issue262_codex_fixture')) {throw 'Fresh native fixture required.'}
$fixtureReceipt=Join-Path $issueQa 'evidence\issue262-native-codex.json'
if(Test-Path -LiteralPath $fixtureReceipt){throw 'Preserve prior runner replacement evidence.'}
$server=[uri]$state.plan.server
if($server.Host -cne '127.0.0.1' -or $server.Scheme -cne 'http'){throw 'Owned loopback server required.'}
$snapshot=Invoke-RestMethod "$($state.plan.server)/api/corps/$($state.demo.corp_id)/snapshot?actor_id=$($state.demo.alice_actor_id)"
if(@($snapshot.snapshot.runs).Count -ne 0 -or @($snapshot.snapshot.tasks).Count -ne 0){throw 'Runner replacement is allowed only before creating acceptance work.'}
$old=$state.processes.runner
$runnerExe=Join-Path $issueProduct 'target\debug\crony-runner.exe'
if($old.executable -cne $runnerExe -or !(Test-LocalOwnedProcess -Record $old -Workspace $issueQa)){throw 'Original exact owned runner not verified.'}
$record=[ordered]@{issue=262;qa_root=$issueQa;product_root=$issueProduct;started_at_utc=[DateTimeOffset]::UtcNow.ToString('o');status='replacing';previous_runner=$old;provider='Native Codex adapter with the existing deterministic fake-codex-app-server.mjs. Synthetic protocol and usage counters, no real inference.';old_runner_stopped=$false;replacement_recorded=$false}
function Save-Receipt { $record|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $fixtureReceipt -Encoding utf8 }
Save-Receipt
try {
    if(!(Stop-LocalOwnedProcess -Record $old -Workspace $issueQa)){throw 'Could not stop the exact fresh runner.'}
    $record.old_runner_stopped=$true;Save-Receipt
    $node=(Get-Command node.exe).Source
    $fixture=Join-Path $issueProduct 'scripts\fake-codex-app-server.mjs'
    $fixtureEnvironment=@{
        CRONY_SERVER_WS="ws://127.0.0.1:$($server.Port)/ws/runner";CRONY_RUNNER_ID=$state.plan.runner_id
        CRONY_CORP_ID=$state.demo.corp_id;CRONY_RUNNER_CREDENTIAL_FILE=(Join-Path $issueQa 'credential.json')
        CRONY_RUNNER_WORKSPACE=(Join-Path $issueQa 'runner');CRONY_SOURCE_REPOSITORY=(Join-Path $issueQa 'source');CRONY_SOURCE_BASE_REF='HEAD'
        CRONY_FAKE_AGENT_SCRIPT=(Join-Path $issueProduct 'scripts\fake-agent.mjs')
        CRONY_CODEX_COMMAND=$node;CRONY_CODEX_COMMAND_ARGS=$fixture
        CRONY_CLAUDE_COMMAND=(Join-Path $issueQa 'disabled-claude.exe');CRONY_OPENCODE_COMMAND=(Join-Path $issueQa 'disabled-opencode.exe')
        CRONY_COPILOT_FIXTURE='true';CRONY_COPILOT_USE_LOGGED_IN_USER='false'
        CRONY_CONNECTIONS_DIRECTORY=(Join-Path $issueQa 'connections');CRONY_GITHUB_COMMAND=(Join-Path $issueQa 'disabled-github.exe');ECORP_FACTORY_WATCH='0'
    }
    $new=Start-LocalOwnedProcess -Role 'runner-codex' -Workspace $issueQa -FilePath $runnerExe -ArgumentList @() -WorkingDirectory $issueProduct -LogDirectory (Join-Path $issueQa 'logs') -Environment $fixtureEnvironment
    $record.replacement_runner=$new;Save-Receipt
    $state.processes.runner=$new
    $state.issue262_codex_fixture=@{previous_runner=$old;replacement_started_at_utc=$record.started_at_utc;script=$fixture;script_sha256=(Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant();node=$node}
    $state.plan.provider=$record.provider
    Save-LocalStackState -Path $statePath -State $state -Workspace $issueQa
    $record.replacement_recorded=$true;Save-Receipt
    $deadline=[DateTime]::UtcNow.AddSeconds(45)
    do {
        if(!(Test-LocalOwnedProcess -Record $new -Workspace $issueQa)){throw 'Replacement runner exited.'}
        $health=Invoke-RestMethod "$($state.plan.server)/health" -TimeoutSec 3
        if($health.runners -eq 1){$record.status='ready';break}
        Start-Sleep -Milliseconds 200
    } while([DateTime]::UtcNow -lt $deadline)
    if($record.status -cne 'ready'){throw 'Native fixture runner did not reconnect.'}
} catch {
    $record.status='failed';$record.error=$_.Exception.Message
    if($record.Contains('replacement_runner') -and !$record.replacement_recorded){
        $record.unrecorded_replacement_stopped=Stop-LocalOwnedProcess -Record $record.replacement_runner -Workspace $issueQa
    }
    throw
} finally {
    $record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o');Save-Receipt
    if($fixtureEnvironment){$fixtureEnvironment.Clear()}
}
Write-Output 'Native synthetic Codex adapter ready in the fresh owned stack; original process receipt preserved.'
