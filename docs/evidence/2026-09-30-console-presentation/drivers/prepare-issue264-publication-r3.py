"""Preserve failed publication r2 and prepare a source-hash schema correction."""
from issue264_publication_lib_r1 import *
import ast
import copy

TRIAGE = EV / "issue264-publication-secret-triage-r1.json"
PRESERVATION = EV / "issue264-completion-packet-r2-preservation.json"
REGRESSION = EV / "issue264-publication-schema-regressions-r1.json"
ARCHIVE = EV / "issue264-completion-packet-r2-failed"
assert not any(p.exists() for p in (TRIAGE, PRESERVATION, REGRESSION, ARCHIVE))
pending_merge()
inputs = completed_inputs()
source = load(EV/"issue264-completion-source-r2.json")
validation = load(EV/"issue264-completion-evidence-validation-r2.json")
assembly = load(EV/"issue264-completion-packet-r2.json")
assert validation["status"] == "failed" and validation["secret_scan"]["exit_code"] == 42
assert validation["secret_scan"]["finding_count"] == 1
assert validation["secret_scan"]["finding_metadata"][0]["start_line"] == 20879
assert validation["tested_tree"] == source["tested_tree"] == assembly["tested_tree"]
original_files(source["physical_files"])
assert index_digest() == source["original_index_sha256"]
assert PACKET.resolve() == (ROOT/"docs/evidence/2026-09-30-console-presentation").resolve()
assert ARCHIVE.parent.resolve() == EV.resolve()
assert PACKET.is_dir() and not PACKET.is_symlink()
actual = sorted(p.relative_to(PACKET).as_posix() for p in PACKET.rglob("*") if p.is_file())
assert actual == assembly["publication_files"]
for item in validation["files"]:
    p = ROOT/item["path"]
    assert p.resolve().is_relative_to(PACKET.resolve()) and not p.is_symlink() and p.stat().st_nlink == 1
    assert sha(p.read_bytes()) == item["sha256"]

viewport_file = PACKET/"viewport/report.json"
viewport = load(viewport_file)
original_viewport_file = EV/"issue264-viewport-probe-r4/report.json"
original_viewport = load(original_viewport_file)
assert viewport["source"] == original_viewport["source"]
assert len(viewport["source"]) == 7
assert all(isinstance(k,str) and isinstance(v,str) and re.fullmatch(r"[a-f0-9]{64}", v)
           and sha((ROOT/"apps/web"/k).read_bytes()) == v for k,v in viewport["source"].items())
line = viewport_file.read_text(encoding="utf-8").splitlines()[20878]
field = json.loads("{"+line.strip().rstrip(",")+"}")
assert set(field) == {"src/Accessible.css"}
assert field["src/Accessible.css"] == sha((ROOT/"apps/web/src/Accessible.css").read_bytes())
write(TRIAGE, {
    "status":"confirmed-non-secret-source-hash", "observed_at_utc":now(),
    "failed_validation":"issue264-completion-evidence-validation-r2.json",
    "failed_validation_sha256":sha((EV/"issue264-completion-evidence-validation-r2.json").read_bytes()),
    "rule":"generic-api-key", "file":"viewport/report.json", "line":20879,
    "json_path":"$.source", "source_file":"apps/web/src/Accessible.css",
    "reported_value_equals_reviewed_file_sha256":True, "all_source_hashes_verified":7,
    "published_report_sha256":sha(viewport_file.read_bytes()),
    "original_report_sha256":sha(original_viewport_file.read_bytes()),
    "finding_line_sha256":sha(line.encode()),
    "correction":"Publish this report's source map as a sorted array of path/sha256 records. All seven names and verified hashes remain recoverable; all other data is preserved by the normal publication redaction.",
    "scanner_or_policy_changed":False, "application_source_changed":False,
    "note":"The scan finding was a file hash under src/Accessible.css; it was not a CSS token value."
})
write(PRESERVATION, {
    "status":"verified-for-preservation", "observed_at_utc":now(),
    "source":str(PACKET), "preserved_destination":str(ARCHIVE),
    "assembly_receipt":"issue264-completion-packet-r2.json",
    "validation_receipt":"issue264-completion-evidence-validation-r2.json",
    "publication_tree":validation["publication_tree"], "files":validation["files"],
    "original_index_sha256":index_digest(), "original_physical_source_unchanged":True
})

