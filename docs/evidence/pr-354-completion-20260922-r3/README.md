# PR #354 dispatch-readiness acceptance correction

Separate read-only factory validity from current dispatch readiness. Recheck runner capabilities and immutable source immediately before enqueue; refuse execution before claim, reclaim or source upgrade when dispatch is unavailable.

All nine contributor gates, all nine factory-connection and four dispatch-readiness SQLx tests, behavioral baseline RED/candidate GREEN, actual native CLI dry-run/new-claim/reclaim controls, and real browser/server/runner policy acceptance. Explicit reuse is limited to identical-source passing build and SQLx results. Tested source is `46237253fc7be2959f0d2d27c8514d075ab10534`. Native r3 supplied the verified build and thirteen PostgreSQL regressions; r7 reused those hashes on the identical tree and ran both acceptance lanes freshly. The retrospective test fails on baseline `08b0b89b2dd16c1906c9dd3468c5ddecca24c4ce` with "stale adapter capability reached enqueue" and passes on the candidate, covering eight capability changes and ready controls. Its overlay adds only the candidate regression test to baseline production code. Source trees, exact patch, original test bytes, commands and log hashes are under `retrospective/`.

The real HTTP path accepts valid/not-ready previews, rejects strict execution intent with 409, accepts a matching ready runner and rejects an observer with 403. The native CLI is an actual built executable using an owned recording loopback proxy and deterministic GitHub transport. Dry-run remains read-only. Normal runs for both a new issue and an expired legacy claim with a required source upgrade each return 409 before any claim, reclaim, upgrade or materialization request. Exact rows of all eight recorded tables, source commits and all GitHub business fields remain unchanged. Read-only GraphQL counters are separately retained; item edits remain zero.

## Historical qualification

The earlier r2 packet's credential-free child implication is unqualified: its PowerShell parent retained `PGPASSFILE`, so that history does not prove credential-free browser/native-child inheritance. Its original files remain unchanged. The corrected execution explicitly removes inherited credential variables before each relevant child, supplies `PGPASSFILE` only to the psql child, and records empty forbidden-variable lists for focused and browser preflight. This is a process-environment check, not a claim of operating-system secret isolation. Native SQLx database delivery still uses an ephemeral environment credential and remains reduced assurance.

All subsequent failed attempts are retained. r3/r4 failed on an inherited empty `GH_PAGER`; this host requires removing the environment entry, because setting its .NET value to null left an empty entry. r5 wrongly expected dry-run to serialize an opt-in false field that it omits. r6 wrongly compared read telemetry with business state. These test-driver corrections changed no product code or validated binary.

## First-run replay

Use PowerShell 7.5 or newer to preserve ownership timestamp strings exactly, and a clean isolated Windows checkout, frozen dependencies, pinned toolchain, PostgreSQL, Edge and Playwright. Create a fresh output directory and choose a new `qa/pr265-run-activity-*` directory outside the checkout and dedicated Cargo target. Preserve any old native binaries and evidence; a fresh checkout must have no `target/debug/crony-server.exe`, `crony-runner.exe` or `crony-cli.exe`. Keep all four `replay/` files adjacent.

```powershell
& ./docs/evidence/pr-354-completion-20260922-r3/replay/run-pr354-native-first-run-r9.ps1 `
  -Revision r9 -ValidationDirectory ./docs/evidence/pr-queue-completion-20260923 `
  -Repository $reviewCheckout -QaRoot $newOwnedQaDirectory `
  -PostgresBin $postgresBin -CargoTargetDirectory $ownedCargoCache `
  -NodeDirectory $nodeBin -PlaywrightModule $playwrightModule `
  -OutputDirectory $newEvidenceDirectory
```

This first-run composition builds all three binaries, provisions SCRAM PostgreSQL, requires the current sixteen factory-connection and four readiness SQLx tests, then runs native intake and browser acceptance. It needs no private reuse receipt. The corrected replay accepts raw or published validation receipts, requires every gate in the current checkout (including audit compatibility and EVM), and reconstructs the validated source tree in a private Git index. It removes only the selected evidence packet from that private index, rejects all source drift and Git errors, and never changes the real index. The example selects the current queue integration packet; the historical nine-gate packet cannot authorize changed source. Default ports are 29354, 26354 and 25354. The recorded r3 build block and r7 acceptance block were executed; the combined first-run r8 script is supplied for replay and is not itself claimed as the producer of these results.

Local Node 24.21.0 differs from the repository 24.19.0 pin. Rust 1.98.1 and PostgreSQL 17.10 were used. Real product screenshots are the PNGs under `native-fixture/`; the validation and retrospective HTML/PNG files render saved results. Development identity and deterministic providers do not establish external-provider or production acceptance. All owned services stopped; databases, source, credentials, logs and workspaces were preserved.


## Proxy error correction, revision 9

The active replay proxy returns a constant JSON 502 with explicit content type,
nosniff and no-store headers. It never returns exception text. The revised driver
probes the live listener with a non-API path containing a hostile marker and an
API request containing invalid JSON; both must return exactly the generic error,
make no upstream request and leave the ledger unchanged.

Historical readiness drivers and the superseded first-run composition are retained
byte-for-byte under archived-drivers/ with .txt extensions. These are historical
evidence, not runnable replay entry points. Their former paths and original hashes
are recorded in provenance/proxy-r9-derivation.json; the entire previous binding
is preserved in provenance/source-binding-before-proxy-correction-r9.json.
Only the current replay/ drivers are intended for execution. Prior test results
remain unchanged. The complete revision 9 first-run composition passed; its fresh
build, thirteen SQLx regressions, three CLI cases, both proxy failure probes and
browser/server/runner acceptance are retained separately under proxy-r9/. No prior
build or SQLx result was reused for this execution.

## Replay review correction and capability custody

The supported replay inputs now differ from the historical revision 9 inputs. Exact prior bytes are retained as non-executable text under `recorded-drivers/pre-review-correction/`; `provenance/replay-review-correction.json` binds original, archived and corrected inputs. The historical native results above remain valid only for their recorded source. A fresh-clone regression proves source reconstruction even when the original staged tree object is absent, proves drift rejection, and checks real-index byte custody. Browser preflight uses source identity and explicit fixture ownership rather than the author's checkout basename.

The active ledger writer hashes capability-bearing fields before either serialization or equality hashing. Published current ledger snapshots are explicitly redacted derivatives; `provenance/ledger-redaction.json` binds their original and derivative SHA-256 values. The originals remain in Git history; no history was rewritten and no scan exception was added. Historical leases were local QA capabilities with past expiry, not claimed current external credentials. New-leak detection remains unchanged. Historical equality hashes describe the original raw snapshots; derivative equality hashes are recorded separately, never relabelled as historical execution results.

Mixed-version compatibility: the updated CLI deliberately refuses execution against an older server that omits `dispatch_readiness`. Upgrade the server before using execute mode with this CLI. Read-only dry-run output remains readable. The fail-closed execution gate is retained.

The final integration review also corrects readiness-child configuration and failure evidence.
The child accepts the supervisor's fresh fixture naming contract and reads all ports from
its exact ownership record, with current validated source and native process/listener checks
before any product request. Arbitrary remote endpoints, changed source, reused scope and
invalid ports are rejected. Raw CLI stdout/stderr stay in memory for assertions; reports
record their byte counts and SHA-256 digests. All structured report responses pass through
capability redaction, and failure records contain only the operation stage and failure kind.
Unexpected non-JSON bodies are digested. Prior provenance and execution receipts retain
their historical bytes and scope; they do not attest these later driver changes.
