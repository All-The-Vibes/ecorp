"""Immutable, explicitly timed physical source observations for issue 259."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

EV = Path(__file__).resolve().parent
ROOT = Path(r"<USERPROFILE>\.codex\worktrees\issue136-browser-docs\ecorp")
BASE = "878a1774774b0630c904cbaf4b05e1b346777817"
BRANCH = "codex/issue259-run-activity"
ENV = {key: value for key, value in os.environ.items()
       if not re.match(r"^(CRONY_|ECORP_|PG|GH_|GITHUB_|GITLEAKS_|AZURE_|GIT_)", key, re.I)
       and key.upper() not in {"DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "COPILOT_GITHUB_TOKEN", "NODE_OPTIONS"}}
ENV.update(GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def git(*args):
    result = subprocess.run(["git", "-C", str(ROOT), *args], env=ENV, capture_output=True,
                            timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0, f"Git {args[0]} failed, exit {result.returncode}"
    return result.stdout


def identity():
    return {"head": git("rev-parse", "HEAD").decode().strip(),
            "branch": git("branch", "--show-current").decode().strip(),
            "diff_sha256": sha(git("diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD")),
            "parent_tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
            "status": git("status", "--porcelain=v1", "--untracked-files=all").decode().splitlines(),
            "files": git("ls-files", "-z", "--cached", "--others", "--exclude-standard").decode().split("\0")[:-1]}


parser = argparse.ArgumentParser()
parser.add_argument("--phase", choices=["before-check", "after-check"], required=True)
args = parser.parse_args()
target = EV / f"issue259-source-{args.phase}-r9.json"
assert not target.exists(), "Preserve existing observation"
started = datetime.now(timezone.utc).isoformat()
focused = load(EV / "issue259-focused-r4.json")
assert focused["status"] == "passed" and focused["source_unchanged"]
before = identity()
assert (before["head"], before["branch"], before["diff_sha256"]) == (BASE, BRANCH, focused["diff_sha256"])
assert not git("diff", "--cached", "--name-only").strip() and not git("ls-files", "--unmerged").strip()
physical = []
for name in sorted(before["files"]):
    file = ROOT / name
    assert file.resolve().is_relative_to(ROOT.resolve()) and file.is_file() and not file.is_symlink()
    physical.append([name, sha(file.read_bytes())])
assert len({name for name, _ in physical}) == len(physical)
assert identity() == before, "Source changed during capture"
receipt = {"issue": 259, "revision": "r9", "phase": args.phase,
           "started_at": started, "recorded_at": datetime.now(timezone.utc).isoformat(),
           "identity": before, "physical_files": physical, "source_file_count": len(physical),
           "physical_files_sha256": sha(json.dumps(physical, separators=(",", ":"), ensure_ascii=False).encode()),
           "test_config_sha256": sha((ROOT / "test.config.json").read_bytes()),
           "focused_receipt_sha256": sha((EV / "issue259-focused-r4.json").read_bytes()),
           "assurance": "Physical bytes recorded at the stated timestamps. These observations do not retroactively precede earlier validation or failed native attempts."}
if args.phase != "before-native":
    prior_path = EV / "issue259-source-before-native-r8.json"
    prior = load(prior_path)
    assert prior["physical_files"] == physical and prior["identity"] == before
    receipt["equals_before_native_bytes"] = True
    receipt["before_native_receipt_sha256"] = sha(prior_path.read_bytes())
if args.phase == "after-check":
    prior_path = EV / "issue259-source-before-check-r9.json"
    prior = load(prior_path)
    assert prior["physical_files"] == physical and prior["identity"] == before
    driver = load(EV / "issue259-check-r9.json")
    assert driver["exit_code"] == 0
    canonical_path = Path(driver["canonical_report"])
    canonical = load(canonical_path)
    assert canonical["status"] == "passed" and canonical["sourceChangedDuringValidation"] is False
    assert not canonical["notRun"] and all(item["passed"] and item["exitCode"] == 0 for item in canonical["checks"])
    assert canonical["source"]["files"] == before["files"]
    assert canonical["source"]["commit"] == before["head"] and canonical["source"]["trackedDiffSha256"] == before["diff_sha256"]
    assert canonical["source"]["testConfigSha256"] == receipt["test_config_sha256"]
    receipt.update(equals_before_check_bytes=True, before_check_receipt_sha256=sha(prior_path.read_bytes()),
                   canonical_report=str(canonical_path), canonical_report_sha256=sha(canonical_path.read_bytes()))
with target.open("x", encoding="utf-8", newline="\n") as stream:
    stream.write(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"phase": args.phase, "receipt": str(target), "files": len(physical),
                  "head": BASE, "diff_sha256": before["diff_sha256"]}))
