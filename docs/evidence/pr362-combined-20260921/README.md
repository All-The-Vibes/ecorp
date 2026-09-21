# PR362 combined validation and portable evidence — September 21, 2026

**Nine required commands exited zero on the unchanged assembled inputs.**
This is local validation and evidence packaging, not a commit, review approval,
NICE verdict, hosted CI result, provider run, or full-product acceptance.

## Exact inputs

- HEAD: `03b77bc6a7b402665e2dba7f6f1820f8fa8dbdd7`.
- Tested staged tree: `aaffa3925e35025181129ceec21880f46d19de6b`.
- Original input manifest SHA-256: `9a4bf154376e096a578094348a7810f390d1787fa397bc206a030caae8f88ab2`.
- Assembled source patch SHA-256: `110d468a06256f09216d06a0a94e1c020176268d8a6a77d7d21f923663326084`.
- Only the two owner-supplied test files differ from HEAD: the Rust nonce
  regression and strengthened real-TLS fixture test. Production code, assertions,
  timeouts, dependency pins, SDK and source patches were not changed in this resume.
- All 771 original indexed working files were rehashed before and after execution.
  Evidence-only public packaging subsequently changes the working files, not the index or tested
  source. `source-bindings.json` preserves the 765 non-owned index/source bindings.
- Startup/regression owner source bytes and combined checkout bytes have explicit
  raw and canonical-LF hashes in archived `integration/owner-source-mapping.json`.
  The startup owner's README has a separately documented checkout-CRLF mapping;
  original expected digests were not changed.

## Actual required-command matrix

The first six passes and web-build pass below are **retained pre-reboot runs**,
not new executions or replayed terminal images. Logs and exact argv/time/exit
records are in [receipts.zip](receipts.zip); the relevant member is named below.
`gate-matrix.json` selects the real passing runs and preserves both Rust failures.

| Gate | Exact command | Actual result | Screenshot |
|---|---|---|---|
| 01 | `node tools/check_migrations.mjs` | exit 0; 41 migrations | [01](01-migrations.png) |
| 02 | `pnpm check:docs` | exit 0; nine command declarations and SDK/CLI pins | [02](02-docs.png) |
| 03 | `pnpm test:unit` | exit 0; 1205 passed, 44 existing skips, 0 failed | [03](03-unit.png) |
| 04 | `pnpm test:steward` | exit 0; 227 passed, 0 failed/skipped | [04](04-steward.png) |
| 05 | `cargo fmt --check` | exit 0; actual empty log retained | [05](05-fmt.png) |
| 06 | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 | [06](06-clippy.png) |
| 07 | `cargo test --workspace` | exit 0; 573 passed, 343 existing ignored, 0 failed | [07](07-rust-native-os-temp.png) |
| 08 | `pnpm build:web` | exit 0; pre-reboot build and image, not rerun | [08](08-web-build.png) |
| 09 | `pnpm lint:web` | exit 0; actual resumed run | [09](09-web-lint.png) |

Original run members: `gates/results.json`, `gates/environment.json`, and
`gates/01-migrations.log` through `gates/08-web-build.log`. The failed original
`07-rust.log` is not the passing gate. Resumed lint/focused runs are under
`resume-after-reboot/gates/`; passing full Rust is under
`resume-after-reboot/gates-native-os-temp/`.

Focused actual commands, not additional unique tests:

- `cargo test --locked --offline -p crony-server secrets::tests -- --nocapture`:
  **7 passed, 0 failed, 130 filtered**; [image](10-secrets.png).
- Bundled Python, `-B -m unittest discover -s tools -p test_startup_validation_harness.py -v`:
  **5 passed**, including verified TLS 1.2; [image](11-python-harness.png).
- `cargo test --workspace --no-run`: native build-artifact qualification before
  target reuse, exit 0; **not a test pass**; [image](00-target-validation.png).

## Failure and interruption chain — all retained

1. Original full Rust failed (exit 101, runner 158 passed / 54 failed / 1 ignored)
   with TEMP inside the coordinator Git checkout and excessive paths. Raw log,
   diagnosis, and [failure image](07-rust.png) remain. Commands 01–06 and 08 passed.
2. Parent reported a host reboot on September 21 at **16:25:42 America/Chicago**.
   The original capture was waiting after completed command 08; command 09 and
   focused suites had no completed receipts. This timestamp is parent-provided,
   not an independently recovered OS reboot event. No old PID/HWND was reused.
3. First resumed full Rust used a new Git-external `C:\t362-r3` directory.
   Path/source-root failures cleared, but the runner had **210 passed / 2 failed /
   1 ignored**, exit 101. Both native connection fixtures failed to establish
   private-directory permissions. [Actual failure](07-rust-external-temp.png).
