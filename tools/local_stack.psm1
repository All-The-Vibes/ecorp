#requires -Version 7.4
Set-StrictMode -Version Latest

function Get-LocalFullPath {
    param([Parameter(Mandatory)][string]$Path)
    [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Test-LocalPathEqual {
    param([string]$Left, [string]$Right)
    if (!$Left -or !$Right) { return $false }
    try {
        return [string]::Equals((Get-LocalFullPath $Left), (Get-LocalFullPath $Right),
            [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function ConvertTo-LocalProcessArgument {
    param([AllowEmptyString()][Parameter(Mandatory)][string]$Value)
    # Start-Process joins ArgumentList into a Windows command line. Preserve one
    # literal argument, including spaces, quotes and trailing backslashes.
    '"' + [regex]::Replace(
        [regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Get-LocalProcessIdentity {
    param([Parameter(Mandatory)][int]$ProcessId)
    if ($ProcessId -le 0) { return $null }
    $process = $null
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        [void]$process.Handle
        if ($process.HasExited) { return $null }
        @{
            pid = $process.Id
            executable = $process.Path
            started_utc = $process.StartTime.ToUniversalTime().ToString('o')
        }
    } catch { return $null }
    finally { if ($process) { $process.Dispose() } }
}

function Test-LocalRecordShape {
    param([hashtable]$Record, [string]$Workspace)
    if (!$Record -or !$Record.ContainsKey('pid') -or !$Record.ContainsKey('executable') -or
        !$Record.ContainsKey('started_utc') -or !$Record.ContainsKey('workspace') -or
        !(Test-LocalPathEqual $Record.workspace $Workspace)) { return $false }
    $number = 0
    $time = [DateTimeOffset]::MinValue
    [int]::TryParse([string]$Record.pid, [ref]$number) -and $number -gt 0 -and
        [IO.Path]::IsPathFullyQualified([string]$Record.executable) -and
        [DateTimeOffset]::TryParse([string]$Record.started_utc, [ref]$time)
}

function Test-LocalOwnedProcess {
    param([hashtable]$Record, [Parameter(Mandatory)][string]$Workspace)
    if (!(Test-LocalRecordShape $Record $Workspace)) { return $false }
    $current = Get-LocalProcessIdentity -ProcessId ([int]$Record.pid)
    if (!$current) { return $false }
    (Test-LocalPathEqual $current.executable $Record.executable) -and
        ([DateTimeOffset]$current.started_utc).UtcTicks -eq
        ([DateTimeOffset]$Record.started_utc).UtcTicks
}

function Stop-LocalOwnedProcess {
    param([hashtable]$Record, [Parameter(Mandatory)][string]$Workspace)
    if (!(Test-LocalRecordShape $Record $Workspace)) { return $false }
    $process = $null
    try {
        $process = Get-Process -Id ([int]$Record.pid) -ErrorAction Stop
        # Keep the process handle open across verification and termination. Do
        # not look up a PID again, or infer ownership of its current descendants.
        [void]$process.Handle
        if ($process.HasExited -or !(Test-LocalPathEqual $process.Path $Record.executable) -or
            $process.StartTime.ToUniversalTime().Ticks -ne
            ([DateTimeOffset]$Record.started_utc).UtcTicks) { return $false }
        $process.Kill()
        if (!$process.WaitForExit(15000)) {
            throw 'The verified process has not exited; its ownership record is retained.'
        }
        return $true
    } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
        return $false
    } catch [System.ArgumentException] {
        return $false
    } finally {
        if ($process) { $process.Dispose() }
    }
}

function New-LocalProcessEnvironment {
    param([hashtable]$Environment = @{})
    # Native Start-Process -Environment removes keys with null values. Do not
    # inherit unrelated cloud/provider secrets into the runner or web client.
    $result = @{}
    foreach ($name in [Environment]::GetEnvironmentVariables('Process').Keys) {
        $result[[string]$name] = $null
    }
    $allow = @('PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP',
        'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA',
        'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
        'SYSTEMDRIVE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PSModulePath',
        'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS')
    foreach ($name in $allow) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($null -ne $value) { $result[$name] = $value }
    }
    foreach ($name in $Environment.Keys) { $result[[string]$name] = $Environment[$name] }
    $result
}

function Initialize-LocalLiteralLauncher {
    if ('ECorp.LocalLiteralLauncher' -as [type]) { return }
    # Start-Process resolves stdout/stderr twice when both are redirected. Its
    # second wildcard pass cannot preserve a resolved literal bracket path.
    # This narrow Windows fallback inherits file handles (not supervisor-owned
    # pipes), so children and their logs survive the launching PowerShell.
    Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace ECorp {
    public static class LocalLiteralLauncher {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo {
            public int cb;
            public string reserved, desktop, title;
            public int x, y, xSize, ySize, xChars, yChars, fillAttribute, flags;
            public short showWindow, reservedCount;
            public IntPtr reservedBytes, stdin, stdout, stderr;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfoEx {
            public StartupInfo startup;
            public IntPtr attributes;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInfo {
            public IntPtr process, thread;
            public int processId, threadId;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(string application, StringBuilder command,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
            IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count,
            int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags,
            IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        private static bool RecordRollbackResult(Exception failure, bool terminated,
            int terminationError, uint waitResult, int waitError) {
            bool verified = terminated && waitResult == 0; // WAIT_OBJECT_0
            failure.Data["LocalStackRollbackVerified"] = verified;
            failure.Data["LocalStackRollbackTerminateSucceeded"] = terminated;
            failure.Data["LocalStackRollbackTerminationError"] = terminationError;
            failure.Data["LocalStackRollbackWaitResult"] = waitResult;
            failure.Data["LocalStackRollbackWaitError"] = waitError;
            return verified;
        }

        public static Process Start(string executable, string command, string directory,
            string stdout, string stderr, IDictionary environment) {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
            var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry entry in environment) {
                if (entry.Value == null) continue;
                var name = Convert.ToString(entry.Key, CultureInfo.InvariantCulture);
                var value = Convert.ToString(entry.Value, CultureInfo.InvariantCulture);
                if (String.IsNullOrEmpty(name) || name.Contains('=') || name.Contains('\0') ||
                    value.Contains('\0')) throw new ArgumentException("Invalid child environment entry.");
                values[name] = value;
            }
            var block = new StringBuilder();
            foreach (var entry in values) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
            block.Append('\0');
            if (values.Count == 0) block.Append('\0');
            // Only these three file handles may be inherited by the new root.
            using var input = File.OpenHandle("NUL", FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Inheritable);
            using var output = File.OpenHandle(stdout, FileMode.Open, FileAccess.Write,
                FileShare.ReadWrite | FileShare.Inheritable);
            using var error = File.OpenHandle(stderr, FileMode.Open, FileAccess.Write,
                FileShare.ReadWrite | FileShare.Inheritable);
            IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, env = IntPtr.Zero;
            bool initialized = false, resumed = false;
            ProcessInfo native = default;
            Process owned = null;
            Exception startupFailure = null;
            try {
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                initialized = true;
                handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handles, 0, input.DangerousGetHandle());
                Marshal.WriteIntPtr(handles, IntPtr.Size, output.DangerousGetHandle());
                Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error.DangerousGetHandle());
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles,
                    new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                var startup = new StartupInfoEx {
                    startup = new StartupInfo {
                        cb = Marshal.SizeOf<StartupInfoEx>(), flags = 0x101, showWindow = 0,
                        stdin = input.DangerousGetHandle(), stdout = output.DangerousGetHandle(),
                        stderr = error.DangerousGetHandle()
                    },
                    attributes = attributes
                };
                env = Marshal.StringToHGlobalUni(block.ToString());
                // Suspended until the exact process handle and creation time
                // are retained; no user code can run during ownership setup.
                const uint creationFlags = 0x08000000 | 0x00080000 | 0x00000400 | 0x00000004;
                if (!CreateProcessW(executable, new StringBuilder(command), IntPtr.Zero,
                    IntPtr.Zero, true, creationFlags, env, directory, ref startup, out native))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                owned = Process.GetProcessById(native.processId);
                _ = owned.Handle;
                _ = owned.StartTime;
                if (ResumeThread(native.thread) == UInt32.MaxValue)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                resumed = true;
                return owned;
            } catch (Exception failure) {
                startupFailure = failure;
                throw; // Preserve the original error, inner cause and stack.
            } finally {
                if (!resumed && native.process != IntPtr.Zero) {
                    // Roll back only this still-suspended root, never a PID lookup.
                    bool terminated = TerminateProcess(native.process, 1);
                    int terminationError = terminated ? 0 : Marshal.GetLastWin32Error();
                    uint waitResult = WaitForSingleObject(native.process, 15000);
                    int waitError = waitResult == UInt32.MaxValue ? Marshal.GetLastWin32Error() : 0;
                    if (!RecordRollbackResult(startupFailure, terminated, terminationError, waitResult, waitError)) {
                        // The caller retains the exact handle with the original
                        // exception for explicit resolution. Do not discard the
                        // last handle or claim cleanup after an unverified rollback.
                        startupFailure.Data["LocalStackRollbackProcessId"] = native.processId;
                        startupFailure.Data["LocalStackRollbackProcessHandle"] =
                            new Microsoft.Win32.SafeHandles.SafeProcessHandle(native.process, true);
                        native.process = IntPtr.Zero;
                    }
                    owned?.Dispose();
                }
                if (native.thread != IntPtr.Zero) CloseHandle(native.thread);
                if (native.process != IntPtr.Zero) CloseHandle(native.process);
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
                if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
            }
        }
    }
}
'@
}

function Start-LocalOwnedProcess {
    param(
        [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z][a-zA-Z0-9-]*$')][string]$Role,
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$LogDirectory,
        [hashtable]$Environment = @{}
    )
    $exe = (Resolve-Path -LiteralPath $FilePath -ErrorAction Stop).Path
    $cwd = (Resolve-Path -LiteralPath $WorkingDirectory -ErrorAction Stop).Path
    $scope = (Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
    $logRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LogDirectory)
    [IO.Directory]::CreateDirectory($logRoot) | Out-Null
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [guid]::NewGuid().ToString('N')
    $stdout = Join-Path $logRoot "$Role-$stamp.stdout.log"
    $stderr = Join-Path $logRoot "$Role-$stamp.stderr.log"
    foreach ($log in @($stdout, $stderr)) {
        # Reserve unique literal files without truncating earlier evidence.
        $stream = [IO.File]::Open($log, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
            [IO.FileShare]::ReadWrite)
        $stream.Dispose()
    }
    $parameters = @{
        FilePath = $exe; WorkingDirectory = $cwd; PassThru = $true; WindowStyle = 'Hidden'
        RedirectStandardOutput = $stdout; RedirectStandardError = $stderr
        Environment = (New-LocalProcessEnvironment -Environment $Environment)
    }
    if ($ArgumentList.Count) {
        $parameters.ArgumentList = @($ArgumentList | ForEach-Object { ConvertTo-LocalProcessArgument $_ })
    }
    $literalOnly = @($exe, $cwd, $stdout, $stderr) | Where-Object {
        $_.Contains('[') -or $_.Contains(']') -or $_.Contains('`')
    }
    if ($literalOnly) {
        Initialize-LocalLiteralLauncher
        $command = ConvertTo-LocalProcessArgument $exe
        if ($ArgumentList.Count) { $command += ' ' + ($parameters.ArgumentList -join ' ') }
        try {
            $process = [ECorp.LocalLiteralLauncher]::Start(
                $exe, $command, $cwd, $stdout, $stderr, $parameters.Environment)
        } catch {
            $failure = $_.Exception
            while ($failure -and !$failure.Data.Contains('LocalStackRollbackVerified')) {
                $failure = $failure.InnerException
            }
            if ($failure -and !$failure.Data['LocalStackRollbackVerified']) {
                $message = 'Failed-start rollback is unverified for owned process {0}. ' +
                    'The original exception retains native results and LocalStackRollbackProcessHandle; explicit resolution is required.'
                Write-Warning -WarningAction Continue ($message -f $failure.Data['LocalStackRollbackProcessId'])
            }
            throw
        }
    } else {
        $process = Start-Process @parameters
    }
    try {
        @{
            role = $Role; workspace = $scope; pid = $process.Id; executable = $exe
            started_utc = $process.StartTime.ToUniversalTime().ToString('o')
            stdout = $stdout; stderr = $stderr
        }
    } finally { $process.Dispose() }
}

function Assert-LocalStackPath {
    param([Parameter(Mandatory)][string]$Path, [switch]$Directory, [switch]$Required,
        [switch]$AllowDependencyLink)
    if (![IO.Path]::IsPathFullyQualified($Path)) { throw "An absolute local path is required: $Path" }
    if ($Required -and !(Test-Path -LiteralPath $Path)) { throw "Required startup path is missing: $Path" }
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if ($Directory -and !$item.PSIsContainer) { throw "Expected a directory: $Path" }
        if (!$Directory -and $item.PSIsContainer) { throw "Expected a file: $Path" }
    }
    if ($AllowDependencyLink) { return }
    for ($cursor = $Path; $cursor; $cursor = Split-Path -Parent $cursor) {
        if ((Test-Path -LiteralPath $cursor) -and
            ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Startup cannot verify redirected path: $cursor"
        }
    }
}

function Invoke-LocalSourceGitRead {
    param([Parameter(Mandatory)][string]$Repository, [Parameter(Mandatory)][string[]]$Arguments)
    $git = Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $info = [Diagnostics.ProcessStartInfo]::new($git.Source)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in (@('-C', $Repository) + $Arguments)) { $info.ArgumentList.Add($argument) }
    # Even rev-parse can write trace files or resolve another checkout through
    # inherited GIT_* settings. Isolate this child without changing its caller.
    $info.Environment.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($null -ne $value) { $info.Environment[$name] = $value }
    }
    $info.Environment['GIT_CONFIG_NOSYSTEM'] = '1'
    $info.Environment['GIT_CONFIG_SYSTEM'] = 'NUL'
    $info.Environment['GIT_CONFIG_GLOBAL'] = 'NUL'
    $info.Environment['GIT_TERMINAL_PROMPT'] = '0'
    $info.Environment['GIT_OPTIONAL_LOCKS'] = '0'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = $false
    try {
        $started = $process.Start()
        if (!$started) { throw 'Git source inspection did not start.' }
        [void]$process.Handle
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(15000)) { throw 'Git source inspection timed out.' }
        # Git diagnostics can include configuration values; do not relay them.
        [void]$stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Git source inspection failed.' }
        $stdout.GetAwaiter().GetResult().TrimEnd([char[]]"`r`n")
    } finally {
        if ($started -and !$process.HasExited) {
            $process.Kill()
            [void]$process.WaitForExit(5000)
        }
        $process.Dispose()
    }
}

function Get-LocalSourceCommit {
    param([Parameter(Mandatory)][string]$Repository, [Parameter(Mandatory)][string]$Ref)
    Assert-LocalStackPath -Path $Repository -Directory -Required
    if ([string]::IsNullOrWhiteSpace($Ref) -or $Ref.StartsWith('-') -or $Ref.Contains("`n") -or $Ref.Contains("`r")) {
        throw "Invalid source ref for repository: $Repository"
    }
    $top = Invoke-LocalSourceGitRead -Repository $Repository -Arguments @('rev-parse', '--show-toplevel')
    if (!(Test-LocalPathEqual ([string]$top) $Repository)) {
        throw "Source must be the exact Git checkout root: $Repository"
    }
    try {
        $commit = Invoke-LocalSourceGitRead -Repository $Repository -Arguments @('rev-parse', '--verify', '--end-of-options', "$Ref^{commit}")
    } catch {
        # Keep the existing safe rejection category for every startup mode.
        # Native Git stderr can contain configuration values and is not relayed.
        throw "Cannot resolve source ref to an immutable commit in: $Repository"
    }
    if ([string]$commit -cnotmatch '^[0-9a-f]{40}$') {
        throw "Cannot resolve source ref to an immutable commit in: $Repository"
    }
    [string]$commit
}

function Assert-LocalStackProcesses {
    param([Parameter(Mandatory)][hashtable]$State, [Parameter(Mandatory)][string]$Workspace)
    foreach ($role in $State.processes.Keys) {
        $record = $State.processes[$role]
        if ($role -notin @('server','runner','web','factoryController') -or
            $record -isnot [hashtable] -or !(Test-LocalRecordShape $record $Workspace) -or
            !$record.ContainsKey('role') -or $record.role -cne $role) {
            throw "Invalid retained process record for $role in $Workspace\output\local-pids.json"
        }
        $candidate = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
        try {
            if ($candidate -and !(Test-LocalOwnedProcess -Record $record -Workspace $Workspace)) {
                throw "Unverifiable $role process ownership in $Workspace\output\local-pids.json; no process was controlled."
            }
        } finally { if ($candidate) { $candidate.Dispose() } }
    }
}

function Get-LocalDatabaseIdentity {
    param([AllowEmptyString()][string]$DatabaseUrl)
    if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
        throw 'Load the existing DATABASE_URL from trusted host configuration. Startup never provisions a database.'
    }
    try {
        $uri = [Uri]$DatabaseUrl
        if (!$uri.IsAbsoluteUri -or $uri.Scheme -notin @('postgres','postgresql') -or
            !$uri.Host -or !$uri.AbsolutePath.Trim('/')) { throw 'invalid' }
        "$($uri.Host.ToLowerInvariant()):$(if($uri.Port -gt 0){$uri.Port}else{5432})$($uri.AbsolutePath)"
    } catch { throw 'DATABASE_URL must be a valid PostgreSQL connection string. Its value was not printed.' }
}

function Assert-LocalRunnerIdentity {
    param([AllowEmptyString()][string]$RunnerId)
    # Match native enrollment's UTF-8 String::len ceiling without normalizing
    # a retained identity into a different runner.
    if ([string]::IsNullOrWhiteSpace($RunnerId) -or
        [Text.Encoding]::UTF8.GetByteCount($RunnerId) -gt 128 -or $RunnerId -match '[\x00-\x1f]') {
        throw 'Runner identity must contain 1 to 128 UTF-8 bytes and no control characters.'
    }
}

function Get-LocalDatabaseEnvironment {
    param([Parameter(Mandatory)][string]$DatabaseUrl)
    $null = Get-LocalDatabaseIdentity -DatabaseUrl $DatabaseUrl
    $uri = [Uri]$DatabaseUrl
    $userInfo = $uri.UserInfo.Split(':', 2)
    # PGDATABASE alone does not expand a URI into host/port/user parameters.
    # Explicit libpq fields prevent an accidental connection to a default host.
    $result = @{
        PGHOST=$uri.DnsSafeHost
        PGPORT=[string]$(if ($uri.Port -gt 0) { $uri.Port } else { 5432 })
        PGDATABASE=[Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
        PGCONNECT_TIMEOUT='5'
        PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000'
    }
    if ($userInfo[0]) { $result.PGUSER = [Uri]::UnescapeDataString($userInfo[0]) }
    if ($userInfo.Count -eq 2) { $result.PGPASSWORD = [Uri]::UnescapeDataString($userInfo[1]) }
    $options = @{
        sslmode='PGSSLMODE';sslrootcert='PGSSLROOTCERT';sslcert='PGSSLCERT';sslkey='PGSSLKEY'
        application_name='PGAPPNAME';client_encoding='PGCLIENTENCODING'
    }
    $seen = @{}
    foreach ($part in $uri.Query.TrimStart('?').Split('&', [StringSplitOptions]::RemoveEmptyEntries)) {
        $pair = $part.Split('=',2)
        $name = [Uri]::UnescapeDataString($pair[0])
        if ($pair.Count -ne 2 -or $name -cnotin @($options.Keys) -or $seen.ContainsKey($name)) {
            throw 'DATABASE_URL has unsupported or repeated options; startup cannot verify equivalent native connection settings.'
        }
        $seen[$name] = $true
        $result[$options[$name]] = [Uri]::UnescapeDataString($pair[1])
    }
    $result
}

function Assert-LocalDatabaseIdentity {
    param([Parameter(Mandatory)][string]$DatabaseUrl, [Parameter(Mandatory)][guid]$CorpId,
        [Parameter(Mandatory)][guid]$ActorId, [Parameter(Mandatory)][string]$RunnerId,
        [Parameter(Mandatory)][string]$CredentialPath)
    Assert-LocalRunnerIdentity -RunnerId $RunnerId
    try {
        $credential = Get-Content -LiteralPath $CredentialPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        $expiry = [DateTimeOffset]::MinValue
        if ($credential -isnot [hashtable] -or
            $credential.runner_id -cne $RunnerId -or $credential.corp_id -ne $CorpId.ToString('D') -or
            ![DateTimeOffset]::TryParse([string]$credential.expires_at, [ref]$expiry) -or
            $expiry -le [DateTimeOffset]::UtcNow -or [string]::IsNullOrWhiteSpace($credential.credential)) {
            throw 'invalid'
        }
    } catch { throw "Missing, expired or mismatched runner credential metadata: $CredentialPath. Restore authorized identity; do not re-enroll." }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes($credential.credential))).ToLowerInvariant()
    $credential = $null
    $runner = $RunnerId.Replace("'", "''")
    $query = @"
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL standard_conforming_strings = on;
SELECT json_build_object(
 'database', current_database(),
 'identity_valid', EXISTS (
   SELECT 1 FROM public.corps c
   JOIN public.actors a ON a.corp_id = c.id
   JOIN public.runner_credentials r ON r.corp_id = c.id
   JOIN public.runner_nodes n ON n.corp_id = c.id AND n.id = r.runner_id
   WHERE c.id = '$CorpId'::uuid AND a.id = '$ActorId'::uuid AND a.kind = 'human'
     AND r.runner_id = '$runner' AND r.revoked_at IS NULL
     AND r.expires_at > now() AND r.token_hash = '$hash'));
ROLLBACK;
"@
    try {
        $result = Invoke-LocalDatabaseRead -DatabaseUrl $DatabaseUrl -Query $query
        $database = [Uri]::UnescapeDataString(([Uri]$DatabaseUrl).AbsolutePath.TrimStart('/'))
        if ($result.database -cne $database -or $result.identity_valid -isnot [bool] -or !$result.identity_valid) {
            throw 'identity mismatch'
        }
    } catch {
        throw "Authorized read-only database/Corp/actor/runner validation failed for $CredentialPath. Check DATABASE_URL, psql.exe on PATH and matching identity; no database was provisioned."
    }
}

function Invoke-LocalDatabaseRead {
    param([Parameter(Mandatory)][string]$DatabaseUrl, [Parameter(Mandatory)][string]$Query)
    # libpq receives the connection only in its private environment; -X ignores
    # psqlrc, -w forbids prompting, and the transaction is explicitly read-only.
    $psql = Get-Command psql.exe -CommandType Application -ErrorAction Stop
    $info = [Diagnostics.ProcessStartInfo]::new($psql.Source)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in @('-X','-w','-A','-t','-q','-v','ON_ERROR_STOP=1')) { $info.ArgumentList.Add($argument) }
    $info.Environment.Clear()
    foreach ($name in @('SystemRoot','WINDIR','PATH','TEMP','TMP')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($null -ne $value) { $info.Environment[$name] = $value }
    }
    $databaseEnvironment = Get-LocalDatabaseEnvironment -DatabaseUrl $DatabaseUrl
    foreach ($key in $databaseEnvironment.Keys) { $info.Environment[$key] = $databaseEnvironment[$key] }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = $false
    try {
        $started = $process.Start()
        if (!$started) { throw 'client did not start' }
        [void]$process.Handle
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.WriteLine($Query)
        $process.StandardInput.Close()
        if (!$process.WaitForExit(15000)) {
            $process.Kill()
            [void]$process.WaitForExit(5000)
            throw 'read-only check timed out'
        }
        if ($process.ExitCode -ne 0) { throw 'read-only check failed' }
        [void]$stderr.GetAwaiter().GetResult()
        $stdout.GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable -ErrorAction Stop
    } finally {
        if ($started -and !$process.HasExited) {
            $process.Kill()
            [void]$process.WaitForExit(5000)
        }
        $process.Dispose()
    }
}

