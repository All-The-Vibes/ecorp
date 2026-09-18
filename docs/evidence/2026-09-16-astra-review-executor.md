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

## First independent review and correction

The first candidate, `1346f57385807f6122b8fc7322bc315237cf17c8`, passed
25 package tests but failed the actual ATV audit and both independent Astra
Santa reviews. It was not pushed or accepted for broad intake.

Seven distinct findings were retained after deduplication: same-revision retry/
recovery, safe diagnostics, incomplete reviewer rubrics, publication lineage,
unprocessed-feedback activation, external gate refresh, and resumable fork
read-only review. Separate workers corrected the intake and state paths, with
red/green regressions and serialized changes for shared state code.

The corrected package suite passed **57/57 tests**, including the full synthetic
bootstrap → retry → reviewed policy update → push receipt → feedback → acceptance
sequence, transient-block recovery, and feedback arriving during push readback.
These are executable regression tests, **not live push, scheduler or CI receipts**.
A copy of the real retained journal also replayed without changing its original
bytes, active claim, round count or unresolved findings. No state reset or new
budget was used.

Original failures and subsequent results remain in the executor's receipt
directory. The corrected exact commit still needs fresh independent reviews,
real publication and the live canary evidence before broad activation.

### Integrated validation — September 17

Three additional legacy-target regressions initially failed: older claims lack
`baseRef`, so recovery/publication rejected its first observed value. The repair
preserves that unknown historical target, requires a gate acknowledgment for the
new observation, and still rejects changing a previously known target. A new
charged round binds the fresh inventory rather than retaining an obsolete one.

The integrated suite then passed **58/58 tests**, and all six baseline repository
commands passed again. Workspace Rust results remain 547 passed, 323 ignored,
0 failed. Earlier failed outputs are retained.

The following images were captured from a real browser rendering summaries of
those actual local command logs. Each includes its source-log SHA-256 and
observed exit code. They are **log-summary screenshots, not application UI,
hosted CI, or live scheduler acceptance evidence**. No application behavior
changed, and the manual office was not started or modified.

| Check | Screenshot |
|---|---|
| Review package, 58 tests | [Package tests](assets/astra-review-executor/01-package-tests.png) |
| Migration validation | [Migrations](assets/astra-review-executor/02-migrations.png) |
| Rust formatting | [Rustfmt](assets/astra-review-executor/03-rustfmt.png) |
| Clippy | [Clippy](assets/astra-review-executor/04-clippy.png) |
| Workspace Rust tests | [Cargo tests](assets/astra-review-executor/05-cargo-tests.png) |
| Web build | [Web build](assets/astra-review-executor/06-web-build.png) |
| Web lint | [Web lint](assets/astra-review-executor/07-web-lint.png) |

### Third-round local validation — September 17

Both second-round Santa reviews returned FAIL despite 58 passing tests. Their
three remaining defects were corrected with separate issue-scoped workers:
current-generation CI binding, strict admission of new review/fix attempts, and
recovery of a blocked claim before its first round was charged. Legacy journal
bytes and previously consumed rounds remain intact.

The integrated implementation also has an explicit read-only metadata gate for
new feedback on already dual-reviewed, unchanged code. A fresh native Astra
checker must verify the exact feedback generation and template applicability.
No-actionable feedback retains the original code reviews and push; actual code
findings return to the original bounded loop. This is not a fourth code-review/
fix round, does not permit edits or publication, and cannot waive current CI.
Blocked metadata assessment releases the writer while retaining its pending
generation and report.

Final local checks passed **86/86 Node tests** and all six baseline commands
again, including 547 Rust passes and 323 explicitly ignored tests.
[The latest Node log-summary capture](assets/astra-review-executor/08-package-tests-round-3.png)
is retained alongside the earlier captures. Red/green regression logs and the
original failed review reports are preserved outside PR worktrees. These local
results still do not claim fresh third-round Santa approval or live canary
acceptance; those receipts must be observed separately.

### Local legacy repair — canary still blocked

Both third-round Santa reviewers and the audit reproduced one remaining
legacy-retry deadlock on the complete seven-event checkpoint. The recorded
canary stopped at its original three-round limit; it was not published,
accepted or reset.

The implementation was subsequently repaired locally. The retry guard now
recognizes a post-failure `fixing`/`auditing` receipt whose version is derived
from validated version-1 history. It still requires the original failed-review
evidence, owner, claim and round, and consumes a real permitted next round.
New version-2 corrections cannot manufacture that provenance or bypass retry.

The complete original checkpoint, pending-verdict variants, and block/resume
paths pass their regression tests without truncating any original event.
The full local suite passes **94/94 tests**, and all six baseline checks pass
again. A copied-state diagnostic confirms the repaired helper still refuses
the exhausted live canary's fourth round; the real journal remains unchanged.
[The local repair capture](assets/astra-review-executor/09-legacy-local-repair.png)
is a log-summary screenshot, not an additional review or live acceptance.

