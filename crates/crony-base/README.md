# Base V2 protocol and connection library

This optional crate leaves V1 checkpoint bytes and the GitHub destination
unchanged. `BaseDestinationConfig::default()` is disabled and unenrolled.
Configuration validation is not chain validation or permission to enable.
No tests contact Base, fund wallets, or deploy a contract.

## Stable interfaces

| Module | Boundary |
| --- | --- |
| `config` | Typed enrollment, explicit customer approvals, independent RPC identities, default-disabled publication |
| `manifest` | Offline Ed25519 authority, independently pinned bootstrap, predecessor-linked versions, countersigned authority rotation, sequence-scoped checkpoint keys |
| `schedule` | Duration, daily UTC, monthly UTC; missing monthly days clamp to month-end; catch-up computes once from now |
| `fees` | Checked integer-wei exposure and monthly admission; same-nonce maximum liability; unavailable L1 settlement is `None`, not zero |
| `abi` | Generated Alloy bindings to `ECorpCheckpointRegistryV1`; opaque V1 digest remains bytes32 |
| `rpc` | HTTPS-only, allowlisted, DNS-pinned, no-proxy/no-redirect bounded JSON-RPC; sealed receipts/events and dual-provider ancestry |
| `signing` | Exact immutable EIP-1559 request, canonical signed-byte decoding, recovered sender and local hash, policy gateway and independent PostgreSQL result journal |
| `kms` | Optional `aws-kms`: supported Alloy AWS signer, immutable ARN, enabled AWS-origin secp256k1 signing key, recovered publisher identity |
| `gateway` | Optional `gateway-service`: separately hosted Axum JSON-RPC router with mandatory workload credential and Corp scope |

The application owns transactional nonce/budget reservation, worker fencing,
archive retention, continuous discovery, and restore reconciliation.
`IntentAuthorizer` must use the read-only authoritative frozen-attempt view
and repeat those authority checks. `PolicyGateway` independently verifies the
complete supplied V1 history, current trusted manifest, exact request, target,
sender, zero value, calldata, and fee ceilings before signing.

The gateway journals the request before KMS access and the result before
returning any signed bytes. An identical retry recovers the stored result;
concurrent results return the committed winner. Loss before result commit
may cause another KMS signature for the same fields, but uncommitted bytes
are never returned. `gateway-journal.sql` must be installed separately from
the application database with an independent administrator, backups, and
SELECT/INSERT-only gateway credentials. Journal retention must outlive any
possible outstanding transaction. An application database restore cannot
establish safety without this independent journal.

`SigningGateway::identity()` returns the configured chain, recovered
publisher and immutable key identity. `journal_snapshot(chain_id, publisher)`
returns an immutable journal epoch, monotonic request cursor, all retained
attempt requests for that wallet, and explicit completeness. PostgreSQL
freezes and snapshots share an advisory transaction lock so a previously
invisible lower cursor cannot commit after a snapshot watermark. Snapshots
include frozen attempts with unknown signing outcomes, not merely returned
signatures. The bounded 4,096-request response becomes explicitly incomplete
above its limit; it never silently authorizes recovery from a partial list.
The gateway HTTP host rejects snapshots crossing its workload's Corp scope.
Runtime SQL permissions also need USAGE on the journal cursor sequence;
the epoch table requires SELECT only.

The separate `crony-base-gateway` package is a runnable host composing this
router with `PgStore`'s read-only authorizer, concrete AWS KMS client, and
independent journal. Its README documents customer provisioning, TLS ingress,
secret mounts, and the default-disabled startup. Never expose its plaintext
loopback listener directly. It cannot deploy, fund, broadcast, register streams,
or execute owner operations.

## Manifest wire format

`vectors/full-history-v1.json` is a complete synthetic offline CLI fixture.
Its exact root keys are `archive` (V1 `Archive`), `manifests`
(`Vec<SignedManifest>`), `trust_pin` (`TrustPin`), `current_version` (u64),
`current_digest` (0x-prefixed B256), and `checkpoint_digest` (unprefixed V1
hex string). It contains two complete decisions with all referenced objects,
two linked checkpoints, the final ref index, and a three-manifest chain
including countersigned authority rotation and a successor-signed version.
The fake network/deployment values do not establish chain inclusion.
Extract the archive, manifest array, and trust pin into separate CLI inputs;
do not treat archive-exported keys as the production trust root.

Regenerate with `cargo run --locked -p crony-base --example
generate_full_history_fixture`. Its deterministic test-only Ed25519 seeds
are repeated bytes 9 (checkpoint), 10 (root authority), and 11 (successor
authority); the fixture JSON contains public keys and signatures, not private
seeds. Never use these synthetic identities for a deployment. The generator
verifies complete V1 history and the manifest chain before writing the fixture.
`vectors/destination-config.example.json` documents the complete serialized
configuration shape and intentionally remains disabled and unenrolled.

`vectors/destination-manifest-v1.json` freezes the synthetic fixture used in
`tests/manifest.rs`. The 20-element fixed array follows the design's declared
field order. Nested network, checkpoint, key, migration and anchor records
are fixed arrays in their Rust field order. Addresses, hashes and public
keys are CBOR byte strings. Other text is UTF-8, integers use shortest
unsigned encoding, and optional values are explicit CBOR nulls.
Checkpoint keys sort lexicographically by key ID and must be unique.

The signature and digest domains are exactly those in the design.
The successor additionally signs
`ecorp-audit/destination-manifest-rotation-countersignature/v1` + NUL +
canonical manifest + current-authority signature. This countersignature
does not alter the design's digest calculation, which includes only the
64-byte current-authority signature. The successor key is in the signed
manifest itself. Failed trust advancement never changes the retained pin.
Auditors retain the entire chain and an independent minimum accepted
version/digest; `ManifestTrust::require_current` checks that external pin.

