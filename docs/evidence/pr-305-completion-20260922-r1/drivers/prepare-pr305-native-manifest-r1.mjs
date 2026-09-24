import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const base = 'C:/Users/shyamsridhar/code/ecorp/output/pr-completion/20260922T123548Z'
const source = 'C:/Users/shyamsridhar/code/ecorp-pr305-completion-20260922'
const pg = 'C:/Users/shyamsridhar/AppData/Local/Programs/ecorp-tools/postgresql-17.10/pgsql/bin'
const { sourceFingerprint, validateBuildReceipt } = await import(pathToFileURL(path.join(source, 'tools/research_handoff_native.mjs')))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = path.join(base, 'pr305-native-r1-build/cargo-test.jsonl')
const bytes = await readFile(receipt)
const records = bytes.toString('utf8').trim().split(/\r?\n/).map(JSON.parse)
const manifest = { schema_version: 1, source, source_sha256: await sourceFingerprint(),
  head: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
for (const lane of ['runner', 'server']) {
  const artifacts = records.filter(record => record.reason === 'compiler-artifact' &&
    record.target?.name === `crony-${lane}` && record.profile?.test === true && record.executable)
  assert.equal(artifacts.length, 1, `Exactly one ${lane} test executable`)
  const binary = artifacts[0].executable
  validateBuildReceipt(records, { lane, binary, root: source })
  manifest[lane] = { path: binary, sha256: digest(await readFile(binary)),
    build_receipt: receipt, build_receipt_sha256: digest(bytes) }
}
manifest.postgres = {}
for (const name of ['initdb', 'postgres', 'psql', 'pg_ctl']) {
  const file = path.join(pg, `${name}.exe`)
  manifest.postgres[name] = { path: file, sha256: digest(await readFile(file)) }
}
await writeFile(path.join(base, 'pr305-native-r1-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ head: manifest.head, source_sha256: manifest.source_sha256, receipt }))
