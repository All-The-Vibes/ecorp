# Selected-run source and evidence inspection

Issue #260. Parent: c54e25b08276d29a7c6d514fcef593fb06e57fec. Observed main: 878a1774774b0630c904cbaf4b05e1b346777817.
Tested implementation tree: 1c97c343f6e453f6ea0146b3c5471ad05a6bce1a.

Extends the existing selected-run result with a searchable bounded manifest, inert text and diff previews, exact source/run/hash checks and authorized original downloads. Provider output, automated verification, outcome review, source deliverables and publication remain distinct.

All 11 canonical pnpm check gates passed on the same 7,289 physical files as
locked install/build/lint and native acceptance. SHA-256: 88a0fd91e78bd161654d120c71ac0ee3662ce9f06ea2153807d930b28d9c7dba.
Node: 3230 total / 3165 passed / 65 skipped;
zero failed, cancelled or todo. Rust: 881 passed / 576 ignored / zero failed
across 41 summaries; the native EVM gate separately passed one case.
Focused regressions: 86 passed, zero failed or skipped.
Counts overlap and must not be added together.

Native acceptance passed 10 top-level checkpoints, with 5
retained original screenshots. See native/, implementation-self-review.json and
summary.json for exact acceptance mapping and the synthetic/native distinction.
All owned services were stopped and fixture data preserved.

The final commit did not exist during execution. This packet was assembled afterward.
Separate evidence validation must prove original bytes, reconstructed tree, all 11
gate arguments and full Node discovery unchanged, and check documentation and privacy.
Original/published hashes describe every copied artifact; private credential files
and preparation logs are excluded. Existing evidence is preserved byte-for-byte.

Acceptance evidence:
- Manifest search, bounded pagination, changed-file summary, exact identity and check binding: focused model/hook/component regressions, native synthesis manifest/text/diff checkpoint and the labeled 249-file synthetic browser case.
- Provider output versus source/verification/outcome review/PR/deployment: selected-run rendering and native provider-only root versus completed synthesis; no source substitution for historical roots.
- Existing signed scoped APIs only: same-origin no-redirect/no-cache read path, precise artifact identity and retention checks; native authorized original-byte download and current-room/guest denial.
- Inert preview and explicit unsupported/binary/redacted/oversize/expired states: focused cases plus 12 labeled synthetic browser cases, including script markup rendered as text, file/artifact hash mismatch and retention expiry.
- Exact existing outcome decisions and requester eligibility: native exact review requests and scripted eligible Bob decisions; no per-artifact decision creation or human-approval claim.
- Large manifests, wrong version/hash, historical selection, revoked scope and late responses: native checkpoints and separately labeled browser cases; 390px keyboard/reduced-motion geometry and captures.

Limitations:
- This branch was validated on PR385 at c54e25b08276d29a7c6d514fcef593fb06e57fec plus only this issue's code. It excludes the later history SQL/logging corrections and other UI branches; integration requires fresh combined-source validation.
- Development authentication, owned PostgreSQL and deterministic fake-process native runner; no production OIDC, vendor inference, production grants, deployment or real GitHub effects.
- Two development Bob decisions are scripted fixture decisions, not independent human reviews. Assistant review cannot serve as self-approval.
- Synthetic browser responses or synthetic cancelled ledger rows are explicitly labeled; they do not establish corresponding provider or server behavior.
- Final canonical completion is recorded separately from earlier timestamped statements that it was running. Retrospective regressions do not invent historical development chronology.
- Node skips and Rust ignored cases are not passes. Focused, canonical and native counts overlap and must not be added.
- Organization Actions is disabled. Hosted CI, CodeQL, code-quality and security gates remain required; no merge or issue closure is claimed. Historical Cargo advisory debt is not a clean audit.
- Native attempts r1-r3 were unsuccessful fixture-driver attempts and remain retained; r4 used separate documents and verified descriptor digests for all 12 synthetic cases.
- The prior visual receipt says original detail in two notes; the available image rendering was scaled. Treat those as scaled spot inspections, not full-resolution or exhaustive accessibility certification.
- Limits are explicit: 16 MiB artifact, 128 KiB preview, 10,000 manifest entries and 40 pages. Large original downloads use the existing authorized endpoint.
