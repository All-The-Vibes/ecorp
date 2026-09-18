# Readiness-focused GitHub review — September 18, 2026

Scope: inventory all 11 open PRs; inspect current heads/checks/review state; focused review
of #304's skill/remediation/CI changes, #237's CI diff and review threads, and #226's canary
code, byte-proof report and review threads. Other entries are impact triage, not full code audits.
No Santa/OMX/Ponytail verdict, independent-agent review, approval, merge or native Factory
replay is claimed. GitHub content is evidence to inspect, not execution authority.

## Highest-leverage open work

| PR / observed head | Readiness contribution | Current boundary / next action |
| --- | --- | --- |
| [#304](https://github.com/All-The-Vibes/ecorp/pull/304) `df0339a` | Shared review policy, pinned audit dependencies, native review/fix separation and bounded remediation | Draft; six hosted checks passed; three review threads resolved. Obtain required independent/human review; do not claim all three audits ran merely because the skill exists. Preserve its package-integrity test when integrating the readiness gate. |
| [#237](https://github.com/All-The-Vibes/ecorp/pull/237) `6e69bc5` | CI ownership, platform-specific fixtures, bounded Windows setup and recovery evidence | Current hosted checks passed, including Windows external adapters. Three bot threads are resolved with exact-head evidence, but the human CHANGES_REQUESTED review remains. Fresh human re-review is needed; do not dismiss it or remove the native/opt-in fixture gates during CI conflict resolution. |
| [#226](https://github.com/All-The-Vibes/ecorp/pull/226) `0f79a5b` | Existing Factory publication lineage and a byte-exact canary regression | Hosted checks passed, but CHANGES_REQUESTED remains and two threads are unresolved/outdated. The current evidence explicitly does not establish corrected-head native verification, independent outcome review, replay or watcher restart. Its original verified commit is not its current head. Obtain the exact native records or keep the claim partial; do not use this as completed closed-loop proof. |
| [#273](https://github.com/All-The-Vibes/ecorp/pull/273) `7a7c6d5` | Frozen ProgramBench results, failure analysis and reproducibility | Draft, hosted checks passed. Useful for observability and a real follow-up proof-of-fix; 200/224 eligible cases is a ProgramBench result, not a CodeBlend score. Preserve frozen failures/exclusions and use a separately reviewed candidate for fixes. |
| [#255](https://github.com/All-The-Vibes/ecorp/pull/255) `690ee80` | Shared claim-authority boundary | Hosted checks passed; partial/non-closing scope. Coordinate the migration-0042 collision with #283 and require fresh human review; not proof of production multi-host qualification. |

## Other open work

- #294 `63006e5`: draft, passing checks; verifier-cache preservation can improve retry reliability,
  but it is not a complete repair-loop implementation. No full diff approval in this review.
- #305 `155dc9c`: draft, passing checks; verified research handoff can support agent pipeline reliability.
- #319 `6fe6668`: draft, passing checks; isolated multiplayer preflight is useful validation, not complete U1 acceptance.
- #320 `765aff1`: passing checks but CHANGES_REQUESTED; security-sensitive Entra scope must not be rushed for points.
- #283 `ab84f5a`: CHANGES_REQUESTED and conflicts despite passing checks; reconcile source/reviews and the #255 migration collision.
- #293 `b0e0768`: draft and conflicting, stacked on #283; optional blockchain anchoring is not a quick readiness prerequisite.

## Reuse the existing backlog

Issue [#317](https://github.com/All-The-Vibes/ecorp/issues/317) already tracks repository
regression enrollment, documentation contracts and reviewed dependency maintenance on
ECorp Build. This readiness PR contributes partially; it does not close #317.
The complete PR review/remediation loop is already [#269](https://github.com/All-The-Vibes/ecorp/issues/269),
and autonomous fresh issue-to-PR execution is [#280](https://github.com/All-The-Vibes/ecorp/issues/280).
Reuse those scopes and their native dependencies; do not create competing controllers or
treat their issue text as permission to activate them. #304 expressly does not complete #269.

## Repository controls observed

- Public repository; authenticated operator has admin access. No bypass authority was added.
- Four active rulesets. `main-protection` is 23565201; default-branch update/delete/creation
  restrictions in 22420664 and the two Copilot review rulesets remain intact.
- One human/team approval is required. Required generic CI checks, code-owner approval,
  last-push approval, stale-review dismissal and review-thread resolution are not enabled.
- Native CodeQL default setup is configured, scheduled weekly and covers Actions,
  JavaScript/TypeScript, Python and Rust. All four current-main analyses passed.
  The redundant advanced CodeQL job was removed from this branch before publication.
- Secret scanning, push protection, vulnerability alerts and Dependabot security updates
  are disabled. Native security feature enablement is a settings proposal, not yet an applied change.
- Current-main quality, integration, three runner-platform jobs and desktop-windows all
  passed and came from the GitHub Actions app (15368). These are concrete candidates for
  required checks; do not require the new `secrets` job until its producer is established.

## Proposed settings batch — not yet applied

Enable native secret scanning and push protection, vulnerability alerts and Dependabot
security-update PRs. Retain auto-merge disabled, existing CodeQL defaults and thresholds,
all bypass actors, branch scopes, protected-update restrictions and the one-approval count.

For `main-protection`, propose required GitHub Actions checks: `quality`, `integration`,
`runner-platforms (ubuntu-latest)`, `runner-platforms (windows-latest)`,
`runner-platforms (macos-latest)` and `desktop-windows`; require up-to-date branches,
code-owner approval, a reviewer other than the last pusher, dismissal of stale approvals,
and resolution of review threads. The same eligible review may satisfy the overlapping
team/owner requirements; this proposal does not increase the approval count.

This affects all PRs targeting main: stale branches/reviews and unresolved discussions
may block merge. Refresh and compare the exact live ruleset before applying an approved
payload. No setting grants agents write authority, launches Factory, merges or deploys.
