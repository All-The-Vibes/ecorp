# TDD remediation (explicit fix mode only)

Before work, record the authorized PRs, branch-write scope, runtime-confirmed
model, remaining budget, and stopping bounds. Default to at most **3 review/fix
rounds per PR**, **2 concurrent fixers**, and stop after **2 rounds with no
verified progress**. Use a smaller host/user budget when present. Bounds survive
handoff/resume; do not reset them or silently increase spending. Review every
inventoried PR even if one PR's remediation is blocked.

Use native subagents, one independent issue per fixer with a non-overlapping
write set. Serialize issues sharing files or dependencies. Each assignment
contains the finding, exact SHA, permitted paths, acceptance test, and budget.
Fixers must not revert teammates' changes or approve their own work.

For each issue:

1. Trace the shared root cause and callers. Add the smallest regression test in
   the existing test harness. Run it against the buggy revision and retain the
   **expected failure** (not an environment/setup failure).
2. Make the smallest correct fix in an isolated worktree. Run the regression
   green and the affected suite. Refactor only while tests stay green.
3. Integrate non-overlapping fixes, then run combined regression and repository
   checks. Two fresh independent Santa reviewers check the resulting exact diff
   and evidence using the same rubric and no access to each other's findings.

For prose/configuration issues use a failing link/schema/contract check when
appropriate; otherwise document why executable TDD is inapplicable and retain
before/after independent review evidence. Never invent a red test.

Re-read the remote head before any authorized push. Stop on concurrent changes;
never force-push, overwrite another author's work, or push to the base branch.
Keep dirty, committed, and unverifiable worktrees and all failed evidence.
Publishing fixes is not authority to merge, auto-merge, deploy, or resolve a
human's approval on their behalf.

After integration repeat rubric → security/Ponytail/Santa audit → TDD correction
at the new head, within the original bounds. Preserve the finding ledger and all
review/test receipts. On a denied capability, exhausted budget, unresolved
conflict, or bound, return remaining findings with BLOCKED rather than silently
substituting serial self-review, a model fallback, or fabricated NICE.
