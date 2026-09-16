# Immutable Base checkpoint registry

`ECorpCheckpointRegistryV1.sol` is the new Base protocol contract. The existing
`StateAuditAnchor.sol`, its artifact, and the frozen V1 vector remain unchanged.
No public network deployment, real funding, production wallet, or public RPC is
part of this implementation.

## Artifact identity and reproduction

The authoritative artifact is `ECorpCheckpointRegistryV1.compiled.json`. It
contains the ABI, creation/runtime bytecode, metadata, storage layout, normalized
source SHA-256, compiler settings, and runtime Keccak-256:

```text
0xe2e734ff4a294b7c36ad6ab657267015538e28b16fcb5a3dc2ea89654e24c3cc
```

Compiler: Solidity `0.8.30+commit.73712a01`, optimizer enabled with 200 runs,
Cancun EVM, no via-IR, IPFS metadata, appended CBOR, no literal source content.
Source is canonicalized to UTF-8/LF before compilation to match Foundry on
Windows and avoid checkout-dependent metadata hashes. The artifact's source
SHA-256 refers to these normalized bytes.

The Windows native compiler is checksum-pinned:
`ccbd3ed44d5fbd26fe039702d403421f1212d2e8752e3cbe3bfd074986911586`.
Forge and Anvil are pinned to `1.7.1`, commit
`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`. Build tooling lives in the ignored
`tools\registry-toolchain` directory, not application dependencies. Its
`package.json`, `package-lock.json`, and `toolchain.json` are versioned;
`node_modules` and native binaries are ignored. The npm lock pins every direct
and transitive package to a public registry URL and integrity digest. Setup uses
`npm ci --ignore-scripts` from that standalone package directory. The native
compiler download is independently SHA-256 verified.

From the repository root:

```powershell
# Only needed when the pinned development tools are absent.
pwsh -NoProfile -File tools\setup_base_registry.ps1
node tools\build_base_registry.mjs
pwsh -NoProfile -File tools\test_base_registry.ps1
```

The setup command downloads public compiler/tool packages, not chain data.
The test command uses no chain RPC, checks artifact reproduction, executes Foundry
unit/fuzz/invariant cases, compares native and solc-js creation/runtime bytecode
exactly, and runs the always-on REVM suite. Nothing deploys outside local memory.
CI may independently invoke `cargo test -p crony-audit` with no Solidity tooling
installed: the checked-in bytecode is actually deployed/executed by REVM.

Clean-source reproduction was also exercised in a fresh project-local directory
containing only copied source/configuration/artifacts and the pinned manifests:
setup restored all 11 npm packages and downloaded the checksum-pinned compiler,
both compilers reproduced the exact artifact, and all Foundry tests passed.
No previously installed tool binary or `node_modules` was copied into that proof.

## Protocol interface

```text
version() -> uint256 (1)
register(bytes32 localStreamKey,address publisher) -> bytes32 streamId
anchor(bytes32 streamId,uint64 sequence,bytes32 checkpointDigest,bytes32 previousAnchorDigest)
head(bytes32 streamId) -> Head
setPublisher(bytes32 streamId,address publisher)
setPaused(bytes32 streamId,bool paused)
proposeOwner(bytes32 streamId,address newOwner)
acceptOwner(bytes32 streamId)
```

`Head` ABI field order is fixed:

```text
bool registered
address owner
address pendingOwner
address publisher
bool paused
uint64 lastSequence
bytes32 lastDigest
bytes32 previousAnchorDigest
uint64 anchorOrdinal
```

`ECorpCheckpointRegistryV1.vector.json` freezes cross-language stream preimages,
owner namespaces, calldata/selectors, version output, the genesis event, and
the nine-word head return. Its digest is copied from the unchanged V1 vector.
The REVM suite executes and compares these exact bytes on both local Base IDs.

Unknown streams return an all-zero head. Mutations require registration.
The stream is `keccak256(abi.encode("ECORP_STATE_AUDIT_STREAM_V1",
registeringOwner, localStreamKey))`, not the V1 ledger UUID, and survives owner
transfer. The local random key is not emitted. Different registering owners
cannot squat on one another's namespace.

Registration retries compare the immutable **initial** publisher. A matching
retry returns the stream with no event, even after publisher, pause, ownership,
or head changes; it never restores enrollment state. A different initial
configuration conflicts. A new owner's call to `register` uses its own namespace
and does not change the old stream.

