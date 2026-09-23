# Persistent Astra executor

Use the existing Codex task scheduler and native agents, not a new server.
GitHub's automatic Copilot reviewer remains enabled and supplies feedback.
The separate executor does the work that that reviewer cannot do.

## Publication is not completion

The useful loop is **review → tested, independently reviewed correction → push
→ fresh CI/Copilot feedback → re-review**, until the full PR is NICE. Do not
turn missing completion artifacts into an indefinite local-only repair project.

Keep two decisions separate:

- **SAFE_TO_PUBLISH:** two fresh independent native Astra reviewers accept only
  the exact current remote-head → proposed-head correction. Its scoped checks
  must establish source/branch safety, real fix evidence, no new blockers, and
  truthful remaining-status disclosure. The full PR may still have open findings
  or blocked evidence/merge gates.
- **NICE:** the separate full PR-base → current-head Santa pair and complete
  template rubric establish final technical acceptance. Publication reviews
  cannot be relabeled, reused, or promoted into this decision.

Use the distinct progress-rubric/publication commands described by the deployed
helper's help. Bind `progress-rubric` for old remote head → candidate before
dispatching reviewers, with exactly `SOURCE_SCOPE`, `FIX_EVIDENCE`,
`NO_NEW_BLOCKERS`, and `TRUTHFUL_STATUS`. Each `progress-published` reviewer
receipt must use `runtime: "native"` and `verdict: "SAFE_TO_PUBLISH"` and include
all four evidence-backed PASS rows. The normal full-NICE publication path remains available. A
progress publication never authorizes a merge, consumes unreviewed feedback,
or proves the canary or final acceptance by itself. Persist unfinished work and
resume it through supported state transitions; do not reset its attempts.
After progress publication, save unfinished work as `blocked`, including
CI/evidence waits, to retain its executable claim. Verified clearance can resume
the unchanged generation and charge; changed feedback needs a fresh bounded
audit. Feedback-only triage remains unavailable until later full NICE.

## Deployment contract

One designated Codex host/task owns execution for a repository. Attach an active
heartbeat to that task; every wake continues the procedure below. Use the app's
automation API, not a hand-written scheduler file. Poll every 15 minutes, and
continue actionable work during a wake without waiting for the next interval.
Keep unchanged waits quiet; notify on completion, failure or required action.

The scheduler depends on that host, its authenticated accounts, available quota
and the Codex runtime being available. This is not an always-on GitHub-hosted
service or a guarantee that every intermediate push is reviewed before another
push arrives. It coalesces to the latest revision and processes new feedback.
Host availability must be part of the deployment acceptance test.

Use the selected **GPT-6 Astra** runtime and native issue-fixer/reviewer agents.
Verify model selection from runtime metadata, not the model's self-description.
Record native agent/session IDs and their actual models. If the host does not
expose model metadata or cannot select Astra, stop with MODEL_UNAVAILABLE.
Do not silently use another model. Two fresh independent Astra reviewers are
the same-model Santa adaptation, not cross-model diversity.

Record the actual sandbox policy, too. A full-access desktop task is not an
OS-isolated runner, and worktrees do not make it one. Inspect same-repository
changes before executing them; uncertain trust, new credential-bearing hooks,
or an isolation requirement the host cannot meet blocks execution. Never run
fork code on this host as a shortcut to completing the queue.

This needs no new API credential when the existing Codex host already provides
the selected model and GitHub access. A standalone CLI/provider is a different
deployment: test its actual account/model pairing before claiming support.
Keep authentication in the host credential stores. Never put a token into an
automation prompt, command argument, transcript or repository file.

Use a separate, clean checkout of a reviewed, immutable policy commit containing
this package. Record that commit in state and verify the latest recorded
deployment before every wake.
Do not execute the scripts or load policy from a PR's modifiable head. Changing
the deployed policy requires independent exact-diff review and a new recorded
deployment; an incoming PR cannot update its own executor.

