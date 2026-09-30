"""Current physical source receipts; no retrospective chronology claims."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(r"<USERPROFILE>\.codex\worktrees\issue258-history\ecorp")
EV = Path(__file__).resolve().parent
ENV = {k: v for k, v in os.environ.items()
       if not re.match(r"^(CRONY_|ECORP_|PG|GH_|GITHUB_|GITLEAKS_|AZURE_|GIT_)", k, re.I)
       and k.upper() not in {"DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "COPILOT_GITHUB_TOKEN", "NODE_OPTIONS"}}
ENV.update(GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0")

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def git(*args):
    result = subprocess.run(["git", "-C", str(ROOT), *args], env=ENV, capture_output=True,
                            timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0, f"Git {args[0]} failed: {result.returncode}"
    return result.stdout

def identity():
    return {"head": git("rev-parse", "HEAD").decode().strip(),
            "branch": git("branch", "--show-current").decode().strip(),
            "diff_sha256": sha(git("diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD")),
            "parent_tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
            "status": git("status", "--porcelain=v1", "--untracked-files=all").decode().splitlines(),
            "files": git("ls-files", "-z", "--cached", "--others", "--exclude-standard").decode().split("\0")[:-1]}

parser = argparse.ArgumentParser()
parser.add_argument("--phase", required=True)
parser.add_argument("--equals")
args = parser.parse_args()
assert re.fullmatch(r"[a-z0-9-]+", args.phase)
target = EV / f"issue258-performance-source-{args.phase}.json"
assert not target.exists(), "Preserve existing receipt"
before = identity()
assert before["head"] == "c54e25b08276d29a7c6d514fcef593fb06e57fec"
assert before["branch"] == "codex/issue258-searchable-history"
assert not git("diff", "--cached", "--name-only").strip() and not git("ls-files", "--unmerged").strip()
physical = []
for name in sorted(before["files"]):
    file = ROOT / name
    assert file.resolve().is_relative_to(ROOT.resolve()) and file.is_file() and not file.is_symlink()
    physical.append([name, sha(file.read_bytes())])
assert len({name for name, _ in physical}) == len(physical)
assert identity() == before, "Source changed during capture"
receipt = {"issue": 258, "phase": args.phase, "recorded_at": datetime.now(timezone.utc).isoformat(),
           "worktree": str(ROOT), "identity": before, "physical_files": physical,
           "physical_files_sha256": sha(json.dumps(physical, separators=(",", ":"), ensure_ascii=False).encode()),
           "source_file_count": len(physical), "test_config_sha256": sha((ROOT / "test.config.json").read_bytes()),
           "assurance": "Physical bytes observed at this timestamp; no claim that capture preceded earlier tests."}
if args.equals:
    prior_path = EV / f"issue258-performance-source-{args.equals}.json"
    prior = json.loads(prior_path.read_text(encoding="utf-8-sig"))
    assert prior["physical_files"] == physical and prior["identity"] == before, "Source changed since prior receipt"
    receipt.update(equals=str(prior_path), equals_sha256=sha(prior_path.read_bytes()))
with target.open("x", encoding="utf-8", newline="\n") as handle:
    handle.write(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({k: receipt[k] for k in ("phase", "recorded_at", "source_file_count", "physical_files_sha256")}))
