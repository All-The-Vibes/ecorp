# State Audit V2 Ethereum anchor contract specification

`contracts/StateAuditAnchor.sol` is the executable compatibility contract for
the V1 checkpoint protocol. `contracts/StateAuditAnchor.compiled.json` is the
Solidity 0.8.30 optimized artifact exercised by the in-process REVM test.
V1 supplies signed checkpoints, destination-neutral durable receipt storage,
independent interval/monthly schedules, the contract, and local EVM
compatibility. Mainnet transport and chain lifecycle remain V2 work.

The contract source and artifact use LF checkout bytes on every platform.
The compiler metadata commits to those exact source bytes; changing line endings
after compilation invalidates that binding. Regenerate, rather than hand-edit,
the artifact with `solc-js 0.8.30+commit.73712a01.Emscripten.clang`, source key
`StateAuditAnchor.sol`, optimizer enabled with 200 runs, and the `prague` EVM
target. Preserve the `abi`, `evm.bytecode.object`, and `metadata` outputs.
The `ethereum_local_chain` test checks the source hash and metadata commitment
in the actual bytecode before executing it.

## Fixed V1 checkpoint identity

The signed CBOR payload is exactly the six-element array:

```text
[1, ledger UUID text, uint64 last sequence, lowercase row hash hex,
 previous local signed-checkpoint digest hex or null, key identifier text]
```

Encoding uses RFC 8949 core deterministic CBOR: definite lengths, shortest
integer/length representations, UTF-8 and bytewise sorted encoded map keys
for JSON objects in history records. Floats and duplicate JSON keys are
unsupported. The public vector uses a UUID v4 text representation.

For domain `d`, `H(d,b)` is BLAKE3 over ASCII
`ecorp.state-audit.v1`, NUL, ASCII `d`, NUL, then bytes `b`.
Row/object domains are specified in `crony-audit`; checkpoint signatures sign
ASCII `ecorp.state-audit.v1`, NUL, ASCII `checkpoint-signature`, NUL, then the
exact CBOR payload. The signed checkpoint digest is
`H("checkpoint", payload || detached_64_byte_Ed25519_signature)`.
Ethereum never reserializes that payload. It anchors its decoded 32-byte
digest. The checkpoint signing key and Ethereum transaction key are distinct.

## Proposed contract interface and authority

Use `bytes16 ledgerId` (UUID's 16 bytes in textual hex order), `uint64 sequence`,
`bytes32 checkpointDigest`, and `bytes32 previousAnchorDigest`.
`abi.encode(ledgerId,sequence,checkpointDigest,previousAnchorDigest)` is four
32-byte static words: bytes16 right padded, uint64 left padded, two unchanged
bytes32 words. The zero bytes32 predecessor represents an unanchored ledger.
Do not use ASCII hexadecimal digest bytes or the previous local checkpoint
as the previous Ethereum anchor.

`registerLedger(bytes16 ledgerId,address publisher)` must require an explicit
registration authority, reject the zero UUID/address and refuse duplicate
registration. Establish and document ownership of the ledger namespace.
`rotatePublisher(bytes16 ledgerId,address publisher)` must require that
ledger's recorded owner/governance authority, reject zero addresses and emit
a publisher-rotation event. Neither operation changes an existing anchor.
No public first-writer-wins takeover or unauthorized rotation is permitted.

`anchor(bytes16 ledgerId,uint64 sequence,bytes32 checkpointDigest,
bytes32 previousAnchorDigest)` must:

1. Require registered ledger and its currently authorized publisher.
2. Reject zero sequence/digest.
3. Return success with no duplicate event/state mutation for an identical
   retry of the last accepted complete tuple.
4. Otherwise require strictly increasing sequence and a predecessor exactly
   equal to the contract's currently stored checkpoint digest.
5. For a first anchor require the zero predecessor; a first sequence may be
   greater than one because intermediate local checkpoints need not be
   externally anchored.
6. Store the sequence/digest/predecessor and emit
   `Anchored(ledgerId,sequence,checkpointDigest,previousAnchorDigest,publisher)`.

Same-sequence different-digest, stale/nonincreasing, wrong-predecessor,
unregistered/foreign-ledger and unauthorized calls revert. Contract state
contains no contract prose, secrets, product objects or full history.
An anchor is a commitment and timestamp/order witness, not execution of
PostgreSQL policy, Ed25519 verification, or proof of historical truth.

## Compatibility and receipts

`crony_audit::AnchorCommitment` and `validate_anchor_progression` exercise the
tuple continuity/idempotency rules. The test anchors local checkpoint 1,
skips local checkpoint 2 and anchors local checkpoint 3; checkpoint 3's
local predecessor remains checkpoint 2, while its previous Ethereum anchor
is checkpoint 1. Foreign ledgers, backwards sequences and wrong ancestors
fail. This local model does not simulate registration/contract authorization.

The frozen JSON vector and Node compatibility command verify actual V1 bytes,
independent Ed25519 validation and the four-word static ABI encoding. The
`ethereum_local_chain` Rust test deploys and executes the compiled contract in
REVM, using that same V1 digest. It covers authorized registration and
rotation, first and sparse anchors, exact retry, conflicting and stale
submissions, wrong predecessors, foreign ledgers and unauthorized publishers.

Future persisted receipts should retain destination identity, chain ID,
contract address, transaction hash/nonce, block hash/number, confirmation and
finality state, previous destination anchor and retry/replacement lineage.
Keep these outside checkpoint payloads. Reorgs can move an observed receipt
back to pending; never label submission as inclusion or inclusion as finality.
V1's `ethereum` destination is a **nonexecuting placeholder** and cannot be
manually published.

V2 must add the production RPC publisher, deployment procedures, transaction
key management, chain/contract attestation, nonce ownership, gas budgets,
transaction replacement and reorg/finality policy. None is implicitly enabled
by configuring a V1 Ethereum destination placeholder.