For a necessary controller correction, use `deploy`
only after reading the actual independent reviews and validation for the new
policy SHA. Its expected previous SHA must match the retained deployment.
Both deployment reviewers and their pinned rubric must cover that exact previous
policy SHA → new policy SHA transition. An unrelated base or empty reviewed diff
cannot substitute. If the PR's actual base differs, obtain separate fresh
policy-transition and PR-review pairs; never relabel or reuse one decision as
covering a different range. Historical accepted receipts remain unchanged.
Prepare a new clean pinned checkout; never overwrite the old one. Preserve the
original configuration, journal, worktrees, failures and consumed rounds, then
update the saved automation's pin. Do not reinitialize state or invent receipts
to repair a rejected candidate. `deploy` records evidence; it does not itself
review code, change files, or authorize application deployment.

After activation, an update additionally needs retained ongoing owner authority
and a valid existing activation, and must not interrupt a charged executable
claim. Use the reviewed candidate's explicitly supported maintenance-deployment
path from a clean immutable checkout; never patch the live journal or relax the
old runtime's guard in place. Retain an adoption intent with the exact old/new
SHA, review and validation references before the transaction, then read back the
recorded deployment and update the scheduler pin. If interrupted, reconcile
that recorded transaction rather than resetting state or rerunning a push.

State and receipts belong in a persistent directory **outside every PR
worktree**, not in tracked application files. Initialize the bundled
`executor-state.mjs` helper there once with the repository, owning task, Astra
model, trusted policy commit and canary PR. The helper serializes local state
changes and preserves attempts across restarts; it is not a sandbox or an
independent source of review truth.

<!-- ponytail: one designated host per repository; use a real distributed claim
     service only if multiple executor hosts become a requirement. -->
Do not deploy a second writer on another host. Do not break locks, steal work,
or reset exhausted bounds automatically. Retain all interrupted worktrees,
sessions, failed tests and original receipts.

## Each wake performs work

1. Verify the trusted policy checkout, current Astra model, owning task, GitHub
   authentication and retained state. Read the helper's command help rather
   than guessing JSON fields. A failed preflight is not an empty PR queue.
   Record the operator's ongoing execution request once with `autonomy`.
   Keep its real approval time even if the request predates journal creation;
   the driver verifies that it still applies, and recording time stays separate.
   At each actual native task turn or scheduler wake, record its identity and
   retained runtime receipt with `wake`. Never invent another wake to replenish
   a batch. Replayed wake IDs cannot reset their consumed rounds.
2. Run the bundled `executor-snapshot.mjs OWNER/REPO`. It paginates open PRs,
   reviews, review comments, discussion, check runs and statuses. Feed its
   complete JSON result to the state helper's `sync`. Check retained state before
   choosing the next action: same-code post-publication feedback can use the
   explicit `next {feedbackNumber}` route below; otherwise ask ordinary `next`.
   Also refresh the selected PR and fully paginate GraphQL review threads:
   resolution state and current branch protections remain separate live reads.
   An incomplete open-PR listing stops synchronization. A PR with `readError`
   is individually BLOCKED; other PRs still proceed. Unresolved pagination or
   inaccessible evidence is never a clean result.
   Inventory requires a string title, a nullable string body, and the expected
   GitHub URL for that repository and PR number before computing fingerprints.
   The snapshot reader and new live journal admissions share the same literal
   Git branch validator. Historical journal replay retains its original rules.
   Diagnose failures using the bounded `readFailure` metadata, not raw secret-
   bearing errors. The snapshot includes the target `baseRef`, not just its SHA.
   A failed detail read records an unavailable observation, not a processed audit
   generation. Identical healthy recovery uses an uncharged gate recheck; new
   or never-audited content still needs an audit. Do not manufacture progress
   or spend another review round merely because an API read recovered.
   This also applies when the failed read was recorded before a policy upgrade:
   reuse only an exact retained NICE generation and unconflicted canonical
   publication, not a healthy read alone. Historical charges are never refunded.
