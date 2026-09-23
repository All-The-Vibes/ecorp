"""Launch the scanner whose compiled digest the trusted Node wrapper recorded.

Node 24 does not expose sealed memfds or Windows mapped-image admission. This
stdlib-only adapter uses those native facilities; it is not a sandbox. The
compiler, Python/Node installations, dependencies and loaded code are trusted.
"""

import hashlib
import os
import stat
import subprocess
import sys

MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024


class IntegrityError(Exception):
    pass


def check_file(file):
    info = os.fstat(file.fileno())
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_size > MAX_EXECUTABLE_BYTES
            or getattr(info, 'st_file_attributes', 0) & 0x400):
        raise IntegrityError('Native evidence scanner must be a private regular executable')


def check_digest(file, expected):
    file.seek(0)
    digest = hashlib.sha256()
    total = 0
    while chunk := file.read(1024 * 1024):
        total += len(chunk)
        if total > MAX_EXECUTABLE_BYTES:
            raise IntegrityError('Native evidence scanner exceeds executable byte limit')
        digest.update(chunk)
    if digest.hexdigest() != expected:
        raise IntegrityError('Native evidence scanner integrity changed after compilation')
    file.seek(0)


def sealed_linux_image(executable, expected):
    import fcntl

    source = os.open(executable, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    image = None
    try:
        with os.fdopen(source, 'rb') as file:
            check_file(file)
            image = os.memfd_create('ecorp-evidence-scanner', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
            total = 0
            while chunk := file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_EXECUTABLE_BYTES:
                    raise IntegrityError('Native evidence scanner exceeds executable byte limit')
                view = memoryview(chunk)
                while view:
                    view = view[os.write(image, view):]
        os.fchmod(image, 0o500)
        seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(image, fcntl.F_ADD_SEALS, seals)
        # Verify the immutable image, not the mutable source used to create it.
        with os.fdopen(os.dup(image), 'rb') as copy:
            check_digest(copy, expected)
        return image
    except BaseException:
        if image is not None:
            os.close(image)
        raise


def run_windows(executable, expected, after_verified=None, before_resume=None):
    import ctypes as c
    from ctypes import wintypes as w
    import msvcrt

    kernel = c.WinDLL('kernel32', use_last_error=True)
    native = c.WinDLL('ntdll')
    kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
    kernel.CreateFileW.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.CloseHandle.restype = w.BOOL
    kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
    kernel.SetInformationJobObject.restype = w.BOOL
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.AssignProcessToJobObject.restype = w.BOOL
    native.NtQueryInformationProcess.argtypes = [w.HANDLE, w.ULONG, c.c_void_p, w.ULONG, c.POINTER(w.ULONG)]
    native.NtQueryInformationProcess.restype = w.LONG
    native.NtResumeProcess.argtypes = [w.HANDLE]
    native.NtResumeProcess.restype = w.LONG

    class Limits(c.Structure):
        _fields_ = [('process_time', c.c_int64), ('job_time', c.c_int64),
                    ('flags', w.DWORD), ('minimum', c.c_size_t), ('maximum', c.c_size_t),
                    ('processes', w.DWORD), ('affinity', c.c_size_t),
                    ('priority', w.DWORD), ('scheduling', w.DWORD)]

    class ExtendedLimits(c.Structure):
        _fields_ = [('basic', Limits), ('io', c.c_uint64 * 6),
                    ('process_memory', c.c_size_t), ('job_memory', c.c_size_t),
                    ('peak_process_memory', c.c_size_t), ('peak_job_memory', c.c_size_t)]

    # GENERIC_READ | GENERIC_EXECUTE, FILE_SHARE_READ, OPEN_REPARSE_POINT.
    # Retaining this handle denies data writers and replacement. Ancestor
    # reparse changes are separately covered by mapped-image verification.
    handle = kernel.CreateFileW(executable, 0xa0000000, 1, None, 3, 0x00200000, None)
    if handle == c.c_void_p(-1).value:
        raise IntegrityError('Unable to retain the native evidence executable')
    try:
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except BaseException:
        kernel.CloseHandle(handle)
        raise
    with os.fdopen(descriptor, 'rb') as file:
        check_file(file)
        check_digest(file, expected)
        if after_verified is not None:
            after_verified()
        job = kernel.CreateJobObjectW(None, None)
        if not job:
            raise IntegrityError('Unable to own the native evidence process')
        process = None
        try:
            limits = ExtendedLimits()
            limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not kernel.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)):
                raise IntegrityError('Unable to constrain the native evidence process lifetime')
            process = subprocess.Popen([executable], stdin=sys.stdin.buffer,
                stdout=sys.stdout.buffer, stderr=sys.stderr.buffer,
                creationflags=0x4 | 0x08000000)  # CREATE_SUSPENDED | CREATE_NO_WINDOW
            process_handle = w.HANDLE(int(process._handle))  # Retained CPython Windows process handle.
            if not kernel.AssignProcessToJobObject(job, process_handle):
                raise IntegrityError('Unable to own the suspended native evidence process')
            # ProcessImageFileMapping (44) takes an input executable file handle.
            # Query the image already mapped into the suspended child; no child
            # user code runs before the match, including TLS initializers.
            mapped = w.HANDLE(handle)
            length = w.ULONG()
            status = native.NtQueryInformationProcess(process_handle, 44, c.byref(mapped),
                c.sizeof(mapped), c.byref(length))
            if status != 0:
                raise IntegrityError('Native evidence process mapped an unverified executable')
            if before_resume is not None:
                before_resume()
            if native.NtResumeProcess(process_handle) != 0:
                raise IntegrityError('Unable to resume the verified native evidence process')
            return process.wait(timeout=110)
        finally:
            # Never let an unverified suspended child escape on an error. The
            # non-inherited job also kills it if the Node timeout kills Python.
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait()
            kernel.CloseHandle(job)


def main():
    if (len(sys.argv) != 3 or not os.path.isabs(sys.argv[1])
            or len(sys.argv[2]) != 64 or any(c not in '0123456789abcdef' for c in sys.argv[2])):
        raise IntegrityError('Invalid verified evidence launch request')
    executable, expected = sys.argv[1:]
    if sys.platform == 'win32':
        return run_windows(executable, expected)
    if sys.platform == 'linux' and os.execve in os.supports_fd:
        image = sealed_linux_image(executable, expected)
        try:
            # Inherit the original request and output pipes. This replaces the
            # launcher process itself, and never resolves an executable pathname.
            os.execve(image, [executable], os.environ)
        finally:
            os.close(image)
    raise IntegrityError('Verified evidence launch requires Windows or Linux native support')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except IntegrityError as error:
        print(str(error), file=sys.stderr)
    except Exception:
        # Native errors may contain the executable's local user path.
        print('Unable to launch the verified native evidence scanner', file=sys.stderr)
    sys.exit(1)
