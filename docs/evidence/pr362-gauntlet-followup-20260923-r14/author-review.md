# PR362 R14 — automated author-delegate full-contribution review

## Attribution and verdict

**PASS for the bounded author-side source/evidence review: R13-PRIVACY-01 is
verified cleared; no unresolved introduced blocking finding identified.**
The literal “99% unchanged original bytes” statement is not supported; the
precise measurements below replace it, without weakening privacy.

This is the requested automated author-delegate continuation in the same verifier
context, not a human attestation, independent review, protected approval, Santa
verdict or authority to publish. No specialist was spawned or represented as
having independently approved this work. The actual fresh R14 execution results
are bound separately in `verification-summary.json`; review cannot convert a
failed, skipped, ignored or unavailable execution into a pass.

## Frozen scope and full-contribution coverage

- HEAD: `a3f755687f0a6778dc0bc655e38b4b130643d04c`
- MERGE_HEAD: `3195fd7f15cb43946f9705640568551cdc6a57e3`
- Staged tree: `f127601f8885288e9b87f7569b85a647103a68bd`
- Target: `1edbf1b5f4d4fe3f12f9177bb72b631d8ce2e819`
- **370 contribution paths: 19 non-evidence paths and 351 evidence paths.**

The actual R13-to-R14 comparison changes exactly the baseline public log,
`focused-validation.json` and additive README disclosure. All **1,307 other
tracked files**, including all application/test/build code and the four product
references, retain their R13 bytes. Within the contribution, **367 paths** are
identical and three changed. Against MERGE_HEAD the correction is twelve paths:
the nine retained R13 corrections plus the three new derivative/provenance paths.

This re-review preserves traceability for every previous source surface, examines
the complete new three-file diff, rechecks current source and caller boundaries,
and revalidates all contribution evidence hashes/privacy controls. R13's genuine
failed review remains unchanged; its reasoning is context, not a relabelled R14
execution or approval.

## R13-PRIVACY-01 closure

`derivative-correction-proof.json` independently verifies:

1. The private before-log exactly equals the public Git blob at `3195fd7...`,
   the R13 source inventory hash, and the previously published hash
   `0ea135df64673bcf9064b5f2675e22deec1f502f4badcaad87f08d912d6454b9`.
2. Exactly two **27-byte** home-prefix spans at lines **15 and 27** become
   `<user-home>`. Reconstructing that exact substitution yields the complete
   current log, SHA-256
   `e10f4389f570ed39a7fc9eda0120dc9715c3de3617a7cedd810d13203d9acc22`.
3. Every non-target byte is unchanged. The original `Ran 1 test in 2.935s` and
   `FAILED (failures=2)` result text remains. This is not a new execution.
4. Every original execution digest in `focused-validation.json` remains.
   Only the affected published hash changes; the prior published hash and exact
   Git pointer are added, and every other log row is identical.
5. The entire prior README is an unchanged prefix; only the dated disclosure
   is appended. Old source/tree bindings and the historical 64-test receipts
   remain at their original identity.
6. The fresh whole-contribution public text scan finds **zero** scoped home-path
   matches. The correction does not merely exclude the leaking file from a scan.

**Numeric qualification:** 3,515 of 3,569 original bytes are outside the two
authorized spans and are identical: **98.486971%**, not literally 99% unchanged
original bytes. The corrected log is 3,537 bytes, **99.103390%** of the original
length. **100% of non-target bytes are preserved.** No extra edit or weakened
redaction is warranted to manufacture a different percentage.

## Full source/caller review