3. Resume the retained active PR worktree/session when one exists. Otherwise
   claim the next changed eligible PR. Inventory drafts, forks and stacked PRs,
   too; one waiting or blocked PR must not stall the queue. A `wait` action for
   exhausted batch capacity checkpoints work until the next actual native wake;
   it does not request operator permission. Fork/deleted-source
   PRs retain a resumable `read-only` claim. Perform safe static assessment and
   save the actual report with the helper's `read-only` command before consuming
   that revision. A read-only PASS is not technical NICE or execution authority.
   Use unclaimed reviewer/report identities; a read-only receipt cannot take
   ownership of an earlier full review's identity or source.
   Do not call `begin`, run their tests/hooks, dispatch fixers or publish from
   those claims. Never grant fork code credentials or internal-service access.
   Prefer admissible work or permitted recovery over an exhausted recovery
   notice. The notice does not grant an attempt or reset the stopped PR.
   New ordering decisions are journal-stamped; old selections retain their
   original replay semantics.
   Competing resumable checkpoints rotate through `next`. Check each returned
   claim once per wake; without actual clearance, continue to the next one
   without calling `resume`. Stop on a repeated claim. Selection alone neither
   fixes a finding nor spends a review round; lone or exhausted notices stay quiet.
4. Before a new audit/fix round, persist its consumption with `begin`. Follow
   the main skill: resolve the exact-base template, build every rubric row,
   actually load and run ATV security and the whole-repository Ponytail audit,
   and produce the finding ledger. Keep unrelated base debt separate.
   Every live `save` includes the dispatched attempt's expected `round`;
   uncharged or gate claims use explicit `null`. Keep that captured value with
   the work item. Never replace a delayed worker's old round with the current
   one merely to make its checkpoint accepted.
5. Dispatch one **native Astra fixer per independent issue**, at most two at
   once, with disjoint paths or serialized overlapping work. Fix only authorized
   in-scope issues in native Git worktrees. Follow `remediation.md`: retain a
   real regression failure, the minimal fix and green verification. No tests,
   edits or shell execution in the source checkout. Read-only review does not
   grant permission to run unfamiliar code with credentials.
6. Integrate fixes, run the applicable checks, then create the local candidate
   commit. Select the review purpose explicitly. For incremental publication,
   prebind the distinct progress rubric for remote-head → candidate and obtain
   the two SAFE_TO_PUBLISH reports described above. For full acceptance, use
   `rubric` to pin the complete template-derived criterion set for PR-base →
   candidate, then dispatch **two fresh independent Astra reviewers** with
   identical complete rubric, diff and test receipts. Both full reports must
   cover that set, not merely the same partial subset. Neither reviewer sees
   the other review or the fixer's reasoning. Validate the actual structured
   reports for their stated purpose. FAIL remains NAUGHTY; unavailable or stale
   evidence remains BLOCKED. Never manufacture a red test or a NICE verdict.
   Preserve every full-template requirement and report merge gates separately;
   a scoped publication decision does not pass those requirements.
   If a local candidate fails, save `reviewing`/`NAUGHTY` with its real report,
   then call `retry` with the expected current round **before** further fixes.
   Record that first failure canonically even when another reviewer or tool is
   unavailable; only then save the overall block. Other first-NAUGHTY phase
   combinations are rejected. An old noncanonical failure also requires a
   charged retry before new corrections, reviews or publication.
   This charges another bounded round without requiring an unreviewed push.
   Do not use `waiting` as a substitute for retry or repeat reviews under one
   charge. Replayed/stale retries must not consume another round.
