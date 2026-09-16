import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))

test('every pinned upstream dependency exists and retains its exact bytes', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'upstream/manifest.json'), 'utf8'))
  assert.equal(manifest.length, 10)
  assert.equal(new Set(manifest.map(({ path }) => path)).size, manifest.length, 'duplicate dependency')
  for (const entry of manifest) {
    const path = resolve(root, entry.path)
    assert.ok(path.startsWith(root), `dependency outside skill: ${entry.path}`)
    assert.match(entry.source, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//)
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), entry.sha256, entry.path)
  }
})

test('the entrypoint and maintained references resolve inside the package', () => {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
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
