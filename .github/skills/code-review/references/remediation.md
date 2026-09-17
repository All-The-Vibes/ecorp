# TDD remediation (explicit fix mode only)

Before work, record the authorized PRs, branch-write scope, runtime-confirmed
model, remaining budget, and stopping bounds. Interactive fix mode defaults to
**3 review/fix rounds per PR**, **2 concurrent fixers**, and **2 rounds with no
verified progress**. For the explicitly authorized persistent executor,
[executor.md](executor.md) replaces per-PR round approval with **3 new rounds
per native wake** under the ongoing request. It never asks permission for each
routine review/fix cycle. Cumulative history and the no-progress breaker survive
wakes and handoffs. Smaller host/user budgets still apply. Review every
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
at the new head, within the applicable bounds. Preserve the finding ledger and
all review/test receipts. Exhausted native-wake capacity is WAITING for automatic
continuation, not a new permission request. A denied capability, exhausted
host/user budget, unresolved conflict or no-progress stop is BLOCKED; never
substitute serial self-review, a model fallback, or fabricated NICE.
