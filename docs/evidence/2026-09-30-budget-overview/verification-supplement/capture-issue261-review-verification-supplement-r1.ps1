#requires -Version 7.5
$ErrorActionPreference = 'Stop'
$issueQa = '<USERPROFILE>\qa\pr265-run-activity-issue261-20260930-r1'
$issueWorktree = '<USERPROFILE>\.codex\worktrees\issue261-budgets\ecorp'
$issuePostgres = '<USERPROFILE>\AppData\Local\Programs\ecorp-tools\postgresql-17.10\pgsql\bin'
$receiptPath = Join-Path $PSScriptRoot 'issue261-review-verification-supplement-r1.json'
$queryPath = Join-Path $PSScriptRoot 'issue261-review-verification-supplement-r1.sql'
$resultPath = Join-Path $PSScriptRoot 'issue261-review-verification-supplement-r1-rows.json'
foreach ($path in @($receiptPath, $queryPath, $resultPath)) {
    if (Test-Path -LiteralPath $path) { throw 'Preserve prior supplemental evidence.' }
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
Import-Module (Join-Path $issueWorktree 'tools\local_stack.psm1') -Force
$ownerPath = Join-Path $issueQa 'ownership.json'
$nativePath = Join-Path $PSScriptRoot 'issue261-review-native-r1.json'
$browserPath = Join-Path $issueQa 'evidence\issue261-browser.json'
$native = Get-Content -LiteralPath $nativePath -Raw | ConvertFrom-Json
$browser = Get-Content -LiteralPath $browserPath -Raw | ConvertFrom-Json
$state = Read-LocalStackState -Path $ownerPath -Workspace $issueQa
if ($native.status -cne 'accepted' -or !$native.stopped -or !$native.physical_source_unchanged -or
    $browser.status -cne 'accepted' -or $browser.failures.Count -or
    (Hash $browserPath) -cne $native.browser_report_sha256) { throw 'Require unchanged successful native evidence.' }
if (!$state.test_owned -or $state.purpose -cne 'pr265-run-activity' -or !$state.stopped_at -or
    !(Test-LocalPathEqual $state.plan.product $issueWorktree) -or
    !(Test-LocalPathEqual $state.plan.qa_root $issueQa) -or
    $state.plan.database.port -ne 15467 -or $state.plan.database.name -cne 'pr265_activity' -or
    $state.plan.database.host -cne '127.0.0.1') { throw 'Fixture ownership or database identity mismatch.' }
$dataPath = (Resolve-Path -LiteralPath (Join-Path $issueQa 'database')).Path
if (!(Test-LocalPathEqual (Split-Path -Parent $dataPath) $issueQa) -or
    ((Get-Item -LiteralPath $dataPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Database path is not the exact owned physical directory.'
}
foreach ($role in @('postgres', 'server', 'runner', 'web')) {
    if (Test-LocalOwnedProcess -Record $state.processes[$role] -Workspace $issueQa) {
        throw 'Preserve any active original fixture process.'
    }
}
if (Test-Path -LiteralPath (Join-Path $dataPath 'postmaster.pid')) { throw 'Database has an existing PID file; preserve it.' }
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort)
foreach ($port in @(15467, 18867, 15867)) {
    if ($listeners -contains $port) { throw 'An original fixture port is occupied; do not adopt it.' }
}
$activeForFixture = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($issueQa, [StringComparison]::OrdinalIgnoreCase) })
if ($activeForFixture.Count) { throw 'An unrecorded fixture database process is present.' }
$mission = '8f666cfa-9209-495b-8b6d-448eb124e1b7'
$expectedRuns = @('61f8e3ab-a1d6-4313-a80a-19076bd54647', 'e2ebeee8-88ed-490b-ae05-f6c00d357940')
$nativeCheck = $browser.checks.native_complete_graph_and_consumption_after_scripted_reviews
if ($nativeCheck.mission -cne $mission -or $nativeCheck.review_ids.Count -ne 2 -or
    @($nativeCheck.review_ids | Where-Object { $null -ne $_ }).Count) { throw 'The historical reporting omission differs.' }
