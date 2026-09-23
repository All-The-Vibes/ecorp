"""Bound immutable Git evidence inventories before allocating replay fixtures."""
from pathlib import PurePosixPath
import re
import subprocess

if not __debug__:
    raise SystemExit('Evidence inventory assertions must be enabled; remove -O/-OO and PYTHONOPTIMIZE.')

MAX_STAGED_ENTRIES = 1024
MAX_STAGED_PATH_BYTES = 1024
MAX_STAGED_TOTAL_BYTES = 64 * 1024 * 1024
MAX_TREE_RECORD_BYTES = MAX_STAGED_PATH_BYTES + 128


def staged_blobs(repo, tree, prefixes, file_limit):
    """Stream NUL records with sizes; reject the entire inventory before reads."""
    process = subprocess.Popen(
        ['git', '-C', str(repo), 'ls-tree', '-r', '-l', '-z', tree, '--', *prefixes],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    blobs = {}
    files = set()
    directories = set()
    pending = b''
    total_bytes = 0
    try:
        while chunk := process.stdout.read1(4096):
            pending += chunk
            while b'\0' in pending:
                record, pending = pending.split(b'\0', 1)
                assert len(record) <= MAX_TREE_RECORD_BYTES, 'Staged evidence record exceeds byte limit.'
                assert len(blobs) < MAX_STAGED_ENTRIES, 'Staged evidence exceeds entry limit.'
                metadata, raw_name = record.split(b'\t', 1)
                mode, kind, oid, raw_size = metadata.decode('ascii').split()
                assert mode in ('100644', '100755') and kind == 'blob', 'Staged evidence must be regular files.'
                assert re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', oid), 'Invalid staged evidence object.'
                assert 0 < len(raw_name) <= MAX_STAGED_PATH_BYTES, 'Staged evidence path exceeds byte limit.'
                name = raw_name.decode('utf-8')
                path = PurePosixPath(name)
                assert (name == path.as_posix() and not path.is_absolute() and
                        '..' not in path.parts and not re.search(r'[\\:<>"|?*\x00-\x1f\x7f]', name)), 'Unsafe staged evidence path.'
                for part in path.parts:
                    assert (part.rstrip(' .') == part and not re.fullmatch(
                        r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.IGNORECASE)), 'Unsafe staged evidence path.'
                key = name.casefold()
                parents = {parent.as_posix().casefold() for parent in path.parents if parent != PurePosixPath('.')}
                assert key not in files and key not in directories and not (parents & files), 'Colliding staged evidence path.'
                size = int(raw_size)
                assert 0 <= size <= file_limit, 'Staged evidence blob exceeds byte limit.'
                total_bytes += size
                assert total_bytes <= MAX_STAGED_TOTAL_BYTES, 'Staged evidence exceeds total byte limit.'
                blobs[name] = (oid, size)
                files.add(key)
                directories.update(parents)
            assert len(pending) <= MAX_TREE_RECORD_BYTES, 'Staged evidence record exceeds byte limit.'
        assert not pending, 'Incomplete staged evidence inventory.'
        assert process.wait(timeout=30) == 0, 'Git staged evidence inventory failed.'
        return blobs
    finally:
        # Retain and stop only the exact child created by this inventory call.
        if process.poll() is None:
            process.kill()
            process.wait(timeout=30)
        process.stdout.close()
