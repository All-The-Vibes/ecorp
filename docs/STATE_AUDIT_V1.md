# State Audit V1

State audit is an explicitly enabled, additive audit layer over PostgreSQL.
It is **not** the product's source of truth or an event-sourcing migration.
Existing native authorization, active-run fencing, spending, revision events
and transactional budget checks remain authoritative.

## Coverage and limits

The first protected aggregate is `mission/<mission UUID>/governance`: mission
specification and authorized ceilings, task contracts/verifier policies, and
pending authorized-budget proposals. Enable it per mission with `cover`.
Complete native contract revisions and budget proposal/approve/reject flows
then append immutable objects, ref moves, decisions and the Corp ledger head
in the same transaction as their existing relational changes and events.
The legacy Factory source-commit upgrade is included because it mutates task
contracts in this aggregate. Its native claim token, lease, source identity and
expected-version checks remain authoritative and execute inside the audit
transaction.

Coverage starts with a clearly identified **baseline**, not a claim about
earlier history. No ledger is automatically initialized. Supply and retain a
non-nil UUID once; initializing that Corp with a different UUID fails.
Database triggers reject changes to covered governance through an
uninstrumented path and reject history updates/deletions. Ordinary run/spend
accounting is outside this V1 snapshot. A newly introduced mutation path must
join the audit transaction before it can change covered governance.

V1 deliberately supports a **bounded complete archive**, not unlimited
history: at most 4,096 decisions per Corp, 32 MiB encoded archive, a stricter
16 MiB stored-record admission bound, and 64 tasks/pending proposals per
mission. New covered transactions fail and roll back before crossing those
bounds, reserving space for a covering checkpoint. Export never truncates.
Plan capacity before enabling a production ledger; reaching capacity requires
a future streaming-format upgrade, **not deleting history or resetting its
identity**. Checks are linear in retained bounded history.
Each Corp supports at most 64 destinations; configuration rejects a 65th
atomically while allowing idempotent updates of existing destinations.

Attributable, structurally valid native policy refusals append a no-change
decision; unauthorized callers, invalid request decoding, SQL failures and
integrity errors do not manufacture refusals. An identical historical request
returns the original native outcome and stable audit receipt even after later
revisions. Current authorization is rechecked. Reusing a request UUID with
different semantic inputs fails. Replays do not re-emit native events.

## Server configuration

All audit key management is outside the runner. The existing `crony-server`
reads these trusted-process environment variables; there are no audit private
key/token command-line arguments or API inputs:

| Variable | Meaning |
| --- | --- |
| `CRONY_STATE_AUDIT_SIGNING_KEY_FILE` | Exactly 32 raw Ed25519 secret seed bytes; setting this enables the service |
| `CRONY_STATE_AUDIT_KEY_ID` | Required nonempty identifier, at most 128 bytes |
| `CRONY_STATE_AUDIT_CHECKPOINT_SECONDS` | Local checkpoint schedule, default 300; range 1..31,536,000 |
| `CRONY_STATE_AUDIT_GITHUB_TOKEN_FILE` | Optional UTF-8 GitHub token file, at most 4,096 bytes; absent means no GitHub network publication |
| `CRONY_STATE_AUDIT_RETAINED_WITNESSES_FILE` | JSON array of independently retained `{ "corp_id": UUID, "ledger_id": UUID, "checkpoint_digest": lowercase_hex, "github_commit": lowercase_hex }`; required with a GitHub credential, at most 256 KiB. `github_commit` may be omitted for verification-only witnesses, but is required for explicit GitHub reconciliation. |

Provision keys/credentials through your secret-management process and restrict
file ACLs to the trusted service identity. Distribute the corresponding raw
32-byte **public** key or JSON signing-key history through a separate trusted
channel. Do not copy a public key history from an untrusted archive and treat
it as trusted. Rotate provider credentials by restarting the service. Changing
the configured checkpoint key ID and key after a new decision atomically
retires the prior public key and activates the new one for the next checkpoint;
old checkpoints remain verifiable against the exported, separately retained
key history. Reusing a key ID with different bytes or creating a gap/overlap in
the activation ranges fails closed. Loss of a private key requires rotation
before another checkpoint can be produced. A known-compromised key invalidates
the operational trust decision for checkpoints in its range even though their
signatures remain mechanically verifiable; retain the public key and incident
record rather than deleting history.
The static `[7;32]` seed in the public compatibility fixture is test material,
never a production key.

