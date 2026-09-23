"""Verify current staged Git bytes, preserving the earlier committed-byte run."""
from pathlib import Path, PurePosixPath
from datetime import datetime, timezone
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import zipfile

base = Path(__file__).parent
repo = Path(r'<reviewed-worktree>')
fixture = base / 'pr362-exact-staged-bytes-r7'
receipt_path = base / 'pr362-exact-staged-bytes-r7.json'
log = base / 'pr362-exact-staged-bytes-r7.log'
assert not any(p.exists() for p in (fixture, receipt_path, log))
git = lambda *args: subprocess.check_output(['git', '-C', str(repo), *args])
tree = git('write-tree').decode().strip()
validation = json.loads((base/'pr362-validation-r7/validation.json').read_bytes())
assert validation['staged_tree'] == tree
assert not git('diff', '--name-only').strip()
report_name = 'docs/evidence/2026-09-21-pr362-gauntlet-remediation.md'
prefixes = ['tools/test_public_evidence_verifier.py', report_name] + [
    'docs/evidence/' + name for name in (
        'pr362-startup-20260921', 'pr362-regressions-20260921',
        'pr362-combined-20260921', 'pr362-gauntlet-20260921')]
names = git('ls-tree', '-r', '--name-only', tree, '--', *prefixes).decode().splitlines()
assert prefixes[0] in names and report_name in names
fixture.mkdir()
sha = lambda raw: hashlib.sha256(raw).hexdigest()
receipt = {'pr': 362, 'tested_staged_tree': tree,
           'source_head': git('rev-parse', 'HEAD').decode().strip(),
           'started_at_utc': datetime.now(timezone.utc).isoformat(), 'status': 'running',
           'scope': 'Sixteen verifier regressions on exact staged Git bytes; gauntlet archive/inventory hashes and published path checks. No native-stack rerun.',
           'fixture': str(fixture), 'files': []}
for name in names:
    target = fixture/name
    assert target.resolve().is_relative_to(fixture.resolve())
    raw = git('show', f'{tree}:{name}')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
    assert target.read_bytes() == raw
    receipt['files'].append({'path': name, 'git_blob_sha256': sha(raw),
                             'executed_sha256': sha(target.read_bytes())})
worktree_report = (repo/report_name).read_bytes()
git_report = (fixture/report_name).read_bytes()
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
           '-s', 'tools', '-p', 'test_public_evidence_verifier.py', '-v']
with log.open('wb') as output:
    result = subprocess.run(command, cwd=fixture, env=environment,
                            stdout=output, stderr=subprocess.STDOUT, timeout=240)
receipt['command'] = command
receipt['log'] = {'file': str(log), 'sha256': sha(log.read_bytes()), 'exit_code': result.returncode}
receipt_path.write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
assert result.returncode == 0, log.read_text(encoding='utf-8')
assert 'Ran 16 tests' in log.read_text(encoding='utf-8')
assert 'skipped=' not in log.read_text(encoding='utf-8')

gauntlet = fixture/'docs/evidence/pr362-gauntlet-20260921'
manifest = json.loads((gauntlet/'manifest.json').read_bytes())
archive_info = manifest['receipt_archive']
archive_bytes = (gauntlet/archive_info['path']).read_bytes()
assert sha(archive_bytes) == archive_info['sha256'] and len(archive_bytes) == archive_info['bytes']
home_pattern = re.compile(rb'(?i)[a-z]:(?:\\+|/)Users(?:\\+|/)[A-Za-z0-9._-]+')
def no_personal_path(name, raw):
    assert not home_pattern.search(raw), name

with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
    members = archive.namelist()
    assert len(members) == len(set(name.casefold() for name in members)) == archive_info['entries']
    assert archive.testzip() is None
    expected = {row['path'] for row in manifest['files'] if row.get('archive')}
    assert expected == set(members)
    for name in members:
        path = PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts and ':' not in name and '\\' not in name
        raw = archive.read(name)
        if not name.endswith(('.png', '.zip')):
            no_personal_path(name, raw)
    for row in manifest['files']:
        if row.get('archive'):
            assert row['archive'] == archive_info['path']
            raw = archive.read(row['path'])
        else:
            target = gauntlet/row['path']
            assert target.resolve().is_relative_to(gauntlet.resolve())
            raw = target.read_bytes()
        assert sha(raw) == row['sha256'] and len(raw) == row['bytes'], row['path']
    for capture in manifest['captures']:
        raw = archive.read(capture['raw_log'])
        assert sha(raw) == capture['sha256'], capture['name']
    for row in manifest['publication_correction']['changed_members']:
        raw = archive.read(row['path'])
        assert sha(raw) == row['published_sha256'] and len(raw) == row['published_bytes']
    receipt['gauntlet'] = {'archive_members': len(members), 'verified_file_rows': len(manifest['files']),
                           'verified_capture_logs': len(manifest['captures']),
                           'corrected_archive_members': len(manifest['publication_correction']['changed_members']),
                           'archive_sha256': sha(archive_bytes), 'manifest_git_sha256': sha((gauntlet/'manifest.json').read_bytes()),
                           'personal_path_scan': 'passed for public gauntlet metadata, report and archive text; screenshots unchanged'}
no_personal_path('gauntlet manifest', (gauntlet/'manifest.json').read_bytes())
no_personal_path('gauntlet report', git_report)
receipt['source_unchanged'] = (tree == git('write-tree').decode().strip() and
    all(sha((fixture/row['path']).read_bytes()) == row['executed_sha256'] for row in receipt['files']))
assert receipt['source_unchanged']
receipt.update(status='passed', finished_at_utc=datetime.now(timezone.utc).isoformat())
receipt_path.write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'status': receipt['status'], 'files': len(names), 'tree': tree,
                  'receipt': str(receipt_path), 'gauntlet': receipt['gauntlet']}))
