"""Validate the publication-only addition without changing the pending merge."""
from issue264_publication_lib_r1 import *
import sys

RECEIPT = EV/"issue264-completion-evidence-validation-r3.json"
NODE = Path(r"<USERPROFILE>\AppData\Local\Programs\ecorp-tools\node-v24.21.0-win-x64\node.exe")
ENV["PATH"] = str(NODE.parent)+os.pathsep+str(Path(sys.executable).parent)+os.pathsep+ENV["PATH"]
assert not RECEIPT.exists(), "Preserve previous validation attempts"
record = {"issues": [263, 264], "status": "running", "started_at_utc": now(), "checks": [],
          "scope": "Publication-only validation after canonical process exit; preserve original bytes, index and pending merge; verify all eleven gate argv and full Node discovery."}
def save():
    RECEIPT.write_text(json.dumps(record, indent=2)+"\n", encoding="utf-8")
def check(name, args, timeout=900):
    log = EV/f"issue264-completion-validation-r3-{name}.log"
    assert not log.exists()
    started = now()
    result = subprocess.run([str(a) for a in args], cwd=ROOT, env=ENV, capture_output=True,
                            timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW)
    with log.open("xb") as stream: stream.write(result.stdout+result.stderr)
    record["checks"].append({"name": name, "arguments": [str(a) for a in args], "exit_code": result.returncode,
                             "started_at_utc": started, "finished_at_utc": now(), "log": str(log), "sha256": sha(log.read_bytes())})
    save()
    assert result.returncode == 0, f"{name} failed; inspect retained log"
