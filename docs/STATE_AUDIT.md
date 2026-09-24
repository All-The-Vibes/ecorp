# State audit: feature and setup guide

ECorp state audit makes selected governance history **tamper-evident and
independently verifiable**. It records covered changes alongside the native
database transaction, signs checkpoints over that history, and lets an auditor
verify a complete export against separately trusted keys and checkpoint digests.

PostgreSQL remains the source of truth. Audit does not replace native
authorization, turn ECorp into an event-sourced system, or prove that an agent's
claims are true.

> **Implementation status:** The supported Base integration has passed local
> acceptance and remains disconnected and disabled by default. It has not been
> publicly deployed or production-qualified. Customer KMS/IAM, TLS isolation,
> independent RPC providers, live fee profiles, and operational restore
> qualification remain customer connection requirements. This guide is not
> approval to enable Base on a customer network. V1 does not depend on Base.

**Jump to:** [V1 setup](#set-up-local-v1-audit) |
[GitHub witness](#add-an-optional-github-checkpoint-witness) |
[Base setup](#prepare-optional-base-anchoring) |
[Verification guarantees](#understand-what-a-verification-result-means) |
[Troubleshooting](#operate-and-troubleshoot).

## What the feature provides

| Capability | Purpose | Activation |
| --- | --- | --- |
| Local V1 history | Immutable content/version records, ordered decisions, and replayable state references | Initialize a Corp ledger and explicitly cover each mission |
| Signed checkpoints | Commit to the ledger identity, sequence, row hash, and previous local checkpoint | Configure the trusted server's Ed25519 signer |
| Offline verification | Detect changed or missing covered history using a complete export and independent trust | Run the CLI verifier; no server or RPC access is needed |
| GitHub checkpoint publication | Retain an external witness to a signed checkpoint | Configure a destination, service credential, and retained witness |
| Optional Base anchoring | Publish the same V1 checkpoint commitment to an immutable registry | Separately provision customer infrastructure, validate, and explicitly enable |

The layers are additive. You can use local V1 audit without GitHub or Base.
Adding Base does not change V1 checkpoint bytes or replace GitHub's independent
publication schedule. "V1 mode" does **not** mean every mission is automatically
audited: ledger initialization and mission coverage are still explicit.

### Coverage starts at a baseline

The initial protected aggregate is `mission/<mission UUID>/governance`: mission
specification and authorized ceilings, task contracts and verifier policies, and
pending authorized-budget proposals. Instrumented native contract revisions and
budget proposal/approval/rejection flows append their audit records in the same
transaction as the relational change.

Coverage starts when the mission is covered. History before that baseline is
**not attested**. This is not a transcript archive, a record of every tool call,
or a complete audit of ordinary run/spend accounting. A valid signature proves
that the trusted key signed the commitment, not that every recorded assertion
is correct or that an unobserved earlier history never existed.

### Plan retention before enabling coverage

V1 uses a bounded complete-history format: at most **4,096 decisions per Corp**,
a **32 MiB exported archive**, a stricter **16 MiB stored-record admission bound**,
and **64 tasks/pending proposals per mission**. Export never silently truncates.
Covered writes that would cross the limits fail and roll back.

These are operational limits, not merely verifier settings. Plan capacity and
retain full evidence before covering production missions. Do not delete audit
history or reset a ledger UUID to recover capacity. Disabling the signer does
not undo coverage: covered changes still accumulate unsigned history.

## Set up local V1 audit

Run commands from the repository root using PowerShell 7. Replace every
angle-bracket placeholder with a value from your deployment. The examples use
`cargo run` so a globally installed CLI is not required.

### 1. Prepare the server and authorities

Start from an ECorp installation with its application database migrated and
native authentication configured. See [local startup](../README.md#start-locally)
and [production security requirements](SECURITY.md).

Use an authorized Corp owner/admin with visibility of all covered rooms.
The acting UUID is not a substitute for authentication; the server checks the
authenticated principal and current authority. Partial room visibility cannot
establish complete Corp-wide coverage.

Provision an Ed25519 signing key through your secret-management process. The
server key file must contain **exactly 32 raw seed bytes**, not hexadecimal text,
PEM, or a JSON wallet. Protect it with service-identity ACLs and distribute the
corresponding public key through a separate trusted channel. Never use a
repository fixture key for real data.

### 2. Configure the trusted server process

| Environment variable | Value |
| --- | --- |
| `CRONY_STATE_AUDIT_SIGNING_KEY_FILE` | Protected path to the 32-byte Ed25519 seed |
| `CRONY_STATE_AUDIT_KEY_ID` | Stable, nonempty key identifier, at most 128 bytes |
| `CRONY_STATE_AUDIT_CHECKPOINT_SECONDS` | Optional local checkpoint interval; default `300`, range `1` through `31536000` |
| `CRONY_STATE_AUDIT_GITHUB_TOKEN_FILE` | Leave unset for local-only operation |
| `CRONY_BASE_WORKER_CONFIG_FILE` | Leave unset on a new V1-only deployment |
| `ECORP_BASE_GATEWAY_CONFIG` | Leave unset on a new V1-only deployment |

For example, set paths and nonsecret identifiers in the server's trusted launch
environment, then start or deliberately restart the server using its normal
deployment procedure:

```powershell
$env:CRONY_STATE_AUDIT_SIGNING_KEY_FILE = 'C:\ProgramData\ECorp\secrets\audit-signing-seed'
$env:CRONY_STATE_AUDIT_KEY_ID = 'customer-audit-key-1'
$env:CRONY_STATE_AUDIT_CHECKPOINT_SECONDS = '300'
```

Do not pass key bytes in CLI arguments, operation JSON, prompts, or runner
configuration. Environment-only delivery of secret values is reduced assurance;
the examples above contain paths, not private key material.

The V1 worker starts with the server. Missing Base configuration does not prevent
V1 from starting. For an already enabled Base deployment, use the pause and
reconciliation procedure rather than treating removal of environment variables
as cancellation of outstanding transactions.

### 3. Initialize the ledger and cover a mission

Configure the CLI's `CRONY_SERVER_HTTP` to your existing API address and supply
authentication using the existing protected `CRONY_ACCESS_TOKEN` mechanism.
Do not put a token in the operation files.

```powershell
$env:CRONY_SERVER_HTTP = '<your existing API URL>'
$Corp = '<existing Corp UUID>'
$Actor = '<authorized human actor UUID>'
```

Save these command objects as separate files, replacing the UUID placeholders:

| File | Contents |
| --- | --- |
| `audit-initialize.json` | `{"action":"initialize","ledger_id":"<new non-nil ledger UUID>"}` |
| `audit-cover.json` | `{"action":"cover","mission_id":"<existing mission UUID>"}` |
| `audit-checkpoint.json` | `{"action":"checkpoint"}` |
| `audit-status.json` | `{"action":"status"}` |
| `audit-export.json` | `{"action":"export"}` |

Record the ledger UUID outside the database before initialization. Reuse that
identity after restart or restore; do not generate a fresh UUID for retries.

```powershell
cargo run --locked -q -p crony-cli -- audit-request $Corp $Actor .\audit-initialize.json
cargo run --locked -q -p crony-cli -- audit-request $Corp $Actor .\audit-cover.json
cargo run --locked -q -p crony-cli -- audit-request $Corp $Actor .\audit-checkpoint.json
cargo run --locked -q -p crony-cli -- audit-request $Corp $Actor .\audit-status.json
```

Repeat `cover` for each intended mission, not for the whole workspace
implicitly. Continue making changes through the existing native governance
operations; audit does not introduce a second mutation API.

### 4. Export and independently verify

Create a covering checkpoint, then save the complete export response:

```powershell
cargo run --locked -q -p crony-cli -- audit-request $Corp $Actor .\audit-export.json > .\archive.json
if ($LASTEXITCODE -ne 0) { throw 'Audit export failed; do not use this output as evidence.' }

cargo run --locked -q -p crony-cli -- audit-verify .\archive.json `
  --trusted-key-file 'C:\AuditTrust\trusted-public-key.bin' `
  --expected-checkpoint '<independently retained covering checkpoint digest>'
```

The trusted file can instead contain the separately retained JSON signing-key
history when keys have rotated. Do not trust keys merely because an export
includes them. Preserve JSON integer values exactly; avoid tools that convert
large integers into floating-point numbers.

Verification checks complete ordered history, referenced objects, checkpoint
signatures and linkage, and the final reconstructed ref index. A separately
expected checkpoint also prevents silently accepting a different final
commitment. It does not, by itself, prove that no newer checkpoint exists.

If new decisions arrive between checkpoint creation and export, produce a new
covering checkpoint and retry. Do not accept unsigned trailing history or
discard intermediate checkpoints to make verification succeed.

## Add an optional GitHub checkpoint witness

Keep a **private complete archive** separately: GitHub publication writes signed
checkpoint witnesses, not the entire private history needed to replay state.

Provision an existing repository and branch with appropriate Contents access.
Protected-branch rules are not bypassed. Add these to the trusted server:

| Environment variable | Value |
| --- | --- |
| `CRONY_STATE_AUDIT_GITHUB_TOKEN_FILE` | Protected UTF-8 credential file, at most 4,096 bytes |
| `CRONY_STATE_AUDIT_RETAINED_WITNESSES_FILE` | Protected JSON witness array, at most 256 KiB |

The witness file is independently retained outside the database's restore
failure domain. Bootstrap it only after verifying the first checkpoint and
the intended repository branch identity:

```json
[
  {
    "corp_id": "<Corp UUID>",
    "ledger_id": "<retained ledger UUID>",
    "checkpoint_digest": "<trusted lowercase checkpoint digest>",
    "github_commit": "<independently retained lowercase GitHub commit SHA>"
  }
]
```

Restart the service to load the credential and witnesses. Save the following as
`audit-github.json` and submit it with `audit-request`:

```json
{
  "action": "configure_destination",
  "destination": {
    "id": "<new destination UUID>",
    "corp_id": "<same Corp UUID>",
    "kind": "github",
    "interval_seconds": 86400,
    "calendar_schedule": null,
    "overdue_after_seconds": 3600,
    "workflow_gate": "none",
    "config": {
      "repository": "<owner/repository>",
      "branch": "<existing branch>",
      "path": "audit"
    }
  }
}
```

`workflow_gate: "none"` does not add a new gate to native PR publication.
Choosing `"published"` is an explicit policy change that can hold publication
until its checkpoint requirement is met; GitHub cannot satisfy a finality gate.

To request publication now, submit
`{"action":"publish","destination_id":"<destination UUID>"}`.
The response means queued, not published. Inspect `status` for receipt,
retry, next-due, and disabled-state information. Outages retain pending work;
they do not undo previously committed governance changes.

See [V1 publication and restore details](STATE_AUDIT_V1.md) for monthly scheduling,
deterministic witness paths, key rotation, pinned ancestry, and explicit
reconciliation after a restore or remote conflict.

## Prepare optional Base anchoring

**This is a connection guide, not a production-readiness claim.** Local
implementation acceptance is complete. Keep Base disabled until customer
provisioning, network qualification, and explicit activation approval are complete.

Base publishes an opaque V1 checkpoint digest, sequence, and predecessor
commitment under a random registered stream. It does not put mission text,
credentials, or complete archive objects on-chain. Stream identifiers, publisher
addresses, commitments, sequence changes, and transaction timing remain public.

### Customer-provisioned components

| Component | Responsibility |
| --- | --- |
| Network and registry | Select Base mainnet `8453` or Base Sepolia `84532`; separately review/deploy the immutable registry and register the stream |
| Owner authority | Customer-controlled ownership, publisher rotation, pause, and ownership transfer; not an unattended worker capability |
| Publisher | Dedicated native-ETH wallet controlled by the isolated signing gateway; not a browser-wallet connection |
| Manifest authority | Offline Ed25519 authority signing destination/network/key/retention bindings, with independently distributed trust pins |
| Read providers | Two independently operated, approved HTTPS providers with qualified historical and finalized-state access |
| Signing gateway | Concrete AWS KMS signer, authenticated workload endpoint, read-only application access, and an independently administered signing journal |
| Retention and spending | Full historical evidence, required GitHub witness policy, explicit cadence, fee ceilings, monthly budget, and low-balance threshold |

Native ETH must be funded on the selected Base network. Mainnet ETH or WETH
elsewhere is not that balance. ECorp does not bridge, withdraw from an exchange,
fund wallets, deploy contracts, or execute owner operations automatically.

### Configuration files and process boundaries

| File or setting | Contents | Detailed reference |
| --- | --- | --- |
| `destination.json` | New destination `id`, disabled `config`, independent `trust_pin`, complete `manifests`, and `retention_days` | [Base administration guide](STATE_AUDIT_BASE_V2.md#host-configuration) |
| Destination `config` | Network and contract pins, publisher, secret-reference names, schedule, spending policy, and explicit customer approvals | [Complete unenrolled example](../crates/crony-base/vectors/destination-config.example.json) |
| `CRONY_BASE_WORKER_CONFIG_FILE` | Worker JSON binding destination IDs to owner, allowed hosts, secret references, and qualified fee-oracle identity | [Worker setup and JSON examples](BASE_WORKER_OPERATIONS.md#host-files-and-startup) |
| Worker `secrets_file` | Protected reference-to-HTTPS-URL map with optional bearer credentials | [Worker setup](BASE_WORKER_OPERATIONS.md#host-files-and-startup) |
| `ECORP_BASE_GATEWAY_CONFIG` | Separate gateway JSON with independent trust files, accepted manifest pins, KMS key ARN, policy, allowed Corps, and mounted secret-file paths | [Gateway setup](../crates/crony-base-gateway/README.md) and [unenrolled example](../crates/crony-base-gateway/gateway.example.json) |

The checked-in examples intentionally contain zero pins/budgets or missing
approvals. They are not configurations that can be enabled unchanged. Do not
substitute synthetic test identities for customer-reviewed values.

Base defaults to disabled, chain ID `8453`, and a monthly UTC schedule on day 1
at 00:00. The unenrolled example deliberately selects Sepolia `84532` instead.
Customer risk/public-metadata approvals and spending limits must be explicitly
provided; defaults do not constitute approval.

GitHub is optional for V1 alone, but **current Base enrollment requires
`require_github_archive: true`**. Alternate-archive enrollment is explicitly
rejected; setting a policy string does not implement another archive provider.
Full private V1 evidence must still be retained independently of the public
checkpoint witness.

The gateway requires distinct external TLS application/journal database
hosts and restricted roles, mounted credentials, an immutable supported KMS key,
and customer-operated TLS ingress. The worker must not receive KMS signing
permission. The gateway cannot broadcast transactions or expose a general-purpose
raw signing endpoint. Follow its runbook rather than collapsing the journal into
the application database.

### Configure without enabling

After preparing the signed destination input, an administrator can save it
disabled and inspect status:

```powershell
$Destination = '<new Base destination UUID>'
cargo run --locked -q -p crony-cli -- base-audit $Corp $Actor configure .\destination.json
cargo run --locked -q -p crony-cli -- base-audit $Corp $Actor status
```

No customer connections means `connection_state: "not_configured"`.
Invalid host configuration reports `"configuration_invalid"` without stopping
V1. `"configured"` means host configuration loaded, not that the wallet is funded
or the destination passed live validation.

Once approved host connections and the isolated gateway are provisioned, the
read-only connection checks are:

```powershell
cargo run --locked -q -p crony-cli -- base-audit $Corp $Actor validate $Destination
cargo run --locked -q -p crony-cli -- base-audit $Corp $Actor preview $Destination
```

These can contact the configured providers and gateway, but do not authorize a
transaction. Do not lower archive, fee, or trust requirements just to obtain a
successful preview.

Validate and enable can return `validated: false` with
`status: "reconciliation_pending"` while bounded historical work remains.
Progress is retained, but no validation ticket or new enablement is issued.
This is a pending result, not successful activation, even if the HTTP request or
CLI exits successfully. Refresh status and the current version before retrying
the operation; background workers also defer until reconciliation completes.

### Explicit activation is a spending decision

After customer qualification, funding, and separate
canary authorization, the administration commands are:

```text
crony-cli base-audit <corp> <actor> enable <destination> --expected-version <current version>
crony-cli base-audit <corp> <actor> request <destination> --idempotency-key <new request UUID>
crony-cli base-audit <corp> <actor> history <destination> --limit 50
crony-cli base-audit <corp> <actor> pause <destination> --expected-version <current version>
```

Obtain the current version from the latest destination response/status; do not
guess it. Enable freshly validates connections and checks authorization and
versioned durable state. **Enable permits scheduled publication; `request` is
not a dry run and does not bypass a disabled destination.** Retry a lost request
response with the same idempotency key.

There is no separate canary-only enable command. A customer canary procedure must
explicitly account for the configured schedule and pause controls rather than
assuming the first request is the only possible publication. Never run these
commands merely to follow a documentation example.

Pause prevents new signing/broadcast effects but cannot revoke already signed
bytes or cancel a broadcast transaction. Receipt reconciliation must continue.
Fee estimates are not hard all-in network spending guarantees; unresolved
liabilities survive month boundaries, and reverted calls can still cost gas.

For signed manifest/key rotations and recovery streams, use a new destination
UUID with retained predecessor linkage, not an in-place replacement of an old
identity. See [rotation and recovery](BASE_WORKER_OPERATIONS.md#immutable-revisions-key-rotation-and-recovery).

## Understand what a verification result means

| Result | What it establishes | What it does not establish |
| --- | --- | --- |
| Local checkpoint | Trusted key signed a commitment to recorded history | External publication or truth of every recorded assertion |
| Verified complete archive | Supplied history replays and matches the supplied trust/commitment | Freshness beyond independently supplied pins |
| GitHub published | Provider readback of retained checkpoint witness files | Blockchain inclusion or finality |
| Base broadcast | A transaction was submitted or a hash is known | Inclusion, an anchor event, or finality |
| Base included/finalized | Qualified receipt/event checks and provider-observed canonical ancestry at the reported tier | An independently verified Ethereum consensus proof |

Base-aware offline verification uses separate manifest and trust files:

```text
crony-cli base-audit-verify archive.json --manifests manifests.json --trust-pin trusted.json --expected-manifest-version <version> --expected-manifest-digest <0x-digest> --expected-checkpoint <0x-digest>
```

Its result deliberately reports `chain_inclusion_verified: false` and
`chain_finality_verified: false`. Saved RPC JSON is not independent chain proof.
The current connection adapter does not supply the independently-derived
assurance tier; it must not silently downgrade a request for that tier.

## Operate and troubleshoot

| Symptom | Action |
| --- | --- |
| Signing/coverage command says signer is unconfigured | Check the server's protected signing-key path and key ID, then use its normal restart procedure |
| Export verification fails | Check covering checkpoint, full rows/objects, independently retained keys, and ledger identity; never remove failing history |
| GitHub publication is pending/disabled | Inspect status, credential access, retained witness, and branch ancestry; use explicit reconciliation where required |
| Base says `not_configured` | Expected in V1-only mode; do not provision a wallet simply to clear this status |
| Base says `configuration_invalid` | Correct host-controlled files and references, then restart; do not submit secrets through the API |
| Validate/enable reports `reconciliation_pending` | Allow another bounded reconciliation step, refresh status/version, and retry; do not treat a successful HTTP response as enablement |
| Versioned enable/pause conflicts | Refresh state and inspect concurrent changes before retrying with the current version |
| Fee, balance, archive, provider, or trust checks fail | Keep publication paused/blocked and resolve the prerequisite; do not bypass the safety check |
| Database was restored | Stop publication, retain all evidence, compare independent witnesses/journal and canonical state before any new signature |

Back up complete local history and private operational state. Retain public keys,
ledger identity, current accepted manifest pins, and external witnesses outside
the application's restore failure domain. Raw signed transactions are private,
potentially executable capabilities until resolved; keep them out of public
exports and logs. A chain query alone cannot detect an unbroadcast signature.

The current Base work is not a claim of automatic recovery from every reorg,
unbounded archive streaming, or independently verified consensus finality.
Consult [worker scheduling, reconciliation, and boundaries](BASE_WORKER_OPERATIONS.md#durable-scheduling-and-reconciliation)
and the [Base integration guide](STATE_AUDIT_BASE_V2.md) before planning rollout.

## Reference documents

| Document | Audience |
| --- | --- |
| [State Audit V1](STATE_AUDIT_V1.md) | V1 protocol, coverage, API, publication, capacity, and restore details |
| [Base state-audit anchoring](STATE_AUDIT_BASE_V2.md) | Base administrators and auditors |
| [Base worker operations](BASE_WORKER_OPERATIONS.md) | Worker deployment and recovery operators |
| [Isolated signing gateway](../crates/crony-base-gateway/README.md) | Gateway, database-role, TLS, and KMS administrators |
| [Immutable registry](../contracts/BASE_REGISTRY_V1.md) | Contract reviewers and independently authorized deployment operators |
| [Base protocol library](../crates/crony-base/README.md) | Protocol, adapter, and offline-verifier developers |
