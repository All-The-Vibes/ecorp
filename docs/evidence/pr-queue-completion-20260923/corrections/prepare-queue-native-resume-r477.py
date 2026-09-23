"""Bind a replay-count correction and resume only the unfinished native suites."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess

private = Path(__file__).resolve().parent
repo = Path(r"<reviewed-worktree>")
baseline = "67e9c956ad29ed0ffdb10b165d6320a506a3eb5b"
read = lambda p: json.loads(p.read_text(encoding="utf-8-sig"))
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def require(value, message):
    if not value:
        raise SystemExit(message)

def git(*args):
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()

record_path = private / "queue-native-resume-r477.json"
driver_path = private / "run-pr354-native-first-run-r477.ps1"
sequence_path = private / "run-queue-native-sequence-r477.ps1"
require(not any(p.exists() for p in (record_path, driver_path, sequence_path)), "Preserve earlier preparation.")
require(git("write-tree") == baseline and not git("diff", "--name-only"), "Native source changed.")
prior_path = private / "queue-native-sequence-r471.json"
prior = read(prior_path)
require(prior["status"] == "failed" and prior["steps"][-1]["name"] == "factory-readiness", "Unexpected stopped sequence.")
require(prior["tested_staged_tree"] == baseline, "Prior source differs.")
for step in prior["steps"][:5]:
    require(step["status"] == "passed" and step["exit_code"] == 0 and sha(Path(step["log"])) == step["sha256"], "Prior successful step changed.")
failed_path = private / "pr354-native-r433-lifecycle.json"
failed = read(failed_path)
require(failed["status"] == "failed" and failed["failure"] == "The factory-connection suite did not execute all 9 expected PostgreSQL regressions.", "Unexpected Factory failure.")
require(failed["cleanup"].startswith("Only owned processes stopped") and failed["tested_staged_tree"] == baseline, "Owned cleanup/source unconfirmed.")
test_log = private / "pr354-native-r433-sqlx-factory-connection.log"
checks = {c["name"]: c for c in failed["checks"]}
require(checks["owned-postgresql-factory-connection-regressions"]["exit_code"] == 0 and sha(test_log) == checks["owned-postgresql-factory-connection-regressions"]["sha256"], "Factory SQLx log changed.")
names = re.findall(r"^test (factory_connection_tests::\S+) \.\.\. ok$", test_log.read_text(encoding="utf-8-sig"), re.M)
require(len(names) == 16 and len(set(names)) == 16, "Expected sixteen actual Factory regressions.")
require(sum("::claim_authority::" in n for n in names) == 4 and sum("::readiness::" in n for n in names) == 4, "Required nested suites absent.")

original_path = repo / "docs/evidence/pr-354-completion-20260922-r3/replay/run-pr354-native-first-run-r9.ps1"
driver = original_path.read_text(encoding="utf-8-sig")
require(driver.count("name='factory-connection';expected=9") == 1, "Unexpected replay contract.")
driver = driver.replace("name='factory-connection';expected=9", "name='factory-connection';expected=16")
driver = driver.replace("& cargo test -p $suite.package", "& cargo test --locked -p $suite.package")
for name in ("qa-pr354-readiness-r9.mjs", "qa-pr354-stack-r3.ps1", "qa-pr354-browser-preflight-r3.mjs"):
    old = "Join-Path $PSScriptRoot '" + name + "'"
    require(driver.count(old) == 1, "Unexpected replay dependency: " + name)
    driver = driver.replace(old, "Join-Path $product 'docs/evidence/pr-354-completion-20260922-r3/replay/" + name + "'")
needle = "        Record-Check \"owned-postgresql-$($suite.name)-regressions\" $log $LASTEXITCODE\n"
require(driver.count(needle) == 1, "Missing count checkpoint.")
expected = "\n".join("            '" + name + "'" for name in sorted(names))
driver = driver.replace(needle, needle + """        if ($suite.name -eq 'factory-connection') {
          $expectedTests = @(
""" + expected + """
          )
          $actualTests = @([regex]::Matches((Get-Content -LiteralPath $log -Raw), '(?m)^test (factory_connection_tests::\\S+) \\.\\.\\. ok\\r?$') | ForEach-Object { $_.Groups[1].Value } | Sort-Object)
          if (($actualTests -join "`n") -cne ($expectedTests -join "`n")) { throw 'The exact reviewed sixteen Factory regressions must execute successfully.' }
        }
