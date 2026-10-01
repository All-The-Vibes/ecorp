# Evidence review correction — October 1, 2026

This implements the two evidence findings in Copilot review 5385286454 on
`2cbaa0917514f51219f5a356e2ec1217b13d1344`. It is the implementing agent's self-review,
not independent approval or a human decision. Product source did not change.

## Default and saved source identities

Comment 4160290754 correctly identified that acceptance R2 set its disposable
default origin to ECorp. The broad non-ECorp claim in the preserved
`self-review-before-canonical-completion.md:68` is retracted for that default
source. The original R2 observations remain historical evidence, not proof of
a distinct default repository identity.

Saved local connections already cloned into managed repositories whose origin
was the local source path. Their native receipts reported distinct `local/...`
identities. The review did not establish a new source-selection product defect.
This follows `crates/crony-runner/src/workspace.rs:116` and `:1366`, local setup
in `connections.rs:1121` and `:1180`, retained capabilities at `:1383`, and default
workspace capability construction in `main.rs:747`.

Fresh R3 used unique `readiness-acceptance/owned-source-...` origin metadata,
with the runner's native Git transport restricted to `file`. That synthetic
remote was not fetched or pushed. The complete real local stack passed
**44 assertions, zero failures**, including all prior readiness scenarios.
Eight checkpoints assert the actual default repository, `main`, and fixture
commit. Ready setup operations assert saved `local/...` identities, null
repository ID, the exact same base/commit, stability across retests, and
agreement with advertised provider and retained workspace capabilities.
These source identities were observed in real server/native receipts; the
browser API and server traffic were not mocked.

R3 ran at `2cbaa0917514f51219f5a356e2ec1217b13d1344`. Its before/after manifest contains
7,213 unchanged files: exactly the 7,147 canonical product inputs plus the 66
previously committed evidence files. The prior native binary hashes match.
All owned services stopped, the fixture origin/commit stayed unchanged, and
cleanup recorded no errors. The account/catalog fixture remains explicit:
there was no provider inference, dispatch, or whole-issue application acceptance.

The original new screenshots were visually inspected and copied byte-for-byte.
They show distinct readiness rows and wrapped IDs. As in R2, the narrow capture
contains the focused skip-link overlay. Images contain disposable fixture paths
and a machine hostname; they contain no credentials. They were not edited.

## Previously omitted passing publication receipts

Comment 4160290828 correctly identified a publication omission. The packet
contained failed R1/R2 preflights but omitted the already observed passing R3
checks. `publication-r3/` now includes their successful docs/whitespace and
changed-blob receipts, actual logs, observed process exits, commit receipt and
introduced-history Gitleaks result. The preflight binds tree
`861f9797cc1ac6ad213c1ec89cb9c53fea3decdd`; commit and history scan bind
`2cbaa0917514f51219f5a356e2ec1217b13d1344`. Both native scans recorded zero findings
under unchanged policy. These are prior-revision receipts, not a claim that
the newly added evidence files were included in those earlier scans.

The evidence-only child revision receives separate documentation, whitespace,
unchanged-product/policy and exact changed-blob/history checks. Its actual tree
and head-bound results are published in a PR comment to avoid a self-referencing
commit receipt. The failed attempts, old self-review and old summary remain
unchanged, with this correction as the current interpretation.

Required hosted checks remain unavailable while Actions is disabled. This
partial contribution stays draft and #198 stays open. No approval, merge,
policy override, whole-history clean security audit, or issue closure is claimed.
