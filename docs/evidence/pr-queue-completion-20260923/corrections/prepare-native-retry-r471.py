"""Preserve r466 and correct its stale helper URI in a fresh native fixture."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlparse

private = Path(__file__).resolve().parent
repo = Path(r"<reviewed-worktree>")
node = Path(r"<local-user>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe")
old = private / "queue-audit-native-r466"
new = private / "queue-audit-native-r471"
read = lambda p: json.loads(p.read_text(encoding="utf-8-sig"))
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
require = lambda condition, reason: None if condition else (_ for _ in ()).throw(SystemExit(reason))
validation = read(private / "queue-validation-r454/validation.json")
failed = read(old / "acceptance-run.json")
cleanup = read(old / "cleanup-r466.json")
require(failed["status"] == "failed" and failed["reason"] == "runtime-readback returned nonzero exit.", "Expected preserved readback failure.")
require(cleanup["status"] == "passed" and cleanup["tested_staged_tree"] == validation["staged_tree"], "Exact-source owned cleanup required.")
failure_log = (old / "runtime-readback.log").read_text(encoding="utf-8-sig")
require("ENOENT" in failure_log and "phase2-queue-r412" in failure_log and "current-attempt.json" in failure_log, "Failure diagnosis changed.")
require(subprocess.check_output(["git", "-C", str(repo), "write-tree"], text=True).strip() == validation["staged_tree"], "Validated source changed.")
require(not subprocess.check_output(["git", "-C", str(repo), "diff", "--name-only"], text=True).strip(), "Unstaged source changed.")
require(not new.exists(), "Preserve prior retry output.")
for name in ("run-queue-audit-native-r471.ps1", "run-queue-native-sequence-r471.ps1", "queue-native-retry-r471.json"):
    require(not (private / name).exists(), "Preserve prior retry artifacts.")
build = read(old / "build-receipt.json")
require(build["status"] == "passed" and build["staged_tree"] == validation["staged_tree"], "Exact-source passing build required.")
for binary in build["binaries"]:
    require(sha(repo / "target-native-qualification/debug" / (binary["name"] + ".exe")) == binary["sha256"], "Native binary changed.")
adaptations = read(old / "driver-adaptations.json")
drivers = []
uri_bindings = []
for entry in adaptations["files"]:
    source = old / entry["adapted"]
    require(sha(source) == entry["adapted_sha256"] and sha(repo / entry["source"]) == entry["source_sha256"], "A recorded driver changed.")
    before = source.read_text(encoding="utf-8-sig")
    after = before.replace("phase2-queue-r466", "phase2-queue-r471").replace("queue-audit-native-r412/", "queue-audit-native-r471/")
    require(not re.search(r"(?:phase2-queue|queue-audit-native)-r(?:412|433|466)", after), "A stale executable fixture binding remains.")
    require(after.replace("phase2-queue-r471", "phase2-queue-r466").replace("queue-audit-native-r471/", "queue-audit-native-r412/") == before, "Only exact path substitutions are authorized by this correction.")
    for uri in re.findall(r'[\x22\x27](file:///[^\x22\x27]+)[\x22\x27]', after):
        local = Path(unquote(urlparse(uri).path).lstrip("/"))
        require(local.parent == new or local.is_file(), "Imported product helper does not exist.")
        uri_bindings.append({"driver": entry["adapted"], "uri": uri})
    drivers.append((entry, source, after))
new.mkdir()
(new / "build-receipt.json").write_bytes((old / "build-receipt.json").read_bytes())
for entry, source, after in drivers:
    target = new / entry["adapted"]
    target.write_text(after, encoding="utf-8")
    entry["retry_parent_sha256"] = sha(source)
    entry["adapted_sha256"] = sha(target)
    entry["changes"].append("Fresh r471 output and helper import URI, correcting r466's stale r412 helper URI; exact path substitutions only, all assertions retained.")
    if target.suffix == ".mjs":
        subprocess.run([str(node), "--check", str(target)], check=True)
(new / "driver-adaptations.json").write_text(json.dumps(adaptations, indent=2) + "\n", encoding="utf-8")
supervisors = []
for stem in ("run-queue-audit-native", "run-queue-native-sequence"):
    original = private / f"{stem}-r466.ps1"
    target = private / f"{stem}-r471.ps1"
    text = original.read_text(encoding="utf-8-sig").replace("r466", "r471")
    target.write_text(text, encoding="utf-8")
    supervisors.append({"original": original.name, "original_sha256": sha(original), "executed": target.name, "executed_sha256": sha(target)})
(new / "supervisor-binding.json").write_text(json.dumps({"supervisors": supervisors, "changes": ["Fresh r471 fixture paths only; owned cleanup, all acceptance steps and physical restart boundaries unchanged."]}, indent=2) + "\n", encoding="utf-8")
preserved = []
for path in (private / "queue-native-sequence-r466.json", old / "acceptance-run.json", old / "runtime-readback.log", old / "cleanup-r466.json", old / "driver-adaptations.json"):
    preserved.append({"file": str(path.relative_to(private)), "sha256": sha(path)})
proof = {"status": "fresh-fixture-retry-prepared", "observed_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "tested_staged_tree": validation["staged_tree"], "production_source_changed": False, "qualification_assertions_modified": False,
    "failure": "r466 runtime readback imported the r412 attempt helper, which looked for the r412 current-attempt.json. The real runtime/signing/broadcast/recovery steps passed. r466 stays failed.",
    "preserved_attempt": preserved, "helper_uri_bindings": uri_bindings, "supervisors": supervisors,
    "adaptations": {"file": str((new / "driver-adaptations.json").relative_to(private)), "sha256": sha(new / "driver-adaptations.json")},
    "scope": "Fresh native audit only, unchanged validated product source and binaries; untouched delegated/Factory/deliverable r433 fixtures and source-bound r455 database acceptance reused."}
(private / "queue-native-retry-r471.json").write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": proof["status"], "staged_tree": validation["staged_tree"], "drivers": len(drivers), "helper_bindings": len(uri_bindings), "sequence": "run-queue-native-sequence-r471.ps1"}))