## Network and fee qualification

`BaseConnection::startup` checks both network identities, deployment block,
code at deployment and current finalized state, absence before deployment,
historical receipt availability, generated contract version/head, owner,
publisher, pause state, and canonical common-finalized ancestry.
The signer address argument must come from the customer's authenticated
gateway/KMS identity check, not an API caller's self-assertion.
Independent operator identities are administrative procurement assertions;
two differently named URLs do not prove independent infrastructure.

`verify_anchor` compares both sealed canonical receipts and exact events,
then follows parent hashes to each provider's finalized head. It stores
observations, not a receipt-trie or Ethereum consensus proof. It refuses
the independently-derived tier because no verifying-node qualification
adapter is implemented. The offline result remains:
**checkpoint verified; chain inclusion/finality not independently established offline**.

`verify_receipt_finality` returns the exact transaction receipt, sealed
inclusion header, both retained ancestry observations, and explicit assurance.
It also accepts successful no-log and reverted transactions. This establishes
the transaction's own nonce finality, not checkpoint coverage: an exact-replay
no-op still requires a separately verified original anchor event. Providers
must agree on receipt costs as well as inclusion, and later common-finalized
observations must match the retained ancestry rather than replacing it.

The legacy one-shot ancestry walk remains bounded to 8,192 headers.
Historical, monthly, and restarted verification uses
`verify_receipt_finality_resumable(hash, &dyn AncestryStore)` or
`verify_anchor_resumable(hash, call, publisher, &dyn AncestryStore)`.
Each returns `Result<Option<...>>`: `None` means bounded progress was retained
and the worker must retry later, never successful finality or releasable spend.
At most 512 complete consensus headers per provider are fetched per invocation.
Every header is re-encoded with Alloy RLP and Keccak-256 checked against its
expected hash, including all parent links through the exact inclusion header.
An arbitrary number of bounded segments may be retained across process restarts;
there is no total 8,192-header history ceiling on this path.

The immutable segment binding includes manifest, chain, transaction, provider,
inclusion, original finalized header and observation time. The original finalized
target does not move forward on retries. `AncestryStore::append` must atomically
CAS the segment ordinal and persist both the full `AncestrySegment` and the
`AncestryState::apply_segment` result. `load` must return only the last retained
derived state, never an API-supplied progress object. Every append checks hashes,
numbers, timestamps, exact boundaries, range bounds, and binding continuity.
The store also supplies a retained consensus header by number for cross-provider
common-finalized comparison. Missing, reordered, changed or unretained segments
must fail closed. No number-only proof or unverified completion flag is accepted.

Completion freshly checks both canonical inclusion/retained-finalized headers
and their common finalized block. `FinalityObservation.retained_ancestry` records
the proof key, segment/header counts and cumulative header-hash commitment;
`ancestry` is empty only because the complete proof is in retained segments,
not because ancestry was omitted. Keep those segments with the finality evidence
and export them for replay via `AncestryState::apply_segment`. An unaccompanied
summary is not an offline inclusion or consensus proof. Assurance remains
provider-observed finalized, not independently derived.

Log pages start at at most 1,000 blocks and shrink explicitly on RPC errors;
callers retain end hashes and overlap scans.

For local integration only, a dev dependency may opt into `test-support`.
In debug builds, `EndpointPolicy::test_only_loopback(SocketAddr)` authorizes
only the exact literal loopback address and nonzero port, with no DNS,
redirect, or proxy. The constructor and its bypass are absent in release
builds. Production policies still require HTTPS/public-only destinations
even when this feature is enabled. Dual-provider test connections must use
distinct pinned socket addresses; they do not establish provider independence.
The opt-in local Anvil regression exercises actual read-only JSON-RPC through
this seam. Production gateway dependencies do not enable it.

Debug/test convenience constructors `HttpRpc::connect_test_loopback`,
`HttpSigningGateway::connect_test_loopback`, and
`BaseConnection::connect_test_loopback(config, trust, secrets)` resolve only
literal `127.0.0.1` or `::1` with an explicit nonzero HTTP port.
The explicitly named Base test constructor permits the same local fixture node
for both transports while preserving destination/trust validation; this is
synthetic integration evidence and never provider-independence qualification.

Fee qualification pins GasPriceOracle code and, for an EIP-1967 proxy,
implementation identity/code. `getL1Fee` receives conservatively serialized
EIP-1559 bytes with maximum-size signature fields. Fee history supplies
bounded suggestions, never spending authority. This implements the
execution-plus-L1-data profile only: a new active fee model requires
customer qualification and a new adapter, not an omitted component.
Runtime code qualification and mocked oracle responses do not establish
the currently deployed Base model, its upgrade flags, or actual prices.
Receipt L1 fee absence retains an accounting warning/liability upstream.

## Dependencies and local evidence

Alloy is pinned to 0.8.3 to preserve V1's REVM 19 / c-kzg 1 native-link
compatibility. Alloy 1.x conflicted with that frozen dependency. The AWS
SDK is pinned to 1.77.0 and its compatible Smithy cohort is pinned in the
workspace lockfile: unconstrained current Smithy releases are not
source-compatible with that SDK. Do not refresh those pins without the
all-feature compilation lane and upstream/security review.

Run `cargo test -p crony-base --all-features` for local protocol/HTTP
fixtures and optional adapter compilation. The PostgreSQL journal
regression is deliberately ignored in ordinary runs; explicitly select
it against a dedicated local QA maintenance database. It does not prove
independent production administration or KMS permissions.

Remaining customer qualification includes real independent providers,
active network/fee-code manifests, production KMS IAM separation, TLS/
secret-broker deployment, long-history retention and restore drills.
There is no reduced-assurance local signing fallback in production code.
