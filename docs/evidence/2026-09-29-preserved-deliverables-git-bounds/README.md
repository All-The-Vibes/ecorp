# PR381 bounded native Git output repair

The private deliverable Git adapter now reuses the existing bounded native-Git implementation. Index inventory and cached deletions cannot allocate unbounded output before checkpoint path validation. The existing 16 MiB stdout limit, 64 KiB stderr limit, 30-second timeout, Windows Job Object ownership and awaited cleanup apply; streaming pack limits are unchanged.

This packet records the repair for ECORP-381-001 on parent `361632cf5d70850f28695bd42c2ba178669cd09c`, intended main `878a1774774b0630c904cbaf4b05e1b346777817`, and tested tree `d52c0acf06eda38cb2cadf43fa592373500305fd`. All 7265 physical source files were identical across canonical r6, rebuilt acceptance r5 and browser r14. The four-file repair and this separately checked evidence are added after the original PR381 publication; the original evidence packet is unchanged.

## Observed current-source validation

All eleven `pnpm check` gates passed with locked dependencies, including state-audit compatibility, the EVM gate and complete Node discovery. Node: 3112 total, 3047 passed, 65 skipped, 0 failed, 0 cancelled, 0 todo. Rust: 892 passed, 576 ignored, 0 failed, 41 result summaries. Full name/argv and output receipts are retained.

Fresh controlled browser-to-server-to-runner acceptance rejected narrowing before effects, retained the native session/worktree, accepted a complete-scope evidence correction, required fresh verification, exported the complete bundle and independently passed all four application tests. Six screenshots were inspected. Source, binaries and owned process cleanup were verified.

## Retrospective regression history

Two real-Git cases stage 9,000 long paths beyond the byte bound without creating physical files. Against the old adapter they failed (2 passed, 2 failed). The repaired adapter subsequently passed 4 focused and 43 deliverable cases. Those runs preceded the final Clippy-only test assertion correction; canonical r6 re-executed the current tests. Failed preflight r5 and the original red receipts remain visible. Earlier SQLx and parity results belong to the original PR candidate and are not reported as reruns of this repair.

## Limits and publication status

- Required hosted CI, CodeQL, code quality, security and review gates remain mandatory; local success does not authorize a merge without them.
- Controlled acceptance uses development authentication, real native server/runner/exporter, Edge and a deterministic native Codex protocol fixture; zero vendor inference calls or GitHub mutations. This does not establish production OIDC or original issue88 lineage.
- The historical full-ECorp target exceeded its 60-second checkpoint read deadline. This small scenario does not establish large-workspace performance; the safety bounds remain in force.
- Canonical Windows Rust tests used RUST_TEST_THREADS=1. Issue213 remains open and its original parallel-failure cause remains inconclusive.
- Canonical ignored/skipped cases remain reported. Earlier SQLx and parity receipts are preserved as older-source evidence, not claimed as current repair executions.
- Historical Cargo advisory debt remains 12 advisories (2 high, 1 moderate, 9 low); this packet does not claim a clean dependency audit.

No independent approval, merge or issue closure is established by this packet. Profile roots are redacted in parsed JSON strings and text; manifests keep original and published hashes separately. Helper snapshots use `.txt` so they do not change Node test discovery.

Published historical logs normalize trailing whitespace and extra terminal blank lines. Original execution logs and their hashes remain unchanged; the first publication whitespace-check failure is retained in the run record. No test was rerun or reclassified by this packaging correction.

The second publication check flagged 300 path-keyed file digests as generic API keys. Every alert was verified against the actual unchanged file bytes. The three historical JSON receipts now represent both source manifests as explicit `files` arrays with `path` and `sha256` fields. All paths and digests are preserved; original execution receipts remain unchanged. No ignore or scanner policy was changed. The failed scan and metadata-only triage are retained.
