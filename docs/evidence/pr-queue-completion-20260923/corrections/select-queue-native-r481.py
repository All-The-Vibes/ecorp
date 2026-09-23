"""Select explicit native evidence only after the observed queue suites pass."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess

private = Path(__file__).resolve().parent
repo = Path(r"<reviewed-worktree>")
qa = Path(r"<local-user>\code\qa")
target = private / "queue-native-selection-r481.json"
read = lambda p: json.loads(p.read_text(encoding="utf-8-sig"))
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
require = lambda condition, reason: None if condition else (_ for _ in ()).throw(SystemExit(reason))
require(not target.exists(), "Preserve the earlier evidence selection.")
validation = read(private / "queue-validation-r454/validation.json")
sequence_path = private / "queue-native-sequence-r478.json"
sequence = read(sequence_path)
tree = validation["staged_tree"]
require(validation["status"] == "passed" and validation["source_unchanged"]
        and len(validation["checks"]) == 11 and all(c["exit_code"] == 0 for c in validation["checks"]),
        "All eleven completed source-bound gates must pass.")
require(sequence["status"] == "passed" and sequence["tested_staged_tree"] == tree,
        "The native sequence must actually pass on the same source.")
require(subprocess.check_output(["git", "-C", str(repo), "write-tree"], text=True).strip() == tree,
        "Staged source changed.")
require(not subprocess.check_output(["git", "-C", str(repo), "diff", "--name-only"], text=True).strip(),
        "Unstaged source changed.")
for step in sequence["steps"]:
    require(step["status"] == "passed" and step["exit_code"] == 0
            and digest(Path(step["log"])) == step["sha256"], "A native sequence step changed or failed.")

audit = repo / "output/native-qualification/phase2-queue-r471"
delegated = qa / "delegated-keycloak-pr320-20260923-r433/evidence"
factory = qa / "pr265-run-activity-pr354-20260922-r477/evidence"
deliverable = qa / "pr265-run-activity-pr355-20260923-r477/evidence"

def selected(source, name=None, redact=False):
    require(source.is_file(), "Missing selected evidence: " + source.name)
    return {"source": str(source), "name": name or source.name,
            "sha256": digest(source), "redact": redact}

audit_artifacts = [selected(audit / name, redact=True) for name in
    ("acceptance.json", "browser-qualification.json", "runtime-qualification.json",
     "github-archive-qualification.json")]
audit_artifacts += [selected(audit / name) for name in
    ("browser-prepare-completed.png", "browser-readback-completed.png", "browser-audit-evidence.png")]
audit_artifacts += [selected(private / "queue-audit-native-r471" / name) for name in
    ("cleanup-r471.json", "build-receipt.json", "driver-adaptations.json", "supervisor-binding.json")]
# Restart ownership records contain process identity, not process command arguments.
audit_artifacts += [selected(audit / "restart-evidence" / f"{stage}-restart-{boundary}.json",
                             name=f"{stage}-restart-{boundary}.json", redact=True)
                    for stage in ("signing", "broadcast", "final")
                    for boundary in ("before", "after")]

audit_artifacts += [selected(private / "queue-audit-native-r471" / name) for name in
    ("e2e_native_archive.mjs", "e2e_native_qualification_browser.mjs",
     "e2e_native_qualification.mjs", "native_qualification_acceptance.mjs",
     "native_qualification_attempt.mjs", "native_qualification_stack.ps1")]
audit_artifacts += [selected(private / "queue-native-build-r412/build.log", name="native-build.log")]

suites = [
    {"name": "audit", "receipt": str(private / "queue-audit-native-r471/acceptance-run.json"),
     "artifacts": audit_artifacts},
    {"name": "delegated", "receipt": str(private / "queue-delegated-native-r433.json"),
     "artifacts": [selected(delegated / name) for name in
        ("synthetic-integration.json", "synthetic-receipt.json", "browser-private-receipt.png",
         "browser-completed.png", "browser-cancelled.png")]},
    {"name": "database", "receipt": str(private / "queue-native-database-r455.json"), "artifacts": []},
    {"name": "factory-readiness", "receipt": str(private / "pr354-native-r477-lifecycle.json"),
     # These ledgers already hash capabilities before serialization; do not hash them again.
     "artifacts": [selected(factory / name) for name in
        ("pr354-dispatch-readiness.json", "pr354-ledger-before.json", "pr354-ledger-after.json")]},
    {"name": "deliverable-failure", "receipt": str(private / "pr355-native-r477-lifecycle.json"),
     "artifacts": [selected(deliverable / "pr355-preserved-export.json", redact=True),
                   selected(deliverable / "pr355-restricted-scope.png"),
                   selected(deliverable / "pr355-complete-scope.png")]},
]
for suite in suites:
    receipt = read(Path(suite["receipt"]))
    require(receipt["status"] == "passed"
            and receipt.get("tested_staged_tree", receipt.get("staged_tree")) == tree,
            "Native receipt did not pass on the tested source: " + suite["name"])
    for check in receipt.get("checks", receipt.get("steps", [])):
        require(check["exit_code"] == 0 and check.get("status", "passed") == "passed"
                and digest(Path(check["log"])) == check["sha256"],
                "Native evidence changed: " + suite["name"])
    if suite["name"] != "audit":
        require(receipt.get("cleanup", "").startswith("Only "), "Owned cleanup is not confirmed.")
cleanup = read(private / "queue-audit-native-r471/cleanup-r471.json")
require(cleanup["status"] == "passed" and cleanup["tested_staged_tree"] == tree,
        "Audit cleanup was not confirmed on the tested source.")
plan = read(private / "queue-package-inputs-r458.json")
corrections = []
for artifact in plan["correction_artifacts"]:
    source = private / artifact["file"]
    require(digest(source) == artifact["sha256"], "Historical correction evidence changed.")
    corrections.append(str(source))
correction = private / "queue-native-fixture-path-correction-r460.json"
require(correction.is_file(), "Required fixture-path correction receipt missing.")
corrections.append(str(correction))
for name in (
    "queue-native-sequence-r433.json", "queue-native-failure-cleanup-r464.json",
    "queue-native-toolchain-r465.log", "queue-native-retry-r466.json",
    "prepare-native-retry-r466.py", "run-queue-audit-native-r466.ps1",
    "run-queue-native-sequence-r466.ps1"):
    source = private / name
    require(source.is_file(), "Missing retained retry evidence.")
    corrections.append(str(source))
for name in (
    "queue-native-sequence-r466.json", "queue-audit-r466-acceptance.json",
    "queue-audit-r466-readback.log", "queue-audit-r466-cleanup.json",
    "queue-native-retry-r471.json", "prepare-native-retry-r471.py",
    "run-queue-audit-native-r471.ps1", "run-queue-native-sequence-r471.ps1",
    "queue-native-selection-binding-r472.json"):
    source = private / name
    require(source.is_file(), "Missing retained readback correction evidence.")
    corrections.append(str(source))
for name in (
    "queue-native-sequence-r471.json", "pr354-native-r433-lifecycle.json",
    "pr354-native-r433-sqlx-factory-connection.log", "pr354-native-r433-stack-stop.log",
    "prepare-queue-native-resume-r477.py", "queue-native-resume-r477.json",
    "run-pr354-native-first-run-r477.ps1", "run-queue-native-sequence-r477.ps1",
    "queue-native-resume-binding-r478.json", "run-queue-native-sequence-r478.ps1",
    "queue-native-selection-binding-r481.json"):
    source = private / name
    require(source.is_file(), "Missing retained Factory replay correction.")
    corrections.append(str(source))
for suite in suites:
    suite["receipt_sha256"] = digest(Path(suite["receipt"]))
    if suite["name"] == "factory-readiness":
        suite["artifacts"].append(selected(private / "run-pr354-native-first-run-r477.ps1"))
selection = {"status": "selected-observed-passing-evidence", "tested_staged_tree": tree,
             "observed_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
             "sequence_receipt": str(sequence_path), "sequence_sha256": digest(sequence_path),
             "suites": suites, "correction_artifacts": corrections,
             "scope": "Explicit artifact selection only; no fixture credentials or whole directories. "
                      "Capability-bearing raw JSON is redacted once during packaging; factory ledgers "
                      "retain their original pre-serialization redaction."}
target.write_text(json.dumps(selection, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": selection["status"], "path": str(target),
                  "suites": len(suites), "artifacts": sum(len(s["artifacts"]) for s in suites),
                  "correction_artifacts": len(corrections)}))
