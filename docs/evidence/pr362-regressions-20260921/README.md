> **PUBLIC REDACTED PACKAGE.** Machine/home/worktree prefixes and transcript identity headers use
> named tokens in archive text. Masked PNGs are explicit derivatives: path-only
> masks and a disclosure footer; source IDs, assertions, results and counts remain
> visible. Unmasked PNGs are byte-identical originals. Redacted bytes are NOT raw. `manifest.json` records each
> raw/public SHA-256 and each image rectangle. Untouched assembled owner copies and raw archive
> remain in the local integration scratch `owner-originals/pr362-regressions-20260921/`.
> Archive links below resolve to `receipts.zip`; the adjacent member path identifies
> the exact file. Historical manifest/receipt hash fields still refer to raw bytes;
> use the public manifest to verify the redacted members. This packaging adds no
> test run or reviewer verdict. The combined run is documented separately in
> [combined validation](../pr362-combined-20260921/README.md).

# PR 362 / F-362-B-02: NEW retrospective nonce and TLS regressions

September 21, 2026. **Local executable coverage added; parent integration and fresh
independent review remain pending. This is not NICE or original test-first history.**

## Scope and patch

- Parent: `03b77bc6a7b402665e2dba7f6f1820f8fa8dbdd7`.
- Historical baseline / target: `410eddfc8bfcfa874dae05555128d39a914f0456`.
- Branch: `codex/pr362-regression-20260921`.
- Worktree: `<REGRESSION_WORKTREE>`.
- Source patch: [source.patch](receipts.zip) (member `source.patch`), **35 insertions / 1 deletion**.
  Only the `#[cfg(test)]` portion of `crates/crony-server/src/secrets.rs` and
  `tools/test_startup_validation_harness.py` change. Everything else added is in
  this new evidence directory.
- No production behavior, API, dependency, lockfile, policy or historical evidence
  change. No commit or push. No shared service, provider or Factory execution.

`source-pins.json` binds the original Git blobs and tested bytes. Both historical
sources were materialized into a newly owned native worktree below this worktree's
`output/pr362-regressions/baseline`; only test overlays were applied there.
`baseline-test-only.patch` and `candidate-test-only.patch` preserve those overlays.
The non-test Rust prefix and the entire Python fixture helper match their exact
historical revisions, allowing for checkout line endings. Final verification
rechecks that invariant and both worktrees' complete tracked change sets.

## What the tests establish

### Nonce fixed-field regression

The new Rust test calls the real `SecretCipher::encrypt` 32 times. It checks nonce
length and independently requires an observed escape from each historical field:
the high four bits of octet 6 being `0100` and the high two bits of octet 8 being
`10` (the supplied RFC 9562 UUIDv4/variant research lead).

The historical first-12-bytes-of-UUIDv4 implementation **necessarily fails** this
particular assertion: both flags remain false. The corrected AEAD/OS-RNG source
passes in the recorded runs. No RNG mock, production seam or source-string-only
runtime claim is involved.

**Coverage limit:** this is not full entropy-distribution, unpredictability,
independence, collision-resistance or CSPRNG certification. Under an assumption
of independent uniform draws, a correct implementation still has nonzero
false-failure probability `2^-128 + 2^-64 - 2^-192` for these 32 samples.
That assumption is not proven by this test. A different defective generator that
escapes those two fixed fields could pass. Existing freshness/authentication tests
remain in the affected suite; they also are not entropy certification.

### Explicit TLS minimum

The existing real-fixture/verified-TLS-1.2 handshake test is strengthened rather
than replaced with a source-text check. Its scoped constructor creates a **real**
`ssl.SSLContext(PROTOCOL_TLS_SERVER)` with a stricter starting minimum, TLS 1.3.
Only the helper module's `ssl` lookup is temporarily replaced by a small test
namespace; the global `ssl.SSLContext` class, its descriptors, socket wrapping,
certificate verification and OpenSSL semantics remain real.

