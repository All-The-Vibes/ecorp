# Issue 172 evidence reconciliation

Read-only follow-up to the earlier native acceptance design. No new acceptance execution, issue closure or product change is claimed.

The current main tree contains `docs/evidence/2026-09-12-scheduler-standalone-acceptance.md` and its source-bound machine receipt. It records 7 issue172 and 9 issue171 regressions passing. The linked `2026-09-12-pr-stack-acceptance.md` and machine receipt record two native runners connected to the same source tuple, preserved four-run recovery history and signed source download, ordered replay after sequence 94 through 99, and exact temporary peer revocation/cleanup. This supersedes the September 7/8 two-runner retention blocker. The historical failed bridge and extra diagnostic remain historical records, not retroactive passes.

The September 12 live lane explicitly excludes persistent command-failure injection into a vendor runner. The issue's original acceptance requests bounded failed-representative fairness, epoch/admission fences and regression cases; it does not require vendor inference. Do not invent a vendor-specific completion criterion or repeat the old bridge blocker. The previously drafted fresh local fault-injection scenario would add new current-source coverage rather than recreate September 7 acceptance.

Current source, exact original PR merged state, substantive review resolution and current validation must be reconciled before completion. Issue 82's active canonical run and source files are preserved. No additional Cargo or service fixture is started while that run owns its target.
