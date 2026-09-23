# Base worker host configuration and local acceptance

This is the host-side companion to [Base state-audit anchoring](STATE_AUDIT_BASE_V2.md).
Provisioning, deployments, funding, owner transactions, and public-chain canaries
require separate customer authorization. None are performed during server startup.

## Host files and startup

`CRONY_BASE_WORKER_CONFIG_FILE` names a host-controlled JSON file. If absent,
`Service::from_environment()` returns `None`; the standalone worker exits without
requiring a database or contacting RPC/signing endpoints. Invalid configuration
makes Base unavailable in the embedded server without stopping V1.

The following is a **shape example, not a qualified customer configuration**.
Replace the destination UUID, owner, host names, and oracle code hash with the
independently approved customer values. The destination UUID must match the
disabled configuration saved through the Base administrative API.

```json
{
  "secrets_file": "C:\\ProgramData\\ECorp\\base-worker-secrets.json",
  "connections": [
    {
      "destination_id": "11111111-1111-4111-8111-111111111111",
      "expected_owner": "0x1111111111111111111111111111111111111111",
      "gateway_secret": "customer/gateway",
      "allowed_hosts": [
        "rpc-a.customer.example",
        "rpc-b.customer.example",
        "gateway.customer.example"
      ],
      "fee_oracle": {
        "qualification_id": "customer-approved-execution-plus-l1-profile",
        "runtime_code_hash": "0x1111111111111111111111111111111111111111111111111111111111111111",
        "implementation": null
      }
    }
  ]
}
```

For a proxy oracle, replace `implementation: null` with the approved
`OracleImplementation` object defined in `crates\crony-base\src\rpc.rs`; do not
omit implementation qualification for an upgradeable deployment.

The secret file is a reference-to-endpoint map. References must exactly match
the destination's `primary_rpc_secret` and `secondary_rpc_secret`, and the
host connection's `gateway_secret`.

```json
{
  "customer/primary": {
    "url": "https://rpc-a.customer.example/",
    "bearer": null
  },
  "customer/secondary": {
    "url": "https://rpc-b.customer.example/",
    "bearer": null
  },
  "customer/gateway": {
    "url": "https://gateway.customer.example/",
    "bearer": "<customer-provisioned workload credential>"
  }
}
```

Restrict both files to the service identity and administrators. Do not check
credentials into Git or submit endpoint credentials in API operation bodies.
The loader reads files at startup; changes require restarting the worker.
Each file is limited to 256 KiB. Unknown fields and duplicate JSON keys are
rejected. There are at most 1,024 host connections with unique destination IDs.

Production endpoints require approved public HTTPS hosts on port 443, pinned DNS
resolution, bounded requests, and no proxy or redirects. Two provider names do
not prove independent infrastructure; independence needs customer qualification.
The test-only loopback policy is not selected by these host files.

After separately provisioning the application database and its migrations:

```powershell
$env:CRONY_BASE_WORKER_CONFIG_FILE = 'C:\ProgramData\ECorp\base-worker.json'
# DATABASE_URL must be supplied through the customer's protected host configuration.
cargo run -p crony-server --bin crony-base-worker
```

The same worker is embedded by the normal server through
`Service::from_environment()` and `service.start(store.clone())`.
The separately administered signing process is the
[`crony-base-gateway` executable](../crates/crony-base-gateway/README.md);
follow its own configuration, TLS ingress, KMS, and database-role instructions.
Do not supply its KMS credentials to the worker.
The standalone worker does not apply migrations. New destinations stay disabled;
owner/admin Validate and Enable remain explicit API operations. Enable performs
fresh host validation and an atomic version/recovery/ticket check in PostgreSQL.
When bounded reconciliation has more work, Validate and Enable return
`{"destination_id":"...","validated":false,"status":"reconciliation_pending","retry_after_seconds":15}`.
This is progress, **not successful validation or enablement**. Repeat the requested
operation to continue a disabled destination's retained progress; Enable does not
change its enable flag until validation completes. No validation ticket or worker
effect is admitted while recovery is pending. The running worker automatically
continues eligible destinations on later ticks.
Pausing does not cancel an already signed transaction; existing attempts continue
receipt reconciliation without signing or rebroadcasting.

## Immutable revisions, key rotation, and recovery

No additional HTTP action is required: use `configure` with a **new destination
UUID**, not a replacement body under the old UUID. Exact same-ID retries return
the existing record; changing its immutable input is rejected.

