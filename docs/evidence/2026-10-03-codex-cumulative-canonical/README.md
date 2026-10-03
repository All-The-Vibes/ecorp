# Canonical validation for the cumulative usage correction

This archive contains the actual `pnpm check` receipt, complete log,
machine-readable report, locked-install logs, before/after and staged physical
manifests, and the implementation commit/review receipts. The
[evidence index](evidence.json) identifies each original and published SHA-256.

Validated implementation: `9cbac5bb6fd5892799f1ec668c9cd6955e20ec6c`.
Validated staged Git tree: `8374dfc972872a54616181b4eded7c6c0976955f`.
Physical fingerprint: `6cf180134972b9384be05515e9e878fb3d29e5c63ee6b37e601a835026e1824a`.

All eleven named gates passed: migrations, state-audit compatibility, EVM,
both documentation gates, full Node discovery, Rust formatting, clippy,
workspace Rust tests, web build and web lint. Node: 3040 passed,
0 failed, 65 skipped, 3105 total,
0 cancelled and 0 todo. Workspace Rust:
941 passed, 0 failed and 596 ignored.
The separate EVM gate reports 1 passed, 0 failed
and 0 ignored. Skipped and ignored cases are not passes.

The run completed before committing the frozen implementation tree. Its
[commit receipt](implementation-commit.json) proves that the tree and physical
source stayed identical. This separate documentation-only branch contains the
result outside the source it validates. The result is attributed to the named
implementation commit, not to this archive's own tree. Only evidence files are
added; no executable source or test-discovery input is changed.

Text copies use the declared root/operator/example substitutions, UTF-8/LF and
trailing-whitespace normalization. Original physical file digests remain in the
manifests; published copies carry separate hashes. Private fixture credentials
are excluded. Earlier report paths in the wrapper receipt only distinguish the
new report from previous attempts and do not make those attempts part of this run.

The implementation's [cumulative consistency packet](../2026-10-03-codex-cumulative-bounds/README.md)
contains the red/green reproduction, two complete native SQL lanes and seven
actual browser/server/runner scenarios. Its historical late-replay packet
separately publishes the earlier canonical result for the earlier commit.

Issue #236 remains incomplete and PR #402 remains draft, stacked on unmerged
#392. Hosted Actions, CodeQL, security and code-quality gates are unavailable;
local checks do not replace them. Independent outcome review and the remaining
auditor-extension feature are still required. No merge, issue completion,
provider inference, billing assurance or clean Cargo audit is claimed.