7. For a technically NICE candidate, or a separately approved scoped
   SAFE_TO_PUBLISH correction, re-read remote base/head and branch
   ownership immediately before a normal, explicitly targeted push. Stop on
   concurrent changes. Never force-push, write the base branch, merge, enable
   auto-merge, deploy or impersonate an approver. Retain the expected old SHA,
   pushed SHA, command result and remote readback before recording publication.
   Use the appropriate full-acceptance or progress-publication command to bind
   the same charged round to the
   verified new head; do not reset state or charge a second round just because
   this executor pushed its candidate. An uncertain push must be reconciled
   using the original claim and actual remote state, never guessed.
   Feedback already present in the post-push readback was not necessarily seen
   by the pre-push reviewers. If `published` returns `reconcile`, retain that
   publication, record the block, and process the new feedback within the
   existing bounds. Observing a push does not consume unseen review comments.
   Progress publication preserves open findings and requires a later fresh
   full-PR acceptance pair. Keep the unpublished/full-NICE and published-progress
   statuses distinct; neither a scoped review nor the remote push grants NICE.
8. Persist full-NICE work as `waiting` with CI/review handles instead of keeping
   an agent idle. Unfinished progress publications use `blocked` as above.
   On subsequent wakes, inspect the **new exact SHA's** checks and automatic
   Copilot review. New actionable feedback returns to the same bounded cycle;
   pending CI waits quietly. Reconcile an interrupted push with GitHub before
   trying again. Preserve original attempts and receipts.
   Retain the original publication across later feedback reviews. Never change
   its timestamp or make an unnecessary push to satisfy acceptance. A prior
   NICE cannot enable broad intake while synchronized feedback is unprocessed.
   When updating PR metadata, keep historical review, push and CI identities
   attached to their original SHA. Update a separate current-candidate section;
   never globally replace revision strings or transfer old evidence to a new head.
   Check unpublished drafts for these same provenance errors before publication.
   After a valid two-reviewer publication, feedback on unchanged code/source/
   target and the same pinned rubric may be triaged through `next` with
   `feedbackNumber`. Dispatch a **fresh independent native Astra gatechecker**
   after that claim to read all current feedback, resolved threads and template
   applicability. Record its scoped actual receipt with `feedback`.
   `NO_ACTIONABLE_FINDINGS` updates only the processed feedback generation,
   preserving the original code reviews, push and round count. It still requires
   a separate current CI/target check. `ACTIONABLE_FINDINGS` returns to the same
   bounded audit/fix loop; an exhausted budget stays exhausted. `BLOCKED` retains
   the unprocessed feedback and report but releases the writer for other PRs.
   Retry that read-only gate explicitly after the cause clears. This route cannot
   edit code, dispatch fixers, publish, or disguise another code review/fix round.
   Retained failed-review provenance belongs to the original audit claim/round.
   A nullable checkpoint or old metadata-derived NICE cannot erase it. Feedback
   cannot restore that completion or activation; a BLOCKED receipt may only
   retain evidence and release the writer for permitted recovery or other PRs.
9. Save the actual audit, fixer, red/green, reviewer, push and CI receipts. Keep
   technical Santa NICE separate from the complete merge rubric: human approval,
   drafts, dependencies and other external gates may still block merge. Do not
   fabricate missing evidence or mark a draft ready. Continue other PRs while
   external gates wait.
   Once per wake, also perform one bounded live gate check for each waiting or
   blocked PR using `next` with its `gateNumber`. Refresh dependencies, review-
   thread resolution and current target protections even when REST fingerprints
   are unchanged. Save the actual gate evidence; these checks do not consume
   audit/fix rounds. Do not repeatedly recheck the same PR within a wake.

