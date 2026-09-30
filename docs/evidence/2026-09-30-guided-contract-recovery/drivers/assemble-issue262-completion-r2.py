"""Assemble observed evidence only after the final canonical process has exited."""
from issue262_publication_lib_r2 import *

SOURCE = EV/"issue262-completion-source-r2.json"
RECEIPT = EV/"issue262-completion-packet-r2.json"
assert not any(p.exists() for p in [PACKET, SOURCE, RECEIPT]), "Preserve prior publication attempts"
x = completed_inputs()
pending_source()
physical, observed = x["physical"], x["observed"]
original_files(physical)
assert identity() == observed
real_index = index_digest()
with temporary_index("assembly", MAIN) as temporary:
    stage_names(dict(physical), temporary)
    tested_tree = git("write-tree", env=temporary).decode().strip()
    assert set(git("ls-tree", "-r", "--name-only", "-z", tested_tree).decode().split("\0")) - {""} == set(dict(physical))
assert index_digest() == real_index
code_paths = git("diff", "--name-only", MAIN, tested_tree).decode().splitlines()
assert len(code_paths) == 10 and all(not p.startswith("docs/evidence/") for p in code_paths)
assert not git("diff", "--name-only", MAIN, tested_tree, "--", "db/migrations", "Cargo.lock", "pnpm-lock.yaml", "scenarios/repo-steward/package-lock.json").strip()
patch = git("diff", "--binary", "--no-ext-diff", "--no-textconv", "--unified=0", MAIN, tested_tree)
snapshots = []
for phase in ["before-coverage-r1", "after-coverage-r1", *x["phases"]]:
    path = EV/f"issue262-source-{phase}.json"
    value = load(path)
    assert value["identity"] == observed and value["physical_files"] == physical
    snapshots.append({"file": path.name, "original_sha256": sha(path.read_bytes()),
                      "recorded_at": value["recorded_at"], "physical_files_sha256": PHYSICAL,
                      "source_file_count": len(physical), "identity_equals_tested_source": True})
source = {"issue": 262, "recorded_at_utc": now(), "base": MAIN, "parents": [MAIN], "branch": BRANCH,
          "parent_tree": observed["parent_tree"], "tested_tree": tested_tree,
          "physical_files": physical, "physical_files_sha256": PHYSICAL, "source_file_count": len(physical),
          "code_paths": code_paths, "code_patch_sha256": sha(patch), "original_binary_diff_sha256": DIFF,
          "original_status": observed["status"], "original_index_sha256": real_index,
          "publication_directory": PACKET_REL, "snapshot_receipts": snapshots,
          "canonical_receipt_sha256": sha(x["canonical_path"].read_bytes()),
          "canonical_report_sha256": sha(x["gate_path"].read_bytes()),
          "native_receipt_sha256": sha(x["native_path"].read_bytes()),
          "canonical_native_same_complete_physical_source": True,
          "scope": "Final canonical, native r9 and coverage r1 observed identical complete physical source. Tested tree reconstructed after execution using a temporary index. No final commit existed during these runs."}
write(SOURCE, source)

