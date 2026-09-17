# Persistent Astra PR executor — implementation checkpoint

This extends PR #304 beyond the shared review instructions. The former
read-only heartbeat `monitor-ecorp-pr-review-workflow` was deleted through the
native app API and its configuration-file absence was checked.

## Execution path

The implementation uses an existing Codex task, its native heartbeat scheduler,
GitHub CLI, native worktrees and native Astra agents. It does not add a daemon,
GitHub App, API key, privileged Actions workflow or ECorp Factory mission.

- The read-only snapshot helper exhausts open-PR and review/check pagination.
  It tracks base/head, feedback and gate changes. An incomplete top-level listing
  fails; a per-PR detail failure remains an explicit blocked item without hiding
  other PRs.
- The state helper persists claims, bounded rounds, findings, publication and
  receipt references outside PR worktrees. Atomic replacement and exclusive
  local locking preserve uncertain/interrupted work rather than resetting it.
- The executor procedure actually dispatches issue-scoped TDD fixers and two
  fresh independent reviewers, publishes authorized corrections, then resumes
  against current CI and automatic Copilot feedback.
- Canary acceptance precedes broad intake. It requires actual model/fixer/audit/
  reviewer/push/CI/automatic-review evidence plus a scheduled wake, persisted
  resume and quiet unchanged follow-up.

The scheduler is local: the designated computer and Codex app must stay
available. There is one executor host per repository, not distributed locking
across teammates' installations. Worktrees are change isolation, not an OS
sandbox. Fork/deleted-source PRs remain visible but cannot run with this host's
credentials; they require a separately safe execution environment.

## Runtime and tests

Native session metadata confirmed `gpt-6-astra` for the existing task and a
native child. The runtime's selected provider is configured on this host;
metadata is not independent attestation of the backend behind that provider.
The desktop task's actual policy is full access, not a restricted sandbox.

A default-provider CLI probe made with `--ignore-user-config` failed because it
discarded the host's configured provider. Its failure is retained; it is not
evidence that the already-running native Astra task is unavailable. No new
credential was created, no model substituted and no permission bypass enabled.

The live snapshot inventoried **17 open PRs** on September 16, 2026 (local time),
including drafts, forks and stacked targets.

Issue-scoped Astra workers reproduced and corrected two concrete intake defects:

1. Missing pagination envelopes were mistaken for an empty repository.
2. One PR's inaccessible detail endpoint could prevent processing the rest.

Expected red and subsequent green outputs are retained separately.
`node --test .github/skills/code-review/tests/*.test.mjs` passed **25/25 tests**.
The state
suite additionally exercises restart/lock/corruption handling, stale revisions,
gate-only resume, monotonic bounds, publication reconciliation and fail-closed
receipt/activation validation. CI runs all review-package tests, not only the
upstream dependency integrity test.

The six repository baseline checks passed locally for this extension:
migration validation, Rustfmt, Clippy with warnings denied, workspace tests,
web build and web lint. Rust results were **547 passed, 323 ignored, 0 failed**;
ignored integration/platform tests are not claimed as passed. This change does
not alter application behavior or require starting the manual office.

## Acceptance boundary

This committed checkpoint is **not** a claim that the persistent canary has
completed, that broad intake is enabled, or that every open PR is NICE.
New-head CI, automatic Copilot review and native scheduler-wake receipts can
only be recorded after deployment/publication. Keep their actual receipts in
the executor state directory and publish a current PR report without rewriting
history to imply that later evidence existed at this commit.

GitHub's built-in Copilot reviewer retains its own model selection. The separate
executor uses Astra; neither its technical Santa verdict nor a bot comment
supplies required human/team approval, marks a draft ready, merges or deploys.
