"""Append the observed core-publication pass without rewriting its validated bytes."""
from issue262_alias_publication_lib_r1 import *

RECEIPT = EV / "issue262-source-alias-packet-r2.json"
assert not RECEIPT.exists(), "Preserve previous publication attempts"
completed_inputs()
pending_source()
source = load(EV / "issue262-source-alias-source-r1.json")
assembly_path = EV / "issue262-source-alias-packet-r1.json"
assembly = load(assembly_path)
validation_path = EV / "issue262-source-alias-evidence-validation-r1.json"
validation = load(validation_path)
exit_name = "issue262-source-alias-validation-r1-session-exit.json"
observed_exit(exit_name)
assert validation["status"] == "passed" and validation["original_index_unchanged"]
assert validation["full_plan_unchanged"] and validation["canonical_native_same_complete_physical_source"]
assert validation["secret_scan"]["exit_code"] == 0 and validation["secret_scan"]["finding_count"] == 0
assert validation["source_receipt_sha256"] == assembly["source_receipt_sha256"]
original_files(source["physical_files"])
verify_source([[f["path"], f["sha256"]] for f in validation["files"]])
assert index_digest() == assembly["original_index_sha256"]
core_names = {f["path"] for f in validation["files"]}
assert sorted(p.relative_to(PACKET).as_posix() for p in PACKET.rglob("*") if p.is_file()) == assembly["publication_files"]
with temporary_index("core-proof", PARENT) as temporary:
    stage_names(set(dict(source["physical_files"])) | core_names, temporary)
    assert git("write-tree", env=temporary).decode().strip() == validation["publication_tree"]

copies = [(validation_path, "publication/evidence-validation-r1.json"),
          (EV / exit_name, "publication/validation-r1-session-exit.json"),
          (assembly_path, "publication/core-assembly-r1.json")]
for check in validation["checks"]:
    path = Path(check["log"])
    assert check["exit_code"] == 0 and sha(guarded_bytes(path, EV)) == check["sha256"]
    copies.append((path, "publication/" + path.name))
scan = validation["secret_scan"]
scan_path = Path(scan["log"])
assert sha(guarded_bytes(scan_path, EV)) == scan["log_sha256"]
copies.append((scan_path, "publication/" + scan_path.name))
for name in ["extend-issue262-source-alias-publication-r1.py", "validate-issue262-source-alias-r2.py",
             "commit-issue262-source-alias-r2.py", "scan-issue262-source-alias-r2.py"]:
    copies.append((EV / name, "drivers/" + name))
assert len({name for _, name in copies}) == len(copies)

personal = re.compile(r"(?:[a-z]:)?[/\\]+Users[/\\]+[^/\\\s\"'<>]+", re.I)


def scrub(value):
    if isinstance(value, dict):
        return {key: scrub(child) for key, child in value.items()}
    if isinstance(value, list):
        return [scrub(child) for child in value]
    if isinstance(value, str):
        value = re.sub(r"(?i)C\^?:\^?<USERPROFILE>\\shyamsridhar", "<USERPROFILE>", value)
        return personal.sub("<USERPROFILE>", value).replace("\r\n", "\n")
    return value


artifacts = []
for path, name in copies:
    raw = guarded_bytes(path, EV)
    text = json.dumps(scrub(json.loads(raw.decode("utf-8-sig"))), indent=2, ensure_ascii=False) if path.suffix == ".json" else scrub(raw.decode("utf-8-sig"))
    text = "\n".join(line.rstrip() for line in text.splitlines()).rstrip() + "\n"
    assert not personal.search(text.replace("^", ""))
    published = text.encode()
    target = PACKET / name
    assert target.is_relative_to(PACKET) and not target.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as stream:
        stream.write(published)
    assert source_sha256(target, ROOT) == sha(published)
    artifacts.append({"file": name, "source_name": path.name, "original_sha256": sha(raw),
                      "published_sha256": sha(published), "bytes": len(published),
                      "transform": "Personal paths redacted; JSON reserialized; UTF-8/LF and trailing-whitespace normalization. No result or scope changed."})

readme = PACKET / "publication/README.md"
text = f"""# Observed publication validation

The original core packet was checked successfully at {validation['finished_at_utc']}.
Its tested product tree is {validation['tested_tree']} and its validated publication
tree is {validation['publication_tree']}. The actual process exit, documentation,
personal-path, diff and native Gitleaks logs are included in this directory.
All recorded checks exited zero and Gitleaks reported zero findings.

Every core-packet byte remains unchanged. The files here and the additional R2
publication drivers were added afterward. The original passing receipt does not
validate these later additions or itself. R2 separately validates the extended
packet and reconstructs the original validated tree; its actual result is retained
in the run record and linked from the PR after execution. No hosted checks, merge,
issue completion or independent review are implied.

manifest.json binds the original local receipt/log bytes to their sanitized
published copies and identifies the complete original file set. The existing core
summary intentionally remains immutable; this is the additional publication record.
"""
with readme.open("x", encoding="utf-8", newline="\n") as stream:
    stream.write(text)
manifest = {"issue": 262, "pr": 389, "recorded_at_utc": now(),
            "core_tested_tree": validation["tested_tree"], "core_publication_tree": validation["publication_tree"],
            "core_validation_sha256": sha(validation_path.read_bytes()),
            "core_files": validation["files"], "artifacts": artifacts,
            "scope_document_sha256": source_sha256(readme, ROOT),
            "scope": "Original passing core validation only; additional publication files require the subsequent R2 validation."}
write(PACKET / "publication/manifest.json", manifest)
original_files(source["physical_files"])
verify_source([[f["path"], f["sha256"]] for f in validation["files"]])
pending_source()
assert index_digest() == assembly["original_index_sha256"]
files = sorted(p.relative_to(PACKET).as_posix() for p in PACKET.rglob("*") if p.is_file())
record = dict(assembly, recorded_at_utc=now(), publication_files=files,
              preceding_assembly_sha256=sha(assembly_path.read_bytes()),
              core_validation_sha256=sha(validation_path.read_bytes()),
              core_publication_tree=validation["publication_tree"],
              addition_files=sorted(set(files) - set(assembly["publication_files"])),
              original_core_packet_unchanged=True, status="extended-awaiting-validation")
write(RECEIPT, record)
print(json.dumps({"status": record["status"], "publication_files": len(files),
                  "added_files": len(record["addition_files"]), "core_publication_tree": validation["publication_tree"]}))
