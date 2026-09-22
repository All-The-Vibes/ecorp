"""Read-only PR362 public packet checks. Python 3 stdlib; no network or effects.
Run from any directory; optionally compare a local assembled checkout with --source.
Private originals and capture provenance are not independently recoverable here.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import zipfile

if not __debug__:
    raise SystemExit('Evidence verifier assertions must be enabled; remove -O/-OO and PYTHONOPTIMIZE.')

H = lambda data: hashlib.sha256(data).hexdigest()
PACKETS = ('pr362-startup-20260921', 'pr362-regressions-20260921', 'pr362-combined-20260921')


def unlinked_path(path):
    """Inspect lexical ancestors before resolving; resolving first hides aliases."""
    path = Path(path)
    assert '..' not in path.parts, 'unsafe evidence ancestor traversal'
    absolute = path.absolute()
    for item in (*reversed(absolute.parents), absolute):
        info = item.lstat()
        assert not (stat.S_ISLNK(info.st_mode) or
                    getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)), ('linked evidence path', str(item))
        if item != absolute:
            assert stat.S_ISDIR(info.st_mode), ('non-directory evidence ancestor', str(item))
    return absolute.resolve(strict=True)


def directory_root(path):
    canonical = unlinked_path(path)
    assert stat.S_ISDIR(canonical.lstat().st_mode), ('non-directory evidence root', str(path))
    return canonical


def filename(name):
    assert isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name), ('unsafe packet filename', name)
    return name


def regular_file(root, relative):
    canonical = unlinked_path(root / relative)
    assert canonical.is_relative_to(root), ('evidence path escaped root', str(relative))
    assert stat.S_ISREG(canonical.lstat().st_mode), ('non-regular evidence entry', str(relative))
    return canonical


def read_file(root, relative):
    path = regular_file(root, relative)
    before = path.lstat()
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        assert stat.S_ISREG(opened.st_mode) and (opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), 'evidence file changed before read'
        assert regular_file(root, relative) == path, 'evidence path changed before read'
        return stream.read()

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
    base = directory_root(base)
    checked = []
    manifests = {}
    inventories = {}
    directories = {}
    for name in PACKETS:
        directory = directory_root(base / name)
        assert directory.is_relative_to(base), 'packet escaped evidence root'
        manifest_data = read_file(directory, 'manifest.json')
        manifest = json.loads(manifest_data)
        delivered = [filename(row['path']) for row in manifest['delivered_files']]
        assert len(delivered) == len(set(path.casefold() for path in delivered)), 'duplicate packet filename'
        assert 'manifest.json' not in delivered, 'manifest cannot hash itself'
        actual = set()
        for entry in directory.iterdir():
            regular_file(directory, entry.name)
            actual.add(entry.name)
        expected = set(delivered) | {'manifest.json'}
        assert actual == expected, (name, 'unmanifested/missing files')
        directories[name] = directory
        manifests[name] = manifest
        inventories[name] = expected
        text_check('manifest.json', manifest_data)
    for name in PACKETS:
        directory = directories[name]
        manifest = manifests[name]
        for row in manifest['delivered_files']:
            data = read_file(directory, filename(row['path']))
            assert (H(data) == row['sha256'] and len(data) == row['bytes']) or ('canonical_lf_sha256' in row and H(data.replace(b'\r\n', b'\n')) == row['canonical_lf_sha256']), row['path']
            if not row['path'].endswith(('.png', '.zip')):
                text_check(row['path'], data)
        with zipfile.ZipFile(io.BytesIO(read_file(directory, 'receipts.zip'))) as archive:
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
            image = filename(row['path'])
            assert image in inventories[name] and image.endswith('.png'), 'image absent from verified inventory'
            data = read_file(directory, image)
            assert data.startswith(b'\x89PNG\r\n\x1a\n')
            assert H(data) == row['public_sha256'] and len(data) == row['public_bytes']
            if not row['rectangles']:
                assert row['raw_sha256'] == row['public_sha256']
                assert row['raw_bytes'] == row['public_bytes']
        for link in re.findall(r'\]\(([^)]+)\)', read_file(directory, 'README.md').decode('utf-8-sig')):
            if '://' not in link:
                local = link.split('#')[0]
                if not local:
                    continue
                parts = PurePosixPath(local).parts
                if len(parts) == 3 and parts[0] == '..' and parts[1] in PACKETS:
                    target_packet, target_name = parts[1], parts[2]
                else:
                    assert len(parts) == 1 and '..' not in parts and ':' not in local and '\\' not in local, ('unsafe README evidence link', link)
                    target_packet, target_name = name, local
                filename(target_name)
                assert target_name in inventories[target_packet], ('unverified README evidence link', link)
                regular_file(directories[target_packet], target_name)
        checked.append({'package': name, 'archive_members': len(manifest['archive_members']), 'images': len(manifest['images'])})
    if source:
        source = directory_root(source)
        binding = json.loads(read_file(directories[PACKETS[-1]], 'source-bindings.json'))
        owned = tuple('docs/evidence/' + n + '/' for n in ('pr362-startup-20260921', 'pr362-regressions-20260921', 'pr362-combined-20260921'))
        entries = subprocess.check_output(['git', '-C', str(source), 'ls-files', '-s'], text=True).splitlines()
        index = {line.split('\t')[1]: line.split()[1] for line in entries if not line.split('\t')[1].startswith(owned)}
        assert index == {p: row['git_blob'] for p, row in binding['files'].items()}, 'source index drift'
        safe(list(binding['files']))
        for path, row in binding['files'].items():
            data = read_file(source, path)
            assert H(data) == row['working_sha256'] or H(data.replace(b'\r\n', b'\n')) == row['canonical_lf_sha256'], path
        checked.append({'source_files': len(index), 'result': 'index blobs and working bytes verified'})
    print(json.dumps({'result': 'PASS', 'checks': checked, 'limit': 'Public integrity, not independent raw/capture/acceptance proof'}, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    verify(Path(__file__).absolute().parent.parent, args.source)