No additional canary review, new limit, policy adoption or push is claimed.
Operator authorization for one more bounded canary round remains pending.

### Autonomous continuation — September 17

The operator clarified that the executor must run autonomously without asking
permission for ordinary audits, fixes and re-reviews. The per-three-round manual
approval gate was an implementation mistake, not a GitHub or Codex requirement.
The original three failed rounds and their evidence remain retained. The native
goal was resumed without resetting its accumulated history.

The journal records the ongoing authority once. Each genuine native wake can
charge three new rounds; a later wake continues automatically while cumulative
PR rounds remain intact. Replaying a wake cannot replenish its batch, and wakes
cannot reset the two-no-progress breaker. Genuine stalled work remains visible
while other eligible PRs proceed. No merge, credential, account-limit or
security-boundary changes are implied.

The corrected suite passes **106/106 Node tests**, including all original 94,
and all six repository checks pass. The actual retained journal also continues
on a copy without rewriting its original events or changing the live journal.
[The current browser capture](assets/astra-review-executor/10-autonomous-continuation.png)
shows the actual local log summaries and hashes; it is not application UI,
hosted CI or scheduler acceptance. The optional skill-creator Python validator
could not start because the host lacks PyYAML; the repository's native package
tests validate this skill's frontmatter, references and pinned dependencies.

This continuation is not a claim of independent PASS, publication, live CI,
automatic Copilot review or repository-wide activation. Those results must be
recorded from actual execution after the corrected candidate is reviewed.

### Autonomous correction after independent review

Both fourth-round Santa reviewers rejected `7498b4b` on two concrete startup/
recovery gaps: a previously unclaimed round-limit stop could hide pending work,
and an authentic ongoing request predating journal creation was rejected.
The actual ATV audit additionally found an unfenced second target observation
for legacy claims and malformed detail rows accepted as ordinary fingerprints.
Its separate whole-repository findings remain base debt, not silent expansion
of this contributor-workflow PR.

The executor retained these failures and automatically charged round five under
the existing ongoing request, without another operator approval. Separate
issue-scoped Astra fixers reproduced each defect before correcting it. Unclaimed
pending work must receive a fresh current-scope audit, authentic request times
remain unchanged, the first known legacy target fences later operations, and
invalid detail payloads block only their PR using typed diagnostics.
Historical journal events remain retained; stricter live admission is not
permission to rewrite earlier attempts or claim that they passed.

The integrated correction passes **136/136 Node tests** and all six baseline
checks (547 Rust passes, 323 ignored). An actual read-only snapshot of ten open
PRs passed the stricter detail validation without hiding any per-PR errors.
The final helper read the live 30-event journal without changing its bytes,
retaining round five and two native-wake charges.
[The integrated capture](assets/astra-review-executor/11-autonomous-corrections.png)
again shows local logs, not hosted CI, independent approval or canary acceptance.
Those live gates remain pending for the new exact candidate.

### Sixth-round corrections

Both fifth-round Santa reviewers rejected `bfc0573`, despite the passing
136-test suite. One reproduced unnecessary audit charges after a transient
detail-read failure; the other reproduced feedback triage restoring acceptance
from a conflicting legacy publication. The actual ATV/Ponytail audit reported
no introduced blockers at that revision; the independent Santa findings still
prevented publication.

The executor automatically charged the next permitted round and assigned
separate native Astra fixers. Failed reads now retain the prior processed audit
generation, and conflicting historical publications cannot supply new feedback
completion or activation authority. Historical accepted events remain readable
and unchanged; new admission rules do not rewrite their past outcomes.

The integrated result passes **153/153 Node tests** and all six baseline
commands, with 547 Rust passes and 323 ignored tests. Read-only replay of the
real 34-event journal retains round six and all three current-wake charges
without changing its bytes. [The local-check capture](assets/astra-review-executor/12-feedback-recovery-corrections.png)
is evidence of those command results, not an independent verdict or live canary
acceptance. Fresh exact-candidate reviews still precede publication.

### Continued automatically on the next native turn

The actual next native goal turn supplied a new recorded wake identity; the
original claim resumed and charged round seven without another user decision.
Three independent issue fixers addressed the sixth-round findings: recovery
from an old-policy failed-read checkpoint, fresh execution relying on invalid
historical activation, and continuation of an already-charged unfinished
attempt at its final permitted charge.

The integrated result passes **185/185 Node tests** and all six baseline checks
(547 Rust passes, 323 ignored). A read-only replay preserved the live 42-event
journal, cumulative round seven and one charge in the new wake; no earlier
spending, failed evidence or historical activation was reset.
[The current local-check capture](assets/astra-review-executor/13-native-continuation-corrections.png)
records those results, not scheduled-wake, hosted CI or canary acceptance.
Independent current-candidate reviews still gate publication.

### Unchanged-canary recovery correction

Seventh-round Santa results disagreed: one PASS and one reproduced failure in
the unchanged-canary recovery path. The AND gate remained NAUGHTY. The actual
security/complexity audit found no introduced blocker at that revision; its
separate base-debt findings were preserved.