The historical helper leaves the context at TLS 1.3 and fails the actual
`server.socket.context.minimum_version == TLSv1_2` assertion. The corrected helper
sets the explicit minimum, passes that assertion, then completes a certificate-
verified TLS-1.2-only connection and returns HTTP 200. There is no global mock
causing `TypeError`, no disabled verification, and no system/global TLS weakening.

**Coverage limit:** this proves the explicit fixture minimum independently of
host defaults, not that the historical host accepted obsolete TLS. The observed
unmodified host default was already TLS 1.2. It is not production TLS endpoint
acceptance or the full startup regression.

The historical helper lacks the later OpenSSL locator used for certificate
setup. `replay_tls_baseline.py` adapts **only** that setup call to the baseline's
existing `command` function and the already installed OpenSSL executable.
The helper file, `http_fixture`, the runtime SSL context, and the identical
overlaid TLS test bytes remain unchanged. The baseline fails at the intended
minimum-version assertion, not import, certificate, compile or mock setup.

## Actual results and native screenshots

Each row links full stdout/stderr; its adjacent JSON contains the exact argv,
working directory, source hashes, head, start/end UTC and native exit code.
All screenshots were opened and visually inspected.

| Invocation | Actual result | Receipt | Native screenshot |
|---|---|---|---|
| Historical nonce | RED: exit 101; 1 assertion failure; both UUID flags false | [log](receipts.zip) (member `runs/01-nonce-red.log`), [JSON](receipts.zip) (member `runs/01-nonce-red.json`) | [image](01-nonce-red.png) |
| First candidate nonce attempt | **INVALID candidate evidence**: exit 101; stale baseline executable reused | [log](receipts.zip) (member `runs/02-nonce-green.log`), [JSON](receipts.zip) (member `runs/02-nonce-green.json`) | [retained failure](02-nonce-green-stale-binary-failure.png) |
| Historical TLS helper | RED: exit 1; 1 failure, TLS 1.3 minimum differs from required TLS 1.2 | [log](receipts.zip) (member `runs/03-tls-red.log`), [JSON](receipts.zip) (member `runs/03-tls-red.json`) | [image](03-tls-red.png) |
| Corrected TLS helper | GREEN: exit 0; 1 passed, including verified TLS 1.2 connection | [log](receipts.zip) (member `runs/04-tls-green.log`), [JSON](receipts.zip) (member `runs/04-tls-green.json`) | [image](04-tls-green.png) |
| Fresh candidate-only nonce build | GREEN: exit 0; 1 passed | [log](receipts.zip) (member `retry-runs/02-nonce-green.log`), [JSON](receipts.zip) (member `retry-runs/02-nonce-green.json`) | [image](02-nonce-green-fresh-target.png) |
| Affected Rust secret suite | Exit 0; **7 passed**, 0 failed, 0 ignored; 130 other tests filtered | [log](receipts.zip) (member `retry-runs/05-secrets-suite.log`), [JSON](receipts.zip) (member `retry-runs/05-secrets-suite.json`) | [image](05-secrets-suite.png) |
| Python harness suite | Exit 0; **5 passed**, 0 failed | [log](receipts.zip) (member `retry-runs/06-harness-suite.log`), [JSON](receipts.zip) (member `retry-runs/06-harness-suite.json`) | [image](06-harness-suite.png) |

The passing suites include the targeted tests again; these are not additional
unique test cases. The Python ownership cases use their existing mocks and start
no Docker container. Only the TLS case opens its disposable loopback fixture.
`cargo fmt --check` and `git diff --check` also passed as supporting checks, not
as a substitute for the parent's nine integration gates.

## Retained failed attempt and corrected execution

