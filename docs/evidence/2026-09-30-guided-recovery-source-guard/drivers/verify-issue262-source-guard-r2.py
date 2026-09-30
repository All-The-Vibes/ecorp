"""Native regression fixtures for fresh capture and publication source guards."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from issue262_source_guard_r2 import canonical_root, guard_identity, source_sha256, verify_source

EV = canonical_root(Path(__file__).absolute().parent)
RECEIPT = EV / "issue262-source-guard-r2.json"
assert not RECEIPT.exists(), "Preserve previous native guard verification"
fixture = Path(tempfile.mkdtemp(prefix="issue262-source-guard-", dir=EV)).absolute()
assert canonical_root(fixture).parent == EV
record = {"issue": 262, "pr": 389, "status": "running", "started_at_utc": datetime.now(timezone.utc).isoformat(),
          "owned_fixture": str(fixture), "guard": guard_identity(), "checks": [],
          "scope": "Fresh native NTFS fixtures at capture/publication boundaries; no historical metadata or continuous locking claim."}
source, hard = fixture / "source.txt", fixture / "hard.txt"
actual, alias = fixture / "actual", fixture / "alias"
large = fixture / "large.bin"


def check(name, operation, rejected):
    did_reject = False
    reason = None
    try:
        operation()
    except AssertionError as error:
        did_reject = True
        reason = str(error)
    passed = did_reject == rejected
    record["checks"].append({"name": name, "passed": passed, "rejected": did_reject, "reason": reason})
    assert passed, name


def both(name, path, root, digest, rejected):
    check(name + " at capture", lambda: source_sha256(path, root), rejected)
    relative = path.relative_to(root).as_posix()
    check(name + " at publication", lambda: verify_source([[relative, digest]], root), rejected)


def historical_predicate(path, root):
    # Exact former per-file admission expression, evaluated now in owned fixtures.
    # This is a retrospective diagnostic, not a replay of past physical metadata.
    return path.resolve().is_relative_to(root.resolve()) and path.is_file() and not path.is_symlink()


try:
    source.write_bytes(b"owned source fixture\n")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    both("canonical single-link file accepted", source, fixture, digest, False)
    os.link(source, hard)
    assert source.stat().st_nlink == hard.stat().st_nlink == 2
    assert historical_predicate(source, fixture)
    record["historical_predicate_hardlink_accepted"] = True
    both("hard-linked source rejected", source, fixture, digest, True)
    both("hard-link alias rejected", hard, fixture, digest, True)
    hard.unlink()
    both("single-link source accepted after owned alias removal", source, fixture, digest, False)
    actual.mkdir()
    child = actual / "child.txt"
    child.write_bytes(b"owned child fixture\n")
    child_digest = hashlib.sha256(child.read_bytes()).hexdigest()
    both("ordinary child accepted", child, fixture, child_digest, False)
    script = "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path '" + str(alias).replace("'", "''") + "' -Target '" + str(actual).replace("'", "''") + "' | Out-Null"
    result = subprocess.run([r"C:\Program Files\PowerShell\7\pwsh.exe", "-NoProfile", "-Command", script],
                            capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0 and alias.is_junction(), "Native junction prerequisite unavailable"
    assert alias.resolve() == actual.resolve() and historical_predicate(alias / "child.txt", fixture)
    record["historical_predicate_parent_junction_accepted"] = True
    both("file reached through parent junction rejected", alias / "child.txt", fixture, child_digest, True)
    both("aliased root rejected", alias / "child.txt", alias, child_digest, True)
    check("out-of-root file rejected at capture", lambda: source_sha256(source, actual), True)
    check("out-of-root file rejected at publication", lambda: verify_source([["../source.txt", digest]], actual), True)
    check("directory rejected at capture", lambda: source_sha256(actual, fixture), True)
    check("directory rejected at publication", lambda: verify_source([["actual", digest]], fixture), True)
    with large.open("xb") as stream:
        stream.truncate(9 * 1024 * 1024)
    large_digest = hashlib.sha256(large.read_bytes()).hexdigest()
    both("legitimate source larger than historical packet read limit accepted", large, fixture, large_digest, False)
    check("changed expected bytes rejected at publication", lambda: verify_source([["source.txt", "0" * 64]], fixture), True)
    original_digest = hashlib.file_digest
    def mutate_owned_file_after_read(stream, algorithm):
        value = original_digest(stream, algorithm)
        with source.open("ab") as out:
            out.write(b"owned mutation\n")
        return value
    try:
        hashlib.file_digest = mutate_owned_file_after_read
        check("native metadata change during read rejected", lambda: source_sha256(source, fixture), True)
    finally:
        hashlib.file_digest = original_digest
    assert guard_identity() == record["guard"]
    record.update(status="passed", passed=len(record["checks"]), failed=0, skipped=0)
except Exception as error:
    record.update(status="failed", failure=str(error), failed=1)
    raise
finally:
    if record["status"] == "passed":
        # Only known, owned entries; never recurse through a junction.
        assert canonical_root(fixture).parent == EV
        assert alias.is_junction() and alias.resolve() == actual.resolve() and actual.resolve().is_relative_to(fixture)
        alias.rmdir()
        assert not hard.exists()
        for path in (source, child, large):
            assert path.resolve().is_relative_to(fixture) and not path.is_symlink() and path.stat().st_nlink == 1
            path.unlink()
        actual.rmdir()
        fixture.rmdir()
    record["owned_fixture_removed"] = not fixture.exists()
    record["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
    with RECEIPT.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(record, indent=2) + "\n")
    print(json.dumps({k: record.get(k) for k in ("status", "passed", "failed", "skipped", "owned_fixture_removed", "failure")}))