$query = @'
BEGIN READ ONLY;
SELECT json_build_object(
  'transaction_read_only', current_setting('transaction_read_only'),
  'database', current_database(),
  'data_directory', current_setting('data_directory'),
  'requests', COALESCE((
    SELECT json_agg(row_to_json(v) ORDER BY v.run_id)
    FROM (
      SELECT q.run_id, q.corp_id, q.task_id, t.mission_id, q.gate_type, q.gate,
        q.status, q.requested_at, q.decided_by, q.decision_note, q.decided_at,
        r.status AS run_status, r.verification_status AS run_verification_status,
        t.status AS task_status, t.verification_status AS task_verification_status
      FROM verification_requests q
      JOIN runs r ON r.id = q.run_id AND r.corp_id = q.corp_id AND r.task_id = q.task_id
      JOIN tasks t ON t.id = q.task_id AND t.corp_id = q.corp_id
      WHERE t.mission_id = '8f666cfa-9209-495b-8b6d-448eb124e1b7'::uuid
        AND q.corp_id = '00000000-0000-4000-8000-000000000001'::uuid
    ) v
  ), '[]'::json)
);
ROLLBACK;
'@
[IO.File]::WriteAllText($queryPath, $query + [Environment]::NewLine)
$record = [ordered]@{
    issue=261; status='starting'; started_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    scope='Supplemental persisted-state query after native acceptance; not a replay or new review decision.'
    reporting_correction='The original driver used review.id. VerificationRequest and verification_requests use run_id as the primary identity; the original receipt therefore contains two null review_ids. Both original assertions checked approved status and the scripted Bob actor. Preserve the original driver and report unchanged.'
    schema_references=@('crates/crony-domain/src/lib.rs:977', 'db/migrations/0009_evidence_verification.sql:60')
    qa_root=$issueQa; owner_sha256=(Hash $ownerPath); native_receipt_sha256=(Hash $nativePath)
    browser_report_sha256=(Hash $browserPath); original_driver_sha256=(Hash (Join-Path $PSScriptRoot 'issue261-review-browser-r1.mjs'))
    query_sha256=(Hash $queryPath); restarted_only_owned_postgres=$true
    application_writes=$false; browser_replayed=$false; actual_human_reviews=0
    owned_process=$null; stopped=$false
}
function Save-Record { $record | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath $receiptPath -Encoding utf8 }
$failure = $null
$owned = $null
Save-Record
try {
    $launch = @{
        Role='postgres-verification-supplement'; Workspace=$issueQa
        FilePath=(Join-Path $issuePostgres 'postgres.exe')
        ArgumentList=@('-D', $dataPath, '-h', '127.0.0.1', '-p', '15467', '-c', 'default_transaction_read_only=on')
        WorkingDirectory=$issueQa; LogDirectory=(Join-Path $issueQa 'logs'); Environment=@{}
    }
    $owned = Start-LocalOwnedProcess @launch
    $record.owned_process=$owned
    Save-Record
    $deadline=[DateTimeOffset]::UtcNow.AddSeconds(30)
    do {
        if (!(Test-LocalOwnedProcess -Record $owned -Workspace $issueQa)) { throw 'Owned supplemental PostgreSQL exited unexpectedly.' }
        & (Join-Path $issuePostgres 'pg_isready.exe') -h 127.0.0.1 -p 15467 -U pr265_qa *> $null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if ($LASTEXITCODE -ne 0) { throw 'Supplemental database readiness timed out.' }
    $owners=@(Get-NetTCPConnection -State Listen -LocalPort 15467 -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1 -or $owners[0] -ne $owned.pid) { throw 'Supplemental listener ownership differs.' }
    $psi=[Diagnostics.ProcessStartInfo]::new((Join-Path $issuePostgres 'psql.exe'))
    $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true
    $psi.RedirectStandardInput=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    $psi.Environment.Clear()
    $safeEnv=New-LocalProcessEnvironment
    foreach ($key in $safeEnv.Keys) { if ($null -ne $safeEnv[$key]) { $psi.Environment[$key]=$safeEnv[$key] } }
    $psi.Environment['PGOPTIONS']='-c default_transaction_read_only=on'
    foreach ($arg in @('-X','-q','-A','-t','-w','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','15467','-U','pr265_qa','-d','pr265_activity')) {
        $psi.ArgumentList.Add($arg)
    }
    $queryProcess=[Diagnostics.Process]::Start($psi)
    try {
        $queryProcess.StandardInput.Write($query)
        $queryProcess.StandardInput.Close()
        $stdoutTask=$queryProcess.StandardOutput.ReadToEndAsync()
        $stderrTask=$queryProcess.StandardError.ReadToEndAsync()
        if (!$queryProcess.WaitForExit(30000)) { throw 'Read-only fixture query timed out; retain its process for inspection.' }
        $queryOutput=$stdoutTask.GetAwaiter().GetResult()
        $queryError=$stderrTask.GetAwaiter().GetResult()
        if ($queryProcess.ExitCode -ne 0) { throw "Read-only fixture query failed: $queryError" }
    } finally { $queryProcess.Dispose() }
    $rows=$queryOutput | ConvertFrom-Json
    [IO.File]::WriteAllText($resultPath, ($rows | ConvertTo-Json -Depth 12) + [Environment]::NewLine)
    $record.rows_sha256=Hash $resultPath
    if ($rows.transaction_read_only -cne 'on' -or $rows.database -cne 'pr265_activity' -or
        !(Test-LocalPathEqual $rows.data_directory $dataPath)) { throw 'Read-only database query identity mismatch.' }
    if (($rows.requests.run_id -join '|') -cne ($expectedRuns -join '|')) { throw 'Unexpected persisted verification request identities.' }
    foreach ($request in $rows.requests) {
        $run=@($nativeCheck.retained_runs | Where-Object { $_.run_id -ceq $request.run_id })
        if ($run.Count -ne 1 -or $request.task_id -cne $run[0].task_id -or
            $request.corp_id -cne $state.demo.corp_id -or $request.mission_id -cne $mission -or
            $request.status -cne 'approved' -or $request.decided_by -cne $state.demo.bob_actor_id -or !$request.decided_at -or
            $request.run_status -cne 'completed' -or $request.run_verification_status -cne 'passed' -or
            $request.task_status -cne 'completed' -or $request.task_verification_status -cne 'passed') {
            throw 'Persisted approval/run/task evidence differs from native acceptance.'
        }
    }
    $record.verification_request_run_ids=@($rows.requests.run_id)
    $record.requests=$rows.requests
    $record.status='verified'
} catch {
    $failure=$_.Exception.Message
    $record.status='failed'; $record.error=$failure
} finally {
    try {
        if ($owned) {
            if (!(Test-LocalOwnedProcess -Record $owned -Workspace $issueQa)) { throw 'Cannot verify the supplemental process identity before shutdown.' }
            $pidFile=Get-Content -LiteralPath (Join-Path $dataPath 'postmaster.pid') -TotalCount 1
            if ([int]$pidFile -ne $owned.pid) { throw 'Postmaster PID differs; do not stop an unowned database.' }
            & (Join-Path $issuePostgres 'pg_ctl.exe') -D $dataPath -m fast -w -t 30 stop *> (Join-Path $PSScriptRoot 'issue261-review-verification-supplement-r1-stop.log')
            if ($LASTEXITCODE -ne 0 -or (Test-LocalOwnedProcess -Record $owned -Workspace $issueQa) -or
                (Test-Path -LiteralPath (Join-Path $dataPath 'postmaster.pid'))) { throw 'Supplemental shutdown is not verified.' }
            $record.stopped=$true
        }
        if ((Hash $ownerPath) -cne $record.owner_sha256 -or (Hash $nativePath) -cne $record.native_receipt_sha256 -or
            (Hash $browserPath) -cne $record.browser_report_sha256 -or
            (Hash (Join-Path $PSScriptRoot 'issue261-review-browser-r1.mjs')) -cne $record.original_driver_sha256) {
            throw 'Historical acceptance or ownership bytes changed.'
        }
        $record.original_evidence_unchanged=$true
    } catch {
        $record.cleanup_error=$_.Exception.Message; $record.status='failed'
        if (!$failure) { $failure=$record.cleanup_error }
    }
    $record.finished_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    Save-Record
}
if ($failure) { throw $failure }
[pscustomobject]$record | Select-Object issue,status,verification_request_run_ids,stopped,original_evidence_unchanged | ConvertTo-Json -Depth 4
