"""Publish observed correction evidence after every validation process exits."""
from issue262_alias_publication_lib_r1 import *

SOURCE = EV/"issue262-source-alias-source-r1.json"
RECEIPT = EV/"issue262-source-alias-packet-r1.json"
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
assert code_paths == [] and tested_tree == git("rev-parse", PARENT+"^{tree}").decode().strip()
patch = git("diff", "--binary", "--no-ext-diff", "--no-textconv", "--unified=0", PARENT, tested_tree)
snapshots = []
for phase in x["phases"]:
    path = EV/f"issue262-source-{phase}.json"
    value = load(path)
    assert value["identity"] == observed and value["physical_files"] == physical
    snapshots.append({"file": path.name, "original_sha256": sha(path.read_bytes()),
                      "recorded_at": value["recorded_at"], "physical_files_sha256": PHYSICAL,
                      "source_file_count": len(physical), "identity_equals_tested_source": True, "guard": value["guard"]})
source = {"issue": 262, "pr": 389, "review_comments": [4146642007, 4146642079, 4146642119, 4146642183], "recorded_at_utc": now(),
          "base": MAIN, "parents": [PARENT], "branch": BRANCH, "parent_tree": observed["parent_tree"],
          "tested_tree": tested_tree, "physical_files": physical, "physical_files_sha256": PHYSICAL,
          "source_file_count": len(physical), "code_paths": code_paths, "code_patch_sha256": sha(patch),
          "original_binary_diff_sha256": DIFF, "original_status": observed["status"],
          "original_index_sha256": real_index, "publication_directory": PACKET_REL,
          "snapshot_receipts": snapshots, "canonical_receipt_sha256": sha(x["canonical_path"].read_bytes()),
          "canonical_report_sha256": sha(x["gate_path"].read_bytes()),
          "native_receipt_sha256": sha(x["native_path"].read_bytes()),
          "canonical_native_same_complete_physical_source": True, "native_source_guard": guard_identity(),
          "scope": "Fresh regressions, coverage, native r12 and canonical validation observed identical complete physical source with canonical paths and single-link files. The tested Git tree is reconstructed after execution. The final correction commit did not exist during execution; publication adds only this separately checked packet."}
write(SOURCE, source)

