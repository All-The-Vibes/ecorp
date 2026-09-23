# PR #355 preserved-deliverable acceptance

Retain typed DeliverableExport failures and the complete failed workspace, prevent silent retries in a fresh checkout, and require the complete source scope for export. Integrate current main and provide a behavioral baseline regression with a complete first-run replay.

All nine contributor gates; three owned PostgreSQL deliverable-failure regressions; baseline ordinary-failure control and export-failure RED/candidate GREEN; actual Edge restricted/full-source export acceptance; and browser/server/native-runner verifier-policy acceptance. Issue #89 remains partial: external-provider and GitHub-publication acceptance are not claimed.

The tested source tree is `5bbcd7f113748ca222ce3e0b2e3310b44baa184e`, incorporating main `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. All nine contributor gates and the new complete native r6 invocation ran on this exact tree. `native-lifecycle.json`, the native logs, screenshots, source and binary hashes bind the results. The r6 first-run driver was executed from the build through both browser lanes; its four exact historical input files matched the pre-execution derivation hashes. The subsequently corrected first-run and preflight inputs are archived byte-for-byte under `recorded-drivers/pre-review-correction/`; the remaining historical replay inputs retain their original bytes. This invocation has no reused build, private prerequisite receipt or prior fixture dependency.

The real Edge flow with a restricted `result.md` scope produces a typed DeliverableExport failure, preserves the entire dirty workspace and proves that no fresh-worktree retry occurs. The complete-source flow exports README.md and portable-untracked.txt with bytes identical to the resulting source commit. Provider evidence result.md remains separate, matches its accepted artifact digest and remains untracked in the preserved workspace. A separate browser/server/native-runner policy flow accepts valid completion and rejects verifier failure. The configured source remains unchanged.

The retrospective applies a test-only compatibility overlay to baseline `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce`. Baseline production is unchanged. Its ordinary untyped execution-failure control passes; the export regression fails at the behavioral assertion with `String("ready")` versus `"failed"`. The candidate passes all three deliverable-failure tests. The exact test originals, compatible baseline test, patch, source manifests, commands and log hashes are under `retrospective/`. The saved-results HTML/PNG displays these logs; it does not claim original TDD chronology.

The original r2 evidence remains unchanged. Its earlier native source was `fa20da1174d7c49d5e7934f9a8d9f8769edcb406`; the current integration includes the equivalent retained-receipt predicate and the mainline regression tests. The fresh r6 build and acceptance remove any need to infer current behavior from that older result. Prior native failures remain in r2. The retained retrospective r1 failure reproduced the desired behavior but its matcher expected line 177 rather than actual line 178; the corrected r2 invocation used a new owned database and the same production/test bytes. A preceding preparation failure stopped before any test and is described in the source manifest.

## First-run replay

Use PowerShell 7.5 or newer to preserve ownership timestamp strings exactly, and a clean isolated Windows checkout, install frozen dependencies and the pinned repository toolchain, and supply PostgreSQL, Edge and Playwright. Keep the four `replay/` files adjacent. Create a new empty output directory and choose a new owned `qa/pr265-run-activity-*` path outside the checkout. Preserve existing native binaries and fixture directories. The fresh checkout must have no `target/debug/crony-server.exe`, `crony-runner.exe` or `crony-cli.exe`. Use a dedicated Cargo target.

```powershell
& ./docs/evidence/pr-355-completion-20260922-r3/replay/run-pr355-native-first-run-r6.ps1 `
  -Revision r7 -ValidationDirectory ./docs/evidence/pr-queue-completion-20260923 `
  -Repository $reviewCheckout -QaRoot $newOwnedQaDirectory `
  -PostgresBin $postgresBin -CargoTargetDirectory $ownedCargoCache `
  -NodeDirectory $nodeBin -PlaywrightModule $playwrightModule `
  -OutputDirectory $newEvidenceDirectory
```

This corrected supported replay derives from the parameterized first-run script that produced native r6; it is not claimed to have produced those historical results. It accepts raw or published receipts, requires every gate in the current checkout (including audit compatibility and EVM), reconstructs the validated tree in a private index, and rejects source drift or Git errors without altering the real index. Select the current queue integration packet shown above; a historical nine-gate packet does not authorize changed source. It builds server, runner and CLI, provisions owned SCRAM PostgreSQL, requires three SQLx regressions, and executes both real browser lanes. Admitted ports are 29355, 26355 and 25355. Local Node 24.21.0 differs from the repository 24.19.0 pin; Rust 1.98.1 and PostgreSQL 17.10 were used. Database credentials delivered through the server/SQLx environment remain reduced assurance. Child environment checks do not prove operating-system isolation.

All owned services stopped after acceptance. Database, credentials, source, workspaces and logs were preserved. Real product screenshots are under `native-fixture/`; validation and retrospective HTML/PNG render saved results. Development identity and deterministic native providers do not establish external-provider or production acceptance. Issue #89 remains partial: this does not close every recovery/export/publication requirement.

## Historical driver custody and review roles

The malformed archival `recorded-drivers/run-pr355-retrospective-r1.ps1` retains its original bytes and hashes, including the unparseable `catch[Threading.AbandonedMutexException]` spelling. It is not a supported entry point and is not relabelled as an executed successful script. Later historical execution variants corrected that spacing; the recorded commands, patch and logs establish the credited RED/GREEN run. The current supported entry point is the corrected `replay/run-pr355-native-first-run-r6.ps1`. `provenance/replay-review-correction.json` binds its prior historical bytes and corrected bytes separately.

Codex-assisted maintainer author-side review inspected retained typed export failures, full-source scope, preserved-workspace retry behavior, current-main integration, the source-binding recipe, and the limits of the recorded native/retrospective evidence against the product, architecture, security and evaluation contracts. That author-side review is separate from eligible protected team, code-owner or last-push approval. No personal-human or independent cross-model review is claimed. Any authorized maintainer review override is recorded separately from the substantive findings and hosted checks.
