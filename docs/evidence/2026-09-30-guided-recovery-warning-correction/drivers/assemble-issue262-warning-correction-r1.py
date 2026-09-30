"""Publish observed correction evidence after every validation process exits."""
from issue262_warning_publication_lib_r1 import *

SOURCE = EV/"issue262-warning-correction-source-r1.json"
RECEIPT = EV/"issue262-warning-correction-packet-r1.json"
assert not any(p.exists() for p in [PACKET, SOURCE, RECEIPT]), "Preserve prior publication attempts"
x = completed_inputs()
pending_source()
physical, observed = x["physical"], x["observed"]
original_files(physical)
assert identity() == observed
real_index = index_digest()
with temporary_index("assembly", PARENT) as temporary:
    stage_names(dict(physical), temporary)
    tested_tree = git("write-tree", env=temporary).decode().strip()
    assert set(git("ls-tree", "-r", "--name-only", "-z", tested_tree).decode().split("\0")) - {""} == set(dict(physical))
assert index_digest() == real_index
code_paths = git("diff", "--name-only", PARENT, tested_tree).decode().splitlines()
assert set(code_paths) == {"apps/web/src/contractRevision.ts", "apps/web/src/contractRevision.test.mjs", "apps/web/src/contractRevisionLifecycle.test.mjs"}
patch = git("diff", "--binary", "--no-ext-diff", "--no-textconv", "--unified=0", PARENT, tested_tree)
snapshots = []
for phase in x["phases"]:
    path = EV/f"issue262-source-{phase}.json"
    value = load(path)
    assert value["identity"] == observed and value["physical_files"] == physical
    snapshots.append({"file": path.name, "original_sha256": sha(path.read_bytes()),
                      "recorded_at": value["recorded_at"], "physical_files_sha256": PHYSICAL,
                      "source_file_count": len(physical), "identity_equals_tested_source": True})
source = {"issue": 262, "pr": 389, "review_comment": 4145802423, "recorded_at_utc": now(),
          "base": MAIN, "parents": [PARENT], "branch": BRANCH, "parent_tree": observed["parent_tree"],
          "tested_tree": tested_tree, "physical_files": physical, "physical_files_sha256": PHYSICAL,
          "source_file_count": len(physical), "code_paths": code_paths, "code_patch_sha256": sha(patch),
          "original_binary_diff_sha256": DIFF, "original_status": observed["status"],
          "original_index_sha256": real_index, "publication_directory": PACKET_REL,
          "snapshot_receipts": snapshots, "canonical_receipt_sha256": sha(x["canonical_path"].read_bytes()),
          "canonical_report_sha256": sha(x["gate_path"].read_bytes()),
          "native_receipt_sha256": sha(x["native_path"].read_bytes()),
          "canonical_native_same_complete_physical_source": True,
          "scope": "Green regressions, coverage, native r10 and canonical validation observed identical complete physical source. The tested Git tree is reconstructed after execution. The final correction commit did not exist during execution; publication adds only this separately checked packet."}
write(SOURCE, source)

