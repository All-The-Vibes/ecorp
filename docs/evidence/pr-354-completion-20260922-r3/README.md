# PR #354 dispatch-readiness acceptance correction

Separate read-only factory validity from current dispatch readiness. Recheck runner capabilities and immutable source immediately before enqueue; refuse execution before claim, reclaim or source upgrade when dispatch is unavailable.

All nine contributor gates, all nine factory-connection and four dispatch-readiness SQLx tests, behavioral baseline RED/candidate GREEN, actual native CLI dry-run/new-claim/reclaim controls, and real browser/server/runner policy acceptance. Explicit reuse is limited to identical-source passing build and SQLx results. Tested source is `46237253fc7be2959f0d2d27c8514d075ab10534`. Native r3 supplied the verified build and thirteen PostgreSQL regressions; r7 reused those hashes on the identical tree and ran both acceptance lanes freshly. The retrospective test fails on baseline `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce` with "stale adapter capability reached enqueue" and passes on the candidate, covering eight capability changes and ready controls. Its overlay adds only the candidate regression test to baseline production code. Source trees, exact patch, original test bytes, commands and log hashes are under `retrospective/`.

The real HTTP path accepts valid/not-ready previews, rejects strict execution intent with 409, accepts a matching ready runner and rejects an observer with 403. The native CLI is an actual built executable using an owned recording loopback proxy and deterministic GitHub transport. Dry-run remains read-only. Normal runs for both a new issue and an expired legacy claim with a required source upgrade each return 409 before any claim, reclaim, upgrade or materialization request. Exact rows of all eight recorded tables, source commits and all GitHub business fields remain unchanged. Read-only GraphQL counters are separately retained; item edits remain zero.

## Historical qualification

The earlier r2 packet's credential-free child implication is unqualified: its PowerShell parent retained `PGPASSFILE`, so that history does not prove credential-free browser/native-child inheritance. Its original files remain unchanged. The corrected execution explicitly removes inherited credential variables before each relevant child, supplies `PGPASSFILE` only to the psql child, and records empty forbidden-variable lists for focused and browser preflight. This is a process-environment check, not a claim of operating-system secret isolation. Native SQLx database delivery still uses an ephemeral environment credential and remains reduced assurance.

All subsequent failed attempts are retained. r3/r4 failed on an inherited empty `GH_PAGER`; this host requires removing the environment entry, because setting its .NET value to null left an empty entry. r5 wrongly expected dry-run to serialize an opt-in false field that it omits. r6 wrongly compared read telemetry with business state. These test-driver corrections changed no product code or validated binary.

## First-run replay

Use an isolated Windows checkout, frozen dependencies, pinned toolchain, PostgreSQL, Edge and Playwright. Create a fresh output directory and choose a new `qa/pr265-run-activity-*` directory outside the checkout and dedicated Cargo target. Preserve any old native binaries and evidence; a fresh checkout must have no `target/debug/crony-server.exe`, `crony-runner.exe` or `crony-cli.exe`. Keep all four `replay/` files adjacent.

```powershell
& ./docs/evidence/pr-354-completion-20260922-r3/replay/run-pr354-native-first-run-r8.ps1 `
  -Revision r8 -ValidationDirectory ./docs/evidence/pr-354-completion-20260922-r3 `
  -Repository $reviewCheckout -QaRoot $newOwnedQaDirectory `
  -PostgresBin $postgresBin -CargoTargetDirectory $ownedCargoCache `
  -NodeDirectory $nodeBin -PlaywrightModule $playwrightModule `
  -OutputDirectory $newEvidenceDirectory
```

This first-run composition builds all three binaries, provisions SCRAM PostgreSQL, requires all nine factory-connection and four readiness SQLx tests, then runs native intake and browser acceptance. It needs no private reuse receipt. It accepts either `staged_tree` or `tested_staged_tree`, validates all nine gate names and requires all non-packet source to match. Default ports are 29354, 26354 and 25354. The recorded r3 build block and r7 acceptance block were executed; the combined first-run r8 script is supplied for replay and is not itself claimed as the producer of these results.

Local Node 24.21.0 differs from the repository 24.19.0 pin. Rust 1.98.1 and PostgreSQL 17.10 were used. Real product screenshots are the PNGs under `native-fixture/`; the validation and retrospective HTML/PNG files render saved results. Development identity and deterministic providers do not establish external-provider or production acceptance. All owned services stopped; databases, source, credentials, logs and workspaces were preserved.
