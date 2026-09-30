"""Publish observed integration evidence only after the canonical process exits."""
from issue264_publication_lib_r1 import *

SOURCE = EV / "issue264-completion-source-r3.json"
RECEIPT = EV / "issue264-completion-packet-r3.json"
assert not any(p.exists() for p in [PACKET, SOURCE, RECEIPT]), "Preserve earlier publication attempts"
x = completed_inputs()
pending_merge()
physical, observed = x["physical"], x["observed"]
original_files(physical)
assert identity() == observed
real_index = index_digest()
with temporary_index("assembly", HEAD) as temporary:
    stage_names(dict(physical), temporary)
    tested_tree = git("write-tree", env=temporary).decode().strip()
    assert set(git("ls-tree", "-r", "--name-only", "-z", tested_tree).decode().split("\0")) - {""} == set(dict(physical))
assert index_digest() == real_index
pending_paths = git("diff", "--name-only", HEAD, tested_tree).decode().splitlines()
integration_paths = git("diff", "--name-only", MAIN, tested_tree).decode().splitlines()
code_paths = [p for p in integration_paths if not p.startswith("docs/evidence/")]
assert len(code_paths) == 85
assert not git("diff", "--name-only", MAIN, tested_tree, "--", "db/migrations", "Cargo.lock", "pnpm-lock.yaml", "scenarios/repo-steward/package-lock.json").strip()
patch = git("diff", "--binary", "--no-ext-diff", "--no-textconv", "--unified=0", MAIN, tested_tree, "--", *code_paths)
pending_patch = git("diff", "--binary", "--no-ext-diff", "--no-textconv", "--unified=0", HEAD, tested_tree)
phases = ["before-dependencies-r3", "after-dependencies-r3", "before-check-r3", "after-check-r3"]
snapshots = [{"name": f"issue264-review-source-{p}.json", "sha256": sha((EV/f"issue264-review-source-{p}.json").read_bytes())} for p in phases]
historical = [[p, digest] for p, digest in physical if p.startswith("docs/evidence/")]
source = {"issues": [263, 264], "dependencies": [258, 259, 260, 261], "recorded_at_utc": now(),
          "base": MAIN, "parent": HEAD, "parents": [HEAD, INCOMING], "branch": BRANCH,
          "parent_tree": observed["parent_tree"], "tested_tree": tested_tree,
          "physical_files": physical, "physical_files_sha256": PHYSICAL, "source_file_count": len(physical),
          "code_paths": code_paths, "integration_paths": integration_paths, "pending_paths": pending_paths,
          "integration_code_patch_sha256": sha(patch), "pending_patch_sha256": sha(pending_patch),
          "original_binary_diff_sha256": DIFF, "original_status": observed["status"], "original_index_sha256": real_index,
          "publication_directory": PACKET_REL, "historical_packet_preserved": historical,
          "preserved_contributions": CONTRIBUTIONS, "snapshot_receipts": snapshots,
          "canonical_receipt_sha256": sha(x["canonical_path"].read_bytes()),
          "canonical_report_sha256": sha(x["gate_path"].read_bytes()),
          "native_receipt_sha256": sha(x["native_path"].read_bytes()),
          "native_source_differences": sorted(NATIVE_DIFFERENCES), "native_unchanged_files": 7524,
          "canonical_native_same_complete_physical_source": False,
          "scope": "Canonical dependencies and all eleven checks observed identical complete physical source. Native r14 preceded three test/coverage-only changes; all 7524 other inputs remain identical. Tested Git tree reconstructed after execution using a temporary index. No final commit existed during these runs."}
write(SOURCE, source)

