# Portable source diff verification — issue #81

## Scope and native prior art

Baseline: `30ec3fab6acd566cc1fc1e574c8a6343d0ce0596`.
The existing `crony-runner/src/deliverable.rs` already builds exports through a
base-seeded temporary index, literal `add -A`, platform-specific executable-bit
handling, and resets of canonical in-worktree provider-artifact paths.
The missing part was a reusable **check** of that candidate rather than only the
unstaged tracked diff. No production runner, verifier protocol, admission, cache,
checkpoint or adapter behavior changed.

`tools/check_deliverable_diff.mjs` mirrors that selection and runs cached Git
whitespace/conflict-marker verification. Its [usage contract](../DELIVERABLE_DIFF_CHECK.md)
requires the same explicit base, selected paths, artifact list and optional
Windows preserved head. A native-recipe hash in the test detects selection drift:
`6f6ded948c846fa95c5fb8fe7b0c748e444c1f16800e72dfb42fb781090e4519`.

## Actual Windows results

Environment: Windows, Node `v26.7.0`, Git `2.55.0.windows.3`.
The editor test runner discovered no tests; the native Node fallback was used.

| Command | Actual outcome |
| --- | --- |
| `node --test --test-concurrency=1 tools/check_deliverable_diff.test.mjs` | 24 passed, 0 failed, 0 skipped |
| Targeted literal-path and late-error refinement checks | 2 passed, 0 failed |
| `node tools/check_migrations.mjs` | 41 migrations, latest 41, immutable checksums |
| `cargo fmt --check` | Passed using the existing Rust 1.94 toolchain; no compilation |
| New command against the owned checkout before staging | Passed and included untracked implementation, tests and documentation |
| Editor diagnostics for the two JavaScript files | No errors |

The 24 cases exercise real disposable Git repositories (under the owned checkout,
not the OS temporary directory), plus bounded failure injection. They cover:

- old false-pass reproduction followed by a failing new check and a clean control;
- tracked, staged, untracked, committed, deleted and renamed source;
- staged-only bad bytes replaced by clean physical bytes, and the inverse;
- a conflicted real index, both unresolved and physically resolved;
- spaces, Unicode, apostrophes, bracket literals, leading dashes, and path rejection;
- ignored evidence/internal files, explicit provider resets, missing/outside artifacts;
- ignored files tracked by the seeded revision versus ignored later additions;
- CRLF conversion, Git attributes, binary blobs and Windows executable-bit seeding;
- linked worktrees, an absent real index and an unrelated inherited alternate index;
- invalid revisions/routing, whole-check timeout, missing Git, signals, output
  overflow, late Git errors and preservation of unexpected cleanup contents.

Every normal fixture compares source-file SHA-256 values, real-index bytes,
HEAD and refs before/after the check. Full candidate-tree IDs are compared with
an independent replay of the native export recipe. This is stronger than merely
comparing filenames or asserting that whitespace was reported.

## Retained red/green proof

A separate, real-Git reproduction retained byte evidence outside the checkout:
`C:\Repos\ecorp\temp\evidence\issue81-deliverable-diff-20260918`.
It used clean tracked physical source, separate staged bytes, a CRLF untracked
deliverable, ignored provider/internal evidence, and a tracked provider artifact.

- Legacy `git diff --check`: exit **0**, despite the untracked whitespace.
- New command with the same export inputs: exit **1** before correction.
- New command after removing only the trailing space: exit **0**.
- Red candidate tree, equal to native replay:
  `087a1a1860eb78458edc5eb744ff43c19192d60a`.
- Green candidate tree, equal to native replay:
  `2168458d05969f125993f396e611d23a9804a978`.
- Real-index SHA-256 before and after the red check:
  `78902858751c7e10c74793ee34427ad2e9c2531ee47ff6577dcf91f68c133dd0`.
- Tested helper SHA-256:
  `2a38199223b4f7c31ce34cb436aed650014b971782d8ce88b107bb4666893726`.

`reproduction.json` records complete before/after source hashes, both command
results, native tree entries, exact inputs and cleanup. The red/green source
bytes and four index snapshots are retained alongside it. Final source
commit/tree/file hashes and the prepared PR body are retained in that same
issue-owned evidence folder. All disposable Git repositories and scratch
indexes were removed; no unexpected cleanup artifacts remained.

The initial test-development log is retained: 19 of 23 tests passed, with four
fixture/API-assumption failures (dash argument syntax, seeded-base ignore
semantics, and two uses of an unavailable mock-environment API). Those were
corrected explicitly, not skipped; the final suite contains 24 passing cases.

## Limits and unchanged gates

These results prove the command and export-selection equivalence, **not** a
live server/runner/browser run or accepted persisted mission. No provider, app,
database, Factory, remote publication or GitHub mutation was performed.
Existing verifier policies are not silently rewritten. Export's independent
write-scope, secret/internal-path, symlink/reparse-point and authorization checks
remain authoritative.

There are no Rust, web or dependency changes. Full Rust/Clippy and web build/lint
gates were not repeated for this command-only change under the assigned bounded
validation scope. The supplied baseline already records strict Clippy's
`retained_provider_receipt.rs:50` `nonminimal_bool` failure, three Windows symlink
privilege failures, and intermittent issue #190 runner timing failures; this
change neither fixes nor claims fresh passes for them. Linux/macOS execution
was not available in this Windows validation.

Issue #317 owns repository-wide Node discovery and CI/documentation-contract
changes. This issue adds a discoverable top-level `*.test.mjs` suite without
editing its package/workflow/marked-contract paths. Until that gate is enrolled,
run the explicit focused command above.