acceptance = [
    {"criterion": "Labeled fields, inline validation, before/after summary and exact advanced JSON parity",
     "implementation": ["apps/web/src/ContractRevisionEditor.tsx", "apps/web/src/contractRevision.ts"],
     "evidence": ["native/browser-report.json: browser_exact_all_supported_fields_roundtrip_draft_only",
                  "native/browser-report.json: guided_fields_errors_focus_lists_and_existing_verifier_editor"],
     "result": "All 19 supported contract fields roundtrip; schema/type/unknown-field errors stay visible and verifier policy uses its existing editor."},
    {"criterion": "Separate revision editing/saving from dispatch and resume, with exact target and eligibility",
     "implementation": ["apps/web/src/App.tsx:904", "apps/web/src/App.tsx:1004", "apps/web/src/App.tsx:3946"],
     "evidence": ["native/browser-report.json: native_resume_revision_saved_without_execution",
                  "native/browser-report.json: browser_explicit_launch_native_contract_v4_verified"],
     "result": "Saved revision alone creates no run. Target task/run/version, reason and explicit permitted next action remain visible."},
    {"criterion": "Plain-language recovery guidance preserves stop, quarantine, budget and controller restrictions",
     "implementation": ["apps/web/src/contractRevision.ts:345", "apps/web/src/ContractRevisionEditor.tsx"],
     "evidence": ["native/browser-report.json: native_no_budget_guidance_save_preserves_restriction",
                  "native/browser-report.json: synthetic_browser_recovery_restrictions_and_controller_handoff"],
     "result": "Native no-budget restriction persists; seven explicitly synthetic browser cases confirm stop/quarantine and Factory handoff/error/missing/stale guidance without mutations."},
    {"criterion": "Do not widen execution authority or duplicate budget semantics",
     "implementation": ["apps/web/src/contractRevision.ts", "crates/crony-store/src/contract_revision.rs:569"],
     "evidence": ["native/browser-report.json: native_and_guided_resume_authority_denials",
                  "history/connection-red.log", "history/connection-green.log"],
     "result": "Native resume rejects tool/scope/prohibition/source/connection/budget changes; adding, removing or swapping a workspace connection is now rejected by the store."},
    {"criterion": "Preserve drafts and exact idempotency through failures and show explicit stale reconciliation",
     "implementation": ["apps/web/src/contractRevision.ts:272", "apps/web/src/contractRevision.ts:326",
                        "apps/web/src/App.tsx:1004", "apps/web/src/App.tsx:5174"],
     "evidence": ["native/browser-report.json: native_response_loss_reload_exact_replay_single_revision_no_execution",
                  "native/browser-report.json: native_stale_version_denial_and_explicit_reconciliation",
                  "apps/web/src/contractRevisionLifecycle.test.mjs"],
     "result": "Two requests after committed response loss yield one revision and zero runs. Immutable retry and storage readback protect unknown outcomes; a refused replay remains uncertain."},
    {"criterion": "Authority, API parity, accessibility and exact native recovery",
     "implementation": ["apps/web/src/App.tsx:3505", "apps/web/src/ContractRevision.css"],
     "evidence": ["native/browser-report.json: mobile_390_keyboard_close_reopen_preserves_draft",
                  "native/browser-report.json: native_member_outsider_and_corp_denials_preserve_actor_draft",
                  "native/browser-report.json: browser_native_codex_resume_preserved_session_workspace_and_verifier"],
     "result": "Actor/Corp/room/mission/task/server scope fences drafts. Desktop/390px keyboard and reduced-motion fixture preserve edits; native server denials and file/test verification retain existing authority."},
]
qualifications = [
    "Evidence is retrospective observed validation. This is agent implementation self-review, not independent approval or a human decision.",
    "The owned PostgreSQL/server/browser path uses deterministic fake-process execution and a synthetic Codex native protocol. No real vendor inference, production OIDC, production grant or deployment is claimed.",
    "The 13 top-level browser groups include seven explicitly synthetic recovery cases in one group. They are not 13 wholly native tests. Zero actual human reviews were performed.",
    "Seventeen original PNG captures are retained. Prior scaled spot inspection covered desktop, 390px keyboard and no-budget views; this is not exhaustive pixel or accessibility certification.",
    "Final canonical, native r9 and coverage r1 used identical 7152-file physical source. The final commit did not exist during execution; this evidence-only addition is validated separately for original bytes, check argv and full Node discovery.",
    "Skipped Node and ignored Rust cases are not passes. Canonical, focused, coverage and native counts overlap and must not be added. Dedicated live and immutable historical replay lanes remain separate.",
    "Original locked-install receipts are unchanged. The pnpm receipt included an uppercase hexadecimal log digest. The Steward receipt lacked an installation-time log digest; its retained log bytes were first bound retrospectively during publication preparation, not during installation.",
    "The first publication packet failed native secret scanning on twelve UUID fixture idempotency keys. That packet and failed validation are preserved privately. Published keys now use stable aliases that retain replay equality; implementation bytes, native receipts and secret-scan policy are unchanged.",
    "Native r8 failed because the fixture correctly stopped at 6000 used against 5000 allowed. r9 raises only the fixture allowance to 6000 and asserts suspend. The failed attempt remains recorded.",
    "GitHub Actions remains disabled; required hosted CI, CodeQL, code-quality and security checks remain mandatory. No merge or issue completion is claimed. Historical Cargo advisory debt is not a clean audit.",
]
review_path = EV/"issue262-completion-self-review-r2.json"
write(review_path, {"issue": 262, "recorded_at_utc": now(),
      "reviewer": "Codex assistant; implementation self-review, not independent or human approval",
      "base": MAIN, "parents": [MAIN], "tested_tree": tested_tree, "physical_files_sha256": PHYSICAL,
      "reviewed_paths": code_paths, "acceptance_mapping": acceptance,
      "issue_context_sha256": sha((EV/"issue262-current-context-r2.json").read_bytes()),
      "existing_issue_comments_at_review": 0,
      "invariants": [
          "UI remains a projection of scoped server state; no server shell execution or new control plane.",
          "Drafts bind server, Corp, actor, room, mission and task. Saving requires preserved request bytes and readback before mutation.",
          "Unknown outcomes keep exact request/key; successful receipts fence duplicate writes and are separate from refresh errors.",
          "Resume ancestry is bounded and fail-closed; exact selected source, persisted verifier policy, native session/workspace, monotonic stop/quarantine and budget authority remain enforced.",
          "Applied migrations, pinned dependencies, secret delivery, shared task state and durable command mechanisms are unchanged."],
      "harness": "No execution, session or permission mechanism added. Recovery uses existing pinned native adapters and the repository's owned deterministic acceptance fixture.",
      "confirmed_findings_resolved": [{"path": "crates/crony-store/src/contract_revision.rs", "line": 569,
          "finding": "Resume narrowness omitted workspace_connection_id and allowed a preserved workspace to change connection authority.",
          "resolution": "Compare connection identity alongside existing source/secret/model/deliverable authority; test add/remove/swap rejection and narrower allowed work."}],
      "unresolved_confirmed_defects_in_scope": [], "qualifications": qualifications})

