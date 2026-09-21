param([ValidateSet('provision','node','rust','rust-retry','rust-diagnostic','rust-exact-binary','rust-longpaths-diagnostic','rust-longpaths','web','canary')][string]$Lane)
$ErrorActionPreference = 'Stop'
$workspace = 'C:\Users\sschofield\repos\ecorp-gauntlet-pr226-20260921'
$evidence = 'C:\Users\sschofield\repos\ecorp\output\pr-gauntlet-20260921\pr226\integration'
Set-Location -LiteralPath $workspace
if ((git rev-parse --show-toplevel).Replace('/', '\') -ne $workspace) { throw 'Wrong workspace' }
$expected = '6f027117897a8ec87673e98036fd4ea22de077af'
if ((git write-tree) -ne $expected) { throw 'Unexpected index tree' }
git -c core.autocrlf=true diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'Unstaged source changes' }
$nativeTemp = [IO.Path]::GetTempPath()
$keep = @('APPDATA','ComSpec','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','Path','PATHEXT',
  'ProgramData','ProgramFiles','ProgramFiles(x86)','ProgramW6432','PSModulePath',
  'SystemRoot','USERPROFILE','windir')
Get-ChildItem Env: | Where-Object Name -NotIn $keep | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$env:TEMP = "$workspace\output\integration\tmp-$Lane"
if ($Lane -in @('rust-retry','rust-diagnostic','rust-exact-binary','rust-longpaths-diagnostic','rust-longpaths')) {
  # Native private-state fixtures must be outside source checkouts; keep their path short.
  $env:TEMP = Join-Path $nativeTemp ("p226-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
  if (Test-Path -LiteralPath $env:TEMP) { throw 'Refuse occupied temporary directory' }
}
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
$env:CARGO_TARGET_DIR = "$workspace\target"
$env:CARGO_NET_OFFLINE = 'true'
$env:CARGO_BUILD_JOBS = '2'
$env:CARGO_TERM_COLOR = 'never'
$env:BUNDLED_CLI_CACHE_DIR = "$workspace\output\integration\sdk-cache"
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = 'NUL'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GIT_OPTIONAL_LOCKS = '0'
$env:pnpm_config_registry = 'https://packagefeedproxy.microsoft.io/npm/'
$env:pnpm_config_fetch_retries = '0'
$env:NO_COLOR = '1'
if ($Lane -eq 'rust-diagnostic') { $env:GIT_TRACE2_EVENT = "$evidence\rust-diagnostic-git-trace.jsonl" }
if ($Lane -eq 'rust-exact-binary') { $env:GIT_TRACE2_EVENT = "$evidence\rust-exact-binary-git-trace.jsonl" }
if ($Lane -in @('rust-longpaths-diagnostic','rust-longpaths')) {
  $env:GIT_CONFIG_COUNT = '1'
  $env:GIT_CONFIG_KEY_0 = 'core.longpaths'
  $env:GIT_CONFIG_VALUE_0 = 'true'
}
if ($Lane -eq 'rust-longpaths-diagnostic') { $env:GIT_TRACE2_EVENT = "$evidence\rust-longpaths-git-trace.jsonl" }
Get-ChildItem Env: | Sort-Object Name | Select-Object Name,Value | ConvertTo-Json |
  Set-Content -LiteralPath "$evidence\$Lane-environment.json"

function Check([string]$Name, [string]$Program, [string[]]$Arguments) {
  $receipt = "$evidence\$Name.json"
  if (Test-Path -LiteralPath $receipt) { throw "Preserve existing receipt: $Name" }
  $before = git write-tree
  $started = [DateTime]::UtcNow
  Write-Output "START $Name : $Program $($Arguments -join ' ')"
  $ErrorActionPreference = 'Continue'
  & $Program @Arguments 1> "$evidence\$Name.stdout.log" 2> "$evidence\$Name.stderr.log"
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $after = git write-tree
  git -c core.autocrlf=true diff --quiet
  $unstaged = $LASTEXITCODE
  [ordered]@{
    command = "$Program $($Arguments -join ' ')"; program = $Program; arguments = $Arguments
    started_at = $started.ToString('o'); finished_at = [DateTime]::UtcNow.ToString('o')
    elapsed_seconds = ([DateTime]::UtcNow - $started).TotalSeconds; exit_code = $code
    workspace = $workspace; head = (git rev-parse HEAD); merge_head = (git rev-parse MERGE_HEAD)
    tree_before = $before; tree_after = $after; unstaged_diff_exit = $unstaged
    source_guard = 'git -c core.autocrlf=true diff --quiet (preserves observed checkout newline policy without loading ambient configuration)'
    stdout = "$Name.stdout.log"; stderr = "$Name.stderr.log"; environment = "$Lane-environment.json"
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receipt
  Write-Output "END $Name exit=$code"
  if ($before -ne $expected -or $after -ne $expected -or $unstaged -ne 0) { throw 'Source changed during validation' }
}

switch ($Lane) {
  provision { Check '00-pnpm-install-offline' pnpm @('install','--offline','--frozen-lockfile') }
  node {
    Check '01-migrations' node @('tools/check_migrations.mjs')
    Check '02-docs' pnpm @('check:docs')
    Check '03-unit' pnpm @('test:unit')
    Check '04-steward' pnpm @('test:steward')
  }
  rust {
    if ((Get-FileHash -LiteralPath "$env:BUNDLED_CLI_CACHE_DIR\v1.0.79-copilot-win32-x64.zip").Hash -ne
      'AE87705442B502853374A58938CA48309B44AD1AEF201E3DE56B9FF89FE3B6BD') { throw 'Unverified SDK archive' }
    Check '05-fmt' cargo @('fmt','--check')
    Check '06-clippy' cargo @('clippy','--workspace','--all-targets','--','-D','warnings')
    Check '07-cargo-test' cargo @('test','--workspace')
  }
  rust-retry { Check '07-cargo-test-temp-retry' cargo @('test','--workspace') }
  rust-diagnostic {
    Check '11-rust-held-ack-diagnostic' cargo @('test','-p','crony-runner',
      'source_checkpoint::tests::issue190_late_stop_cancels_held_ack_without_acceptance_or_post_verifier_seal',
      '--','--exact','--nocapture')
  }
  rust-exact-binary {
    Check '12-held-ack-exact-workspace-binary' "$workspace\target\debug\deps\crony_runner-87f899cdec9d59fe.exe" @(
      'source_checkpoint::tests::issue190_late_stop_cancels_held_ack_without_acceptance_or_post_verifier_seal',
      '--exact','--nocapture')
  }
  rust-longpaths-diagnostic {
    Check '13-held-ack-native-longpaths' "$workspace\target\debug\deps\crony_runner-87f899cdec9d59fe.exe" @(
      'source_checkpoint::tests::issue190_late_stop_cancels_held_ack_without_acceptance_or_post_verifier_seal',
      '--exact','--nocapture')
  }
  rust-longpaths { Check '07-cargo-test-native-longpaths' cargo @('test','--workspace') }
  web {
    Check '08-web-build' pnpm @('build:web')
    Check '09-web-lint' pnpm @('lint:web')
  }
  canary {
    Check '10-canary' node @('--test','scenarios/factory-live-canary/status.test.mjs','scenarios/factory-live-canary/git-bytes.test.mjs')
  }
}
