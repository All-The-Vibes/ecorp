# Native evidence path scanner

`node tools/check_evidence_personal_paths.mjs` checks the retained PR226 evidence
packets. Explicit directory arguments select other owned evidence roots. The
scanner reports file names without repeating personal path values. Discovery
matches the ASCII completion-packet prefix even when a native filename is not
Unicode; a matching name that cannot be represented in the JSON result is an
error, never a silently omitted packet or a lossy replacement name.

Use the repository-pinned Rust and Node toolchains plus CPython 3.12 or newer on
Windows or Linux. The `Evidence scanner` workflow provisions Python 3.12 and
executes the native tests on both hosts. Other hosts fail closed because this
launcher has no qualified immutable executable admission for them. There is no
fallback to a pathname-only launch. These platform requirements apply to this
evidence-check command and its tests.

## Native capability and trust boundary

Node 24's `spawnSync` accepts an executable pathname. An earlier digest check
cannot bind that pathname to the bytes eventually executed. The existing
cap-std 4.0.3 scanner adapter secures directory-relative evidence reads, but does
not expose a parent-side process-image admission API to Node. The small
stdlib-only Python adapter supplies that missing native operation:

Each wrapper instance forces a new Rust compilation into a unique linker output.
It records that output's digest, copies the completed bytes into a separate file
created exclusively for execution, and checks that file against the recorded
digest. This avoids the zero-filled code mapping observed when a cold Windows
test launched the linker output directly. The test executes the first launch;
it does not warm the executable or retry a failed launch.

- On Linux, copy the compiled image into a memfd, seal writes, growth, shrinkage
  and changes to the seals, then verify its digest. Execute that retained file
  descriptor with `os.execve`. Later source replacements cannot change the
  sealed image. A kernel lacking the required facilities rejects the launch.
- On Windows, retain the executable with read and execute access and only read
  sharing. Verify its digest, create the child suspended, and compare its actual
  mapped image with the retained executable handle using
  `NtQueryInformationProcess(ProcessImageFileMapping)`. Resume only after the
  identity matches. The handle remains open until exit. A private kill-on-close
  job owns the child, including if the outer Node timeout terminates Python.

`ProcessImageFileMapping` and `NtResumeProcess` are Windows native APIs rather
than stable Win32 contracts. The adapter rejects missing APIs, unsupported
information classes, failed ownership, image mismatches and resume failures.
The native tests exercise positive and negative mapping comparisons, actual
ancestor reparse retargeting before process creation and before resume, ordinary
writer handles, retained writable mappings and final-digest replacement attempts.

The compiler, recorded build digest, installed Python/Node toolchain, loaded
launcher source and runtime dependencies are trusted. This is filesystem
race protection at scanner launch; it is not protection against a compromised
toolchain, same-account process injection, arbitrary changes to trusted code,
or a hostile operating-system administrator. Python receives launcher source
already loaded by Node and runs with `-I -S`; the adapter needs no installed
third-party Python package. Scanner input and output retain their existing
limits and the parent timeout.

## Reproduction

```text
cargo test --locked -p crony-runner --bin crony-evidence-paths
node --test tools/check_evidence_personal_paths.test.mjs tools/check_evidence_native_build.test.mjs tools/check_evidence_launch.test.mjs
node tools/check_evidence_personal_paths.mjs
```

The tests create owned temporary fixtures and preserve failures. Windows uses a
malformed UTF-16 suffix and Unix uses a malformed byte suffix to verify packet
admission. Tiny real Rust executables test trusted execution versus a poison
executable that records whether it ran; they are separate from the production
scanner's content and capability-walking tests. The cached-artifact test also
replaces the executable at the Node-to-native launch boundary after Node's
final digest check.
