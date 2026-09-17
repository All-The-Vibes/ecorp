import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const [file, trustFile, nativeVerifier, reportDirectory] = process.argv.slice(2)
assert.ok(file && trustFile && nativeVerifier)
const output = reportDirectory || path.dirname(file)
if (reportDirectory) mkdirSync(output)
const bytes = readFileSync(file)
const envelope = JSON.parse(bytes)
const publicBytes = readFileSync(trustFile)
assert.equal(publicBytes.length, 32)
assert.equal(envelope.public_key_hex, publicBytes.toString('hex'))

function canonical(value) {
  function head(major, value) {
    const n = BigInt(value)
    if (n < 24n) return Buffer.from([major * 32 + Number(n)])
    for (const [size, tag, limit] of [[1,24,256n],[2,25,65536n],[4,26,4294967296n],[8,27,18446744073709551616n]]) {
      if (n < limit) {
        const bytes = Buffer.alloc(1 + size)
        bytes[0] = major * 32 + tag
        for (let i = 0; i < size; i++) bytes[size-i] = Number((n >> BigInt(i*8)) & 255n)
        return bytes
      }
    }
    throw new Error('CBOR integer outside supported range')
  }
  if (value === null) return Buffer.from([0xf6])
  if (typeof value === 'boolean') return Buffer.from([value ? 0xf5 : 0xf4])
  if (typeof value === 'number') {
    assert.ok(Number.isSafeInteger(value))
    return value >= 0 ? head(0,value) : head(1,-1n-BigInt(value))
  }
  if (typeof value === 'string') {
    const s = Buffer.from(value,'utf8')
    return Buffer.concat([head(3,s.length),s])
  }
  if (Array.isArray(value)) return Buffer.concat([head(4,value.length),...value.map(canonical)])
  assert.equal(typeof value,'object')
  const pairs = Object.entries(value).map(([k,v]) => [canonical(k),canonical(v)])
    .sort(([a],[b]) => Buffer.compare(a,b))
  return Buffer.concat([head(5,pairs.length),...pairs.flat()])
}
assert.equal(canonical(envelope.payload).toString('hex'),envelope.canonical_payload_hex)
const key = createPublicKey({
  key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicBytes]), format:'der', type:'spki',
})
assert.equal(envelope.archive.checkpoints.length,1)
const signed = envelope.archive.checkpoints[0]
const c = signed.checkpoint
const payload = canonical([c.protocol_version,c.ledger_id,c.last_sequence,c.last_row_hash,c.previous_checkpoint_digest,c.key_id])
assert.deepEqual(payload,Buffer.from(signed.payload))
const message = Buffer.concat([Buffer.from('ecorp.state-audit.v1\0checkpoint-signature\0'),payload])
const signature = Buffer.from(signed.signature)
assert.equal(verify(null,message,key,signature),true)
const alteredMessage = Buffer.from(message)
alteredMessage[alteredMessage.length-1] ^= 1
assert.equal(verify(null,alteredMessage,key,signature),false)
const alteredSignature = Buffer.from(signature)
alteredSignature[0] ^= 1
assert.equal(verify(null,message,key,alteredSignature),false)

const native = spawnSync(nativeVerifier,['verify',file,trustFile],{encoding:'utf8',timeout:30_000})
assert.equal(native.status,0,native.stderr)
const nativeResult = JSON.parse(native.stdout)
assert.equal(nativeResult.status,'PASS')
const tampered = structuredClone(envelope)
tampered.payload.objective += ' TAMPERED'
const tamperedFile = path.join(output,'tampered-envelope-negative.json')
writeFileSync(tamperedFile,JSON.stringify(tampered),{flag:'wx'})
const negative = spawnSync(nativeVerifier,['verify',tamperedFile,trustFile],{encoding:'utf8',timeout:30_000})
assert.equal(negative.status,1,'Altered work-item payload must fail')
const report = {
  status:'PASS', verifier:'Node.js node:crypto/OpenSSL, independent CBOR encoder, native archive verifier',
  node:process.version, openssl:process.versions.openssl,
  envelope_sha256:createHash('sha256').update(bytes).digest('hex'),
  public_key_sha256:createHash('sha256').update(publicBytes).digest('hex'),
  public_key_hex:publicBytes.toString('hex'), signature_hex:signature.toString('hex'),
  payload_digest:envelope.payload_digest, checkpoint_digest:envelope.checkpoint_digest,
  independent_canonicalization_matches:true, independent_ed25519_verification:true,
  changed_signed_message_rejected:true, changed_signature_rejected:true,
  changed_work_item_rejected:true, native_verification:nativeResult,
}
writeFileSync(path.join(output,'independent-verification.json'),JSON.stringify(report,null,2),{flag:'wx'})
console.log(JSON.stringify(report,null,2))
