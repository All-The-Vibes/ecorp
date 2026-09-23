#requires -Version 7.4
[CmdletBinding()]
param(
    [ValidateSet('Module', 'Source', 'Startup')][string]$Suite = 'Module',
    [string]$NodePath,
    [string]$FixtureParent = [IO.Path]::GetTempPath(),
    [switch]$RetainFixtures
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This script is a child test scope. Delete without first reading or retaining
# the caller's value. Every DATABASE_URL subsequently used is a synthetic canary.
Remove-Item -LiteralPath Env:DATABASE_URL -ErrorAction SilentlyContinue
if (!$IsWindows) { throw 'These fixtures require Windows and PowerShell 7.4+.' }

$script:Cases = [Collections.Generic.List[object]]::new()
$script:Processes = [Collections.Generic.List[hashtable]]::new()
$script:Sentinels = [Collections.Generic.List[string]]::new()
$script:Junctions = [Collections.Generic.List[string]]::new()
$script:FixtureRoot = $null
$script:Lease = $null
$script:Cleanup = @{ created_processes = 0; remaining_processes = 0; temp_removed = $true }

function Assert-True {
    param($Actual, [string]$Message)
    if ($Actual -isnot [bool] -or !$Actual) { throw $Message }
}

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    if ($Actual -cne $Expected) { throw $Message }
}

function Assert-False {
    param($Actual, [string]$Message)
    if ($Actual -isnot [bool] -or $Actual) { throw $Message }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-True $rejected $Message
}

function Invoke-Case {
    param([string]$Name, [scriptblock]$Action)
    try {
        & $Action | Out-Null
        $script:Cases.Add(@{ name = $Name; passed = $true; error = $null })
    } catch {
        $message = $_.Exception.Message + "`n" + $_.FullyQualifiedErrorId + "`n" + $_.ScriptStackTrace
        foreach ($sentinel in $script:Sentinels) { $message = $message.Replace($sentinel, '[synthetic-redacted]') }
        $script:Cases.Add(@{ name = $Name; passed = $false; error = $message })
    }
}

