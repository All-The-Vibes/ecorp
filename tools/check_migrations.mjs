import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const migrationsRoot = path.join(root, 'db', 'migrations')
const manifestPath = path.join(migrationsRoot, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const files = (await readdir(migrationsRoot))
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort()

assert.equal(manifest.schema_version, 1)
assert.equal(manifest.migrations.length, files.length)
assert.deepEqual(
  manifest.migrations.map((migration) => migration.file),
  files,
  'migration files must match the manifest and be listed in version order',
)

for (const [index, migration] of manifest.migrations.entries()) {
  const previousVersion = manifest.migrations[index - 1]?.version ?? 0
  assert.ok(
    Number.isSafeInteger(migration.version) && migration.version > previousVersion,
    'migration versions must be positive integers in strictly increasing order',
  )
  assert.equal(
    Number(migration.file.slice(0, 4)),
    migration.version,
    `migration ${migration.file} has an unexpected version prefix`,
  )
  const bytes = await readFile(path.join(migrationsRoot, migration.file))
  const sha384 = createHash('sha384').update(bytes).digest('hex')
  assert.equal(
    sha384,
    migration.sha384,
    `migration ${migration.version} was modified; append a new migration instead`,
  )
}

console.log(
  JSON.stringify(
    {
      schema_version: manifest.schema_version,
      migration_count: files.length,
      latest_version: manifest.migrations.at(-1)?.version ?? 0,
      immutable_checksums: true,
    },
    null,
    2,
  ),
)
