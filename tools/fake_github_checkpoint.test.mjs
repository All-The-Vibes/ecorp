import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Safe full-Node-discovery coverage. Only unique local JSON/body files are used;
// these tests never contact GitHub, launch the stack or execute the live driver.
const script = fileURLToPath(new URL('./fake_github_cli.mjs', import.meta.url))
const repository = 'Example/Repo'
const branch = 'ecorp/checkpoint-72'
const commit = 'a'.repeat(40)
const token = 'synthetic-publisher-credential-do-not-echo'

function fixture(t, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ecorp-fake-github-checkpoint-'))
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('ecorp-fake-github-checkpoint-'))
    rmSync(directory, { recursive: true, force: true })
  })
  const statePath = join(directory, 'state.json')
  const bodyPath = join(directory, 'body.md')
  const read = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const write = state => writeFileSync(statePath, `${JSON.stringify(state)}\n`)
  write({ repository, branch_heads: { [branch]: commit }, ...extra })
  writeFileSync(bodyPath, '## Draft checkpoint\r\nFocused: passed\nFull: pending\nRésumé 🚀\n')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:ECORP_|CRONY_|GH_|GITHUB_|AZURE_|NODE_OPTIONS$)/i.test(key)))
  function run(args, { status = 0, environment = {} } = {}) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { ...env, ECORP_FAKE_GITHUB_STATE: statePath,
        ECORP_FAKE_GITHUB_EXPECT_TOKEN: token, GH_TOKEN: token, GITHUB_TOKEN: token,
        ...environment },
    })
    assert.ifError(result.error)
    assert.equal(result.status, status, result.stderr)
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token))
    return result
  }
  const createArgs = ['pr', 'create', '--repo', repository, '--head', branch,
    '--base', 'main', '--title', 'Checkpoint 72', '--body-file', bodyPath]
  const view = (number = 1) => JSON.parse(run(['pr', 'view', String(number), '--repo', repository,
    '--json', 'number,id,url,state,isDraft,title,body,headRefName,headRefOid,baseRefName,autoMergeRequest']).stdout)
  return { read, write, run, createArgs, view, bodyPath }
}

test('a lost draft-create response leaves one recoverable PR on the stable branch', t => {
  const f = fixture(t, { fail_pr_create_after_success: true })
  f.run([...f.createArgs, '--draft'], { status: 1 })
  const observed = f.view()
  assert.equal(observed.isDraft, true)
  assert.equal(observed.state, 'OPEN')
  assert.equal(observed.autoMergeRequest, null)
  assert.equal(observed.headRefName, branch)
  assert.equal(observed.headRefOid, commit)
  assert.equal(observed.body, readFileSync(f.bodyPath, 'utf8'))
  const listed = JSON.parse(f.run(['pr', 'list', '--repo', repository,
    '--state', 'all', '--head', branch, '--base', 'main']).stdout)
  assert.deepEqual(listed, [observed])
  f.run([...f.createArgs, '--draft'], { status: 1 })
  assert.deepEqual(f.view(), observed)
  assert.equal(f.read().pull_requests.length, 1)
  assert.equal(f.read().pr_create_calls, 1)
  assert.equal(f.read().pr_create_external_success_failures, 1)
})

test('a lost gate-edit response can be reconciled without replacing the draft identity', t => {
  const f = fixture(t)
  f.run([...f.createArgs, '--draft'])
  const original = f.view()
  const state = f.read()
  state.fail_pr_edit_after_success = true
  f.write(state)
  const body = 'Focused: passed\r\nFull: failed\nNot ready for review.\n'
  writeFileSync(f.bodyPath, body)
  f.run(['pr', 'edit', '1', '--repo', repository, '--title', 'Checkpoint: failed verification',
    '--body-file', f.bodyPath], { status: 1 })
  const updated = f.view()
  assert.equal(updated.body, body)
  assert.equal(updated.title, 'Checkpoint: failed verification')
  for (const field of ['number', 'id', 'url', 'headRefName', 'headRefOid', 'baseRefName', 'state', 'isDraft', 'autoMergeRequest']) {
    assert.deepEqual(updated[field], original[field], field)
  }
  assert.equal(f.read().pr_edit_calls, 1)
  assert.equal(f.read().pr_edit_external_success_failures, 1)
  assert.equal(f.read().pr_create_calls, 1)
})

test('explicit ready and undo affect only draft state and preserve unknown-outcome evidence', t => {
  const f = fixture(t, { fail_pr_ready_after_success: true })
  f.run([...f.createArgs, '--draft'])
  const original = f.view()
  f.run(['pr', 'ready', '1', '--repo', repository], { status: 1 })
  assert.deepEqual(f.view(), { ...original, isDraft: false })
  assert.equal(f.read().pr_ready_external_success_failures, 1)
  f.run(['pr', 'ready', '1', '--repo', repository, '--undo'])
  assert.deepEqual(f.view(), original)
  const state = f.read()
  state.pull_requests[0].state = 'CLOSED'
  f.write(state)
  f.run(['pr', 'ready', '1', '--repo', repository], { status: 1 })
  assert.equal(f.read().pr_ready_calls, 2)
  assert.equal(f.read().pull_requests[0].state, 'CLOSED')
  assert.equal(f.read().pull_requests[0].autoMergeRequest, null)
})

test('known-PR reads expose human changes and never select a replacement for a missing identity', t => {
  const f = fixture(t)
  f.run([...f.createArgs, '--draft'])
  const state = f.read()
  state.pr_view_mutation = { call: 1, number: 1, patch: { title: 'Human title', body: 'Human body', isDraft: false } }
  f.write(state)
  assert.equal(f.view().body, 'Human body')
  assert.equal(f.view().title, 'Human title')
  assert.equal(f.view().isDraft, false)
  assert.equal(f.read().pr_view_mutations_applied, 1)
  const before = f.read()
  for (const selector of ['0', '2', '-1', branch, 'NaN']) {
    f.run(['pr', 'view', selector, '--repo', repository], { status: 1 })
  }
  assert.deepEqual(f.read(), before)
})

test('draft operations reject wrong repository, missing PR and unbrokered credentials without effects', t => {
  const f = fixture(t)
  f.run([...f.createArgs, '--draft'])
  for (const operation of ['view', 'edit', 'ready']) {
    const extra = operation === 'edit' ? ['--title', 'New', '--body-file', f.bodyPath] : []
    const before = f.read()
    f.run(['pr', operation, '1', '--repo', 'Elsewhere/Repo', ...extra], { status: 1 })
    f.run(['pr', operation, '2', '--repo', repository, ...extra], { status: 1 })
    f.run(['pr', operation, '1', '--repo', repository, ...extra], {
      status: 1, environment: { GH_TOKEN: 'different-synthetic-credential' },
    })
    assert.deepEqual(f.read(), before)
  }
  assert.ok(!JSON.stringify(f.read().effect_log).includes(token))
})

test('ordinary creation remains ready while missing branch evidence prevents any creation', t => {
  const f = fixture(t, { branch_heads: {} })
  f.run([...f.createArgs, '--draft'], { status: 1 })
  assert.equal(f.read().pull_requests, undefined)
  const state = f.read()
  state.branch_heads[branch] = commit
  f.write(state)
  f.run(f.createArgs)
  assert.equal(f.view().isDraft, false)
  assert.equal(f.view().autoMergeRequest, null)
})