focused_path = EV / "issue264-focused-review-green-r1.json"
focused = load(focused_path)
focused_log = EV / "issue264-focused-review-green-r1.log"
assert focused["status"] == "passed" and focused["source_unchanged"] and focused["exit_code"] == 0
assert sha(focused_log.read_bytes()) == focused["log_sha256"]
assert re.search(r"(?m)^ℹ pass 58\s*$", focused_log.read_text(encoding="utf-8-sig"))
assert re.search(r"(?m)^ℹ fail 0\s*$", focused_log.read_text(encoding="utf-8-sig"))
for name, digest in focused["source"].items():
    assert sha((ROOT/name).read_bytes()) == digest
mission_path = EV / "issue264-mission-create-green-r1/report.json"
mission = load(mission_path)
assert mission["status"] == "passed" and len(mission["cases"]) == 6 and all(c["status"] == "passed" for c in mission["cases"])
for name, digest in mission["source"].items():
    assert sha((ROOT/name).read_bytes()) == digest
admission_path = EV / "issue264-native-admission-regressions-r1/report.json"
admission = load(admission_path)
assert admission["status"] == "passed" and len(admission["cases"]) == 15 and all(c["status"] == "passed" for c in admission["cases"])
assert admission["source_driver_sha256"] == sha((EV/"issue264-native-admission-r1.mjs").read_bytes())
viewport_path = EV / "issue264-viewport-probe-r4/report.json"
viewport = load(viewport_path)
assert viewport["status"] == "passed" and viewport["stopped"] and len(viewport["cases"]) == 16
assert len(viewport["assertions"]) == 1252 and not viewport["failures"] and not viewport["errors"] and not viewport["unexpected"]
for name, digest in viewport["source"].items():
    assert sha((ROOT/"apps/web"/name).read_bytes()) == digest
native, browser = x["native"], x["browser"]
native_shots = sorted(set(png_names(browser)))
assert len(native_shots) == 112
for name in native_shots:
    path = x["browser_path"].parent/name
    assert path.resolve().is_relative_to(x["browser_path"].parent.resolve()) and path.is_file()

qualifications = [
    "All evidence is retrospective observed validation; it does not claim test-first development or an independent human review.",
    "The canonical run includes the latest #258 history corrections, #259 activity, #260 evidence, #261 budgets and #263/#264 presentation together. All four original PR heads remain ancestors of the intended merge commit.",
    "Native r14 and canonical r3 have different complete physical identities. Exactly two source-contract tests and the coverage-admission tool changed afterward; all application, runtime, style, dependency, migration and fixture inputs are byte-identical. See validation-recovery.json.",
    "Native acceptance uses owned PostgreSQL/server/browser and a deterministic fake-process runner. Scripted Bob decisions are not human reviews. No production OIDC, vendor inference, production grant, deployment or GitHub effect is claimed.",
    "The browser report has 72 top-level checkpoints, including explicitly synthetic variants. They are not 72 native tests. Rich failure/cost/permission cases and production-connect responses that were intercepted remain labeled synthetic.",
    "Text/non-text contrast measurements cover the sampled rendered controls and report exceptions. Group opacity, artwork, gradients and native-widget pixels are outside that scanner. Six screenshot observations were scaled spot inspections; this is not exhaustive WCAG certification.",
    "Skipped Node and ignored Rust cases are not passes. Coverage, focused, canonical and native counts overlap and must not be added together. Dedicated live and historical-replay fixture lanes remain separate.",
    "The final commit did not exist during execution. This evidence packet was added afterward and separately validated for unchanged original bytes, full gate arguments and Node discovery.",
    "Organization-disabled Actions prevents required hosted validation. CI, CodeQL, code-quality and security checks remain mandatory; no merge readiness or issue completion is claimed. Historical Cargo advisory debt is not a clean audit.",
]
acceptance = {
    "263": [
        "Global Light/Dark/System preferences, default System, early bootstrap before CSS, OS updates, explicit override, reload and storage failure: first-paint and persistence checkpoints in native/browser-report.json.",
        "Semantic canvas/surface/control/status/focus tokens across all five workspaces, Connections, native forms, dialogs, evidence, code and diffs: native presentation samples, separately labeled synthetic production-connect cases, viewport probe and THEME-CANVAS/THEME-OFFICE-CONTROLS resolutions.",
        "Measured AA text/non-text thresholds and focus visibility in both themes with explicit sampling limitations; visible status words and icons remain. Retained office artwork and evidence captures are not inverted.",
        "Mode/theme changes have no operational writes. Native historical provider and source-diff identities, drafts and modal state survive the changes; keyboard/390px/reduced-motion cases cover both modes.",
    ],
    "264": [
        "Independent Executive/Operations user preference persists across reload. Executive view projects mission outcomes, responsible team, task states, budget assurance and original result links without a spatial office or routine raw-ID noise.",
        "Critical failed checks/rejection, stalled/stale/unavailable states, exhausted authority, quarantine, pending decisions and unpriced work remain visible; native pending/reconnect cases and synthetic critical-state variants prove distinct covered states.",
        "Exact authorized mission/task/run/artifact selection survives pure toggles and explicit Operations drilldowns. Native historical provider and selected source manifest/diff paths exercise this; role/current-room denial uses real server enforcement.",
        "Existing shared snapshot, selection, result/evidence/budget projections and role-gated controls remain authoritative. No new server execution, approval, ledger or permission mechanism is introduced.",
        "Native creates in both ordinary and delayed-refresh cases each produced one create and one launch. Draft edits survive a delayed refresh; successful creation is committed separately from launch/storage/refresh errors.",
    ],
}
inventory = load(EV/"inventory-r702.json")
criteria = {str(i["number"]): i["body"].split("## Acceptance criteria\n", 1)[1].split("## Boundaries and validation", 1)[0].strip()
            for i in inventory["issues"] if i["number"] in [263, 264]}