""")
driver_path.write_text(driver, encoding="utf-8", newline="\n")

sequence_original = private / "run-queue-native-sequence-r471.ps1"
sequence = sequence_original.read_text(encoding="utf-8-sig")
start = sequence.index("try{\n Step 'native-build'")
end = sequence.index(" Step 'factory-readiness' {", start)
replacement = r"""try{
 Step 'verify-prior-suites' {
  $priorPath=Join-Path $PSScriptRoot 'queue-native-sequence-r471.json'
  $prior=Get-Content -LiteralPath $priorPath -Raw|ConvertFrom-Json
  if($prior.status -ne 'failed' -or $prior.tested_staged_tree -cne $v.staged_tree -or $prior.steps[-1].name -ne 'factory-readiness'){throw 'Prior sequence differs.'}
  foreach($name in @('native-build','audit','audit-owned-stop','delegated','database')){
   $step=@($prior.steps|Where-Object name -eq $name)
   if($step.Count -ne 1 -or $step[0].status -ne 'passed' -or $step[0].exit_code -ne 0 -or (Get-FileHash -LiteralPath $step[0].log).Hash.ToLowerInvariant() -cne $step[0].sha256){throw 'A reused passing step changed.'}
  }
  foreach($relative in @('queue-audit-native-r471/acceptance-run.json','queue-delegated-native-r433.json','queue-native-database-r455.json')){
   $path=Join-Path $PSScriptRoot $relative
   $native=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
   if($native.status -ne 'passed' -or $native.tested_staged_tree -cne $v.staged_tree){throw 'Matching-source native acceptance required.'}
   foreach($check in @($native.checks)+@($native.steps)){
    if(!$check){continue}
    if($check.exit_code -ne 0 -or (Get-FileHash -LiteralPath $check.log).Hash.ToLowerInvariant() -cne $check.sha256){throw 'Native log changed.'}
   }
  }
  $record.reused_sequence=@{path=$priorPath;sha256=(Get-FileHash -LiteralPath $priorPath).Hash.ToLowerInvariant();scope='Only the five completed steps; failed Factory acceptance remains failed.'}
  Write-Output 'Verified completed audit, delegated and database acceptance on the unchanged source. Their original receipts remain unchanged.'
 }
 Step 'retain-failed-factory-binaries' {
  Retain-Binaries 'pr354-native-r433-lifecycle.json' 'queue-pr354-retained-binaries-r433' 'failed'
 }
"""
sequence = sequence[:start] + replacement + sequence[end:]
# Only current sequence/fixture outputs receive the new revision; earlier receipts retain their original identities.
sequence = sequence.replace("queue-native-sequence-r471-$Name", "queue-native-sequence-r477-$Name")
sequence = sequence.replace("$receiptPath=Join-Path $PSScriptRoot 'queue-native-sequence-r471.json'", "$receiptPath=Join-Path $PSScriptRoot 'queue-native-sequence-r477.json'")
sequence = sequence.replace("(Join-Path $repo 'docs/evidence/pr-354-completion-20260922-r3/replay/run-pr354-native-first-run-r9.ps1') -Revision r433", "(Join-Path $PSScriptRoot 'run-pr354-native-first-run-r477.ps1') -Revision r477")
sequence = sequence.replace("pr265-run-activity-pr354-20260922-r433", "pr265-run-activity-pr354-20260922-r477")
sequence = sequence.replace("(Join-Path $repo 'docs/evidence/pr-355-completion-20260922-r3/replay/run-pr355-native-first-run-r6.ps1') -Revision r433", "(Join-Path $repo 'docs/evidence/pr-355-completion-20260922-r3/replay/run-pr355-native-first-run-r6.ps1') -Revision r477")
sequence = sequence.replace("pr265-run-activity-pr355-20260923-r433", "pr265-run-activity-pr355-20260923-r477")
retention_start = sequence.index(" Step 'retain-factory-binaries' {")
retention_end = sequence.index(" Step 'deliverable-failure' {", retention_start)
sequence = sequence[:retention_start] + " Step 'retain-factory-binaries' { Retain-Binaries 'pr354-native-r477-lifecycle.json' 'queue-pr354-retained-binaries-r477' 'passed' }\n" + sequence[retention_end:]
function = r"""
function Retain-Binaries([string]$ReceiptName,[string]$DestinationName,[string]$ExpectedStatus){
 $path=Join-Path $PSScriptRoot $ReceiptName
 $native=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
 if($native.status -ne $ExpectedStatus -or $native.cleanup -notlike 'Only owned processes stopped*' -or $native.tested_staged_tree -cne $v.staged_tree){throw 'Exact completed fixture and cleanup required.'}
 $sourceRoot=[IO.Path]::GetFullPath((Join-Path $repo 'target/debug'))
 $destination=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot $DestinationName))
 if(!$destination.StartsWith([IO.Path]::GetFullPath($PSScriptRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $destination)){throw 'Invalid or existing binary retention path.'}
 foreach($binary in $native.binaries){
  if($binary.file -notin @('crony-server.exe','crony-runner.exe','crony-cli.exe')){throw 'Unexpected binary selection.'}
  $binaryPath=[IO.Path]::GetFullPath((Join-Path $sourceRoot $binary.file))
  if([IO.Path]::GetDirectoryName($binaryPath) -cne $sourceRoot -or (Get-FileHash -LiteralPath $binaryPath).Hash.ToLowerInvariant() -cne $binary.sha256){throw 'Owned binary changed.'}
  $live=@(Get-CimInstance Win32_Process -Filter ("Name = '"+$binary.file+"'") | Where-Object {$_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $binaryPath})
  if($live.Count){throw 'Owned native binary is still in use.'}
 }
 New-Item -ItemType Directory -Path $destination|Out-Null
 foreach($binary in $native.binaries){
  Move-Item -LiteralPath (Join-Path $sourceRoot $binary.file) -Destination (Join-Path $destination $binary.file)
  if((Get-FileHash -LiteralPath (Join-Path $destination $binary.file)).Hash.ToLowerInvariant() -cne $binary.sha256){throw 'Retained binary digest changed.'}
 }
 @{status='retained';source=$sourceRoot;destination=$destination;binaries=$native.binaries;original_receipt_sha256=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $destination 'retention-receipt.json') -Encoding utf8
}
"""
sequence = sequence.replace("$pg='C:", function + "\n$pg='C:", 1)
sequence_path.write_text(sequence, encoding="utf-8", newline="\n")
record = {"status": "prepared-not-executed", "at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "tested_staged_tree": baseline, "original_sequence": {"file": prior_path.name, "sha256": sha(prior_path)},
          "failed_factory": {"file": failed_path.name, "sha256": sha(failed_path)},
          "observed_factory_tests": names, "reason": "All sixteen current SQLx Factory tests passed, but historical replay expected nine. Retain failure; require exactly all sixteen in the new private replay and complete the remaining browser acceptance.",
          "driver_original": {"file": str(original_path.relative_to(repo)), "sha256": sha(original_path)},
          "driver": {"file": driver_path.name, "sha256": sha(driver_path)},
          "sequence": {"file": sequence_path.name, "sha256": sha(sequence_path)},
          "scope": "Private replay correction only. Product and historical evidence unchanged. Reuse completed native suites only on their exact original source after checking original hashes. Fresh owned Factory and deliverable fixtures."}
record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": record["status"], "record": str(record_path), "current_factory_cases": len(names)}))