transform = '''def publication_data(value, artifact_name):
    if artifact_name != "viewport/report.json":
        return value
    mapping = value["source"]
    assert isinstance(mapping, dict) and len(mapping) == 7
    records = []
    for name, digest in sorted(mapping.items()):
        assert isinstance(name, str) and isinstance(digest, str)
        assert re.fullmatch(r"[a-f0-9]{64}", digest)
        path = ROOT/"apps/web"/name
        assert path.resolve().is_relative_to((ROOT/"apps/web").resolve())
        assert path.is_file() and not path.is_symlink()
        assert sha(path.read_bytes()) == digest
        records.append({"path": name, "sha256": digest})
    published = dict(value, source=records)
    assert {r["path"]: r["sha256"] for r in published["source"]} == mapping
    return published

'''
prepared={}
for name in ("assemble","validate","commit","scan"):
    prior=EV/f"{name}-issue264-completion-r2.py"
    target=EV/f"{name}-issue264-completion-r3.py"
    assert not target.exists()
    text=prior.read_text(encoding="utf-8-sig")
    text=re.sub(r"issue264-completion-(source|packet|self-review|feedback-resolution|visual-resolution|evidence-validation|validation|commit|secret-scan)-r2",r"issue264-completion-\1-r3",text)
    text=text.replace("-issue264-completion-r2.py","-issue264-completion-r3.py")
    if name=="assemble":
        marker="def scrub(value):"
        assert text.count(marker)==1
        text=text.replace(marker,transform+marker)
        marker='json.dumps(scrub(load(path)), indent=2, ensure_ascii=False)'
        assert text.count(marker)==1
        text=text.replace(marker,'json.dumps(scrub(publication_data(load(path), name)), indent=2, ensure_ascii=False)')
        marker='published, transform = value.encode(), "UTF-8/LF and whitespace normalization; personal paths/discovered credentials redacted; JSON reserialized"'
        assert text.count(marker)==1
        text=text.replace(marker,marker+'\n            if name == "viewport/report.json": transform += "; $.source map converted losslessly to sorted path/sha256 records after verifying all seven hashes against the reviewed source"')
        marker='driver_names.add("repair-issue264-evidence-classifier-r1.py")'
        assert text.count(marker)==1
        text=text.replace(marker,marker+'\ndriver_names.add("prepare-issue264-publication-r3.py")')
        marker='assert len({name for _, name in copies}) == len(copies)'
        assert text.count(marker)==1
        text=text.replace(marker,'''copies += [(EV/"issue264-completion-evidence-validation-r2.json", "history/publication-r2-validation.json"),
           (EV/"issue264-publication-secret-triage-r1.json", "history/publication-r2-triage.json"),
           (EV/"issue264-completion-packet-r2-preservation.json", "history/publication-r2-preservation.json"),
           (EV/"issue264-publication-schema-regressions-r1.json", "history/publication-schema-regressions.json")]
'''+marker)
        marker='The final commit did not exist during execution. The separately validated packet'
        assert text.count(marker)==1
        text=text.replace(marker,'''Publication r2 stopped at a secret-scan finding: the flagged value was verified
as the SHA-256 of src/Accessible.css. The original failed packet remains preserved.
The viewport report now represents its seven source hashes as path/sha256 records,
retaining every name and digest. Original/published hashes record the transformation.
Scanner rules and repository policy remain unchanged.

'''+marker)
    ast.parse(text,filename=target.name)
    prepared[target]=text

tree=ast.parse(prepared[EV/"assemble-issue264-completion-r3.py"])
nodes=[]
variables={"secret_key","css_design_tokens","secrets","redactions","personal"}
functions={"is_secret_field","discover","redact_text","scrub","publication_data"}
for node in tree.body:
    if isinstance(node,ast.FunctionDef) and node.name in functions:nodes.append(node)
    elif isinstance(node,ast.Assign):
        ids={n.id for target in node.targets for n in ast.walk(target) if isinstance(n,ast.Name)}
        if ids&variables:nodes.append(node)
scope={"re":re,"ROOT":ROOT,"sha":sha}
exec(compile(ast.Module(body=nodes,type_ignores=[]),"actual-r3-publication-functions","exec"),scope)
transformed=scope["publication_data"](copy.deepcopy(original_viewport),"viewport/report.json")
assert isinstance(transformed["source"],list)
assert {r["path"]:r["sha256"] for r in transformed["source"]}==original_viewport["source"]
assert {k:v for k,v in transformed.items() if k!="source"}=={k:v for k,v in original_viewport.items() if k!="source"}
assert scope["publication_data"](original_viewport,"another-report.json") is original_viewport
bad=copy.deepcopy(original_viewport)
bad["source"]["src/Accessible.css"]="0"*64
try:scope["publication_data"](bad,"viewport/report.json")
except AssertionError:pass
else:raise AssertionError("Mismatched source hash was accepted")
bad["source"]["src/Accessible.css"]="synthetic-credential-canary"
try:scope["publication_data"](bad,"viewport/report.json")
except AssertionError:pass
else:raise AssertionError("Non-hash source value was accepted")

css="--theme-canvas"
cases=[
    ({"token":"redaction-canary"},True),
    ({"token":css},True),
    ({"api_key":css},True),
    ({"state":"ok","token":css,"color":"rgb(0, 0, 0)","contrast":21},False),
    ({"selector":".office","token":css,"expected":"rgb(0, 0, 0)","observed":"rgb(0, 0, 0)"},False),
    ({"state":"ok","token":"redaction-canary","color":"rgb(0, 0, 0)","contrast":21},True),
    ({"state":"ok","token":css,"color":"rgb(0, 0, 0)","contrast":21,"scope":"auth"},True),
    ({"token":""},False),
]
for container,expected in cases:
    key="api_key" if "api_key" in container else "token"
    assert scope["is_secret_field"](container,key,container[key]) is expected
    scope["secrets"].clear();scope["redactions"].clear()
    scope["discover"](container,"$","synthetic")
    result=scope["scrub"](container)
    assert result[key]==("<REDACTED>" if expected else container[key])
scope["secrets"].clear();scope["redactions"].clear()
for path,text in prepared.items():
    with path.open("x",encoding="utf-8",newline="\n") as stream:stream.write(text)
write(REGRESSION,{
    "status":"passed","observed_at_utc":now(),"schema_cases":4,"credential_classification_cases":len(cases),
    "verified_source_hashes":7,"source_roundtrip_exact":True,"non_source_report_data_preserved":True,
    "mismatched_and_non_hash_source_values_rejected":True,
    "scanner_policy_unchanged":True,"original_index_unchanged":index_digest()==source["original_index_sha256"],
    "scripts":[{"name":p.name,"sha256":sha(p.read_bytes())} for p in prepared]
})
print(json.dumps({"status":"r3-prepared-packet-move-pending","schema_cases":4,"credential_cases":len(cases),"packet_files":len(actual),"original_source_unchanged":True}))
