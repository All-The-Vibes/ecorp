# Factory budget resume — observed acceptance, September 27, 2026

An approved budget revision could leave the Factory mission without a usable provider-resume control: optional provider-free checkpoint verification suppressed ordinary resume, and the recovery context could remain stale when the Factory item version did not change. The UI now offers the existing native budget-resume path for the exact suspended source/session/workspace, refreshes context when budget authority changes, and keeps stopped, cancelled, quarantined, verifier-only, unfinished and pending-budget states fenced.

The server and store continue to authorize resume under current Corp/room membership, role, source lineage, workspace, task/mission/enclosing budgets and idempotency locks. This change does not add a ledger, automatic budget grant, permission mechanism, provider process, migration or dependency.

## Source and results

Base commit: ee7bdb1b75f3ce5e7f315feeec6583777b0c4ff7. Validated candidate tree: 9a039c63c4d7e57d0f0c46c9058f35b5ac2a73f9. The three code files and full physical source fingerprint are in [summary.json](summary.json). [tested-code.patch](tested-code.patch) preserves the reviewed diff.

Locked offline dependencies and the canonical pnpm check completed all 11 current gates: migrations, state-audit compatibility, EVM, both documentation gates, full Node discovery, Rust formatting, strict Clippy, Rust workspace tests, web build and lint.

- Node: 3097 total; 3032 passed; 65 skipped; 0 failed; 0 cancelled; 0 todo.
- Rust: 865 passed; 0 failed; 558 ignored. Counts and command arguments are preserved in [canonical-report.json](canonical-report.json).
- Focused recovery regressions: 30 passed. Earlier 0/1 and 24/28 attempts remain as their actual results; the latter's historical filename includes green but it failed four fixture cases.
- Native build, all three independent native lanes and browser acceptance use the same recorded candidate. Successful cleanup verified no fixture listeners remained.

The earlier browser run reached an approved revision but failed with an absent approved Factory resume control. Its original source and failure remain in [earlier-browser-driver.json](earlier-browser-driver.json); they are not represented as a run on the corrected candidate.

## Acceptance

[browser-report.json](browser-report.json) records actual production UI requests for rejected and approved revisions, bounded finish scope, original/current/consumed/remaining ledger, requester self-review denial, restart/reconnect, replay and same-session/workspace resume. It records no page errors or external-origin requests and no horizontal overflow at 390 pixels. [browser-native-report.json](browser-native-report.json) binds those actions to the native Factory/server/runner state and database.

[native-bounded-report.json](native-bounded-report.json) qualifies approved native continuation and immutable spend. [native-overrun-report.json](native-overrun-report.json) qualifies a later hard stop without accepted completion. [native-missing-checkpoint-report.json](native-missing-checkpoint-report.json) qualifies safe catch-up of the legacy checkpoint. Each lane uses its own freshly owned fixture.

The initial missing-checkpoint attempt failed because its exclusive README lock also blocked the adapter's preceding Git evidence scan; [earlier-missing-checkpoint-report.json](earlier-missing-checkpoint-report.json) preserves that failure on the same candidate. The external r4 derivation refreshes only the synthetic index metadata, verifies identical source bytes and index blob identity, and proves both Git status and diff succeed while actual file reads are denied before releasing the provider handshake. Every original native cancellation, checkpoint and recovery assertion remains in place. [checkpoint-derivation.json](checkpoint-derivation.json) records the exact derivation, hashes and limits. The immediate standalone probe did not reproduce the original failure, so the timestamp explanation remains a hypothesis rather than a confirmed product defect.

Actual browser captures: [first state](browser-01.png), [second state](browser-02.png), [third state](browser-03.png), [fourth state](browser-04.png), [fifth state](browser-05.png), [sixth state](browser-06.png), [seventh state](browser-07.png). The full capture list and digests remain in the browser report and artifact manifest.

## Reproduction and limits

Use the checked-in tools/e2e_factory_budget_recovery.mjs fixture in its documented dedicated native lane with separately owned new QA roots. Bounded and overrun results use the r3 driver; the missing-checkpoint result uses the saved external r4 derivation and lock precondition check. The browser derivation and saved driver transcripts explain the production UI and owned restart additions. Driver transcripts are reference text; replace the redacted profile root with the independently owned local environment before reuse.

The actors and providers are synthetic test fixtures. These results are retrospective acceptance, not live model inference, actual human decisions, hosted publication, production deployment or operating-system isolation. Database environment delivery remains reduced assurance. Historical Cargo advisories and ignored/skipped tests are not a clean-audit or executed-test claim.

Evidence files were added after code validation. Separate publication validation must prove that every original physical file and the full canonical/Node-discovery plan are unchanged and that excluding this evidence directory reconstructs the validated candidate tree. The final PR records the resulting commit; no self-referential commit hash is invented here.

The manifest records original and published SHA-256 digests. Text publication strips a UTF-8 BOM where present and replaces Windows profile roots with USERPROFILE placeholders; it does not rewrite results. Screenshot bytes are unchanged. Evidence-specific Git attributes preserve raw transcripts and patch whitespace.

Publication scanning also identified eight synthetic command/decision replay UUIDs as generic API keys. Text reports consistently replace those UUIDs with labeled placeholders; [publication-redactions.json](publication-redactions.json) records original identifier hashes, affected files and scan findings. Original receipts remain preserved locally. This transform does not alter execution results, source identities or screenshot bytes, and the scan policy remains unchanged.