The service starts its checkpoint/publisher worker with the server. Durable
destination state and pending receipts survive restarts. Without the signer,
existing explicitly covered store mutations still append history, while
manual signing/coverage API commands are unavailable. Operators must avoid
prolonged signing outages and monitor unsigned growth.

## API and CLI operation

Use existing authentication. POST
`/api/corps/<corp_id>/state-audit` with
`{"actor_id":"<actor UUID>","command":{...}}`. Unknown fields, duplicate JSON
keys, floats and over-bound audit request bodies are rejected. Corp-wide
management operations reuse owner/admin budget-management authorization and
visibility of all covered rooms. Request receipts are actor-scoped and reuse
the corresponding native operation's current authorization.

Save one command object in a local JSON file and use:

```text
crony-cli audit-request <corp_id> <actor_id> operation.json
```

Use the existing `CRONY_ACCESS_TOKEN`/server configuration, rather than
putting credentials in operation JSON. Examples of operation file contents:

```json
{"action":"initialize","ledger_id":"<new UUID recorded outside the database>"}
```

```json
{"action":"cover","mission_id":"<existing mission UUID>"}
```

```json
{"action":"checkpoint"}
```

```json
{"action":"export"}
```

```json
{"action":"status"}
```

```json
{"action":"receipt","request_id":"<native revision idempotency UUID>"}
```

Use the existing native mission contract and budget revision endpoints to
change covered state; audit does not add a second governance write authority.
Create a covering checkpoint before export. Save the complete export response
without rewriting its JSON numbers. Offline verification performs no network
access:

```text
crony-cli audit-verify archive.json --trusted-key-file trusted-public-key.bin
crony-cli audit-verify archive.json --trusted-key-file trusted-public-key.bin --expected-checkpoint <retained digest>
crony-cli audit-verify archive.json --trusted-key-file trusted-key-history.json --expected-checkpoint <retained digest>
```

The JSON trust file is the separately retained `signing_keys` array from a
known-good export. A raw key is accepted only for archives whose complete key
history uses that same public key.

An expected digest identifies the archive's final covering checkpoint.
Verification checks exact canonical/index agreement, object hashes,
contiguous ordered decisions, baseline semantics, version/ref ancestry,
all detached signatures and local checkpoint predecessors, and exact final
ref replay. Missing/extra referenced objects, altered fields, foreign ledger
identities and incomplete or unsigned history fail.

## GitHub publication and multi-anchor receipts

Configure any number of independent destinations within operational bounds:

```json
{
  "action":"configure_destination",
  "destination":{
    "id":"<new destination UUID>",
    "corp_id":"<same Corp UUID>",
    "kind":"github",
    "interval_seconds":86400,
    "calendar_schedule":null,
    "overdue_after_seconds":3600,
    "workflow_gate":"published",
    "config":{"repository":"owner/repository","branch":"main","path":"audit"}
  }
}
```

The repository and branch must already exist and the configured service
credential must have appropriate Contents access. Protected-branch rules are
not bypassed. A destination's identity/repository/branch/path are immutable; create a new
destination to change them. Schedules, overdue thresholds and workflow gates
can be updated. `calendar_schedule` is either null or a monthly UTC schedule
with `day_of_month` (1 through 28), `hour_utc` and `minute_utc`. Interval
schedules allow 60 seconds through 10 years. A long Ethereum interval or
monthly schedule is not overdue until its own next due time plus configured
threshold.

`{"action":"publish","destination_id":"<UUID>"}` makes an existing GitHub
destination due now. It queues work, not a success claim. The worker polls at
most 60 seconds apart; tokenless services do not execute publication.

Publication uses bounded, authenticated HTTPS requests to GitHub's API, not
shell execution. Files are additive and deterministic:

```text
<root>/<ledger>/<20-digit-sequence>.checkpoint
<root>/<ledger>/<20-digit-sequence>-<signed-checkpoint-digest>.cbor
<root>/<ledger>/<20-digit-sequence>-<signed-checkpoint-digest>.ed25519
<root>/<ledger>/<20-digit-sequence>-<signed-checkpoint-digest>.json
```

The fixed sequence claim contains the lowercase signed-checkpoint digest and
makes a conflicting digest collide at one exact path even after the repository
contains thousands of checkpoint artifacts. The `.cbor` file is the exact
source-independent payload, `.ed25519` is the detached signature, and `.json`
is the machine-readable envelope/index. No
destination, branch, commit, transaction or retry fields enter the signed
payload. These are checkpoint witnesses, not automatically published full
private history exports.

