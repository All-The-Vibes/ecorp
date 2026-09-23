"""Verify PR362 staged evidence against a raw passing nine-gate receipt.

Run with --repository, --validation and a new --output-directory. This replaces
the immutable historical r5 recorded driver; it rejects optimized Python before
reading source, validating evidence, allocating a fixture or writing a receipt.
"""
import sys
if sys.flags.optimize:
    raise SystemExit('Evidence driver assertions must be enabled; remove -O/-OO and PYTHONOPTIMIZE.')
# The in-process verifier import must preserve the exact staged fixture too.
sys.dont_write_bytecode = True
import argparse
import importlib.util
from pathlib import Path, PurePosixPath
from datetime import datetime, timezone
import hashlib
import io
import json
import os
import re
import subprocess
import zipfile
from staged_evidence_inventory import require_regression_count, staged_blobs

EXPECTED_REGRESSIONS = 63

REQUIRED_GATES = {
    'migrations': ('node', ['tools/check_migrations.mjs']),
    'documentation': ('pnpm', ['check:docs']),
    'node-unit': ('pnpm', ['test:unit']),
    'steward': ('pnpm', ['test:steward']),
    'rust-format': ('cargo', ['fmt', '--check']),
    'rust-clippy': ('cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']),
    'rust-workspace': ('cargo', ['test', '--workspace']),
    'web-build': ('pnpm', ['build:web']),
    'web-lint': ('pnpm', ['lint:web']),
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repository', required=True, type=Path)
parser.add_argument('--validation', required=True, type=Path)
parser.add_argument('--output-directory', required=True, type=Path)
args = parser.parse_args()
# Reuse the reader shipped beside this vetted driver, never Python selected by
# --repository. Inspect lexical input ancestors before canonicalizing aliases.
reader_path = Path(__file__).resolve().parents[1] / 'docs/evidence/pr362-combined-20260921/verify_public.py'
spec = importlib.util.spec_from_file_location('local_public_packet_reader', reader_path)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def read_input(path):
    path = Path(path).absolute()
    root = verifier.directory_root(path.parent)
    return verifier.read_file(root, path.name)


repo = verifier.directory_root(args.repository)
validation_path = args.validation
base = args.output_directory.absolute()
assert not base.exists(), 'Preserve existing evidence output.'
fixture = base / 'fixture'
receipt_path = base / 'receipt.json'
log = base / 'regressions.log'

git = lambda *args: subprocess.check_output(['git', '-C', str(repo), *args])


