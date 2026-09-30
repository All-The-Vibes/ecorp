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
import sys
sys.dont_write_bytecode = True
from issue262_source_guard_r2 import (
    canonical_root, canonical_single_link_file, guard_identity, source_sha256, verify_source,
)

EV = canonical_root(Path(__file__).absolute().parent)
ROOT = Path(r"<USERPROFILE>\.codex\worktrees\issue262-recovery\ecorp")
MAIN = "878a1774774b0630c904cbaf4b05e1b346777817"
PARENT = "97b141ed47b16aa9682f88a6378c60c86487ec35"
PRIOR = Path(r"<USERPROFILE>\code\ecorp\output\issue-completion\20260926T112626Z")
BRANCH = "codex/issue262-guided-recovery"
PACKET_REL = "docs/evidence/2026-09-30-guided-recovery-source-guard"
PACKET = ROOT / PACKET_REL
PREFIX = "issue262-source-alias"
PHYSICAL = "cff87be69660700f2c966a5c19ded9e8b377f4c1ef36ecc3ae3aee2d28d32fb0"
DIFF = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
NAMES = ["migrations", "state-audit-compatibility", "state-audit-evm", "docs",
         "repository-docs", "node-tests", "format", "clippy", "rust-tests", "web-build", "web-lint"]
GITLEAKS = Path(r"<USERPROFILE>\code\ecorp\output\pr-completion\20260922T123548Z\gitleaks-8.30.1\gitleaks.exe")
GITLEAKS_SHA = "17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c"
NODE = Path(r"<USERPROFILE>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe")
ENV = {k: v for k, v in os.environ.items()
       if not re.match(r"^(CRONY_|ECORP_|PG|GH_|GITHUB_|GITLEAKS_|AZURE_|GIT_)", k, re.I)
       and k.upper() not in {"DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
                             "COPILOT_GITHUB_TOKEN", "NODE_OPTIONS"}}
ENV.update(GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="Never", GIT_OPTIONAL_LOCKS="0", PYTHONDONTWRITEBYTECODE="1")


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
    assert git("rev-parse", "HEAD").decode().strip() == PARENT
    assert git("branch", "--show-current").decode().strip() == BRANCH
    assert not git("ls-files", "--unmerged").strip()
    merge = Path(git("rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD").decode().strip())
    assert not merge.exists(), "A concurrent merge must be preserved and reconciled"
    assert git("remote", "get-url", "origin").decode().strip() in {
        "https://github.com/All-The-Vibes/ecorp.git", "https://github.com/All-The-Vibes/ecorp"}


def original_files(physical):
    """Check declared paths, ancestor aliases, link counts and streamed bytes."""
    assert len(physical) == len(dict(physical)) == 7304
    assert sha(json.dumps(physical, separators=(",", ":"), ensure_ascii=False).encode()) == PHYSICAL
    expected = load(EV / "issue262-source-guard-r2.json")["guard"]
    assert guard_identity() == expected
    assert source_sha256(EV / "issue262_source_guard_r2.py", EV) == expected["adapter_sha256"]
    assert source_sha256(ROOT / expected["repository_guard_path"]) == expected["repository_guard_sha256"]
    verify_source(physical)
    assert guard_identity() == expected


def guarded_bytes(path, root):
    """Admit publication inputs and reject a path or byte change during copying."""
    path = canonical_single_link_file(path, root)
    expected = source_sha256(path, root)
    data = path.read_bytes()
    assert sha(data) == expected == source_sha256(path, root), path.name
    return data


def observed_exit(name):
    value = load(EV / name)
    assert value["exit_code"] == 0 and value["observed_at_utc"]
    assert value["observation"] in {"write_stdin returned process exit", "exec_command returned process exit"}
    assert value["session_id"] is None or isinstance(value["session_id"], int)
    return value