native, browser = x["native"], x["browser"]
shots = sorted(set(png_names(browser)))
assert len(shots) == 17
copies = [(SOURCE, "source-equivalence.json"), (review_path, "implementation-self-review.json"),
          (x["canonical_path"], "canonical-driver.json"), (x["gate_path"], "canonical-report.json"),
          (Path(x["canonical"]["log"]), "canonical-pnpm-check.log"),
          (EV/"issue262-check-final-r1-session-exit.json", "canonical-session-exit.json"),
          (x["native_path"], "native-driver.json"), (x["browser_path"], "native/browser-report.json"),
          (Path(native["qa_root"])/"ownership.json", "fixture-ownership.json"),
          (x["coverage_path"], "coverage-driver.json"), (EV/"issue262-check-r1.json", "history/baseline-canonical-driver.json"),
          (EV/"issue262-focused-r3.json", "history/focused-driver.json"),
          (EV/"issue262-focused-r3.log", "history/focused.log"),
          (EV/"issue262-native-connection-red-r1.json", "history/connection-red-driver.json"),
          (EV/"issue262-native-connection-red-r1.log", "history/connection-red.log"),
          (EV/"issue262-native-connection-green-r1.json", "history/connection-green-driver.json"),
          (EV/"issue262-native-connection-green-r1.log", "history/connection-green.log"),
          (EV/"issue262-completion-evidence-validation-r1.json", "history/publication-privacy-failed-r1.json")]
for path, dep in zip(x["dependency_paths"], x["dependencies"]):
    copies += [(path, "dependencies/"+path.name), (Path(dep["log"]), "dependencies/"+Path(dep["log"]).name)]
copies.append((x["dependency_binding_path"], "dependencies/"+x["dependency_binding_path"].name))
copies += [(Path(step["log"]), "native/"+step["name"]+".log") for step in native["steps"]]
copies += [(x["browser_path"].parent/name, "native/"+name) for name in shots]
copies += [(x["coverage_root"]/name, "coverage/"+name) for name in ["summary.json", "run.json", "coverage.json", "lcov.info", "tests.log"]]
for i in range(2, 9):
    prior_path = EV/f"issue262-native-r{i}.json"
    assert prior_path.is_file()
    copies.append((prior_path, f"history/native-r{i}-driver.json"))
for step in load(EV/"issue262-native-r8.json")["steps"]:
    if step["name"] == "browser":
        copies.append((Path(step["log"]), "history/native-r8-browser.log"))