review_path = EV/"issue264-completion-self-review-r3.json"
write(review_path, {"issues": [263, 264], "recorded_at_utc": now(), "reviewer": "Codex assistant; implementation self-review, not independent or human approval",
                   "base": MAIN, "parents": [HEAD, INCOMING], "tested_tree": tested_tree, "physical_files_sha256": PHYSICAL,
                   "reviewed_paths": code_paths, "issue_acceptance_criteria": criteria, "acceptance_mapping": acceptance,
                   "invariants": "Office and Executive views project authoritative scoped state. Server/runner/secret boundaries, exact persisted evidence, durable approval and idempotent dispatch remain unchanged. Source/MIME/hash/scope checks reject ambiguous substitutions. Existing applied migrations and pinned dependencies are unchanged.",
                   "harness": "No execution/session/tool/permission mechanism added. Owned acceptance reuses the repository's pinned fake-process native fixture and existing server/runner protocols through the admission driver.",
                   "conflicts": "Preserve exact task/run evidence selection and incoming activity; validate destination before closing inspector; retain regression seams. The later #258 SQL/logging merge has no unresolved conflicts.",
                   "unresolved_confirmed_defects_in_scope": [], "qualifications": qualifications})
feedback_path = EV/"issue264-completion-feedback-resolution-r3.json"
write(feedback_path, {"recorded_at_utc": now(), "tested_tree": tested_tree, "published": False,
    "scope": "Local resolution evidence; remote feedback is not marked resolved or answered by this receipt.",
    "findings": [
        {"pr": 385, "comment": 4140998620, "path": "apps/web/src/App.tsx", "line": 5304,
         "resolution": "Capture request/viewer/draft before await; record successful creation before dispatch/selection/refresh; scoped receipt fences replay and preserves concurrent edits.", "evidence": "focused/mission-create-report.json; native/browser-report.json native_mission_creation"},
        {"pr": 386, "comment": 4140739130, "path": "apps/web/src/sourceEvidence.ts", "line": 105,
         "resolution": "Accept the server's MIME token alphabet and structured JSON suffixes.", "evidence": "focused/review-green.log"},
        {"pr": 386, "comment": 4140739159, "path": "apps/web/src/sourceEvidence.ts", "line": 153,
         "resolution": "Provider source identity falls back to workspace_base_commit, retaining mismatch rejection.", "evidence": "focused/review-green.log"},
        {"pr": 386, "comment": 4140739187, "path": "apps/web/src/sourceEvidence.ts", "line": 347,
         "resolution": "Use locale-independent path search normalization.", "evidence": "focused/review-green.log"},
        {"pr": 387, "comment": 4140725979, "path": "apps/web/src/BudgetOverviewPanel.tsx", "line": 26,
         "resolution": "Both budget and Executive panels sample the external freshness clock in a layout effect before paint.", "evidence": "focused/review-green.log"},
        {"pr": 386, "comment": 4140739090, "path": "drivers/issue264-native-admission-r1.mjs", "line": 1,
         "resolution": "New native driver verifies executable root, fixture ownership and transitive inputs; historical driver remains immutable.", "evidence": "focused/admission-report.json; native-driver.json"},
    ]})
