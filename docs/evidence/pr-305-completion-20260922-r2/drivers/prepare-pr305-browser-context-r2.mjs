import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const [product, qaRoot, destination] = process.argv.slice(2)
assert.ok(product && qaRoot && destination)
const { candidateSourcePins, validateResearchQa, researchDemo } = await import(pathToFileURL(path.join(product, 'tools/research_handoff_browser.mjs')))
const { verifyOwnedTestProcess } = await import(pathToFileURL(path.join(product, 'tools/owned_test_stack.mjs')))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const state = JSON.parse((await readFile(path.join(qaRoot, 'ownership.json'), 'utf8')).replace(/^\uFEFF/u, ''))
assert.equal(state.test_owned, true)
assert.equal(state.plan.product, product)
assert.equal(state.demo.corp_id, researchDemo.corp_id)
assert.equal(state.demo.alice_actor_id, researchDemo.alice_actor_id)
const pins = await candidateSourcePins()
assert.equal(state.source.base_commit, pins.head)
const assets = {}
async function visit(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`
    if (entry.isDirectory()) await visit(path.join(directory, entry.name), `${relative}/`)
    else {
      assert.ok(entry.isFile())
      const url = relative === 'index.html' ? '/' : `/${relative}`
      // Public provenance text is shipped beside runtime assets but is not a
      // browser input in this case. Pin only the admitted built runtime paths;
      // every subsequent unpinned browser request still fails the real lane.
      if (url !== '/' && url !== '/favicon.svg' &&
        !/^\/assets\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:js|css|svg|png|jpg|jpeg|webp|ttf|woff2?)$/.test(url)) continue
      assets[url] = sha(await readFile(path.join(directory, entry.name)))
    }
  }
}
await visit(path.join(qaRoot, 'built-web'))
const context = { schema_version: 1, issue: 297, state: 'candidate_ready', test_owned: true,
  ...pins, source: state.source, fixture: researchDemo, web: { url: state.plan.web, assets } }
for (const name of ['server', 'runner']) {
  const process = state.processes[name]
  const binary = path.join(product, 'target/debug', `crony-${name}.exe`)
  const manifest = { test_owned: true, workspace: product, server_url: state.plan.server,
    platform: 'win32', server: process.pid, server_creation: process.started_utc,
    server_executable: process.executable }
  await verifyOwnedTestProcess({ root: product, server: state.plan.server, binary, manifest, requireListener: name === 'server' })
  context[name] = { [name === 'server' ? 'url' : 'id']: name === 'server' ? state.plan.server : state.plan.runner_id,
    binary, sha256: sha(await readFile(binary)), manifest }
}
validateResearchQa(context)
for (const [asset, hash] of Object.entries(assets)) {
  const response = await fetch(context.web.url + asset)
  assert.ok(response.ok)
  assert.equal(sha(Buffer.from(await response.arrayBuffer())), hash)
}
await writeFile(destination, JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ context: destination, head: pins.head, files_sha256: pins.files_sha256, assets: Object.keys(assets).length, processes_verified: true }))
