# Human-requested review-only publication

An authorized user can request a GitHub pull request from an exact verified result in ECorp. The saved request waits for an independently enrolled trusted publisher, survives caller disconnect and publisher/server restart, and shows the resulting PR or a durable failure without starting another coding run. This completes the implementation and controlled acceptance for #219; GitHub issue completion additionally requires the implementation PR to merge. Parent #145 and machine-generated intent #348 are separate.

The 32-file implementation preserves normal human OIDC/Corp/room/Publish authorization, exact source and policy checks, tokenless human readback, and workload-only execution derived from recorded human provenance. A bounded repository watcher delegates to native `factory-publish`; existing attempt leases, fencing, current-authority checks, artifact download, Git import, remote adoption and Project updates remain authoritative. No second provider harness, approval engine or effect executor was added. Migration 0057 is additive; previously applied SQL is unchanged.

## Source and validation

Current-main parent: `878a1774774b0630c904cbaf4b05e1b346777817`. Tested staged tree: `79fb6df9ad8503fb48dbcd0c91e51c701c2ef28d`. All 7,159 physical source files match the acceptance build and browser run. Those ran with parent `fea25059c0af95a86a2fde39209d82e61a1a1385`; its tree and the dependency merge tree are identically `70ca1719de097ef9b27819acc847e9dce14b19b2`. [source-equivalence.json](source-equivalence.json) records the full fingerprint and source mapping. [tested-code.patch](tested-code.patch) is the reviewed product diff.

Locked offline dependency installation and canonical `pnpm check` passed all 11 gates: immutable migrations, state-audit compatibility, native EVM, both documentation gates, full Node discovery, Rust formatting, strict Clippy, workspace Rust tests, web build and web lint. Node: 3,123 total, 3,058 passed, 0 failed, 65 skipped, 0 cancelled, 0 todo. Rust workspace: 879 passed, 0 failed and 582 ignored across 41 summaries. The separate EVM gate passed one test. [canonical-report.json](canonical-report.json) and [canonical-pnpm-check.log](canonical-pnpm-check.log) preserve the actual commands and results. Native ignored probes are not passes.

Fresh native PostgreSQL focused checks passed 13 real-migration request/execution cases, two watcher unit cases and five HTTP authorization cases, with zero failures or ignored cases. They cover scope, current authority, exact preview and source policy, provenance, tokenless readback, direct-CLI intent rejection, competing claims, replay, failure cleanup and transaction invariants. Their receipts bind the unchanged Rust/migration source. These tests overlap the full suite; counts are not additive.

## Controlled product acceptance

[controlled-browser-report.json](controlled-browser-report.json) and [controlled-native-report.json](controlled-native-report.json) record real Edge, server, runner, publisher, PostgreSQL and private Git with development authentication, deterministic providers and simulated GitHub. Two genuine native verified results produced two tokenless human intents. The caller disconnected before execution; a competing worker attempted no effects. A deliberate publisher crash after simulated PR creation exited 86. After server restart and actual persisted lease expiry, native recovery adopted the same PR on its second attempt. Repeating the completed intent made no new attempt.

A controlled Project-update failure kept the existing second PR and visible failure, with no retry loop. No extra coding runs, browser publisher credential or remote-main change occurred. All browser requests stayed on loopback, and every owned server, runner, web and PostgreSQL process was stopped. Full-history native Git packing preserved refs and passed fsck; the production Git timeout stayed 30,000 ms.

Ten unmodified captures cover exact preview, waiting, working after reconnect, published and failure states at 390px and 1440px. The interactions ran at 390x844; measured cards and document widths have no horizontal overflow. [screenshot-review.json](screenshot-review.json) records Codex visual inspection, including the existing focused skip link visible over the mobile work-item title. This is not an independent human review or authorization decision.

| State | Mobile | Desktop |
| --- | --- | --- |
| Exact result | [390px](01-exact-result-preview-390px.png) | [1440px](01-exact-result-preview-1440px.png) |
| Waiting | [390px](02-waiting-for-trusted-publisher-390px.png) | [1440px](02-waiting-for-trusted-publisher-1440px.png) |
| Working | [390px](03-working-after-caller-reconnect-390px.png) | [1440px](03-working-after-caller-reconnect-1440px.png) |
| Published | [390px](04-published-exact-link-390px.png) | [1440px](04-published-exact-link-1440px.png) |
| Failure with PR | [390px](05-failure-with-existing-pr-390px.png) | [1440px](05-failure-with-existing-pr-1440px.png) |

## Recorded failures and limits

[history.json](history.json) preserves the actual regression and fixture chronology. Red assertions remain separate from compilation and fixture failures. Handler red-r1 did not compile; red-r2/r3 failed fixture setup; red-r4 exposed tokenless readback after revocation and cross-Corp artifact metadata defects. Handler green-r1 had a wrong new HTTP 403 expectation where the native role-change mapping returns 400; green-r2 omitted required resolved-base fixture metadata; green-r3 passed five cases. Worker-r1 compared credential `last_used_at` in two no-effect snapshots; its diagnosis exposes only differing field names, and corrected fixtures passed. Browser-r1 through r5 failed; r6 passed the earlier source; r7 passed the integrated source. The preserved Git diagnostics distinguish an over-time fetch, a failed fsck experiment and successful complete-history native packing. No failed attempt is relabeled as acceptance.

Raw failed snapshots may contain ephemeral fencing values and remain private. Published history includes original hashes and allowlisted test-result excerpts. Local profile roots are redacted, with original/published hashes distinguished. The first publication check caught caret-escaped Windows profile roots in copied PostgreSQL initialization logs; [publication-redaction.json](publication-redaction.json) records their correction while preserving original logs and the failed check receipt. Driver snapshots end in `.txt` and cannot enter Node test discovery. The complete fixture directory and its credential files are never publication inputs.

Evidence files were added after code execution; final source equivalence and evidence-only validation are recorded separately. This fixture does not prove live GitHub mutation, real model inference, production OIDC configuration or operating-system isolation. Environment-only database credentials remain reduced assurance. The serial Rust canonical run does not close the separate Windows concurrency issue #213. Existing Cargo advisory debt remains 12 advisories (2 high, 1 moderate, 9 low); no clean audit is claimed. Publication never means merge, auto-merge or deployment.
