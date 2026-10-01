# Correct a published Factory result

Use the mission console's **Review corrections** panel when a completed Factory
publication needs a bounded source correction. This operation preserves the
accepted mission, task, run, source deliverable and publication. It creates a
separate correction mission, then permits an explicit superseding publication
after verification, independent review and adoption.

Before the first publication, an advanced base is handled by
[Factory base refresh](FACTORY_BASE_REFRESH.md). A review correction retains the
published repository and base; it cannot silently refresh that base or authorize
a different destination.

## Requirements and authority

- The current Factory item and its selected publication are `published`, with
  the exact recorded PR head and a retained, valid signed commit/branch export.
- The authorizing actor has current recovery permission and access to the
  mission's room. The authenticated principal determines attribution; an
  evidence link does not impersonate the linked reviewer.
- The operation names the current item version, publication ID, published head
  and effective source-issue revision. The original claim revision and any
  completed recovery provenance remain distinct.
- Original task and mission budgets must both have remaining token and cost
  authority, and the source task must have remaining provider attempts. The
  correction receives their intersection, not a replenished allocation.
- The runner advertises `publication-review-revision-v1`, artifact transfer and
  canonical source verification, as well as the capabilities required for its
  normal provider assignment. Update server and runner together.

A work item permits at most three corrections. Each published result permits
only one correction mission, including an abandoned one. Corrections form a
single chain through adopted, superseding publications. Native task retries
consume the saved remaining attempts; they do not create another correction.

Repository, base, connection, write scope, tools, secrets, model, deadline and
deliverable contract are inherited. The operation accepts no replacement
authority fields. Every saved automated verifier check is retained, and the
manual gate becomes independent review while preserving its role restrictions.
The original requester remains the budget owner; the actual authorizing actor
is recorded separately. Existing budget, stop, loop-breaker and room checks
continue to apply at dispatch, verification and publication.

## Authorize and execute

1. Open the published mission and refresh its correction history. Compare the
   recorded publication and head with the review being addressed.
2. Record one to twenty findings. Choose correctness, security, verification or
   product contract, and enter a concrete summary. Optional repository-relative
   paths, positive line numbers and HTTPS evidence links identify the finding.
   Links must not contain credentials. Findings are attributed to the current
   authorizing actor, not an asserted external reviewer identity.
3. Select **Authorize correction**. The Factory item enters `review_revision`;
   the original mission remains selected. Authorization creates no provider run
   and performs no publication effect.
4. Select **Open correction mission**, inspect its inherited contract and
   remaining authority, then explicitly select **Start mission**. Use the normal
   mission stop and resume controls if execution needs recovery.

The runner restores the signed published source in new private Git storage. The
configured source checkout and original provider workspace are preserved. Native
harness sessions, tools, permissions and retry behavior execute the correction.
A resumed session must retain the same source seed, workspace fingerprint and
HEAD. Canonical source verification and export run through the existing native
path; changing the saved policy or source authority rejects further progress.

## Review, adopt and publish

Inspect the correction run's actual checks, source export, base and resulting
commit. A fresh review decision must come from a currently authorized human
actor independent of the correction authorizers and original requesters and
producers throughout the bounded lineage. It cannot reuse an ancestor's decision
key. An automation operating a development actor does not establish human signoff.

After all saved checks and the fresh independent review pass, use **Adopt
verified correction** with a reason. Adoption revalidates the source and
replacement, selects the exact completed correction mission atomically, and
returns the Factory item to `verified`. An export by itself is insufficient, and
the original accepted records remain unchanged.

Use the ordinary [trusted publisher flow](DARK_FACTORY_CONTRIBUTOR_GUIDE.md#publish-a-verified-result)
with the adopted deliverable and a separate current publication authorization.
The CLI creates one superseding PR on the deterministic branch
`<authorized-prefix>issue-<number>-review-<revision-id-without-hyphens>`. Its body
links the prior PR and correction lineage. The old PR, branch and publication
remain intact; this operation does not merge or close either PR.

Before remote effects, and even on a completed publication replay, the CLI checks
every retained predecessor's exact PR identity, head and native remote branch.
Manual unverified commits or a disappeared predecessor fail closed. Publication
also retains the existing exact remote-base check. Neither adoption nor a retry
authorizes overwriting a remote branch, changing the base, merging or deploying.
An already satisfied Project review status does not receive another transition.

The panel shows the original publication, last recorded review head, findings,
correction mission/run, replacement source, independent decision and publication
history. The displayed head is persisted publication evidence; refreshing this
panel does not perform a live GitHub attestation. Until superseding publication
finishes, the last published head remains visible separately from the adopted
replacement.

## Retry, abandonment and evidence

Every authorization and settlement has an operation UUID and complete saved
request. Retry a lost response with the same key, original expected version and
identical inputs. The App retains the key for an unchanged request and asks for
history reconciliation after an unconfirmed response. A different key is a new
operation, not a retry. Publisher recovery continues to use its own effect key,
workload credential, lease and fencing token.

Stop active correction runs through the ordinary mission controls before
selecting **Abandon correction**. Unstarted work can be abandoned directly.
Abandonment records a terminal settlement, preserves all source and evidence,
and restores the original `published` selection. It does not authorize a second
correction against that publication. The same settlement request can be replayed;
a different settlement cannot reverse it.

The exact-context API returns publication history and linked corrections. The
control endpoints are:

```text
GET/POST /api/corps/{corp}/factory/work-items/{item}/review-revisions
POST /api/corps/{corp}/factory/work-items/{item}/review-revisions/{revision}/adopt
POST /api/corps/{corp}/factory/work-items/{item}/review-revisions/{revision}/abandon
```

Authorization supplies `actor_id`, `expected_version`, `idempotency_key`,
`publication_id`, `published_head_commit`, `observed_source_revision` and
`findings`. Settlement supplies the actor, expected version, idempotency key,
observed source revision and reason. Use the deployment's existing authenticated
API transport. A caller-supplied actor ID is not authentication.

`factory_review_revisions` records immutable source and replacement authority,
findings, attribution and settlement. Adoption binds the exact replacement run,
deliverable, commit and independent decision. Publications record their
`supersedes_publication_id`. Enabled state-audit coverage follows both linked
missions; missions without correction links retain their existing fingerprint.

The pinned SDK 1.0.11 and CLI 1.0.79 provide native execution and permissions.
ECorp adds the tenant-scoped authorization, residual allocation, immutable
cross-mission source lineage and publication succession absent from those native
mechanisms. It adds no provider execution engine or operating-system sandbox.

Keep actual source hashes, commands, counts, checks, decision IDs, operation keys
and publication receipts. Label fake providers, development principals and local
GitHub boundaries at their actual scope. See the
[dedicated evaluation lane](EVALS.md#factory-review-revisions).
