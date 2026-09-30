# Guided contract revision and recovery

Issue #262. Observed main and sole parent: 878a1774774b0630c904cbaf4b05e1b346777817.
Tested implementation tree: a66f3fd6c857f30543627b9e895f446904bf8f79.

Guided controls replace JSON-first editing while retaining all 19 supported contract
fields and the exact advanced editor. Drafts keep exact scope, version and immutable
retry bodies. Saving a revision never dispatches or resumes. Explicit reconciliation
and existing native recovery restrictions remain visible.

The server now rejects adding, removing or swapping workspace-connection authority
when revising a preserved run for resume. Regression and native denial evidence are retained.

All eleven final canonical pnpm check gates passed with locked dependencies.
Node: 3139 total / 3074 passed / 65 skipped /
0 failed. Rust: 879 passed / 564 ignored /
0 failed across 41 summaries. The EVM gate is separate.
Model coverage: 499 tests passed across 20 models and 31 test files;
99.66% lines, 97.58% functions, 97.11% branches, with unchanged 99/95/97 thresholds.
Counts overlap and are not additive.

native/browser-report.json records 13 top-level groups and 17 original PNG captures.
The owned browser/server/PostgreSQL/runner fixture exercised actual save, rejection,
response loss, exact replay, stale reconciliation, explicit launch, native Codex
protocol resume, persisted verification, and no-budget denial. The Codex protocol
and inference are deterministic fixtures. Seven recovery presentation cases are
explicitly synthetic. Zero actual human reviews were performed. Services were stopped.

Native r9, coverage r1 and final canonical validation observed the same 7,152
physical files: 18f38ededd67727fba62b364f62a4277f0776dbf1ff80495db01c869b59d6914. The tested tree was reconstructed after process exit
using a temporary index. The final commit did not exist during execution. Publication
adds this evidence packet afterward; its separate validation verifies original bytes,
unchanged full check arguments/Node discovery, documentation and native secret scanning.

Original/published SHA-256 pairs identify every copied artifact. Personal paths and
discovered credential strings are redacted; fixture idempotency identifiers use
stable aliases preserving equality. Private credential files are excluded.
Earlier failed native drivers, the r8 failed browser log and the older baseline
canonical receipt remain historical evidence; they are not final-source passes.

Required hosted validation remains blocked by disabled GitHub Actions. No merge,
GitHub approval, issue closure or clean historical dependency audit is claimed.

Acceptance mapping:
- Labeled fields, inline validation, before/after summary and exact advanced JSON parity: All 19 supported contract fields roundtrip; schema/type/unknown-field errors stay visible and verifier policy uses its existing editor.
- Separate revision editing/saving from dispatch and resume, with exact target and eligibility: Saved revision alone creates no run. Target task/run/version, reason and explicit permitted next action remain visible.
- Plain-language recovery guidance preserves stop, quarantine, budget and controller restrictions: Native no-budget restriction persists; seven explicitly synthetic browser cases confirm stop/quarantine and Factory handoff/error/missing/stale guidance without mutations.
- Do not widen execution authority or duplicate budget semantics: Native resume rejects tool/scope/prohibition/source/connection/budget changes; adding, removing or swapping a workspace connection is now rejected by the store.
- Preserve drafts and exact idempotency through failures and show explicit stale reconciliation: Two requests after committed response loss yield one revision and zero runs. Immutable retry and storage readback protect unknown outcomes; a refused replay remains uncertain.
- Authority, API parity, accessibility and exact native recovery: Actor/Corp/room/mission/task/server scope fences drafts. Desktop/390px keyboard and reduced-motion fixture preserve edits; native server denials and file/test verification retain existing authority.

Qualifications:
- Evidence is retrospective observed validation. This is agent implementation self-review, not independent approval or a human decision.
- The owned PostgreSQL/server/browser path uses deterministic fake-process execution and a synthetic Codex native protocol. No real vendor inference, production OIDC, production grant or deployment is claimed.
- The 13 top-level browser groups include seven explicitly synthetic recovery cases in one group. They are not 13 wholly native tests. Zero actual human reviews were performed.
- Seventeen original PNG captures are retained. Prior scaled spot inspection covered desktop, 390px keyboard and no-budget views; this is not exhaustive pixel or accessibility certification.
- Final canonical, native r9 and coverage r1 used identical 7152-file physical source. The final commit did not exist during execution; this evidence-only addition is validated separately for original bytes, check argv and full Node discovery.
- Skipped Node and ignored Rust cases are not passes. Canonical, focused, coverage and native counts overlap and must not be added. Dedicated live and immutable historical replay lanes remain separate.
- Original locked-install receipts are unchanged. The pnpm receipt included an uppercase hexadecimal log digest. The Steward receipt lacked an installation-time log digest; its retained log bytes were first bound retrospectively during publication preparation, not during installation.
- The first publication packet failed native secret scanning on twelve UUID fixture idempotency keys. That packet and failed validation are preserved privately. Published keys now use stable aliases that retain replay equality; implementation bytes, native receipts and secret-scan policy are unchanged.
- Native r8 failed because the fixture correctly stopped at 6000 used against 5000 allowed. r9 raises only the fixture allowance to 6000 and asserts suspend. The failed attempt remains recorded.
- GitHub Actions remains disabled; required hosted CI, CodeQL, code-quality and security checks remain mandatory. No merge or issue completion is claimed. Historical Cargo advisory debt is not a clean audit.