function Read-LocalStackState {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Workspace)
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop }
    catch { throw "The local ownership record cannot be parsed: $Path. It was not removed or used for process control." }
    if ($state -isnot [hashtable]) { throw "Invalid local ownership record: $Path" }
    if (!$state.ContainsKey('schema_version')) {
        # Old numeric-only PIDs are historical data, never stop authority.
        $state.schema_version = 1
        return $state
    }
    if ($state.schema_version -ne 2 -or !$state.ContainsKey('workspace') -or
        !(Test-LocalPathEqual $state.workspace $Workspace) -or
        !$state.ContainsKey('processes') -or $state.processes -isnot [hashtable]) {
        throw "Local ownership record scope/version mismatch: $Path. No process was controlled."
    }
    $state
}

function Save-LocalStackState {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][hashtable]$State,
        [Parameter(Mandatory)][string]$Workspace)
    $root = (Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path.TrimEnd('\', '/')
    $target = [IO.Path]::GetFullPath($Path)
    if (!$target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The ownership record must stay inside its explicit workspace.'
    }
    if ($State.ContainsKey('workspace') -and !(Test-LocalPathEqual $State.workspace $root)) {
        throw 'Refusing to overwrite a differently scoped ownership record.'
    }
    # Reading a legacy file is diagnostic only. Neither a returned v1 record
    # nor raw PID-only fields may be relabeled as v2 stop authority.
    if (($State.ContainsKey('schema_version') -and $State.schema_version -ne 2) -or
        !$State.ContainsKey('processes') -or $State.processes -isnot [hashtable]) {
        throw 'Only v2 process-record state may be saved. Legacy PID-only state is read-only.'
    }
    foreach ($record in $State.processes.Values) {
        if ($null -ne $record -and $record -isnot [hashtable]) {
            throw 'Numeric PIDs cannot be promoted to v2 process ownership records.'
        }
    }
    $parent = Split-Path -Parent $target
    $cursor = $parent
    while ($cursor -and $cursor.Length -ge $root.Length) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Ownership-record directories must not redirect outside the workspace.'
            }
        }
        if (Test-LocalPathEqual $cursor $root) { break }
        $cursor = Split-Path -Parent $cursor
    }
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $State.schema_version = 2
    $State.workspace = $root
    $State.updated_at = [DateTime]::UtcNow.ToString('o')
    $temporary = $target + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporary, $target, $true)
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

Export-ModuleMember -Function Get-LocalFullPath, Test-LocalPathEqual,
    ConvertTo-LocalProcessArgument, Get-LocalProcessIdentity, Test-LocalOwnedProcess,
    Stop-LocalOwnedProcess, New-LocalProcessEnvironment, Start-LocalOwnedProcess,
    Read-LocalStackState, Save-LocalStackState, Assert-LocalStackPath,
    Get-LocalSourceCommit, Assert-LocalStackProcesses, Get-LocalDatabaseIdentity, Assert-LocalDatabaseIdentity,
    Assert-LocalRunnerIdentity
