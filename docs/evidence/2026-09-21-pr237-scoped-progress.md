# PR237: reviewed correction progress, not final acceptance

This candidate is an incremental correction to remote head
`6e69bc543ef16d11ecf4baf5f2488a6a7b478100`, not a claim that the full PR is NICE.
It preserves the eight prior scoped fixes and their TDD history, adds the missing
source-binding dependencies to the attempt-path test fixture, and pins the
existing CI action references to the accepted target's immutable SHAs. It does
not start Factory, introduce another test platform, close #50, merge the PR or
waive human review.

## Current verification

- Eleven named Node suites: **209 passed, 0 failed, 1 skipped**. The skipped
  owned-stack startup/two-restart/database-drift lane was not executed.
- Real owned-inert-child identity fault checks: **37 passed**; child cleanup
  verified. These are not a native Factory/budget-recovery scenario.
- Current migration checker passed.
- Attempt-path test integration: the actual nine current failures became nine
  passes without accepting `ReferenceError`, weakening path assertions or
  replacing the driver's admission logic. The actual source-binding helpers now
  execute in the controlled fixture. The relevant three-suite run passed 83.
- CI pinning: two real contract failures became five passes; thirteen broader
  static CI checks passed. All 26 remote uses match accepted target
  `39632b957819012721c90902925d8fa7a9c7e873`; the immutable Rust action's explicit
  `1.98.1` input was checked. Jobs, permissions, options and cold-primary ordering
  were preserved.

Focused counts overlap; they are not additional unique coverage. The complete
current commands, ordered suite list, before/after input hashes and native
readback are in [the selected current packet](pr237-progress/manifest.json).
Original eight-fixer evidence remains in
[the historical packet](pr237-review-fixes/README.md).

## Source-identical baseline reuse

The recorded Rust and web input manifests still match this candidate. The
earlier formatter, workspace/all-target Clippy and approved frozen-feed web
build/lint passes are reused, not described as new runs. The later Windows
workspace qualification passed **555 tests, with 343 ignored**, using
`--test-threads=1`; it did not skip/filter additional tests. Original parallel
and setup failures (54, 9 and 1) remain retained, not retroactively passed.

The packet includes the original command results and logs plus the current
continuity check. A recorded base HEAD is lineage, not a substitute for the
tested working-tree hashes. No original unavailable native report was
reconstructed.

## Still open

- **PR237-B-004:** original four native runtime/source/executable/cleanup records
  remain unavailable. New source-binding code and its tests do not recreate them.
- **PR237-B-005:** current correction screenshots do not supply images for those
  original unprovided native runs.
- **EVID237-03:** current qualified evidence is provided, but the full review's
  outstanding evidence requirements await independent closure.
- The PR currently has merge conflicts and a changes-requested review. New-head
  hosted checks, fresh Copilot feedback, full Santa acceptance and required human
  gates are not claimed by this local report.

Any permission to publish this correction must come from two fresh independent
`SAFE_TO_PUBLISH` delta reviews under the deployed trusted policy. Those reviews
cannot stand in for full-PR NICE.

![Actual current local-log capture](assets/pr237-progress/local-verification.png)