visual_path = EV/"issue264-completion-visual-resolution-r3.json"
write(visual_path, {"recorded_at_utc": now(), "tested_tree": tested_tree,
    "history_preserved": "visual-findings-original.json retains the original pending findings and disproven skip-link allegation.",
    "resolved": [
        {"id": "THEME-CANVAS", "path": "apps/web/src/ConsoleTheme.css", "line": 82, "resolution": "Root canvas now uses --theme-canvas, observed in native and synthetic light/dark captures."},
        {"id": "THEME-OFFICE-CONTROLS", "path": "apps/web/src/OfficeFloor.css", "line": 120, "resolution": "Office DOM controls, status, roster, surfaces and focus use semantic theme tokens; artwork keeps original colors."},
    ], "evidence": ["native/browser-report.json", "viewport/report.json", "visual-observations.json"],
    "limits": qualifications[5]})

copies = [(SOURCE, "source-equivalence.json"), (x["canonical_path"], "canonical-driver.json"),
          (x["gate_path"], "canonical-report.json"), (Path(x["canonical"]["log"]), "canonical-pnpm-check.log"),
          (x["dependency_path"], "locked-dependencies.json"), (x["native_path"], "native-driver.json"),
          (x["browser_path"], "native/browser-report.json"), (Path(native["qa_root"])/"ownership.json", "fixture-ownership.json"),
          (x["recovery_path"], "validation-recovery.json"), (review_path, "implementation-self-review.json"),
          (feedback_path, "feedback-resolution.json"), (visual_path, "visual-resolution.json"),
          (EV/"issue264-visual-findings-r1.json", "visual-findings-original.json"),
          (EV/"issue264-visual-observations-r2.json", "visual-observations.json"),
          (focused_path, "focused/review-green.json"), (focused_log, "focused/review-green.log"),
          (mission_path, "focused/mission-create-report.json"), (admission_path, "focused/admission-report.json"),
          (viewport_path, "viewport/report.json"),
          (EV/"issue264-dependency-conflict-resolution-r1.json", "history/dependency-conflicts.json"),
          (EV/"issue264-history-and-theme-integration-r2.json", "history/history-and-theme-integration.json"),
          (EV/"issue264-integration-checkpoint-r1.json", "history/checkpoint.json"),
          (EV/"issue264-review-check-r3-session-exit.json", "canonical-session-exit.json")]