4. Read-only ACL inspection and the unchanged production ACL snippet on new,
   empty diagnostic directories isolated a TEMP-location permission difference:
   the drive-root location lacked the user's explicit FullControl grant. The
   native OS TEMP location includes it. The same snippet failed with
   `UnauthorizedAccessException` for both lexical and canonical drive-root paths,
   then succeeded for both native OS TEMP forms. Diagnostics are not product tests.
   Private account/SID/ACL dumps remain local; an explicitly labelled projection
   and their hashes are in `resume/native-os-temp-proof-public-source.json`.
5. The final unchanged full suite used a **45-character, newly owned OS TEMP
   subdirectory**, `<OWNED_OS_TEMP>`. Every ancestor was checked for `.git` and
   reparse points; native Git returned exit 128, not a repository. Both previously
   failing native fixtures and the full suite passed. No ACL on an existing path,
   process token, permission mode, assertion, timeout, source, or SDK was changed.

All runs retain build jobs **2**, Rust test threads **2**, offline Cargo,
profile debug=0/incremental=0, and process-scoped `core.longpaths=true`.
No global Git setting changed. The unique combined-only target remained exclusive
to this source root. Its 84 pre-resume executable hashes, dependency-root inspection,
original source hashes and native no-run qualification are retained. The focused
server build uses the same source-exclusive target with Cargo's own feature-specific
artifact identities, never an artifact from the historical baseline root.

The existing package draft also incorrectly added a footer to images labelled
byte-identical. The actual verifier failure is retained. Packaging now copies
unmasked originals verbatim; only explicit privacy-masked derivatives get a
footer. No original image or outcome was altered. A diagnostic setup KeyError
and an early capture refusal are not application-test failures or passes.

## Public packaging and reproduction

- [Startup owner evidence](../pr362-startup-20260921/README.md).
- [Retrospective regression evidence](../pr362-regressions-20260921/README.md).
- [Portable verifier](verify_public.py), [manifest](manifest.json),
  [gate matrix](gate-matrix.json), [source bindings](source-bindings.json).
- ZIP entries are explicit **public derivatives**, not raw receipts. Roots use
  role tokens; owner transcript identity headers and standalone local-user labels in archived tooling are explicitly redacted.
  Source IDs, assertions, outcomes, counts and old hash fields remain unchanged.
  Each manifest maps raw/public hashes, byte lengths and replacement counts.
  Root text files additionally bind canonical-LF hashes for Git checkout EOL
  portability; ZIP members and PNG bytes remain strictly byte-exact.
- Images with no masks are byte-identical native captures. Masked images declare
  exact rectangles and a disclosure footer. Verification checks unchanged pixels
  outside those rectangles. No saved log was rendered as a new execution image.
- Native Cua standard-daemon `launch_app`, `start_minimized:false` qualified new
  background consoles, with frame readback and exact-window captures. No
  foreground delivery, permission bypass, policy edit or old handle reuse.
- Raw originals, original capture programs, failed fixtures and build artifacts
  remain local. Archived redacted scripts preserve the actual program text but
  require replacing role tokens before reproduction; the verifier below is
  portable and needs only Python's standard library.

From this directory, verify public hashes, archives, JSON, image metadata and links:

```powershell
python -B verify_public.py
python -B verify_public.py --source <path-to-assembled-checkout>
```

The optional source check compares the recorded index blobs and working bytes.
Git checkout line-ending changes are accepted only if the canonical-LF SHA-256
still matches the recorded bytes; it does not permit semantic source drift.
The full local private/public replay additionally checks original bytes and masked
pixels; its script and inputs are retained in integration scratch. The portable
checker cannot independently recover unpublished raw originals or verify image
capture history; hashes alone are not proof of execution.

For a new test run, use this exact assembled source and a target exclusive to it.
Set `TEMP`, `TMP`, and `TMPDIR` to a short new directory under native OS TEMP,
verify no Git ancestor, retain the declared job/thread limits, and run the unchanged
commands above. Do not run the archived flawed first-attempt TEMP setup.

## Owned-resource cleanup

Both resumed capture shells exited naturally after their real screenshots were
acknowledged. Exact PID and command/path inspection found no remaining owned
validation processes. The parent-owned Cua daemon was left running. Failed
fixtures, raw originals and the exclusive target are deliberately retained for
review, not force-deleted. See archived `resume/cleanup.json`.

## Remaining boundaries

343 Rust ignored tests and 44 Node skips remain **not executed**, never passes.
This work does not run opt-in SQLx/provider/Factory lanes, shared ports, or a new
browser-to-server-to-runner acceptance flow. The startup owner packet is separate
source-bound evidence; component results are not expanded to full-PR acceptance.
New retrospective RED/GREEN runs do not recover original test-first chronology.
The requirements clarification is not approval. No staging was performed by this resumed worker. Parent owns final staging/commit/push,
author-side review, fresh independent reviewer pair, hosted checks and protected
approval gates. Earlier committed `03b77bc` evidence is untouched.
