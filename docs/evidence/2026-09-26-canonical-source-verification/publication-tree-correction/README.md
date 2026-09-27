# Publication imports retain the verified Git tree

Review thread PRRT_kwDOUIQ-ns6mbriF on parent 1b5648475ad845f30afd745aae41fe96ad1d0be4 identified
a publication boundary gap: the CLI checked the bundle head and base, but did
not compare the imported tree with the canonical verified tree.

The trusted publisher now retains canonical field presence and uses the existing
SourceVerification parser to validate the paired identity and authorized base.
Ownership-qualified bundle refs require the identity. Historical HEAD and run-only
refs remain compatible only when both canonical fields are absent; null, partial
and malformed supplied identities fail. After importing the exact bundle commit,
native Git resolves its tree and the publisher compares it with the verified
tree before pushing or adopting a branch or PR. Export metadata may change while
the tree stays identical. Existing digest, single-head, namespace, remote-base
currency, ancestry and durable effect guards remain.

Four real-Git import regressions cover local SHA-1 and SHA-256 repositories,
base prerequisites, amended export metadata, wrong trees and malformed identities.
Retrospective red: 2 passed, 2 failed, 0 ignored, 141 filtered. Green: 4 passed,
0 failed, 0 ignored, 141 filtered. These executions followed the review finding;
they do not describe the original development chronology or full-stack acceptance.

Locked pnpm check passed all 11 current named gates on parent 1b5648475ad845f30afd745aae41fe96ad1d0be4,
candidate tree 699b686d53daa61d619bb91c6fc7f34fec48a244.
Full Node discovery: 3091 total, 3026 passed,
0 failed, 65 skipped,
0 cancelled and 0 todo.
Rust: 862 passed, 0 failed,
558 ignored across 41 summaries.
The EVM result is separate. Skips and ignores do not establish acceptance.

Fresh native Windows publication acceptance used matching CLI/server/runner
binaries, a fresh owned database, local Git and deterministic GitHub. Its original
assertions exercise publication and recovery, and the receipts preserve source,
binary, fixture and cleanup identities. Only fixture paths were adapted.

Earlier Edge-to-server-to-runner verification/export and graph/readiness/identity/
budget results remain in ../windows-transfer-correction. They retain their actual
r11 identities and screenshots. source-equivalence.json names the three changed
paths and preserves the earlier scheduler/budget/correction chain; all other
product and fixture bytes are unchanged. Those earlier executions did not rerun.

The publication commit adds only separately checked evidence after the tested
candidate tree. Every final-head required CI, CodeQL, quality/security, Windows
acceptance and substantive review remains independently required. Local import
tests do not establish external GitHub SHA-256 support. Deterministic providers,
synthetic GitHub and loopback trust do not establish live inference, deployment,
production authentication, independent human review or OS isolation. Environment
delivery remains reduced assurance. Historical Cargo debt remains 12 advisories
(2 high, 1 moderate, 9 low), with no clean-audit claim.
