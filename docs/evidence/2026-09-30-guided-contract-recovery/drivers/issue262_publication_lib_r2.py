"""Guards for publishing observed issue 262 evidence after validation exits."""
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
ROOT = Path(r"<USERPROFILE>\.codex\worktrees\issue262-recovery\ecorp")
MAIN = "878a1774774b0630c904cbaf4b05e1b346777817"
BRANCH = "codex/issue262-guided-recovery"
PACKET_REL = "docs/evidence/2026-09-30-guided-contract-recovery"
PACKET = ROOT / PACKET_REL
PREFIX = "issue262-completion"
PHYSICAL = "18f38ededd67727fba62b364f62a4277f0776dbf1ff80495db01c869b59d6914"
DIFF = "c157ea6afc6e3c26a0172834b4fe946794b059de7ff02d019b44b4ac96faf239"
NAMES = ["migrations", "state-audit-compatibility", "state-audit-evm", "docs",
         "repository-docs", "node-tests", "format", "clippy", "rust-tests", "web-build", "web-lint"]
GITLEAKS = Path(r"<USERPROFILE>\code\ecorp\output\pr-completion\20260922T123548Z\gitleaks-8.30.1\gitleaks.exe")
GITLEAKS_SHA = "17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c"
NODE = Path(r"<USERPROFILE>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe")
ENV = {k: v for k, v in os.environ.items()
       if not re.match(r"^(CRONY_|ECORP_|PG|GH_|GITHUB_|GITLEAKS_|AZURE_|GIT_)", k, re.I)
       and k.upper() not in {"DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
                             "COPILOT_GITHUB_TOKEN", "NODE_OPTIONS"}}
ENV.update(GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="Never", GIT_OPTIONAL_LOCKS="0")


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def normalized_sha256(value):
    assert isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{64}", value), "Invalid SHA-256"
    return value.lower()


def instant(value):
    result = datetime.fromisoformat(value)
    assert result.tzinfo is not None, "Evidence timestamp must include an offset"
    return result.astimezone(timezone.utc)


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


def pending_source():
    assert git("rev-parse", "HEAD").decode().strip() == MAIN
    assert git("branch", "--show-current").decode().strip() == BRANCH
    assert not git("ls-files", "--unmerged").strip()
    merge = Path(git("rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD").decode().strip())
    assert not merge.exists(), "A concurrent merge must be preserved and reconciled"
    assert git("remote", "get-url", "origin").decode().strip() in {
        "https://github.com/All-The-Vibes/ecorp.git", "https://github.com/All-The-Vibes/ecorp"}


def original_files(physical):
    assert len(physical) == len(dict(physical)) == 7152
    assert sha(json.dumps(physical, separators=(",", ":"), ensure_ascii=False).encode()) == PHYSICAL
    for name, expected in physical:
        path = ROOT / name
        assert path.resolve().is_relative_to(ROOT.resolve()) and path.is_file() and not path.is_symlink(), name
        assert sha(path.read_bytes()) == expected, name