Identical preexisting files are adopted after pinned readback; conflicting
bytes fail. The adapter checks the retained commit's ancestry, never force
pushes and never rewrites an existing file. A crash after one or more file
writes can resume safely. An outage cannot roll back previously accepted
governance state. Failures retain pending work, count and retry status.

The newest covering checkpoint can supersede older pending publications.
Superseded receipts record `covered_by`; published receipts retain commit,
destination and its previous published checkpoint independently from the
payload's previous *local* checkpoint. Status returns at most 100 recent
receipts and at most 64 destinations. `published` means provider readback,
**not independent verification, chain confirmation or finality**.
Status reports `latest_committed_sequence`,
`latest_github_published_sequence`, `latest_ethereum_finalized_sequence`,
`last_successful_publication`, `next_scheduled_publication`, publication
errors, overdue destinations and disabled destinations separately. Workflow
gates are persisted as `none`, `published` or `finalized`; GitHub cannot be
configured to satisfy a finality gate. Any non-`none` Corp destination gates
the existing pull-request publication effect, and the gate is rechecked in the
same authorization transaction immediately before each remote effect. Other
future downstream effects must call the same store guard before release.

## Privacy, retention, and restore

Canonical audit DTOs are hand-selected. They exclude tokens, runner secrets,
raw mission descriptions, contract prose, acceptance-test prose and arbitrary
serialized operational state. They commit those inputs using domain-separated
digests where needed. Task allowed-tools/write-scope values, resource/actor
UUIDs, ceilings, timestamps and optional run references are visible in an
authorized complete export. Those fields may themselves be sensitive; review
them before sharing. Hashing low-entropy values does not make them secret.
Version provenance assertions are separate from the server's observed
execution context; V1 records no invented assertions of human review.

Original native responses are retained in a separate immutable **private**
operational retry table. They can contain the same free text as the existing
native API and are intentionally excluded from public audit exports.

Back up relational product data, all audit tables (including private retry
results, ref/head state, coverage and publication receipts), and signing-key
material using the existing secret-backup process. Retain ledger UUID, trusted
public key, completed exports and latest externally witnessed digest outside
the database. Do not cascade-delete retained audit history.

Before reopening a restored service for writes, keep its publisher stopped,
compare ledger identity, export and independently verify against the retained
latest checkpoint, and compare external commit ancestry. A restore older than
that witness fails the expected-final-digest check; missing/tampered internal
history fails replay. Reconcile a newer known-good backup before resuming.
The database trigger forbids identity changes/deletion, but a database owner
can bypass SQL controls: external witnesses are necessary to detect a
consistent whole-database rollback. Before each automatic publication, the
worker requires a retained witness for that Corp, checks the ledger identity,
replays local history with the configured trusted signing key, and requires
the pinned checkpoint to be present in that ancestry. Missing or divergent
pins durably disable the destination, including after restoring an older
backup. Publication remains disabled until an authorized operator submits an
explicit `reconcile` command containing the retained ledger identity and
checkpoint digest and that witness verifies against the complete local
history. Reconciliation also requires the configured retained GitHub commit,
proves that the current branch head descends from it, and restores that commit
as the destination's ancestry fence. Remote branch rewrites and same-sequence conflicting checkpoint files
also disable publication. Newer valid local history is allowed. Configure the
first pin after independently
verifying the first checkpoint; without a pin no publication occurs.

The witness file is read at startup. Keep it outside the database backup
failure domain, protect it against rollback, and update it to the latest
independently observed checkpoint before restarting publication after restore.
The service does not fetch or automatically advance those external pins;
rollback newer than a stale pin cannot be detected by that pin. Local writes
and checkpoint creation are not startup-gated, so the operator restore
procedure above is still required before reopening writes.

## Protocol and V2 contract compatibility

See [STATE_AUDIT_ETH_V2_CONTRACT.md](STATE_AUDIT_ETH_V2_CONTRACT.md) for the
contract implementation, compatibility specification and explicit V2
publisher boundaries.
`state-audit-v1-vector.json` freezes checkpoint fields, canonical bytes,
signature, public key and BLAKE3 digest. Rust tests cover hash vectors,
refusal/replay/tampering and skipped local checkpoints between anchors.
`npm run check:state-audit-compatibility` independently checks CBOR bytes and
Ed25519 using Node's crypto implementation, plus static Ethereum ABI encoding.
`npm run check:state-audit-evm` deploys the compiled Solidity contract to an
in-process REVM chain and exercises registration, publisher rotation, sparse
anchors, exact retry, conflict, predecessor, stale-sequence, foreign-ledger and
unauthorized-publisher behavior using the frozen V1 checkpoint digest.