copies += [(Path(s["log"]), "native-"+s["name"]+".log") for s in native["steps"] if s["name"] != "prepare"]
copies += [(Path(s["log"]), "dependencies-"+s["name"]+".log") for s in x["dependencies"]["steps"]]
copies += [(x["browser_path"].parent/name, "native/"+name) for name in native_shots]
copies += [(viewport_path.parent/name, "viewport/"+name) for name in sorted(set(png_names(viewport)))]
copies += [(x["coverage_root"]/name, "coverage/"+name) for name in ["summary.json", "run.json", "coverage.json", "lcov.info", "tests.log"]]
copies += [(EV/s["name"], "source/"+s["name"]) for s in snapshots]
copies += [(EV/f"issue264-review-source-{p}.json", f"source/issue264-review-source-{p}.json") for p in ["before-native-r14", "after-native-r14"]]
prior = load(EV/"issue264-review-check-r2.json")
copies += [(EV/"issue264-review-check-r2.json", "history/canonical-r2-driver.json"),
           (Path(prior["canonical_report"]), "history/canonical-r2-report.json"),
           (Path(prior["log"]), "history/canonical-r2.log")]
driver_names = set(native["drivers"]) | {"run-issue264-review-native-r14.ps1", "run-issue264-review-dependencies-r3.ps1",
    "run-issue264-review-check-r3.ps1", "record-issue264-validation-recovery-r1.py", "issue264-viewport-probe-r4.mjs",
    "issue264-native-admission-regressions-r1.mjs", "issue264_publication_lib_r1.py", "assemble-issue264-completion-r3.py",
    "validate-issue264-completion-r3.py", "commit-issue264-completion-r3.py", "scan-issue264-completion-r3.py"}
driver_names.add("repair-issue264-evidence-classifier-r1.py")
driver_names.add("prepare-issue264-publication-r3.py")
copies += [(EV/name, "drivers/"+name) for name in sorted(driver_names)]
copies += [(EV/"issue264-publication-redaction-regressions-r1.json", "history/redaction-regressions.json"), (EV/"issue264-completion-packet-r1-failure.json", "history/assembly-r1-failure.json")]
copies += [(EV/"issue264-completion-evidence-validation-r2.json", "history/publication-r2-validation.json"),
           (EV/"issue264-publication-secret-triage-r1.json", "history/publication-r2-triage.json"),
           (EV/"issue264-completion-packet-r2-preservation.json", "history/publication-r2-preservation.json"),
           (EV/"issue264-publication-schema-regressions-r1.json", "history/publication-schema-regressions.json")]
assert len({name for _, name in copies}) == len(copies)

secret_key = re.compile(r"^(?:.*_)?(?:credential|credentials|password|passwd|secret|private_key|signing_key|api_key|authorization|cookie|token|access_token|refresh_token|enrollment_token|claim_token|assignment_token|lease_token|publisher_token|auth_token|session_token)$", re.I)
css_design_tokens = set(re.findall(r"(--[-a-z0-9]+)\s*:", (ROOT/"apps/web/src/ConsoleTheme.css").read_text(encoding="utf-8")))

def is_secret_field(container, key, child):
    if not secret_key.fullmatch(key) or not isinstance(child, str) or not child:
        return False
    # These two exact measurement schemas use token for a defined CSS property.
    # Other token fields, even with a CSS-looking value, remain credential-bearing.
    if key == "token" and child in css_design_tokens and set(container) in (
        {"state", "token", "color", "contrast"},
        {"selector", "token", "expected", "observed"},
    ):
        return False
    return True

secrets, redactions = set(), []
personal = re.compile(r"(?:[a-z]:)?[/\\]+Users[/\\]+[^/\\\s\"'<>]+", re.I)
def discover(value, location, filename):
    if isinstance(value, dict):
        for key, child in value.items():
            if is_secret_field(value, key, child):
                redactions.append({"file": filename, "json_path": location+"."+key, "treatment": "credential-bearing value redacted"})
                if child not in {"[REDACTED]", "<REDACTED>", "***"}: secrets.add(child)
            else: discover(child, location+"."+key, filename)
    elif isinstance(value, list):
        for i, child in enumerate(value): discover(child, f"{location}[{i}]", filename)
def redact_text(value):
    for secret in sorted(secrets, key=len, reverse=True): value = value.replace(secret, "<REDACTED>")
    value = re.sub(r"(?i)C\^?:\^?<USERPROFILE>\\shyamsridhar", "<USERPROFILE>", value)
    return personal.sub("<USERPROFILE>", value).replace("\r\n", "\n")