native, browser = x["native"], x["browser"]
shots = sorted(set(png_names(browser)))
assert len(shots) == 19
acceptance = [
    {"criterion": "Reject aliased and multiply linked source at fresh capture",
     "implementation": ["drivers/capture-issue262-source-r3.py: source capture", "drivers/issue262_source_guard_r2.py: canonical_single_link_file and source_sha256"],
     "evidence": ["guard/native-regressions.json", "source-equivalence.json"],
     "result": "The complete 7,304-file source passes canonical declared-path, lexical ancestor/reparse-point, regular-file, single-link and opened-file identity checks. Owned native hard links and parent junctions fail closed."},
    {"criterion": "Apply the same source admission during publication",
     "implementation": ["drivers/issue262_alias_publication_lib_r1.py: original_files", "drivers/validate-issue262-source-alias-r1.py", "drivers/commit-issue262-source-alias-r1.py"],
     "evidence": ["guard/native-regressions.json", "source-equivalence.json"],
     "result": "Assembly, evidence validation and commit call the same native verifier for every original file. Publication inputs and new packet files also require canonical single-link paths and matching bytes."},
    {"criterion": "Regenerate evidence on the actual source after closing the metadata gap",
     "implementation": ["drivers/run-issue262-source-guard-focused-r1.ps1", "drivers/run-issue262-coverage-r1.ps1", "drivers/run-issue262-native-r12.ps1", "drivers/run-issue262-check-final-r1.ps1"],
     "evidence": ["regression/fresh.log", "coverage/summary.json", "native/browser-report.json", "canonical-report.json"],
     "result": "Fresh focused regressions, model coverage, the complete owned local stack and all eleven canonical gates passed with matching physical source and guard identities at each boundary."},
    {"criterion": "Preserve original development chronology and evidence history",
     "implementation": ["source-equivalence.json: physical_files"],
     "evidence": ["implementation-self-review.json", "guard/first-attempt-failure.json", "guard/first-attempt-diagnosis.json"],
     "result": "No product or existing evidence byte changes. Historical capture predicates have an explicitly documented alias-assurance gap and are superseded for readiness by this fresh pass. Native guard attempt R1 failed before product validation; that receipt and diagnosis remain preserved."},
]
qualifications = [
    "This is newly observed validation and assistant implementation self-review. It is not original development chronology, independent GitHub approval or a human decision.",
    "Both historical packets remain byte-for-byte intact. Their old capture/publication predicates did not attest canonical declared paths or single-link source. Fresh validation supersedes that assurance gap; it cannot establish past filesystem metadata.",
    "Source guard R2 is a thin adapter over the existing repository verify_public.py directory_root, unlinked_path and regular_file guards. It adds streamed hashing and opened-file identity checks, not a new execution or permission system.",
    "The first native guard attempt rejected an ordinary file because this Windows/Python runtime returned different lstat/fstat ctime_ns. That failed attempt is preserved. R2 uses the existing reader's portable device, inode, size, mtime_ns and link-count identity fields; all 22 fresh native guard cases passed.",
    "Native R11 stopped before browser acceptance because its copied fixture helper rejected the new QA-root name. Source equality and owned shutdown passed. Its failure is retained; R12 uses a fresh owned stack and the corrected explicit path pattern.",
    "Alias checks establish observed metadata and bytes at capture and publication boundaries. They do not claim continuous operating-system locking or historical metadata.",
    "The fresh owned browser/server/PostgreSQL/runner stack uses deterministic fake-process execution and a synthetic Codex protocol, not live vendor inference, production identity or GitHub effects.",
    "Fifteen top-level browser groups include seven explicitly synthetic recovery presentation cases. Malformed warning variants are synthetic browser-storage edits to a receipt saved by the local server. Zero actual human reviews occurred.",
    "Nineteen original screenshots are retained. They are acceptance artifacts, not exhaustive visual or accessibility certification.",
    "The product head was already committed before this execution. The final evidence-only commit did not yet exist. All original bytes remain unchanged; separately checked evidence is added afterward.",
    "Native r12 records final canonical validation as pending because it completed earlier. The later canonical receipt and matching-source binding establish its successful completion without rewriting that historical native receipt.",
    "Skipped Node and ignored Rust cases are not passes. Focused, coverage, native and canonical counts overlap. Dedicated live and immutable historical replay lanes remain separate.",
    "Locked-dependency receipts are reused with unchanged locks. Steward log bytes were first bound retrospectively by the existing dependency-artifact receipt. Dependency installation was not re-executed.",
    "Rust workspace tests use RUST_TEST_THREADS=1 without filtering tests. The separately required native EVM gate is still executed.",
    "The actual Node runtime is 24.21.0, while the repository declares 24.19.0. Execution on the declared Node version is not claimed.",
    "Required hosted CI, CodeQL, code-quality and security checks remain unavailable while GitHub Actions is disabled. No merge, issue closure, self-approval, policy change or clean historical Cargo advisory audit is claimed.",
]
review_path = EV / "issue262-source-alias-self-review-r1.json"
write(review_path, {"issue": 262, "pr": 389, "recorded_at_utc": now(),
      "reviewer": "Codex assistant; implementation self-review, not independent or human approval",
      "base": MAIN, "parents": [PARENT], "tested_tree": tested_tree, "physical_files_sha256": PHYSICAL,
      "reviewed_paths": ["drivers/issue262_source_guard_r2.py", "drivers/capture-issue262-source-r3.py",
                         "drivers/issue262_alias_publication_lib_r1.py", "drivers/validate-issue262-source-alias-r1.py",
                         "drivers/commit-issue262-source-alias-r1.py"],
      "surrounding_paths": ["docs/evidence/pr362-combined-20260921/verify_public.py",
                            "tools/e2e_stopped_source_checkpoint.mjs", "tools/run_checks.mjs", "test.config.json"],
      "review_comments": [4146642007, 4146642079, 4146642119, 4146642183],
      "confirmed_findings_resolved": [
          {"finding": "Both prior source captures admitted hard-linked files and aliases in parent directories.",
           "resolution": "Fresh capture requires canonical declared paths, no linked/reparse ancestors, regular files and st_nlink == 1 before streaming bytes; the same checks follow the read."},
          {"finding": "Both prior publication guards repeated the incomplete path predicate.",
           "resolution": "The new publication path calls verify_source at assembly, evidence validation, commit and pre-push verification. Dependent evidence is regenerated on this guarded source."}],
      "invariants": [
          "Configured source checkout and existing contributor work remain preserved; all acceptance runs in an owned isolated worktree and fixture.",
          "All original tracked physical bytes, including the earlier product implementation and evidence packets, are unchanged.",
          "No product authorization, tenant/Corp scope, secrets, task state, verification policy, budget, loop breaker, harness or migration behavior is changed.",
          "The existing native evidence reader is reused rather than introducing a competing execution or permissions mechanism.",
          "Observed native failures, skipped and ignored checks, runtime drift and unavailable hosted gates remain disclosed."],
      "acceptance_mapping": acceptance, "qualifications": qualifications,
      "unresolved_confirmed_defects_in_correction": [], "independent_review_performed": False})

