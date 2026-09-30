# Governed Factory base refresh

Issue #84. Base: 878a1774774b0630c904cbaf4b05e1b346777817.
Tested implementation tree: 52867f5d35cb30be622fe9a550cec7e07322c8e6.

An already verified Factory deliverable can now be explicitly reconstructed and
re-verified after its authorized publication base advances. Refresh pins the new
base, retains the original result, runs the complete saved checks in fresh private
storage, requires a new independent review, and selects the result only through
explicit adoption. The existing publisher still requires the exact current base
and permits one branch and pull-request effect. Three lifetime attempts bound retries.

All eleven canonical pnpm check gates passed on the unchanged candidate source.
Node: 3108 total, 3043 passed, 0 failed and
65 skipped. Rust: 900 passed, 0 failed and
585 ignored across 41 summaries. The separate native
EVM gate passed one test; migrations checked all 57 versions. Skips and ignores
are not passes, and these counts overlap with focused lanes.

Full-stack acceptance R10 passed all ten scenarios through real Chrome/App,
server, PostgreSQL, runner and Git. Provider execution uses fake-process; the
GitHub boundary is fake and publication targets a local bare remote. One
publication branch and one fake PR were created at exact fixture commit
21c5153d82e75e11a30c5a73e9e616529f232912. The reported two branches include main.
The publisher credential was revoked and all owned services stopped; PostgreSQL
shutdown exited zero. Automated fixture actors do not represent human signoff.

The dedicated store lane passed 21 tests with 551 filtered; the predispatch lane
passed 8 with 564 filtered. Both used owned PostgreSQL and had zero failures or
ignored cases. Their matching 276-file manifests are incomplete. Canonical R2
and acceptance R10 instead bind every one of the 7,162 physical source files:
efe92db431183bd759bc833eda77c2a57b9fd2fc58cc06c3565abe80894c93c8.

Canonical R1 failed with 13 Node failures and five later gates not run. Locked
dependency installation and working Python resolved those environment failures
before R2. Native prerequisite regressions passed 32 tests; their original
wrapper's spec/TAP parsing error is preserved alongside a retrospective
reconciliation. Earlier failures and limitations remain in the history directory.

The publication commit did not exist during these executions. Source equivalence
records the reconstructed tested tree, verifies all Git blobs against the tested
bytes allowing only CRLF-to-LF normalization, and retains the complete physical
manifest once. Matching duplicated manifests use explicit references. Evidence
is added afterward; a separate validation checks original bytes, full command
arguments, Node discovery, documentation, privacy and secret scans.

The summary maps all eight issue criteria to implementation and observed evidence.
Artifact SHA-256 pairs distinguish original retained bytes from the published,
sanitized versions. Internal original hashes still identify original artifacts.
Personal paths and discovered credential strings are redacted; synthetic operation
identifiers use stable aliases. Original screenshot bytes are preserved.

Required hosted CI, CodeQL, code-quality and security gates remain unavailable
while GitHub Actions is disabled. This packet supports a draft implementation PR;
issue #84 remains open. No merge, self-approval, human decision, production
publication, live-provider acceptance or clean historical Cargo audit is claimed.

Qualifications:
- Assembly R1 exited one because its helper misread the scanner path/hash-pair schema. R2 validates every pair and preserves the failure receipt. Canonical/single-link path checks were added and observed at publication time; they are not retroactive proof of path metadata during earlier test execution.
- This is retrospective development validation and an AI implementation self-review, not an independent GitHub approval or a real human decision. No historical tests, reviews or chronology are invented.
- Acceptance R10 uses real Chrome, the actual App, server, PostgreSQL, runner and native Git. Provider execution is the deterministic fake-process adapter; GitHub is a fake boundary backed by a local bare publication remote. This is not live-provider or hosted-publication acceptance.
- The fixture reviewer is an automated distinct actor. Product explicit_human metadata in this fixture is not evidence of a human decision. Both original screenshots were visually inspected at reduced display resolution; this is not exhaustive visual or accessibility certification.
- Acceptance R10 and canonical R2 bind all 7,162 physical files. Store R11, predispatch R1 and runtime-build R2 have matching but incomplete 276-file manifests; those alone do not prove complete-source equivalence. Runtime binary hashes are historical build identities and are not asserted unchanged after later canonical builds.
- The publication commit is created after tests. Temporary-index reconstruction verifies every source blob, permitting only Git CRLF-to-LF normalization, and separately checks evidence-only additions against the original bytes, all full-plan arguments and Node discovery.
- Canonical R1 failed with 3,108 Node tests: 3,030 passed, 13 failed and 65 skipped. Two failures required the locked Teams SDK dependencies; eleven required working Python rather than the Windows Store alias. Five later gates did not run. R3 setup then completed frozen pnpm installation and the locked Repo Steward npm installation, without changing source or lockfiles.
- Prerequisite regressions observed native process exit zero and 32 passing tests. Their original wrapper wrongly expected TAP but received spec output, raising IndexError. The retained reconciliation parses the existing log retrospectively; it is not a new execution or a claim that the original wrapper succeeded.
- Earlier failed acceptance and validation attempts are preserved. Acceptance R8/R9 and canonical R1 are included as history; successful later evidence does not rewrite them. Runner/CLI R4 predate later changes and are not used as final-source validation.
- Optional legacy browser pure-test comparison R2 has the same 28 total, 18 passing and 10 failing tests on main and candidate. It is outside canonical Node discovery and is retained as a failure, not relabeled as a pass.
- The actual validation runtime is Node 24.21.0, pnpm 11.19.0, Rust 1.98.1 and Python 3.12.14. The repository declares Node 24.19.0; this is not a pinned-Node execution claim. RUST_TEST_THREADS was explicitly unset for canonical R2, so Rust used native thread defaults.
- Skipped Node and ignored Rust tests are not passes. Canonical, EVM, focused and full-stack counts overlap and must not be summed. Dedicated live and immutable historical replay lanes remain separate.
- GitHub Actions is disabled in the latest retained inventory. Required hosted CI, CodeQL, code-quality and security gates remain mandatory and unavailable. Issue 84 is open; no merge, issue closure, self-approval, policy override or clean historical Cargo advisory audit is claimed.

The first evidence validator exited one after three generic-api-key alerts for synthetic browser decision_key UUIDs. The original failed packet and scan receipt were preserved locally. Published copies consistently alias those fixture idempotency identifiers; no scanner policy or ignore rule changed. Product source, original acceptance, test counts and original artifact hashes are unchanged. The revised packet requires a fresh complete evidence validation.

The second evidence validator exited one before documentation, privacy or secret checks because the alias-correction helper had written summary.json with Windows CRLF, which Git would normalize. The complete failed packet and receipt were preserved locally. This packaging correction writes explicit LF bytes and retains the failed validation and observed exit; it changes no product source, test result or original acceptance receipt. A fresh evidence validation is required.
