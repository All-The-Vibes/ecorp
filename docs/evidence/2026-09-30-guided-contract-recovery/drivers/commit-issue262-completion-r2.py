"""Commit only the implementation and separately validated evidence tree."""
from issue262_publication_lib_r2 import *

RECEIPT = EV/"issue262-completion-commit-r2.json"
assert not RECEIPT.exists(), "Preserve earlier commit attempts"
record = {"issue": 262, "status": "preparing", "started_at_utc": now(), "base": MAIN,
          "parents": [MAIN], "branch": BRANCH, "remote_merge_performed": False, "issue_completed": False}

def save():
    RECEIPT.write_text(json.dumps(record, indent=2)+"\n", encoding="utf-8")

def verify_files(source, validation):
    original_files(source["physical_files"])
    for f in validation["files"]:
        assert sha((ROOT/f["path"]).read_bytes()) == f["sha256"], f["path"]

save()
try:
    completed_inputs()
    pending_source()
    source_path, validation_path = EV/"issue262-completion-source-r2.json", EV/"issue262-completion-evidence-validation-r2.json"
    source, validation, assembly = load(source_path), load(validation_path), load(EV/"issue262-completion-packet-r2.json")
    assert validation["status"] == "passed" and validation["original_index_unchanged"] and validation["full_plan_unchanged"]
    assert validation["secret_scan"]["exit_code"] == 0 and validation["secret_scan"]["finding_count"] == 0
    assert source["parents"] == validation["parents"] == [MAIN]
    assert validation["source_receipt_sha256"] == assembly["source_receipt_sha256"] == sha(source_path.read_bytes())
    assert sha((PACKET/"summary.json").read_bytes()) == assembly["summary_sha256"]
    assert index_digest() == source["original_index_sha256"] == validation["original_index_sha256"]
    for check in validation["checks"]:
        assert check["exit_code"] == 0 and sha(Path(check["log"]).read_bytes()) == check["sha256"]
    verify_files(source, validation)
    original = set(dict(source["physical_files"]))
    published = {f["path"] for f in validation["files"]}
    current = set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").decode().split("\0")) - {""}
    assert original <= current <= original|published
    assert sorted(p.relative_to(PACKET).as_posix() for p in PACKET.rglob("*") if p.is_file()) == assembly["publication_files"]
    with temporary_index("commit-proof", MAIN) as temporary:
        stage_names(original, temporary)
        tested_tree = git("write-tree", env=temporary).decode().strip()
        assert tested_tree == source["tested_tree"] == validation["tested_tree"]
        stage_names(published, temporary)
        publication_tree = git("write-tree", env=temporary).decode().strip()
        assert publication_tree == validation["publication_tree"]
    record.update(tested_tree=tested_tree, publication_tree=publication_tree, physical_files_sha256=PHYSICAL,
                  validation_sha256=sha(validation_path.read_bytes()), source_receipt_sha256=sha(source_path.read_bytes()),
                  original_source_files=len(original), publication_files=len(published),
                  explicit_ignored_publication_paths=validation["explicit_ignored_publication_paths"],
                  all_original_bytes_unchanged=True, author_identity=git("var", "GIT_AUTHOR_IDENT").decode().strip())
    save()
    stage_names(original|published, dict(ENV, GIT_LITERAL_PATHSPECS="1"))
    assert git("write-tree").decode().strip() == publication_tree
    git("diff", "--cached", "--check", MAIN)
    assert not git("diff", "--name-only").strip()
    verify_files(source, validation)
    pending_source()
    changed = git("diff", "--cached", "--name-only", MAIN).decode().splitlines()
    assert set(changed) == set(source["code_paths"]) | published
    record.update(status="staged-and-verified", changed_files=changed)
    save()
    result = git("commit", "-m", "Add guided contract revisions with durable recovery drafts and narrow resume authority")
    with (EV/"issue262-completion-commit-r2.log").open("xb") as stream:
        stream.write(result)
    head = git("rev-parse", "HEAD").decode().strip()
    assert git("show", "-s", "--format=%P", head).decode().split() == [MAIN]
    assert git("rev-parse", "HEAD^{tree}").decode().strip() == publication_tree
    assert not git("status", "--porcelain=v1", "--untracked-files=all").strip()
    git("merge-base", "--is-ancestor", MAIN, head)
    assert sha(git("diff", "--binary", "--no-ext-diff", "--no-textconv", "--unified=0", MAIN, head, "--", *source["code_paths"])) == source["code_patch_sha256"]
    assert set(git("diff", "--name-only", MAIN, head).decode().splitlines()) == set(source["code_paths"])|published
    verify_files(source, validation)
    record.update(status="committed-and-verified", head=head, committed_tree=publication_tree,
                  commit_log_sha256=sha(result), worktree_clean=True, ordinary_single_parent_commit=True)
except Exception as error:
    record.update(status="failed", failure=str(error))
    raise
finally:
    record["finished_at_utc"] = now()
    save()
    print(json.dumps({k: record.get(k) for k in ["status", "head", "parents", "tested_tree", "publication_tree", "failure"]}))
