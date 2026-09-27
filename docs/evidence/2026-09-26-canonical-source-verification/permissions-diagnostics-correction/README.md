# Permission fingerprints and safe graph diagnostics

Review threads PRRT_kwDOUIQ-ns6mcVx0 and PRRT_kwDOUIQ-ns6mcVyJ identified
private free text in graph failure diagnostics and a mismatch between copied
ignored-file permissions and the permissions fingerprint on parent e9caa3b4580dc73032d3498881940a9785e67737.

Graph failure output now contains validated UUIDs, known state values and
bounded run entries. Free-text summaries and workspace details are omitted.
Assertions check booleans so an unexpected response cannot disclose its value
through the assertion object's actual field.

Ignored-file opening uses the existing native no-follow capability and checks
opened identity, size and permissions against the captured directory metadata.
Copying and fingerprinting use one captured permission value. Windows conversion
uses the destination handle, avoiding a reread from the mutable source. Unix
fingerprints retain all 0o7777 permission bits.

Retrospective diagnostics: red 12 passed / 4 failed; green 16 passed / 0 failed,
with zero skipped, cancelled or todo. Native Windows permission regressions:
red 1 passed / 2 failed; green 3 passed / 0 failed; zero ignored and 307 filtered
across two summaries. These are new regressions after review, not historical
development claims. Unix-specific execution remains a final-head hosted gate.

Canonical r13 passed migrations, state-audit compatibility/EVM, both documentation
gates, Node discovery (3,029 passed, 65 skipped, zero failures) and Rust formatting,
then failed Clippy on Windows-only test cleanup clearing a readonly attribute.
Its Rust workspace tests and web build/lint gates did not run. The original failed
driver, report and logs are retained as preceding-canonical artifacts. A scoped
Windows-only lint exception corrected that cleanup statement, and the subsequent
locked/offline full-workspace Clippy preflight passed on this candidate. Its
receipt and log are retained separately; neither replaces the new complete run.

Locked pnpm check passed all 11 current gates on candidate tree
4a83a09cd20c83c457fe960b58ce1c5c34cb7152 with published parent e9caa3b4580dc73032d3498881940a9785e67737.
Node discovery: 3094 total, 3029 passed,
0 failed, 65 skipped,
0 cancelled and 0 todo.
Rust: 865 passed, 0 failed,
558 ignored across 41 summaries.
The native EVM gate is recorded separately. Skips and ignores are not acceptance.

Fresh source-bound Windows fixtures exercised graph completion, controlled runner
readiness, identity lifecycle, budget breakers and publication/recovery with
matching native binaries and fresh owned databases. Fresh Edge/server/runner
acceptance observed a CRLF failing mission and an LF passing mission, downloaded
and imported the actual bundle, checked signed provenance and exact Git tree,
and denied an outsider with HTTP 404. The accepted export added migration 57
while preserving all 56 historical migration hashes. Four screenshots were
visually inspected; their original bytes and review are included.

Earlier scheduler and aggregate-budget/task-correction acceptance keeps its
original identity through source-equivalence.json. The canonical tested source
precedes this evidence-only packet; separate publication checks verify its
bytes, docs, scan and unchanged full command plan. Final-head CI, CodeQL,
security, review resolution, exact-head merge and issue-state verification remain
independent requirements.

Deterministic providers, synthetic GitHub and loopback trust do not demonstrate
live inference, deployment, production authentication, independent human review
or OS isolation. Environment delivery remains reduced assurance. Historical
Cargo debt remains 12 advisories: 2 high, 1 moderate and 9 low.
