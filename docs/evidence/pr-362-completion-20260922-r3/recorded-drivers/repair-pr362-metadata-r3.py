"""Preserve original evidence and publish explicitly distinguished path-normalized bytes."""
from pathlib import Path
import copy
import hashlib
import json
import re
import zipfile

private = Path(__file__).parent
repo = Path(r'<reviewed-worktree>')
sha = lambda data: hashlib.sha256(data).hexdigest()
originals = private / 'pr362-public-path-original-r3'
originals.mkdir(exist_ok=False)
home = re.compile(rb'''(?i)[A-Z]:(?:\\+|/)Users(?:\\+|/)[^\\/\s"'<>;]+''')
def normalize(raw):
    return home.sub(b'<original-user>', raw)

gauntlet = repo / 'docs/evidence/pr362-gauntlet-20260921'
report = repo / 'docs/evidence/2026-09-21-pr362-gauntlet-remediation.md'
manifest_path = gauntlet / 'manifest.json'
archive_path = gauntlet / 'receipts.zip'
raw_manifest = manifest_path.read_bytes()
raw_report = report.read_bytes()
raw_archive = archive_path.read_bytes()
for name, raw in [('manifest.json', raw_manifest), ('report.md', raw_report), ('receipts.zip', raw_archive)]:
    (originals / name).write_bytes(raw)
    assert (originals / name).read_bytes() == raw

manifest = json.loads(normalize(raw_manifest))
members = {}
changed = []
with zipfile.ZipFile(archive_path) as archive:
    assert archive.testzip() is None
    entries = [(copy.copy(info), archive.read(info.filename)) for info in archive.infolist()]
for info, raw in entries:
    assert not info.is_dir(), info.filename
    public = normalize(raw)
    members[info.filename] = (raw, public)
    if raw != public:
        if info.filename.endswith('.json'):
            json.loads(public)
        changed.append({'path': info.filename, 'original_sha256': sha(raw),
                        'published_sha256': sha(public), 'original_bytes': len(raw), 'published_bytes': len(public)})
with zipfile.ZipFile(archive_path, 'w') as archive:
    for info, raw in entries:
        archive.writestr(info, members[info.filename][1])
published_archive = archive_path.read_bytes()
format_note = 'ZIP containing path-normalized public text and unchanged binary entries; private originals are retained separately.'
for row in manifest['files']:
    if row.get('archive') == 'receipts.zip':
        raw, public = members[row['path']]
        assert row['sha256'].lower() == sha(raw) and row['bytes'] == len(raw), row['path']
        row.update(original_sha256=sha(raw), original_bytes=len(raw), sha256=sha(public), bytes=len(public))
    elif row['path'] == 'receipts.zip':
        assert row['sha256'].lower() == sha(raw_archive)
        row.update(original_sha256=sha(raw_archive), original_bytes=len(raw_archive),
                   sha256=sha(published_archive), bytes=len(published_archive), format=format_note)
    else:
        actual = (gauntlet / row['path']).read_bytes()
        assert sha(actual) == row['sha256'].lower() and len(actual) == row['bytes'], row['path']
for capture in manifest['captures']:
    raw, public = members[capture['raw_log']]
    assert capture['sha256'].lower() == sha(raw), capture['raw_log']
    capture.update(original_sha256=sha(raw), sha256=sha(public))
manifest['receipt_archive'].update(original_sha256=sha(raw_archive), original_bytes=len(raw_archive),
                                   sha256=sha(published_archive), bytes=len(published_archive), format=format_note)
manifest['publication_correction'] = {
    'date': '2026-09-22',
    'scope': 'Personal home prefixes in the newly added report, receipt metadata and archived text are replaced with <original-user>. Original log line endings and other bytes are preserved. Images are unchanged.',
    'original_manifest_sha256': sha(raw_manifest),
    'original_report_sha256': sha(raw_report),
    'original_archive_sha256': sha(raw_archive),
    'published_archive_sha256': sha(published_archive),
    'changed_members': changed,
    'historical_hashes': 'Hashes inside retained historical receipt payloads still bind original execution bytes. The files/captures inventory records original_sha256 and the actual published sha256 separately. This is no new execution or acceptance.'
}
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
note = ('\n\nSeptember 22, 2026 publication correction: the report and retained receipt text now use '
        '`<original-user>` for personal home prefixes. The public archive is a path-normalized copy; '
        'private original bytes are retained. The manifest records separate original and published '
        'hashes, and hashes inside historical receipt payloads continue to describe the original '
        'execution bytes. Screenshot bytes, recorded results and historical source bindings are unchanged.\n')
report.write_bytes(normalize(raw_report) + note.encode())
assert not home.search(manifest_path.read_bytes()) and not home.search(report.read_bytes())
with zipfile.ZipFile(archive_path) as archive:
    assert archive.testzip() is None
    for name, (_, public) in members.items():
        assert archive.read(name) == public and not home.search(public)

combined = repo / 'docs/evidence/pr362-combined-20260921'
combined_manifest = combined / 'manifest.json'
before = combined_manifest.read_bytes()
assert before == (private / 'pr362-containment-original-r3/manifest.json').read_bytes()
data = json.loads(before)
row = next(row for row in data['delivered_files'] if row['path'] == 'verify_public.py')
previous = copy.deepcopy(row)
verifier = (combined / 'verify_public.py').read_bytes()
row.update(sha256=sha(verifier), bytes=len(verifier),
           canonical_lf_sha256=sha(verifier.replace(b'\r\n', b'\n')),
           supersedes_verifier=previous,
           correction='September 22, 2026: reject directories, linked or reparse-point roots/ancestors/files, unsafe or duplicate manifest names, and image/README references outside verified inventories. Original verifier and manifest are retained privately; capture bytes remain unchanged.')
combined_manifest.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8', newline='\n')
receipt = {'changed_archive_members': len(changed), 'archive_members': len(members),
           'original_manifest_sha256': sha(raw_manifest), 'published_manifest_sha256': sha(manifest_path.read_bytes()),
           'original_report_sha256': sha(raw_report), 'published_report_sha256': sha(report.read_bytes()),
           'original_archive_sha256': sha(raw_archive), 'published_archive_sha256': sha(published_archive),
           'verifier_sha256': sha(verifier), 'original_combined_manifest_sha256': sha(before),
           'published_combined_manifest_sha256': sha(combined_manifest.read_bytes())}
(private / 'pr362-public-path-correction-r3.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt))