def unchanged_worktree():
    result = subprocess.run(['git', '-C', str(repo), 'diff', '--quiet', '--exit-code'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    assert result.returncode in (0, 1), 'Unable to verify source worktree.'
    return result.returncode == 0


tree = git('write-tree').decode().strip()
validation_bytes = read_input(validation_path)
validation_root = verifier.directory_root(validation_path.absolute().parent)
validation = json.loads(validation_bytes.decode('utf-8-sig'))
assert validation['status'] == 'passed' and validation['source_unchanged'] is True, 'Nine passing gates are required.'
checks = validation['checks']
assert isinstance(checks, list) and len(checks) == 9 and all(
    isinstance(row, dict) and type(row.get('exit_code')) is int and row['exit_code'] == 0
    for row in checks), 'Nine passing gates are required.'
names = [row.get('name') for row in checks]
assert all(isinstance(name, str) for name in names) and len(set(names)) == 9 and set(names) == set(REQUIRED_GATES), 'Nine canonical unique gate commands are required.'
for row in checks:
    assert (row.get('program'), row.get('arguments')) == REQUIRED_GATES[row['name']], 'Nine canonical unique gate commands are required.'
    name = row.get('log')
    assert isinstance(name, str) and name, 'Gate logs must use receipt-relative paths.'
    path = PurePosixPath(name)
    # Admit the complete inventory lexically before any log lookup. Windows
    # drive-relative names, UNC paths and alternate streams are unsafe even
    # when this receipt is being replayed on another operating system.
    assert (name == path.as_posix() and path.parts and not path.is_absolute() and
            '..' not in path.parts and not re.search(r'[\\:<>"|?*\x00-\x1f\x7f]', name)), 'Gate logs must use receipt-relative paths.'
    for part in path.parts:
        assert (part.rstrip(' .') == part and not re.fullmatch(
            r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.IGNORECASE)), 'Gate logs must use receipt-relative paths.'
for row in validation['checks']:
    assert hashlib.sha256(verifier.read_file(validation_root, row['log'])).hexdigest() == row['sha256'], 'Gate log changed.'
assert validation['staged_tree'] == tree, 'Source differs from passing validation.'
assert unchanged_worktree(), 'Unstaged source changes are not validated.'
report_name = 'docs/evidence/2026-09-21-pr362-gauntlet-remediation.md'
prefixes = ['tools/test_public_evidence_verifier.py', 'tools/test_staged_evidence_driver.py',
            'tools/staged_evidence_inventory.py',
            'tools/verify_pr362_staged_evidence.py', report_name] + [
    'docs/evidence/' + name for name in (
        'pr362-startup-20260921', 'pr362-regressions-20260921',
        'pr362-combined-20260921', 'pr362-gauntlet-20260921')]
blobs = staged_blobs(repo, tree, prefixes, verifier.MAX_FILE_BYTES)
names = list(blobs)
assert all(name in names for name in prefixes[:5]), 'Required staged replay source or discovery file is missing.'
fixture.mkdir(parents=True)
sha = lambda raw: hashlib.sha256(raw).hexdigest()
receipt = {'pr': 362, 'tested_staged_tree': tree,
           'source_head': git('rev-parse', 'HEAD').decode().strip(),
           'started_at_utc': datetime.now(timezone.utc).isoformat(), 'status': 'running',
           'scope': 'Public-verifier and driver admission regressions on exact staged Git bytes; bounded gauntlet archive/inventory hashes and published path checks. No native-stack rerun.',
           'validation_sha256': hashlib.sha256(validation_bytes).hexdigest(),
           'fixture': str(fixture), 'files': []}
for name in names:
    target = fixture/name
    assert target.resolve().is_relative_to(fixture.resolve())
    oid, size = blobs[name]
    raw = git('cat-file', 'blob', oid)
    assert len(raw) == size, 'Staged evidence blob size changed.'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
    executed = verifier.read_file(fixture, name)
    assert executed == raw
    receipt['files'].append({'path': name, 'git_blob_sha256': sha(raw),
                             'executed_sha256': sha(executed)})
worktree_report = verifier.read_file(repo, report_name)
git_report = verifier.read_file(fixture, report_name)
receipt['report_representation'] = {
    'worktree_sha256': sha(worktree_report), 'git_blob_sha256': sha(git_report),
    'canonical_lf_sha256': sha(worktree_report.replace(b'\r\n', b'\n')),
    'git_matches_canonical_lf': worktree_report.replace(b'\r\n', b'\n') == git_report,
    'worktree_crlf_count': worktree_report.count(b'\r\n')}
assert receipt['report_representation']['git_matches_canonical_lf']

environment = dict(os.environ)
environment.pop('PYTHONOPTIMIZE', None)
environment['PYTHONDONTWRITEBYTECODE'] = '1'
command = [sys.executable, '-X', 'utf8', '-m', 'unittest', 'discover',
           '-s', 'tools', '-p', 'test_*evidence*.py', '-v']
with log.open('wb') as output:
    result = subprocess.run(command, cwd=fixture, env=environment,
                            stdout=output, stderr=subprocess.STDOUT, timeout=240)
receipt['command'] = command
regression_log = read_input(log)
regression_text = regression_log.decode('utf-8')
receipt['log'] = {'file': str(log), 'sha256': sha(regression_log), 'exit_code': result.returncode}
receipt_path.write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
assert result.returncode == 0, regression_text
require_regression_count(regression_text, EXPECTED_REGRESSIONS)
receipt['regression_count'] = EXPECTED_REGRESSIONS

gauntlet = fixture/'docs/evidence/pr362-gauntlet-20260921'
manifest_bytes = verifier.read_file(gauntlet, 'manifest.json')
manifest = json.loads(manifest_bytes)
archive_info = manifest['receipt_archive']
archive_bytes = verifier.read_file(gauntlet, archive_info['path'], max_bytes=verifier.MAX_ARCHIVE_BYTES)
assert sha(archive_bytes) == archive_info['sha256'] and len(archive_bytes) == archive_info['bytes']
home_pattern = re.compile(rb'(?i)[a-z]:(?:\\+|/)Users(?:\\+|/)[A-Za-z0-9._-]+')
def no_personal_path(name, raw):
    assert not home_pattern.search(raw), name

with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
    member_info = verifier.checked_archive_members(archive)
    members = list(member_info)
    assert len(members) == len(set(name.casefold() for name in members)) == archive_info['entries']
    payloads = {name: verifier.read_archive_member(archive, info) for name, info in member_info.items()}
    expected = {row['path'] for row in manifest['files'] if row.get('archive')}
    assert expected == set(members)
    for name in members:
        path = PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts and ':' not in name and '\\' not in name
        raw = payloads[name]
        if not name.endswith(('.png', '.zip')):
            no_personal_path(name, raw)
    for row in manifest['files']:
        if row.get('archive'):
            assert row['archive'] == archive_info['path']
            raw = payloads[row['path']]
        else:
            raw = verifier.read_file(gauntlet, row['path'])
        assert sha(raw) == row['sha256'] and len(raw) == row['bytes'], row['path']
    for capture in manifest['captures']:
        raw = payloads[capture['raw_log']]
        assert sha(raw) == capture['sha256'], capture['name']
    for row in manifest['publication_correction']['changed_members']:
        raw = payloads[row['path']]
        assert sha(raw) == row['published_sha256'] and len(raw) == row['published_bytes']
    receipt['gauntlet'] = {'archive_members': len(members), 'verified_file_rows': len(manifest['files']),
                           'verified_capture_logs': len(manifest['captures']),
                           'corrected_archive_members': len(manifest['publication_correction']['changed_members']),
                           'archive_sha256': sha(archive_bytes), 'manifest_git_sha256': sha(manifest_bytes),
                           'personal_path_scan': 'passed for public gauntlet metadata, report and archive text; screenshots unchanged'}
no_personal_path('gauntlet manifest', manifest_bytes)
no_personal_path('gauntlet report', git_report)
receipt['source_unchanged'] = (tree == git('write-tree').decode().strip() and
    unchanged_worktree() and
    all(sha(verifier.read_file(fixture, row['path'])) == row['executed_sha256'] for row in receipt['files']))
assert receipt['source_unchanged']
receipt.update(status='passed', finished_at_utc=datetime.now(timezone.utc).isoformat())
receipt_path.write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'status': receipt['status'], 'files': len(names), 'tree': tree,
                  'receipt': str(receipt_path), 'gauntlet': receipt['gauntlet']}))
