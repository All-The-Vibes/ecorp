"""Native adversarial checks for the verified-launch adapter; owned fixtures only."""

import hashlib
import importlib.util
import json
import mmap
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
launcher = Path(__file__).with_name('launch_verified_evidence.py')
spec = importlib.util.spec_from_file_location('verified_launch', launcher)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
suffix = '.exe' if sys.platform == 'win32' else ''
good = root / ('good' + suffix)
poison = root / ('poison' + suffix)
marker = root / 'unexpected-execution.txt'
os.environ['ECORP_LAUNCH_POISON_MARKER'] = str(marker)
checks = []


def record(name):
    assert not marker.exists(), 'unverified executable ran'
    checks.append(name)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def cli(path, expected):
    return subprocess.run([sys.executable, '-I', '-S', '-c', launcher.read_text(encoding='utf-8'),
        str(path), expected], input='{}', text=True, capture_output=True, timeout=20)


expected = digest(good)
result = cli(good, expected)
assert result.returncode == 0, result.stderr
assert json.loads(result.stdout) == {'files': ['trusted-image'], 'directories': []}
record('trusted image executes with inherited request/output pipes')
result = cli(poison, expected)
assert result.returncode != 0 and 'integrity changed' in result.stderr
record('digest mismatch rejects executable before its first instruction')
linked = root / ('hard-linked' + suffix)
os.link(good, linked)
try:
    result = cli(linked, expected)
    assert result.returncode != 0 and 'private regular executable' in result.stderr
    record('multiply linked executable rejected')
finally:
    linked.unlink()

if sys.platform == 'win32':
    import ctypes as c
    from ctypes import wintypes as w

    def fails(callback):
        try:
            callback()
        except module.IntegrityError:
            return
        raise AssertionError('expected refusal before executing the child')

    def write_blocked():
        try:
            with good.open('r+b') as writer:
                writer.write(b'bad')
        except PermissionError:
            return
        raise AssertionError('data writer escaped retained-handle fence')

    assert module.run_windows(str(good), expected, after_verified=write_blocked) == 0
    assert digest(good) == expected
    record('writer after final digest denied by retained read/execute handle')

    replacement = root / ('replacement' + suffix)
    shutil.copyfile(poison, replacement)

    def replace_blocked():
        try:
            os.replace(replacement, good)
        except PermissionError:
            return
        raise AssertionError('executable replacement escaped retained-handle fence')

    assert module.run_windows(str(good), expected, after_verified=replace_blocked) == 0
    record('replacement after final digest denied')
    # These cases require a writable image before launch. Use fresh verified
    # copies so an earlier execution's retained image cannot block fixture setup.
    writer = root / 'pre-existing-writer.exe'
    shutil.copyfile(good, writer)
    assert digest(writer) == expected
    with writer.open('r+b'):
        fails(lambda: module.run_windows(str(writer), expected))
    record('pre-existing data writer rejects launch')

    # Keeping a writable mapping after closing its source handle is a different
    # native case from an ordinary writer handle. The loader must refuse it.
    mapped_writer = root / 'pre-existing-mapping.exe'
    shutil.copyfile(good, mapped_writer)
    assert digest(mapped_writer) == expected
    with mapped_writer.open('r+b') as file:
        writer_map = mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_WRITE)
    try:
        fails(lambda: module.run_windows(str(mapped_writer), expected))
        record('pre-existing writable mapping rejects launch')
    finally:
        writer_map.close()

    original_popen = module.subprocess.Popen
    observed = []

    def redirected_popen(arguments, **kwargs):
        child = original_popen([str(poison)], **kwargs)
        observed.append(child)
        return child

    module.subprocess.Popen = redirected_popen
    try:
        fails(lambda: module.run_windows(str(good), expected))
        assert len(observed) == 1 and observed[0].poll() is not None
        record('wrong mapped image killed while suspended without running poison')
    finally:
        module.subprocess.Popen = original_popen

    # Real mount-point reparse updates exercise the pathname-to-image gap. The
    # executable handle remains open while an attribute-only directory handle
    # retargets the alias used by CreateProcess.
    kernel = c.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
    kernel.CreateFileW.restype = w.HANDLE
    kernel.DeviceIoControl.argtypes = [w.HANDLE, w.DWORD, c.c_void_p, w.DWORD,
        c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p]
    kernel.DeviceIoControl.restype = w.BOOL
    kernel.CloseHandle.argtypes = [w.HANDLE]
    original = root / 'original'
    alternate = root / 'alternate'
    alias = root / 'alias'
    for path in (original, alternate, alias):
        path.mkdir()
    name = 'scanner.exe'
    shutil.copyfile(good, original / name)
    shutil.copyfile(poison, alternate / name)
    handle = kernel.CreateFileW(str(alias), 0x180, 7, None, 3, 0x02200000, None)
    assert handle != c.c_void_p(-1).value
    returned = w.DWORD()

    def retarget(destination):
        import struct
        substitute = ('\\??\\' + str(destination)).encode('utf-16-le')
        printable = str(destination).encode('utf-16-le')
        paths = substitute + b'\0\0' + printable + b'\0\0'
        data = struct.pack('<IHHHHHH', 0xa0000003, len(paths) + 8, 0,
            0, len(substitute), len(substitute) + 2, len(printable)) + paths
        buffer = c.create_string_buffer(data)
        assert kernel.DeviceIoControl(handle, 0x900a4, buffer, len(data), None, 0,
            c.byref(returned), None), c.get_last_error()

    try:
        retarget(original)
        fails(lambda: module.run_windows(str(alias / name), expected,
            after_verified=lambda: retarget(alternate)))
        record('real ancestor reparse retarget before CreateProcess rejects wrong image')
        retarget(original)
        assert module.run_windows(str(alias / name), expected,
            before_resume=lambda: retarget(alternate)) == 0
        record('retarget after mapped-image verification executes the already verified image')
    finally:
        # Remove only the tag from the retained owned directory handle; never
        # traverse the alias to remove its target or any fixture data.
        import struct
        tag = c.create_string_buffer(struct.pack('<IHH', 0xa0000003, 0, 0))
        assert kernel.DeviceIoControl(handle, 0x900ac, tag, 8, None, 0, c.byref(returned), None)
        kernel.CloseHandle(handle)
else:
    assert sys.platform == 'linux', 'native launcher test needs a supported host'
    import fcntl
    image = module.sealed_linux_image(str(good), expected)
    try:
        seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        assert fcntl.fcntl(image, fcntl.F_GET_SEALS) & seals == seals
        for change in [lambda: os.write(image, b'bad'), lambda: os.ftruncate(image, 0),
                lambda: mmap.mmap(image, 0, access=mmap.ACCESS_WRITE)]:
            try:
                change()
            except OSError:
                continue
            raise AssertionError('sealed image was writable')
        record('sealed Linux image denies writes, truncation and writable mappings')
        retained = root / ('retained-original' + suffix)
        good.rename(retained)
        shutil.copyfile(poison, good)
        # Execute the retained descriptor directly, exactly as production does.
        read_fd, write_fd = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(read_fd)
            os.dup2(write_fd, 1)
            os.close(write_fd)
            os.execve(image, [str(good)], os.environ)
        os.close(write_fd)
        with os.fdopen(read_fd, 'rb') as pipe:
            output = pipe.read(4096)
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0
        assert json.loads(output) == {'files': ['trusted-image'], 'directories': []}
        record('source replacement after sealing cannot change descriptor-executed code')
    finally:
        os.close(image)

print(json.dumps({'status': 'passed', 'platform': sys.platform, 'checks': checks}))
