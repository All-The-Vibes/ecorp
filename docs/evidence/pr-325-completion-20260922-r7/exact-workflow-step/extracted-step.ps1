$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
pwsh -NoProfile -File ./tools/local_stack_browser_policy_handoff.test.ps1 -NodePath $nodePath -OutputDirectory (Join-Path $env:GITHUB_WORKSPACE 'output/runner-platform-browser-policy-handoff')
