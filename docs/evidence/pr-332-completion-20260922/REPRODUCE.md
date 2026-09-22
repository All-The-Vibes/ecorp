# Reproduce the verification-policy browser acceptance

This complete recipe was reconstructed on September 22, 2026 for review
5279806496. It is a reproduction guide, not a recovered historical transcript.
The original report, six application screenshots and command-report image remain
unchanged. The accompanying `prepare-browser-fixture.ps1` parameterizes the
retained synthetic-input preparation script; it adds no product harness.

The retained acceptance used product head
`d920cf70a6205ad5e91a1f102eda06de41df1bcc`. Its separate synthetic task repository
started at `3455bbea10272f33d53ed92248b8e140ef3dca6b`; preparation committed the
verifier inputs as `c0f5b88a0a174730be79a5cfff920e65927fa38b`. Fresh Git commits
depend on creation time: record the new IDs, never substitute these historical IDs.
`browser-acceptance.json` distinguishes task source from product source and binds
the product driver, supervisor, dependencies and application screenshots.

Use Windows, PowerShell 7, Git, Node, pnpm, Rust, native PostgreSQL and Microsoft
Edge. Recorded validation used Node 24.21.0, pnpm 11.19.0 and Rust 1.98.1.
Node 24.21.0 differs from the repository's 24.19.0 CI pin. The native supervisor
used PostgreSQL 17.10; the browser report records Edge 153.0.4234.48.
Playwright 1.62.1 was identified from the installed module during this follow-up;
the historical browser report did not separately record its package version.
Record the actual tool versions of a new run.

## Prepare new owned locations and matching binaries

Run in a dedicated PowerShell session. Replace these absolute paths with owned
paths on your machine. `$instructions` is a checkout containing this guide and
its preparation helper. `$product`, `$qa` and `$reproTools` must not already exist.
The QA directory must be outside the product checkout, have a parent named `qa`
and have a leaf starting with `pr265-run-activity-`.

```powershell
$ErrorActionPreference = 'Stop'
$instructions = 'D:\ECorp-QA\reviewed-pr332'
$product = 'D:\ECorp-QA\ecorp-pr332-reproduction'
$qa = 'D:\ECorp-QA\qa\pr265-run-activity-pr332-reproduction'
$reproTools = 'D:\ECorp-QA\pr332-reproduction-tools'
$pg = 'D:\ECorp-Tools\postgresql-17.10\pgsql\bin'
$head = 'd920cf70a6205ad5e91a1f102eda06de41df1bcc'
$preparation = Join-Path $instructions 'docs/evidence/pr-332-completion-20260922/prepare-browser-fixture.ps1'
if (!(Test-Path -LiteralPath $preparation)) { throw 'Use the companion preparation script from the reviewed PR.' }
foreach ($directory in @($product, $qa, $reproTools)) {
    if (Test-Path -LiteralPath $directory) { throw 'Use fresh locations; preserve prior attempts.' }
}
foreach ($program in @('initdb.exe', 'postgres.exe', 'createdb.exe', 'pg_ctl.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $pg $program))) { throw 'Install native PostgreSQL first.' }
}
git clone --no-checkout https://github.com/All-The-Vibes/ecorp.git $product
if ($LASTEXITCODE) { throw 'Clone failed.' }
git -C $product fetch origin refs/pull/332/head
if ($LASTEXITCODE) { throw 'PR history fetch failed.' }
git -C $product checkout --detach $head
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
$runOutputs = Join-Path $reproTools 'results'
New-Item -ItemType Directory -Path $runOutputs | Out-Null
npm install --prefix $reproTools --no-audit --no-fund playwright@1.62.1
if ($LASTEXITCODE) { throw 'Playwright installation failed.' }
$env:CRONY_PLAYWRIGHT_MODULE = Join-Path $reproTools 'node_modules/playwright'
$env:CRONY_BROWSER_CHANNEL = 'msedge'
node --version
pnpm --version
rustc --version
& (Join-Path $pg 'postgres.exe') --version
node -e "const {chromium}=require(process.env.CRONY_PLAYWRIGHT_MODULE); (async()=>{const b=await chromium.launch({channel:'msedge',headless:true}); console.log(b.version()); await b.close()})().catch(e=>{console.error(e);process.exitCode=1})"
if ($LASTEXITCODE) { throw 'Install Edge before continuing.' }
```

