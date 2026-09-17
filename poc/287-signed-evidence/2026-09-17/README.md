# ECorp work-item signing POC - public evidence

This directory publishes the complete Gate 1 signed envelope, not just a hash.
Gate 1 was reproduced on September 17, 2026 using the existing ECorp audit
implementation. This commit alone does not claim GitHub read-back verification
or any Base transaction; those require separate evidence.

## Artifact and trust pins

- Task: `032d6b74-e30d-4b30-9fe3-73ff9ba46f0c`.
- Mission: `332e8cfd-c9eb-41c3-91ec-89a4bd5a1815`.
- Payload: the exact version-1 contract of a persisted, completed local ECorp
  task from the deterministic browser/runner exercise, not real-model inference.
- Execution source commit: `c55b66067372ee5db9c6c06ba9acb8d913b59b05`,
  the local integration of published PR #293 and the then-published #283 head.
  This evidence branch retains that commit as its parent.
- Exact `signed-envelope.json` SHA-256:
  `461f2a24e9e43f1b3885a7509690b30da06def47adacf5025a14e083f9ea6471`.
- Raw Ed25519 public key:
  `fe59a6514f5536f66fecb7f93dc0802c3d15bf2d90748c4489c23f98472e4ac1`.
- Public-key SHA-256:
  `434382d8e32b705750a0a2dd60f68b834165ac2e6f7c7e222f760afe5d5576bd`.
- Signed-checkpoint digest:
  `6fcb00a630a8a74818681be4c23cdaa3dd675ad1af3894fe34c7fe19c5524afc`.

Check the public-key pin against the independently retained Gate 1 record.
Downloading a key alongside an untrusted envelope does not by itself establish
trust. No private key, seed, credential, token, or database connection is included.

## Exact scope and canonical serialization

The contract's readable representation is `payload.json`; `payload.cbor` holds
the exact canonical bytes. Existing `crony_audit::canonical` uses RFC 8949 core
deterministic CBOR over its JSON-compatible subset: null, booleans, integers,
UTF-8 strings, arrays, and string-keyed maps. Integer and length encodings are
shortest; maps sort keys lexicographically by encoded CBOR bytes. Array order
and supplied nulls are preserved. Floats are rejected.

The contract digest is BLAKE3 of:

```text
UTF8("ecorp.state-audit.v1") || 0x00 ||
UTF8("contract-input") || 0x00 || payload.cbor
```

It equals `176ec72dff1c01ac58e3fbf6fbaf22be3773f12cc50e8754e6b99abecd51fffe`.

The existing native audit chain binds:

```text
contract -> task.contract_digest -> governance content -> version ->
decision -> checkpoint.last_row_hash -> Ed25519 signature
```

The Ed25519 message is:

```text
UTF8("ecorp.state-audit.v1") || 0x00 ||
UTF8("checkpoint-signature") || 0x00 || checkpoint.cbor
```

Checkpoint CBOR is the fixed array `[protocol_version, ledger_id, last_sequence,
last_row_hash, previous_checkpoint_digest, key_id]`. The signed-checkpoint
digest is BLAKE3 over the same native prefix, domain `checkpoint`, and the
concatenation `checkpoint.cbor || checkpoint.ed25519`.

This is a native checkpoint commitment to the contract, not a direct Ed25519
signature on arbitrary task JSON. Execution status, historical completion,
and other task metadata are not newly attested. Ledger
`35dcd250-2205-4ba8-bf27-3bf787e2f342` has one baseline and covering checkpoint
at sequence 1; history before the baseline is not attested.

## Verification

The envelope contains the original payload, canonical payload bytes, public
key identity, signature, checkpoint, and complete native archive. The standalone
files are convenient copies. Gate 1 reports record independent Node/OpenSSL
Ed25519 verification, an independently implemented CBOR encoder, native archive
and task-binding verification, and rejection of tampered contracts/signatures.

To reproduce offline verification from an isolated checkout of this evidence
commit, using the repository's existing Rust dependencies and Node.js:

```powershell
$p = "poc\287-signed-evidence\2026-09-17"
New-Item -ItemType Directory -Path crates\crony-store\examples -Force | Out-Null
Copy-Item "$p\reproduce\poc_gate1.rs" crates\crony-store\examples\poc_gate1.rs
cargo build --locked -p crony-store --example poc_gate1
$report = Join-Path $env:TEMP ("ecorp-gate2-verify-" + [guid]::NewGuid().ToString("N"))
node "$p\reproduce\verify-independent.mjs" "$p\signed-envelope.json" `
  "$p\trusted-public-key.bin" .\target\debug\examples\poc_gate1.exe $report
```

The `verify` path uses no database, private key, network, or signing operation.
The harness also retains its original one-shot signing path for inspection;
do not invoke it to verify existing evidence or reset a ledger.

No production-hardening, hosted qualification, or on-chain acceptance is
claimed. PR #293 remains separate from this additive evidence branch.