native, browser = x["native"], x["browser"]
shots = sorted(set(png_names(browser)))
assert len(shots) == 19
acceptance = [
    {"criterion": "Reject malformed optional refresh warnings before restoring a saved receipt",
     "implementation": ["apps/web/src/contractRevision.ts:319", "apps/web/src/contractRevision.test.mjs:224"],
     "evidence": ["regression/red.log", "regression/green.log", "native/browser-report.json: native_saved_receipt_malformed_warning_reload_fails_closed"],
     "result": "An object, either array shape, empty array/object, null, booleans, number and zero fail closed. The actual panel shows its existing storage error, disables revision, renders no saved result, preserves exact stored bytes and sends zero revision requests. Server revisions and run counts remain unchanged."},
    {"criterion": "Keep compatible saved receipts and exact idempotency state",
     "implementation": ["apps/web/src/contractRevision.ts:319", "apps/web/src/contractRevision.test.mjs:207", "apps/web/src/contractRevisionLifecycle.test.mjs:64"],
     "evidence": ["regression/green.log", "native/browser-report.json: native_saved_receipt_optional_text_warning_restores_without_replay"],
     "result": "Absent, empty-string and textual warnings restore correctly. Saved revision v2 retains its exact pending request and performs no replay or new write."},
    {"criterion": "Revalidate the complete guided recovery implementation on the corrected source",
     "implementation": ["apps/web/src/App.tsx", "apps/web/src/ContractRevisionEditor.tsx", "crates/crony-store/src/contract_revision.rs"],
     "evidence": ["canonical-report.json", "native/browser-report.json", "coverage/summary.json"],
     "result": "The full named check plan, model coverage, and all 15 browser acceptance groups passed on the same physical source. Existing actor/Corp denials, response-loss replay, stale reconciliation, explicit launch, native protocol resume, persisted verification, authority narrowing and budget restrictions were re-exercised."},
]
qualifications = [
    "This is retrospective observed regression and acceptance evidence, and an assistant implementation self-review. It is not original development chronology, an independent GitHub approval or a human decision.",
    "The red test run used the published production guard with new regression tests and observed two failures. The green run changes only that production guard relative to the red source. Three new test cases account for the model-coverage increase from 499 to 502.",
    "The browser/server/PostgreSQL/runner stack is fresh and owned. Execution uses the existing deterministic fake-process and synthetic Codex protocol fixture, not live vendor inference or production identity.",
    "Malformed and valid warning variants are synthetic browser-storage edits to a receipt genuinely saved and replayed by the local server. They are not malformed API responses.",
    "The 15 top-level browser groups include one group with seven explicitly synthetic recovery presentation cases; they are not 15 wholly native tests. Zero actual human reviews were performed.",
    "Nineteen original screenshots are preserved. The two new warning views were visually spot checked at reduced display resolution; this does not establish exhaustive visual or accessibility certification.",
    "Green regressions, coverage, native r10 and canonical checks observed identical 7,231-file physical source. The final commit did not exist then. The original evidence packet is retained byte-for-byte as historical validation of the previous implementation.",
    "Native r10's receipt predates final canonical completion and records that check as pending. The completed canonical receipt and source-equivalence binding in this packet establish its later successful result without rewriting the native receipt.",
    "Skipped Node and ignored Rust cases are not passes. Canonical, focused, coverage and native counts overlap. Dedicated live and immutable historical replay lanes remain separate.",
    "Prior locked-dependency receipts are reused only with unchanged lockfiles. The pnpm install receipt included a log digest; the Steward receipt did not. Its retained log bytes were first bound retrospectively by the existing dependency-artifact receipt. Installs were not re-executed in this correction.",
    "Required hosted CI, CodeQL, code-quality and security checks remain unavailable because GitHub Actions is disabled. Local checks do not replace them. No merge, issue closure, self-approval, policy change, live-provider acceptance or clean historical Cargo advisory audit is claimed.",
]
review_path = EV/"issue262-warning-correction-self-review-r1.json"
write(review_path, {"issue": 262, "pr": 389, "recorded_at_utc": now(),
      "reviewer": "Codex assistant; implementation self-review, not independent or human approval",
      "base": MAIN, "parents": [PARENT], "tested_tree": tested_tree, "physical_files_sha256": PHYSICAL,
      "reviewed_paths": code_paths, "surrounding_paths": ["apps/web/src/App.tsx:904", "apps/web/src/App.tsx:1066", "apps/web/src/App.tsx:5198", "apps/web/src/contractRevisionHarness.mjs"],
      "review_comment": 4145802423, "review_thread": "PRRT_kwDOUIQ-ns6nk3ie",
      "confirmed_findings_resolved": [{"path": "apps/web/src/contractRevision.ts", "line": 319,
          "finding": "A saved receipt restored from session storage could contain an object refreshWarning that reached React rendering.",
          "resolution": "Require every defined refreshWarning to be a string before restoring the draft. Invalid values use the existing storage-error path; absence and strings retain compatibility."}],
      "invariants": [
          "The guard is evaluated before untrusted stored data returns to the component; null, objects, arrays and primitives other than strings are rejected without coercion.",
          "Malformed storage is preserved for explicit recovery. The component does not dispatch, replay or overwrite it, and the saved server revision is unchanged.",
          "Valid saved outcomes retain the existing immutable pending request and replay receipt. Storage parsing does not authorize any new effect.",
          "No harness, secret, permission, tenant scope, budget, loop breaker, migration or server execution mechanism changes."],
      "harness": "No execution or permission mechanism introduced; existing pinned native adapters and owned fixtures are reused.",
      "acceptance_mapping": acceptance, "qualifications": qualifications,
      "unresolved_confirmed_defects_in_correction": [], "independent_review_performed": False})

