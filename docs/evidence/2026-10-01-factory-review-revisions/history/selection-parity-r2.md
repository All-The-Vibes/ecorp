# Issue 95 selection parity review

This is a retrospective source review on October 1, 2026, following the failed canonical R1 run. It is not a passing test receipt.

The managed checkout remains on parent `7e65f46a0c0f991460eeb4c5b60723d2e0dff1f9`, with the uncommitted issue 95 implementation. Current main was last reconciled at `878a1774774b0630c904cbaf4b05e1b346777817` in `queue-inventory-r17.json`.

## Native selection

Reviewed `crates/crony-runner/src/deliverable.rs`, its diff from the parent, the independent Git oracle in `tools/check_deliverable_diff.test.mjs`, `tools/check_deliverable_diff.mjs`, `deliverable_verification.rs`, and the correction tests in `review_revision_tests.rs`.

- Ordinary calls to `prepare` still select from the immutable base on Unix and from an explicitly preserved head on Windows. The platform filter moved from `select_index` into its caller. Ordinary `prepare_tree` continues to use its explicit canonical tree. There is no change to the ordinary Node checker/oracle.
- `prepare_revision` is a separate correction mode. It validates the published object ID and commit/branch form, requires original base -> published head -> workspace HEAD ancestry, and supplies the published predecessor as the selection seed on all platforms.
- The selected path validation, restoration of unselected seeded paths to the original delta base, platform-specific executable mode handling, native `git add -A`, provider-artifact reset to the original base, scope validation, and unsafe-change rejection remain in the selection sequence.
- Corrections retain the original base for delta/scope inspection, freeze one candidate tree before verification, and export a child of the published predecessor. A complete revert still creates that child; it does not reset publication lineage to the original base. Resetting the real worktree index accounts for paths removed from the base delta by a revert.
- Existing native correction regressions exercise exact seeding and executable mode, signed source/resume integrity, verified tree and bundle ancestry, partial/complete reverts with clean indexes, and lost ancestry/out-of-scope rejection. Native deliverable regressions and the full ordinary Node parity file are being rerun for this revision; their receipts, rather than this review text, determine the result.

The old recipe hash `22a8887f0f2c84779ac0ae875683da62643eb1358c066a3e4777015050988e10` is replaced with `5e2be3fe67abb81d410d4012b2cf38d8ba1209ef4825bd0dacf9e8a23df93d65`. The existing source guard additionally pins the caller's `correction_parent.or(preserve_head_commit.filter(|_| cfg!(windows)))` mapping because it now owns the ordinary platform decision. This does not claim the ordinary Node checker implements correction seeding; that path is covered by native correction tests.

## Canonical R1 prerequisite and test corrections

- Eleven failures arose from the Windows Store `python.exe` alias. Subsequent runs prepend the existing working bundled Python directory to process-local PATH. No global environment, TLS, package-manager security settings or test discovery configuration is changed.
- Two Teams host failures arose from absent optional SDK packages. `issue95-steward-install-r1.json` records `npm ci --ignore-scripts --no-fund --workspaces=false`, native exit 0, unchanged locked dependencies, and an audit of 118 packages reporting zero vulnerabilities. This is not a Cargo advisory audit.
- The recurrence regression searched the entire serialized result for the substring `revision`; the absolute `state_directory` contains the checkout name `issue95-review-revision`. `issue95-node-recurrence-red-r1.json` reproduces this assertion failure. The assertion now searches for the serialized input property `"revision":`, retaining its non-disclosure intent without rejecting directory names. Production recurrence code is unchanged.
- Canonical R1 and all failed attempts are preserved. R1 passed the first five named gates and failed Node discovery: 3,135 tests, 3,055 passed, 15 failed, 65 skipped, zero cancelled/todo. Formatting, clippy, workspace Rust tests, web build and web lint did not run in R1.

These two test-file changes require new complete source-bound acceptance and canonical receipts. Earlier successful native/product acceptance remains historical evidence for its recorded source.
