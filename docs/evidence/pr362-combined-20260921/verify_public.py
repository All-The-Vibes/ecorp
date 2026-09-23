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
# Absolute resource limits do not come from the untrusted evidence manifest.
# The delivered packets fit comfortably below these independent replay ceilings.
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_PACKET_FILES = 128  # Includes the packet's manifest.
MAX_PACKET_TOTAL_BYTES = 32 * 1024 * 1024  # Across all three packets, manifests included.
MAX_ARCHIVE_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_MEMBER_BYTES = 1024 * 1024
MAX_ARCHIVE_TOTAL_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 512


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
    info = canonical.lstat()
    assert stat.S_ISREG(info.st_mode), ('non-regular evidence entry', str(relative))
    assert info.st_nlink == 1, ('hard-linked evidence entry', str(relative))
    return canonical


def read_file(root, relative, *, max_bytes=MAX_FILE_BYTES):
    assert isinstance(max_bytes, int) and 0 <= max_bytes <= MAX_FILE_BYTES, 'invalid evidence byte limit'
    path = regular_file(root, relative)
    before = path.lstat()
    assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'evidence file changed before open'
    assert 0 <= before.st_size <= max_bytes, 'evidence file exceeds byte limit'
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        assert stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1 and (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) == (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns), 'evidence file changed before read'
        assert regular_file(root, relative) == path, 'evidence path changed before read'
        data = stream.read(max_bytes + 1)
        assert len(data) <= max_bytes, 'evidence file exceeds byte limit'
        after = os.fstat(stream.fileno())
        assert after.st_nlink == 1 and len(data) == opened.st_size and (after.st_size, after.st_mtime_ns) == (opened.st_size, opened.st_mtime_ns), 'evidence file changed during read'
        assert regular_file(root, relative) == path, 'evidence path changed during read'
        current = path.lstat()
        assert (current.st_dev, current.st_ino) == (opened.st_dev, opened.st_ino), 'evidence file replaced during read'
        return data

def safe(names):
    assert len(names) == len(set(n.casefold() for n in names)), 'duplicate archive path'
    for name in names:
        path = PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts
        assert '\\' not in name and ':' not in name

def checked_archive_members(archive):
    """Validate the entire central-directory budget before decompressing data."""
    members = archive.infolist()
    assert len(members) <= MAX_ARCHIVE_MEMBERS, 'archive exceeds member limit'
    safe([member.filename for member in members])
    compressed = expanded = 0
    for member in members:
        assert not member.is_dir(), 'archive directory is not evidence'
        assert 0 <= member.file_size <= MAX_ARCHIVE_MEMBER_BYTES, 'archive member exceeds byte limit'
        assert 0 <= member.compress_size <= MAX_ARCHIVE_BYTES, 'archive compressed size exceeds byte limit'
        compressed += member.compress_size
        expanded += member.file_size
        assert compressed <= MAX_ARCHIVE_BYTES, 'archive compressed size exceeds byte limit'
        assert expanded <= MAX_ARCHIVE_TOTAL_BYTES, 'archive expansion exceeds byte limit'
    return {member.filename: member for member in members}

def read_archive_member(archive, member):
    assert 0 <= member.file_size <= MAX_ARCHIVE_MEMBER_BYTES, 'archive member exceeds byte limit'
    with archive.open(member) as stream:
        data = stream.read(MAX_ARCHIVE_MEMBER_BYTES + 1)
    assert len(data) <= MAX_ARCHIVE_MEMBER_BYTES, 'archive member exceeds byte limit'
    assert len(data) == member.file_size, 'archive member size mismatch'
    # Reading to EOF also verifies CRC; avoid testzip's unbounded second pass.
    return data

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
    admitted_sizes = {}
    total_bytes = 0
    for name in PACKETS:
        directory = directory_root(base / name)
        assert directory.is_relative_to(base), 'packet escaped evidence root'
        manifest_data = read_file(directory, 'manifest.json')
        manifest = json.loads(manifest_data)
        assert isinstance(manifest['delivered_files'], list) and len(manifest['delivered_files']) < MAX_PACKET_FILES, 'packet manifest exceeds file limit'
        delivered = [filename(row['path']) for row in manifest['delivered_files']]
        assert len(delivered) == len(set(path.casefold() for path in delivered)), 'duplicate packet filename'
        assert 'manifest.json' not in delivered, 'manifest cannot hash itself'
        actual = set()
        sizes = {}
        # scandir streams entries; Path.iterdir may first allocate every name.
        # Admit every packet before hashing or decompressing any payload.
        with os.scandir(directory) as entries:
            for entry in entries:
                assert len(actual) < MAX_PACKET_FILES, 'packet directory exceeds file limit'
                path = regular_file(directory, entry.name)
                size = path.lstat().st_size
                limit = MAX_ARCHIVE_BYTES if entry.name.endswith('.zip') else MAX_FILE_BYTES
                assert 0 <= size <= limit, 'evidence file exceeds byte limit'
                total_bytes += size
                assert total_bytes <= MAX_PACKET_TOTAL_BYTES, 'evidence packets exceed total byte limit'
                sizes[entry.name] = size
                actual.add(entry.name)
        expected = set(delivered) | {'manifest.json'}
        assert actual == expected, (name, 'unmanifested/missing files')
        directories[name] = directory
        manifests[name] = manifest
        inventories[name] = expected
        admitted_sizes[name] = sizes
        text_check('manifest.json', manifest_data)

    def payload(packet, relative):
        # A later replacement or growth cannot increase the admitted byte budget.
        return read_file(directories[packet], relative, max_bytes=admitted_sizes[packet][relative])

    for name in PACKETS:
        directory = directories[name]
        manifest = manifests[name]
        for row in manifest['delivered_files']:
            data = payload(name, filename(row['path']))
            assert (H(data) == row['sha256'] and len(data) == row['bytes']) or ('canonical_lf_sha256' in row and H(data.replace(b'\r\n', b'\n')) == row['canonical_lf_sha256']), row['path']
            if not row['path'].endswith(('.png', '.zip')):
                text_check(row['path'], data)
        with zipfile.ZipFile(io.BytesIO(payload(name, 'receipts.zip'))) as archive:
            members = checked_archive_members(archive)
            rows = manifest['archive_members']
            assert isinstance(rows, list) and len(rows) <= MAX_ARCHIVE_MEMBERS, 'archive manifest exceeds member limit'
            safe([row['member'] for row in rows])
            assert set(members) == {row['member'] for row in rows}
            expanded = 0
            for row in rows:
                data = read_archive_member(archive, members[row['member']])
                expanded += len(data)
                assert expanded <= MAX_ARCHIVE_TOTAL_BYTES, 'archive expansion exceeds byte limit'
                assert H(data) == row['public_sha256'] and len(data) == row['public_bytes'], row['member']
                if row['representation'] == 'unchanged bytes':
                    assert row['public_sha256'] == row['raw_sha256']
                text_check(row['member'], data)
        for row in manifest['images']:
            image = filename(row['path'])
            assert image in inventories[name] and image.endswith('.png'), 'image absent from verified inventory'
            data = payload(name, image)
            assert data.startswith(b'\x89PNG\r\n\x1a\n')
            assert H(data) == row['public_sha256'] and len(data) == row['public_bytes']
            if not row['rectangles']:
                assert row['raw_sha256'] == row['public_sha256']
                assert row['raw_bytes'] == row['public_bytes']
        for link in re.findall(r'\]\(([^)]+)\)', payload(name, 'README.md').decode('utf-8-sig')):
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
        binding = json.loads(payload(PACKETS[-1], 'source-bindings.json'))
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