copies = [(SOURCE, "source-equivalence.json"), (review_path, "implementation-self-review.json"),
          (x["canonical_path"], "canonical-driver.json"), (x["gate_path"], "canonical-report.json"),
          (Path(x["canonical"]["log"]), "canonical-pnpm-check.log"),
          (EV/"issue262-check-final-r1-session-exit.json", "canonical-session-exit.json"),
          (x["native_path"], "native-driver.json"), (x["browser_path"], "native/browser-report.json"),
          (EV/"issue262-native-r10-session-exit.json", "native-session-exit.json"),
          (Path(native["qa_root"])/"ownership.json", "fixture-ownership.json"),
          (x["coverage_path"], "coverage-driver.json"),
          (EV/"issue262-coverage-r1-session-exit.json", "coverage-session-exit.json")]
for regression, name in zip(x["regressions"], ["red", "green"]):
    copies += [(regression["path"], f"regression/{name}-driver.json"),
               (Path(regression["receipt"]["log"]), f"regression/{name}.log")]
for path, dep in zip(x["dependency_paths"], x["dependencies"]):
    copies += [(path, "dependencies/"+path.name), (Path(dep["log"]), "dependencies/"+Path(dep["log"]).name)]
copies.append((x["dependency_binding_path"], "dependencies/"+x["dependency_binding_path"].name))
copies += [(Path(step["log"]), "native/"+step["name"]+".log") for step in native["steps"]]
copies += [(x["browser_path"].parent/name, "native/"+name) for name in shots]
copies += [(x["coverage_root"]/name, "coverage/"+name) for name in ["summary.json", "run.json", "coverage.json", "lcov.info", "tests.log"]]
driver_names = set(native["drivers"]) | {
    "run-issue262-check-final-r1.ps1", "run-issue262-coverage-r1.ps1", "run-refresh-warning-green-r1.ps1",
    "issue262_warning_publication_lib_r1.py", "assemble-issue262-warning-correction-r1.py",
    "validate-issue262-warning-correction-r1.py", "commit-issue262-warning-correction-r1.py", "scan-issue262-warning-correction-r1.py"}
copies += [(EV/name, "drivers/"+name) for name in sorted(driver_names)]
assert len({name for _, name in copies}) == len(copies)

secret_key = re.compile(r"^(?:.*_)?(?:credential|credentials|password|passwd|secret|private_key|signing_key|api_key|authorization|cookie|token|access_token|refresh_token|enrollment_token|claim_token|assignment_token|lease_token|publisher_token|auth_token|session_token)$", re.I)
personal = re.compile(r"(?:[a-z]:)?[/\\]+Users[/\\]+[^/\\\s\"'<>]+", re.I)
secrets, redactions, idempotency_aliases = set(), [], {}


def discover(value, location, filename):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "idempotency_key" and isinstance(child, str) and child:
                alias = idempotency_aliases.setdefault(child, f"<idempotency-{len(idempotency_aliases)+1:03d}>")
                redactions.append({"file": filename, "json_path": location+"."+key,
                                   "treatment": "Fixture idempotency identifier replaced with a stable alias preserving equality", "alias": alias})
            elif secret_key.fullmatch(key) and isinstance(child, str) and child:
                redactions.append({"file": filename, "json_path": location+"."+key, "treatment": "credential-bearing string redacted"})
                if child not in {"[REDACTED]", "<REDACTED>", "***"}:
                    secrets.add(child)
            else:
                discover(child, location+"."+key, filename)
    elif isinstance(value, list):
        for i, child in enumerate(value):
            discover(child, f"{location}[{i}]", filename)