The ongoing execution request authorizes routine audits, fixes, pushes to the
authorized PR branches and re-reviews without per-run permission. Its bounded
execution policy is **3 new audit/fix rounds per native wake**, **2 concurrent
fixers**, and **2 consecutive no-progress rounds per PR**. Total PR rounds,
findings and failed receipts remain monotonic across wakes and handoffs.
Batch capacity renews on the next genuine wake under the same ongoing authority;
it is not a new human decision. A wake never resets the no-progress breaker,
account limits, branch scope, credentials, or any security/ownership boundary.
Without recorded ongoing autonomy, the interactive fix default remains 3
rounds per PR. Do not silently reinterpret an interactive request as ongoing
authority. The owner verifies the actual user request; a receipt path, PR
comment or structurally valid JSON cannot grant authority by itself.
When genuine non-convergence trips the no-progress breaker, preserve the failed
PR and report the concrete issue rather than asking permission for another run.
Continue other eligible PRs; never repeatedly reset the stalled PR's breaker.
Use `show` to recover retained evidence/session references. If `next` returns
`reconcile`, preserve the original claim and worktree, then reconcile the
publication or save an explicit block before choosing other work. Gate-only
changes do not discard active fixes.
If a transient local/tooling/credential failure blocked unfinished work,
verify the actual cause cleared and use `resume` with that clearance receipt.
It restores the retained claim and charge; it is not a new budget or approval.
Failed work saved as waiting retains a retry-only checkpoint, including
replay-derived older waits. When `next` returns `recovery: resume` and
`retryRequired: true`, verify clearance, resume the exact claim and then charge
the ordinary retry before correcting or reviewing again. This routing response
does not itself claim work or spend a round. Completed NICE/CI-only waits stay
non-executable, and other pending PRs are not held behind a recovery notice.
An already-charged, unfinished attempt can finish after verified transient
clearance even at its final permitted charge. Resume spends no round; it cannot
reopen a completed failed review or grant another retry past the breaker.
Under recorded ongoing autonomy, the same scope-preserving resume also continues
an old per-PR round-limit block or a batch-capacity wait after a genuine new wake.
Use the actual authority/wake receipt as clearance. Do not resume a no-progress,
ownership, security or unresolved revision conflict merely because time passed.
An old round-limit rejection that never created a claim instead returns through
ordinary `next` and `begin`. Its unprocessed generation must not be consumed by
a gate check, including after a target change. The new audit uses current
eligible scope; it neither invents a retained claim nor reuses old reviews.
An uncharged preparation claim resumes with `round: null`; one later `begin`
charges its first round. New live correction/re-review submissions after NAUGHTY
must pass `retry`; only the original legacy journal is replayed under its old
admission rules. New CLI-stamped version-2 records reject bypasses and downgrades.
For a proven version-1 post-failure `fixing` or `auditing` checkpoint, the same
explicit `retry` may consume the next permitted round directly. Its original
events remain unchanged; it does not authorize a new uncharged legacy attempt
or extend either stopping bound.
Legacy claims may lack the original target identity. Their first authoritative
target observation becomes a forward-only fence; a later known retarget must
reconcile even though the original historical snapshot still lacks that field.
New live snapshot input must include its actual target. Preserve old events
rather than filling historical omissions with invented values.
Conflicting historical publications remain readable evidence of prior attempts,
not a basis for fresh feedback completion or activation. A no-actionable
metadata review cannot clear a known source/target conflict or restore its NICE.
After any recorded activation, inspect `show.activation.valid` and its reason:
`enabled` alone is a historical outcome, not current authority. Invalid
activation blocks new non-canary admissions and continuations, including
retained claims; only unchanged blocked evidence may be recorded for them.
Historical report-ownership conflicts invalidate their activation basis without
rewriting the journal. Ownership follows recorded order: a later conflicting
receipt cannot poison an earlier genuine decision or its exact acknowledgement.
Correct the canary under its existing scope and supply the full new acceptance
proof to `enable`. A later clean publication or wake alone does not repair
activation. The previous activation events and proofs remain retained.
Invalid activation is itself pending corrective work: the unchanged eligible
canary may enter one bounded current-scope audit without a manufactured remote
change. Its claim is bound to that activation, not to each wake. Resume/retry
interrupted work normally; gates cannot consume unfinished correction, and a
new technical NICE waits for full acceptance rather than spawning more audits.
Before the first activation, a conflicting retained canonical publication is
the same kind of pending canary correction under ongoing authority. Its
publication-bound claim survives waits and a replacement publication; fresh
reviews, current gates and the full acceptance proof remain mandatory.
Gate-only updates cannot replace a matching blocked corrective claim or spend
its charge again. Resume that original claim after verified clearance. A
read-only gate saved as waiting does not change the retained unfinished audit's
eligibility; completed failures and exhausted new-attempt bounds still apply.
These correction bounds also govern retained claims created by older policies
without the corrective marker. Their historical NICE cannot renew a cycle or
reset the no-progress breaker; genuinely unfinished charged work still resumes
within its existing charge.
Ordinary CI waits, conflicts, competing claims, forks and exhausted stops cannot
be reopened through this route.

