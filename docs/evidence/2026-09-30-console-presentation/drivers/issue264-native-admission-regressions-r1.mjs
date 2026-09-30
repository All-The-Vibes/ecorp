// Dedicated native admission lane: fresh owned Git/JSON fixtures; no services,
// product subprocesses, credentials, network requests, or cleanup.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { admitNativeAcceptance, executionFiles } from './issue264-native-admission-r1.mjs'

const evidence = dirname(fileURLToPath(import.meta.url))
const original = '<USERPROFILE>/.codex/worktrees/issue264-modes/ecorp'
const root = join(evidence, 'issue264-native-admission-regressions-r1')
assert.ok(!existsSync(root), 'Preserve all earlier admission regression attempts')
mkdirSync(root)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' })
const report = { started_at: new Date().toISOString(), scope: 'Fresh owned admission fixtures only. No native services or untrusted product code executed.',
  root, source_driver_sha256: hash(readFileSync(join(evidence, 'issue264-native-admission-r1.mjs'))),
  cases: [], status: 'running', resources_preserved: true }
const save = () => write(join(root, 'report.json'), report)
save()
function fixture(name) {
  const home = join(root, name), product = join(home, 'product'), qa = join(home, 'qa'), receiptPath = join(home, 'source.json')
  mkdirSync(join(product, 'tools'), { recursive: true }); mkdirSync(qa)
  for (const name of executionFiles) copyFileSync(join(original, name), join(product, name))
  const git = (...args) => execFileSync('git', ['-C', product, ...args],
    { env, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('-c', 'core.autocrlf=false', 'add', 'tools')
  git('-c', 'user.name=ECorp QA', '-c', 'user.email=qa@ecorp.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=NUL', 'commit', '-m', 'Owned admission fixture')
  const head = git('rev-parse', 'HEAD')
  const receipt = { worktree: product, identity: { head },
    physical_files: executionFiles.map(name => [name, hash(readFileSync(join(product, name)))]) }
  const ownership = { purpose: 'pr265-run-activity', test_owned: true, schema_version: 2, workspace: qa,
    plan: { product, product_commit: head } }
  write(receiptPath, receipt); write(join(qa, 'ownership.json'), ownership)
  return { product, qa, receipt, ownership, receiptPath,
    inputs: () => ({ productRoot: product, qaRoot: qa, sourceReceiptPath: receiptPath,
      sourceReceiptSha256: hash(readFileSync(receiptPath)) }) }
}
const cases = [
  ['valid', null, null],
  ['ownership-product-redirection', f => { f.ownership.plan.product = join(root, 'untrusted-nonexistent-checkout') }, /cannot select/],
  ['source-root-mismatch', f => { f.receipt.worktree = join(root, 'untrusted-nonexistent-checkout') }, /caller product root/],
  ['ownership-head-mismatch', f => { f.ownership.plan.product_commit = 'f'.repeat(40) }, /Ownership source HEAD differs/],
  ['actual-head-mismatch', f => { f.ownership.plan.product_commit = f.receipt.identity.head = 'f'.repeat(40) }, /Actual source HEAD differs/],
  ['supervisor-bytes-changed', f => { writeFileSync(join(f.product, 'tools/qa_factory_run_activity.ps1'), '# changed data; never executed\n') }, /Physical source changed/],
  ['transitive-helper-bytes-changed', f => { writeFileSync(join(f.product, 'tools/owned_test_stack.mjs'), '// changed data; never imported\n') }, /Physical source changed/],
  ['missing-transitive-source', f => { f.receipt.physical_files = f.receipt.physical_files.filter(([name]) => name !== 'tools/owned_test_stack.mjs') }, /Missing runtime source binding/],
  ['escaped-source-path', f => { f.receipt.physical_files.push(['../outside.txt', 'a'.repeat(64)]) }, /contained relative file/],
  ['duplicate-source-path', f => { f.receipt.physical_files.push(f.receipt.physical_files[0]) }, /Duplicate physical source/],
  ['source-hard-link', f => {
    const source = join(f.product, 'tools/task_graph_fixture.mjs'), prior = join(f.product, 'tools/task_graph_fixture-preserved.mjs')
    renameSync(source, prior); linkSync(prior, source)
  }, /single-link source file/],
  ['ownership-hard-link', f => {
    const source = join(f.qa, 'ownership.json'), prior = join(f.qa, 'ownership-preserved.json')
    renameSync(source, prior); linkSync(prior, source)
  }, /regular_single_link_file_required/],
]
for (const [name, mutate, expected] of cases) {
  const item = { name, status: 'running' }; report.cases.push(item); save()
  try {
    const f = fixture(name)
    mutate?.(f)
    // Write receipt mutations before admission. Product code is never patched
    // into something executable; the two changed files are only inert comments.
    write(f.receiptPath, f.receipt)
    if (name !== 'ownership-hard-link') write(join(f.qa, 'ownership.json'), f.ownership)
    if (expected) await assert.rejects(() => admitNativeAcceptance(f.inputs()), expected)
    else {
      const result = await admitNativeAcceptance(f.inputs())
      assert.equal(result.product, f.product)
      assert.deepEqual(Object.keys(result.execution_files), executionFiles)
    }
    item.status = 'passed'
  } catch (error) { item.status = 'failed'; item.failure = String(error.stack ?? error) }
  save()
}
for (const name of ['receipt-digest-mismatch', 'caller-path-missing', 'product-junction']) {
  const item = { name, status: 'running' }; report.cases.push(item); save()
  try {
    const f = fixture(name), inputs = f.inputs()
    if (name === 'receipt-digest-mismatch') {
      inputs.sourceReceiptSha256 = '0'.repeat(64)
      await assert.rejects(() => admitNativeAcceptance(inputs), /digest changed/)
    } else if (name === 'caller-path-missing') {
      delete inputs.productRoot
      await assert.rejects(() => admitNativeAcceptance(inputs), /Explicit absolute caller paths/)
    } else {
      const alias = join(dirname(f.product), 'product-alias')
      symlinkSync(f.product, alias, 'junction'); inputs.productRoot = alias
      await assert.rejects(() => admitNativeAcceptance(inputs), /real directory|not canonical/)
    }
    item.status = 'passed'
  } catch (error) { item.status = 'failed'; item.failure = String(error.stack ?? error) }
  save()
}
report.status = report.cases.every(item => item.status === 'passed') ? 'passed' : 'failed'
report.finished_at = new Date().toISOString(); save()
console.log(JSON.stringify({ status: report.status, passed: report.cases.filter(item => item.status === 'passed').length,
  failed: report.cases.filter(item => item.status === 'failed'), report: join(root, 'report.json') }))
if (report.status !== 'passed') process.exitCode = 1
