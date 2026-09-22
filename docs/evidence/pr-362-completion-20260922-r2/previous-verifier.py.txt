"""Read-only PR362 public packet checks. Python 3 stdlib; no network or effects.
Run from any directory; optionally compare a local assembled checkout with --source.
Private originals and capture provenance are not independently recoverable here.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import zipfile

H = lambda data: hashlib.sha256(data).hexdigest()

def safe(names):
    assert len(names) == len(set(n.casefold() for n in names)), 'duplicate archive path'
    for name in names:
        path = PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts
        assert '\\' not in name and ':' not in name

def text_check(name, data):
    assert not re.search(rb'(?i)C:(?:\\+|/)Users(?:\\+|/)', data), name
    if name.endswith('.json'):
        json.loads(data.decode('utf-8-sig'))

def verify(base, source=None):
    checked = []
    for name in ('pr362-startup-20260921', 'pr362-regressions-20260921', 'pr362-combined-20260921'):
        directory = base / name
        manifest = json.loads((directory / 'manifest.json').read_bytes())
        actual = {p.name for p in directory.iterdir() if p.is_file()}
        expected = {row['path'] for row in manifest['delivered_files']} | {'manifest.json'}
        assert actual == expected, (name, 'unmanifested/missing files')
        for row in manifest['delivered_files']:
            data = (directory / row['path']).read_bytes()
            assert (H(data) == row['sha256'] and len(data) == row['bytes']) or ('canonical_lf_sha256' in row and H(data.replace(b'\r\n', b'\n')) == row['canonical_lf_sha256']), row['path']
            if not row['path'].endswith(('.png', '.zip')):
                text_check(row['path'], data)
        text_check('manifest.json', (directory / 'manifest.json').read_bytes())
        with zipfile.ZipFile(directory / 'receipts.zip') as archive:
            safe(archive.namelist())
            assert archive.testzip() is None
            assert set(archive.namelist()) == {r['member'] for r in manifest['archive_members']}
            for row in manifest['archive_members']:
                data = archive.read(row['member'])
                assert H(data) == row['public_sha256'] and len(data) == row['public_bytes'], row['member']
                if row['representation'] == 'unchanged bytes':
                    assert row['public_sha256'] == row['raw_sha256']
                text_check(row['member'], data)
        for row in manifest['images']:
            data = (directory / row['path']).read_bytes()
            assert data.startswith(b'\x89PNG\r\n\x1a\n')
            assert H(data) == row['public_sha256'] and len(data) == row['public_bytes']
            if not row['rectangles']:
                assert row['raw_sha256'] == row['public_sha256']
                assert row['raw_bytes'] == row['public_bytes']
        for link in re.findall(r'\]\(([^)]+)\)', (directory / 'README.md').read_text(encoding='utf-8-sig')):
            if '://' not in link:
                assert (directory / link.split('#')[0]).exists(), (name, link)
        checked.append({'package': name, 'archive_members': len(manifest['archive_members']), 'images': len(manifest['images'])})
    if source:
        binding = json.loads((base / 'pr362-combined-20260921/source-bindings.json').read_bytes())
        owned = tuple('docs/evidence/' + n + '/' for n in ('pr362-startup-20260921', 'pr362-regressions-20260921', 'pr362-combined-20260921'))
        entries = subprocess.check_output(['git', '-C', str(source), 'ls-files', '-s'], text=True).splitlines()
        index = {line.split('\t')[1]: line.split()[1] for line in entries if not line.split('\t')[1].startswith(owned)}
        assert index == {p: row['git_blob'] for p, row in binding['files'].items()}, 'source index drift'
        for path, row in binding['files'].items():
            data = (source / path).read_bytes()
            assert H(data) == row['working_sha256'] or H(data.replace(b'\r\n', b'\n')) == row['canonical_lf_sha256'], path
        checked.append({'source_files': len(index), 'result': 'index blobs and working bytes verified'})
    print(json.dumps({'result': 'PASS', 'checks': checked, 'limit': 'Public integrity, not independent raw/capture/acceptance proof'}, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    verify(Path(__file__).resolve().parent.parent, args.source)