Only the current publisher may anchor, including replay, and paused streams
reject all anchors. The opaque, nonzero V1 digest is copied unchanged into
`bytes32`. Sequences are positive, may skip checkpoints, and cannot exceed
`2^63-1`. A new anchor requires a greater sequence and the current head digest
as predecessor. Only the exact latest request can replay without state changes
or events. Older requests revert; the worker must find their historical events.

Owner operations cannot erase history. Ownership requires a proposal and
acceptance by the nonzero pending owner. Owners may replace a proposal or clear
it with zero; zero cannot accept. Publishers cannot be zero. Every entrypoint
rejects ETH, with no receive/fallback, proxy, administrator, external-call,
creation, withdrawal, or destruction path.

## Local execution evidence (September 15, 2026)

Tests were written first and executed against a deployable no-op scaffold:

```powershell
cargo test -p crony-audit --test base_registry_local_chain -- --nocapture
& .\tools\registry-toolchain\node_modules\@foundry-rs\forge-win32-amd64\bin\forge.exe test --use .\tools\registry-toolchain\solc-0.8.30.exe --match-path 'contracts/test/ECorpCheckpointRegistryV1.t.sol' -vv
```

Behavioral red: REVM had 7 failures and 1 artifact-only pass; Foundry had
8 failures and 1 nonpayable pass. The failures included namespace/event
assertions and calls that incorrectly succeeded, not just compilation errors.
The preceding REVM run also recorded all 8 failures for the absent artifact.

The implemented contract passes those same behavioral commands. Final REVM
coverage includes 10 always-on tests and 1,152 seeded state-machine transitions
across Base chain IDs 8453 and 84532. It verifies the existing V1 CBOR,
Ed25519 signature, BLAKE3 digest, unchanged ABI bytes32, emitted event fields,
stored heads, isolation, replay/conflicts, integer limits, nonpayability,
and authority changes. Compiled runtime opcode inspection excludes external
calls, contract creation, delegate calls, and self-destruction.

Foundry includes 8 unit/property tests (two fuzz properties, 256 cases each)
and one stateful invariant (64 runs, 64 calls each, zero handler reverts).
The handler compares accepted event fields and a monotonic model of the head
after mixed owner, publisher, pause, authorized, unauthorized, and replay calls.

The reproducible REVM gas benchmark uses a fresh Cancun transaction per
operation and includes transaction intrinsic gas:

| Operation | Gas |
|---|---:|
| First registration | 91,173 |
| First anchor | 80,205 |
| Later anchor | 66,289 |
| Exact latest replay | 32,075 |

These are execution benchmarks, not Base fee quotes. They exclude L1 data fees,
operator fees, public RPC behavior, sequencer behavior, finality, reorgs, and
production signer authorization. Local chain-ID configuration is not evidence
of public Base connectivity or deployment readiness.

## Local Anvil JSON-RPC acceptance

In a dedicated terminal, start the pinned process; the command remains in the
foreground, binds only loopback, refuses an occupied port, and suppresses the
fixture private-key banner:

```powershell
pwsh -NoProfile -File tools\start_base_registry_anvil.ps1 -Port 18545 -ChainId 84532
```

Then run:

```powershell
node tools\test_base_registry_anvil.mjs 18545
```

The client cannot accept a public URL. It checks pinned Anvil identity and the
local Base chain ID before any writes. It uses only unlocked Anvil fixture
accounts, deploys the checked-in artifact, and checks the entire runtime code.
Each invocation creates a new registry and random local stream, making repeated
runs independent without resetting a shared node.

Eight actual transactions cover deployment, registration, registration replay,
unauthorized anchoring, genesis, exact replay at a new nonce, a skipped sequence,
and a stale-request revert. Additional submission at an already-consumed nonce
is rejected without a new receipt or nonce increment. Assertions inspect real
receipts, sealed blocks, transaction hashes/nonces/value/calldata, events via
`eth_getLogs`, runtime via `eth_getCode`, and heads via `eth_call`. Reverted
transactions consume their nonce but emit no logs; exact semantic replay uses a
new transaction nonce but creates no duplicate anchor event.

The observed final state is sequence 17, ordinal 2, exactly two anchor events.
Per-run evidence, including local receipt/transaction/block identities, is
written under `target\foundry\anvil-evidence`. No public deployment, production
wallet, provider finality, reorg behavior, or signer gateway is demonstrated.

The script reserves fixture accounts 0-2 during its short run. Other local
integration workers should use separate fixture accounts or wait until the run
finishes; the script refuses a lane with pending work. Do not reset or terminate
a shared Anvil instance while another worker uses it. Stop only the explicitly
owned process ID when all local consumers have finished.
