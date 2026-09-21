# ECorp continuous improvement and CI recovery

Generated 2026-09-21T08:18:00.825Z.

Reviewed advisory learning and finite CI recovery are implemented and verified through local deterministic native acceptance. **Fresh qualification was attempted and failed before judging. Genuine learning and hosted CI pilots remain unrun.**

## Benchmark status

| Evidence | Operations | Substrate | Composite |
| --- | ---: | ---: | ---: |
| Prior qualified local assessment | 71.5 | 87.4 | 79.1 |
| New structural diagnostic only | Not assessed | 87.4 | Not assessed |

The prior qualified assessment predates this implementation. The new structural scan does not supply a new operations score or composite score. No score improvement is claimed.

## Latest qualification closure

**The latest assessment failed before judging. Operations remains 71.5 from the earlier qualified assessment; the 80 and 90 goals remain unmet.**

| Case | Actual outcome |
| --- | --- |
| Recurring proposal | Provider reported content filtering: 19,514 input tokens, zero output and zero tool calls. The proposal was absent; native verification failed and source stayed unchanged. |
| Feedback proposal and repair | The actual proposal was independently reviewed. The repair request then reported content filtering: 36,722 input tokens, zero output and zero tool calls. The byte guard rejected the unchanged target before controller acceptance, export or consumption. |
| Negative control | Native edit preserved the exact intended source bytes, including mixed line endings. The run was cancelled by the hard budget breaker at 277,845 reported tokens against a 250,000-token phase limit. The proposal contained literal newline escapes outside JSON strings and was invalid; no review or recovery cycle completed. |

Four native attempts used 562,402 reported tokens: three failed and one cancelled. All runs are terminal and worktrees are preserved. The nine-attempt allocation is closed: four consumed, five unused, zero reusable. Lifetime accounting is 43 provider attempts and 4,151,470 reported tokens, with earlier records counted once. Reported usage is not a billing estimate. No judge stages ran and no new score was produced.

The corrected native edit tool preserved the negative candidate exactly. The strict review guard also correctly refused an unapplied approved repair. These observations do not turn the failed qualification into a success. The provider did not supply a filtering category or trigger; no cause is inferred and no filter workaround or further retry was attempted.

Before dispatch, the correction passed 45 standalone byte-guard tests, 37 controller integration tests, 36 transport/controller checks and 22 allocation tests. Independent reviews verified unchanged product source, functional oracles and grading. The implementation remains local commit 4e541467; hosted workflows are unenrolled and source PR publication remains blocked by automatic approval policy.

The pinned benchmark caps Self-Healing CI/CD at raw 3 when its rollback-path signal is false. The source includes native isolated known-good workspace restoration, which is narrower than deployment rollback. The scanner returned no rollback signal; neither labels nor passing local fixtures can establish a deployed rollback path.

[Latest sanitized qualification data](qualification.json). Earlier failures follow and remain part of the record.

## Earlier qualification outcome

**The new assessment failed before judging. Operations remains 71.5 from the earlier qualified assessment; neither the 80 nor 90 goal has been reached.**

| Case | Actual outcome |
| --- | --- |
| Recurring maintenance | All seven stages passed; exact reviewed repair; fixed checks 15/18 → 18/18; duplicate/replay and stale-evidence rejection verified. |
| Feedback repair | Functional checks improved 20/22 → 22/22, but the edit normalized 61 line endings outside the approved one-byte change. Exact review compliance failed. |
| Negative control | Stopped when its candidate normalized the same 61 line endings and failed the exact experiment transform. Rejection, interruption and restoration were not completed for this case. |

This attempt used 7 native attempts and 789,564 reported tokens. All runs are terminal, no provider run remains active, and failed artifacts/worktrees are preserved. Reported token usage is not a billing estimate. This allocation is closed: seven used, two unused, zero reusable. No judge stages ran and no new score was produced.

These were genuine provider executions in the native local lifecycle with independent agent proposal reviews. They do not establish a genuine human approval, a causal learning gain, hosted CI operation, or an accepted source PR. The controller marked both positive stage chains fulfilled, but the separate byte audit invalidates the feedback repair; functional success does not override that audit.

