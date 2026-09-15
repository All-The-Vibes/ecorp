# Base state-audit anchoring

Base anchoring is an optional destination, not a replacement for V1. PostgreSQL
remains authoritative, the V1 checkpoint envelope and digest are unchanged, and
GitHub publication keeps its existing independent schedule. A newly configured
Base destination must remain disabled until an audit administrator explicitly
enables it after connection validation.

No customer wallet, funded account, public registry deployment, provider
credential, or customer trust authority is included in the repository. Building
or starting the ordinary
server must not deploy, register, fund, bridge, or publish to a public chain.
Existing `ethereum` V1 placeholders are not converted into active Base destinations.

## Authority and prerequisites

Use a dedicated native-ETH publishing wallet on the selected network:
**Base mainnet (8453)** or **Base Sepolia (84532)**. Mainnet ETH and WETH are not
substitutes for native ETH on Base. The registry receives zero-value calls and
does not hold customer funds.

Keep four authorities separate: V1 checkpoint Ed25519 signer, customer
transaction-signing gateway, owner multisig, and offline Ed25519 destination
manifest authority. Connecting a browser wallet is not the unattended signing
model. Only the owner sends registration, pause, publisher-rotation, and ownership
transactions; the worker is authorized only to anchor an approved checkpoint.

Customer provisioning must supply:

- A reviewed immutable registry deployment, exact runtime-code hash, deployment
  block identity, registered random stream, and publisher address.
- A signed destination manifest with separately distributed root authority,
  initial digest, minimum accepted manifest version, historical checkpoint keys,
  network identity, retention policy, and any migration/rotation chain.
- Two independently operated read providers (or an owned verifying node and an
  independent provider), qualified historical/finality access, and the qualified
  Base fee-oracle identity.
- A policy-enforcing signing gateway with durable independently retained
  signing-result journal and an immutable customer key identity.
- Explicit cadence, integer-wei spending limits, archive/retention arrangements,
  low-balance policy, metadata-disclosure approval, and Base trust acceptance.

Private RPC credentials and signing credentials belong in host-controlled secret
references, never operation JSON, prompts, transaction arguments, or exports.
RPC destination policy must be approved independently of the destination request.

## Host configuration

Leave `CRONY_BASE_WORKER_CONFIG_FILE` and `ECORP_BASE_GATEWAY_CONFIG` unset to
retain the disconnected V1 operating mode. Neither executable loads a customer
connection implicitly. Building the gateway does not enable it.

The separate [signing-gateway host](../crates/crony-base-gateway/README.md)
includes a deliberately unenrolled
[configuration example](../crates/crony-base-gateway/gateway.example.json).
It composes AWS KMS, the read-only application intent authorizer, the independent
PostgreSQL signing journal, and the authenticated gateway router. Follow that
runbook for restricted database roles, secret mounts, immutable key identity,
independent trust pins, and customer-operated TLS ingress. Its `--check-config`
command is offline configuration validation, not a production connection test.

`destination.json` is the administration envelope, not the host secret file:

| Field | Required value |
| --- | --- |
| `id` | New non-nil destination UUID |
| `config` | Complete [destination configuration](../crates/crony-base/vectors/destination-config.example.json), with `enabled: false` |
| `trust_pin` | Independently distributed `authority` and `initial_manifest_digest` |
| `manifests` | Complete ordered array of signed manifests through the approved current version |
| `retention_days` | Customer-approved evidence-retention duration |

The example's zero pins, zero spending limits, and unaccepted risks are intentional
placeholders, not a usable enrollment. Obtain real deployment/network values and
signatures through the customer's reviewed provisioning process. Addresses and
hashes use `0x`-prefixed hexadecimal. The two per-gas fee fields use canonical
decimal strings; total wei budgets use hexadecimal quantities. Ed25519 public
keys, canonical bytes, and signatures use integer arrays. Do not hand-edit a
signed manifest's fields without issuing a correctly signed successor.

For the server's embedded worker, set `CRONY_BASE_WORKER_CONFIG_FILE` to a
host-controlled JSON file containing `secrets_file` and `connections`. Use an
absolute secret-file path. Each connection binds a destination UUID to
`expected_owner`, `gateway_secret`, `allowed_hosts`, and `fee_oracle`.
The oracle qualification includes `runtime_code_hash`, `qualification_id`, and
either `implementation: null` for a genuinely non-proxy oracle or the approved
implementation's `address` and `runtime_code_hash`. Hashes must come from the
actual network qualification, not from a copied local test fixture.

The mounted secret file maps the destination's `primary_rpc_secret`,
`secondary_rpc_secret`, and the host's `gateway_secret` reference names to
objects containing `url` and optional `bearer`. Keep actual values outside the
repository under restrictive host ACLs. RPC and gateway URLs must satisfy the
host allowlist and HTTPS/public-address checks; loopback HTTP is accepted only
by debug-only local fixtures, never production configuration.

