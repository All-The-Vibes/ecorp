#requires -Version 7.4
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ReportDirectory,
  [string]$TemporaryRoot = $env:RUNNER_TEMP
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'Windows ACL readiness requires a Windows host.' }

function Get-PlainDirectoryPath([string]$Directory) {
  if (![IO.Path]::IsPathFullyQualified($Directory)) { throw 'Readiness directories must be absolute.' }
  $full = [IO.Path]::GetFullPath($Directory)
  for ($current = $full; $current; $current = [IO.Path]::GetDirectoryName($current)) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Readiness directories must have ordinary, non-redirected ancestors.'
      }
    }
  }
  return $full
}

$reports = Get-PlainDirectoryPath $ReportDirectory
$readinessRoot = Get-PlainDirectoryPath $TemporaryRoot
if (!(Test-Path -LiteralPath $readinessRoot -PathType Container)) { throw 'Readiness temporary root must already exist.' }
foreach ($name in @('acl-readiness.json', 'acl-readiness.stdout.log', 'acl-readiness.stderr.log')) {
  if (Test-Path -LiteralPath (Join-Path $reports $name)) { throw 'Readiness reports already exist; preserve them and select a new directory.' }
}
[IO.Directory]::CreateDirectory($reports) | Out-Null
# The GUID directory is owned by this single probe and retained for diagnostics.
# No pre-existing directory receives an ACL change or recursive cleanup.
# The runner uses Windows PowerShell 5.1, not this step's PowerShell 7.
# Exercise its first-use ACL startup without changing the runner's 10s deadline.
$readinessDirectory = Join-Path $readinessRoot ('ecorp-acl-readiness-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $readinessDirectory | Out-Null
$nativeHost = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$readinessScript = @'
$ErrorActionPreference='Stop'
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($owner,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($env:ECORP_CONNECTION_ACL_TARGET,$acl)
$actual=[System.IO.Directory]::GetAccessControl($env:ECORP_CONNECTION_ACL_TARGET)
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw 'ACL owner or inheritance verification failed.' }
$rules=@($actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
$expectedSids=@($owner.Value,'S-1-5-18' | Sort-Object -Unique)
$actualSids=@($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
if ($rules.Count -ne $expectedSids.Count -or ($actualSids -join ',') -ne ($expectedSids -join ',')) { throw 'ACL principal verification failed.' }
foreach($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -or $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw 'ACL permission verification failed.' }
}
@{ host_version=$PSVersionTable.PSVersion.ToString(); verified=$true } | ConvertTo-Json -Compress
'@
$readinessInfo = [Diagnostics.ProcessStartInfo]::new()
$readinessInfo.FileName = $nativeHost
$readinessInfo.WorkingDirectory = $readinessDirectory
$readinessInfo.UseShellExecute = $false
$readinessInfo.CreateNoWindow = $true
$readinessInfo.RedirectStandardOutput = $true
$readinessInfo.RedirectStandardError = $true
foreach ($argument in @('-NoLogo','-NoProfile','-NonInteractive','-Command',$readinessScript)) { $readinessInfo.ArgumentList.Add($argument) }
$readinessInfo.Environment['ECORP_CONNECTION_ACL_TARGET'] = $readinessDirectory
$readinessProcess = [Diagnostics.Process]::new()
$readinessProcess.StartInfo = $readinessInfo
$readinessClock = [Diagnostics.Stopwatch]::StartNew()
$readinessReceipt = @{ host_version=$null; verified=$false; timed_out=$false; duration_ms=0 }
$readinessStarted = $false
$readinessStdout = $null
$readinessStderr = $null
try {
  $readinessStarted = $readinessProcess.Start()
  if (!$readinessStarted) { throw 'Native ACL readiness host did not start.' }
  $readinessStdout = $readinessProcess.StandardOutput.ReadToEndAsync()
  $readinessStderr = $readinessProcess.StandardError.ReadToEndAsync()
  if (!$readinessProcess.WaitForExit(60000)) { $readinessReceipt.timed_out=$true; throw 'Native ACL readiness exceeded 60 seconds.' }
  if (![Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($readinessStdout,$readinessStderr),5000)) { throw 'Native ACL readiness output did not close.' }
  if ($readinessProcess.ExitCode -ne 0) { throw 'Native ACL readiness failed.' }
  $readinessResult = $readinessStdout.Result | ConvertFrom-Json
  if ($readinessResult.verified -ne $true -or $readinessResult.host_version -notmatch '^5\.1\.') { throw 'Native Windows PowerShell ACL readiness was not verified.' }
  $readinessReceipt.host_version = $readinessResult.host_version
  $readinessReceipt.verified = $true
} finally {
  $readinessCleanupFailed = $false
  if ($readinessStarted -and !$readinessProcess.HasExited) {
    try { $readinessProcess.Kill($true); $readinessCleanupFailed = !$readinessProcess.WaitForExit(5000) } catch { $readinessCleanupFailed=$true }
  }
  if ($readinessStdout -and $readinessStderr) {
    try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($readinessStdout,$readinessStderr),5000) } catch { $readinessCleanupFailed=$true }
    if ($readinessStdout.IsCompletedSuccessfully) { $readinessStdout.Result | Set-Content (Join-Path $reports 'acl-readiness.stdout.log') }
    if ($readinessStderr.IsCompletedSuccessfully) { $readinessStderr.Result | Set-Content (Join-Path $reports 'acl-readiness.stderr.log') }
  }
  $readinessClock.Stop()
  $readinessReceipt.duration_ms = $readinessClock.ElapsedMilliseconds
  $readinessReceipt | ConvertTo-Json | Set-Content (Join-Path $reports 'acl-readiness.json')
  $readinessProcess.Dispose()
  if ($readinessCleanupFailed) { throw 'Owned ACL readiness process cleanup failed.' }
}