function Assert-InFixture {
    param([string]$Path)
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $root = [IO.Path]::GetFullPath($script:FixtureRoot).TrimEnd('\', '/')
    if ($full -ne $root -and !$full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing a filesystem operation outside the task-created temporary tree.'
    }
    $full
}

function Write-FixtureFile {
    param([string]$Path, [string]$Text)
    $full = Assert-InFixture $Path
    [IO.File]::WriteAllText($full, $Text, [Text.UTF8Encoding]::new($false))
}

function Wait-FixtureJson {
    param([string]$Path)
    $full = Assert-InFixture $Path
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        if ([IO.File]::Exists($full)) {
            try { return ([IO.File]::ReadAllText($full) | ConvertFrom-Json -AsHashtable) }
            catch { } # The fixture may be in its one small readiness-file write.
        }
        Start-Sleep -Milliseconds 25
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'A synthetic fixture did not publish readiness within 10 seconds.'
}

function New-FixtureSpec {
    param([string]$Mode = 'worker', [string[]]$Extra = @())
    $nonce = [guid]::NewGuid().ToString('N')
    @{
        nonce = $nonce
        ready = Join-Path $script:FixtureRoot "$nonce ready [literal].json"
        before = [DateTime]::UtcNow
        arguments = @($script:FixtureScript, $Mode, $script:Lease,
            (Join-Path $script:FixtureRoot "$nonce ready [literal].json"), $nonce) + $Extra
    }
}

function Register-FixtureHandle {
    param([Diagnostics.Process]$Process, [hashtable]$Spec)
    # Pin this exact native process before checking identity. Cleanup never
    # reacquires a PID, delegates to the module under test, or kills a tree.
    [void]$Process.Handle
    $creation = $Process.StartTime.ToUniversalTime()
    $owned = @{
        process = $Process; process_id = $Process.Id
        executable = $script:NodeExecutable; creation = $creation; verified = $false
    }
    # Retain the exact handle even if readiness or image inspection subsequently
    # fails. An unverified fixture can exit on its lease, but is never killed.
    $script:Processes.Add($owned)
    if ($Process.HasExited -or $creation -lt $Spec.before.AddSeconds(-1)) {
        throw 'Could not independently establish synthetic process ownership.'
    }
    $owned
}

function Assert-FixtureReady {
    param([hashtable]$Ready, [hashtable]$Owned, [hashtable]$Spec)
    Assert-Equal $Ready.nonce $Spec.nonce 'Fixture readiness nonce must match this launch.'
    Assert-Equal ([int]$Ready.process_id) $Owned.process_id 'Fixture readiness must identify the held process.'
    Assert-Equal $Ready.executable $script:NodeExecutable 'Fixture must execute the explicitly selected Node binary.'
    $Owned.process.Refresh()
    $image = $Owned.process.MainModule
    Assert-True ($null -ne $image -and
        [string]::Equals($image.FileName, $script:NodeExecutable, [StringComparison]::OrdinalIgnoreCase)) 'The ready process image must match the held synthetic handle.'
    Assert-True ($Owned.creation -le [IO.File]::GetLastWriteTimeUtc($Spec.ready)) 'A reused PID created after readiness is not this fixture.'
    $Owned.verified = $true
}

function Start-Fixture {
    param([hashtable]$Spec)
    $info = [Diagnostics.ProcessStartInfo]::new($script:NodeExecutable)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.WorkingDirectory = $script:Workspace
    $info.Environment.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($null -ne $value) { $info.Environment[$name] = $value }
    }
    foreach ($argument in $Spec.arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (!$process.Start()) { throw 'Synthetic process creation failed.' }
    $owned = Register-FixtureHandle $process $Spec
    $ready = Wait-FixtureJson $Spec.ready
    Assert-FixtureReady $ready $owned $Spec
    @{ owned = $owned; ready = $ready; spec = $Spec }
}

function Get-FixtureRecord {
    param([hashtable]$Fixture)
    @{
        workspace = $script:Workspace
        pid = $Fixture.owned.process_id
        executable = $Fixture.owned.executable
        started_utc = $Fixture.owned.creation.ToString('o')
    }
}

function Assert-FixtureAlive {
    param([hashtable]$Fixture)
    Assert-False $Fixture.owned.process.HasExited 'A synthetic process that must survive was terminated.'
}

function Stop-FixtureHandle {
    param([hashtable]$Owned)
    $process = $Owned.process
    if (!$process.HasExited) {
        if (!$Owned.verified) {
            Assert-True ($process.WaitForExit(5000)) 'An unverified fixture did not cooperate with lease cleanup; it was not killed.'
            return
        }
        if ($process.Id -ne $Owned.process_id -or
            $process.StartTime.ToUniversalTime().Ticks -ne $Owned.creation.Ticks -or
            ![string]::Equals($process.MainModule.FileName, $Owned.executable, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing cleanup: the held synthetic process identity no longer matches.'
        }
        $process.Kill() # Root only, through the handle retained at fixture creation.
    }
    Assert-True ($process.WaitForExit(5000)) 'The exact synthetic process did not exit during cleanup.'
}

function Start-ModuleFixture {
    param(
        [hashtable]$Spec,
        [string]$Role = 'literal-fixture',
        [hashtable]$Environment = @{},
        [string]$Workspace = $script:Workspace,
        [string]$WorkingDirectory = $Workspace,
        [string]$LogDirectory = $script:LogDirectory
    )
    $output = @(Start-LocalOwnedProcess -Role $Role -Workspace $Workspace `
        -FilePath $script:NodeExecutable -ArgumentList $Spec.arguments `
        -WorkingDirectory $WorkingDirectory -LogDirectory $LogDirectory `
        -Environment $Environment *>&1)
    $records = @($output | Where-Object { $_ -is [hashtable] })
    Assert-Equal $records.Count 1 'Start must return exactly one process-record hashtable.'
    $record = $records[0]
    $ready = Wait-FixtureJson $Spec.ready
    Assert-Equal $ready.nonce $Spec.nonce 'Module-started child must publish its unique fixture nonce.'
    Assert-Equal ([int]$ready.process_id) ([int]$record.pid) 'Module record must name the actual fixture child.'
    $process = [Diagnostics.Process]::GetProcessById([int]$ready.process_id)
    $owned = Register-FixtureHandle $process $Spec
    Assert-FixtureReady $ready $owned $Spec
    Assert-Equal ([DateTimeOffset]$record.started_utc).UtcTicks $owned.creation.Ticks 'Start must record exact OS creation time.'
    Assert-Equal $record.executable $owned.executable 'Start must record the actual executable.'
    Assert-Equal $record.workspace $Workspace 'Start must bind the explicit workspace.'
    @{ owned = $owned; ready = $ready; spec = $Spec; record = $record; output = $output }
}

function Wait-FixtureLog {
    param([string]$Path, [string]$Marker)
    $full = Assert-InFixture $Path
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        if ([IO.File]::Exists($full)) {
            $stream = $null
            $reader = $null
            try {
                # Reading a live redirected log must also share the writer's
                # existing write handle; File.ReadAllText shares reads only.
                $stream = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read,
                    [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
                $reader = [IO.StreamReader]::new($stream)
                $text = $reader.ReadToEnd()
                if ($text.Contains($Marker)) { return $text }
            } catch [IO.IOException] {
                # The launcher may still be opening/flushing this new log.
            } finally {
                if ($reader) { $reader.Dispose() }
                elseif ($stream) { $stream.Dispose() }
            }
        }
        Start-Sleep -Milliseconds 25
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Expected output was not retained in the fixture log.'
}

function Assert-ReadRefused {
    param([string]$Path, [string]$Workspace)
    # Missing files may return null; corrupt or foreign state may throw. Neither
    # is stop authority, and neither may remove/repair the evidence file.
    $value = $null
    try { $value = Read-LocalStackState -Path $Path -Workspace $Workspace } catch { return }
    Assert-True ($null -eq $value) 'Invalid state must not return usable ownership authority.'
}

function Invoke-ModuleCases {
    $module = Join-Path $PSScriptRoot 'local_stack.psm1'
    Import-Module -Name $module -Force -DisableNameChecking
    $script:NodeExecutable = (Resolve-Path -LiteralPath $NodePath).Path
    $temporaryParent = [IO.Path]::GetFullPath($FixtureParent).TrimEnd('\', '/')
    $script:FixtureRoot = Join-Path $temporaryParent ("ecorp local lifecycle " + [guid]::NewGuid().ToString('N'))
    if ([IO.Directory]::Exists($script:FixtureRoot)) { throw 'Refusing to reuse a temporary test directory.' }
    [IO.Directory]::CreateDirectory($script:FixtureRoot) | Out-Null
    $script:Cleanup.temp_removed = $false
    $script:Workspace = Join-Path $script:FixtureRoot 'workspace with spaces [literal]'
    $script:LogDirectory = Join-Path $script:Workspace 'logs with spaces [literal]'
    [IO.Directory]::CreateDirectory($script:LogDirectory) | Out-Null
    $script:Lease = Join-Path $script:FixtureRoot 'fixture lease'
    Write-FixtureFile $script:Lease 'synthetic process lease'
    $script:FixtureScript = Join-Path $script:FixtureRoot 'synthetic child [literal] with spaces.mjs'
    # No sockets, database/client code, shell, real service, or credential reads.
    # All children exit when our lease disappears, with a 45-second hard TTL as
    # a backstop if the test supervisor is interrupted before its finally block.
    Write-FixtureFile $script:FixtureScript @'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
const [mode, lease, readyPath, nonce, ...extra] = process.argv.slice(2)
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value))
const digest = (name) => process.env[name] === undefined ? null
  : createHash('sha256').update(process.env[name]).digest('hex')
const alive = () => fs.existsSync(lease)
const expires = Date.now() + 45_000
const ready = {
  nonce, process_id: process.pid, parent_id: process.ppid,
  executable: process.execPath, cwd: process.cwd(), arguments: extra,
  sentinel_digest: digest('ECORP_LOCAL_STACK_TEST_SENTINEL'),
  database_digest: digest('DATABASE_URL'),
  ambient_present: Object.hasOwn(process.env, 'ECORP_LOCAL_STACK_TEST_AMBIENT'),
  removed_present: Object.hasOwn(process.env, 'ECORP_LOCAL_STACK_TEST_REMOVED'),
}
if (mode === 'parent') {
  const child = spawn(process.execPath,
    [process.argv[1], 'worker', lease, extra[0], extra[1]],
    { windowsHide: true, stdio: 'ignore', detached: true })
  child.on('error', () => process.exit(2))
  child.unref()
}
if (mode === 'reader') {
  const [statePath, resultPath, readerLease] = extra
  let reads = 0, failures = 0
  const generations = new Set()
  const inspect = () => {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      const generation = state.generation
      if (state.schema_version !== 2 || !Number.isInteger(generation) ||
          state.payload !== String(generation % 10).repeat(65536) ||
          state.proof !== `generation-${generation}`) throw new Error('torn state')
      reads++
      generations.add(generation)
    } catch { failures++ }
  }
  inspect()
  write(readyPath, ready)
  const timer = setInterval(() => {
    if (!alive() || !fs.existsSync(readerLease) || Date.now() >= expires) {
      clearInterval(timer)
      write(resultPath, { reads, failures, distinct_generations: generations.size })
      process.exit(0)
    }
    inspect()
  }, 1)
} else {
  write(readyPath, ready)
  console.log(`fixture stdout ${nonce}`)
  console.error(`fixture stderr ${nonce}`)
  const timer = setInterval(() => {
    if (!alive() || Date.now() >= expires) { clearInterval(timer); process.exit(0) }
  }, 50)
}
'@

    if ($Suite -eq 'Startup') { Invoke-StartupCases; return }
    $guard = Start-Fixture (New-FixtureSpec)
    $guardRecord = Get-FixtureRecord $guard
    Invoke-Case 'identity comes from the live process and binds only the explicit workspace' {
        $identity = Get-LocalProcessIdentity -ProcessId $guard.owned.process_id
        Assert-True ($identity -is [hashtable]) 'Identity must be a hashtable.'
        Assert-Equal ([int]$identity.pid) $guard.owned.process_id 'Identity PID differs from the held fixture.'
        Assert-Equal $identity.executable $guard.owned.executable 'Identity executable differs from the held fixture.'
        Assert-Equal ([DateTimeOffset]$identity.started_utc).UtcTicks $guard.owned.creation.Ticks 'Identity creation timestamp differs.'
        Assert-False (Test-LocalOwnedProcess -Record $identity -Workspace $script:Workspace) 'An identity without a workspace cannot authorize stopping.'
        $identity.workspace = $script:Workspace
        Assert-True (Test-LocalOwnedProcess -Record $identity -Workspace $script:Workspace) 'An exact, workspace-bound record must match.'
    }

    Invoke-Case 'wrong timestamps, executable, workspace and malformed records fail closed' {
        $variants = [Collections.Generic.List[object]]::new()
        $variants.Add($null)
        $variants.Add(@{})
        foreach ($key in @('pid', 'workspace', 'executable', 'started_utc')) {
            $copy = $guardRecord.Clone()
            $copy.Remove($key)
            $variants.Add($copy)
        }
        foreach ($change in @(
            @{ started_utc = $guard.owned.creation.AddSeconds(-1).ToString('o') },
            @{ started_utc = $guard.owned.creation.AddSeconds(1).ToString('o') },
            @{ started_utc = 'not-a-timestamp' }, @{ started_utc = $null },
            @{ executable = (Join-Path $script:Workspace 'not-the-fixture.exe') },
            @{ executable = 'node.exe' }, @{ executable = '' },
            @{ workspace = ($script:Workspace + '-neighbor') }, @{ workspace = $null },
            @{ pid = 'not-a-process-id' }, @{ pid = 0 }, @{ pid = -1 }
        )) {
            $copy = $guardRecord.Clone()
            foreach ($key in $change.Keys) { $copy[$key] = $change[$key] }
            $variants.Add($copy)
        }
        foreach ($record in $variants) {
            Assert-FixtureAlive $guard
            Assert-False (Test-LocalOwnedProcess -Record $record -Workspace $script:Workspace) 'A mismatched/malformed record passed ownership validation.'
            Assert-False (Stop-LocalOwnedProcess -Record $record -Workspace $script:Workspace) 'A mismatched/malformed record authorized stopping.'
            Assert-FixtureAlive $guard
        }
        Assert-False (Stop-LocalOwnedProcess -Record $guardRecord -Workspace ($script:Workspace + '-neighbor')) 'The caller workspace must also match.'
        Assert-FixtureAlive $guard
    }

    Invoke-Case 'a stale creation record aimed at a live synthetic PID cannot stop it' {
        $old = Start-Fixture (New-FixtureSpec)
        $stale = Get-FixtureRecord $old
        Stop-FixtureHandle $old.owned
        $replacement = Start-Fixture (New-FixtureSpec)
        Assert-True ($old.owned.creation.Ticks -ne $replacement.owned.creation.Ticks) 'PID-reuse simulation requires distinct observed creation times.'
        # Deliberately simulate PID reuse; do not churn system PIDs to force it.
        $stale.pid = $replacement.owned.process_id
        Assert-False (Test-LocalOwnedProcess -Record $stale -Workspace $script:Workspace) 'A PID alone must not adopt a new process.'
        Assert-False (Stop-LocalOwnedProcess -Record $stale -Workspace $script:Workspace) 'A stale creation record must not stop the replacement.'
        Assert-FixtureAlive $replacement
        Assert-FixtureAlive $guard
    }

    Invoke-Case 'stopping the verified root leaves its descendant and an unrelated child alive' {
        $descendantSpec = New-FixtureSpec
        $parent = Start-Fixture (New-FixtureSpec -Mode 'parent' -Extra @($descendantSpec.ready, $descendantSpec.nonce))
        $ready = Wait-FixtureJson $descendantSpec.ready
        Assert-Equal ([int]$ready.parent_id) $parent.owned.process_id 'The descendant fixture must actually belong to this root.'
        $held = Register-FixtureHandle ([Diagnostics.Process]::GetProcessById([int]$ready.process_id)) $descendantSpec
        Assert-FixtureReady $ready $held $descendantSpec
        $descendant = @{ owned = $held }
        $record = Get-FixtureRecord $parent
        Assert-True (Stop-LocalOwnedProcess -Record $record -Workspace $script:Workspace) 'The exact owned root should stop.'
        Assert-True ($parent.owned.process.WaitForExit(5000)) 'The verified root did not exit.'
        Start-Sleep -Milliseconds 150
        Assert-FixtureAlive $descendant
        Assert-FixtureAlive $guard
        Assert-True ($null -eq (Get-LocalProcessIdentity -ProcessId $record.pid)) 'An exited fixture must have no live identity.'
        Assert-False (Test-LocalOwnedProcess -Record $record -Workspace $script:Workspace) 'The exited record must not match.'
        Assert-False (Stop-LocalOwnedProcess -Record $record -Workspace $script:Workspace) 'Repeated stopping must not act on another process.'
    }

    foreach ($pathCase in @(
        @{ name = 'Start accepts working and log directories containing spaces'; working = 'plain working directory'; logs = 'plain log directory' },
        @{ name = 'Start treats bracketed log directories as literal paths'; working = 'plain working directory'; logs = 'bracketed [literal] log directory' },
        @{ name = 'Start treats bracketed working directories as literal paths'; working = 'bracketed [literal] working directory'; logs = 'plain log directory' }
    )) {
        Invoke-Case $pathCase.name {
            $working = Join-Path $script:FixtureRoot $pathCase.working
            $logs = Join-Path $script:FixtureRoot $pathCase.logs
            [IO.Directory]::CreateDirectory((Assert-InFixture $working)) | Out-Null
            [IO.Directory]::CreateDirectory((Assert-InFixture $logs)) | Out-Null
            $started = Start-ModuleFixture (New-FixtureSpec) -Workspace $script:FixtureRoot `
                -WorkingDirectory $working -LogDirectory $logs
            Assert-Equal $started.ready.cwd $working 'The child did not enter the exact requested literal working directory.'
            $null = Wait-FixtureLog $started.record.stdout "fixture stdout $($started.spec.nonce)"
            $null = Wait-FixtureLog $started.record.stderr "fixture stderr $($started.spec.nonce)"
            Assert-True (Stop-LocalOwnedProcess -Record $started.record -Workspace $script:FixtureRoot) 'The literal-path fixture must stop through its exact ownership record.'
            Assert-True ($started.owned.process.WaitForExit(5000)) 'The literal-path fixture did not exit.'
        }
    }

    Invoke-Case 'failed-start rollback results preserve the original error and require both success signals' {
        # Pure result-handling cases, not injected failures in Windows kernel
        # calls. No process handles or actual termination failures are fabricated.
        $launcher = 'ECorp.LocalLiteralLauncher' -as [type]
        Assert-True ($null -ne $launcher) 'The actual literal launcher must have loaded.'
        $method = $launcher.GetMethod('RecordRollbackResult', [Reflection.BindingFlags]'NonPublic,Static')
        Assert-True ($null -ne $method) 'The native rollback result handler must exist.'
        foreach ($case in @(
            @{ terminated = $true; wait = [uint32]0; verified = $true },
            @{ terminated = $false; wait = [uint32]0; verified = $false },
            @{ terminated = $true; wait = [uint32]258; verified = $false },
            @{ terminated = $false; wait = [uint32]258; verified = $false },
            @{ terminated = $true; wait = [uint32]::MaxValue; verified = $false },
            @{ terminated = $false; wait = [uint32]::MaxValue; verified = $false }
        )) {
            $cause = [InvalidOperationException]::new('synthetic inner cause')
            $failure = [InvalidOperationException]::new('synthetic original startup failure', $cause)
            $terminationError = if ($case.terminated) { 0 } else { 5 }
            $waitError = if ($case.wait -eq [uint32]::MaxValue) { 6 } else { 0 }
            $verified = $method.Invoke($null, [object[]]@(
                $failure, [bool]$case.terminated, [int]$terminationError, [uint32]$case.wait, [int]$waitError))
            Assert-Equal $verified $case.verified 'Rollback must not be verified if termination or waiting failed.'
            Assert-Equal $failure.Data['LocalStackRollbackVerified'] $case.verified 'The original exception must disclose rollback verification status.'
            Assert-Equal $failure.Data['LocalStackRollbackTerminateSucceeded'] $case.terminated 'The native termination result must remain observable.'
            Assert-Equal $failure.Data['LocalStackRollbackTerminationError'] $terminationError 'The native termination error must be preserved.'
            Assert-Equal $failure.Data['LocalStackRollbackWaitResult'] $case.wait 'The native wait result must be preserved.'
            Assert-Equal $failure.Data['LocalStackRollbackWaitError'] $waitError 'The native wait error must be preserved.'
            Assert-Equal $failure.Message 'synthetic original startup failure' 'Rollback reporting must not replace the startup error.'
            Assert-True ([object]::ReferenceEquals($failure.InnerException, $cause)) 'Rollback reporting must preserve the original inner exception.'
        }
    }

    Invoke-Case 'Start preserves literal arguments, spaces, child-only environment and redacted evidence' {
        $sentinel = 'synthetic-not-a-database-' + [guid]::NewGuid().ToString('N')
        $script:Sentinels.Add($sentinel)
        [Environment]::SetEnvironmentVariable('ECORP_LOCAL_STACK_TEST_AMBIENT', $sentinel, 'Process')
        [Environment]::SetEnvironmentVariable('ECORP_LOCAL_STACK_TEST_REMOVED', $sentinel, 'Process')
        try {
            $arguments = @('one argument with spaces', '[literal]*?;&$HOME', '"quoted value"', 'C:\trailing space path\', '')
            $started = Start-ModuleFixture (New-FixtureSpec -Extra $arguments) -Environment @{
                ECORP_LOCAL_STACK_TEST_SENTINEL = $sentinel
                DATABASE_URL = $sentinel
                ECORP_LOCAL_STACK_TEST_REMOVED = $null
            }
            Assert-Equal $started.ready.cwd $script:Workspace 'WorkingDirectory must be a literal path containing spaces and brackets.'
            Assert-Equal ($started.ready.arguments | ConvertTo-Json -Compress) ($arguments | ConvertTo-Json -Compress) 'Argument boundaries, quotes and empty arguments must survive.'
            $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($sentinel))).ToLowerInvariant()
            Assert-Equal $started.ready.sentinel_digest $digest 'The explicitly supplied environment canary did not reach the child.'
            Assert-Equal $started.ready.database_digest $digest 'The synthetic database canary must travel through environment only.'
            Assert-False $started.ready.ambient_present 'An unapproved ambient canary leaked into the child.'
            Assert-False $started.ready.removed_present 'A null environment override must remove the inherited name.'
            Assert-True ($null -eq [Environment]::GetEnvironmentVariable('DATABASE_URL', 'Process')) 'Start must not mutate the supervisor database environment.'
            Assert-True ($null -eq [Environment]::GetEnvironmentVariable('ECORP_LOCAL_STACK_TEST_SENTINEL', 'Process')) 'Start must not mutate the supervisor canary environment.'
            $stdout = Wait-FixtureLog $started.record.stdout "fixture stdout $($started.spec.nonce)"
            $stderr = Wait-FixtureLog $started.record.stderr "fixture stderr $($started.spec.nonce)"
            $statePath = Join-Path $script:Workspace 'redacted state.json'
            Save-LocalStackState -Path $statePath -Workspace $script:Workspace -State @{ processes = @{ fixture = $started.record } }
            foreach ($text in @($stdout, $stderr, ($started.output | Out-String),
                ($started.record | ConvertTo-Json -Depth 12), [IO.File]::ReadAllText($statePath),
                [IO.File]::ReadAllText($started.spec.ready))) {
                Assert-False ($text.Contains($sentinel)) 'A synthetic environment canary leaked into arguments, logs, state, record or diagnostics.'
            }
            Assert-True (Test-LocalOwnedProcess -Record $started.record -Workspace $script:Workspace) 'The Start record must be usable as exact ownership evidence.'
            Assert-True (Stop-LocalOwnedProcess -Record $started.record -Workspace $script:Workspace) 'The module-started child must stop through its exact record.'
            Assert-True ($started.owned.process.WaitForExit(5000)) 'The module-started child did not exit.'
        } finally {
            Remove-Item -LiteralPath Env:ECORP_LOCAL_STACK_TEST_AMBIENT -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath Env:ECORP_LOCAL_STACK_TEST_REMOVED -ErrorAction SilentlyContinue
        }
    }

    Invoke-Case 'repeated role launches retain earlier logs and allocate unique stdout/stderr files' {
        $historical = Join-Path $script:LogDirectory 'literal-fixture.stdout.log'
        Write-FixtureFile $historical 'historical log must survive'
        $first = Start-ModuleFixture (New-FixtureSpec)
        $firstOut = Wait-FixtureLog $first.record.stdout "fixture stdout $($first.spec.nonce)"
        $firstErr = Wait-FixtureLog $first.record.stderr "fixture stderr $($first.spec.nonce)"
        Assert-True (Stop-LocalOwnedProcess -Record $first.record -Workspace $script:Workspace) 'First exact record should stop.'
        $second = Start-ModuleFixture (New-FixtureSpec)
        $null = Wait-FixtureLog $second.record.stdout "fixture stdout $($second.spec.nonce)"
        $null = Wait-FixtureLog $second.record.stderr "fixture stderr $($second.spec.nonce)"
        $paths = @($first.record.stdout, $first.record.stderr, $second.record.stdout, $second.record.stderr)
        Assert-Equal (@($paths | Sort-Object -Unique).Count) 4 'Each launch and stream needs a distinct log file.'
        Assert-Equal ([IO.File]::ReadAllText($first.record.stdout)) $firstOut 'A later launch changed the earlier stdout log.'
        Assert-Equal ([IO.File]::ReadAllText($first.record.stderr)) $firstErr 'A later launch changed the earlier stderr log.'
        Assert-Equal ([IO.File]::ReadAllText($historical)) 'historical log must survive' 'A launch deleted a historical log.'
        Assert-True (Stop-LocalOwnedProcess -Record $second.record -Workspace $script:Workspace) 'Second exact record should stop.'
    }

    foreach ($rollbackMode in @('verified', 'unverified')) {
        Invoke-Case "extracted Launch preserves ownership on save failure ($rollbackMode rollback)" {
            $tokens = $null
            $errors = $null
            $starter = [Management.Automation.Language.Parser]::ParseFile(
                (Join-Path $PSScriptRoot 'local_stack_start.ps1'), [ref]$tokens, [ref]$errors)
            Assert-Equal $errors.Count 0 'The starter must parse before extracting Launch.'
            $definitions = @($starter.FindAll({ param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Launch'
            }, $true))
            Assert-Equal $definitions.Count 1 'Exactly one production Launch function must be exercised.'
            $definition = $definitions[0]
            # Never dot-source/run the starter. Refuse any expansion of this
            # extracted function into service, network, or credential operations.
            foreach ($command in $definition.FindAll({ param($node)
                $node -is [Management.Automation.Language.CommandAst]
            }, $true)) {
                Assert-True ($command.GetCommandName() -in @(
                    'Role-Live', 'Select-Object', 'Start-LocalOwnedProcess',
                    'Save-State', 'Stop-LocalOwnedProcess', 'Write-Warning',
                    'Assert-LocalStackProcesses', 'Ensure-FreePort'
                )) 'The extracted Launch function contains an operation outside this synthetic fixture.'
            }
            . ([scriptblock]::Create($definition.Extent.Text))

            $root = $script:Workspace
            $logs = $script:LogDirectory
            $role = 'runner'
            $statePath = Join-Path $root "launch $rollbackMode save failure [literal].json"
            $unrelated = $guardRecord.Clone()
            $unrelated.role = 'server'
            $state = @{
                processes = @{ server = $unrelated }
                previous_processes = @()
            }
            Save-LocalStackState -Path $statePath -Workspace $root -State $state
            $before = [IO.File]::ReadAllText($statePath)
            $context = @{
                role = $role; spec = (New-FixtureSpec); fixture = $null; saveFailure = $null
                stopRecord = $null; stopWorkspace = $null
                stopFailure = [InvalidOperationException]::new('synthetic exact-root rollback failure')
            }
            function Role-Live([string]$Role) {
                $record = if ($state.processes.ContainsKey($Role)) { $state.processes[$Role] } else { $null }
                Test-LocalOwnedProcess -Record $record -Workspace $root
            }
            function Save-State {
                $record = $state.processes[$context.role]
                $ready = Wait-FixtureJson $context.spec.ready
                Assert-Equal ([int]$ready.process_id) ([int]$record.pid) 'The Launch record must identify this synthetic child.'
                $owned = Register-FixtureHandle ([Diagnostics.Process]::GetProcessById([int]$record.pid)) $context.spec
                Assert-FixtureReady $ready $owned $context.spec
                $context.fixture = @{ owned = $owned; ready = $ready; spec = $context.spec }
                $null = Wait-FixtureLog $record.stdout "fixture stdout $($context.spec.nonce)"
                $null = Wait-FixtureLog $record.stderr "fixture stderr $($context.spec.nonce)"
                try {
                    # Actual writer + Windows sharing denial, not a mocked save.
                    Save-LocalStackState -Path $statePath -Workspace $root -State $state
                } catch {
                    $context.saveFailure = $_
                    throw
                }
            }
            if ($rollbackMode -eq 'unverified') {
                # Simulate only the rollback error. The child is real, remains
                # on a held verified handle, and is reaped by fixture cleanup.
                function Stop-LocalOwnedProcess([hashtable]$Record, [string]$Workspace) {
                    $context.stopRecord = $Record
                    $context.stopWorkspace = $Workspace
                    throw $context.stopFailure
                }
            }

            $lock = [IO.File]::Open($statePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $failure = $null
            try {
                try {
                    Launch $role $script:NodeExecutable $context.spec.arguments $root @{} *>&1 | Out-Null
                } catch { $failure = $_ }
            } finally { $lock.Dispose() }
            Assert-True ($null -ne $context.saveFailure) 'The real state writer must hit the deliberately locked destination.'
            Assert-True ($null -ne $failure) 'Launch must rethrow the persistence failure, not report startup success.'
            Assert-True ([object]::ReferenceEquals(
                $failure.Exception.GetBaseException(), $context.saveFailure.Exception.GetBaseException()
            )) 'Rollback must preserve the original persistence error/cause.'
            $diagnostic = $failure.Exception
            while ($diagnostic -and !$diagnostic.Data.Contains('LocalStackNewProcessRecord')) {
                $diagnostic = $diagnostic.InnerException
            }
            Assert-True ($null -ne $diagnostic) 'The original exception must retain the exact unsaved ownership record.'
            $record = $diagnostic.Data['LocalStackNewProcessRecord']
            Assert-True ($record -is [hashtable]) 'Retained cleanup authority must be a process-record hashtable.'
            Assert-Equal ([int]$record.pid) $context.fixture.owned.process_id 'The retained record must name only the newly created child.'
            Assert-Equal $record.workspace $root 'The retained record must preserve its workspace.'
            Assert-Equal ([DateTimeOffset]$record.started_utc).UtcTicks $context.fixture.owned.creation.Ticks 'The retained record must preserve exact process creation time.'
            Assert-Equal $record.executable $context.fixture.owned.executable 'The retained record must preserve its executable.'
            Assert-Equal ([IO.File]::ReadAllText($statePath)) $before 'A failed launch save must not change existing state bytes.'
            Assert-FixtureAlive $guard
            Assert-True ([IO.File]::Exists($record.stdout) -and [IO.File]::Exists($record.stderr)) 'Rollback must retain both newly created log files.'
            Assert-Equal (@(Get-ChildItem -LiteralPath $root -Filter '*.tmp').Count) 0 'Failed persistence must clean only its temporary state file.'
            if ($rollbackMode -eq 'verified') {
                Assert-True $diagnostic.Data['LocalStackPersistenceRollbackVerified'] 'A successful exact-root rollback must be explicitly verified.'
                Assert-True ($context.fixture.owned.process.WaitForExit(5000)) 'The actual newly launched child must be reaped on persistence failure.'
                Assert-Equal $record.stop_outcome 'startup_persistence_rollback' 'The retained record must explain why this child was stopped.'
                Assert-True ($null -eq $state[$role]) 'The failed role must not remain advertised as running.'
            } else {
                Assert-False $diagnostic.Data['LocalStackPersistenceRollbackVerified'] 'A failed rollback must never claim verified cleanup.'
                Assert-True ([object]::ReferenceEquals($context.stopRecord, $record)) 'Rollback must target only the exact newly created record.'
                Assert-Equal $context.stopWorkspace $root 'Rollback must use the original workspace.'
                Assert-Equal $diagnostic.Data['LocalStackPersistenceRollbackError'].Message $context.stopFailure.Message 'The secondary rollback error must remain observable without replacing the save error.'
                Assert-FixtureAlive $context.fixture
                Stop-FixtureHandle $context.fixture.owned
            }
        }
    }

    Invoke-Case 'v2 state round-trips nested records and read preserves exact bytes' {
        $statePath = Join-Path $script:Workspace 'round trip [literal].json'
        Assert-True ($null -eq (Read-LocalStackState -Path $statePath -Workspace $script:Workspace)) 'A missing state file must return null.'
        Save-LocalStackState -Path $statePath -Workspace $script:Workspace -State @{
            processes = @{ fixture = $guardRecord }; metadata = @{ marker = 'generation one' }
        }
        $before = [IO.File]::ReadAllText($statePath)
        $state = Read-LocalStackState -Path $statePath -Workspace $script:Workspace
        Assert-True ($state -is [hashtable]) 'Read must return a hashtable.'
        Assert-Equal $state.schema_version 2 'The state schema must be version 2.'
        Assert-Equal $state.workspace $script:Workspace 'State must bind its explicit workspace.'
        Assert-Equal $state.metadata.marker 'generation one' 'Nested state did not round-trip.'
        Assert-True (Test-LocalOwnedProcess -Record $state.processes.fixture -Workspace $script:Workspace) 'Serialization must retain exact live process identity.'
        Assert-Equal ([IO.File]::ReadAllText($statePath)) $before 'Reading state must not rewrite it.'
        Assert-ReadRefused $statePath ($script:Workspace + '-neighbor')
        Assert-Equal ([IO.File]::ReadAllText($statePath)) $before 'Foreign reads must not change the state.'
        $state.metadata.marker = 'generation two'
        Save-LocalStackState -Path $statePath -Workspace $script:Workspace -State $state
        $updated = Read-LocalStackState -Path $statePath -Workspace $script:Workspace
        Assert-Equal $updated.metadata.marker 'generation two' 'Replacing existing state did not persist the complete update.'
        Assert-Equal (@(Get-ChildItem -LiteralPath $script:Workspace -Filter '*.tmp').Count) 0 'Successful replacement left a temporary state file.'
        Assert-FixtureAlive $guard
    }

    Invoke-Case 'corrupt, unsupported and differently scoped state is refused without deleting evidence' {
        $statePath = Join-Path $script:Workspace 'invalid state.json'
        foreach ($text in @(
            '{broken json', 'null', '42', '[]',
            '{"schema_version":3,"workspace":"not-this-workspace","processes":{}}',
            (@{ schema_version = 2; workspace = $script:Workspace; processes = 'invalid' } | ConvertTo-Json),
            (@{ schema_version = 2; processes = @{} } | ConvertTo-Json)
        )) {
            Write-FixtureFile $statePath $text
            Assert-ReadRefused $statePath $script:Workspace
            Assert-Equal ([IO.File]::ReadAllText($statePath)) $text 'Rejected state was removed or silently repaired.'
        }
        Assert-FixtureAlive $guard
    }

    Invoke-Case 'state writes reject traversal, sibling-prefix paths and foreign workspace claims' {
        $sibling = Join-Path $script:FixtureRoot 'workspace with spaces [literal]-neighbor'
        [IO.Directory]::CreateDirectory($sibling) | Out-Null
        foreach ($outside in @(
            (Join-Path $script:FixtureRoot 'outside state.json'),
            (Join-Path $script:Workspace '..\traversal state.json'),
            (Join-Path $sibling 'prefix collision.json')
        )) {
            Write-FixtureFile $outside 'outside evidence'
            Assert-Throws { Save-LocalStackState -Path $outside -State @{ processes = @{} } -Workspace $script:Workspace } 'A state write escaped the explicit workspace.'
            Assert-Equal ([IO.File]::ReadAllText($outside)) 'outside evidence' 'A rejected write changed a file outside its workspace.'
        }
        $inside = Join-Path $script:Workspace 'foreign scoped state.json'
        Write-FixtureFile $inside 'inside evidence'
        Assert-Throws { Save-LocalStackState -Path $inside -State @{ workspace = $sibling; processes = @{} } -Workspace $script:Workspace } 'A foreign state workspace must be rejected.'
        Assert-Equal ([IO.File]::ReadAllText($inside)) 'inside evidence' 'Rejected foreign state overwrote prior evidence.'
    }

    Invoke-Case 'state writes reject reparse-point parent directories' {
        $outside = Join-Path $script:FixtureRoot 'junction destination'
        $junction = Join-Path $script:Workspace 'redirect [literal]'
        [IO.Directory]::CreateDirectory($outside) | Out-Null
        $null = Assert-InFixture $junction
        New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
        $script:Junctions.Add($junction)
        $evidence = Join-Path $outside 'state.json'
        Write-FixtureFile $evidence 'junction target evidence'
        Assert-Throws { Save-LocalStackState -Path (Join-Path $junction 'state.json') -Workspace $script:Workspace -State @{ processes = @{} } } 'A reparse-point parent must not redirect the writer.'
        Assert-Equal ([IO.File]::ReadAllText($evidence)) 'junction target evidence' 'The junction destination was modified.'
    }

    Invoke-Case 'a failed atomic replacement preserves old bytes and removes its temporary file' {
        $statePath = Join-Path $script:Workspace 'locked state.json'
        Save-LocalStackState -Path $statePath -Workspace $script:Workspace -State @{ processes = @{}; marker = 'before' }
        $before = [IO.File]::ReadAllText($statePath)
        $lock = [IO.File]::Open($statePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            Assert-Throws { Save-LocalStackState -Path $statePath -Workspace $script:Workspace -State @{ processes = @{}; marker = 'after' } } 'A replacement must fail when the target denies delete sharing.'
        } finally { $lock.Dispose() }
        Assert-Equal ([IO.File]::ReadAllText($statePath)) $before 'A failed replacement damaged the previous state.'
        Assert-Equal (@(Get-ChildItem -LiteralPath $script:Workspace -Filter '*.tmp').Count) 0 'A failed replacement left temporary files.'
    }

    Invoke-Case 'concurrent synthetic reader observes only complete atomic state generations' {
        $statePath = Join-Path $script:Workspace 'concurrent state.json'
        $readerLease = Join-Path $script:FixtureRoot 'reader lease'
        $resultPath = Join-Path $script:FixtureRoot 'reader result.json'
        Write-FixtureFile $readerLease 'reader lease'
        $makeState = { param([int]$Generation)
            @{ processes = @{}; generation = $Generation; proof = "generation-$Generation"
                payload = ([string]($Generation % 10)) * 65536 }
        }
        Save-LocalStackState -Path $statePath -Workspace $script:Workspace -State (& $makeState 0)
        $reader = Start-Fixture (New-FixtureSpec -Mode 'reader' -Extra @($statePath, $resultPath, $readerLease))
        try {
            for ($generation = 1; $generation -le 24; $generation++) {
                # Windows may reject an atomic rename while a reader has the
                # destination open. Retry that safe failure; never accept a
                # missing/torn snapshot or require destructive lock breaking.
                $saved = $false
                for ($attempt = 0; $attempt -lt 30 -and !$saved; $attempt++) {
                    try {
                        Save-LocalStackState -Path $statePath -Workspace $script:Workspace -State (& $makeState $generation)
                        $saved = $true
                    } catch [IO.IOException] {
                        Start-Sleep -Milliseconds 10
                    } catch [UnauthorizedAccessException] {
                        Start-Sleep -Milliseconds 10
                    }
                }
                Assert-True $saved 'Atomic replacement never completed within the bounded reader-contention retries.'
                Start-Sleep -Milliseconds 5
            }
        } finally {
            $null = Assert-InFixture $readerLease
            Remove-Item -LiteralPath $readerLease -Force
        }
        $result = Wait-FixtureJson $resultPath
        Assert-True ($reader.owned.process.WaitForExit(5000)) 'The bounded reader fixture did not exit.'
        Assert-Equal $reader.owned.process.ExitCode 0 'The reader fixture failed.'
        Assert-True ($result.reads -gt 1 -and $result.distinct_generations -gt 1) 'The reader must overlap multiple actual state generations.'
        Assert-Equal $result.failures 0 'A concurrent reader observed missing, malformed or torn state.'
    }

    Invoke-Case 'legacy numeric state stays read-only and never authorizes stopping' {
        $statePath = Join-Path $script:Workspace 'legacy numeric state.json'
        $original = @{ server = $guard.owned.process_id; runner = $null; factoryController = $null; web = $null } | ConvertTo-Json
        Write-FixtureFile $statePath $original
        $legacy = Read-LocalStackState -Path $statePath -Workspace $script:Workspace
        Assert-True ($legacy -is [hashtable]) 'Legacy numeric state must remain readable for diagnostics.'
        Assert-Equal ([int]$legacy.server) $guard.owned.process_id 'Legacy diagnostics lost the historical PID.'
        Assert-Equal ([IO.File]::ReadAllText($statePath)) $original 'Reading legacy data must not upgrade or delete it.'
        $insufficient = @{ workspace = $script:Workspace; pid = $legacy.server }
        Assert-False (Test-LocalOwnedProcess -Record $insufficient -Workspace $script:Workspace) 'Legacy PID-only state is not ownership evidence.'
        Assert-False (Stop-LocalOwnedProcess -Record $insufficient -Workspace $script:Workspace) 'Legacy PID-only state must not stop the live fixture.'
        Assert-FixtureAlive $guard
        $rawLegacy = $original | ConvertFrom-Json -AsHashtable
        foreach ($candidate in @(
            $legacy, $rawLegacy,
            @{ schema_version = 1; workspace = $script:Workspace; processes = @{ fixture = $guardRecord } },
            @{ schema_version = 2; workspace = $script:Workspace; processes = $rawLegacy }
        )) {
            $before = $candidate | ConvertTo-Json -Depth 12 -Compress
            Assert-Throws { Save-LocalStackState -Path $statePath -Workspace $script:Workspace -State $candidate } 'Legacy numeric state must not be silently rewritten as v2 authority.'
            Assert-Equal ($candidate | ConvertTo-Json -Depth 12 -Compress) $before 'Rejecting legacy state must not mutate the caller record.'
            Assert-Equal ([IO.File]::ReadAllText($statePath)) $original 'The legacy numeric evidence must remain read-only.'
            Assert-FixtureAlive $guard
        }
    }
    Invoke-StartupCases
}

function Invoke-StartupCases {
    Invoke-Case 'database URI maps to exact child-only libpq fields without default-host fallback' {
        $module = Get-Module local_stack
        $values = & $module { Get-LocalDatabaseEnvironment 'postgresql://fixture:p%40ss@[::1]:57570/fixture%20db?sslmode=require' }
        Assert-Equal $values.PGHOST '::1' 'IPv6 host must map exactly.'
        Assert-Equal $values.PGPORT '57570' 'The explicit fixture port must not fall back to 5432.'
        Assert-Equal $values.PGDATABASE 'fixture db' 'The decoded database name must not be a URI.'
        Assert-Equal $values.PGUSER 'fixture' 'The configured principal must be explicit.'
        Assert-Equal $values.PGPASSWORD 'p@ss' 'Escaped authentication data must stay in the private child environment.'
        Assert-Equal $values.PGSSLMODE 'require' 'Native TLS configuration must be preserved.'
        Assert-Equal $values.PGOPTIONS '-c default_transaction_read_only=on -c statement_timeout=5000' 'The check must impose read-only execution and its exact statement timeout.'
        Assert-Equal $values.PGCONNECT_TIMEOUT '5' 'The check must use its bounded native connection timeout.'
        foreach ($suffix in @('?host=elsewhere','?options=unsafe','?SSLMODE=require','?sslmode=require&sslmode=disable')) {
            Assert-Throws { & $module {param($suffix) Get-LocalDatabaseEnvironment ("postgresql://fixture@127.0.0.1:57570/fixture$suffix")} $suffix } 'Ambiguous or unsupported connection options must fail before any connection.'
        }
    }
    Invoke-Case 'runner identity uses the exact native 128 UTF-8 byte ceiling' {
        Assert-LocalRunnerIdentity ('a' * 128)
        Assert-LocalRunnerIdentity (([string][char]0xE9) * 64)
        foreach ($invalid in @('', ' ', ('a' * 129), (([string][char]0xE9) * 65), "runner`nother")) {
            Assert-Throws { Assert-LocalRunnerIdentity $invalid } 'Invalid or oversized runner identity was accepted.'
        }
    }
    $blocker = Join-Path $script:FixtureRoot 'regular file [ancestor]'
    Write-FixtureFile $blocker 'retained ancestor bytes'
    foreach ($directory in @($false, $true)) {
        Invoke-Case "absent path below a regular-file ancestor rejects (Directory=$directory)" {
            $failure = $null
            try { Assert-LocalStackPath -Path (Join-Path $blocker 'absent\leaf') -Directory:$directory }
            catch { $failure = $_.Exception.Message }
            Assert-Equal $failure "Expected a directory: $blocker" 'An existing ancestor must be a directory for both file and directory requests.'
        }
    }
    $workspace = Join-Path $script:FixtureRoot 'startup'
    $source = Join-Path $script:FixtureRoot 'source'
    foreach ($directory in @($workspace,$source,(Join-Path $workspace 'tools'),
        (Join-Path $workspace 'output\runner'),(Join-Path $workspace 'target\debug'),
        (Join-Path $workspace 'apps\web\node_modules\vite\bin'))) {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    $providerTarget = Join-Path $script:FixtureRoot 'provider-target'
    [IO.Directory]::CreateDirectory($providerTarget) | Out-Null
    $providerRedirect = Join-Path $workspace 'provider-redirect'
    New-Item -ItemType Junction -Path $providerRedirect -Target $providerTarget | Out-Null
    $script:Junctions.Add($providerRedirect)
    Invoke-Case 'path validation permits absent descendants and explicit dependency junctions' {
        Assert-LocalStackPath -Path (Join-Path $workspace 'absent\directory') -Directory
        Assert-LocalStackPath -Path (Join-Path $workspace 'absent\file.json')
        Assert-LocalStackPath -Path $blocker -Required
        $dependency = Join-Path $providerTarget 'dependency.js'
        Write-FixtureFile $dependency 'synthetic dependency'
        Assert-Throws { Assert-LocalStackPath -Path (Join-Path $providerRedirect 'dependency.js') -Required } 'Ordinary paths must still reject junction ancestors.'
        Assert-LocalStackPath -Path (Join-Path $providerRedirect 'dependency.js') -Required -AllowDependencyLink
    }
    & git -C $source init --quiet
    if ($LASTEXITCODE) { throw 'Could not initialize disposable source.' }
    Write-FixtureFile (Join-Path $source 'fixture.txt') 'owned startup fixture'
    & git -C $source add fixture.txt
    & git -C $source -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m fixture
    if ($LASTEXITCODE) { throw 'Could not commit disposable source.' }
    $nativeRef = 'refs/heads/F02.A_z-09@x{y}'
    $boundaryRef = 'refs/heads/' + ('a' * 120) + '/' + ('b' * 124)
    $invalidRefs = @(
        @{name='Unicode';ref="refs/heads/review-$([char]0xE9)"},
        @{name='257-byte';ref=($boundaryRef + 'b')}
    )
    $commit = & git -C $source rev-parse --verify HEAD
    if ($LASTEXITCODE) { throw 'Could not resolve disposable source.' }
    # Keep Windows path limits from masking the native 256-byte ref contract.
    # This is configuration in the owned Git fixture, not the operator profile.
    & git -C $source config core.longpaths true
    if ($LASTEXITCODE) { throw 'Could not configure owned source-ref fixture.' }
    foreach ($ref in @($nativeRef,$boundaryRef,$boundaryRef.Substring(0,255)) + @($invalidRefs.ref)) {
        & git -C $source update-ref $ref $commit
        if ($LASTEXITCODE) { throw 'Could not create owned source-ref fixture.' }
    }
    Invoke-Case 'generic source resolver accepts the existing Factory-compatible Unicode Git ref' {
        $ref = $invalidRefs[0].ref
        $resolved = & git -C $source rev-parse --verify --end-of-options "$ref^{commit}"
        Assert-Equal $LASTEXITCODE 0 'The owned Unicode ref must exist in Git.'
        Assert-Equal $resolved $commit 'The owned Unicode ref must resolve to the fixture commit.'
        Assert-Equal (Get-LocalSourceCommit $source $ref) $commit 'Generic resolution must not impose the runner-only ASCII contract on Factory.'
    }
    Invoke-Case 'generic source resolver accepts a real SHA-256 Git commit' {
        $sha256Source = Join-Path $script:FixtureRoot 'source-sha256'
        [IO.Directory]::CreateDirectory($sha256Source) | Out-Null
        & git -C $sha256Source init --quiet --object-format=sha256
        if ($LASTEXITCODE) { throw 'Could not initialize the owned SHA-256 source.' }
        Write-FixtureFile (Join-Path $sha256Source 'fixture.txt') 'owned SHA-256 startup fixture'
        & git -C $sha256Source add fixture.txt
        if ($LASTEXITCODE) { throw 'Could not stage the owned SHA-256 source.' }
        & git -C $sha256Source -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m fixture
        if ($LASTEXITCODE) { throw 'Could not commit the owned SHA-256 source.' }
        $sha256Commit = & git -C $sha256Source rev-parse --verify HEAD
        Assert-Equal $LASTEXITCODE 0 'The real SHA-256 fixture must resolve.'
        Assert-True ($sha256Commit -cmatch '^[0-9a-f]{64}$') 'The fixture must use an actual 64-character commit.'
        Assert-Equal (Get-LocalSourceCommit $sha256Source HEAD) $sha256Commit 'Startup must accept the native supported SHA-256 commit.'
    }
    & git -C $source update-ref 'refs/heads/-F02' $commit
    if ($LASTEXITCODE) { throw 'Could not create owned leading-dash ref.' }
    $resolved = & git -C $source rev-parse --verify --end-of-options '-F02^{commit}'
    if ($LASTEXITCODE -or $resolved -cne $commit) { throw 'Leading-dash negative control must genuinely resolve in owned Git.' }
    foreach ($case in @(
        @{name='whitespace';ref=" `t"},
        @{name='leading-dash';ref='-F02'},
        @{name='CR';ref="HEAD`r"},
        @{name='LF';ref="HEAD`n"}
    )) {
        Invoke-Case "generic source resolver preserves original $($case.name) rejection" {
            $failure = $null
            try { Get-LocalSourceCommit $source $case.ref | Out-Null }
            catch { $failure = $_.Exception.Message }
            Assert-Equal $failure "Invalid source ref for repository: $source" 'The original common ref boundary must reject before Git lookup.'
        }
    }
    Invoke-Case 'generic source resolver rejects empty input' {
        Assert-Throws { Get-LocalSourceCommit $source '' } 'Empty generic refs must remain rejected.'
    }
    foreach ($case in $invalidRefs) {
        $resolved = & git -C $source rev-parse --verify --end-of-options "$($case.ref)^{commit}"
        if ($LASTEXITCODE -or $resolved -cne $commit) { throw 'Invalid native ref must genuinely resolve in owned Git.' }
        Invoke-Case "native source ref rejects real $($case.name) Git ref" {
            $failure = $null
            try { Assert-LocalRunnerSourceRef -Repository $source -Ref $case.ref }
            catch { $failure = $_.Exception.Message }
            Assert-Equal $failure "Invalid source ref for repository: $source" 'Git resolution must not bypass the native ref contract.'
        }
    }
    Invoke-Case 'native source ref accepts exact syntax and 255/256 UTF-8 byte boundaries' {
        Assert-Equal ([Text.Encoding]::UTF8.GetByteCount($boundaryRef)) 256 'The fixture must reach the exact native byte ceiling.'
        foreach ($ref in @($nativeRef,$boundaryRef,$boundaryRef.Substring(0,255),'HEAD','HEAD^0','HEAD~0','HEAD@{0}','HEAD^{commit}')) {
            Assert-LocalRunnerSourceRef -Repository $source -Ref $ref
            Assert-Equal (Get-LocalSourceCommit $source $ref) $commit 'Permitted native syntax must resolve without substitution.'
        }
    }
    Invoke-Case 'native source ref rejects every forbidden ASCII character and non-ASCII case folds' {
        $invalid = @('','-HEAD',('a' * 257),"review-$([char]0x212A)","review-$([char]0x130)","review-e$([char]0x301)")
        foreach ($number in 0..127) {
            $character = [char]$number
            if (!(([int]$character -ge 48 -and [int]$character -le 57) -or
                ([int]$character -ge 65 -and [int]$character -le 90) -or
                ([int]$character -ge 97 -and [int]$character -le 122) -or
                '._/@{}^~-'.Contains($character))) { $invalid += "HEAD$character" }
        }
        foreach ($ref in $invalid) {
            $failure = $null
            try { Assert-LocalRunnerSourceRef -Repository $source -Ref $ref }
            catch { $failure = $_.Exception.Message }
            Assert-Equal $failure "Invalid source ref for repository: $source" 'Unsupported characters must fail at the native contract guard, not at Git.'
        }
    }
    foreach ($name in @('start_local.ps1','local_stack_start.ps1','local_stack_operation.ps1','local_stack.psm1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $workspace "tools\$name")
    }
    # Replace only the external database transport and child entrypoint in the
    # disposable copy. Production validation, control flow and ownership remain.
    $mock = @'

function Invoke-LocalDatabaseRead {
    param($DatabaseUrl, $Query)
    if (!$Query.StartsWith("BEGIN READ ONLY;") -or !$Query.TrimEnd().EndsWith('ROLLBACK;') -or
        $Query -notmatch 'r\.revoked_at IS NULL' -or $Query -notmatch 'r\.expires_at > now\(\)' -or
        $Query -notmatch 'r\.token_hash = ''[0-9a-f]{64}''' -or
        $Query -match '(?i)\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b') {
        throw 'Unsafe database check'
    }
    if ($env:ECORP_LOCAL_STACK_TEST_DATABASE_DENIED -eq '1') { throw 'Synthetic denied database' }
    @{ database='fixture'; identity_valid=$true }
}
$script:NativeFixtureStart = ${function:Start-LocalOwnedProcess}
function Start-LocalOwnedProcess {
    param($Role,$Workspace,$FilePath,$ArgumentList,$WorkingDirectory,$LogDirectory,$Environment)
    $fixture = Get-Content -LiteralPath (Join-Path $Workspace 'startup-fixture.json') -Raw | ConvertFrom-Json -AsHashtable
    $ready = Join-Path $Workspace "$Role-$([guid]::NewGuid().ToString('N'))-ready.json"
    $record = & $script:NativeFixtureStart -Role $Role -Workspace $Workspace -FilePath $fixture.node `
        -ArgumentList @($fixture.script,'worker',$fixture.lease,$ready,$fixture.nonce) `
        -WorkingDirectory $Workspace -LogDirectory $LogDirectory -Environment @{}
    $record.fixture_ready = $ready
    $record
}
$script:NativeFixtureStop = ${function:Stop-LocalOwnedProcess}
function Stop-LocalOwnedProcess {
    param($Record,$Workspace)
    if ($Record.role -ceq $env:ECORP_LOCAL_STACK_TEST_STOP_ROLE) {
        throw 'Synthetic second-stop failure'
    }
    & $script:NativeFixtureStop -Record $Record -Workspace $Workspace
}
Export-ModuleMember -Function Start-LocalOwnedProcess, Stop-LocalOwnedProcess
'@
    $modulePath = Join-Path $workspace 'tools\local_stack.psm1'
    Write-FixtureFile $modulePath ([IO.File]::ReadAllText($modulePath) + $mock)
    foreach ($path in @('target\debug\crony-server.exe','target\debug\crony-runner.exe','target\debug\crony-cli.exe','apps\web\node_modules\vite\bin\vite.js')) {
        Write-FixtureFile (Join-Path $workspace $path) 'synthetic entrypoint replaced by owned Node fixture'
    }
    $corp = '00000000-0000-4000-8000-000000000230'
    $actor = '00000000-0000-4000-8000-000000000231'
    $credentialPath = Join-Path $workspace 'output\runner\credential.json'
    $credential = @{corp_id=$corp;runner_id='fixture-runner';credential='synthetic-credential-not-authority';expires_at=[DateTimeOffset]::UtcNow.AddHours(1).ToString('o')}
    $script:Sentinels.Add($credential.credential)
    Write-FixtureFile $credentialPath ($credential | ConvertTo-Json)
    $nonce = [guid]::NewGuid().ToString('N')
    Write-FixtureFile (Join-Path $workspace 'startup-fixture.json') (@{
        node=$script:NodeExecutable;script=$script:FixtureScript;lease=$script:Lease;nonce=$nonce
    } | ConvertTo-Json)
    $statePath = Join-Path $workspace 'output\local-pids.json'
    # Each suite owns distinct ephemeral ports. Module includes these cases too,
    # so fixed ports can collide with a concurrently invoked Startup suite.
    $portListeners = @(
        [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
        [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    )
    try {
        foreach ($portListener in $portListeners) { $portListener.Start() }
        $serverPort = $portListeners[0].LocalEndpoint.Port
        $webPort = $portListeners[1].LocalEndpoint.Port
    } finally {
        foreach ($portListener in $portListeners) { $portListener.Stop() }
    }
    $baseState = @{
        schema_version=2; workspace=$workspace; configuration=@{
            source_repository=$source;source_base_ref='HEAD';source_commit=(Get-LocalSourceCommit $source HEAD)
            runner_id='fixture-runner';server_port=$serverPort;web_port=$webPort;database_identity='127.0.0.1:57577/fixture'
            runner_workspace=(Join-Path $workspace 'output\runner');copilot_home=(Join-Path $workspace 'output\runner\copilot-home')
        };processes=@{};previous_processes=@();corp_id=$corp;actor_id=$actor;identity_initialized=$true
    }
    Write-FixtureFile $statePath ($baseState | ConvertTo-Json -Depth 12)
    $environment = @{}
    foreach ($name in [Environment]::GetEnvironmentVariables('Process').Keys) {
        if ($name -match '^(CRONY_|ECORP_FACTORY_|ECORP_GITHUB_|CARGO_TARGET_DIR$|DATABASE_URL$)') {
            $environment[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
            [Environment]::SetEnvironmentVariable($name,$null,'Process')
        }
    }
    $env:DATABASE_URL = 'postgresql://synthetic-secret@127.0.0.1:57577/fixture'
    $script:Sentinels.Add($env:DATABASE_URL)
    $starter = Join-Path $workspace 'tools\start_local.ps1'
    function Get-StartupSnapshot {
        $items = @(Get-Item -LiteralPath $workspace) + @(Get-ChildItem -LiteralPath $workspace -Recurse -Force)
        @($items | Sort-Object FullName | ForEach-Object {
            $acl = (Get-Acl -LiteralPath $_.FullName).Sddl
            $_.Refresh()
            [ordered]@{
                path=$_.FullName;acl=$acl;attributes=[int]$_.Attributes
                written=$_.LastWriteTimeUtc.Ticks
                hash=$(if (!$_.PSIsContainer) {
                    $stream=[IO.File]::Open($_.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,
                        [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
                    try { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) }
                    finally { $stream.Dispose() }
                })
            }
        }) | ConvertTo-Json -Depth 5 -Compress
    }
    function Invoke-RestMethod {
        param($Uri,$TimeoutSec)
        if ($Uri -like '*/health') { return @{ status='ok';mode='development' } }
        @{ snapshot=@{corp=@{id=$corp}};runners=@(@{id='fixture-runner';connected=$true}) }
    }
    function Invoke-WebRequest { param($Uri,$TimeoutSec) @{StatusCode=200} }
    function Register-StartupProcesses {
        $current = Read-LocalStackState -Path $statePath -Workspace $workspace
        foreach ($role in $current.processes.Keys) {
            $record = $current.processes[$role]
            if (@($script:Processes | Where-Object process_id -eq $record.pid).Count) { continue }
            if (!(Test-LocalOwnedProcess $record $workspace)) { continue }
            $readyPath = $record.fixture_ready
            $ready = Wait-FixtureJson $readyPath
            $spec = @{before=([DateTimeOffset]$record.started_utc).UtcDateTime;ready=$readyPath;nonce=$nonce}
            $held = Register-FixtureHandle ([Diagnostics.Process]::GetProcessById($record.pid)) $spec
            Assert-FixtureReady $ready $held $spec
            $null = Wait-FixtureLog $record.stdout "fixture stdout $nonce"
            $null = Wait-FixtureLog $record.stderr "fixture stderr $nonce"
        }
    }
    try {
        Invoke-Case 'Factory Unicode ref resolves in preflight while the runner retains its supported ref' {
            $settings = @{
                ECORP_FACTORY_WATCH='1'
                ECORP_FACTORY_SOURCE_BASE_REF=$invalidRefs[0].ref
                ECORP_GITHUB_CLI=$script:NodeExecutable
            }
            $old = @{}
            foreach ($name in $settings.Keys) {
                $old[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
                [Environment]::SetEnvironmentVariable($name,$settings[$name],'Process')
            }
            try {
                foreach ($restart in @($false,$true)) {
                    $before = Get-StartupSnapshot
                    $result = & $starter -Preflight -Restart:$restart -SkipBuild -SkipInstall
                    Assert-Equal $result.status 'ready' 'Factory Unicode resolution must pass with the independently supported runner ref.'
                    Assert-Equal $result.source_commit $commit 'Runner HEAD must still resolve to the exact fixture commit.'
                    Assert-Equal (Get-StartupSnapshot) $before 'Factory preflight changed retained files or ACLs.'
                }
            } finally {
                foreach ($name in $settings.Keys) { [Environment]::SetEnvironmentVariable($name,$old[$name],'Process') }
            }
        }
        Invoke-Case 'saved-connection Factory preflight does not resolve its ref in the legacy checkout' {
            $settings = @{
                ECORP_FACTORY_WATCH='1'
                ECORP_FACTORY_WORKSPACE_CONNECTION_ID='00000000-0000-4000-8000-000000000232'
                ECORP_FACTORY_SOURCE_BASE_REF='refs/heads/connection-project-only'
                ECORP_GITHUB_CLI=$script:NodeExecutable
            }
            $old = @{}
            foreach ($name in $settings.Keys) {
                $old[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
                [Environment]::SetEnvironmentVariable($name,$settings[$name],'Process')
            }
            try {
                Assert-Throws { Get-LocalSourceCommit $source $settings.ECORP_FACTORY_SOURCE_BASE_REF } 'The selected project ref must genuinely be absent from the legacy checkout.'
                foreach ($restart in @($false,$true)) {
                    $before = Get-StartupSnapshot
                    $result = & $starter -Preflight -Restart:$restart -SkipBuild -SkipInstall
                    Assert-Equal $result.status 'ready' 'The native controller must resolve the selected connection without a legacy-source fallback.'
                    Assert-Equal $result.source_commit $commit 'The runner retains its separately configured source.'
                    Assert-Equal (Get-StartupSnapshot) $before 'Saved-connection preflight changed retained files, attributes or ACLs.'
                }
            } finally {
                foreach ($name in $settings.Keys) {
                    if ($null -eq $old[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
                    else { [Environment]::SetEnvironmentVariable($name,$old[$name],'Process') }
                }
            }
        }
        Invoke-Case 'read-only startup preflight has exact proof fields and no filesystem or ACL effects' {
            $before = Get-StartupSnapshot
            $result = & $starter -Preflight -SkipBuild -SkipInstall -SkipFactoryController
            Assert-Equal $result.status 'ready' 'Valid retained configuration must pass.'
            Assert-Equal $result.schema_version 1 'Unexpected preflight report version.'
            Assert-True $result.read_only 'Preflight must identify its read-only scope.'
            Assert-Equal $result.source_commit $baseState.configuration.source_commit 'Preflight must prove the exact commit.'
            Assert-Equal ($result.checks -join ',') 'retained_state,identity,database,source,credential,ownership,ports,dependencies,paths' 'Preflight must report the exact completed checks.'
            Assert-Equal (($result.PSObject.Properties.Name | Sort-Object) -join ',') 'actor_id,checks,corp_id,read_only,runner_id,schema_version,server_url,source_base_ref,source_commit,source_repository,status,web_url,workspace' 'Report must expose only approved metadata fields.'
            $after = Get-StartupSnapshot
            if ($before -cne $after) {
                Write-FixtureFile (Join-Path $script:FixtureRoot 'preflight-before.json') $before
                Write-FixtureFile (Join-Path $script:FixtureRoot 'preflight-after.json') $after
            }
            Assert-Equal $after $before 'Preflight changed retained bytes, metadata or ACLs.'
        }
        Invoke-Case 'normal start and repeat start preserve verified live process identities' {
            & $starter -SkipBuild -SkipInstall -SkipFactoryController | Out-Null
            Register-StartupProcesses
            $before = (Read-LocalStackState $statePath $workspace).processes | ConvertTo-Json -Depth 8 -Compress
            & $starter -SkipBuild -SkipInstall -SkipFactoryController | Out-Null
            Assert-Equal ((Read-LocalStackState $statePath $workspace).processes | ConvertTo-Json -Depth 8 -Compress) $before 'Ordinary start replaced a healthy owned process.'
        }
        $expectedErrors = @{
            'missing database'='Load the existing DATABASE_URL*'
            'missing source'='Required startup path is missing:*'
            'actor mismatch'='Retained actor identity mismatch*'
            'runner mismatch'='Runner identity mismatch*'
            'source commit mismatch'='Retained source commit no longer matches*'
            'database mismatch'='Database identity mismatch*'
            'expired credential'='Missing, expired or mismatched runner credential metadata:*'
            'credential scope mismatch'='Missing, expired or mismatched runner credential metadata:*'
            'unverifiable process'='Unverifiable server process ownership*'
            'database denied'='Authorized read-only database/Corp/actor/runner validation failed*'
            'missing binary'='Required startup path is missing:*'
            'redirected provider home'='Startup cannot verify redirected path:*'
            'missing retained setting'='Retained configuration is missing runner_workspace*'
            'invalid schema'='Local ownership record scope/version mismatch*'
            'occupied port'="Port $serverPort is occupied without matching server ownership*"
            'missing credential'='Required startup path is missing:*'
            'missing source ref'='Cannot resolve source ref to an immutable commit*'
            'invalid port'='CRONY_SERVER_PORT must be a valid TCP port*'
        }
        foreach ($scenario in @('missing database','missing source','actor mismatch','runner mismatch','source commit mismatch','database mismatch','expired credential','credential scope mismatch','unverifiable process','database denied','missing binary','redirected provider home','missing retained setting','invalid schema','occupied port','missing credential','missing source ref','invalid port')) {
            Invoke-Case "$scenario fails before Start/Restart/preflight effects" {
                $originalState = [IO.File]::ReadAllText($statePath)
                $originalCredential = [IO.File]::ReadAllText($credentialPath)
                $invalid = $originalState | ConvertFrom-Json -AsHashtable
                $guard = Start-Fixture (New-FixtureSpec)
                $guardRecord = Get-FixtureRecord $guard
                $guardRecord.workspace = $workspace
                $guardRecord.role = 'server'
                $invalid.processes = @{server=$guardRecord}
                $changed = @{}
                $listener = $null
                switch ($scenario) {
                    'missing database' { $changed.DATABASE_URL=$null }
                    'missing source' { $changed.CRONY_SOURCE_REPOSITORY=(Join-Path $workspace 'absent') }
                    'actor mismatch' { $changed.CRONY_ACTOR_ID='00000000-0000-4000-8000-000000000999' }
                    'runner mismatch' { $changed.CRONY_RUNNER_ID='other-runner' }
                    'source commit mismatch' { $invalid.configuration.source_commit='0' * 40 }
                    'database mismatch' { $changed.DATABASE_URL='postgresql://synthetic-secret@127.0.0.1:57577/other' }
                    'expired credential' { $bad=$credential.Clone();$bad.expires_at=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o');Write-FixtureFile $credentialPath ($bad|ConvertTo-Json) }
                    'credential scope mismatch' { $bad=$credential.Clone();$bad.runner_id='other-runner';Write-FixtureFile $credentialPath ($bad|ConvertTo-Json) }
                    'unverifiable process' { $invalid.processes.server.started_utc=[DateTimeOffset]::UtcNow.AddDays(-1).ToString('o') }
                    'database denied' { $changed.ECORP_LOCAL_STACK_TEST_DATABASE_DENIED='1' }
                    'missing binary' { $changed.CARGO_TARGET_DIR=(Join-Path $workspace 'absent-target') }
                    'redirected provider home' { $changed.CRONY_COPILOT_HOME=$providerRedirect }
                    'missing retained setting' { $invalid.configuration.Remove('runner_workspace') }
                    'invalid schema' { $invalid.schema_version=3 }
                    'missing credential' { Remove-Item -LiteralPath $credentialPath }
                    'missing source ref' { $changed.CRONY_SOURCE_BASE_REF='refs/heads/no-such-fixture' }
                    'invalid port' { $changed.CRONY_SERVER_PORT='65536' }
                    'occupied port' {
                        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$serverPort)
                        $listener.Start()
                    }
                }
                Write-FixtureFile $statePath ($invalid | ConvertTo-Json -Depth 12)
                $old = @{}
                foreach ($key in $changed.Keys) { $old[$key]=[Environment]::GetEnvironmentVariable($key,'Process');[Environment]::SetEnvironmentVariable($key,$changed[$key],'Process') }
                try {
                    foreach ($mode in @(@{Preflight=$true},@{},@{Restart=$true})) {
                        # Missing binaries matter only when that role would launch.
                        if ($scenario -eq 'missing binary' -and !$mode.ContainsKey('Restart')) { continue }
                        $before = Get-StartupSnapshot
                        $failure = $null
                        try { & $starter @mode -SkipBuild -SkipInstall -SkipFactoryController | Out-Null }
                        catch { $failure = $_.Exception.Message }
                        # Report only known rejection categories, never arbitrary
                        # exception text that could contain credential canaries.
                        $actualRejection = @($expectedErrors.Keys | Where-Object { $failure -like $expectedErrors[$_] }) -join ', '
                        Assert-True ($null -ne $failure -and $failure -like $expectedErrors[$scenario]) "Expected the exact $scenario rejection; observed categories: [$actualRejection]."
                        Assert-Equal (Get-StartupSnapshot) $before 'Rejected input changed files, metadata or ACLs.'
                        Assert-FixtureAlive $guard
                        if ($listener) { Assert-True $listener.Server.IsBound 'Rejected input changed the unrelated listener.' }
                    }
                } finally {
                    foreach ($key in $old.Keys) { [Environment]::SetEnvironmentVariable($key,$old[$key],'Process') }
                    Write-FixtureFile $statePath $originalState
                    Write-FixtureFile $credentialPath $originalCredential
                    Stop-FixtureHandle $guard.owned
                    if ($listener) { $listener.Stop() }
                }
            }
        }
        foreach ($setting in @('CRONY_RUNNER_WORKSPACE','CRONY_COPILOT_HOME')) {
            foreach ($mode in @(
                @{name='Preflight';arguments=@{Preflight=$true}},
                @{name='Preflight+Restart';arguments=@{Preflight=$true;Restart=$true}},
                @{name='Start';arguments=@{}},
                @{name='Restart';arguments=@{Restart=$true}}
            )) {
                Invoke-Case "regular-file ancestor rejects $setting $($mode.name) without effects" {
                    $originalState = [IO.File]::ReadAllText($statePath)
                    $retained = $originalState | ConvertFrom-Json -AsHashtable
                    $retained.processes = @{}
                    $guards = @()
                    $old = [Environment]::GetEnvironmentVariable($setting,'Process')
                    try {
                        foreach ($role in @('server','runner','web')) {
                            $guard = Start-Fixture (New-FixtureSpec)
                            $guards += $guard
                            $record = Get-FixtureRecord $guard
                            $record.workspace = $workspace
                            $record.role = $role
                            $retained.processes[$role] = $record
                        }
                        Write-FixtureFile $statePath ($retained | ConvertTo-Json -Depth 12)
                        $pathBlocker = Join-Path $workspace "$setting-blocker.txt"
                        Write-FixtureFile $pathBlocker 'retained blocker bytes'
                        $requested = Join-Path $pathBlocker 'absent\directory'
                        Assert-False (Test-Path -LiteralPath $requested) 'The requested leaf must be absent.'
                        [Environment]::SetEnvironmentVariable($setting,$requested,'Process')
                        $before = Get-StartupSnapshot
                        $failure = $null
                        $arguments = $mode.arguments
                        try { & $starter @arguments -SkipBuild -SkipInstall -SkipFactoryController | Out-Null }
                        catch { $failure = $_.Exception.Message }
                        Register-StartupProcesses
                        $after = Get-StartupSnapshot
                        $identities = @($retained.processes.Values | ForEach-Object {
                            [ordered]@{record=$_;alive=(Test-LocalOwnedProcess $_ $workspace)}
                        })
                        # Keep actual before/after evidence even when the buggy
                        # restart has already stopped roots or rewritten state.
                        Write-FixtureFile (Join-Path $script:FixtureRoot "$setting-$($mode.name).json") (
                            @{before=$before;after=$after;failure=$failure;identities=$identities} | ConvertTo-Json -Depth 12)
                        Assert-Equal $failure "Expected a directory: $pathBlocker" 'Reject the exact regular-file ancestor during shared validation.'
                        Assert-Equal $after $before 'Rejected input changed retained bytes, timestamps, ACLs or workspace tree.'
                        foreach ($identity in $identities) { Assert-True $identity.alive 'Rejected input changed an exact retained process identity.' }
                        foreach ($guard in $guards) { Assert-FixtureAlive $guard }
                    } finally {
                        Register-StartupProcesses
                        [Environment]::SetEnvironmentVariable($setting,$old,'Process')
                        Write-FixtureFile $statePath $originalState
                        foreach ($guard in $guards) { Stop-FixtureHandle $guard.owned }
                    }
                }
            }
        }
        foreach ($case in $invalidRefs) {
            foreach ($mode in @(
                @{name='Preflight';arguments=@{Preflight=$true}},
                @{name='PreflightRestart';arguments=@{Preflight=$true;Restart=$true}},
                @{name='Start';arguments=@{}},
                @{name='Restart';arguments=@{Restart=$true}}
            )) {
                Invoke-Case "native source ref rejects $($case.name) $($mode.name) without effects" {
                    $originalState = [IO.File]::ReadAllText($statePath)
                    $retained = $originalState | ConvertFrom-Json -AsHashtable -DateKind String
                    $retained.processes = @{}
                    $guards = @()
                    $old = [Environment]::GetEnvironmentVariable('CRONY_SOURCE_BASE_REF','Process')
                    try {
                        foreach ($role in @('server','runner','web')) {
                            $guard = Start-Fixture (New-FixtureSpec)
                            $guards += $guard
                            $record = Get-FixtureRecord $guard
                            $record.workspace = $workspace
                            $record.role = $role
                            $retained.processes[$role] = $record
                        }
                        Write-FixtureFile $statePath ($retained | ConvertTo-Json -Depth 12)
                        $env:CRONY_SOURCE_BASE_REF = $case.ref
                        $before = Get-StartupSnapshot
                        $failure = $null
                        $arguments = $mode.arguments
                        try { & $starter @arguments -SkipBuild -SkipInstall -SkipFactoryController | Out-Null }
                        catch { $failure = $_.Exception.Message }
                        Register-StartupProcesses
                        $after = Get-StartupSnapshot
                        $identities = @($retained.processes.Values | ForEach-Object {
                            [ordered]@{record=$_;alive=(Test-LocalOwnedProcess $_ $workspace)}
                        })
                        Write-FixtureFile (Join-Path $script:FixtureRoot "source-ref-$($case.name)-$($mode.name).json") (
                            [ordered]@{ref=$case.ref;utf8Bytes=[Text.Encoding]::UTF8.GetByteCount($case.ref)
                                at=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                                before=$before;after=$after;failure=$failure;identities=$identities} | ConvertTo-Json -Depth 12)
                        Assert-Equal $failure "Invalid source ref for repository: $source" 'Reject the native-incompatible ref during shared validation.'
                        Assert-Equal $after $before 'Rejected ref changed retained bytes, timestamps, ACLs or workspace tree.'
                        foreach ($identity in $identities) { Assert-True $identity.alive 'Rejected ref changed an exact retained process identity.' }
                        foreach ($guard in $guards) { Assert-FixtureAlive $guard }
                    } finally {
                        Register-StartupProcesses
                        [Environment]::SetEnvironmentVariable('CRONY_SOURCE_BASE_REF',$old,'Process')
                        Write-FixtureFile $statePath $originalState
                        foreach ($guard in $guards) { Stop-FixtureHandle $guard.owned }
                    }
                }
            }
        }
        foreach ($shape in @('file','escaping-junction','absent','directory')) {
            foreach ($mode in @(
                @{name='Preflight';arguments=@{Preflight=$true}},
                @{name='PreflightRestart';arguments=@{Preflight=$true;Restart=$true}},
                @{name='Start';arguments=@{}},
                @{name='Restart';arguments=@{Restart=$true}}
            )) {
                Invoke-Case "mandatory worktrees child $shape $($mode.name)" {
                    $originalState = [IO.File]::ReadAllText($statePath)
                    $retained = $originalState | ConvertFrom-Json -AsHashtable -DateKind String
                    $retained.processes = @{}
                    $guards = @()
                    $requested = Join-Path $workspace "F03-$shape-$($mode.name)"
                    $child = Join-Path $requested 'worktrees'
                    $invalidChild = $shape -in @('file','escaping-junction')
                    try {
                        [IO.Directory]::CreateDirectory((Assert-InFixture $requested)) | Out-Null
                        switch ($shape) {
                            'file' { Write-FixtureFile $child 'retained worktrees blocker bytes' }
                            'escaping-junction' {
                                $target = "$requested-target"
                                [IO.Directory]::CreateDirectory((Assert-InFixture $target)) | Out-Null
                                Write-FixtureFile (Join-Path $target 'retained.txt') 'outside runner root; inside owned fixture'
                                New-Item -ItemType Junction -Path $child -Target $target | Out-Null
                                $script:Junctions.Add($child)
                            }
                            'directory' {
                                [IO.Directory]::CreateDirectory($child) | Out-Null
                                Write-FixtureFile (Join-Path $child 'retained.txt') 'existing managed directory bytes'
                            }
                            'absent' { Assert-False (Test-Path -LiteralPath $child) 'The managed child must start absent.' }
                        }
                        foreach ($role in @('server','runner','web')) {
                            $guard = Start-Fixture (New-FixtureSpec)
                            $guards += $guard
                            $record = Get-FixtureRecord $guard
                            $record.workspace = $workspace
                            $record.role = $role
                            $retained.processes[$role] = $record
                        }
                        # Match the retained setting so the live-setting guard
                        # cannot mask missing mandatory-child validation.
                        $retained.configuration.runner_workspace = $requested
                        Write-FixtureFile $statePath ($retained | ConvertTo-Json -Depth 12)
                        $snapshot = {
                            [ordered]@{
                                retained=(Get-StartupSnapshot)
                                entries=@(@(Get-Item -LiteralPath $workspace) +
                                    @(Get-ChildItem -LiteralPath $workspace -Recurse -Force) |
                                    Sort-Object FullName | ForEach-Object {
                                        [ordered]@{path=$_.FullName;created=$_.CreationTimeUtc.Ticks
                                            attributes=[string]$_.Attributes;target=$_.LinkTarget}
                                    })
                            } | ConvertTo-Json -Depth 6 -Compress
                        }
                        $before = & $snapshot
                        $failure = $null
                        $result = $null
                        $arguments = $mode.arguments
                        try { $result = & $starter @arguments -SkipBuild -SkipInstall -SkipFactoryController }
                        catch { $failure = $_.Exception.Message }
                        Register-StartupProcesses
                        $after = & $snapshot
                        $identities = @($retained.processes.Values | ForEach-Object {
                            [ordered]@{record=$_;alive=(Test-LocalOwnedProcess $_ $workspace)}
                        })
                        Write-FixtureFile (Join-Path $script:FixtureRoot "worktrees-$shape-$($mode.name).json") (
                            [ordered]@{at=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                                child=$child;shape=$shape;mode=$mode.name;failure=$failure
                                before=$before;after=$after;identities=$identities
                                scope='synthetic entrypoint; not native WorkspaceManager boot'} | ConvertTo-Json -Depth 12)
                        if ($invalidChild) {
                            $expected = if ($shape -eq 'file') { "Expected a directory: $child" }
                                else { "Startup cannot verify redirected path: $child" }
                            Assert-Equal $failure $expected 'Reject the exact mandatory child during shared validation.'
                            Assert-Equal $after $before 'Invalid child changed retained bytes, ACLs, timestamps, state, links or tree.'
                        } else {
                            Assert-True ($null -eq $failure) 'A normal absent/existing managed directory must remain allowed.'
                            if ($arguments.ContainsKey('Preflight')) {
                                Assert-Equal $result.status 'ready' 'Valid child must pass preflight.'
                                Assert-Equal $after $before 'Read-only preflight changed the valid workspace.'
                            }
                        }
                        if ($invalidChild -or !$arguments.ContainsKey('Restart') -or $arguments.ContainsKey('Preflight')) {
                            foreach ($identity in $identities) { Assert-True $identity.alive 'Validation changed an exact held process identity.' }
                            foreach ($guard in $guards) { Assert-FixtureAlive $guard }
                        } else {
                            $current = Read-LocalStackState $statePath $workspace
                            Assert-Equal $current.processes.Count 3 'Valid restart must replace only the three synthetic roots.'
                            foreach ($identity in $identities) { Assert-False $identity.alive 'Valid restart must stop the old owned root.' }
                            foreach ($record in $current.processes.Values) {
                                Assert-True (Test-LocalOwnedProcess $record $workspace) 'Valid restart must retain exact replacement ownership.'
                            }
                        }
                    } finally {
                        Register-StartupProcesses
                        Write-FixtureFile $statePath $originalState
                        foreach ($guard in $guards) { Stop-FixtureHandle $guard.owned }
                    }
                }
            }
        }
        foreach ($restriction in @('read-only','delete-sharing')) {
            foreach ($mode in @(
                @{name='Start';restart=$false;preflight=$false},
                @{name='Restart';restart=$true;preflight=$false},
                @{name='Preflight';restart=$false;preflight=$true}
            )) {
                Invoke-Case "$restriction ownership target rejects $($mode.name) before effects" {
                    & $starter -SkipBuild -SkipInstall -SkipFactoryController | Out-Null
                    Register-StartupProcesses
                    $originalState = [IO.File]::ReadAllText($statePath)
                    $owned = (Read-LocalStackState $statePath $workspace).processes
                    $attributes = [IO.File]::GetAttributes($statePath)
                    $locked = $null
                    try {
                        if ($restriction -eq 'read-only') {
                            [IO.File]::SetAttributes($statePath, $attributes -bor [IO.FileAttributes]::ReadOnly)
                        } else {
                            $locked = [IO.File]::Open($statePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
                        }
                        $before = Get-StartupSnapshot
                        $failure = $null
                        try { & $starter -Restart:$mode.restart -Preflight:$mode.preflight -SkipBuild -SkipInstall -SkipFactoryController | Out-Null }
                        catch { $failure = $_.Exception.Message }
                        $after = Get-StartupSnapshot
                        $live = @($owned.Values | ForEach-Object { Test-LocalOwnedProcess $_ $workspace })
                        Write-FixtureFile (Join-Path $script:FixtureRoot "replacement-$restriction-$($mode.name).json") (@{
                            restriction=$restriction;mode=$mode.name;failure=$failure
                            before=($before | ConvertFrom-Json);after=($after | ConvertFrom-Json);original_roots_live=$live
                        } | ConvertTo-Json -Depth 8)
                        Assert-Equal $after $before 'Rejected ownership output changed retained bytes, attributes, timestamps or ACLs.'
                        Assert-Equal @($live | Where-Object { !$_ }).Count 0 'A known non-replaceable ownership target must be rejected before stopping any original root.'
                        Assert-True ($failure -like 'Ownership record cannot be replaced:*') 'Read-only validation must identify the known replacement failure.'
                    } finally {
                        if ($locked) { $locked.Dispose() }
                        [IO.File]::SetAttributes($statePath,$attributes)
                        Register-StartupProcesses
                        Write-FixtureFile $statePath $originalState
                    }
                }
            }
        }
        Invoke-Case 'partial restart retains old configuration and a subsequent start recovers it' {
            & $starter -SkipBuild -SkipInstall -SkipFactoryController | Out-Null
            Register-StartupProcesses
            $originalState = [IO.File]::ReadAllText($statePath)
            $original = $originalState | ConvertFrom-Json -AsHashtable
            $newPort = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
            try { $newPort.Start(); $requestedPort = $newPort.LocalEndpoint.Port }
            finally { $newPort.Stop() }
            $settings = @{
                CRONY_WEB_PORT=[string]$requestedPort
                CRONY_SOURCE_BASE_REF=$nativeRef
                ECORP_LOCAL_STACK_TEST_STOP_ROLE='server'
            }
            $old = @{}
            foreach ($name in $settings.Keys) {
                $old[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
                [Environment]::SetEnvironmentVariable($name,$settings[$name],'Process')
            }
            $recovered = $false
            try {
                $failure = $null
                try { & $starter -Restart -SkipBuild -SkipInstall -SkipFactoryController | Out-Null }
                catch { $failure = $_.Exception.Message }
                foreach ($name in $settings.Keys) {
                    if ($null -eq $old[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
                    else { [Environment]::SetEnvironmentVariable($name,$old[$name],'Process') }
                }
                $partial = Read-LocalStackState $statePath $workspace
                Write-FixtureFile (Join-Path $script:FixtureRoot 'partial-restart.json') (@{
                    before=$original;after=$partial;failure=$failure
                } | ConvertTo-Json -Depth 12)
                Assert-Equal $failure 'Synthetic second-stop failure' 'The fixture must fail on the second old root, after the first stop was saved.'
                Assert-False (Test-LocalOwnedProcess $original.processes.runner $workspace) 'The first stop must actually complete.'
                foreach ($role in @('server','web')) {
                    Assert-True (Test-LocalOwnedProcess $original.processes[$role] $workspace) 'The remaining original roots must be preserved.'
                }
                Assert-Equal $partial.configuration.Count $original.configuration.Count 'Partial restart must preserve the complete old configuration.'
                foreach ($key in $original.configuration.Keys) {
                    Assert-Equal $partial.configuration[$key] $original.configuration[$key] 'A partial restart must not attach proposed settings to the remaining old roots.'
                }
                Assert-Equal $partial.server_url $original.server_url 'Partial restart must retain the old API URL.'
                Assert-Equal $partial.web_url $original.web_url 'Partial restart must retain the old web URL.'
                & $starter -SkipBuild -SkipInstall -SkipFactoryController | Out-Null
                Register-StartupProcesses
                $current = Read-LocalStackState $statePath $workspace
                Assert-Equal $current.configuration.Count $original.configuration.Count 'Recovery must preserve the complete old configuration.'
                foreach ($key in $original.configuration.Keys) {
                    Assert-Equal $current.configuration[$key] $original.configuration[$key] 'Ordinary recovery must use the old saved configuration.'
                }
                foreach ($role in @('server','web')) {
                    Assert-Equal $current.processes[$role].pid $original.processes[$role].pid 'Recovery must reuse the remaining old roots.'
                }
                Assert-True (Test-LocalOwnedProcess $current.processes.runner $workspace) 'Recovery must replace the stopped runner with an owned root.'
                Assert-True ($current.processes.runner.pid -ne $original.processes.runner.pid) 'The runner recovery must be a new process.'
                Write-FixtureFile (Join-Path $script:FixtureRoot 'partial-restart-recovered.json') ($current | ConvertTo-Json -Depth 12)
                $recovered = $true
            } finally {
                foreach ($name in $settings.Keys) {
                    if ($null -eq $old[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
                    else { [Environment]::SetEnvironmentVariable($name,$old[$name],'Process') }
                }
                Register-StartupProcesses
                if (!$recovered) { Write-FixtureFile $statePath $originalState }
            }
        }
        Invoke-Case 'valid restart replaces only verified owned fixture roots after validation' {
            & $starter -SkipBuild -SkipInstall -SkipFactoryController | Out-Null
            Register-StartupProcesses
            $before = (Read-LocalStackState $statePath $workspace).processes
            & $starter -Restart -SkipBuild -SkipInstall -SkipFactoryController | Out-Null
            Register-StartupProcesses
            $after = (Read-LocalStackState $statePath $workspace).processes
            Assert-Equal $after.Count 3 'Restart must launch server, runner and web only.'
            foreach ($role in @('server','runner','web')) {
                Assert-False (Test-LocalOwnedProcess $before[$role] $workspace) 'Restart left an old owned process running.'
                Assert-True (Test-LocalOwnedProcess $after[$role] $workspace) 'Restart failed to create an owned replacement.'
            }
        }
    } finally {
        Register-StartupProcesses
        foreach ($name in @('DATABASE_URL','ECORP_LOCAL_STACK_TEST_DATABASE_DENIED')) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
        foreach ($name in $environment.Keys) { [Environment]::SetEnvironmentVariable($name,$environment[$name],'Process') }
    }
}

function Invoke-SourceCases {
    $tokens = $null
    $errors = $null
    $start = [Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $PSScriptRoot 'local_stack_start.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'The starter must parse before source guards are meaningful.' }
    $stop = [Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $PSScriptRoot 'stop_local.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'The stopper must parse before source guards are meaningful.' }
    $commands = $start.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true)
    function Get-ConditionalAncestors {
        param($Node)
        for ($parent = $Node.Parent; $null -ne $parent; $parent = $parent.Parent) {
            if ($parent -is [Management.Automation.Language.IfStatementAst] -or
                $parent -is [Management.Automation.Language.CatchClauseAst]) { $parent }
        }
    }
    function Get-SourceExpression {
        param($Node)
        while ($null -ne $Node) {
            if ($Node -is [Management.Automation.Language.PipelineAst] -and $Node.PipelineElements.Count -eq 1) {
                $Node = $Node.PipelineElements[0]
            } elseif ($Node -is [Management.Automation.Language.CommandExpressionAst]) {
                $Node = $Node.Expression
            } elseif ($Node -is [Management.Automation.Language.ParenExpressionAst]) {
                $Node = $Node.Pipeline
            } elseif ($Node -is [Management.Automation.Language.StatementBlockAst] -and $Node.Statements.Count -eq 1) {
                $Node = $Node.Statements[0]
            } else { return $Node }
        }
    }
    function Test-SourceMember {
        param($Node, [string]$Variable, [string]$Member)
        $expression = Get-SourceExpression $Node
        return $expression -is [Management.Automation.Language.MemberExpressionAst] -and
            $expression.Expression -is [Management.Automation.Language.VariableExpressionAst] -and
            $expression.Expression.VariablePath.UserPath -eq $Variable -and
            $expression.Member -is [Management.Automation.Language.StringConstantExpressionAst] -and
            $expression.Member.Value -eq $Member
    }
    Invoke-Case 'starter has no unconditional stop invocation' {
        foreach ($command in $commands | Where-Object { $_.Extent.Text -match 'stop_local\.ps1|^\s*(Stop-LocalOwnedProcess|Stop-Process)\b' }) {
            Assert-True (@(Get-ConditionalAncestors $command).Count -gt 0) 'Stop must be an explicit conditional action or failed-start cleanup, not unconditional startup.'
        }
    }
    Invoke-Case 'starter never passes a database URL as a command argument' {
        $arguments = $start.FindAll({ param($node)
            ($node -is [Management.Automation.Language.StringConstantExpressionAst] -or
                $node -is [Management.Automation.Language.ExpandableStringExpressionAst]) -and
                $node.Value -match '(^|\s)--database-url(\s|$)'
        }, $true)
        Assert-Equal @($arguments).Count 0 'DATABASE_URL must not be exposed through --database-url.'
    }
    Invoke-Case 'starter forwards the native runner startup-recovery opt-out unchanged' {
        $launches = @($commands | Where-Object {
            $_.GetCommandName() -eq 'Launch' -and $_.CommandElements.Count -gt 1 -and
            $_.CommandElements[1] -is [Management.Automation.Language.StringConstantExpressionAst] -and
            $_.CommandElements[1].Value -eq 'server'
        })
        Assert-Equal $launches.Count 1 'The source guard must find the actual server launch.'
        $launch = $launches[0]
        $setups = @($start.FindAll({ param($node)
            $node -is [Management.Automation.Language.AssignmentStatementAst] -and
                $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
                $node.Left.VariablePath.UserPath -eq 'serverEnvironment'
        }, $true) | Where-Object { $_.Extent.EndOffset -lt $launch.Extent.StartOffset })
        Assert-Equal $setups.Count 1 'The server environment must come from one explicit pre-launch selection.'
        $selection = $setups[0].Right
        Assert-True ($selection -is [Management.Automation.Language.PipelineAst] -and
            $selection.PipelineElements.Count -eq 1) 'The selected server environment must not be replaced by a different pipeline.'
        $call = $selection.PipelineElements[0]
        Assert-True ($call -is [Management.Automation.Language.CommandAst] -and
            $call.GetCommandName() -eq 'Explicit-Environment' -and $call.CommandElements.Count -eq 2) 'The server must use the explicit environment selector.'
        $names = @($call.CommandElements[1].SafeGetValue()) # Literal names only; no environment values are read.
        Assert-True ($names -contains 'CRONY_RUNNER_STARTUP_RECOVERY') 'The caller native recovery opt-out must not be stripped.'
        $argument = $launch.CommandElements[-1]
        Assert-True ($argument -is [Management.Automation.Language.VariableExpressionAst] -and
            $argument.VariablePath.UserPath -eq 'serverEnvironment') 'The selected recovery flag must reach the actual server launch.'
        $overrides = @($start.FindAll({ param($node)
            $node -is [Management.Automation.Language.AssignmentStatementAst]
        }, $true) | Where-Object {
            (Test-SourceMember $_.Left 'serverEnvironment' 'CRONY_RUNNER_STARTUP_RECOVERY') -and
                $_.Extent.StartOffset -gt $setups[0].Extent.EndOffset -and
                $_.Extent.EndOffset -lt $launch.Extent.StartOffset
        })
        Assert-Equal $overrides.Count 0 'The caller recovery flag must not be overwritten after selection.'
        Assert-Equal (@($launch.FindAll({ param($node)
            $node -is [Management.Automation.Language.StringConstantExpressionAst] -and
                $node.Value -eq '--runner-startup-recovery'
        }, $true)).Count) 0 'A hard-coded command argument must not override the caller recovery flag.'
    }
    Invoke-Case 'startup never enrolls or bootstraps even when retained identity is absent' {
        $enrollments = @($commands | Where-Object {
            $_.GetCommandName() -eq 'Invoke-RestMethod' -and $_.Extent.Text -match '/runners/enroll|/demo/bootstrap|/demo/reset'
        })
        Assert-Equal $enrollments.Count 0 'Startup is not an enrollment or identity provisioning command.'
        $fallbacks = @($start.FindAll({param($node)
            $node -is [Management.Automation.Language.StringConstantExpressionAst] -and
            $node.Value -in @('--enrollment-token-file','CRONY_RUNNER_ENROLLMENT_TOKEN_FILE')
        }, $true))
        Assert-Equal $fallbacks.Count 0 'A credential disappearing after validation must not enable native enrollment fallback.'
        $checks = @($commands | Where-Object { $_.GetCommandName() -eq 'Assert-LocalDatabaseIdentity' })
        Assert-Equal $checks.Count 1 'All start modes must share the native identity check.'
    }
    Invoke-Case 'Factory policy paths are canonicalized against the checkout before persistence and launch' {
        $pathAssignments = @($start.FindAll({ param($node)
            $node -is [Management.Automation.Language.AssignmentStatementAst] -and
                $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
                $node.Left.VariablePath.UserPath -eq 'policyPath'
        }, $true))
        Assert-Equal $pathAssignments.Count 1 'A policy filename must be resolved before changing the child working directory.'
        $resolve = Get-SourceExpression $pathAssignments[0].Right
        Assert-True ($resolve -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
            $resolve.Static -and $resolve.Expression -is [Management.Automation.Language.TypeExpressionAst] -and
            $resolve.Expression.TypeName.FullName -in @('IO.Path', 'System.IO.Path') -and
            $resolve.Member.Value -eq 'GetFullPath' -and $resolve.Arguments.Count -eq 2) 'Policy resolution must use an explicit base path, not the process working directory.'
        Assert-True (Test-SourceMember $resolve.Arguments[0] 'factory' 'verification_policy_file') 'Resolve the selected persisted policy filename.'
        Assert-True ($resolve.Arguments[1] -is [Management.Automation.Language.VariableExpressionAst] -and
            $resolve.Arguments[1].VariablePath.UserPath -eq 'root') 'The policy base must be the checkout root, not the dotenv guard directory.'
        $canonical = @($start.FindAll({ param($node)
            $node -is [Management.Automation.Language.AssignmentStatementAst]
        }, $true) | Where-Object { Test-SourceMember $_.Left 'factory' 'verification_policy_file' })
        Assert-Equal $canonical.Count 1 'The canonical filename must replace the selected value exactly once.'
        $value = Get-SourceExpression $canonical[0].Right
        Assert-True ($value -is [Management.Automation.Language.MemberExpressionAst] -and
            $value.Member.Value -eq 'Path') 'Persist the resolved filesystem path, not a provider object or the original relative string.'
        $literalResolutions = @($canonical[0].Right.FindAll({ param($node)
            $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Resolve-Path'
        }, $true))
        Assert-Equal $literalResolutions.Count 1 'The canonical policy must be resolved literally.'
        Assert-True ($literalResolutions[0].CommandElements.Count -eq 3 -and
            $literalResolutions[0].CommandElements[1].ParameterName -eq 'LiteralPath' -and
            $literalResolutions[0].CommandElements[2].VariablePath.UserPath -eq 'policyPath') 'Bracket characters in policy paths must not expand as wildcards.'
        $configurations = @($start.FindAll({ param($node)
            $node -is [Management.Automation.Language.AssignmentStatementAst] -and
                $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
                $node.Left.VariablePath.UserPath -eq 'configuration'
        }, $true))
        Assert-Equal $configurations.Count 1 'The source guard must identify the persisted configuration construction.'
        Assert-True ($canonical[0].Extent.EndOffset -lt $configurations[0].Extent.StartOffset) 'Canonicalization must happen before the configuration is persisted.'
        $options = @($start.FindAll({ param($node)
            $node -is [Management.Automation.Language.StringConstantExpressionAst] -and
                $node.Value -eq '--verification-policy-file'
        }, $true))
        Assert-Equal $options.Count 1 'The guard must cover the actual native policy argument.'
        $arguments = $options[0].Parent
        Assert-True ($arguments -is [Management.Automation.Language.ArrayLiteralAst] -and
            $arguments.Elements.Count -eq 2 -and
            (Test-SourceMember $arguments.Elements[1] 'factory' 'verification_policy_file')) 'The controller must receive the canonicalized policy field.'
    }
    Invoke-Case 'Factory saved connection is retained and passed only as an explicit native option' {
        $options = @($start.FindAll({ param($node)
            $node -is [Management.Automation.Language.StringConstantExpressionAst] -and
                $node.Value -eq '--workspace-connection-id'
        }, $true))
        Assert-Equal $options.Count 1 'Only the native Factory invocation receives the selected connection.'
        $arguments = $options[0].Parent
        Assert-True ($arguments -is [Management.Automation.Language.ArrayLiteralAst] -and
            $arguments.Elements.Count -eq 2 -and
            (Test-SourceMember $arguments.Elements[1] 'factory' 'workspace_connection_id')) 'The option must use the validated persisted connection, not an inferred current account.'
        $guards = @(Get-ConditionalAncestors $options[0] | Where-Object {
            $_ -is [Management.Automation.Language.IfStatementAst] -and
            ($_.Clauses | ForEach-Object { $_.Item1.Extent.Text }) -match '\$factory\.workspace_connection_id'
        })
        Assert-True ($guards.Count -gt 0) 'Legacy unbound Factory must not receive an empty connection argument.'
        $settings = @($commands | Where-Object {
            $_.GetCommandName() -eq 'Setting' -and
            $_.Extent.Text -match 'ECORP_FACTORY_WORKSPACE_CONNECTION_ID'
        })
        Assert-Equal $settings.Count 1 'Factory connection selection must use the supported host setting.'
        Assert-True ($settings[0].Extent.Text -match 'factory_workspace_connection_id') 'Ordinary restart must reuse the recorded non-secret connection ID.'
        $validation = @($start.FindAll({ param($node)
            $node -is [Management.Automation.Language.StringConstantExpressionAst] -and
            $node.Value -like 'Factory workspace connection must be*'
        }, $true))
        Assert-Equal $validation.Count 1 'Invalid or nil connection IDs must be rejected before service changes.'
        $refs = @($commands | Where-Object {
            $_.GetCommandName() -eq 'Setting' -and $_.Extent.Text -match 'ECORP_FACTORY_SOURCE_BASE_REF'
        })
        Assert-Equal $refs.Count 1 'Factory must retain its own source ref instead of retargeting the runner.'
        Assert-True ($refs[0].Extent.Text -match 'factory_source_base_ref') 'The controller ref must survive restart.'
        $upgrades = @($start.FindAll({ param($node)
            $node -is [Management.Automation.Language.StringConstantExpressionAst] -and
                $node.Value -like 'Use explicit restart to change the running Factory source ref*'
        }, $true))
        Assert-Equal $upgrades.Count 1 'An old ownership record cannot silently adopt a different ref for a live controller.'
        $upgradeGuards = @(Get-ConditionalAncestors $upgrades[0] | Where-Object {
            $_ -is [Management.Automation.Language.IfStatementAst] -and
            $_.Extent.Text -match 'factory_source_base_ref' -and
            $_.Extent.Text -match "Test-LocalSettingChanged 'factory_source_base_ref'" -and
            $_.Extent.Text -match "Role-Live 'factoryController'"
        })
        Assert-True ($upgradeGuards.Count -gt 0) 'The old-record guard must compare the legacy effective ref and actual live controller.'
    }
    Invoke-Case 'live source-ref changes use exact comparison for old and current records' {
        $comparators = @($start.FindAll({ param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq 'Test-LocalSettingChanged'
        }, $true))
        Assert-Equal $comparators.Count 1 'One production comparator must protect both configuration paths.'
        # Execute only this AST-extracted pure function, never a starter.
        . ([ScriptBlock]::Create($comparators[0].Extent.Text))
        foreach ($name in @('source_base_ref','factory_source_base_ref')) {
            Assert-True (Test-LocalSettingChanged $name 'main' 'Main') 'Case-only Git refs are distinct.'
            Assert-True (Test-LocalSettingChanged $name "caf$([char]0xE9)" "cafe$([char]0x301)") 'Distinct Unicode ref strings must not compare equal.'
            Assert-True (!(Test-LocalSettingChanged $name 'main' 'main')) 'An identical ref must reuse the current controller.'
        }
        Assert-True (!(Test-LocalSettingChanged 'runner_workspace' 'C:\Workspace' 'c:\workspace')) 'Preserve Windows path comparison behavior for unrelated settings.'
        $calls = @($commands | Where-Object { $_.GetCommandName() -eq 'Test-LocalSettingChanged' })
        Assert-Equal $calls.Count 2 'The comparator must protect both legacy upgrade and ordinary live configuration checks.'
        Assert-True (@($calls | Where-Object { $_.Extent.Text -match '\$key' }).Count -eq 1) 'Existing saved ref keys must also use the exact comparator.'
    }
    Invoke-Case 'starter never deletes enrollment or credentials without an explicit reset/rotation guard' {
        foreach ($command in $commands | Where-Object {
            $_.GetCommandName() -eq 'Remove-Item' -and $_.Extent.Text -match 'credential|enrollment'
        }) {
            $guards = @(Get-ConditionalAncestors $command | Where-Object {
                $_ -is [Management.Automation.Language.IfStatementAst] -and
                ($_.Clauses | ForEach-Object { $_.Item1.Extent.Text }) -match 'Rotate|Reset|Re.?enroll'
            })
            Assert-True ($guards.Count -gt 0) 'Credential/enrollment deletion requires an explicit reset/rotation condition.'
        }
    }
    Invoke-Case 'startup has no implicit Compose provisioning and validation precedes restart or writes' {
        $composeCommands = @($commands | Where-Object {
            $_.GetCommandName() -match '^docker(\.exe)?$' -and $_.Extent.Text -match '\bcompose\b'
        })
        Assert-Equal $composeCommands.Count 0 'Missing database state must never cause implicit provisioning.'
        $check = @($commands | Where-Object { $_.GetCommandName() -eq 'Assert-LocalDatabaseIdentity' })
        Assert-Equal $check.Count 1 'Startup must have one shared database/identity validation.'
        foreach ($effect in @($commands | Where-Object {
            $_.GetCommandName() -in @('New-Item','icacls.exe','Save-State','Stop-LocalOwnedProcess','Launch')
        })) {
            $inFunction = $false
            for ($ancestor = $effect.Parent; $ancestor; $ancestor = $ancestor.Parent) {
                if ($ancestor -is [Management.Automation.Language.FunctionDefinitionAst]) { $inFunction=$true;break }
            }
            if (!$inFunction) {
                Assert-True ($effect.Extent.StartOffset -gt $check[0].Extent.EndOffset) 'A startup effect precedes validation.'
            }
        }
    }
    Invoke-Case 'stopper does not rediscover or terminate a descendant tree from saved PIDs' {
        Assert-False ($stop.Extent.Text -match 'Get-CimInstance|ParentProcessId|Add-ProcessTree|taskkill|Stop-Process\s+-Id') 'Stop must use verified root ownership, not PID-based descendant enumeration.'
        Assert-True ($stop.Extent.Text -match 'Stop-LocalOwnedProcess') 'Stop must delegate to the identity-verifying lifecycle boundary.'
    }
}

try {
    if ($Suite -eq 'Source') { Invoke-SourceCases } else { Invoke-ModuleCases }
} catch {
    $script:Cases.Add(@{ name = 'suite setup and execution'; passed = $false; error = $_.Exception.Message })
} finally {
    if ($script:FixtureRoot) {
        Invoke-Case 'cleanup reaps only held synthetic handles and removes only its temporary tree' {
            if ($script:Lease -and [IO.File]::Exists($script:Lease)) {
                $null = Assert-InFixture $script:Lease
                Remove-Item -LiteralPath $script:Lease -Force
            }
            $script:Cleanup.created_processes = $script:Processes.Count
            $cleanupFailures = 0
            foreach ($owned in $script:Processes) {
                try { Stop-FixtureHandle $owned }
                catch { $cleanupFailures++ }
                if (!$owned.process.HasExited) { $script:Cleanup.remaining_processes++ }
                $owned.process.Dispose()
            }
            Assert-Equal $cleanupFailures 0 'Synthetic process cleanup could not be verified; temporary evidence was preserved.'
            Assert-Equal $script:Cleanup.remaining_processes 0 'A synthetic process survived cleanup.'
            foreach ($junction in $script:Junctions) {
                $full = Assert-InFixture $junction
                Assert-True ([bool]((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Expected test-created junction changed before cleanup.'
                Remove-Item -LiteralPath $full -Force # Remove the link, never recurse through it.
            }
            if ($RetainFixtures -or @($script:Cases | Where-Object { !$_.passed }).Count) {
                $script:Cleanup.temp_removed = $false
                $script:Cleanup.retained_fixture = $script:FixtureRoot
                return
            }
            $full = Assert-InFixture $script:FixtureRoot
            Assert-True ([IO.Path]::GetFileName($full).StartsWith('ecorp local lifecycle ')) 'Temporary root ownership marker is missing.'
            Assert-False ([bool]((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Refusing recursive deletion of a redirected temporary root.'
            Remove-Item -LiteralPath $full -Recurse -Force
            $script:Cleanup.temp_removed = ![IO.Directory]::Exists($full)
            Assert-True $script:Cleanup.temp_removed 'The verified task-created temporary tree was not removed.'
        }
    }
}

$report = @{
    suite = $Suite
    scope = 'synthetic-only; not native startup acceptance'
    powershell = $PSVersionTable.PSVersion.ToString()
    cases = @($script:Cases.ToArray())
    cleanup = $script:Cleanup
}
Write-Output ('ECORP_LOCAL_STACK_TEST_RESULT=' + ($report | ConvertTo-Json -Depth 12 -Compress))
if (@($script:Cases | Where-Object { !$_.passed }).Count) { exit 1 }
