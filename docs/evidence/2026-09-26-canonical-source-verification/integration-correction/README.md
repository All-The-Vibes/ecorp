# Portable bundle compatibility and current validation

The native publisher now accepts both historical run-only references and the
current refs/ecorp/deliverables/<32hex>-<32hex> form emitted by the runner. Exact
namespace, single-head, verified commit, base and ancestry restrictions remain.
The Linux hosted publication failure exposed this concrete incompatibility.

The Windows graph fixture now includes bounded persisted failure metadata when
the mission fails. It does not change execution or replay semantics. The original
hosted Windows failure cause remains unestablished by that older log.

The current canonical command ran on parent 68d044d224593caaed42c4cdbde846b97882ffe5, candidate tree
05e59e67ec9d2629ff28d471d55eecaf2d303aee, with locked dependencies and all 11 named gates.
Node: 3091 total, 3026 passed,
0 failed, 65 skipped,
0 cancelled, 0 todo.
Rust: 855 passed, 0 failed,
558 ignored across 41 summaries.
The EVM gate is recorded separately. Skips and ignores are not executed acceptance.

Fresh native Windows publication and the original external-adapter validation
driver passed on matching CLI/server/runner binaries with fresh owned databases
and synthetic repositories. The graph evidence consists of five scenario reports
and the lifecycle summary. Exact source/binary preservation and owned-process
cleanup are recorded. These fixtures use deterministic providers and fake GitHub.
They do not establish live inference, production authentication, deployment,
independent human decisions or OS isolation.

The focused bundle regression failed before the parser fix, then passed 9 cases
with 132 filtered. Graph diagnostic regressions failed 2 cases before the change,
then passed all 13 cases. Original logs, source hashes and patch representations
are preserved; these new regression observations do not rewrite original
development history.

source-equivalence.json distinguishes the earlier native/browser observations
from this current canonical/native run. All other original physical source files
are unchanged. The earlier #82/#172 evidence remains in ../process-cleanup.
The separate budget-and-correction acceptance packet covers #56, #221 and #224
on the earlier recorded tree and includes this same equivalence manifest.

Publication adds only separately checked evidence after the tested tree.
Final-head hosted CI, CodeQL, code-quality/security, substantive review, merge
and issue closure require their own verification. No self-approval is claimed.
Environment-only database delivery remains reduced assurance. Historical Cargo
debt remains 12 advisories (2 high, 1 moderate, 9 low).