The executor automatically charged round eight and assigned a native Astra
fixer. Invalid activation now admits bounded corrective work for the unchanged
eligible canary without an unrelated remote edit. The corrective claim is tied
to that activation; interruptions and repeated wakes cannot create free audits,
reset no-progress history, or bypass full new acceptance.

Integrated verification passes **194/194 Node tests** and all six repository
checks (547 Rust passed, 323 ignored). The final helper replayed the real
46-event journal without changing its bytes, retaining round eight and two
charges in the current native wake.
[The current capture](assets/astra-review-executor/14-unchanged-canary-recovery.png)
shows local command results only. Fresh independent reviews and live canary
acceptance remain separate.

### Gate updates preserve unfinished audit work

The eighth-round independent reviews found two remaining recovery defects:
gate-only changes could replace a blocked corrective claim, and a waiting
read-only gate could strand an already-charged final attempt. Their actual
failures remained NAUGHTY despite the passing local suite; the audit separately
reported no introduced security/complexity blocker.

The executor automatically charged round nine and dispatched two issue-scoped
Astra fixers. Matching blocked correction claims now survive gate-only updates,
and final-charge recovery uses retained audit provenance rather than the
read-only gate's presentation phase. Neither correction creates another
attempt, refunds counters, changes earlier events, or supplies missing approval.

The integrated suite passes **207/207 Node tests** and all six repository checks
(547 Rust passes, 323 ignored). Read-only replay retains the actual 50-event
journal, cumulative round nine and all three current-wake charges without
changing its bytes. [The current capture](assets/astra-review-executor/15-gate-retention-corrections.png)
is local command evidence; independent approval, publication and live canary
acceptance are still separate gates.

### Failure provenance and legacy correction bounds

Ninth-round reviews found two retry-accounting defects: a first failure saved
directly as blocked could lose its retry-required provenance, and an old
unmarked correction claim could renew a cycle from invalid historical NICE.
The next native turn continued automatically with issue-scoped TDD corrections.

A new scoped human package/CI comment arrived on the unchanged remote PR head.
It reported no actionable finding and explicitly was not whole-PR approval.
The executor retained that new feedback and the prior blocked claim, then
charged the next audit in the same cumulative cycle; it did not pretend the
old feedback fingerprint was unchanged or treat the comment as Copilot proof.

New first failures must use the canonical reviewing/NAUGHTY admission. Earlier
noncanonical failures remain readable but fence new attempts until a charged
retry. Invalid activation also constrains older unmarked begin/resume paths,
without resetting their original history or preventing legitimate continuation
of an already-charged unfinished attempt.

Integrated checks pass **234/234 Node tests** and all six repository commands
(547 Rust passed, 323 ignored). Read-only replay preserves the real 58-event
journal, cumulative round ten, one current-wake charge, the current feedback
claim and its prior blocked claim. [The current capture](assets/astra-review-executor/16-failure-provenance-corrections.png)
shows those local results, not a current independent approval or live canary.

### Attempt fencing and failed-wait recovery

The tenth-round independent reviewers reproduced stale prior-attempt saves
poisoning a later retry and failed waiting checkpoints losing their resumable
claim. The executor retained both findings and automatically charged the next
bounded correction round. Native issue fixers added explicit live save-round
fencing and retry-only recovery for failed waits, without granting a fresh
attempt or changing completed CI waits.

The audit also identified an exact-byte provenance gap in the earlier
precommit helper replay receipt. That receipt and screenshot remain historical,
not proof of pinned-byte identity. A separate pinned replay was retained, and
subsequent checks retain the actual tested source bytes, their byte hashes and
canonical Git blobs, plus an independent post-commit pinned-helper replay.
No old receipt was rewritten to imply later evidence existed earlier.

The final integrated run passes **255/255 Node tests** and all six repository
checks (547 Rust passed, 323 ignored). The initial integration run's two
historical-fixture serialization failures are preserved; the fixture now
represents the actual older save schema without an undefined new round field.
Exact tested script/test bytes and canonical Git-blob bindings are retained.
[The current local capture](assets/astra-review-executor/17-attempt-and-wait-recovery.png)
shows these results and source binding, not independent approval or live
acceptance.

### Pre-activation correction — September 18

Eleventh-round Santa results were one PASS and one reproduced pre-activation
recovery failure. The failed AND gate prevented publication. A native TDD fixer
extended the existing bounded correction path to a conflicting retained
publication before the first enable event, without manufacturing remote changes
or accepting the historical conflict. Existing after-activation correction,
claim retention, retry accounting and full fresh acceptance remain required.

Integrated verification passes **268/268 Node tests** and all six repository
checks (547 Rust passes, 323 ignored). Exact tested source bytes and canonical
Git blobs are retained, together with read-only replay preserving the real
66-event journal, round twelve and all three current-wake charges.
[The current local capture](assets/astra-review-executor/18-preactivation-recovery.png)
does not substitute for independent source approval or live acceptance.