driver_names = set(native["drivers"]) | {
    "run-issue262-check-final-r1.ps1", "run-issue262-coverage-r1.ps1",
    "issue262_publication_lib_r2.py", "assemble-issue262-completion-r2.py",
    "validate-issue262-completion-r2.py", "commit-issue262-completion-r2.py", "scan-issue262-completion-r2.py"}
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
    write(PACKET/"reviewed-code.patch.json", {"encoding": "utf-8", "context_lines": 0, "base": MAIN,
          "tested_tree": tested_tree, "decoded_sha256": sha(patch), "patch": patch.decode()})
    patch_file = PACKET/"reviewed-code.patch.json"
    artifacts.append({"file": patch_file.name, "original_sha256": sha(patch), "published_sha256": sha(patch_file.read_bytes()),
                      "bytes": patch_file.stat().st_size, "transform": "Exact implementation diff encoded as JSON"})
    checks = [{k: c[k] for k in ["name", "argv", "exitCode", "passed", "counts"]} for c in x["gate"]["checks"]]
    summary = {"issue": 262, "status": "locally-validated-awaiting-required-hosted-checks", "issue_completed": False,
               "base": MAIN, "parents": [MAIN], "tested_tree": tested_tree, "physical_files_sha256": PHYSICAL,
               "source_file_count": len(physical), "canonical_native_same_complete_physical_source": True,
               "evidence_added_after_code_execution": True, "checks": checks,
               "top_level_browser_groups_including_synthetic": list(browser["checks"]), "native_report_screenshots": len(shots),
               "coverage": x["coverage"], "acceptance_mapping": acceptance, "qualifications": qualifications,
               "artifacts": artifacts, "redactions": redactions}
    write(PACKET/"summary.json", scrub(summary))
    node, rust = x["node"], x["rust"]
    text = f"""# Guided contract revision and recovery

Issue #262. Observed main and sole parent: {MAIN}.
Tested implementation tree: {tested_tree}.

Guided controls replace JSON-first editing while retaining all 19 supported contract
fields and the exact advanced editor. Drafts keep exact scope, version and immutable
retry bodies. Saving a revision never dispatches or resumes. Explicit reconciliation
and existing native recovery restrictions remain visible.

The server now rejects adding, removing or swapping workspace-connection authority
when revising a preserved run for resume. Regression and native denial evidence are retained.

All eleven final canonical pnpm check gates passed with locked dependencies.
Node: {node['tests']} total / {node['passed']} passed / {node['skipped']} skipped /
{node['failed']} failed. Rust: {rust['passed']} passed / {rust['ignored']} ignored /
{rust['failed']} failed across {rust['summaries']} summaries. The EVM gate is separate.
Model coverage: 499 tests passed across 20 models and 31 test files;
99.66% lines, 97.58% functions, 97.11% branches, with unchanged 99/95/97 thresholds.
Counts overlap and are not additive.

native/browser-report.json records 13 top-level groups and 17 original PNG captures.
The owned browser/server/PostgreSQL/runner fixture exercised actual save, rejection,
response loss, exact replay, stale reconciliation, explicit launch, native Codex
protocol resume, persisted verification, and no-budget denial. The Codex protocol
and inference are deterministic fixtures. Seven recovery presentation cases are
explicitly synthetic. Zero actual human reviews were performed. Services were stopped.

Native r9, coverage r1 and final canonical validation observed the same 7,152
physical files: {PHYSICAL}. The tested tree was reconstructed after process exit
using a temporary index. The final commit did not exist during execution. Publication
adds this evidence packet afterward; its separate validation verifies original bytes,
unchanged full check arguments/Node discovery, documentation and native secret scanning.

Original/published SHA-256 pairs identify every copied artifact. Personal paths and
discovered credential strings are redacted; fixture idempotency identifiers use
stable aliases preserving equality. Private credential files are excluded.
Earlier failed native drivers, the r8 failed browser log and the older baseline
canonical receipt remain historical evidence; they are not final-source passes.

Required hosted validation remains blocked by disabled GitHub Actions. No merge,
GitHub approval, issue closure or clean historical dependency audit is claimed.

Acceptance mapping:
"""
    text += "\n".join("- "+a["criterion"]+": "+a["result"] for a in acceptance)
    text += "\n\nQualifications:\n"+"\n".join("- "+q for q in qualifications)+"\n"
    (PACKET/"README.md").write_text(text, encoding="utf-8", newline="\n")
    original_files(physical)
    pending_source()
    assert index_digest() == real_index
    files = sorted(p.relative_to(PACKET).as_posix() for p in PACKET.rglob("*") if p.is_file())
    write(RECEIPT, {"issue": 262, "status": "assembled", "recorded_at_utc": now(), "base": MAIN, "parents": [MAIN],
          "tested_tree": tested_tree, "source_receipt_sha256": sha(SOURCE.read_bytes()), "physical_files_sha256": PHYSICAL,
          "publication_files": files, "summary_sha256": sha((PACKET/"summary.json").read_bytes()),
          "original_physical_files_unchanged": True, "original_index_sha256": real_index, "index_unchanged": True,
          "code_paths": code_paths, "native_screenshots": len(shots)})
finally:
    secrets.clear()
    idempotency_aliases.clear()
print(json.dumps({"status": "assembled", "tested_tree": tested_tree, "publication_files": len(files), "index_unchanged": True}))