save()
try:
    x = completed_inputs()
    pending_merge()
    source_path = EV/"issue264-completion-source-r3.json"
    source, assembly, summary = load(source_path), load(EV/"issue264-completion-packet-r3.json"), load(PACKET/"summary.json")
    assert source["parents"] == assembly["parents"] == [HEAD, INCOMING]
    assert sha(source_path.read_bytes()) == assembly["source_receipt_sha256"]
    assert sha((PACKET/"summary.json").read_bytes()) == assembly["summary_sha256"]
    assert source["canonical_receipt_sha256"] == sha(x["canonical_path"].read_bytes())
    assert source["canonical_report_sha256"] == sha(x["gate_path"].read_bytes())
    assert source["native_receipt_sha256"] == sha(x["native_path"].read_bytes())
    assert not source["canonical_native_same_complete_physical_source"]
    assert set(source["native_source_differences"]) == NATIVE_DIFFERENCES
    physical = source["physical_files"]
    original_files(physical)
    initial_index = index_digest()
    assert initial_index == source["original_index_sha256"] == assembly["original_index_sha256"]
    files = [{"path": p.relative_to(ROOT).as_posix(), "sha256": sha(p.read_bytes()), "bytes": p.stat().st_size}
             for p in sorted(PACKET.rglob("*")) if p.is_file()]
    assert sorted(p.relative_to(PACKET).as_posix() for p in PACKET.rglob("*") if p.is_file()) == assembly["publication_files"]
    original_names, packet_names = set(dict(physical)), {f["path"] for f in files}
    assert not original_names & packet_names
    current_names = set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").decode().split("\0")) - {""}
    assert original_names <= current_names <= original_names | packet_names
    ignored = packet_names - current_names
    if ignored:
        confirmed = set(git("check-ignore", "--stdin", "-z", data=("\0".join(sorted(ignored))+"\0").encode()).decode().split("\0")) - {""}
        assert confirmed == ignored
    for artifact in summary["artifacts"]:
        assert sha((PACKET/artifact["file"]).read_bytes()) == artifact["published_sha256"]
    for snapshot in source["snapshot_receipts"]:
        assert sha((EV/snapshot["name"]).read_bytes()) == snapshot["sha256"]
    with temporary_index("validation", HEAD) as temporary:
        stage_names(original_names, temporary)
        tested_tree = git("write-tree", env=temporary).decode().strip()
        assert tested_tree == source["tested_tree"] == assembly["tested_tree"]
        assert git("diff", "--name-only", MAIN, tested_tree).decode().splitlines() == source["integration_paths"]
        assert sha(git("diff", "--binary", "--no-ext-diff", "--no-textconv", "--unified=0", MAIN, tested_tree, "--", *source["code_paths"])) == source["integration_code_patch_sha256"]
        assert sha(git("diff", "--binary", "--no-ext-diff", "--no-textconv", "--unified=0", HEAD, tested_tree)) == source["pending_patch_sha256"]
        stage_names(packet_names, temporary)
        publication_tree = git("write-tree", env=temporary).decode().strip()
        assert set(git("diff", "--name-only", tested_tree, publication_tree).decode().splitlines()) == packet_names
    personal = re.compile(rb"(?:[a-z]:)?[/\\]+Users[/\\]+[^/\\\s\"'<>]+", re.I)
    for item in files:
        path = ROOT/item["path"]
        assert not path.is_symlink() and path.stat().st_nlink == 1
        if path.suffix != ".png":
            raw = path.read_bytes()
            raw.decode("utf-8")
            assert not personal.search(raw.replace(b"^", b"")), item["path"]
        assert git("hash-object", "--no-filters", "--", str(path)).strip() == git("hash-object", "--path="+item["path"], "--", str(path)).strip(), item["path"]
    assert subprocess.check_output([str(NODE), "--version"], env=ENV).decode().strip() == x["canonical"]["versions"]["node"]
    script = "import {readFileSync} from 'node:fs';import {checkPlan} from './tools/run_checks.mjs';console.log(JSON.stringify(checkPlan('full',JSON.parse(readFileSync(0,'utf8')))));"
    result = subprocess.run([str(NODE), "--input-type=module", "-e", script], cwd=ROOT, env=ENV,
                            input=json.dumps(sorted(original_names|packet_names)).encode(), capture_output=True,
                            timeout=180, creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0
    plan = json.loads(result.stdout)
    assert len(plan) == len(x["gate"]["checks"]) == 11
    assert all(a["name"] == b["name"] and a["argv"] == b["argv"] for a, b in zip(plan, x["gate"]["checks"]))
    record.update(base=MAIN, parents=[HEAD, INCOMING], branch=BRANCH, tested_tree=tested_tree, publication_tree=publication_tree,
                  source_receipt_sha256=sha(source_path.read_bytes()), physical_files_sha256=PHYSICAL, files=files,
                  original_physical_files_unchanged=True, historical_packet_files_preserved=len(source["historical_packet_preserved"]),
                  canonical_native_same_complete_physical_source=False, native_runtime_inputs_unchanged=True,
                  evidence_added_after_code_execution=True, full_plan_unchanged=True, git_preserves_packet_bytes=True,
                  final_plan=plan, issue_completed=False, original_index_sha256=initial_index,
                  explicit_ignored_publication_paths=sorted(ignored))
    save()
    check("docs", [NODE, "tools/check_docs.mjs"])
    check("repository-docs", [NODE, "tools/check_documentation.mjs"])
    check("personal-paths", [NODE, "tools/check_evidence_personal_paths.mjs", PACKET])
    assert sha(GITLEAKS.read_bytes()) == GITLEAKS_SHA
    assert subprocess.check_output([str(GITLEAKS), "version"], env=ENV).decode().strip() == "8.30.1"
    policy = {n: sha((ROOT/n).read_bytes()) if (ROOT/n).is_file() else None for n in [".gitleaksignore", ".gitleaks.toml"]}
    with tempfile.TemporaryDirectory(prefix="issue264-completion-evidence-scan-", dir=EV) as owned:
        owned_path = Path(owned).resolve()
        assert owned_path.parent == EV.resolve() and owned_path.name.startswith("issue264-completion-evidence-scan-")
        report_path = owned_path/"report.json"
        args = [str(GITLEAKS), "dir", str(PACKET), "--redact=100", "--no-banner", "--no-color", "--ignore-gitleaks-allow",
                "--gitleaks-ignore-path", str(ROOT/".gitleaksignore"), "--exit-code=42", "--timeout=300", "--report-format=json", "--report-path", str(report_path)]
        if policy[".gitleaks.toml"] is not None: args += ["--config", str(ROOT/".gitleaks.toml")]
        result = subprocess.run(args, cwd=ROOT, env=ENV, capture_output=True, timeout=360, creationflags=subprocess.CREATE_NO_WINDOW)
        findings = load(report_path) if report_path.exists() else None
        log = EV/"issue264-completion-validation-r3-gitleaks.log"
        with log.open("xb") as stream: stream.write(result.stdout+result.stderr)
        record["secret_scan"] = {"version": "8.30.1", "native_sha256": GITLEAKS_SHA, "exit_code": result.returncode,
                                 "finding_count": len(findings) if isinstance(findings, list) else None,
                                 "policy_sha256": policy, "log": str(log), "log_sha256": sha(log.read_bytes())}
        if findings:
            record["secret_scan"]["finding_metadata"] = [{"rule": f.get("RuleID"), "file": str(f.get("File", "")).replace(str(PACKET), "<PACKET>"), "start_line": f.get("StartLine")} for f in findings]
        save()
        assert result.returncode == 0 and isinstance(findings, list) and not findings, "Triage secret findings before publication"
    check("diff-check", ["git", "--no-optional-locks", "diff", "--check"])
    original_files(physical)
    pending_merge()
    assert index_digest() == initial_index
    assert all(sha((ROOT/f["path"]).read_bytes()) == f["sha256"] for f in files)
    assert policy == {n: sha((ROOT/n).read_bytes()) if (ROOT/n).is_file() else None for n in policy}
    record.update(status="passed", original_index_unchanged=True, unresolved_conflicts=False)
except Exception as error:
    record.update(status="failed", failure=str(error))
    raise
finally:
    record["finished_at_utc"] = now()
    save()
    print(json.dumps({k: record.get(k) for k in ["status", "tested_tree", "publication_tree", "original_index_unchanged", "failure"]}))