def redact_text(value):
    for secret in sorted(secrets, key=len, reverse=True):
        value = value.replace(secret, "<REDACTED>")
    for identifier, alias in idempotency_aliases.items():
        value = value.replace(identifier, alias)
    value = re.sub(r"(?i)C\^?:\^?<USERPROFILE>\\shyamsridhar", "<USERPROFILE>", value)
    return personal.sub("<USERPROFILE>", value).replace("\r\n", "\n")


def scrub(value):
    if isinstance(value, dict):
        return {k: "<REDACTED>" if secret_key.fullmatch(k) and isinstance(v, str) and v else scrub(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return redact_text(value) if isinstance(value, str) else value


try:
    for path, name in copies:
        assert path.is_file() and not path.is_symlink() and "credential" not in path.name.lower(), name
        if path.suffix == ".json":
            discover(load(path), "$", name)
    qa = Path(native["qa_root"])
    for path in [*qa.glob("*.json"), *(qa/"evidence").glob("*.json")]:
        discover(load(path), "$", "private-fixture-discovery:"+path.name)
    PACKET.mkdir(parents=True)
    artifacts = []
    for path, name in copies:
        raw = path.read_bytes()
        if path.suffix == ".png":
            published, transform = raw, "none; original capture bytes"
        else:
            value = json.dumps(scrub(load(path)), indent=2, ensure_ascii=False) if path.suffix == ".json" else redact_text(raw.decode("utf-8-sig"))
            value = "\n".join(line.rstrip() for line in value.splitlines()).rstrip()+"\n"
            assert not personal.search(value.replace("^", "")) and all(secret not in value for secret in secrets), name
            assert all(identifier not in value for identifier in idempotency_aliases), name
            published, transform = value.encode(), "UTF-8/LF and whitespace normalization; personal paths/discovered credential strings redacted; fixture idempotency identifiers replaced with stable aliases; JSON reserialized"
        target = PACKET/name
        assert target.resolve().is_relative_to(PACKET.resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(published)
        artifacts.append({"file": name, "source_name": path.name, "original_sha256": sha(raw),
                          "published_sha256": sha(published), "bytes": len(published), "transform": transform})
    assert not personal.search(patch.decode()) and all(secret not in patch.decode() for secret in secrets)
    write(PACKET/"reviewed-code.patch.json", {"encoding": "utf-8", "context_lines": 0, "base": PARENT,
          "pr_base": MAIN, "tested_tree": tested_tree, "decoded_sha256": sha(patch), "patch": patch.decode()})
    patch_file = PACKET/"reviewed-code.patch.json"
    artifacts.append({"file": patch_file.name, "original_sha256": sha(patch), "published_sha256": sha(patch_file.read_bytes()),
                      "bytes": patch_file.stat().st_size, "transform": "Exact correction diff encoded as JSON"})
    checks = [{k: c[k] for k in ["name", "argv", "exitCode", "passed", "counts"]} for c in x["gate"]["checks"]]
    summary = {"issue": 262, "pr": 389, "review_comment": 4145802423,
               "status": "locally-validated-awaiting-required-hosted-checks", "issue_completed": False,
               "base": MAIN, "parents": [PARENT], "tested_tree": tested_tree, "physical_files_sha256": PHYSICAL,
               "source_file_count": len(physical), "canonical_native_same_complete_physical_source": True,
               "evidence_added_after_code_execution": True, "checks": checks,
               "regression_counts": [r["counts"] for r in x["regressions"]],
               "top_level_browser_groups_including_synthetic": list(browser["checks"]), "native_report_screenshots": len(shots),
               "coverage": x["coverage"], "acceptance_mapping": acceptance, "qualifications": qualifications,
               "artifacts": artifacts, "redactions": redactions}
    write(PACKET/"summary.json", scrub(summary))
    node, rust = x["node"], x["rust"]
    text = f"""# Saved recovery warning correction

Issue #262, PR #389, review comment 4145802423. Current main: {MAIN}.
Correction parent: {PARENT}. Tested implementation tree: {tested_tree}.

A saved recovery draft could restore an object in its optional refresh warning and
pass it to React rendering. Restoration now accepts only an absent warning or a
string. Invalid values use the existing storage error, preserve the stored bytes,
disable revision and send no request. Valid receipts and exact pending requests
keep their existing behavior. The correction changes one guard and adds three tests.

Retrospective regressions observed 39 tests: 37 passed and 2 failed before the guard
fix; 39 passed, 0 failed and 0 skipped afterward. Both failures were the new malformed
warning cases. The tests were written during this correction, not original development.

All eleven canonical pnpm check gates passed with unchanged locked dependencies.
Node: {node['tests']} total / {node['passed']} passed / {node['skipped']} skipped /
{node['failed']} failed. Rust: {rust['passed']} passed / {rust['ignored']} ignored /
{rust['failed']} failed across {rust['summaries']} summaries. The EVM gate is separate.
Model coverage: 502 tests passed across 20 models and 31 test files; 99.69% lines,
97.58% functions and 97.12% branches, with unchanged 99/95/97 thresholds.
These counts overlap and are not additive.

The fresh owned browser/server/PostgreSQL/runner run passed 15 top-level acceptance
groups and retained 19 original screenshots. Ten malformed browser-storage variants
were rejected; absent, empty and textual warnings restored. No revision request was
sent and server revisions/runs were unchanged by these cases. Other groups re-exercise
saved response loss and exact replay, stale reconciliation, explicit launch, native
protocol resume, persisted verification, authority denials and budget restrictions.
The provider and Codex protocol remain deterministic fixtures. Seven recovery
presentation cases are explicitly synthetic. Zero actual human reviews occurred.
The owned services stopped successfully and fixture data was retained.

Green regressions, coverage, native acceptance and canonical validation observed the
same 7,231 physical files: {PHYSICAL}. The tested tree was reconstructed after process
exit. Publication adds this evidence packet afterward and separately verifies original
source bytes, complete check arguments, Node discovery, documentation and secret scanning.
The [previous packet](../2026-09-30-guided-contract-recovery/README.md) remains unchanged
as history. This packet is current validation of the correction, not a rewrite of it.

Artifact SHA-256 pairs identify the original and published bytes. Personal paths and
discovered credential strings are redacted. Synthetic idempotency identifiers use
consistent aliases. Original screenshots are unchanged; private credentials are excluded.

GitHub Actions remains disabled. Required hosted checks are still mandatory; no merge,
issue completion, self-approval or clean historical dependency audit is claimed.

Qualifications:
"""
    text += "\n".join("- "+q for q in qualifications)+"\n"
    (PACKET/"README.md").write_text(text, encoding="utf-8", newline="\n")
    original_files(physical)
    pending_source()
    assert index_digest() == real_index
    files = sorted(p.relative_to(PACKET).as_posix() for p in PACKET.rglob("*") if p.is_file())
    write(RECEIPT, {"issue": 262, "pr": 389, "status": "assembled", "recorded_at_utc": now(),
          "base": MAIN, "parents": [PARENT], "tested_tree": tested_tree,
          "source_receipt_sha256": sha(SOURCE.read_bytes()), "physical_files_sha256": PHYSICAL,
          "publication_files": files, "summary_sha256": sha((PACKET/"summary.json").read_bytes()),
          "original_physical_files_unchanged": True, "original_index_sha256": real_index, "index_unchanged": True,
          "code_paths": code_paths, "native_screenshots": len(shots)})
finally:
    secrets.clear()
    idempotency_aliases.clear()
print(json.dumps({"status": "assembled", "tested_tree": tested_tree, "publication_files": len(files), "index_unchanged": True}))
