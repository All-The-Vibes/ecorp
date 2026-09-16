import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const walk = (path) => {
  const stat = lstatSync(path)
  assert.ok(!stat.isSymbolicLink(), `symlink in package: ${path}`)
  return stat.isDirectory()
    ? readdirSync(path).flatMap((name) => walk(resolve(path, name)))
    : [path]
}

test('every pinned upstream dependency exists and retains its exact bytes', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'upstream/manifest.json'), 'utf8'))
  assert.equal(manifest.length, 10)
  assert.equal(new Set(manifest.map(({ path }) => path)).size, manifest.length, 'duplicate dependency')
  const controlFiles = ['upstream/manifest.json', 'upstream/.gitattributes'].map((path) => resolve(root, path))
  assert.deepEqual(
    walk(resolve(root, 'upstream')).filter((path) => !controlFiles.includes(path)).sort(),
    manifest.map(({ path }) => resolve(root, path)).sort(),
    'upstream files must match manifest paths',
  )
  for (const entry of manifest) {
    const path = resolve(root, entry.path)
    assert.ok(path.startsWith(root), `dependency outside skill: ${entry.path}`)
    assert.match(entry.source, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//)
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), entry.sha256, entry.path)
  }
})

test('the entrypoint and maintained references resolve inside the package', () => {
  const files = [resolve(root, 'SKILL.md'), ...walk(resolve(root, 'references'))]
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^https:\/\//.test(href)) continue
      const target = resolve(dirname(file), href.split('#')[0])
      assert.ok(target.startsWith(root.endsWith(sep) ? root : root + sep), href)
      assert.ok(statSync(target).isFile(), `${file}: ${href}`)
    }
  }
  const entrypoint = readFileSync(resolve(root, 'SKILL.md'), 'utf8')
  assert.match(entrypoint, /^---\r?\nname: code-review\r?\ndescription: [^\r\n]+\r?\n---/)
})
