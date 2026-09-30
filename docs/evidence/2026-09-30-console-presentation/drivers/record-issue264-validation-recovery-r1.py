"""Record observed validation and source applicability without rewriting prior receipts."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

EV = Path(__file__).resolve().parent
WT = Path(r"<USERPROFILE>\.codex\worktrees\issue264-modes\ecorp")
QA = Path(r"<USERPROFILE>\qa\pr265-run-activity-issue264-20260930-r14")

def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def reference(path):
    return {"path": str(path), "sha256": digest(path)}

def write(name, value):
    with (EV / name).open("x", encoding="utf-8", newline="\n") as output:
        output.write(json.dumps(value, indent=2, ensure_ascii=False) + "\n")

old_path = EV / "issue264-review-source-before-native-r14.json"
new_path = EV / "issue264-review-source-before-check-r3.json"
old, new = read(old_path), read(new_path)
before, after = dict(old["physical_files"]), dict(new["physical_files"])
assert before.keys() == after.keys()
changed = sorted(name for name in before if before[name] != after[name])
expected = ["apps/web/src/missionComposer.test.mjs", "apps/web/src/missionPreview.test.mjs", "tools/coverage_web_models.mjs"]
assert changed == expected, changed
assert old["identity"]["head"] == new["identity"]["head"]
assert old["merge_heads"] == new["merge_heads"]
canonical_path = EV / "issue264-review-check-r2.json"
canonical = read(canonical_path)
assert canonical["status"] == "failed" and canonical["physical_source_unchanged"]
node = next(item for item in canonical["checks"] if item["name"] == "node-tests")
assert node["counts"]["node"] == {"tests": 3468, "passed": 3401, "failed": 2, "skipped": 65, "todo": 0, "cancelled": 0}
coverage_root = WT / "output/coverage/issue264-review-r1"
coverage = read(coverage_root / "summary.json")
assert coverage["ok"] and coverage["sourceStable"] and coverage["files"] == 24
assert coverage["thresholds"] == {"lines": 99, "functions": 95, "branches": 97}
log = (coverage_root / "tests.log").read_text(encoding="utf-8")
assert re.search(r"tests 804\b", log) and re.search(r"pass 804\b", log)
assert re.search(r"fail 0\b", log) and re.search(r"skipped 0\b", log)
native_path = EV / "issue264-review-native-r14.json"
native = read(native_path)
assert native["status"] == "accepted" and native["physical_source_unchanged"] and native["stopped"]
native_browser = QA / "evidence/issue264-native-browser.json"
assert digest(native_browser) == native["browser_report_sha256"]
assert read(native_browser)["failures"] == []

write("issue264-validation-recovery-r1.json", {
    "issues": [263, 264], "recorded_at": datetime.now(timezone.utc).isoformat(),
    "reviewer": "Codex assistant; not an independent human approval",
    "source_before": reference(old_path), "source_after": reference(new_path),
    "changed_files": [{"path": name, "before_sha256": before[name], "after_sha256": after[name]} for name in changed],
    "unchanged_physical_files": len(before) - len(changed),
    "resolution": {
        "coverage_admission": "Explicitly register executiveOverview.ts as a pure production model and presentationPreferences.ts as a React hook. Exact denominator and 99/95/97 thresholds are unchanged.",
        "canonical_assertions": "The existing mission composer and preview source-contract assertions now verify that the submission captures currentMissionRequest and sends the captured body. Native held-plan/launch conditions and preview separation remain checked; browser regressions independently exercise real behavior."
    },
    "prior_canonical": reference(canonical_path),
    "prior_counts": node["counts"]["node"], "prior_not_run": canonical["not_run"],
    "coverage": {"summary": reference(coverage_root / "summary.json"), "run": reference(coverage_root / "run.json"), "lcov": reference(coverage_root / "lcov.info"), "tests_log": reference(coverage_root / "tests.log"), "counts": {"tests": 804, "passed": 804, "failed": 0, "skipped": 0}, "metrics": coverage["coverage"], "thresholds": coverage["thresholds"]},
    "native_applicability": {
        "receipt": reference(native_path), "browser_report": reference(native_browser),
        "conclusion": "Every physical source file except the two source-contract tests and coverage admission tool is byte-identical to the accepted native r14 source. The application, styles, native binaries' source, dependencies, migrations, and native fixture tools have not changed. r14 remains applicable to these runtime inputs.",
        "limits": "The native run occurred before these test/coverage changes. This is a retrospective input comparison, not a claim that r14 executed at the later source identity. The complete canonical r3 run is still in progress; no hosted CI, merge readiness, or issue completion is claimed."
    }
})

observations = [
    ("presentation-source-manifest-code-diff-dark-open-disclosures-cfd066ce.png", "Dark source identity table, inert diff, and evidence controls were readable with no obvious clipping.", "Scaled full-page spot inspection: 1440x9373 to 922x6000."),
    ("native-mission-create-delayed-refresh-failure-saved-refresh-failure.png", "The saved mission ID, dispatch confirmation, and recovery actions remained visible during snapshot failure; in-flight draft edits were retained.", "Spot inspection of the captured browser state."),
    ("native-mission-create-ordinary-completed.png", "Ordinary creation displayed the completed mission, source/provider downloads, and explicit publication limitations.", "Spot inspection of the captured browser state."),
    ("native-source-390px-keyboard-1856a48f.png", "The mobile source view wrapped exact identities and retained accessible evidence controls.", "Scaled full-page spot inspection: 390x8784 to 266x6000."),
    ("presentation-executive-dark-390px-keyboard-511833c2.png", "The mobile Executive view displayed clear keyboard focus and explicit missing-history and cost limitations.", "Spot inspection of the captured browser state."),
    ("presentation-connections-dark-954daf6c.png", "The dark connection dialog retained the draft and visible focus.", "Spot inspection of the captured browser state."),
]
write("issue264-visual-observations-r2.json", {
    "issues": [263, 264], "recorded_at": datetime.now(timezone.utc).isoformat(),
    "reviewer": "Codex assistant; not independent human review",
    "chronology": "Observations were made with view_image in the preceding continuation. Their hashes and notes are recorded here afterward; no earlier review timestamp is asserted.",
    "native_report": reference(native_browser), "source": reference(old_path),
    "images": [{**reference(QA / "evidence" / name), "observation": observation, "inspection_limit": limitation} for name, observation, limitation in observations],
    "limitations": "Scaled spot inspection is not an exhaustive visual or accessibility audit. Native development decisions were scripted, not human reviews. Synthetic browser-only states remain separately identified in the native report."
})
print(json.dumps({"recorded": ["issue264-validation-recovery-r1.json", "issue264-visual-observations-r2.json"], "runtime_inputs_unchanged": True, "changed_files": changed, "coverage_tests_passed": 804}))