copies = [(SOURCE, "source-equivalence.json"), (review_path, "implementation-self-review.json"),
          (x["canonical_path"], "canonical-driver.json"), (x["gate_path"], "canonical-report.json"),
          (Path(x["canonical"]["log"]), "canonical-pnpm-check.log"),
          (EV/"issue262-check-final-r1-session-exit.json", "canonical-session-exit.json"),
          (x["native_path"], "native-driver.json"), (x["browser_path"], "native/browser-report.json"),
          (EV/"issue262-native-r12-session-exit.json", "native-session-exit.json"),
          (Path(native["qa_root"])/"ownership.json", "fixture-ownership.json"),
          (x["coverage_path"], "coverage-driver.json"),
          (EV/"issue262-coverage-r1-session-exit.json", "coverage-session-exit.json")]
for regression, name in zip(x["regressions"], ["fresh"]):
    copies += [(regression["path"], f"regression/{name}-driver.json"),
               (Path(regression["receipt"]["log"]), f"regression/{name}.log")]
for path, dep in zip(x["dependency_paths"], x["dependencies"]):
    copies += [(path, "dependencies/"+path.name), (Path(dep["log"]), "dependencies/"+Path(dep["log"]).name)]
copies.append((x["dependency_binding_path"], "dependencies/"+x["dependency_binding_path"].name))
copies += [(Path(step["log"]), "native/"+step["name"]+".log") for step in native["steps"]]
copies += [(x["browser_path"].parent/name, "native/"+name) for name in shots]
copies += [(x["coverage_root"]/name, "coverage/"+name) for name in ["summary.json", "run.json", "coverage.json", "lcov.info", "tests.log"]]
driver_names = set(native["drivers"]) | {
    "run-issue262-check-final-r1.ps1", "run-issue262-coverage-r1.ps1", "run-issue262-source-guard-focused-r1.ps1",
    "verify-issue262-source-guard-r2.py", "issue262_source_guard_r1.py", "verify-issue262-source-guard-r1.py",
    "issue262_alias_publication_lib_r1.py", "assemble-issue262-source-alias-r1.py",
    "validate-issue262-source-alias-r1.py", "commit-issue262-source-alias-r1.py", "scan-issue262-source-alias-r1.py"}
