// Local GitHub Contents API fixture. Only the native publisher creates objects.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

assert.equal(process.env.CRONY_NATIVE_QUALIFICATION, '1')
assert.ok(process.env.CRONY_NATIVE_OUTPUT && path.isAbsolute(process.env.CRONY_NATIVE_OUTPUT))
const output = path.resolve(process.env.CRONY_NATIVE_OUTPUT)
const repository = path.join(output, 'github-fixture.git')
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
  GIT_AUTHOR_NAME: 'Local Qualification Fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid.local',
  GIT_COMMITTER_NAME: 'Local Qualification Fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid.local',
}
await mkdir(output, { recursive: true })
function git(args, input) {
  return execFileSync('git', ['--git-dir', repository, ...args], {
    env, input, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  })
}
const exists = spawnSync('git', ['--git-dir', repository, 'rev-parse', '--is-bare-repository'], { env, stdio: 'ignore' }).status === 0
if (!exists) {
  execFileSync('git', ['init', '--bare', repository], { env, stdio: 'ignore' })
  const tree = git(['mktree'], '').toString().trim()
  const commit = git(['commit-tree', tree], 'Initialize local native audit fixture\n').toString().trim()
  git(['update-ref', 'refs/heads/audit', commit])
}
const head = () => git(['rev-parse', 'refs/heads/audit']).toString().trim()
const sha = (value) => /^[0-9a-f]{40}$/.test(value)
const safePath = (value) => value.length <= 512 && value.split('/').every((part) =>
  /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) && !part.includes('..') && !part.endsWith('.lock') && !part.endsWith('.'))
function blobAt(commit, file) {
  const result = spawnSync('git', ['--git-dir', repository, 'rev-parse', '--verify', `${commit}:${file}`], { env, encoding: 'utf8' })
  if (result.status !== 0) return null
  const blob = result.stdout.trim()
  assert.ok(sha(blob))
  return { sha: blob, bytes: git(['cat-file', 'blob', blob]) }
}
function objects() {
  const commit = head()
  const entries = git(['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean).map((entry) => {
    const [metadata, name] = entry.split('\t')
    const blob = metadata.split(' ')[2]
    return { path: name, blob_sha: blob, bytes: Number(git(['cat-file', '-s', blob]).toString()) }
  })
  return { commit, entries, identity: 'Actual immutable Git commit/tree/blob objects; local fixture, not GitHub infrastructure.' }
}
function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
let writes = 0
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:18558')
    const prefix = '/repos/qualification/native-audit/'
    if (request.method === 'GET' && url.pathname === '/qualification/objects') {
      return send(response, 200, { ...objects(), writes })
    }
    if (!url.pathname.startsWith(prefix)) return send(response, 404, { error: 'Not found' })
    const route = url.pathname.slice(prefix.length)
    if (request.method === 'GET' && route === 'branches/audit') return send(response, 200, { commit: { sha: head() } })
    if (request.method === 'GET' && route.startsWith('compare/')) {
      const [old, current] = route.slice(8).split('...')
      if (!sha(old) || !sha(current)) return send(response, 400, { error: 'Invalid identity' })
      const descendant = spawnSync('git', ['--git-dir', repository, 'merge-base', '--is-ancestor', old, current], { env, stdio: 'ignore' }).status === 0
      return send(response, 200, { status: descendant ? (old === current ? 'identical' : 'ahead') : 'diverged', merge_base_commit: { sha: descendant ? old : current } })
    }
    if (!route.startsWith('contents/')) return send(response, 404, { error: 'Not found' })
    const file = decodeURIComponent(route.slice(9))
    if (!safePath(file)) return send(response, 400, { error: 'Invalid path' })
    if (request.method === 'GET') {
      const commit = url.searchParams.get('ref')
      if (!sha(commit)) return send(response, 400, { error: 'Immutable ref required' })
      const blob = blobAt(commit, file)
      if (!blob) return send(response, 404, { error: 'Not found' })
      return send(response, 200, { type: 'file', encoding: 'base64', path: file, sha: blob.sha, content: blob.bytes.toString('base64') })
    }
    if (request.method !== 'PUT') return send(response, 405, { error: 'Unsupported method' })
    let body = Buffer.alloc(0)
    for await (const chunk of request) {
      if (body.length + chunk.length > 400_000) return send(response, 413, { error: 'Request exceeds bound' })
      body = Buffer.concat([body, chunk])
    }
    const value = JSON.parse(body.toString())
    if (value.branch !== 'audit' || value.sha !== undefined || typeof value.content !== 'string') return send(response, 400, { error: 'Additive create required' })
    const previous = head()
    if (blobAt(previous, file)) return send(response, 422, { error: 'Immutable path already exists' })
    const bytes = Buffer.from(value.content, 'base64')
    if (bytes.length > 262144) return send(response, 413, { error: 'File exceeds bound' })
    const blob = git(['hash-object', '-w', '--stdin'], bytes).toString().trim()
    git(['read-tree', previous])
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`])
    const tree = git(['write-tree']).toString().trim()
    const commit = git(['commit-tree', tree, '-p', previous], 'Add immutable ECorp audit checkpoint\n').toString().trim()
    git(['update-ref', 'refs/heads/audit', commit, previous])
    assert.ok(blobAt(commit, file).bytes.equals(bytes))
    writes += 1
    await writeFile(path.join(output, 'github-objects.json'), `${JSON.stringify({ ...objects(), writes }, null, 2)}\n`)
    return send(response, 201, { commit: { sha: commit }, content: { sha: blob, path: file } })
  } catch {
    // Never disclose request content or signed bytes in failure responses.
    send(response, 500, { error: 'Local GitHub fixture operation failed' })
  }
})
server.listen(18558, '127.0.0.1', () => console.log('Native local GitHub fixture ready on exact loopback18558.'))
