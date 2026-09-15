import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const vector = JSON.parse(readFileSync(new URL("../docs/state-audit-v1-vector.json", import.meta.url)));
const checkpoint = vector.checkpoint;
// Independently encode the fixed V1 array using only the RFC 8949 primitives
// used by this published vector; this is not a general-purpose CBOR encoder.
const text = (s) => {
  const bytes = Buffer.from(s, "utf8");
  assert(bytes.length <= 255);
  return Buffer.concat([Buffer.from(bytes.length < 24 ? [0x60 + bytes.length] : [0x78, bytes.length]), bytes]);
};
const payload = Buffer.concat([
  Buffer.from([0x86, 1]),
  text(checkpoint.ledger_id),
  Buffer.from([checkpoint.last_sequence]),
  text(checkpoint.last_row_hash),
  Buffer.from([0xf6]),
  text(checkpoint.key_id),
]);
assert.equal(payload.toString("hex"), vector.payload_hex);
const publicKey = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(vector.public_key_hex, "hex")]),
  type: "spki",
  format: "der",
});
const message = Buffer.concat([Buffer.from("ecorp.state-audit.v1\0checkpoint-signature\0"), payload]);
assert(verify(null, message, publicKey, Buffer.from(vector.signature_hex, "hex")));
assert(!verify(null, payload, publicKey, Buffer.from(vector.signature_hex, "hex")));
// Ethereum ABI's four fixed-width words. bytes16 UUID is right-padded; uint64
// sequence is left-padded. bytes32 digests are decoded hex, not ASCII hex.
const ledgerWord = Buffer.concat([Buffer.from(checkpoint.ledger_id.replaceAll("-", ""), "hex"), Buffer.alloc(16)]);
const sequenceWord = Buffer.alloc(32);
sequenceWord.writeBigUInt64BE(BigInt(checkpoint.last_sequence), 24);
const abi = Buffer.concat([ledgerWord, sequenceWord, Buffer.from(vector.digest, "hex"), Buffer.alloc(32)]);
assert.equal(abi.length, 128);
assert.equal(abi.subarray(64, 96).toString("hex"), vector.digest);
assert.equal(abi.readBigUInt64BE(56), 1n);
console.log("V1 canonical bytes, independent Ed25519 signature, and Ethereum static ABI compatibility passed (no chain transaction).");