The initial capture script shared one owned Cargo target across the two source
roots. Cargo's first candidate invocation performed no compilation and reused
the baseline test executable. Its SHA-256 exactly matches the saved baseline
binary; its result also retains the old assertion line and 135 filtered tests.
See `stale-candidate-attempt.json` and `stale-candidate-dep-info.d.txt`.
The exit was a real execution failure, but **not execution of the candidate source**
and not a second security RED. The misleading intended case name is retained
alongside the actual exit and this explicit invalidation.

No test or product logic was changed to make it pass. The retry used a new
candidate-only target, compiled the native candidate crate and dependencies, and
produced a different executable SHA-256. Both binaries and both build targets are
preserved under the owned `output/pr362-regressions` directory, with binary hashes
recorded here. Subsequent candidate Rust commands used only that new target.

`capture-tests.ps1` is the exact first-attempt script, including its target-sharing
mistake. It was stopped only at the completed TLS capture wait; its two remaining
suite commands were not run. `capture-tests-retry.ps1` records the actual replacement
nonce and suite invocations. **Do not reuse a target across historical source roots.**

## Reproduction and capture provenance

`prepare.py` records the exact native-worktree/test-overlay preparation and refuses
to overwrite an earlier baseline. Its stdout/stderr are in `prepare.log`.
Both capture scripts refuse existing receipt directories. On a fresh equivalent
checkout, run the source-pinned tests using distinct absolute Cargo targets:

```powershell
$env:CARGO_BUILD_JOBS = '2'
$env:CARGO_NET_OFFLINE = 'true'
$env:CARGO_TARGET_DIR = '<new absolute target for this source root only>'
cargo test -p crony-server --locked --offline secrets::tests::nonces_are_not_constrained_to_uuid_v4_fixed_bits -- --exact --nocapture --test-threads=1
cargo test -p crony-server --locked --offline secrets::tests -- --nocapture --test-threads=1
$python = '<HOME>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $python -B -m unittest discover -s tools -p test_startup_validation_harness.py -v
```

The exact Windows Python and OpenSSL paths are in the per-run JSON; the baseline
TLS replay uses the certificate-setup-only adapter described above. Parent CI
discovery already includes the existing Rust unit and Python harness mechanisms.
No new dependency or application test framework was introduced.

Environment: native Windows 11 x64, Rust/Cargo 1.98.1, Python 3.12.14, Python's
OpenSSL 3.5.8; see `environment.json`. Cached Cargo dependencies were used offline
with the unchanged lockfile and two build jobs. Temporary files, worktrees,
targets and raw output all remain inside the owned root.

Cua's qualified background route launched native console/PowerShell test
processes without activation and captured their exact owned HWNDs through
`get_window_state`. Each displayed test result came from that invocation's live
stdout/stderr pipeline, never re-rendered from a saved log or a report. `cua-*.json`
retains launch, binding, frame readback and capture metadata. The qualification
image is labeled separately and is not a test-result receipt. No foreground or
desktop fallback was used. Both owned capture shells were closed after their
commands/captures; `cleanup.json` verifies their absence. Worktrees, failed
attempts, binaries, targets and logs were preserved.

## Remaining acceptance boundaries

- This work addresses the missing effective executable regression coverage in
  F-362-B-02, subject to independent review of these tests and receipts.
- `setup-notes.md` and `original-author-records` retain the bounded search in the
  known author worktree. The old E0063 compile failure is not RED. **Full-original
  test-first history was not recovered and remains unavailable.** New September 21
  retrospective runs cannot repair that history or override reviewer A's T21
  chronology concern. The parent/policy owner must decide its applicability.
- The separate startup-capture worker owns F-362-B-01; nothing here modifies or
  claims acceptance for that work. Earlier proxy/gateway/MCP screenshot or other
  full-PR gaps are not resolved by these images.
- Parent must integrate the two test-file changes and this new evidence folder,
  run all nine gates on the combined source, and obtain fresh independent dual
  review before committing/publishing. No reviewer approval, protected review,
  hosted CI, full-stack acceptance, merge readiness or NICE is asserted here.
