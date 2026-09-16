import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const sql = 'SELECT 1;\n'
const sha384 = createHash('sha384').update(sql).digest('hex')

async function fixture(t, versions) {
  const root = path.resolve(import.meta.dirname, '..', 'output', `migration-check-${randomUUID()}`)
  const migrationsRoot = path.join(root, 'db', 'migrations')
  await mkdir(migrationsRoot, { recursive: true })
  t.after(() => rm(root, { recursive: true }))
  await mkdir(path.join(root, 'tools'))
  const script = path.join(root, 'tools', 'check_migrations.mjs')
  await copyFile(path.join(import.meta.dirname, 'check_migrations.mjs'), script)
  const manifest = {
    schema_version: 1,
    migrations: versions.map((version, index) => ({
      version,
      file: `${String(version).padStart(4, '0')}_fixture_${index}.sql`,
      sha384,
    })),
  }
  for (const migration of manifest.migrations) {
    await writeFile(path.join(migrationsRoot, migration.file), sql)
  }
  return {
    manifest,
    migrationsRoot,
    async check() {
      await writeFile(path.join(migrationsRoot, 'manifest.json'), JSON.stringify(manifest))
      const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 })
      assert.ifError(result.error)
      assert.notEqual(result.status, null, result.stderr)
      return result
    },
  }
}

for (const versions of [[1, 2, 3], [1, 46, 50]]) {
  test(`accepts ordered migration versions ${versions.join(', ')}`, async (t) => {
    const f = await fixture(t, versions)
    const result = await f.check()
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      schema_version: 1,
      migration_count: versions.length,
      latest_version: versions.at(-1),
      immutable_checksums: true,
    })
  })
}

for (const versions of [[1, 1], [2, 1], [0, 1]]) {
  test(`rejects invalid migration ordering ${versions.join(', ')}`, async (t) => {
    const f = await fixture(t, versions)
    assert.notEqual((await f.check()).status, 0)
  })
}

for (const version of ['2', 2.5, 3]) {
  test(`rejects malformed or mismatched version ${JSON.stringify(version)}`, async (t) => {
    const f = await fixture(t, [1, 2])
    f.manifest.migrations[1].version = version
    assert.notEqual((await f.check()).status, 0)
  })
}

test('rejects edited historical SQL even with a valid manifest', async (t) => {
  const f = await fixture(t, [1, 2])
  await writeFile(path.join(f.migrationsRoot, f.manifest.migrations[0].file), 'SELECT 2;\n')
  const result = await f.check()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /was modified; append a new migration instead/)
})

test('rejects missing or unlisted migration files', async (t) => {
  const f = await fixture(t, [1, 2])
  const migrationPath = path.join(f.migrationsRoot, f.manifest.migrations[1].file)
  await rm(migrationPath)
  assert.notEqual((await f.check()).status, 0)
  await writeFile(migrationPath, sql)
  await writeFile(path.join(f.migrationsRoot, '0003_unlisted.sql'), sql)
  assert.notEqual((await f.check()).status, 0)
})

for (const autocrlf of ['true', 'false']) {
  test(`canonical migration checkout passes with core.autocrlf=${autocrlf}`, async (t) => {
    const repositoryRoot = path.resolve(import.meta.dirname, '..')
    const root = path.join(repositoryRoot, 'output', `migration-checkout-${randomUUID()}`)
    const checkout = path.join(root, 'checkout')
    await mkdir(checkout, { recursive: true })
    t.after(() => rm(root, { recursive: true }))
    const env = { ...process.env, GIT_INDEX_FILE: path.join(root, 'index') }
    const git = (...args) => {
      const result = spawnSync('git', ['-c', `core.autocrlf=${autocrlf}`, ...args], {
        cwd: repositoryRoot, env, encoding: 'utf8', timeout: 30_000,
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr)
      return result.stdout
    }
    const paths = ['.gitattributes', 'db/migrations', 'tools/check_migrations.mjs']
    // Include proposed changes without staging the contributor's real index.
    git('read-tree', 'HEAD')
    git('add', '--', ...paths)
    const files = git('ls-files', '-z', '--', ...paths).split('\0').filter(Boolean)
    git('checkout-index', `--prefix=${checkout}${path.sep}`, '--', ...files)
    for (const file of files.filter((file) => file.endsWith('.sql'))) {
      const bytes = await readFile(path.join(checkout, file))
      assert.equal(bytes.includes(13), false, `${file} must retain canonical LF bytes`)
    }
    const result = spawnSync(process.execPath, [path.join(checkout, 'tools', 'check_migrations.mjs')], {
      encoding: 'utf8', timeout: 10_000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
  })
}