For a same-stream revision, pause the predecessor and drain its active intent.
Supply the full existing manifest chain plus the authorized successor manifest,
with an increased manifest version and matching `previous_manifest_digest`.
Checkpoint-key changes preserve historical keys and explicit sequence ranges.
Manifest-authority rotation requires the old authority's signature and the new
authority's countersignature; subsequent manifests use the successor authority
while retaining the original trust pin and chain.

For a recovery stream or contract migration, supply the signed migration's old
destination identity, retained last-verified anchor, retained incident event when
the observed head is unverified, and the exact retained first-new-checkpoint
digest. The predecessor must be paused and belong to the same Corp/customer.
The first new intent selects that checkpoint, not whichever checkpoint happens
to be latest. Existing old-stream attempts and liabilities are retained, not
canceled; an occupied sender lane still blocks a new nonce on that wallet.

Configuration records immutable predecessor/successor evidence on both
destinations. Superseded destinations cannot be reenabled. The new revision is
disabled and requires a host connection entry for its new UUID, fresh gateway/RPC
validation, and explicit version-checked Enable. Old configuration, incidents,
attempts, and evidence remain available through history.

Public destination/intent/status/history responses do not include raw signed
transaction bytes, signing credentials, or resolved endpoint secrets. Destination
configuration contains only endpoint reference names and public key identities;
the signed transaction table and host secret files are private runtime state.

## Real local database and worker acceptance

Use only an explicitly owned PostgreSQL maintenance database. SQLx creates
isolated application test databases. The HTTP worker test additionally creates
and drops its own uniquely named journal database; it does not use the
application schema for the signing journal.

```powershell
$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:55483/postgres'
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target-native-qualification'
cargo test -p crony-store base_v2_ -- --ignored --test-threads=1
```

The retained-observation paging regression needs only that owned PostgreSQL
database. Its two actual HTTP fixtures bind fresh loopback ports; it does not
contact Anvil, sign transactions, deploy contracts, or write to a chain.

```powershell
cargo test -p crony-store base_v2_observation_paging -- --ignored --nocapture
cargo test -p crony-server --bin crony-base-worker base_worker_observation_paging_http -- --ignored --nocapture
```

These cover more than 1,024 retained rows, the 64-row boundary, a transaction
whose evidence insert has not committed, same-page replay, process/connection
restart, competing/stale page acknowledgements, tail inserts during both sweep
and log-scan phases, owner version changes, tentative reorg restart, and a
terminal finalized contradiction beyond row 1,024. The full HTTP rescan also
crosses the existing per-tick log-range bound: completed header work survives
that defer rather than restarting from the first retained row.

The executable-path test requires a **separate, disposable** Anvil node on
loopback port 18556, using the pinned repository launcher. It deploys a local
registry, configures a synthetic fixed-fee oracle, and funds a deterministic
fixture signer only on that disposable node. Do not point it at a shared or
customer chain. The other registry suite's node on port 18545 is not used.

```powershell
# Keep running in a separate terminal.
.\tools\start_base_registry_anvil.ps1 -Port 18556 -ChainId 84532

# Run from the repository root with the owned DATABASE_URL above.
cargo test -p crony-server --bin crony-base-worker base_worker_http_gateway_restart_and_finality -- --ignored --nocapture
```

The launcher creates a separate state cache for each node. `-CacheDirectory` can
name a new, absolute host-owned directory; it must not already exist. Retain it
when diagnosing a failure. The secondary HTTP fixture reuses its client pool:
constructing a client per ancestry-header request can exhaust local TCP endpoints.

## Full native runtime qualification (development only)

`crony-server/native-qualification` is nondefault, rejects release builds, and
requires `CRONY_NATIVE_QUALIFICATION=1`. It enables exact-loopback fixtures, not
production transport exceptions. Build server, runner, CLI and the
`crony-native-fixture` binary into `target-native-qualification`.

`tools\native_qualification_stack.ps1` owns API8992, UI5298, PostgreSQL55483,
Anvil18557, GitHub18558, secondary RPC18559 and gateway18560. It expects the owned
container `ecorp-foreground287-20260917-postgres`. Supply `-HostDirectory` under
the current Copilot session's files directory, outside Git. It restricts host
file ACLs and records exact process ownership before any restart or stop.
The gateway key remains in memory; do not restart its fixture during recovery.
Factory stays disabled. Local registry deployment and funding are fixture
operations only; never redirect these tools to public endpoints.