The earlier metadata refusal and first transport attempt remain recorded separately. That first executing attempt used five native attempts and 229,467 reported tokens; its fault was the observer's incorrect all-CRLF baseline assumption. The latest failure concerns edits made after the corrected baseline passed.

A new strict reviewed-transform guard passed 45 offline tests, including the retained unauthorized line-ending rewrite. Nine provider-free regression checks of the pinned Copilot native driver reproduced the patch failure and showed that edit/str_replace preserves approved repair, interruption, restoration and append bytes. Read-only live metadata confirms that Claude Opus 5 exposes that native edit tool; the GPT model used in the failed attempt does not. That prospective package was subsequently executed; its failed outcome is recorded in the latest closure above.

[Earlier qualification details](qualification-previous.json).

## Implemented capabilities

- **Reviewed advisory learning:** A reviewed, versioned intent appends selected guidance to one held task; native admission records actual consumption and enforces expiry and retirement. Only schema-3 native observations can be promoted. Legacy resume observations remain candidates. Guidance cannot expand source, tools, write scope, spending or verification.
- **Finite CI repair and isolated restoration:** One existing grant binds a repair and restoration to distinct held tasks, exact sources, unchanged checks and finite budgets. Rejected work remains preserved. Restoration is a new isolated native run at the verified known-good commit. It is not deployment rollback or an unlimited retry loop.
- **Manual recovery workflow:** A trusted default-branch job can continue an existing recovery UUID through the native watch command, with exact source readback and an exclusive checkout. Implemented but not enrolled or executed in hosted GitHub Actions. It creates no grant, mission or review decision.
- **Scheduled read-only Steward audit:** A separate opt-in six-hour schedule runs three bounded audit cycles and retains metadata only. Implemented but disabled and unenrolled. It performs no task launch or cleanup mutation, and shares no state across jobs.
- **Documentation drift checks:** Generated protected HTTP paths and marked maintenance commands are checked against source alongside existing command/version contracts. Coverage is bounded: 59 paths and six maintenance commands. It does not prove every document or HTTP schema is current.
- **Honest delivery accounting:** Live API authorship, exact native-produced contributions, dependency automation and co-author metadata are reported separately. Custom bot labels and co-author trailers do not establish evaluator recognition. Whole-PR authorship is not inferred from one native commit.

## Repository validation

| Gate | Recorded result | Command |
| --- | --- | --- |
| Rust workspace | 568 passed; 362 ignored | `cargo test --workspace` |
| Node unit suite | 1366 passed; 44 skipped | `pnpm test:unit` |
| Steward | 234 passed | `pnpm test:steward` |
| Focused feedback | 6 passed (5 database + 1 canonical unit) | `cargo test -p crony-store feedback_ -- --include-ignored --test-threads=1` |
| Focused CI recovery | 14 passed (14 database) | `cargo test -p crony-store ci_recovery_ -- --ignored --test-threads=1` |
| Final scheduler guard | 17 passed | `node --test tools/steward_schedule.test.mjs` |
| Migrations | 43 migrations | `node tools/check_migrations.mjs` |
| Documentation contracts | 59 protected paths; 6 commands | `pnpm check:docs` |
| Formatting | Passed | `cargo fmt --check` |
| Clippy | Passed | `cargo clippy --workspace --all-targets -- -D warnings` |
| Native build | Passed | `cargo build --workspace` |
| Web build | Passed | `pnpm build:web` |
| Web lint | Passed | `pnpm lint:web` |

The full Node gate preceded the final narrow scheduler job guard; its 17-case focused follow-up passed separately. The focused suites exercised **19 database cases plus one canonical unit case**. They do not mean that all 362 ignored workspace tests ran. Skipped and ignored tests remain visible. Earlier failed attempts, including an environment prerequisite failure, remain retained.

## Native acceptance