The same worker can run separately with
`cargo run --locked -p crony-server --bin crony-base-worker`, using the same
host-controlled connections and a separately supplied `DATABASE_URL` for the
migrated application database. The worker does not install database migrations.
The ordinary server remains the package's default
executable. Configure the customer connections first, but leave the stored
destination disabled until the explicit versioned enable operation.

## Administrative CLI and API

The native authenticated endpoint is
`POST /api/corps/<corp>/base-audit`, with a bounded JSON body:

```json
{
  "actor_id": "<human actor UUID>",
  "command": {"action": "status"}
}
```

Use the existing `CRONY_ACCESS_TOKEN` and `CRONY_SERVER_HTTP` configuration.
The following commands are separate from the existing V1 `audit-request` and
`audit-verify` commands:

```text
crony-cli base-audit <corp> <actor> status
crony-cli base-audit <corp> <actor> configure destination.json
crony-cli base-audit <corp> <actor> validate <destination>
crony-cli base-audit <corp> <actor> preview <destination>
crony-cli base-audit <corp> <actor> enable <destination> --expected-version <version>
crony-cli base-audit <corp> <actor> request <destination> --idempotency-key <UUID>
crony-cli base-audit <corp> <actor> history <destination> --limit 50
crony-cli base-audit <corp> <actor> history <destination> --after <cursor> --limit 50
crony-cli base-audit <corp> <actor> pause <destination> --expected-version <version>
```

Configure saves disabled configuration. Validate and preview do not authorize a
transaction. Enable uses optimistic concurrency; stale versions are refused.
Validate and enable can return `validated: false` with
`status: "reconciliation_pending"` when a bounded historical scan or newly
retained observation tail requires another step. Progress persists, but no
validation ticket or new enablement is issued. Refresh status and the current
version before retrying; an HTTP success or zero CLI exit is not evidence of
activation. Background workers defer rather than publish before reconciliation
completes.
Manual publication has a dedicated owner/admin spending permission and requires a
non-nil idempotency key. Retry a lost response with the **same key**. The caller
cannot supply arbitrary sender, nonce, calldata, value, fee fields, or validation
proofs to the publication operation.

API action names match CLI operation names. Configure uses a `destination`
object. Validate/preview use `destination_id`. Enable/pause additionally require
`expected_version`. Request additionally requires `idempotency_key`. History
accepts optional `after` and `limit` (1 through 100; default 50).
All operations preserve Corp scope and the visibility required for complete
per-Corp audit history. A filtered room history cannot establish complete coverage.

Status includes `connection_state`: `not_configured`, `configuration_invalid`,
or `configured`. "Configured" is not a claim of successful connection, funding,
or publication. Missing or invalid host configuration does not stop the V1 server;
connection-dependent operations return an explicit conflict until corrected.

Pause stops new effects; it does **not** cancel already signed or broadcast
transactions. Changing publisher, revoking authority, and consuming an outstanding
nonce are distinct administrative recovery actions, not automatic rollback.

