#requires -Version 7.4
param([Parameter(Mandatory)][string]$NodePath)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'delegated_qa_root.ps1')
Import-Module (Join-Path $PSScriptRoot 'local_stack.psm1') -Force -DisableNameChecking
$root=Join-Path ([IO.Path]::GetTempPath()) ('ecorp-delegated-paths-'+[guid]::NewGuid().ToString('N'))
$product=Join-Path $root 'delegated-keycloak-product'
$independent=Join-Path $root 'delegated-keycloak-independent'
New-Item -ItemType Directory -Path $product,$independent|Out-Null
$cases=[Collections.Generic.List[object]]::new()
$children=[Collections.Generic.List[Diagnostics.Process]]::new()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DelegatedQaAliasTest {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetShortPathNameW(string path, StringBuilder value, uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint QueryDosDeviceW(string name, StringBuilder value, uint length);
}
'@
function Check([string]$Name,[scriptblock]$Body) {
    try { & $Body; $cases.Add(@{name=$Name;passed=$true}) }
    catch { $cases.Add(@{name=$Name;passed=$false;error=$_.Exception.Message}) }
}
function Reject([scriptblock]$Body) {
    $rejected=$false
    try { & $Body|Out-Null } catch { $rejected=$true }
    if(!$rejected){throw 'An unsafe or unqualified path was accepted.'}
}
function Equal([string]$Actual,[string]$Expected) {
    if(![string]::Equals($Actual,$Expected,[StringComparison]::OrdinalIgnoreCase)){throw 'Physical path identity did not match.'}
}
function New-FixtureProcess([string]$Directory) {
    $start=[Diagnostics.ProcessStartInfo]::new($NodePath)
    $start.UseShellExecute=$false
    $start.CreateNoWindow=$true
    $start.WorkingDirectory=$Directory
    $start.Environment.Clear()
    foreach($name in @('SystemRoot','WINDIR','TEMP','TMP')) {
        $value=[Environment]::GetEnvironmentVariable($name)
        if($null -ne $value){$start.Environment[$name]=$value}
    }
    $start.ArgumentList.Add('-e')
    $start.ArgumentList.Add('setInterval(() => {}, 1000)')
    $child=[Diagnostics.Process]::Start($start)
    [void]$child.Handle
    $children.Add($child)
    return $child
}
function Write-Ownership([string]$Directory,[Diagnostics.Process]$Process,[bool]$Stale) {
    $record=Get-LocalProcessIdentity -ProcessId $Process.Id
    if(!$record){throw 'Native process identity unavailable.'}
    $record.workspace=$Directory
    if($Stale){$record.started_utc=[DateTimeOffset]::UtcNow.AddDays(-1).ToString('o')}
    $state=@{schema_version=2;workspace=$Directory;purpose='delegated-keycloak-acceptance';test_owned=$true;processes=@{postgres=$record}}
    Save-LocalStackState -Path (Join-Path $Directory 'ownership.json') -State $state -Workspace $Directory
}
$mapped=$null
$substExercised=$false
$substRemoved=$false
try {
    Check 'allows a new independent directory' {
        $path=Join-Path $root 'delegated-keycloak-new'
        Equal (Resolve-DelegatedQaRoot $path $product) $path
        if(Test-Path -LiteralPath $path){throw 'Path validation unexpectedly created a fixture.'}
    }
    Check 'allows an existing independent directory' { Equal (Resolve-DelegatedQaRoot $independent $product -RequireExists) $independent }
    Check 'allows a sibling sharing the product name prefix' {
        $path=Join-Path ($product+'-sibling') 'delegated-keycloak-new'
        Equal (Resolve-DelegatedQaRoot $path $product) $path
    }
    Check 'resolves multiple missing parents from their existing physical ancestor' {
        $path=Join-Path $root 'new-parent/new-child/delegated-keycloak-new'
        Equal (Resolve-DelegatedQaRoot $path $product) ([IO.Path]::GetFullPath($path))
    }
    Check 'rejects the product itself' { Reject { Resolve-DelegatedQaRoot $product $product } }
    Check 'rejects a product descendant' { Reject { Resolve-DelegatedQaRoot (Join-Path $product 'delegated-keycloak-inside') $product } }
    Check 'rejects a product ancestor' {
        $nested=Join-Path $independent 'product'
        New-Item -ItemType Directory -Path $nested|Out-Null
        Reject { Resolve-DelegatedQaRoot $independent $nested }
    }
    Check 'rejects a missing root when existing ownership is required' { Reject { Resolve-DelegatedQaRoot (Join-Path $root 'delegated-keycloak-missing') $product -RequireExists } }
    Check 'rejects a relative path' { Reject { Resolve-DelegatedQaRoot 'delegated-keycloak-relative' $product } }
    Check 'rejects network paths without touching a network share' { Reject { Resolve-DelegatedQaRoot '\\invalid.example\share\delegated-keycloak-network' $product } }
    Check 'rejects an unrelated leaf name' { Reject { Resolve-DelegatedQaRoot (Join-Path $root 'unqualified-root') $product } }
    Check 'rejects an existing file ancestor' {
        $file=Join-Path $root 'file-parent'
        [IO.File]::WriteAllText($file,'preserve')
        Reject { Resolve-DelegatedQaRoot (Join-Path $file 'delegated-keycloak-child') $product }
        Equal ([IO.File]::ReadAllText($file)) 'preserve'
    }
    Check 'rejects an existing file leaf' {
        $file=Join-Path $root 'delegated-keycloak-file'
        [IO.File]::WriteAllText($file,'preserve')
        Reject { Resolve-DelegatedQaRoot $file $product }
        Equal ([IO.File]::ReadAllText($file)) 'preserve'
    }
    Check 'rejects a junction in an existing parent' {
        $junction=Join-Path $root 'junction-parent'
        New-Item -ItemType Junction -Path $junction -Target $independent|Out-Null
        Reject { Resolve-DelegatedQaRoot (Join-Path $junction 'delegated-keycloak-child') $product }
    }
    Check 'rejects a junction used as the QA leaf' {
        $junction=Join-Path $root 'delegated-keycloak-junction'
        New-Item -ItemType Junction -Path $junction -Target $independent|Out-Null
        Reject { Resolve-DelegatedQaRoot $junction $product -RequireExists }
    }
    $short=[Text.StringBuilder]::new(32768)
    $shortCount=[DelegatedQaAliasTest]::GetShortPathNameW($product,$short,[uint32]$short.Capacity)
    if($shortCount -gt 0 -and $shortCount -lt $short.Capacity -and $short.ToString() -cne $product) {
        Check 'rejects a product descendant through a native short-name alias' { Reject { Resolve-DelegatedQaRoot (Join-Path $short.ToString() 'delegated-keycloak-child') $product } }
    } else {
        $cases.Add(@{name='rejects a product descendant through a native short-name alias';passed=$false;skip='This volume did not expose a distinct short-name alias.'})
    }
    foreach($letter in @('Z','Y','X','W','V','U','T')) {
        $device=[Text.StringBuilder]::new(32768)
        if([DelegatedQaAliasTest]::QueryDosDeviceW($letter+':',$device,[uint32]$device.Capacity) -eq 0 -and
            [Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 2){$mapped=$letter+':';break}
    }
    if(!$mapped){throw 'No unused native drive name is available for the owned alias fixture.'}
    & subst.exe $mapped $root
    if($LASTEXITCODE){throw 'Cannot create the owned substituted drive.'}
    $substExercised=$true
    Check 'resolves a substituted independent QA path to its physical directory' {
        Equal (Resolve-DelegatedQaRoot ($mapped+'\delegated-keycloak-independent') $product -RequireExists) $independent
    }
    Check 'rejects a product descendant hidden behind a substituted drive' {
        Reject { Resolve-DelegatedQaRoot ($mapped+'\delegated-keycloak-product\delegated-keycloak-child') $product }
    }
    Check 'compares physical containment when the product uses a substituted drive' {
        Reject { Resolve-DelegatedQaRoot (Join-Path $product 'delegated-keycloak-child') ($mapped+'\delegated-keycloak-product') }
    }
    $stopRoot=Join-Path $root 'delegated-keycloak-stop'
    New-Item -ItemType Directory -Path (Join-Path $stopRoot 'database')|Out-Null
    $sentinel=New-FixtureProcess $root
    $target=New-FixtureProcess $stopRoot
    $marker=Join-Path $stopRoot 'database/postmaster.pid'
    [IO.File]::WriteAllText($marker,[string]$sentinel.Id)
    Check 'stale PostgreSQL identity preserves the target and unrelated process' {
        Write-Ownership $stopRoot $target $true
        Reject { & (Join-Path $PSScriptRoot 'qa_delegated.ps1') -Phase Stop -QaRoot $stopRoot -NodePath $NodePath }
        if($target.HasExited -or $sentinel.HasExited){throw 'Stale ownership stopped a live process.'}
    }
    Check 'PostgreSQL-role stop uses exact process identity and ignores a decoy postmaster PID' {
        Write-Ownership $stopRoot $target $false
        & (Join-Path $PSScriptRoot 'qa_delegated.ps1') -Phase Stop -QaRoot $stopRoot -NodePath $NodePath|Out-Null
        if(!$target.WaitForExit(5000) -or $sentinel.HasExited){throw 'Stop did not preserve the exact process boundary.'}
        & (Join-Path $PSScriptRoot 'qa_delegated.ps1') -Phase Stop -QaRoot $stopRoot -NodePath $NodePath|Out-Null
        Equal ([IO.File]::ReadAllText($marker)) ([string]$sentinel.Id)
        if($sentinel.HasExited){throw 'Repeated stop affected the unrelated process.'}
    }
} finally {
    foreach($child in $children){
        try { if(!$child.HasExited){$child.Kill();[void]$child.WaitForExit(5000)} }
        finally {$child.Dispose()}
    }
    if($substExercised){
        $device=[Text.StringBuilder]::new(32768)
        if([DelegatedQaAliasTest]::QueryDosDeviceW($mapped,$device,[uint32]$device.Capacity) -eq 0 -or
            ![string]::Equals($device.ToString(),'\??\'+$root,[StringComparison]::OrdinalIgnoreCase)) {
            throw 'The substituted drive changed ownership; preserve it rather than removing it.'
        }
        & subst.exe $mapped /D
        if($LASTEXITCODE){throw 'Cannot remove the verified owned alias mapping.'}
        $substRemoved=$true
    }
}
$result=@{scope='Native Windows physical paths and production delegated QA stop; owned synthetic processes';cases=@($cases);fixture=$root;subst_exercised=$substExercised;subst_removed=$substRemoved;files_preserved=$true}
Write-Output ('ECORP_DELEGATED_QA_ROOT_RESULT='+($result|ConvertTo-Json -Depth 8 -Compress))
if(@($cases|Where-Object {!$_.passed -and !$_.skip}).Count){exit 1}
