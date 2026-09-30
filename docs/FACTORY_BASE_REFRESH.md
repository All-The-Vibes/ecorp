# Refresh a verified Factory result onto an advanced base

Use `factory-base-refresh` when a verified commit/branch deliverable still has
current issue authority, but its authorized publication branch has advanced.
Publication continues to require an exact remote base. Refresh creates new
verification evidence without rewriting the original deliverable or publishing
anything by itself.

## Requirements

- The Factory item is `verified`, with one ready commit/branch deliverable from
  its selected mission. The actor has current recovery permission, room access,
  and the unexpired Factory claim and fencing token.
- The issue remains open at the explicitly observed revision and repository.
  Completed recovery provenance can supply the effective revision; the original
  claim revision is retained.
- The new base is a full lowercase Git object ID on the same publication branch
  and descends from the original verified base. It must already be available in
  the runner's configured source through trusted workspace setup. Refresh does
  not fetch, reset, check out, or update refs in that source repository.
- Update both server and runner. The runner must advertise
  `publication-base-refresh-v1`, durable control, artifact transfer, and canonical
  source verification. A connected workspace must have a native source check at
  the exact new base. Provider sign-in is unnecessary for this verification-only
  operation.
- There must be no pending refresh or existing publication for this item.
  Publication recovery handles an existing publication; refresh cannot replace
  its immutable effect authority. Each work item permits at most three refresh
  attempts, including abandoned attempts.

Use the exact-context read to inspect the current item, deliverables, version,
and refresh history:

```powershell
crony --server $ServerUrl factory-base-refresh $CorpId $ActorId $WorkItemId list
```

## Authorize, review, and adopt

Keep the claim token in `ECORP_FACTORY_CLAIM_TOKEN`, populated through the
operator's existing private credential handling. Do not put token values in
command arguments, transcripts, evidence, or repository files. Renew an expired
claim through the existing Factory flow before a new operation.

Save an operation UUID and the complete arguments before submitting. A lost
response is retried with that same key, original expected version, and original
arguments. A new key represents a new operation, not a retry.

```powershell
crony --server $ServerUrl factory-base-refresh $CorpId $ActorId $WorkItemId authorize `
  --source-deliverable-id $SourceDeliverableId `
  --new-base-commit $NewBaseCommit `
  --expected-version $FactoryVersion `
  --operation-key $AuthorizeKey `
  --observed-source-revision $IssueRevision `
  --reason "Re-verify the saved deliverable after the authorized dependency advanced main."
```

The CLI rereads GitHub issue identity and the remote publication base. For a
connected workspace it also requests the existing native connection check.
The server fences the claim, validates the saved source and current authority,
and creates one linked mission, task, run, and durable runner command. The
original mission remains selected and publication is blocked while the refresh
is pending, including when the new run fails or awaits review.

The runner uses the existing portable bundle and native Git `merge-tree` to
reconstruct the verified delta against the new base in fresh private storage.
Conflicts fail without automatic resolution. Verification uses the existing
canonical source snapshots and export path. Every saved automated check is
retained; the API accepts no replacement checks. The only contract change is
the immutable base. The manual gate becomes independent review, retaining any
existing role restrictions.

In the mission console, inspect the new run's actual checks, signed export,
source base and resulting commit. A reviewer must be independent of every
refresh authorizer and the original requesters and producers throughout the
bounded lineage. Review uses the existing **Accept evidence** or **Reject
evidence** action with a durable decision key; a network retry retains that key.
An automation-driven development actor is not evidence of an independent human
signoff.

After the new run completes and its independent decision is persisted, reread
the context and adopt with a separate saved operation key:

```powershell
crony --server $ServerUrl factory-base-refresh $CorpId $ActorId $WorkItemId adopt $RefreshId `
  --expected-version $FactoryVersion `
  --operation-key $AdoptKey `
  --observed-source-revision $IssueRevision `
  --reason "Adopt the refreshed commit with its complete verification and independent review."
```

Adoption rechecks both source and result, including original recovery and budget
authority. It selects the new mission and base atomically. Publish the selected
result through the ordinary [trusted publisher flow](DARK_FACTORY_CONTRIBUTOR_GUIDE.md#publish-a-verified-result).
That aggregate still permits one branch/PR effect, revalidates the exact current
remote base, and needs its separately authorized publisher credential. Refresh
does not grant merge or deployment authority.

## Failure and abandonment

Changed issue revision, repository identity, claim, source policy, verifier
policy, room access, durable stop, expired artifact, or invalid source proof
must be resolved before proceeding. A failed refresh does not make the original
verified commit publishable against a different base.

Once the refresh run is terminal, the current authorized claimant can explicitly
abandon it using `abandon $RefreshId` with the same control fields as adoption.
Abandonment releases the pending fence without selecting a new result; it is
allowed to record failure after issue authority changes. It never deletes the
original or refresh workspace. A later attempt requires fresh authority and
consumes another of the three lifetime attempts. If the remote base advances
again after adoption, another governed refresh is necessary.

Refresh runs have no provider session, model, secrets, or provider-token/cost
allocation. This does not make verification free or create an operating-system
sandbox: the saved verifier commands retain their existing trusted execution
scope and bounds. Native harness execution and permissions are reused; ECorp
adds the cross-mission authorization and immutable lineage that those native
capabilities do not provide.

## Durable evidence

`factory_base_refreshes` preserves the original base, new base, source
mission/task/run/deliverable and commit, authorizing actor and operation key,
replacement mission/task/run, and immutable saved contracts and policies. A
single settlement records adoption or abandonment. Adoption additionally binds
the result deliverable, result commit, and exact independent decision.

State-audit coverage follows the linked mission. When enabled, authorization and
settlement are reflected in both mission histories; exported authority and
settlement digests omit claim-token values. Missions without refresh links keep
their existing audit fingerprint. Publication follows the exact adopted chain
and keeps original claim and effective recovery revisions distinct.

Record real runner and browser receipts alongside the saved policy, check IDs,
source hashes, decision IDs, refresh/settlement keys, and publication receipt.
Fixture actors, fake providers, local publication remotes, and synthetic store
metadata must be labeled at their actual scope. See the dedicated
[evaluation lane](EVALS.md#factory-base-refresh).