With the pinned toolchain and the existing PostgreSQL image installed, create
the explicitly disposable database container and build the fixture binaries:

```powershell
docker run --detach --pull=never --name ecorp-foreground287-20260917-postgres `
  -p 127.0.0.1:55483:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target-native-qualification'
cargo build --locked -p crony-server -p crony-runner -p crony-cli `
  --features crony-server/native-qualification --bins
```

The loopback trust-auth database is a reduced-assurance local fixture only.
Never reuse an existing container or production database to avoid a port conflict.

Restore the locked frontend with the pinned package manager and its supply-chain
checks intact. A corporate mirror may return different tarball locations.
Qualify any machine-local transport mapping against the registry's exact package
version and the unchanged locked integrity; do not weaken policy or silently
upgrade dependencies. Do not use a failed installation as acceptance evidence.

Run the existing drivers in this order:

1. Start the owned stack; run `e2e_native_qualification_browser.mjs --phase prepare`.
2. Run `e2e_native_qualification.mjs --phase audit`; start the gateway fixture;
   restart the server/runner to load their host configuration.
3. Run `--phase request`: configure disabled, validate, enable with the current
   version, request one stable intent, publish the complete native archive, and
   wait for the held journal response.
4. Retain `signing-restart-before.json` (processes, gateway metrics and zero
   application signed-result count); physically restart server/runner; retain
   `signing-restart-after.json`. Run `--phase broadcast`.
5. Require an observed pending transaction and null receipt. Retain
   `broadcast-restart-before.json` (processes and pending evidence), restart,
   retain `broadcast-restart-after.json`, then run `--phase recover`.
6. Retain `final-restart-before.json`, perform a final server/runner restart,
   and retain `final-restart-after.json`.
7. Put the six restart records under the output's `restart-evidence` directory.
   Run `native_qualification_attempt.mjs --begin`, then runtime `--phase readback`,
   `e2e_native_archive.mjs`, and browser `--phase readback`, in that order.
8. Run `native_qualification_acceptance.mjs`. It derives acceptance from the
   successful current reports and restart records; it contains no historical
   command outcomes. Do not edit source or restart processes between these
   identity-bound readbacks.

The drivers require `CRONY_NATIVE_QUALIFICATION=1`,
`CRONY_SERVER_HTTP=http://127.0.0.1:8992`, and the private
`CRONY_NATIVE_HOST_DIRECTORY`. The browser also requires
`CRONY_NATIVE_WEB=http://127.0.0.1:5298`, an absolute `CRONY_NATIVE_OUTPUT` pointing
to `output\native-qualification\phase2`, and an installed Playwright module
selected by `CRONY_PLAYWRIGHT_MODULE`.

If mining and native finality completed before a harness assertion failed,
`--phase observe-finality` performs read-only reconciliation of that same attempt.
It requires the previously captured pending-after-restart evidence. It does not
repeat a restart, mine, sign, or broadcast. Preserve the failed invocation.
Provider finality tips may differ while advancing; the harness checks recorded
inclusion and both tips against both endpoints, plus retained ancestry counts,
rather than requiring simultaneous tips.

The UI's **Audit evidence** panel is read-only and uses the existing authorized
native status/history APIs. It shows verified checkpoints, registry/stream,
finality transactions, provider observations and complete archive receipts.
Changing the viewer remounts the panel; denied or failed reads do not show a
previous viewer's evidence. The qualification browser checks the rendered panel,
not just a fetch from the browser origin.

Passing this lane qualifies local native wiring and recovery only. Development
identities, a deterministic runner, a same-node RPC proxy, a memory-only signer,
a synthetic oracle and a local GitHub fixture do not qualify production identity,
provider independence, KMS, public GitHub, public Base, or a hardened deployment.

This test uses the actual bounded HTTP RPC client, authenticated gateway router,
policy gateway, application `PgStore` intent authorizer, separate PostgreSQL
signing journal, and worker functions. A test signer replaces KMS, the second
local RPC endpoint forwards to the same Anvil node, and a synthetic GitHub
publication receipt supplies the independently tested V1 archive prerequisite.
It therefore does not qualify KMS permissions, provider independence, real Base
fees/finality, or actual GitHub transport.

