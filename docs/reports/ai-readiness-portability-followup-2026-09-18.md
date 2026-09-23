# Readiness follow-up: GitHub controls and checkpoint-test portability

This is a scoped follow-up to [draft PR #323](https://github.com/All-The-Vibes/ecorp/pull/323),
based on published head `6119296d475e94a45b643534a3a0bbd581b130f2`. It is a partial
contribution to #317, not a completed autonomous remediation system or a new benchmark.

## Approved GitHub settings applied

After the user approved the exact preview, native GitHub API readback confirmed the
following on September 18, 2026 (main-protection updated at `2026-09-18T05:42:15.733Z`):

- Secret scanning and push protection enabled.
- Vulnerability alerts enabled (GET returned HTTP 204).
- Dependabot security updates enabled, not paused.
- Ruleset `23565201` (`main-protection`) requires the existing GitHub Actions
  app's checks: `quality`, `integration`, `runner-platforms (ubuntu-latest)`,
  `runner-platforms (windows-latest)`, `runner-platforms (macos-latest)` and
  `desktop-windows`. Branches must be up to date.
- Code-owner review, stale-review dismissal, last-push approval and review-thread
  resolution enabled. The existing one-approval count and required `ecorp-team`
  review remain; no bypass was added. CODEOWNERS routing added by #323 becomes
  main's routing policy only after its reviewed merge.

The live ruleset was compared against every approved payload field. The other
three rulesets, default-branch restrictions, native CodeQL setup and thresholds
were preserved. CodeQL remains weekly with Actions, JavaScript/TypeScript, Python
and Rust. Auto-merge remains disabled. The new `secrets` check is not yet required
across main because its workflow has not landed there.

These controls can block existing PRs with stale checks/reviews or unresolved
threads. They do not authorize merge, deployment, Factory intake or a new agent
controller. No existing human changes-requested review was dismissed.

## Observed hosted failure and bounded repair

On `6119296`, [quality job 105493434019](https://github.com/All-The-Vibes/ecorp/actions/runs/35311200797/job/105493434019)
reported 939 Node passes, 62 failures and five skips. The failures were in
`tools/e2e_checkpoint_verification.test.mjs`: a Windows-shaped in-memory runtime
fixture reached `expectedWorkspace` with Linux's host-default path implementation
and failed with `unsafe_posix_path`. The other original-head hosted checks
subsequently passed; this does not validate the follow-up head.

The repair uses Node's existing `path.win32` and `path.posix` implementations:

- Pure original/recovery assessment functions accept an explicit path API.
- The injectable offline suite forwards it through all assessment phases.
- Windows-shaped offline fixtures consistently use `path.win32`, independently
  of the CI host. Dedicated regressions also exercise POSIX paths on every host.
- Native execution retains the host default. There is no new CLI override,
  live-runtime configuration, path guessing or change to the containment helpers.

Traversal, alternate data streams, UNC/incompatible spellings, sibling
workspaces and mismatched journal paths remain rejected. Independent review,
source identity, preserved-workspace and provider-free recovery checks remain
intact. No test is skipped and no safety check or timeout is relaxed.

## Validation and remaining limitation

- `node --test --test-reporter=tap tools/e2e_checkpoint_verification.test.mjs tools/e2e_stopped_source_checkpoint.test.mjs`:
  **266 passed, zero failures, cancellations or skips**.
- Negative control: load the unchanged `6119296` driver in memory with the new
  portability regressions. All four selected controls fail (three POSIX positive
  paths plus the suite's incompatible-path rejection). They pass with the repair.
  This uses inert in-memory fixtures, not a native service or provider.
- `pnpm check:preview`: all eight expected gates; no writes.
- Full run `2026-09-18T05-44-35-261Z-full.json`: **1053 Node passes, zero failures,
  one cancellation**. The existing Teams SDK unauthenticated-request test timed
  out at its unchanged 15-second limit. Source did not change during this run;
  the fail-fast driver did not execute the subsequent Rust/web gates.
- The unchanged Teams suite immediately passed in isolation: **18/18**. That
  does not erase the broad-suite timeout or establish consistently green CI.
- The six required repository gates were then run separately and all exited
  successfully: 41 migration checks, Rust formatting, Clippy with warnings as
  errors, workspace Rust tests, web build and web lint. Ignored database-dependent
  Rust tests remain ignored, not passing coverage.

The subsequent serialized full run `2026-09-18T05-48-29-340Z-full.json` passed all
eight gates with no source change during validation and no unexecuted gate:
**1054 Node passed, zero failed/cancelled/skipped; 554 Rust passed, zero failed,
343 ignored**. Migration, documentation contract, formatting, Clippy, web build
and web lint passed. The [unaltered portable receipt](ai-readiness-validation-portability.json)
retains the validated dirty-tree fingerprint. This result does not erase the
earlier Teams timeout. This reporting paragraph and the copied receipt were
added afterward; the two validated code/test files were unchanged.

These checks validate contributor tooling, not browser/server/runner product
acceptance. No retained service, database, runner credential or original source
checkout was changed. Subsequent exact-head hosted results belong in #323;
the PR stays draft until remaining validation and independent review are complete.

The last pre-publication CodeBlend result remains historical: composite 67.1,
foundations 87.0, operations 51.75. Neither settings activation nor this repair
is a measured score increase. Verified recurring repair/review/outcome evidence
remains separate work under #269/#280.
