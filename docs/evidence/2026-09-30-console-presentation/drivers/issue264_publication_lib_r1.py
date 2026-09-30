"""Shared guards for publishing observed #263/#264 integration evidence.

This module performs no work on import. The running canonical validation must
finish before any caller can materialize a tree or alter the worktree/index.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

EV = Path(__file__).resolve().parent
ROOT = Path(r"<USERPROFILE>\.codex\worktrees\issue264-modes\ecorp")
MAIN = "878a1774774b0630c904cbaf4b05e1b346777817"
HEAD = "0df25381eb294b8a7fff2daa14d44de638c49483"
INCOMING = "485d8531eb3692806fa8ce22c129efff893696d9"
BRANCH = "codex/issue264-console-modes"
PACKET_REL = "docs/evidence/2026-09-30-console-presentation"
PACKET = ROOT / PACKET_REL
PREFIX = "issue264-completion"
PHYSICAL = "8fff00537e4ebd046a9d98862500ba46abab97f82db021f28115bc1e293fa801"
DIFF = "3a2a987f08582edf522dcff607a3c86e13e1bfb961df0ccc3ce074454c7dff97"
NAMES = ["migrations", "state-audit-compatibility", "state-audit-evm", "docs",
         "repository-docs", "node-tests", "format", "clippy", "rust-tests", "web-build", "web-lint"]
CONTRIBUTIONS = {"385": INCOMING, "384": "72810fa89d6e8440ab8aadb14e005c0b001563bd",
                 "386": "cfa1752c8458a97d7012af017b6a356536fd4408",
                 "387": "1612d1e204698a721113c08033573d786cff85e7"}
NATIVE_DIFFERENCES = {"apps/web/src/missionComposer.test.mjs",
                      "apps/web/src/missionPreview.test.mjs", "tools/coverage_web_models.mjs"}
GITLEAKS = Path(r"<USERPROFILE>\code\ecorp\output\pr-completion\20260922T123548Z\gitleaks-8.30.1\gitleaks.exe")
GITLEAKS_SHA = "17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c"
ENV = {k: v for k, v in os.environ.items()
       if not re.match(r"^(CRONY_|ECORP_|PG|GH_|GITHUB_|GITLEAKS_|AZURE_|GIT_)", k, re.I)
       and k.upper() not in {"DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
                             "COPILOT_GITHUB_TOKEN", "NODE_OPTIONS"}}
ENV.update(GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="Never", GIT_OPTIONAL_LOCKS="0")


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    with Path(path).open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def git(*args, env=ENV, data=None, timeout=240):
    result = subprocess.run(["git", "--no-optional-locks", "-C", str(ROOT), *args],
                            env=env, input=data, capture_output=True, timeout=timeout,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        # Do not print Git output or credential-bearing environment on errors.
        raise RuntimeError(f"Git {args[0]} exited {result.returncode}")
    return result.stdout


def identity():
    return {"head": git("rev-parse", "HEAD").decode().strip(),
            "branch": git("branch", "--show-current").decode().strip(),
            "diff_sha256": sha(git("diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD")),
            "parent_tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
            "status": git("status", "--porcelain=v1", "--untracked-files=all").decode().splitlines(),
            "files": git("ls-files", "-z", "--cached", "--others", "--exclude-standard").decode().split("\0")[:-1]}


def index_digest():
    path = Path(git("rev-parse", "--path-format=absolute", "--git-path", "index").decode().strip())
    return sha(path.read_bytes())


def pending_merge():
    assert git("rev-parse", "HEAD").decode().strip() == HEAD
    assert git("branch", "--show-current").decode().strip() == BRANCH
    assert git("rev-parse", "MERGE_HEAD").decode().strip() == INCOMING
    assert not git("ls-files", "--unmerged").strip()
    assert git("remote", "get-url", "origin").decode().strip() in {
        "https://github.com/All-The-Vibes/ecorp.git", "https://github.com/All-The-Vibes/ecorp"}
    git("merge-base", "--is-ancestor", MAIN, HEAD)
    for pr, commit in CONTRIBUTIONS.items():
        if pr != "385":
            git("merge-base", "--is-ancestor", commit, HEAD)


def original_files(physical):
    assert len(physical) == len(dict(physical)) == 7527
    assert sha(json.dumps(physical, separators=(",", ":"), ensure_ascii=False).encode()) == PHYSICAL
    for name, expected in physical:
        path = ROOT / name
        assert path.resolve().is_relative_to(ROOT.resolve()) and path.is_file() and not path.is_symlink(), name
        assert sha(path.read_bytes()) == expected, name


def completed_inputs():
    """Read receipts only; fail closed while the canonical wrapper is active."""
    session = load(EV / "issue264-review-check-r3-session-exit.json")
    assert session["session_id"] == 64740 and session["exit_code"] == 0
    assert session["observation"] == "write_stdin returned process exit" and session["observed_at_utc"]
    canonical_path = EV / "issue264-review-check-r3.json"
    canonical = load(canonical_path)
    assert canonical.get("completed_at_utc"), "Canonical r3 still owns this source; leave it frozen"
    assert canonical["status"] == "passed" and canonical["exit_code"] == 0
    assert canonical["physical_source_unchanged"] and canonical["all_named_gates_enabled"]
    assert canonical["command"] == "pnpm check" and canonical["rust_test_threads"] == 1
    assert sha(Path(canonical["log"]).read_bytes()) == canonical["log_sha256"]
    gate_path = Path(canonical["canonical_report"])
    gate = load(gate_path)
    assert sha(gate_path.read_bytes()) == canonical["canonical_sha256"]
    assert gate["status"] == "passed" and not gate["sourceChangedDuringValidation"] and not gate["notRun"]
    assert [c["name"] for c in gate["checks"]] == NAMES
    assert all(c["passed"] and c["exitCode"] == 0 and not c.get("errorCode") for c in gate["checks"])
    node = next(c["counts"]["node"] for c in gate["checks"] if c["name"] == "node-tests")
    rust = next(c["counts"]["rust"] for c in gate["checks"] if c["name"] == "rust-tests")
    assert node["tests"] > 3400 and node["failed"] == node["cancelled"] == node["todo"] == 0
    assert node["tests"] == node["passed"] + node["skipped"]
    assert rust["failed"] == 0 and rust["passed"] > 880 and rust["summaries"] > 0
    dependency_path = EV / "issue264-review-dependencies-r3.json"
    dependencies = load(dependency_path)
    native_path = EV / "issue264-review-native-r14.json"
    native = load(native_path)
    assert canonical["dependency_receipt_sha256"] == sha(dependency_path.read_bytes())
    assert dependencies["status"] == "passed" and dependencies["physical_source_unchanged"]
    assert dependencies["completed_at_utc"]
    assert native["status"] == "accepted" and native["stopped"] and native["physical_source_unchanged"]
    assert native["finished_at_utc"] and not native.get("stop_error")
    assert len(native["steps"]) == 9
    for receipt in [dependencies, native]:
        for step in receipt["steps"]:
            assert step["exit_code"] == 0 and sha(Path(step["log"]).read_bytes()) == step["sha256"]
    phases = ["before-dependencies-r3", "after-dependencies-r3", "before-check-r3", "after-check-r3"]
    snapshots = [load(EV / f"issue264-review-source-{p}.json") for p in phases]
    physical, observed = snapshots[0]["physical_files"], snapshots[0]["identity"]
    assert all(s["physical_files"] == physical and s["identity"] == observed for s in snapshots)
    assert all(s["merge_heads"] == [INCOMING] and s["physical_files_sha256"] == PHYSICAL for s in snapshots)
    assert observed["head"] == HEAD and observed["branch"] == BRANCH and observed["diff_sha256"] == DIFF
    assert gate["source"]["commit"] == HEAD and gate["source"]["trackedDiffSha256"] == DIFF
    assert set(gate["source"]["files"]) == set(observed["files"]) == set(dict(physical))
    for name, digest in canonical["lock_sha256"].items():
        assert sha((ROOT / name).read_bytes()) == digest
    native_before = load(EV / "issue264-review-source-before-native-r14.json")
    native_after = load(EV / "issue264-review-source-after-native-r14.json")
    assert native_before["identity"] == native_after["identity"]
    assert native_before["physical_files"] == native_after["physical_files"]
    old = dict(native_before["physical_files"])
    assert set(old) == set(dict(physical))
    differences = [name for name, digest in physical if old[name] != digest]
    assert set(differences) == NATIVE_DIFFERENCES
    recovery_path = EV / "issue264-validation-recovery-r1.json"
    recovery = load(recovery_path)
    assert {x["path"] for x in recovery["changed_files"]} == NATIVE_DIFFERENCES
    assert recovery["unchanged_physical_files"] == 7524
    for name in ["source_before", "source_after"]:
        reference = recovery[name]
        assert sha(Path(reference["path"]).read_bytes()) == reference["sha256"]
    browser_path = Path(native["browser_report"])
    browser = load(browser_path)
    assert sha(browser_path.read_bytes()) == native["browser_report_sha256"]
    assert browser["status"] == "accepted" and not browser["failures"] and len(browser["checks"]) == 72
    assert all(value is not False for value in browser["checks"].values())
    assert browser["actual_human_reviews"] == 0
    assert browser["source_receipt_sha256"] == sha((EV / "issue264-review-source-before-native-r14.json").read_bytes())
    for name, digest in native["drivers"].items():
        assert sha((EV / name).read_bytes()) == digest
    assert load(Path(native["qa_root"]) / "ownership.json")["stopped_at"]
    for item in recovery["coverage"].values():
        if isinstance(item, dict) and "path" in item and "sha256" in item:
            assert sha(Path(item["path"]).read_bytes()) == item["sha256"]
    coverage_root = ROOT / "output/coverage/issue264-review-r1"
    coverage, coverage_run = load(coverage_root / "summary.json"), load(coverage_root / "run.json")
    assert coverage["ok"] and coverage["sourceStable"] and coverage["exitCode"] == 0
    assert coverage_run["ok"] and coverage_run["sourceStable"] and coverage_run["exitCode"] == 0
    assert coverage_run["before"]["files"] == coverage_run["after"]["files"]
    assert coverage["thresholds"] == {"lines": 99, "functions": 95, "branches": 97}
    for file in coverage_run["before"]["files"]:
        assert sha((ROOT / file["file"]).read_bytes()) == file["sha256"], file["file"]
    assert len(coverage_run["modelFiles"]) == 24 and len(coverage_run["frameworkFiles"]) == 5
    assert "apps/web/src/executiveOverview.ts" in coverage_run["modelFiles"]
    assert "apps/web/src/presentationPreferences.ts" in coverage_run["frameworkFiles"]
    return locals()


@contextmanager
def temporary_index(label, initial):
    descriptor, name = tempfile.mkstemp(prefix=f"{PREFIX}-{label}-index-", dir=EV)
    os.close(descriptor)
    path = Path(name).resolve()
    assert path.parent == EV.resolve() and path.name.startswith(PREFIX)
    path.unlink()
    try:
        env = dict(ENV, GIT_INDEX_FILE=str(path), GIT_LITERAL_PATHSPECS="1")
        git("read-tree", initial, env=env)
        yield env
    finally:
        if path.exists():
            assert path.resolve().parent == EV.resolve() and path.name.startswith(PREFIX)
            path.unlink()


def stage_names(names, env):
    names = sorted(set(names))
    assert names and all("\0" not in n and not Path(n).is_absolute() and ".." not in Path(n).parts for n in names)
    git("add", "--force", "--all", "--pathspec-from-file=-", "--pathspec-file-nul", env=env,
        data=("\0".join(names) + "\0").encode())


def png_names(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from png_names(child)
    elif isinstance(value, list):
        for child in value:
            yield from png_names(child)
    elif isinstance(value, str) and value.lower().endswith(".png"):
        yield value