def completed_inputs():
    """Fail closed unless the observed process exit and all final receipts agree."""
    session = observed_exit("issue262-check-final-r1-session-exit.json")
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
    assert node["tests"] >= 3142 and node["failed"] == node["cancelled"] == node["todo"] == 0
    assert node["tests"] == node["passed"] + node["skipped"]
    assert rust["failed"] == 0 and rust["passed"] >= 879 and rust["summaries"] > 0
    phases = ["focused-before-r1", "focused-after-r1", "before-coverage-r1", "after-coverage-r1", "before-native-r12", "after-native-r12", "before-check-final-r1", "after-check-final-r1"]
    snapshots = [load(EV / f"issue262-source-{p}.json") for p in phases]
    physical, observed = snapshots[0]["physical_files"], snapshots[0]["identity"]
    assert all(s["physical_files"] == physical and s["identity"] == observed for s in snapshots)
    assert all(s["physical_files_sha256"] == PHYSICAL for s in snapshots)
    guard = load(EV / "issue262-source-guard-r2.json")
    assert guard["status"] == "passed" and guard["passed"] == 22 and guard["failed"] == guard["skipped"] == 0
    assert len(guard["checks"]) == 22 and all(c["passed"] for c in guard["checks"])
    assert guard_identity() == guard["guard"]
    assert all(s["guard"] == guard["guard"] for s in snapshots)
    assert all(s["capture_driver_sha256"] == sha((EV / "capture-issue262-source-r3.py").read_bytes()) for s in snapshots)
    assert observed["status"] == [] and len(physical) == 7304
    assert observed["head"] == PARENT and observed["branch"] == BRANCH and observed["diff_sha256"] == DIFF
    assert gate["source"]["commit"] == PARENT and gate["source"]["trackedDiffSha256"] == DIFF
    assert set(gate["source"]["files"]) == set(observed["files"]) == set(dict(physical))
    for name, digest in canonical["lock_sha256"].items():
        assert sha((ROOT/name).read_bytes()) == digest
    dependency_paths = [PRIOR / name for name in ["issue262-dependencies-r1.json", "issue262-steward-dependencies-r1.json"]]
    dependencies = [load(p) for p in dependency_paths]
    dependency_binding_path = PRIOR / "issue262-dependency-artifact-binding-r1.json"
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
        assert log_path.resolve() == (PRIOR / (path.stem + ".log")).resolve()
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
    native_path = EV / "issue262-native-r12.json"
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
    assert browser["status"] == "accepted" and not browser["failures"] and len(browser["checks"]) == 15
    assert all(value is not False for value in browser["checks"].values())
    assert browser["actual_human_reviews"] == 0
    assert browser["source_receipt_sha256"] == sha((EV/"issue262-source-before-native-r12.json").read_bytes())
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
        "lines": 99.69, "functions": 97.58, "branches": 97.12}
    coverage_log = (coverage_root/"tests.log").read_text(encoding="utf-8-sig")
    coverage_counts = {key: int(value) for key, value in re.findall(
        r"(?m)^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$", coverage_log)}
    assert coverage_counts == {"tests": 502, "pass": 502, "fail": 0,
                               "cancelled": 0, "skipped": 0, "todo": 0}
    native_exit = observed_exit("issue262-native-r12-session-exit.json")
    coverage_exit = observed_exit("issue262-coverage-r1-session-exit.json")
    focused_exit = observed_exit("issue262-source-guard-focused-r1-session-exit.json")
    regression_path = EV / "issue262-source-guard-focused-r1.json"
    regression = load(regression_path)
    assert regression["status"] == "passed" and regression["physical_source_unchanged"] and regression["exit_code"] == 0
    assert regression["kind"] == "fresh_regression_with_native_source_alias_guard"
    regression_log = Path(regression["log"])
    assert sha(regression_log.read_bytes()) == regression["log_sha256"]
    counts = {key: int(value) for key, value in re.findall(
        r"(?m)^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$", regression_log.read_text(encoding="utf-8-sig"))}
    assert counts == {"tests": 39, "pass": 39, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}
    before_path, after_path = (EV / Path(regression[k]).name for k in ["source_before", "source_after"])
    before, after = load(before_path), load(after_path)
    assert before["physical_files"] == after["physical_files"] == physical
    assert before["identity"] == after["identity"] == observed
    regressions = [{"path": regression_path, "receipt": regression, "counts": counts,
                    "source_before": before_path, "source_after": after_path}]
    for receipt in [regression, coverage_driver, canonical]:
        assert receipt["drivers"]
        for name, digest in receipt["drivers"].items():
            assert source_sha256(EV / name, EV) == digest, name
    assert guard_identity() == guard["guard"]
    git("merge-base", "--is-ancestor", MAIN, PARENT)
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