The test injects a lost reply after the gateway durably commits signed bytes.
A fresh worker connection reconciles the journal, recovers the same signature
without signing again, and broadcasts it. It then reverts that tentative local
inclusion, detects the reorg, rescans, and rebroadcasts the original signed bytes.
After mining more than 8,192 blocks, successive bounded worker calls retain both
providers' full consensus headers and complete transaction/event finality.
A failing or ignored test is not an acceptance result; invoke it explicitly and
retain the actual output.

The local HTTP fixtures also exercise a log scan that discovers a new `Anchored`
event after the retained sweep's watermark was captured. That call must return
pending. A fresh connection checks the resulting tail on the next bounded tick;
the overlapping log replay must retain the same evidence row and watermark,
allowing completion rather than an infinite new-evidence loop. The actual
gateway/Anvil test additionally proves pending validation blocks claims and
enable tickets, then resumes to the same signed transaction's finality.

## Durable scheduling and reconciliation

Before an attempt has a frozen nonce, a newer checkpoint coalesces the queued
intent into a new immutable intent. The superseded intent and request receipts
remain in history; its fence is invalidated. After nonce reservation, retries
must retain the existing attempt and calldata.

Tentative reorgs preserve explicit enable authorization but pause all effects
until canonical rescanning and journal/nonce reconciliation finish. Provisional
costs revert to conservative reservations. Orphaned observations remain in
history, excluded only from current canonical projections. A contradiction of
retained finalized inclusion or finalized-head evidence is terminal and requires
an authorized linked recovery rather than automatic resume.

Migration 0048 retains immutable ancestry segments of at most 512 full consensus
headers each, scoped to Corp, destination, transaction, provider, and pinned
inclusion/finalized identities. Appends use compare-and-swap under an advisory
transaction lock. Progress is reconstructed from retained segments, not trusted
from a summary row. Worker retries continue from the stored cursor; partial
ancestry never advances finality or releases nonce liability. Network requests
occur outside these database transactions.

Migration 0049 adds durable, destination/Corp-scoped retained-observation sweeps.
Each worker tick reads at most **64 immutable evidence rows**, in increasing
evidence-ID order, and projects at most four sealed headers per row rather than
loading receipts or ancestry payloads. There is no total 1,024-row history cutoff.
An indexed per-page orphan lookup is bounded to those headers; it never hides
finalized evidence, including a previously orphaned block later finalized.

The cursor captures a committed high-water mark under the same destination lock
that evidence writers acquire before allocating IDs. Consequently a delayed
insert cannot commit behind an acknowledged cursor. New evidence extends the
tail, including evidence added during the subsequent bounded log scan. A private
version/revision capability fences acknowledgements and final sweep consumption;
stale workers, pause/version changes, and reorg resets cannot consume old progress.
Evidence is never updated or deleted by paging.

Both providers must recheck every page header and the persisted canonical tip
before acknowledging a page. The persisted tip protects already checked pages
across restarts and is checked again on later ticks. A tentative reorg atomically
resets the sweep with the existing reconciliation state; finalized contradictions
remain terminal. The completed header phase persists while historical log scans
defer. Publication is permitted only after the retained sweep, log catch-up, and
canonical stream-head agreement all complete and a final locked watermark check
finds no unchecked tail. This trades bounded work per tick for additional ticks
as history grows; it does not claim constant-time rescanning. RPC runs outside
database transactions. V1 export/streaming behavior is unchanged.

Incomplete retained pages, historical log catch-up, and newly discovered
observation tails are explicit pending outcomes, not RPC/integrity failures.
Workers perform no publication effects for those outcomes and resume durable
progress on later ticks. Startup/recovery validation issues no ticket until
completion; its completed rescan is reused within that tick rather than
immediately starting another sweep. Actual provider disagreement, stale fences,
and finalized contradictions remain errors. The final locked watermark check
is unchanged and never accepts unchecked scanner-created evidence.

Enrollment currently requires `require_github_archive: true`. Alternate-archive
enrollment is explicitly rejected; a configured string or policy flag cannot
stand in for retained archive evidence. Archive loading uses bounded V1 exports,
not an unbounded streaming exporter.

Production fee profiles, live provider qualification, IAM/TLS separation,
operational restore drills, and canary approval remain customer acceptance
requirements. Local tests exercise functionality but do not establish those
customer-specific trust assertions.
