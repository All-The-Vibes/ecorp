"""Prepare a retained selector for the resumed native acceptance; do not select early."""
import hashlib
import json
from pathlib import Path

private = Path(__file__).resolve().parent
source = private / "prepare-queue-native-selection-r472.py"
target = private / "select-queue-native-r481.py"
binding = private / "queue-native-selection-binding-r481.json"
if target.exists() or binding.exists():
    raise SystemExit("Preserve earlier selector preparation.")
text = source.read_text(encoding="utf-8-sig")
replacements = {
    'target = private / "queue-native-selection-r472.json"': 'target = private / "queue-native-selection-r481.json"',
    'sequence_path = private / "queue-native-sequence-r471.json"': 'sequence_path = private / "queue-native-sequence-r478.json"',
    'pr265-run-activity-pr354-20260922-r433/evidence': 'pr265-run-activity-pr354-20260922-r477/evidence',
    'pr265-run-activity-pr355-20260923-r433/evidence': 'pr265-run-activity-pr355-20260923-r477/evidence',
    'pr354-native-r433-lifecycle.json': 'pr354-native-r477-lifecycle.json',
    'pr355-native-r433-lifecycle.json': 'pr355-native-r477-lifecycle.json',
}
for old, new in replacements.items():
    if text.count(old) != 1:
        raise SystemExit("Unexpected selector boundary: " + old)
    text = text.replace(old, new)
needle = 'selection = {"status": "selected-observed-passing-evidence"'
addition = '''for name in (
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
'''
if text.count(needle) != 1:
    raise SystemExit("Unexpected selection creation boundary.")
text = text.replace(needle, addition + needle)
target.write_text(text, encoding="utf-8", newline="\n")
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
binding.write_text(json.dumps({"status": "prepared-not-executed", "original": source.name,
    "original_sha256": sha(source), "selector": target.name, "selector_sha256": sha(target),
    "scope": "Select audit r471, delegated r433, database r455, Factory and deliverable r477 only after resumed sequence r478 passes on unchanged source. Retain failed Factory count expectation and private replay corrections."}, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"selector": str(target), "status": "prepared-not-executed"}))
