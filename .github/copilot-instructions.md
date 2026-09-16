# ECorp Copilot review

For every pull request, use `.github/skills/code-review/SKILL.md` in its
read-only review mode. Read `AGENTS.md` and the referenced product, architecture,
security, and evaluation contracts. Review the exact PR head against its actual
target branch, including draft, fork, documentation, and stacked PRs.

Use the applicable PR-template rubric and the packaged audit dependencies.
Report missing evidence or unavailable tools as BLOCKED; never invent audit
completion, executed tests, an independent Santa NICE verdict, or approvals.
Separate pre-existing whole-repository debt from issues introduced by this PR.
Include the `ECorp code-review` label and reviewed head SHA in the summary so
maintainers can verify that this workflow was used.

Automatic review is not permission to modify branches, run fixers, merge,
deploy, expose credentials, or bypass repository policy. Explicit remediation
requests use the skill's bounded TDD/subagent fix mode in isolated worktrees.