## Canary and activation

Start with one authorized same-repository PR while inventorying the entire
queue. Use a real finding; do not plant a bug in somebody's PR or create a
token test whose green result substitutes for the workflow.

Before enabling repository-wide execution, retain proof of:

- actual Astra runtime and issue-scoped fixer execution;
- real red/green evidence (or a documented non-executable prose exception);
- actual ATV/Ponytail audit outputs and both fresh Santa receipts;
- a normal push to the canary PR and exact-SHA remote readback;
- CI and a newly completed **automatic** Copilot review for that SHA;
- persisted resume after a wait, and a quiet unchanged follow-up;
- an actual scheduler wake, not just a saved automation configuration.

The helper can validate receipt structure and identities, not authenticity.
Each represented fixer `issueId` must name a retained `fixed` finding in the
canary's current cycle. This is not a bijection with every historical or related
ledger label: genuine integrated source/red/green evidence may be shared.
The driver still verifies actual independent-issue coverage and authenticity.
Historical accepted proofs lacking that relationship remain readable, but their
activation is invalid; replay or an ACK cannot grant current authority. Correct
them through the existing charged canary correction, not another user approval.
Read the underlying native receipts and GitHub results before accepting the
canary. Never enable broad intake on a plain `NICE` string or unit tests alone.
Activation also requires the retained ongoing authority for this owner and
repository. Its `schedulerWake` must match a registered wake's `id` and
`sourceRef`, with `at` equal to that wake's recorded `startedAt`. Use the actual
registered scheduled-wake record; matching fields do not prove its authenticity
or turn a goal-triggered turn into scheduler evidence. An old activation missing
its original authority/wake binding remains readable but cannot authorize new
non-canary work. Recording a grant or wake later does not retroactively repair
that activation; full supported re-acceptance is still required.
Replacement acceptance must belong to the current charged corrective audit and
its fresh independent code acceptance. Reordered acknowledgements or changed
receipt metadata cannot substitute. Older unmarked genuine corrections are
recognized from their accepted charge and code-review/publication events, not
invented markers. The canonical old push may remain when the source is unchanged;
do not manufacture a push merely to requalify it.
CI evidence must include the current `gateKey` and `baseRef`, and be verified
after both the technical round start and the latest observed gate generation.
An old same-head green receipt does not discharge a newer failing check.
Normal completed NICE cycles renew when either base or head changes; a new
diff must not inherit an exhausted prior successful cycle. Same-revision
feedback, unfinished/failed work and invalid policy/publication correction
retain their existing bounds.
An old NICE projection with unresolved failed-review provenance or conflicting
report ownership is not a successful cycle. Under-bound pending work must use a charged audit in its
existing cycle; head/base changes cannot reset its failed bounds. Exhausted
stops remain stops, without consuming or repeatedly replacing retained work.
An old unclaimed bound rejection may have incorrectly consumed a base-only
generation after completed NICE. Recover that exact retained successful basis
as an audit, not a gate-only check; preserve all old events and counts.
Report separately: implemented, scheduled, canary verified, broad intake enabled.
If the canary is incomplete, keep executing it; do not replace the executor with
a read-only observer or claim the deployment is complete.
