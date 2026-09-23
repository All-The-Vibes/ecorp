"""Apply exactly the reviewed late PR319 candidate after native evidence selection."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess

private = Path(__file__).resolve().parent
repo = Path(r"<reviewed-worktree>")
read = lambda p: json.loads(p.read_text(encoding="utf-8-sig"))
sha = lambda raw: hashlib.sha256(raw).hexdigest()

def require(value, message):
    if not value:
        raise SystemExit(message)

def git(*args):
    return subprocess.check_output(["git", "-C", str(repo), *args])

record_path = private / "queue-pr319-integration-r483.json"
input_path = private / "queue-integration-r483.json"
equivalence_path = private / "queue-native-source-equivalence-r483.json"
feedback_path = private / "pr-feedback-queue-r483.json"
require(not any(p.exists() for p in (record_path, input_path, equivalence_path, feedback_path)), "Preserve previous application.")
candidate_path = private / "queue-pr319-candidate-r475.json"
candidate = read(candidate_path)
baseline = candidate["baseline_tree"]
require(git("write-tree").decode().strip() == baseline and not git("diff", "--name-only").strip(), "Original native source changed.")
require(not git("ls-files", "--others", "--exclude-standard").strip(), "Unexpected untracked source.")
selection_path = private / "queue-native-selection-r481.json"
selection = read(selection_path)
require(selection["status"] == "selected-observed-passing-evidence" and selection["tested_staged_tree"] == baseline, "Passing native selection required before applying source changes.")
sequence_path = Path(selection["sequence_receipt"])
require(sha(sequence_path.read_bytes()) == selection["sequence_sha256"] and read(sequence_path)["status"] == "passed", "Native selection changed.")
expected = sorted([".github/workflows/ci.yml", "tools/qa_multiplayer_object_sources.test.mjs",
    "tools/qa_multiplayer_object_sources.test.ps1", "tools/qa_multiplayer_preflight.ps1", "tools/qa_multiplayer_preflight.test.ps1"])
require(sorted(f["file"] for f in candidate["files"]) == expected, "Unexpected candidate scope.")
for item in candidate["files"]:
    require(sha(git("show", baseline + ":" + item["file"])) == item["before_sha256"], "Baseline Git blob changed.")
    require(sha((private / "queue-pr319-candidate-r475" / item["file"]).read_bytes()) == item["after_sha256"], "Candidate bytes changed.")
focused = {
    "queue-pr319-candidate-r475-objects.log": "564cee1f128c3f31f52b2b4ddf1f0a29d61d2ba5dc972098bf4bc3f6c8b9b3dc",
    "queue-pr319-candidate-r475-preflight.log": "e3c94a7c79ed23296aa91d42ce071d657eacb5f690ed3bac9eca77c68dcfca48",
}
for name, digest in focused.items():
    require(sha((private / name).read_bytes()) == digest, "Focused verification log changed.")
previous_input_path = private / "queue-integration-r436.json"
inputs = read(previous_input_path)
pr = next(i for i in inputs["inputs"] if i["number"] == 319)
old, new = candidate["previous_remote_head"], candidate["reviewed_remote_head"]
require(pr["remote_head"] == old and pr["head"] == old and inputs["parents"].count(old) == 1, "Unexpected PR319 ancestry.")
require(subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", old, new], capture_output=True).returncode == 0, "Late contributor head must preserve prior ancestry.")
feedback = read(private / "pr-feedback-queue-r437.json")
latest_feedback = read(private / "pr-feedback-queue-pr319-r474.json")
if isinstance(latest_feedback, dict):
    latest_feedback = [latest_feedback]
require(isinstance(latest_feedback, list) and len(latest_feedback) == 1, "Unexpected new feedback shape.")
require(latest_feedback[0]["number"] == 319 and latest_feedback[0]["data"]["headRefOid"] == new, "New feedback head differs.")
record = {"status": "applying-reviewed-candidate", "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "baseline_tree": baseline, "candidate_sha256": sha(candidate_path.read_bytes()),
    "native_selection_sha256": sha(selection_path.read_bytes()), "files": candidate["files"], "focused_logs": focused}
record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
for item in candidate["files"]:
    (repo / item["file"]).write_bytes((private / "queue-pr319-candidate-r475" / item["file"]).read_bytes())
subprocess.run(["git", "-C", str(repo), "add", "--", *expected], check=True)
tree = git("write-tree").decode().strip()
actual = git("diff", "--name-only", baseline, tree).decode().splitlines()
require(actual == expected, "Only the exact five reviewed paths may change.")
for item in candidate["files"]:
    require(sha(git("show", tree + ":" + item["file"])) == item["after_sha256"], "Staging changed candidate bytes.")
require(not git("diff", "--name-only").strip(), "Unstaged source appeared.")
pr["remote_head"] = new
pr["head"] = new
pr["tree"] = git("rev-parse", new + "^{tree}").decode().strip()
pr["previous_input"] = {"remote_head": old, "record": previous_input_path.name, "sha256": sha(previous_input_path.read_bytes())}
inputs["parents"] = [new if p == old else p for p in inputs["parents"]]
require(len(inputs["parents"]) == 19 and len(set(inputs["parents"])) == 19, "Unexpected parent count.")
for item in inputs["inputs"]:
    for parent in [item["remote_head"], *item.get("pending_parents", [])]:
        require(any(subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", parent, p], capture_output=True).returncode == 0 for p in inputs["parents"]), "Reviewed contributor or maintainer ancestry lost.")
inputs["supersedes"] = {"file": previous_input_path.name, "sha256": sha(previous_input_path.read_bytes())}
inputs["updated_at_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
inputs["late_pr319_delta"] = {"original_head": old, "reviewed_head": new, "baseline_tree": baseline, "combined_tree": tree,
    "files": expected, "review": candidate["review"], "feedback_thread": candidate["feedback_thread"]}
input_path.write_text(json.dumps(inputs, indent=2) + "\n", encoding="utf-8")
feedback = [latest_feedback[0] if i["number"] == 319 else i for i in feedback]
feedback_path.write_text(json.dumps(feedback, indent=2) + "\n", encoding="utf-8")
unchanged = git("diff", "--name-only", baseline, tree, "--", ".", *[":(exclude)" + p for p in expected]).decode().strip()
require(not unchanged, "A native runtime, native driver, dependency or unrelated entry changed.")
equivalence = {"schema_version": 1, "status": "verified-scope-equivalence", "native_execution_tree": baseline,
    "validation_source_tree": tree, "native_selection": {"file": selection_path.name, "sha256": sha(selection_path.read_bytes())},
    "changed_paths": candidate["files"], "outside_changed_paths": [], "tracked_tree_comparison": "git diff --name-only <native_execution_tree> <validation_source_tree>; exact five-path allowlist and before/after Git blob SHA-256 checks",
    "scope": "All tracked entries outside the five standalone multiplayer preflight, preflight-test and CI paths are identical, including application code, dependencies, runtime scripts, native acceptance drivers and existing evidence. The five native suites do not import or invoke these standalone preflight files. Native execution receipts retain their original executed tree; they are reused only for unchanged runtime behavior. The changed preflight is covered by fresh focused checks and the final full validation run, whose result is recorded separately.",
    "focused_logs": focused, "at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
equivalence_path.write_text(json.dumps(equivalence, indent=2) + "\n", encoding="utf-8")
record.update(status="applied-staged-awaiting-final-validation", staged_tree=tree,
    integration_inputs_sha256=sha(input_path.read_bytes()), native_equivalence_sha256=sha(equivalence_path.read_bytes()),
    feedback_sha256=sha(feedback_path.read_bytes()), finished_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": record["status"], "tree": tree, "changed_files": len(expected), "parents": len(inputs["parents"])}))