| Lane | Observed result | Boundary |
| --- | --- | --- |
| Current learning suite | 6/6 assertions; 7 runs; 3 QA fixture decisions; preservation audit passed | Fixed deterministic case: 0/1 → 1/1; no causal or provider-quality claim |
| Earlier learning suite | 7 runs and 3 QA fixture decisions retained | Historical evidence and its failures remain separate |
| CI core | 4 runs; 12 checks | Repair acceptance, exact isolated restoration, replay and preservation |
| CI independent review | 3 runs; 10 checks; 3 synthetic reviewer decisions; requester denied with HTTP 403 | Passing automated checks remain unaccepted until the configured native review |
| Browser-to-native path | Passed: one fresh CUA browser launch; 6 assertions; 1 verifier check; 327 verified artifact bytes. | Separate from backend fixture acceptance |

The current learning suite used one clean driver invocation, six completed runs and one expected failed baseline, with no automatic retry. Its fixed one-case improvement is a transport and control demonstration, not proof of learned real-provider behavior. CI restoration is a new isolated workspace at a verified known-good commit; **no deployment rollback occurred**. Original failed runs, decisions, artifacts and worktrees remain retained.

## Live delivery throughput

Fixed 90-day window: 2026-06-23T04:53:05.000Z through 2026-09-21T04:53:05.000Z.

**102 merged PRs = 96 PRs published by User accounts + 6 Dependabot PRs.** This is not a count of 96 distinct people. One native-produced contribution in [PR #234](https://github.com/All-The-Vibes/ecorp/pull/234) is a subset of those 96 User-account PRs. Its exact native commit is `97012e2e9dc0bbed21578e24b21700c4bfdb6097`; later maintainer edits and the entire PR are not attributed to that contribution. The other 95 PRs have unknown production origin.

Recognized-agent merged share is **unknown (null)** because no evaluator-issued recognition registry was supplied. The capture includes 345 distinct commits; five have co-author trailers. Those trailers do not change API authorship or establish evaluator recognition.

## Remaining work

- Browser-to-native acceptance: **passed**.
- Final source commit: **complete**.
- Genuine provider learning and hosted CI pilots: **not-run**.
- Fresh qualified operations/composite assessment: **attempted; failed before judging**.
- Hosted scheduled and manual workflow enrollment: **disabled-unenrolled**.

The scheduled read-only audit and manual recovery workflow are implemented, disabled and unenrolled. No hosted invocation, source publication, PR publication, merge or deployment is claimed. Automatic approval review blocked source PR publication; the committed source remains local.

## Concrete next steps

1. **Resolve the provider refusal:** Use supported provider diagnostics to resolve the reported content-filter response. Its trigger was not supplied. Preserve the refusal evidence; do not reword or reroute the same blocked request to evade the filter.
2. **Correct future artifact formatting:** Use valid compact JSON or actual whitespace for new evidence files. Literal newline escapes outside JSON strings are invalid. Preserve failed outputs, keep the existing JSON-schema verifier, and review any future execution allocation separately.
3. **Deliver and measure real changes:** Resolve the automatic policy block on source PR publication, then use normal review and merge for substantive native-produced changes. Record immutable production provenance, lead time, rework and review effort; keep unknown origin distinct from recognized agent authorship.
4. **Enable and prove the operating loop:** After default-branch acceptance, enroll the bounded audit and recovery workflows on the trusted host. A genuine learning pilot requires repeated native observations, a concrete owner-reviewed adoption, actual later consumption and a fixed comparison. Isolated source restoration does not establish deployment rollback.

## Evidence identity

Implementation commit: `4e541467c3f716865497dd48f6b78949bbb5e2d9`. Parent/base commit: `3aff250c118c1e24daebc39e7c8655049a344fb5`. Source working tree was clean at capture.

- Source file manifest SHA-256: `244560243628bd123cbf5e3fe9180bea7cb4d8b5c0afb9a0efe7c9bb8d552bf7`
- Evidence manifest SHA-256: `4d07ffaa983ac8c23c91aa2778b9f24e59b2c7a6e333733e6e74083e0492550f`
- Source files captured: 769.

The manifests contain repository-relative filenames or evidence identifiers and hashes. Raw private logs, native ledgers, routing and authentication details are retained separately and excluded here. See [sanitized report JSON](report.json), [source manifest](source-manifest.json) and [evidence manifest](evidence-manifest.json).
