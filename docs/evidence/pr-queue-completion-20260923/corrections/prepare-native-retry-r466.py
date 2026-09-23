"""Retain the failed fixture and prepare a fresh exact-source native retry."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess

private = Path(__file__).resolve().parent
repo = Path(r"<reviewed-worktree>")
old = private / "queue-audit-native-r412"
new = private / "queue-audit-native-r466"
read = lambda p: json.loads(p.read_text(encoding="utf-8-sig"))
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
require = lambda value, reason: None if value else (_ for _ in ()).throw(SystemExit(reason))
validation = read(private / "queue-validation-r454/validation.json")
prior = read(private / "queue-native-sequence-r433.json")
cleanup = read(private / "queue-native-failure-cleanup-r464.json")
require(prior["status"] == "failed" and cleanup["status"] == "passed"
        and cleanup["source_unchanged"] and cleanup["fixture_ports_free"], "Reconcile the failed attempt first.")
require(subprocess.check_output(["git", "-C", str(repo), "write-tree"], text=True).strip()
        == validation["staged_tree"], "The validated source changed.")
require(not new.exists(), "Preserve the earlier retry directory.")
require(not (private / "run-queue-native-sequence-r466.ps1").exists(), "Preserve the earlier retry supervisor.")
build = read(old / "build-receipt.json")
require(build["status"] == "passed" and build["staged_tree"] == validation["staged_tree"], "Matching native build required.")
for binary in build["binaries"]:
    require(sha(repo / "target-native-qualification/debug" / (binary["name"] + ".exe")) == binary["sha256"], "Native binary changed.")
anvil = repo / "tools/registry-toolchain/node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe"
forge = repo / "tools/registry-toolchain/node_modules/@foundry-rs/forge-win32-amd64/bin/forge.exe"
pins = read(repo / "tools/registry-toolchain/toolchain.json")
tool_versions = {}
for name, binary in (("anvil", anvil), ("forge", forge)):
    lines = subprocess.check_output([str(binary), "--version"], text=True).splitlines()
    require(lines[0] == f"{name} Version: {pins['foundry']['version']}" and
            lines[1] == f"Commit SHA: {pins['foundry']['commit']}", "Unpinned Foundry binary.")
    tool_versions[name] = {"version": lines[0], "commit": lines[1], "sha256": sha(binary)}
new.mkdir()
(new / "build-receipt.json").write_bytes((old / "build-receipt.json").read_bytes())
adaptations = read(old / "driver-adaptations.json")
for entry in adaptations["files"]:
    source = old / entry["adapted"]
    require(sha(source) == entry["adapted_sha256"], "The original adaptation changed.")
    require(sha(repo / entry["source"]) == entry["source_sha256"], "Product driver changed.")
    text = source.read_text(encoding="utf-8-sig").replace("phase2-queue-r412", "phase2-queue-r466")
    (new / entry["adapted"]).write_text(text, encoding="utf-8")
    entry["retry_parent_sha256"] = entry["adapted_sha256"]
    entry["adapted_sha256"] = sha(new / entry["adapted"])
    entry["changes"].append("Fresh r466 output root after a missing local Anvil installation; every acceptance assertion is retained.")
(new / "driver-adaptations.json").write_text(json.dumps(adaptations, indent=2) + "\n", encoding="utf-8")

audit_source = private / "run-queue-audit-native-r412.ps1"
audit = audit_source.read_text(encoding="utf-8-sig")
audit = audit.replace("queue-audit-native-r412", "queue-audit-native-r466")
audit = audit.replace("ecorp-queue-audit-20260923-r412", "ecorp-queue-audit-20260923-r466")
audit = audit.replace("phase2-queue-r412", "phase2-queue-r466")
audit = audit.replace("postgres-queue-audit-r412", "postgres-queue-audit-r466")
stop = r'''
function Stop-OwnedFixture {
  $cleanupPath=Join-Path $run 'cleanup-r466.json'
  if(Test-Path -LiteralPath $cleanupPath){throw 'Preserve earlier cleanup evidence.'}
  $statePath=Join-Path $output 'processes.json'
  if(Test-Path -LiteralPath $statePath){
    $ownedState=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
    foreach($ownedProcess in $ownedState.processes.Values){
      $identity=Get-LocalProcessIdentity -ProcessId $ownedProcess.pid
      if($identity -and !(Test-LocalOwnedProcess -Record $ownedProcess -Workspace $repo)){throw 'Cannot prove exact fixture ownership before cleanup.'}
    }
    & $stack -Action stop -HostDirectory $hostRoot
    if($LASTEXITCODE){throw 'Owned stack cleanup failed.'}
  }
  $postgresPath=Join-Path $run 'postgres-ownership.json'
  if(Test-Path -LiteralPath $postgresPath){
    $ownedPostgres=Get-Content -LiteralPath $postgresPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
    $identity=Get-LocalProcessIdentity -ProcessId $ownedPostgres.pid
    if($identity){
      if(!(Test-LocalOwnedProcess -Record $ownedPostgres -Workspace $run)){throw 'Cannot prove exact PostgreSQL ownership before cleanup.'}
      & (Join-Path $pg 'pg_ctl.exe') -D $cluster -m fast -w stop
      if($LASTEXITCODE){throw 'Owned PostgreSQL cleanup failed.'}
    }
  }
  $remaining=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -in @(8992,5298,55483,18557,18558,18559,18560))
  if($remaining.Count){throw 'Native fixture listeners remain; preserve unverified process owners.'}
  @{status='passed';tested_staged_tree=$build.staged_tree;retained='All source, data, private credentials, binaries, ownership records and evidence';stopped='Only processes whose PID, executable and creation time matched owned records';scope='Owned cleanup executes inside the native supervisor before it exits, so descendant streams cannot hold up the outer sequence.'}|ConvertTo-Json|Set-Content -LiteralPath $cleanupPath -Encoding utf8
}
'''
require(audit.count("function Capture-Restart") == 1, "Ambiguous audit supervisor.")
audit = audit.replace("function Capture-Restart", stop + "\nfunction Capture-Restart", 1)
needle = "}finally{\n  $receipt.finished_at_utc="
replacement = "}finally{\n  try { Step 'owned-stop' { Stop-OwnedFixture } } catch { $receipt.status='failed'; $receipt.cleanup_error=$_.Exception.Message }\n  $receipt.finished_at_utc="
require(audit.count(needle) == 1, "Ambiguous audit cleanup boundary.")
audit = audit.replace(needle, replacement, 1)
audit_target = private / "run-queue-audit-native-r466.ps1"
audit_target.write_text(audit, encoding="utf-8")
(new / "supervisor-binding.json").write_text(json.dumps({"original": audit_source.name,
    "original_sha256": sha(audit_source), "executed": audit_target.name, "executed_sha256": sha(audit_target),
    "changes": ["Fresh owned fixture paths and original matching native build.",
        "All native acceptance assertions and physical restart boundaries retained.",
        "Run exact-ownership cleanup before the native supervisor exits to release descendant process streams."]}, indent=2) + "\n", encoding="utf-8")

sequence_source = private / "run-queue-native-sequence-r433.ps1"
sequence = sequence_source.read_text(encoding="utf-8-sig")
sequence = sequence.replace("queue-validation-r432", "queue-validation-r454")
sequence = sequence.replace("queue-native-sequence-r433", "queue-native-sequence-r466")
sequence = sequence.replace("run-queue-audit-native-r412.ps1", "run-queue-audit-native-r466.ps1")
old_build = " Step 'native-build' { & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'build-queue-native-r412.ps1') }"
reuse_build = r''' Step 'native-build' {
  $priorPath=Join-Path $PSScriptRoot 'queue-native-sequence-r433.json'
  $prior=Get-Content -LiteralPath $priorPath -Raw|ConvertFrom-Json
  $buildStep=@($prior.steps|Where-Object name -eq 'native-build')
  if($buildStep.Count -ne 1 -or $buildStep[0].status -ne 'passed' -or $buildStep[0].exit_code -ne 0 -or (Get-FileHash -LiteralPath $buildStep[0].log).Hash.ToLowerInvariant() -cne $buildStep[0].sha256){throw 'Matching prior build log required.'}
  $buildPath=Join-Path $PSScriptRoot 'queue-audit-native-r466/build-receipt.json'
  $build=Get-Content -LiteralPath $buildPath -Raw|ConvertFrom-Json
  if($build.status -ne 'passed' -or $build.staged_tree -cne $v.staged_tree){throw 'Exact-source passing native build required.'}
  foreach($binary in $build.binaries){
    if((Get-FileHash -LiteralPath (Join-Path $repo "target-native-qualification/debug/$($binary.name).exe")).Hash.ToLowerInvariant() -cne $binary.sha256){throw 'Native binary changed.'}
  }
  $record.reused_native_build=@{path=$buildPath;sha256=(Get-FileHash -LiteralPath $buildPath).Hash.ToLowerInvariant();prior_sequence=$priorPath;prior_sequence_sha256=(Get-FileHash -LiteralPath $priorPath).Hash.ToLowerInvariant()}
  Write-Output 'Reused passing exact-source native build after verifying every binary and the original build log.'
 }'''
require(sequence.count(old_build) == 1, "Ambiguous build reuse boundary.")
sequence = sequence.replace(old_build, reuse_build, 1)
start = sequence.index(" Step 'audit-owned-stop' {")
end = sequence.index(" Step 'delegated' {", start)
sequence = sequence[:start] + r''' Step 'audit-owned-stop' {
  $cleanup=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'queue-audit-native-r466/cleanup-r466.json') -Raw|ConvertFrom-Json
  if($cleanup.status -ne 'passed' -or $cleanup.tested_staged_tree -cne $v.staged_tree){throw 'Audit owned cleanup must pass on the exact tested source.'}
  Write-Output 'Verified audit cleanup completed inside the native supervisor; all fixture evidence is retained.'
 }
''' + sequence[end:]
sequence_target = private / "run-queue-native-sequence-r466.ps1"
sequence_target.write_text(sequence, encoding="utf-8")

failed_audit = read(old / "acceptance-run.json")
proof = {"status": "fresh-fixture-retry-prepared", "observed_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "tested_staged_tree": validation["staged_tree"], "production_source_changed": False,
    "previous_sequence": {"file": "queue-native-sequence-r433.json", "sha256": sha(private / "queue-native-sequence-r433.json"), "status": prior["status"]},
    "previous_native_attempt": {"file": "queue-audit-native-r412/acceptance-run.json", "sha256": sha(old / "acceptance-run.json"),
        "status": failed_audit["status"], "reason": failed_audit["reason"], "steps": failed_audit["steps"]},
    "cleanup": {"file": "queue-native-failure-cleanup-r464.json", "sha256": sha(private / "queue-native-failure-cleanup-r464.json")},
    "toolchain_install": {"command": "pwsh -NoProfile -File tools/setup_base_registry.ps1", "exit_code": 0,
        "log": "queue-native-toolchain-r465.log", "sha256": sha(private / "queue-native-toolchain-r465.log"), "tools": tool_versions,
        "native_solc_sha256": sha(repo / "tools/registry-toolchain/solc-0.8.30.exe")},
    "adaptations": {"file": "queue-audit-native-r466/driver-adaptations.json", "sha256": sha(new / "driver-adaptations.json")},
    "retry_supervisor": {"file": sequence_target.name, "sha256": sha(sequence_target)},
    "scope": "Fresh audit fixture only; reuse the unchanged validated source, native binaries and database acceptance. Delegated/Factory/deliverable r433 fixtures have not started. The r433 audit failure remains a failure. No acceptance assertion was weakened."}
(private / "queue-native-retry-r466.json").write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": proof["status"], "audit_supervisor": str(audit_target), "sequence": str(sequence_target), "source": validation["staged_tree"]}))
