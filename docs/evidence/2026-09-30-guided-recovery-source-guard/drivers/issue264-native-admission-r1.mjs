// Executable acceptance input admission. The caller supplies the trusted source
// root and the digest of its freshly captured source receipt; ownership is data.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const executionFiles = Object.freeze([
  'tools/e2e_stopped_source_checkpoint.mjs',
  'tools/qa_factory_run_activity.ps1',
  'tools/qa_multiplayer_preflight.ps1',
  'tools/local_stack.psm1',
  'tools/task_graph_fixture.mjs',
  'tools/owned_test_stack.mjs',
])
const load = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
const inside = (root, target) => {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'))
}

export async function admitNativeAcceptance({ productRoot, qaRoot, sourceReceiptPath, sourceReceiptSha256 }) {
  for (const value of [productRoot, qaRoot, sourceReceiptPath]) {
    assert.ok(typeof value === 'string' && isAbsolute(value), 'Explicit absolute caller paths are required')
  }
  assert.match(sourceReceiptSha256 ?? '', /^[0-9a-f]{64}$/, 'Caller must bind the source receipt digest')
  const product = resolve(productRoot), qa = resolve(qaRoot)
  // Before any product module is imported, reject an alias and bind all runtime
  // inputs using Node built-ins. Detailed path checks below reuse the product's
  // existing stopped-source validator and native supervisor.
  for (const root of [product, qa]) {
    const info = lstatSync(root)
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'A real directory is required')
    assert.equal(realpathSync(root), root, 'Directory alias is not canonical')
  }
  assert.ok(!inside(product, qa) && !inside(qa, product), 'Product and QA roots must not overlap')
  const receiptBytes = readFileSync(sourceReceiptPath)
  assert.equal(hash(receiptBytes), sourceReceiptSha256, 'Caller source receipt digest changed')
  const sourceReceipt = load(receiptBytes)
  const ownership = load(readFileSync(join(qa, 'ownership.json')))
  assert.equal(ownership.purpose, 'pr265-run-activity')
  assert.equal(ownership.test_owned, true)
  assert.equal(ownership.schema_version, 2)
  assert.ok(isAbsolute(ownership.workspace ?? '') && resolve(ownership.workspace) === qa, 'Ownership QA root differs')
  assert.ok(isAbsolute(ownership.plan?.product ?? '') && resolve(ownership.plan.product) === product,
    'Ownership cannot select the executable product root')
  assert.ok(isAbsolute(sourceReceipt.worktree ?? '') && resolve(sourceReceipt.worktree) === product,
    'Source receipt must name the caller product root')
  assert.match(sourceReceipt.identity?.head ?? '', /^[0-9a-f]{40}$/, 'Exact source HEAD is required')
  assert.equal(ownership.plan.product_commit, sourceReceipt.identity.head, 'Ownership source HEAD differs')
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  Object.assign(gitEnv, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' })
  const git = (...args) => execFileSync('git', ['-C', product, ...args],
    { env: gitEnv, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  assert.equal(resolve(git('rev-parse', '--show-toplevel')), product, 'Actual Git root differs')
  assert.equal(git('rev-parse', 'HEAD'), sourceReceipt.identity.head, 'Actual source HEAD differs')
  assert.ok(Array.isArray(sourceReceipt.physical_files) && sourceReceipt.physical_files.length > 0,
    'Physical source capture is required')
  const physical = new Map()
  for (const entry of sourceReceipt.physical_files) {
    assert.ok(Array.isArray(entry) && entry.length === 2, 'Malformed physical source entry')
    const [name, digest] = entry
    assert.ok(typeof name === 'string' && name.length > 0 && !isAbsolute(name) &&
      !name.includes('\\') && !name.includes(':') && name.split('/').every(part => part && part !== '.' && part !== '..'),
    'Physical source path must be a contained relative file')
    assert.match(digest, /^[0-9a-f]{64}$/)
    assert.ok(!physical.has(name), 'Duplicate physical source entry')
    physical.set(name, digest)
    const file = join(product, name), info = lstatSync(file)
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Regular single-link source file required')
    assert.equal(realpathSync(file), file, 'Source alias is not canonical')
    assert.equal(hash(readFileSync(file)), digest, 'Physical source changed: ' + name)
  }
  for (const name of executionFiles) assert.ok(physical.has(name), 'Missing runtime source binding: ' + name)
  // This module has only built-in imports and an inert guarded main. Its bytes
  // were checked above, before import. Reuse its established containment rules.
  const { checkContainedFile } = await import(pathToFileURL(join(product, executionFiles[0])))
  await checkContainedFile(qa, join(qa, 'ownership.json'))
  for (const name of executionFiles) {
    await checkContainedFile(product, join(product, name))
    assert.equal(hash(readFileSync(join(product, name))), physical.get(name), 'Runtime source changed during admission')
  }
  assert.equal(hash(readFileSync(sourceReceiptPath)), sourceReceiptSha256, 'Source receipt changed during admission')
  return { product, qa, ownership, sourceReceipt, sourceReceiptSha256,
    execution_files: Object.fromEntries(executionFiles.map(name => [name, physical.get(name)])) }
}