copies += [(EV/name, "drivers/"+name) for name in sorted(driver_names)]
copies += [
    (EV/"issue262-source-guard-r2.json", "guard/native-regressions.json"),
    (EV/"issue262-source-guard-r1.json", "guard/first-attempt-failure.json"),
    (EV/"issue262-source-guard-r1-diagnosis.json", "guard/first-attempt-diagnosis.json"),
    (EV/"issue262-source-guard-focused-r1-session-exit.json", "regression/session-exit.json"),
    (EV/"issue262-native-r11.json", "history/native-r11-driver.json"),
    (EV/"issue262-native-r11-session-exit.json", "history/native-r11-session-exit.json"),
    (EV/"issue262-native-r11-diagnosis.json", "history/native-r11-diagnosis.json"),
    (EV/"run-issue262-native-r11.ps1", "history/run-issue262-native-r11.ps1"),
    (EV/"issue262-native-codex-r1.ps1", "history/issue262-native-codex-r1.ps1"),
]
assert len({name for _, name in copies}) == len(copies)


def admitted_root(path):
    path = Path(path).absolute()
    for root in [EV, PRIOR, ROOT, Path(native["qa_root"]).absolute()]:
        if path.is_relative_to(root):
            canonical_single_link_file(path, root)
            return root
    raise AssertionError("Publication input is outside explicitly owned roots")


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
        assert canonical_single_link_file(path, admitted_root(path)) == path and "credential" not in path.name.lower(), name
        if path.suffix == ".json":
            discover(json.loads(guarded_bytes(path, admitted_root(path)).decode("utf-8-sig")), "$", name)
    qa = Path(native["qa_root"])
    for path in [*qa.glob("*.json"), *(qa/"evidence").glob("*.json")]:
        discover(json.loads(guarded_bytes(path, qa).decode("utf-8-sig")), "$", "private-fixture-discovery:"+path.name)
    canonical_root(PACKET.parent)
    PACKET.mkdir()
    artifacts = []
    for path, name in copies:
        raw = guarded_bytes(path, admitted_root(path))
        if path.suffix == ".png":
            published, transform = raw, "none; original capture bytes"
        else:
            value = json.dumps(scrub(json.loads(raw.decode("utf-8-sig"))), indent=2, ensure_ascii=False) if path.suffix == ".json" else redact_text(raw.decode("utf-8-sig"))
            value = "\n".join(line.rstrip() for line in value.splitlines()).rstrip()+"\n"
            assert not personal.search(value.replace("^", "")) and all(secret not in value for secret in secrets), name
            assert all(identifier not in value for identifier in idempotency_aliases), name
            published, transform = value.encode(), "UTF-8/LF and whitespace normalization; personal paths/discovered credential strings redacted; fixture idempotency identifiers replaced with stable aliases; JSON reserialized"
        target = PACKET/name
        assert target.is_relative_to(PACKET)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(published)
        assert source_sha256(target, ROOT) == sha(published)
        artifacts.append({"file": name, "source_name": path.name, "original_sha256": sha(raw),
                          "published_sha256": sha(published), "bytes": len(published), "transform": transform})
    assert not personal.search(patch.decode()) and all(secret not in patch.decode() for secret in secrets)
    write(PACKET/"reviewed-code.patch.json", {"encoding": "utf-8", "context_lines": 0, "base": PARENT, "product_code_changed": False,
          "pr_base": MAIN, "tested_tree": tested_tree, "decoded_sha256": sha(patch), "patch": patch.decode()})
    patch_file = PACKET/"reviewed-code.patch.json"
    artifacts.append({"file": patch_file.name, "original_sha256": sha(patch), "published_sha256": sha(patch_file.read_bytes()),
                      "bytes": patch_file.stat().st_size, "transform": "Exact correction diff encoded as JSON"})
    checks = [{k: c[k] for k in ["name", "argv", "exitCode", "passed", "counts"]} for c in x["gate"]["checks"]]
    summary = {"issue": 262, "pr": 389, "review_comments": [4146642007, 4146642079, 4146642119, 4146642183],
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
    text = f"""# Guided recovery source guard correction

Issue #262, PR #389. This packet resolves review comments 4146642007, 4146642079,
4146642119 and 4146642183 on the original capture/publication helpers.
Main: {MAIN}. Validated product head: {PARENT}. Tested tree: {tested_tree}.

The earlier helpers checked resolved containment and the final symlink only. They
could accept a hard-linked file or a path through an aliased parent. Fresh capture
and publication now use the same native guard: declared paths must be canonical,
lexical ancestors must not be symlinks or reparse points, and files must be regular
with a link count of one. Streamed hashes also check the opened file's native
identity before and after reading. The adapter reuses the repository's existing
evidence reader.

All 22 native guard regressions passed, including real NTFS hard links and parent
junctions, ordinary files, source larger than 8 MiB, changed bytes and a mutation
during hashing. The first guard attempt rejected an ordinary file because native
lstat/fstat ctime values differed. Its failure and diagnosis are retained; the
successful guard uses the same portable identity fields as the existing reader.
No product validation ran with the failed guard.

Native R11 then stopped before browser acceptance because its copied Codex fixture
helper still required the old QA-root name. Its source equality and owned shutdown
passed. The failed attempt is retained; R12 uses the corrected explicit path
pattern and a fresh owned stack.

Fresh focused regressions: 39 passed, zero failed or skipped.
All eleven canonical pnpm check gates passed.
Node: {node['tests']} total / {node['passed']} passed / {node['skipped']} skipped /
{node['failed']} failed. Rust: {rust['passed']} passed / {rust['ignored']} ignored /
{rust['failed']} failed across {rust['summaries']} summaries, using one test thread.
The native EVM gate remains separate. Model coverage: 502 passed; 99.69% lines,
97.58% functions and 97.12% branches against unchanged 99/95/97 thresholds.
These counts overlap and are not additive.

The fresh owned browser/server/PostgreSQL/runner stack passed 15 top-level acceptance
groups and retained 19 original screenshots. It re-exercised guided revision,
immutable request replay, stale reconciliation, explicit launch, native protocol
resume, persisted verification, authority restrictions and budget restrictions.
Provider execution and Codex protocol responses are deterministic fixtures;
seven recovery presentation cases and browser-storage variants are explicitly
synthetic. Zero actual human reviews occurred. Owned services stopped successfully.

Every validation boundary observed the same 7,304 physical source files:
{PHYSICAL}. The committed product head existed before the tests. This final
evidence-only commit is added afterward, with source checks again at assembly,
evidence validation and commit. Publication inputs and new packet files also
require canonical single-link paths. The complete named check plan and full Node
discovery are unchanged; documentation and privacy/security checks run afterward.

The [original packet](../2026-09-30-guided-contract-recovery/README.md) and
[warning-correction packet](../2026-09-30-guided-recovery-warning-correction/README.md)
remain unchanged as history. This packet supersedes their incomplete source-alias
assurance for readiness. It does not attest historical filesystem metadata or
continuous operating-system locking.

Artifact hashes bind original and published bytes. Personal paths and discovered
credential strings are redacted; synthetic idempotency identifiers use stable
aliases. Screenshots retain original bytes. Published driver copies have redacted
local paths; configure explicit owned paths before reproducing them. Run Python
with bytecode caching disabled to preserve the source inventory.

GitHub Actions remains disabled. Required hosted CI, CodeQL, quality and security
checks remain mandatory. No merge, issue completion, independent approval or clean
historical Cargo advisory audit is claimed. Actual Node: 24.21.0; the repository
declares 24.19.0, so execution on that declared runtime is not claimed.

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
          "code_paths": code_paths, "native_screenshots": len(shots), "native_source_guard": guard_identity()})
finally:
    secrets.clear()
    idempotency_aliases.clear()
print(json.dumps({"status": "assembled", "tested_tree": tested_tree, "publication_files": len(files), "index_unchanged": True}))