def completed_inputs():
    """Fail closed unless the observed process exit and all final receipts agree."""
    session = load(EV / "issue262-check-final-r1-session-exit.json")
    assert session["session_id"] == 71997 and session["exit_code"] == 0
    assert session["observation"] == "write_stdin returned process exit" and session["observed_at_utc"]
    canonical_path = EV / "issue262-check-final-r1.json"
    canonical = load(canonical_path)
    assert canonical.get("completed_at_utc"), "Final canonical validation still owns this source"
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
    assert node["tests"] >= 3139 and node["failed"] == node["cancelled"] == node["todo"] == 0
    assert node["tests"] == node["passed"] + node["skipped"]
    assert rust["failed"] == 0 and rust["passed"] >= 879 and rust["summaries"] > 0
    phases = ["before-native-r9", "after-native-r9", "before-check-final-r1", "after-check-final-r1"]
    snapshots = [load(EV / f"issue262-source-{p}.json") for p in phases]
    physical, observed = snapshots[0]["physical_files"], snapshots[0]["identity"]
    assert all(s["physical_files"] == physical and s["identity"] == observed for s in snapshots)
    assert all(s["physical_files_sha256"] == PHYSICAL for s in snapshots)
    assert observed["head"] == MAIN and observed["branch"] == BRANCH and observed["diff_sha256"] == DIFF
    assert gate["source"]["commit"] == MAIN and gate["source"]["trackedDiffSha256"] == DIFF
    assert set(gate["source"]["files"]) == set(observed["files"]) == set(dict(physical))
    for name, digest in canonical["lock_sha256"].items():
        assert sha((ROOT/name).read_bytes()) == digest
    dependency_paths = [EV / name for name in ["issue262-dependencies-r1.json", "issue262-steward-dependencies-r1.json"]]
    dependencies = [load(p) for p in dependency_paths]
    dependency_binding_path = EV / "issue262-dependency-artifact-binding-r1.json"
    dependency_binding = load(dependency_binding_path)
    assert dependency_binding["kind"] == "retrospective-dependency-artifact-binding"
    assert dependency_binding["issue"] == 262
    assert dependency_binding["install_reexecuted"] is False
    assert dependency_binding["historical_receipts_modified"] is False
    expected_dependencies = [
        ("pnpm install --frozen-lockfile", "pnpm-lock.yaml", True),
        ("npm ci --prefix scenarios/repo-steward --ignore-scripts --no-audit --no-fund",
         "scenarios/repo-steward/package-lock.json", False),
    ]
    bindings = dependency_binding["inputs"]
    assert len(bindings) == len(dependencies) == len(expected_dependencies)
    assert [b["receipt"] for b in bindings] == [p.name for p in dependency_paths]
    for path, d, binding, expected in zip(dependency_paths, dependencies, bindings, expected_dependencies):
        command, lock_name, historical_digest = expected
        assert d["issue"] == 262 and d["command"] == binding["command"] == command
        assert d["exit_code"] == 0 and d["lock_unchanged"] and d["finished_at_utc"]
        assert sha(path.read_bytes()) == normalized_sha256(binding["receipt_sha256"])
        log_path = Path(d["log"])
        assert log_path.resolve() == (EV / (path.stem + ".log")).resolve()
        assert log_path.name == binding["log_name"] and not log_path.is_symlink()
        log_bytes = log_path.read_bytes()
        assert len(log_bytes) == binding["log_bytes"]
        assert sha(log_bytes) == normalized_sha256(binding["log_sha256"])
        assert binding["historical_log_digest_present"] is historical_digest
        assert ("log_sha256" in d) is historical_digest
        if historical_digest:
            assert sha(log_bytes) == normalized_sha256(d["log_sha256"])
        assert binding["lock_path"] == lock_name
        lock_digest = sha((ROOT / lock_name).read_bytes())
        assert lock_digest == normalized_sha256(binding["lock_sha256"])
        assert lock_digest == normalized_sha256(d["lock_before"]) == normalized_sha256(d["lock_after"])
        assert lock_digest == normalized_sha256(canonical["lock_sha256"][lock_name])
        assert instant(d["finished_at_utc"]) == instant(binding["recorded_install_finished_at_utc"])
        assert instant(d["started_at_utc"]) <= instant(d["finished_at_utc"])
        assert instant(d["finished_at_utc"]) <= instant(dependency_binding["observed_at_utc"])
    native_path = EV / "issue262-native-r9.json"
    native = load(native_path)
    assert native["status"] == "accepted" and native["stopped"] and native["physical_source_unchanged"]
    assert native["finished_at_utc"] and not native.get("stop_error")
    assert len(native["steps"]) == 9
    for step in native["steps"]:
        assert step["exit_code"] == 0 and sha(Path(step["log"]).read_bytes()) == step["sha256"]
    for name, digest in native["drivers"].items():
        assert sha((EV/name).read_bytes()) == digest
    browser_path = Path(native["browser_report"])
    browser = load(browser_path)
    assert sha(browser_path.read_bytes()) == native["browser_report_sha256"]
    assert browser["status"] == "accepted" and not browser["failures"] and len(browser["checks"]) == 13
    assert all(value is not False for value in browser["checks"].values())
    assert browser["actual_human_reviews"] == 0
    assert browser["source_receipt_sha256"] == sha((EV/"issue262-source-before-native-r9.json").read_bytes())
    assert load(Path(native["qa_root"])/"ownership.json")["stopped_at"]
    coverage_path = EV/"issue262-coverage-r1.json"
    coverage_driver = load(coverage_path)
    assert coverage_driver["status"] == "passed" and coverage_driver["exit_code"] == 0
    assert coverage_driver["physical_source_unchanged"] and coverage_driver["finished_at_utc"]
    assert sha(Path(coverage_driver["log"]).read_bytes()) == coverage_driver["log_sha256"]
    coverage_root = Path(coverage_driver["coverage_output"])
    coverage, coverage_run = load(coverage_root/"summary.json"), load(coverage_root/"run.json")
    assert coverage["ok"] and coverage["sourceStable"] and coverage["exitCode"] == 0
    assert coverage_run["ok"] and coverage_run["sourceStable"] and coverage_run["exitCode"] == 0
    assert coverage_run["before"]["files"] == coverage_run["after"]["files"]
    assert coverage["thresholds"] == {"lines": 99, "functions": 95, "branches": 97}
    for file in coverage_run["before"]["files"]:
        assert sha((ROOT/file["file"]).read_bytes()) == file["sha256"], file["file"]
    assert len(coverage_run["modelFiles"]) == 20 and len(coverage_run["testFiles"]) == 31
    assert "apps/web/src/contractRevision.ts" in coverage_run["modelFiles"]
    assert {k: v["percent"] for k, v in coverage["coverage"].items()} == {
        "lines": 99.66, "functions": 97.58, "branches": 97.11}
    coverage_log = (coverage_root/"tests.log").read_text(encoding="utf-8-sig")
    coverage_counts = {key: int(value) for key, value in re.findall(
        r"(?m)^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$", coverage_log)}
    assert coverage_counts == {"tests": 499, "pass": 499, "fail": 0,
                               "cancelled": 0, "skipped": 0, "todo": 0}
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
        data=("\0".join(names)+"\0").encode())


def png_names(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from png_names(child)
    elif isinstance(value, list):
        for child in value:
            yield from png_names(child)
    elif isinstance(value, str) and value.lower().endswith(".png"):
        yield value
