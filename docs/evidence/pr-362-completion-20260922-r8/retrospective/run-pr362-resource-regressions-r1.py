"""Retain observed behavior and source identities for PR362 admission fixes."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

base = Path(__file__).resolve().parent
repo = Path(r"<reviewed-worktree>")
phase = sys.argv[1]
assert phase in ("red", "green")
receipt_path = base / f"pr362-resource-{phase}-r1.json"
log_path = base / f"pr362-resource-{phase}-r1.log"
assert not receipt_path.exists() and not log_path.exists(), "Preserve earlier evidence."
paths = [
    "tools/verify_pr362_staged_evidence.py",
    "docs/evidence/pr362-combined-20260921/verify_public.py",
    "tools/test_public_evidence_verifier.py",
    "tools/test_staged_evidence_driver.py",
]
hashes = lambda: {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in paths}
tests = [
    "tools.test_public_evidence_verifier.PublicEvidenceVerifierTests.test_packet_file_count_boundary_and_plus_one",
    "tools.test_public_evidence_verifier.PublicEvidenceVerifierTests.test_directory_entry_limit_is_streamed_before_payload",
    "tools.test_public_evidence_verifier.PublicEvidenceVerifierTests.test_packet_total_uses_all_actual_sizes_before_payload",
    "tools.test_public_evidence_verifier.PublicEvidenceVerifierTests.test_admitted_file_growth_cannot_expand_payload_read",
    "tools.test_staged_evidence_driver.StagedEvidenceDriver.test_duplicate_gate_cannot_replace_a_required_command",
    "tools.test_staged_evidence_driver.StagedEvidenceDriver.test_substituted_gate_name_program_and_arguments_are_rejected",
    "tools.test_staged_evidence_driver.StagedEvidenceDriver.test_missing_gate_command_metadata_is_rejected",
    "tools.test_staged_evidence_driver.StagedEvidenceDriver.test_staged_entry_limit_rejects_before_materialization",
    "tools.test_staged_evidence_driver.StagedEvidenceDriver.test_staged_total_bytes_rejects_before_materialization",
]
command = [sys.executable, "-X", "utf8", "-m", "unittest", "-v", *tests]
record = {"pr": 362, "phase": phase, "source_head": subprocess.check_output(
    ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip(),
    "started_at_utc": datetime.now(timezone.utc).isoformat(), "command": command,
    "input_sha256": hashes(), "driver_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
environment = dict(os.environ)
environment.pop("PYTHONOPTIMIZE", None)
environment["PYTHONDONTWRITEBYTECODE"] = "1"
with log_path.open("xb") as output:
    result = subprocess.run(command, cwd=repo, env=environment, stdout=output,
                            stderr=subprocess.STDOUT, timeout=240)
raw = log_path.read_bytes()
record.update(exit_code=result.returncode, log=str(log_path),
    log_sha256=hashlib.sha256(raw).hexdigest(), source_unchanged=hashes() == record["input_sha256"],
    finished_at_utc=datetime.now(timezone.utc).isoformat())
record["status"] = "observed_red" if phase == "red" and result.returncode != 0 else (
    "passed" if phase == "green" and result.returncode == 0 else "unexpected")
receipt_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(json.dumps(record, indent=2))
assert record["source_unchanged"] and record["status"] != "unexpected"
