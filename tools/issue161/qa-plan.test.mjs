import assert from 'node:assert/strict'
import test from 'node:test'
import { createQaPlan, parseOptions } from './qa-plan.mjs'

const options = { dryRun: true, qaRoot: 'C:\\ecorp\\qa\\issue-161-isolated', pgBin: 'C:\\pg\\bin',
  worktree: 'C:\\ecorp\\contributions\\issue-161', sourceCheckout: 'C:\\dev\\ecorp' }
const reads = { platform: 'win32', exists: value => value !== options.qaRoot, realpath: value => value }

test('preview has no mutations and keeps all resources outside both checkouts', () => {
  const plan = createQaPlan(options, reads)
  assert.deepEqual(plan.mutations, [])
  assert.equal(plan.boundaries.services_started, false)
  assert.equal(plan.proposed_resources.runner_roots.length, 2)
  assert.equal(plan.proposed_resources.controller_count, 2)
  assert.match(plan.boundaries.multi_host_acceptance, /not covered/)
})

test('reject execution, occupied roots, missing binaries, redirects and unsafe paths', () => {
  assert.throws(() => createQaPlan({ ...options, dryRun: false }, reads))
  assert.throws(() => createQaPlan(options, { ...reads, exists: () => true }))
  assert.throws(() => createQaPlan(options, { ...reads, exists: value => reads.exists(value) && !value.endsWith('pg_ctl.exe') }))
  assert.throws(() => createQaPlan(options, { ...reads, realpath: () => 'C:\\elsewhere' }))
  for (const qaRoot of ['C:\\', 'relative', 'C:\\ecorp\\qa\\..\\qa\\issue-161-isolated',
    'C:\\ecorp\\qa\\retained-office', 'C:\\dev\\ecorp\\qa\\issue-161-invalid']) {
    assert.throws(() => createQaPlan({ ...options, qaRoot }, reads))
  }
})

test('parser permits only explicit dry-run setup options and rejects ambiguous input', () => {
  assert.deepEqual(parseOptions(['--dry-run', '--qa-root', options.qaRoot, '--pg-bin', options.pgBin,
    '--worktree', options.worktree, '--source-checkout', options.sourceCheckout]), options)
  for (const args of [['--execute'], ['--dry-run', '--dry-run'], ['--qa-root'],
    ['--qa-root', '--dry-run'], ['--qa-root', 'a', '--qa-root', 'b']]) {
    assert.throws(() => parseOptions(args))
  }
})