The existing driver selects the installed Edge channel through
`CRONY_BROWSER_CHANNEL`. The Playwright module path identifies the explicit
module above. The task uses no real provider or production identity.

## Start, prepare, exercise and stop the native stack

The supervisor creates a fresh owned PostgreSQL instance, development actors,
synthetic Git repository and native runner scope. Do not hand-author its
`ownership.json`. The recorded ports were **28865** for the server, **25865** for
the web UI and **25465** for PostgreSQL. The supervisor refuses occupied ports;
use free ports and preserve the actual values in the new setup if reproducing
elsewhere. This recipe uses the recorded values.

```powershell
$supervisor = Join-Path $product 'tools/qa_factory_run_activity.ps1'
$setupPath = Join-Path $runOutputs 'browser-setup.json'
try {
    & $supervisor -Phase Start -QaRoot $qa -PostgresBin $pg `
        -ServerPort 28865 -WebPort 25865 -DatabasePort 25465 `
        *> (Join-Path $runOutputs 'stack-start.log')
    $state = Get-Content -LiteralPath (Join-Path $qa 'ownership.json') -Raw | ConvertFrom-Json -AsHashtable
    $setup = [ordered]@{
        test_owned = $true
        qa_root = $qa
        output = (Join-Path $qa 'evidence')
        server_url = $state.plan.server
        web_url = $state.plan.web
        source_repository = $state.source.repository
        source_commit = $state.source.base_commit
        source = (Join-Path $qa 'source')
        workspace = (Join-Path $qa 'runner')
        runner_id = $state.plan.runner_id
        processes = $state.processes
        reviewed_product_head = $head
        fixture_inputs_prepared = $false
    }
    $setup | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $setupPath -Encoding utf8
    & $preparation -Product $product -Qa $qa -SetupPath $setupPath `
        -OutputDirectory $runOutputs -ExpectedHead $head `
        *> (Join-Path $runOutputs 'fixture-prepare.log')
    & $supervisor -Phase Status -QaRoot $qa -PostgresBin $pg `
        *> (Join-Path $runOutputs 'stack-status.log')
    $env:ECORP_POLICY_TEST = '1'
    $env:ECORP_POLICY_SETUP = $setupPath
    node tools/e2e_verification_policy_browser.mjs `
        *> (Join-Path $runOutputs 'browser.log')
    if ($LASTEXITCODE) { throw 'Browser acceptance failed; retain this attempt.' }
} finally {
    if (Test-Path -LiteralPath (Join-Path $qa 'ownership.json')) {
        & $supervisor -Phase Stop -QaRoot $qa -PostgresBin $pg `
            *> (Join-Path $runOutputs 'stack-stop.log')
    }
}
```

Preparation verifies the actual product revision, fresh synthetic source,
ownership and absence of active runs. It stops only the owned runner, writes
`check.mjs` and `fixture.test.mjs`, then commits those inputs in the synthetic
source. Both require exact `verify.txt` bytes `VERIFIED\n` and parsed `schema.json`
equal to `{ "status": "ok", "count": 1 }`. It restarts the owned deterministic
runner with fixture-only environment, updates ownership/setup and records both
source commits. It does not reset the database or alter product files. The
companion script contains the complete literal fixture programs and runner
environment; no private setup file is needed to reproduce them.

## Expected evidence and retained scope

The driver writes a new `browser-*` directory under `$qa/evidence`, containing
`report.json` and six unmodified browser screenshots. Success requires driver
exit 0, overall `status: passed`, no browser errors or blocked requests, and
`source_unchanged: true`.

The desktop 1440 by 1050 and mobile 390-pixel views exercise all six verifier
editors, literal arguments, keyboard focus and viewport fit. Browser Save
persists the policy; browser Launch reaches the server and native runner. The
positive mission completes only after all six checks pass. A second mission
with an impossible artifact floor must persist a failed run and retain its
worktree. A `runner failed` stage for that second mission is the intended
negative case; it does not mean the overall acceptance passed despite an
unexpected error. Inspect both persisted results and all six screenshots.

The synthetic screenshot-signature input is a verifier fixture, not an
application image. These runs do not prove real-provider inference, production
authentication or a human review decision. The six application PNGs remain
separate from the saved command-report image and the new live command captures.

Stop checks process identities before stopping fixture processes. It retains
database files, source, credentials, logs, evidence and workspaces. Preserve
failed attempts and choose new paths for another run. Keep credentials and raw
private payloads local; publish only inspected evidence with original and
normalized hashes clearly distinguished.
