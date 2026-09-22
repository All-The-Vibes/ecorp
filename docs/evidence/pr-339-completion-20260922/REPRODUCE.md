# Reproduce the independent-review browser acceptance

This recipe was reconstructed on September 22, 2026 in response to review
5279985007. It is a new reproduction guide, not a recovered transcript of the
historical invocation. The original reports, seven screenshots and two failed
attempts remain unchanged.

The retained run used product head `c71796a203620d231533f25277158551a2c97de2`
plus staged product tree `d5d88dd7a002c094e86a806a1fc4823db8e654ed`.
Published commit `e0b550fd8150be35c7a9c462469b3fc0e39de2d2` contains that product
source and its subsequent evidence. The independent synthetic task repository
had commit `89d17d9bde3684134b8406389fccd8b76a06a347`. A fresh supervisor run
creates and records a new synthetic commit; do not relabel it as the old one.

The driver uses development Alice, Bob and Eve identities, PostgreSQL and the
native deterministic runner. It performs no real-provider inference or production
identity validation and does not represent a human review decision.

## Prerequisites and a fresh checkout

Use Windows with PowerShell 7, Git, Node, pnpm, Rust, native PostgreSQL tools and
Microsoft Edge. The retained validation used Node 24.21.0, pnpm 11.19.0 and
Rust 1.98.1; Node 24.21.0 differs from the repository's 24.19.0 CI pin. The
supervisor used PostgreSQL 17.10. The browser report records Edge
153.0.4234.48. This reconstructed recipe pins Playwright 1.62.1, identified from
the installed module during this follow-up; the historical report did not record
that module version separately. Record actual versions when reproducing.

Run the following in a dedicated PowerShell session. Replace the example absolute
paths with new, owned locations. The QA directory's parent must be named `qa` and
its leaf must start with `pr265-run-activity-`. It must be outside the product.
The QA and tooling directories below must not already exist.

```powershell
$ErrorActionPreference = 'Stop'
$product = 'D:\ECorp-QA\ecorp-pr339-reproduction'
$qa = 'D:\ECorp-QA\qa\pr265-run-activity-pr339-reproduction'
$reproTools = 'D:\ECorp-QA\pr339-reproduction-tools'
$pg = 'D:\ECorp-Tools\postgresql-17.10\pgsql\bin'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
foreach ($directory in @($product, $qa, $reproTools)) {
    if (Test-Path -LiteralPath $directory) { throw 'Use fresh locations; preserve prior attempts.' }
}
foreach ($program in @('initdb.exe', 'postgres.exe', 'createdb.exe', 'pg_ctl.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $pg $program))) { throw 'Install the native PostgreSQL tools first.' }
}
if (!(Test-Path -LiteralPath $edge)) { throw 'Install Microsoft Edge at the driver-selected path first.' }
git clone --no-checkout https://github.com/All-The-Vibes/ecorp.git $product
if ($LASTEXITCODE) { throw 'Clone failed.' }
git -C $product checkout --detach e0b550fd8150be35c7a9c462469b3fc0e39de2d2
if ($LASTEXITCODE) { throw 'Pinned checkout failed.' }
Set-Location -LiteralPath $product
foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    if ($name -match '^(CRONY_|ECORP_|PG|GH_|GITHUB_|AZURE_)' -or
        $name -in @('DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
                   'COPILOT_GITHUB_TOKEN', 'NODE_OPTIONS')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
}
$env:CARGO_TARGET_DIR = Join-Path $product 'target'
pnpm install --frozen-lockfile
if ($LASTEXITCODE) { throw 'Dependency installation failed.' }
cargo build --locked -p crony-server -p crony-runner --bins
if ($LASTEXITCODE) { throw 'Matching-source native build failed.' }
New-Item -ItemType Directory -Path $reproTools | Out-Null
npm install --prefix $reproTools --no-audit --no-fund playwright@1.62.1
if ($LASTEXITCODE) { throw 'Playwright installation failed.' }
$env:CRONY_PLAYWRIGHT_MODULE = Join-Path $reproTools 'node_modules/playwright'
node --version
pnpm --version
rustc --version
& (Join-Path $pg 'postgres.exe') --version
(Get-Item -LiteralPath $edge).VersionInfo.ProductVersion
```

The driver selects the installed Edge executable explicitly. No Playwright browser
download is needed. If Edge is installed elsewhere, update only the copied driver's
`executablePath`, and record that path and actual browser version for the new run.

## Substitute the published placeholders and execute

The published driver requires an ownership record created by the supervisor. Never
hand-author `ownership.json` or point it at a retained/shared stack. The supervisor
creates a fresh PostgreSQL database, synthetic source, runner scope and development
identities. The driver refuses a fixture containing any mission or run.

Ports **28870** (server) and **25870** (web) are fixed by assertions in the driver.
The recipe uses **25470** for the new PostgreSQL instance. The supervisor refuses
occupied ports. Changing the supervisor's defaults without these overrides will
not satisfy the published driver.

```powershell
$template = Join-Path $product 'docs/evidence/pr-339-completion-20260922/browser-driver.mjs'
$driverPath = Join-Path $reproTools 'browser-driver.mjs'
$driver = [IO.File]::ReadAllText($template)
$driver = $driver.Replace('<reviewed-worktree>', $product)
$driver = $driver.Replace('<local-user>\code\qa\pr265-run-activity-pr339-20260922T123548Z-r3', $qa)
if ($driver.Contains('<reviewed-worktree>') -or $driver.Contains('<local-user>')) {
    throw 'Not all published path placeholders were substituted.'
}
[IO.File]::WriteAllText($driverPath, $driver, [Text.UTF8Encoding]::new($false))
$supervisor = Join-Path $product 'tools/qa_factory_run_activity.ps1'
try {
    & $supervisor -Phase Start -QaRoot $qa -PostgresBin $pg `
        -ServerPort 28870 -WebPort 25870 -DatabasePort 25470 `
        *> (Join-Path $reproTools 'stack-start.log')
    & $supervisor -Phase Status -QaRoot $qa -PostgresBin $pg `
        *> (Join-Path $reproTools 'stack-status.log')
    node $driverPath *> (Join-Path $reproTools 'browser.log')
    if ($LASTEXITCODE) { throw 'Browser acceptance failed; preserve this attempt.' }
} finally {
    if (Test-Path -LiteralPath (Join-Path $qa 'ownership.json')) {
        & $supervisor -Phase Stop -QaRoot $qa -PostgresBin $pg `
            *> (Join-Path $reproTools 'stack-stop.log')
    }
}
```

Success creates `evidence/pr339-reviewer/report.json` and seven PNG screenshots
inside the new QA root. The report must say `passed`, contain no browser errors or
blocked requests, preserve the synthetic source and record a completed run. Alice's
requester exclusion disables her review controls, Bob's eligible controls remain
enabled, and Eve cannot see the mission or run. The browser saves and launches the
mission, the native artifact check passes, and the run completes only after the
development Bob identity accepts the pending review. Desktop and mobile captures
record those positive and negative states. A changed ownership identity, dirty source,
nonempty fixture, wrong port or failed persisted-state assertion must fail the attempt.

`Stop` verifies recorded process identities and stops only this fixture's processes.
It preserves the database, source, credentials, logs, evidence and workspaces. Do not
delete or reuse an unsuccessful fixture; inspect its retained records and use new
paths for another attempt. Keep credential files and raw private logs local. Publish
only inspected, normalized evidence and distinguish the new run from the retained one.