def publication_data(value, artifact_name):
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

def scrub(value):
    if isinstance(value, dict):
        return {k: "<REDACTED>" if is_secret_field(value, k, v) else scrub(v) for k, v in value.items()}
    if isinstance(value, list): return [scrub(v) for v in value]
    return redact_text(value) if isinstance(value, str) else value
try:
    for path, name in copies:
        assert path.is_file() and not path.is_symlink() and "credential" not in path.name.lower(), name
        if path.suffix == ".json": discover(load(path), "$", name)
    qa = Path(native["qa_root"])
    for path in list(qa.glob("*.json")) + list((qa/"evidence").glob("*.json")):
        discover(load(path), "$", "private-fixture-discovery:"+path.name)
    PACKET.mkdir(parents=True)
    artifacts = []
    for path, name in copies:
        raw = path.read_bytes()
        if path.suffix == ".png":
            published, transform = raw, "none; original capture bytes"
        else:
            value = json.dumps(scrub(publication_data(load(path), name)), indent=2, ensure_ascii=False) if path.suffix == ".json" else redact_text(raw.decode("utf-8-sig"))
            value = "\n".join(line.rstrip() for line in value.splitlines()).rstrip()+"\n"
            assert not personal.search(value.replace("^", "")) and all(secret not in value for secret in secrets), name
            published, transform = value.encode(), "UTF-8/LF and whitespace normalization; personal paths/discovered credentials redacted; JSON reserialized"
            if name == "viewport/report.json": transform += "; $.source map converted losslessly to sorted path/sha256 records after verifying all seven hashes against the reviewed source"
        target = PACKET/name
        assert target.resolve().is_relative_to(PACKET.resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream: stream.write(published)
        artifacts.append({"file": name, "source_name": path.name, "original_sha256": sha(raw), "published_sha256": sha(published), "bytes": len(published), "transform": transform})
    assert not personal.search(patch.decode()) and all(secret not in patch.decode() for secret in secrets)
    write(PACKET/"reviewed-code.patch.json", {"encoding": "utf-8", "context_lines": 0, "base": MAIN, "tested_tree": tested_tree, "decoded_sha256": sha(patch), "patch": patch.decode()})
    artifacts.append({"file": "reviewed-code.patch.json", "original_sha256": sha(patch), "published_sha256": sha((PACKET/"reviewed-code.patch.json").read_bytes()), "bytes": (PACKET/"reviewed-code.patch.json").stat().st_size, "transform": "Exact integration code patch encoded as JSON; excludes evidence"})
    checks = [{k:c[k] for k in ["name", "argv", "exitCode", "passed", "counts"]} for c in x["gate"]["checks"]]
    summary = {"issues": [263, 264], "dependencies": [258, 259, 260, 261], "status": "local-integration-validated", "issue_completed": False,
               "base": MAIN, "parents": [HEAD, INCOMING], "tested_tree": tested_tree, "physical_files_sha256": PHYSICAL,
               "source_file_count": len(physical), "historical_packet_files_preserved": len(historical),
               "canonical_native_same_complete_physical_source": False, "native_source_differences": sorted(NATIVE_DIFFERENCES),
               "native_unchanged_files": 7524, "evidence_added_after_code_execution": True,
               "checks": checks, "top_level_browser_checkpoints_including_synthetic": list(browser["checks"]),
               "native_report_screenshots": len(native_shots), "focused_review_passed": 58, "mission_creation_regressions_passed": 6,
               "fixture_admission_regressions_passed": 15, "coverage": x["coverage"], "acceptance_mapping": acceptance,
               "qualifications": qualifications, "artifacts": artifacts, "redactions": redactions}
    write(PACKET/"summary.json", scrub(summary))
    node, rust = x["node"], x["rust"]
    readme = f"""# Console themes and Executive / Operations presentation

Issues #263 and #264, integrated with contributions for #258, #259, #260 and #261.
Observed main: {MAIN}. Preserved parents: {HEAD} and {INCOMING}.
Tested implementation tree: {tested_tree}.

The console gains independent persistent Light/Dark/System and Executive/Operations
preferences. The restrained Executive view keeps critical decisions and uncertain
data visible and opens exact authorized context in the existing Operations workflow.
The integration also resolves mission-creation replay/draft loss, source-evidence
compatibility and freshness-clock findings without introducing another control plane.

All eleven canonical pnpm check gates passed with locked dependencies on 7,527
unchanged physical files. Source SHA-256: {PHYSICAL}.
Node: {node['tests']} total / {node['passed']} passed / {node['skipped']} skipped;
zero failed, cancelled or todo. Rust: {rust['passed']} passed / {rust['ignored']} ignored /
{rust['failed']} failed across {rust['summaries']} summaries. The native EVM gate is separate.
Model coverage: 804 passed, 24 models, 46 test files; 99.80% lines, 98.14% functions,
98.60% branches against unchanged 99/95/97 thresholds. Counts overlap.

Native/browser-report.json retains 72 named checkpoints, including explicitly
synthetic cases, with 112 original PNG captures. The real owned PostgreSQL/server/
fake-process runner path verifies exact historical evidence, authorized download,
scope denial and browser mission creation. Both created missions recorded one create
and one launch. Services were stopped. Synthetic and native evidence are labeled.

Native r14 preceded three test/coverage-only changes. All other 7,524 physical
inputs are byte-identical; validation-recovery.json records this retrospective
applicability analysis. The native run did not execute at r3's complete identity.

Publication r2 stopped at a secret-scan finding: the flagged value was verified
as the SHA-256 of src/Accessible.css. The original failed packet remains preserved.
The viewport report now represents its seven source hashes as path/sha256 records,
retaining every name and digest. Original/published hashes record the transformation.
Scanner rules and repository policy remain unchanged.

The final commit did not exist during execution. The separately validated packet
adds evidence only, with original/published hashes and credential/path redaction;
private credential files and preparation logs are excluded. Existing evidence is
preserved. See source-equivalence.json, implementation-self-review.json,
feedback-resolution.json and visual-resolution.json for review details.

Hosted Actions remains organization-disabled. Required CI, CodeQL, code-quality
and security checks are not bypassed. No merge or issue completion is claimed.

Acceptance mapping:
""" + "\n".join(f"- #{issue}: {item}" for issue, entries in acceptance.items() for item in entries) + "\n\nQualifications:\n" + "\n".join("- "+q for q in qualifications) + "\n"
    (PACKET/"README.md").write_text(readme, encoding="utf-8", newline="\n")
    original_files(physical)
    pending_merge()
    assert index_digest() == real_index
    files = sorted(p.relative_to(PACKET).as_posix() for p in PACKET.rglob("*") if p.is_file())
    write(RECEIPT, {"issues": [263, 264], "status": "assembled", "recorded_at_utc": now(), "base": MAIN,
                   "parents": [HEAD, INCOMING], "tested_tree": tested_tree, "source_receipt": str(SOURCE),
                   "source_receipt_sha256": sha(SOURCE.read_bytes()), "physical_files_sha256": PHYSICAL,
                   "publication_files": files, "summary_sha256": sha((PACKET/"summary.json").read_bytes()),
                   "original_physical_files_unchanged": True, "original_index_sha256": real_index, "index_unchanged": True,
                   "historical_packet_files_preserved": len(historical), "integration_code_paths": len(code_paths), "native_screenshots": 112})
finally:
    secrets.clear()
print(json.dumps({"status": "assembled", "tested_tree": tested_tree, "publication_files": len(files), "integration_code_paths": len(code_paths), "index_unchanged": True}))
