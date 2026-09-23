param(
  [Parameter(Mandatory)][string]$Workspace,
  [Parameter(Mandatory)][string]$SignalDirectory
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $Workspace
$sourceHead = 'ebaf582fc2fdd90c3c5eac2abacba46967917595'
$sourceTree = '6f027117897a8ec87673e98036fd4ea22de077af'
if ((git rev-parse HEAD) -ne $sourceHead) { throw 'Unexpected source HEAD' }
if ((git rev-parse 'HEAD^{tree}') -ne $sourceTree) { throw 'Unexpected source tree' }
git -c core.autocrlf=true diff --exit-code $sourceHead --
if ($LASTEXITCODE -ne 0) { throw 'Existing source files changed before execution' }
$output = $PSScriptRoot
if (Test-Path -LiteralPath "$output\logs") { throw 'Versioned capture output already exists' }
$nativeTemp = Join-Path ([IO.Path]::GetTempPath()) ("p226-" + [guid]::NewGuid().ToString('N').Substring(0,6))
if (Test-Path -LiteralPath $nativeTemp) { throw 'Occupied worker temporary root' }
New-Item -ItemType Directory -Path $nativeTemp,"$output\logs",$SignalDirectory | Out-Null
$keep = @('APPDATA','ComSpec','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','Path','PATHEXT',
  'ProgramData','ProgramFiles','ProgramFiles(x86)','ProgramW6432','PSModulePath',
  'SystemRoot','USERPROFILE','windir')
Get-ChildItem Env: | Where-Object Name -NotIn $keep | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$env:Path = (Get-Content -Raw -LiteralPath "$Workspace\output\integration\capture-tool-path-v1.txt").Trim()
$env:TEMP = $nativeTemp
$env:TMP = $nativeTemp
$env:CARGO_TARGET_DIR = "$Workspace\target"
$env:CARGO_NET_OFFLINE = 'true'
$env:CARGO_BUILD_JOBS = '2'
$env:CARGO_TERM_COLOR = 'never'
$env:BUNDLED_CLI_CACHE_DIR = "$Workspace\output\integration\sdk-cache"
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = 'NUL'
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'core.longpaths'
$env:GIT_CONFIG_VALUE_0 = 'true'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GIT_OPTIONAL_LOCKS = '0'
$env:pnpm_config_registry = 'https://packagefeedproxy.microsoft.io/npm/'
$env:pnpm_config_fetch_retries = '0'
$env:NO_COLOR = '1'
Get-ChildItem Env: | Sort-Object Name | Select-Object Name,Value | ConvertTo-Json |
  Set-Content -LiteralPath "$output\capture-environment-v1.json"
$driverHash = (Get-FileHash -LiteralPath $PSCommandPath).Hash
$commands = @(
  @{name='01-migrations';program='node';arguments=@('tools/check_migrations.mjs')},
  @{name='02-docs';program='pnpm';arguments=@('check:docs')},
  @{name='03-unit';program='pnpm';arguments=@('test:unit')},
  @{name='04-steward';program='pnpm';arguments=@('test:steward')},
  @{name='05-fmt';program='cargo';arguments=@('fmt','--check')},
  @{name='06-clippy';program='cargo';arguments=@('clippy','--workspace','--all-targets','--','-D','warnings')},
  @{name='07-cargo-test';program='cargo';arguments=@('test','--workspace')},
  @{name='08-web-build';program='pnpm';arguments=@('build:web')},
  @{name='09-web-lint';program='pnpm';arguments=@('lint:web')},
  @{name='10-canary';program='node';arguments=@('--test','scenarios/factory-live-canary/status.test.mjs','scenarios/factory-live-canary/git-bytes.test.mjs')}
)
foreach ($command in $commands) {
  $name = $command.name
  $program = $command.program
  $arguments = $command.arguments
  $null = Get-Command -Name $program -ErrorAction Stop
  $started = [DateTime]::UtcNow
  Clear-Host
  Write-Host "PR226 FRESH NATIVE EXECUTION / $name / $($started.ToString('o'))"
  Write-Host "SOURCE $sourceHead TREE $sourceTree"
  Write-Host "COMMAND: $program $($arguments -join ' ')"
  Write-Host 'Native Git core.longpaths=true; normal test scheduling; no test filters or added skips.'
  Write-Host ''
  $ErrorActionPreference = 'Continue'
  & $program @arguments 2>&1 | Tee-Object -FilePath "$output\logs\$name.console.txt"
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  Write-Host ''
  Write-Host "ACTUAL EXIT CODE: $code / $name"
  $receipt = [ordered]@{
    command="$program $($arguments -join ' ')"; program=$program; arguments=$arguments
    started_at=$started.ToString('o'); finished_at=[DateTime]::UtcNow.ToString('o')
    exit_code=$code; source_head=$sourceHead; source_tree=$sourceTree
    process_id=$PID; driver_sha256=$driverHash
    console_log="logs/$name.console.txt"; environment='capture-environment-v1.json'
    scope='Fresh local command execution; screenshot captures this live native terminal, not a rendered report.'
  }
  $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$output\$name.json"
  $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$SignalDirectory\$name.ready.json"
  Write-Host "WAITING FOR OWN-WINDOW CAPTURE: $name"
  $deadline = [DateTime]::UtcNow.AddMinutes(20)
  while (-not (Test-Path -LiteralPath "$SignalDirectory\$name.captured")) {
    if ([DateTime]::UtcNow -gt $deadline) { throw "Capture not completed: $name" }
    Start-Sleep -Milliseconds 250
  }
  if ($code -ne 0) { throw "Preserved failing gate: $name exit=$code" }
}
'Complete: all ten invocations exited zero; inspect their actual test/ignored/skipped counts.' |
  Set-Content -LiteralPath "$SignalDirectory\capture-v1-complete.txt"