For key/manifest rotation, configure an authorized successor under a **new
destination UUID** after pausing and draining the same-stream predecessor.
Signed recovery to a different stream also uses a new destination UUID and must
link the retained predecessor and first recovery checkpoint. The existing
`configure` action handles both transitions; a different body under the old UUID
is not an update. The successor remains disabled and needs a matching host
connection, current gateway trust, fresh validation, and explicit enable.
See [immutable revisions and recovery](BASE_WORKER_OPERATIONS.md#immutable-revisions-key-rotation-and-recovery)
for the exact prerequisites and preservation of old attempts and liabilities.

## Offline archive verification

The verifier does not contact ECorp, RPC providers, or a signing gateway:

```text
crony-cli base-audit-verify archive.json --manifests manifests.json --trust-pin trusted.json --expected-manifest-version <version> --expected-manifest-digest <0x-digest> --expected-checkpoint <0x-digest>
```

`manifests.json` is an ordered array of signed manifests, beginning at the
separately trusted bootstrap. `trusted.json` contains the offline authority's
32-byte public key as an integer array (`authority`) and the initial manifest
digest (`initial_manifest_digest`). Obtain these pins and the expected current
manifest version/digest independently, not from an untrusted export. The expected
checkpoint identifies the commitment the auditor intends to verify. Matching
supplied pins is not a claim that the export is the latest public-chain state.

The command checks manifest linkage and authorized rotation, every retained V1
decision/object, intermediate checkpoint continuity, historical checkpoint key
ranges, the reconstructed ref index, and the covering checkpoint. Archive-embedded
keys cannot substitute for signed manifest authority. Inputs are bounded and
duplicate JSON keys are rejected.

Results explicitly report `chain_inclusion_verified: false` and
`chain_finality_verified: false`: **checkpoint verified; chain inclusion/finality
not independently established offline**. Saved receipt JSON cannot change those
flags. The V1 `audit-verify` command remains available unchanged.

The synthetic [full-history fixture](../crates/crony-base/vectors/full-history-v1.json)
exercises two decisions, linked intermediate checkpoints, and countersigned
manifest-authority rotation. It is test data only, not a customer trust root.
Offline input is limited to 32 MiB per archive/manifest file, 128 manifests,
and the V1 archive's 4,096-row bound. Oversized or incomplete evidence fails;
it is not silently truncated or reported as verified.

## Assurance, cost, and cadence

Keep local committed coverage, GitHub archive coverage, canonical observed Base
head, and verified Base coverage separate. A broadcast hash is not inclusion.
Inclusion requires the successful sealed canonical receipt and exact event;
finality additionally requires canonical ancestry to matching qualified
`finalized` observations. Provider disagreement cannot advance assurance.
Do not report Base evidence as "Ethereum finalized."

Provider-observed finality is not a consensus proof. Independently derived
assurance requires an actual qualified verifying Base node. Offline verification
of checkpoint bytes and signatures does not independently establish chain
inclusion/finality from saved RPC JSON.

Monthly means a UTC calendar month, not thirty days. Missed schedules catch up
once. GitHub/archive unavailability blocks Base publication under the strict
archive policy, not ordinary ECorp operation. Evidence reconciliation and
retention operate independently of the publication cadence.

Amounts are integer wei. Admission reserves maximum executable gas exposure plus
conservatively estimated L1 fees. An estimate is not a guaranteed all-in spending
ceiling; L1 components can change. Unresolved liabilities survive month boundaries.
Unknown actual L1 fees are not zero fees. Reverted calls still cost gas.

## Customer connection and activation

1. Approve network trust, permanent public metadata, cadence, and spending policy.
2. Review and deploy the registry under separate explicit authorization.
3. Register the stream from its intended owner, record deployment/registration
   evidence, and sign/distribute the trusted destination manifest.
4. Provision the dedicated signer/gateway and approved independent RPC connections.
5. Configure the destination while disabled, then validate and inspect the preview.
6. Fund native ETH on the exact configured Base network using a customer-controlled
   funding process. ECorp does not perform an exchange withdrawal or bridge transfer.
7. Separately authorize a limited canary, inspect independently observed evidence,
   then enable the accepted recurring schedule.

Local tests do not replace Base Sepolia fee/finality qualification, production IAM
review, registry review, retention/recovery drills, or the limited mainnet canary.
The design's public-testnet and production qualification phases require separate
authorization and customer-provisioned connections.

## Restore and incident handling

Restore starts with publishing paused. Reconcile retained history, canonical
events, sender nonces, all immutable signing attempts, and the independently
administered signing journal before allowing another signature. An unbroadcast
signed transaction is invisible to chain queries and remains a broadcast capability.
Never reuse a nonce merely because a database backup or RPC cannot find it.

An unknown public checkpoint is `evidence_unavailable` until established, not
automatically malicious and not verified coverage. Conflicts and contradicted
finality observations preserve evidence and require incident handling. A poisoned
stream is recovered through an explicitly authorized, signed migration to a new
stream; changing configuration must not erase the old history.

Retain raw signed transactions privately until resolved, alongside receipt/event
history, finality observations, manifests, signing-attempt journal, all skipped
checkpoints, and covered historical objects. No recovery automatically funds a
wallet, changes chains, resets a ledger identity, or sends a cancellation.

## Local development and acceptance

Run from the repository root:

```powershell
cargo test -p crony-audit -p crony-cli -p crony-server
cargo test -p crony-base --all-features
cargo clippy -p crony-cli --all-targets -- -D warnings
.\tools\test_base_registry.ps1
```

The registry scripts restore pinned local Solidity/Foundry tooling and do not
deploy to public networks. See the [registry runbook](../contracts/BASE_REGISTRY_V1.md)
for the Anvil-only receipt/event/nonce exercise and the reproducible artifact.

The HTTP/authorization acceptance lane requires a **disposable, separate
PostgreSQL database** and creates demo application data:

```powershell
$env:BASE_AUDIT_TEST_DATABASE_URL = '<disposable PostgreSQL database URL>'
cargo test -p crony-server --bin crony-server base_v2_api_http_disconnected -- --ignored
```

Do not point this variable at a development or customer application database.
The test uses an ephemeral loopback HTTP server, leaves Base disconnected, and
exercises both Base and V1 endpoints through native authentication/authorization.
Ordinary Cargo runs intentionally do not execute this opt-in database lane.

Implementation followed red/green tests: missing administration/verification
commands were first rejected by the parser, spending required a new permission,
invalid API envelopes were rejected before connection work, and the registry's
initial no-op implementation failed behavioral tests before the implementation
was added. Core/durable fixtures cover protocol and persistence separately from
public-network qualification; local mocks do not establish production IAM or
Base fee/finality semantics.