| Surface | Current files and relevant callers | Assessment |
|---|---|---|
| CLI transport | `crates/crony-cli/src/transport.rs:7-202`; `main.rs:181-185,492-510`; Factory/publisher helpers `factory.rs:4501-4535`, `publish.rs:1835-1870` | Native URL/client construction, origin-only input, remote HTTPS, no redirects, sensitive actual Bearer header and loopback proxy bypass remain. All operational callers use the constructed client. Server-side authorization is not replaced. |
| Gateway transport and paths | `crates/crony-gateways/src/lib.rs:34-126,269-394,478-743` | Private parsed origin, same-origin joins, UUID room IDs, redirect refusal before decoding and existing read-only body limits remain. Unrestricted bodies are not advertised as newly bounded. |
| Protocol entrypoints | `crates/crony-gateways/src/bin/crony-mcp.rs`, `crony-acp.rs`, `crony-a2a.rs` | Every constructor propagates failure. A2A checks loopback before binding; this is not authenticated remote ingress or hostile-local-process isolation. |
| Secret encryption | `crates/crony-server/src/secrets.rs`; `main.rs:1151,4844-4896` | Existing OS-random AEAD nonce generation, twelve-byte persisted format and Corp/secret/name AAD remain. Grant validation precedes decryption. Tests do not certify entropy quality. |
| Proxy/native MCP fixtures | `tools/e2e_factory_controller.mjs:279-342`, complete `security_fixtures.test.mjs`, native configuration and redirect scenario in `probe_mcp.test.mjs` | Actual extracted proxy uses fixed output and allowlisted diagnostics. Native MCP tests cover both transport modes; the unit lane does not execute the Factory driver. |
| Startup harness | Changed primitives/callers in `tools/test_startup_validation.py`, complete `test_startup_validation_harness.py` | Existing OpenSSL resolution, explicit TLS 1.2 minimum, minimal Windows SystemRoot forwarding, real verified handshake and mocked container-ownership tests stay distinct from a full startup/Docker drill. |
| Portable verifier | Complete `docs/evidence/pr362-combined-20260921/verify_public.py`, `tools/test_public_evidence_verifier.py` | Fixed physical/file/ZIP/member/aggregate limits, CRC, safe names and link/descriptor checks remain. Image metadata is admitted before payloads; README marker limits precede lookup and forward scans are bounded. Not a general Markdown parser or OS sandbox. |
| Staged replay | Complete `tools/staged_evidence_inventory.py`, `verify_pr362_staged_evidence.py`, `test_staged_evidence_driver.py` | Canonical nine commands, receipt-relative logs, exact hashes, complete discovery/no skips, bounded Git inventory and early lexical/reparse output admission remain. Remote guard/test bytes are preserved; only remote expected count 64 becomes 69. |
| CI and operational docs | `.github/workflows/ci.yml`, `docs/MCP_OPERATIONS.md`, `docs/SECURITY.md` | Existing test jobs carry the added discovery; no new pin/permission change. Transport claims remain aligned with code. This local review does not establish hosted jobs or neutral-check acceptability. |
| Public evidence | Two transport/remediation reports, original packet READMEs/manifests, ten completion packets and the complete R14 three-file delta | Original results, failure history and source bindings remain historical. The missed double-escaped prefix is now a disclosed derivative with exact old/new provenance, not a changed result. |

The four product references, root/worktree AGENTS and tool boundaries were
revalidated as unchanged and their relevant evidence/security contracts reread.
The contributor still preserves tenant/Corp/actor scope, durable authorization,
idempotency, runner lifecycle, verifier policy, budgets and attempt history.
No application architecture or dependency changes were introduced in R14.

## Current artifact proof

- `current-source-equivalence.json`: complete inventory and Python/JSON parsing;
  exact twelve-path correction, preserved nine R13 fixes, unchanged old helper
  assertions/functions/test methods and 69 independently enumerated test methods.
- `privacy-derivative-proof.json`: 233 archive members compared with retained
  raw originals, 25 portable images, both exact gauntlet derivative encodings,
  four rejected outside-rectangle RGB/alpha controls and 331 scoped text/member
  scans. Current tree and invocation bindings are new R14 records.
- `contribution-evidence-audit.json`: all 286 standalone public text files,
  61 decoded PNGs and 123 matching published log hashes across ten historical
  completion packets. No scoped home-path leak remains.
- `full-contribution.diff` and `twelve-path-correction.diff`: actual target-to-
  index and remote-to-index diffs, not synthetic summaries.

The 61 image bytes are unchanged from R13, including the previously inspected
two explicit gauntlet derivatives and the remote historical report screenshot.
Fresh byte/pixel checks do not claim fresh captures, independent capture
authenticity, OCR/general DLP, or manual inspection of every historical log line.
No historical packet is used as the fresh nine-gate receipt.

## Minimality, whitespace classification and external gates

The parent used the smallest sufficient correction: two path substitutions,
one provenance-row extension and an additive disclosure. Existing native tools
and tests suffice; no parser framework, dependency, new execution mechanism,
source-binding repin or historical-results normalization is needed.

The old-HEAD `git diff --cached --check` failure is preserved, not silently
discarded or called a pass. `whitespace-classification.json` binds its flagged
paths to byte-identical staged, target and remote blobs; correction-relative and
full-target diff checks remain separately required. Immutable incoming benchmark
and completion evidence is not normalized to silence a wrong-baseline comparison.

The parent reports remote `3195fd7...`, four green uploaded CodeQL analyses but
a **NEUTRAL warning aggregator**, and an ordinary rerun rejected with
“workflow run cannot be retried.” This lane did not query or mutate hosted state,
retry remotely, alter settings or bypass anything. **All CI green is not claimed.**

Remaining external gates: parent's minimal public packaging and new-tree
qualification, live remote fences, two fresh scoped reviews and protected
approvals. Fresh browser/server/runner, full Docker/startup, ignored opt-ins,
production/provider identity and dependency-alert requalification are not
established here. Stop when all assigned fresh local runs, immutable receipt
checks and owned-process/source fences complete; never substitute this
author-side verdict for those separate gates.
