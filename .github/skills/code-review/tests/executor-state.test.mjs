import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../scripts/executor-state.mjs', import.meta.url))
const owner = 'native-task-1'
const repo = 'example/ecorp'
const sha = (n) => n.toString(16).padStart(40, '0')
const key = (n) => n.toString(16).padStart(64, '0')
const init = { owner, repo, model: 'gpt-6-astra', policySha: sha(99), canary: 1 }
const pr = (number = 1, extra = {}) => ({
  number, base: sha(10), head: sha(11), reviewKey: key(1), gateKey: key(1),
  sourceRepo: repo, branch: `fix-${number}`, state: 'open', draft: false,
  url: `https://github.com/${repo}/pull/${number}`, ...extra,
})
const fixture = () => join(mkdtempSync(join(tmpdir(), 'executor-state-test-')), 'state')
const run = (dir, command, input, ok = true) => {
  const result = spawnSync(process.execPath, [script, dir, command], {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(result.status, ok ? 0 : 1, result.stderr || result.stdout)
  const output = JSON.parse(result.stdout)
  if (!ok) assert.equal(typeof output.error, 'string')
  return output
}
const setup = (prs = [pr()]) => {
  const dir = fixture()
  run(dir, 'init', init)
  run(dir, 'sync', { owner, complete: true, prs })
  return dir
}
const next = (dir) => run(dir, 'next', { owner })
const start = (dir) => {
  const claim = next(dir)
  return run(dir, 'begin', { owner, number: claim.number, claimId: claim.claimId, base: claim.base, head: claim.head })
}
const saveInput = (claim, extra = {}) => ({
  owner, number: claim.number, claimId: claim.claimId, base: claim.base, head: claim.head,
  phase: 'waiting', evidence: ['evidence/attempt.json'], findings: [],
  technicalVerdict: null, reason: 'Waiting for CI', ...extra,
})
const reviewers = (claim) => [1, 2].map((n) => ({
  reviewerId: `${claim.claimId}-reviewer-${n}`, model: 'gpt-6-astra',
  base: claim.base, head: claim.head, verdict: 'NICE',
  completedAt: new Date().toISOString(), sourceRef: `evidence/${claim.claimId}-review-${n}.json`,
  criteria: [{ id: 'rubric', result: 'PASS', sourceRef: 'evidence/rubric.json' }],
}))
const complete = (dir) => {
  const claim = start(dir)
  const receipts = reviewers(claim)
  run(dir, 'save', saveInput(claim, { phase: 'complete', technicalVerdict: 'NICE', reviewers: receipts }))
  return { claim, receipts }
}
const proof = (claim, receipts) => ({
  number: claim.number, base: claim.base, head: claim.head, reviewers: receipts,
  ci: { base: claim.base, head: claim.head, status: 'passed', sourceRef: 'https://ci.example/run/1', verifiedAt: new Date().toISOString() },
  push: { repo, branch: 'fix-1', before: sha(9), head: claim.head, sourceRef: 'evidence/real-push.json', pushedAt: new Date().toISOString() },
  schedulerWake: { id: 'native-wake-1', at: new Date().toISOString(), sourceRef: 'evidence/native-wake.json' },
  resumeRef: 'evidence/resume.json', quietNoopRef: 'evidence/quiet-noop.json',
  copilot: { reviewId: 123, head: claim.head, automatic: true, sourceRef: 'https://github.com/example/ecorp/pull/1#pullrequestreview-123' },
  audits: { atvRef: 'evidence/atv.json', ponytailRef: 'evidence/ponytail.json' },
  fixers: [{ issueId: 'finding-1', agentId: 'fixer-1', model: 'gpt-6-astra', sourceRef: 'evidence/fixer.json', redRef: 'evidence/red.txt', greenRef: 'evidence/green.txt' }],
})

// Fixtures are intentionally retained, including failed attempts. No test removes a lock.
test('CLI exists (red-first missing-module check)', () => {
  assert.ok(existsSync(script), 'executor-state.mjs is not implemented')
})

test('initialization is immutable, owner-bound, outside worktrees, and never repairs missing state', () => {
  const dir = setup()
  const original = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'init', { ...init, model: 'other' }, false)
  run(dir, 'next', { owner: 'other-task' }, false)
  run(dir, 'sync', { owner, complete: true, prs: [pr()], repo: 'other/repo' }, false)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), original)
  const missing = fixture()
  mkdirSync(missing)
  run(missing, 'init', init, false)
  run(missing, 'show', undefined, false)
  const worktree = fixture()
  mkdirSync(worktree)
  writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere')
  run(join(worktree, 'state'), 'init', init, false)
})

test('inventory rejects partial, duplicates and malformed fields', () => {
  const dir = setup()
  for (const input of [
    { owner, prs: [pr()] }, { owner, complete: false, prs: [pr()] },
    { owner, complete: true, prs: [pr(), pr()] },
    { owner, complete: true, prs: [pr(1, { base: 'bad' })] },
    { owner, complete: true, prs: [pr(1, { gateKey: '' })] },
    { owner, complete: true, prs: [pr(1, { state: 'unknown' })] },
    { owner, complete: true, prs: [pr(1, { readError: 'other' })] },
  ]) run(dir, 'sync', input, false)
})

test('resume and unchanged waiting are no-ops; gate checks do not spend rounds', () => {
  const dir = setup()
  const claim = start(dir)
  assert.equal(next(dir).claimId, claim.claimId)
  run(dir, 'begin', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head }, false)
  run(dir, 'save', saveInput(claim))
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(next(dir).action, 'none')
  run(dir, 'sync', { owner, complete: true, prs: [pr()] })
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { gateKey: key(2) })] })
  const gate = next(dir)
  assert.equal(gate.action, 'check')
  run(dir, 'save', saveInput(gate))
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
})

test('two consecutive no-progress rounds survive head/review changes and process restart', () => {
  const dir = setup()
  for (let n = 0; n < 2; n++) {
    const claim = start(dir)
    run(dir, 'save', saveInput(claim, { phase: 'blocked', reason: 'Audit failed' }))
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(12 + n), reviewKey: key(n + 2) })] })
  }
  const blocked = next(dir)
  assert.equal(blocked.action, 'blocked')
  assert.match(blocked.reason, /no.progress/)
  const state = run(dir, 'show')
  assert.equal(state.prs['1'].cycles[0].rounds, 2)
  assert.equal(state.prs['1'].cycles[0].noProgress, 2)
  assert.equal(next(dir).action, 'none')
})

test('three-round bound survives heads with verified progress and retains failure evidence', () => {
  const dir = setup()
  const open = (id) => ({ id, status: 'open', evidence: [] })
  const fixed = (id) => ({ id, status: 'fixed', evidence: [`evidence/${id}-green.json`] })
  const ledgers = [[open('a'), open('b')], [fixed('a'), open('b')], [fixed('a'), fixed('b')]]
  for (let n = 0; n < 3; n++) {
    const claim = start(dir)
    run(dir, 'save', saveInput(claim, { findings: ledgers[n] }))
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(12 + n) })] })
  }
  assert.match(next(dir).reason, /round/)
  const state = run(dir, 'show')
  assert.equal(state.prs['1'].cycles[0].rounds, 3)
  assert.equal(state.prs['1'].cycles.length, 1)
  const journal = JSON.parse(readFileSync(join(dir, 'state.json')))
  assert.equal(journal.events.filter((e) => e.command === 'save').length, 3)
})

test('fresh structured NICE allows a new cycle only on a changed head', () => {
  const dir = setup()
  complete(dir)
  assert.equal(next(dir).action, 'none')
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(12) })] })
  start(dir)
  const cycles = run(dir, 'show').prs['1'].cycles
  assert.equal(cycles.length, 2)
  assert.equal(cycles[0].technicalVerdict, 'NICE')
  assert.equal(cycles[1].rounds, 1)
})

test('waiting PR does not hide other PRs; forks are blocked, not reviewed', () => {
  const others = [pr(2), pr(3, { sourceRepo: 'fork/ecorp' }), pr(4, { readError: 'DETAIL_READ_FAILED' }), pr(5)]
  const dir = setup([pr(), ...others])
  assert.equal(next(dir).number, 1)
  const gate = next(dir)
  run(dir, 'save', saveInput(gate))
  assert.equal(next(dir).action, 'none', 'canary restricts scheduling until enable')
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(12) }), ...others] })
  const { claim, receipts } = complete(dir)
  run(dir, 'enable', { owner, acceptanceProof: proof(claim, receipts) })
  const second = next(dir)
  assert.equal(second.number, 2)
  run(dir, 'save', saveInput(second, { phase: 'blocked' }))
  const fork = next(dir)
  assert.equal(fork.number, 3)
  assert.equal(fork.action, 'blocked')
  assert.match(fork.reason, /fork/)
  assert.equal(run(dir, 'show').prs['3'].cycles[0].technicalVerdict, null)
  const inaccessible = next(dir)
  assert.equal(inaccessible.number, 4)
  assert.match(inaccessible.reason, /DETAIL_READ_FAILED/)
  const remaining = next(dir)
  assert.equal(remaining.number, 5)
  run(dir, 'save', saveInput(remaining))
  assert.equal(next(dir).action, 'none')
})

test('stale base/head/review claims fail; interrupted work keeps its budget', () => {
  for (const change of [{ base: sha(20) }, { head: sha(20) }, { reviewKey: key(2) }]) {
    const dir = setup()
    const claim = start(dir)
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, change)] })
    run(dir, 'save', saveInput(claim), false)
    const state = run(dir, 'show')
    assert.equal(state.prs['1'].cycles[0].rounds, 1)
    assert.equal(state.prs['1'].cycles[0].noProgress, 1)
  }
})

test('lock collisions fail closed without stealing; corruption stays byte-for-byte intact', () => {
  const dir = setup()
  writeFileSync(join(dir, 'executor.lock'), 'original-lock')
  run(dir, 'next', { owner }, false)
  assert.equal(readFileSync(join(dir, 'executor.lock'), 'utf8'), 'original-lock')
  for (const bytes of ['{', '{}', '{"version":1,"events":[]}', '{"version":1,"events":[{"command":"init"}]}']) {
    const broken = fixture()
    mkdirSync(broken)
    writeFileSync(join(broken, 'state.json'), bytes)
    run(broken, 'show', undefined, false)
    run(broken, 'init', init, false)
    assert.equal(readFileSync(join(broken, 'state.json'), 'utf8'), bytes)
  }
})

test('unknown phases, uncharged audits, dropped findings and plain NICE fail closed', () => {
  const dir = setup()
  const gate = next(dir)
  run(dir, 'save', saveInput(gate, { phase: 'auditing' }), false)
  const claim = run(dir, 'begin', { owner, number: 1, claimId: gate.claimId, base: gate.base, head: gate.head })
  run(dir, 'save', saveInput(claim, { phase: 'invented' }), false)
  run(dir, 'save', saveInput(claim, { phase: 'complete', technicalVerdict: 'NICE' }), false)
  run(dir, 'save', saveInput(claim, { phase: 'fixing', findings: [{ id: 'bug', status: 'open', evidence: [] }] }))
  run(dir, 'save', saveInput(claim), false)
})

test('NICE rejects stale, duplicated, malformed, non-passing and self reviewers', () => {
  const dir = setup()
  const claim = start(dir)
  const good = reviewers(claim)
  const badReceipts = [
    [], [good[0]], [good[0], good[0]],
    [good[0], { ...good[1], head: sha(999) }],
    [good[0], { ...good[1], completedAt: '2000-01-01T00:00:00.000Z' }],
    [good[0], { ...good[1], sourceRef: '' }],
    [good[0], { ...good[1], reviewerId: owner }],
    [good[0], { ...good[1], verdict: 'NAUGHTY' }],
    [good[0], { ...good[1], criteria: [] }],
  ]
  for (const receipts of badReceipts) {
    run(dir, 'save', saveInput(claim, { phase: 'complete', technicalVerdict: 'NICE', reviewers: receipts }), false)
  }
  run(dir, 'save', saveInput(claim, { phase: 'complete', technicalVerdict: 'NICE', reviewers: good }))
})

test('enable requires explicit complete acceptance at current revision, including CI and actual push', () => {
  const dir = setup()
  run(dir, 'enable', { owner, acceptanceProof: {} }, false)
  const { claim, receipts } = complete(dir)
  const good = proof(claim, receipts)
  for (const bad of [
    'NICE', { ...good, ci: undefined }, { ...good, push: undefined },
    { ...good, reviewers: [] }, { ...good, ci: { ...good.ci, status: 'pending' } },
    { ...good, push: { ...good.push, before: claim.head } },
    { ...good, push: { ...good.push, repo: 'other/ecorp' } },
  ]) run(dir, 'enable', { owner, acceptanceProof: bad }, false)
  run(dir, 'enable', { owner, acceptanceProof: good })
  assert.equal(run(dir, 'show').enabled, true)
  const stale = setup()
  const prior = complete(stale)
  run(stale, 'sync', { owner, complete: true, prs: [pr(1, { readError: 'DETAIL_READ_FAILED' })] })
  run(stale, 'enable', { owner, acceptanceProof: proof(prior.claim, prior.receipts) }, false)
  run(stale, 'sync', { owner, complete: true, prs: [pr(1, { base: sha(30) })] })
  run(stale, 'enable', { owner, acceptanceProof: proof(prior.claim, prior.receipts) }, false)
})

test('manual canary alone cannot activate without native wake, resume, quiet, automatic review and fixer receipts', () => {
  const dir = setup()
  const { claim, receipts } = complete(dir)
  const good = proof(claim, receipts)
  for (const field of ['schedulerWake', 'resumeRef', 'quietNoopRef', 'copilot', 'audits', 'fixers']) {
    const bad = { ...good }
    delete bad[field]
    run(dir, 'enable', { owner, acceptanceProof: bad }, false)
  }
  for (const bad of [
    { ...good, resumeRef: '' }, { ...good, quietNoopRef: '' },
    { ...good, schedulerWake: { ...good.schedulerWake, at: '2000-01-01T00:00:00.000Z' } },
    { ...good, copilot: { ...good.copilot, automatic: false } },
    { ...good, copilot: { ...good.copilot, head: sha(99) } },
    { ...good, audits: { atvRef: '', ponytailRef: 'p' } }, { ...good, fixers: [] },
    { ...good, fixers: [{ ...good.fixers[0], greenRef: good.fixers[0].redRef }] },
  ]) run(dir, 'enable', { owner, acceptanceProof: bad }, false)
  run(dir, 'enable', { owner, acceptanceProof: good })
})

test('snapshot nullable sources stay blocked and source identity cannot be laundered through null', () => {
  const dir = setup([pr(1, { sourceRepo: null }), pr(2)])
  assert.equal(next(dir).action, 'blocked')
  assert.equal(run(dir, 'show').prs['2'].present, true)
  const fork = setup([pr(1, { sourceRepo: 'fork/ecorp' })])
  run(fork, 'sync', { owner, complete: true, prs: [pr(1, { sourceRepo: null })] })
  run(fork, 'sync', { owner, complete: true, prs: [pr()] })
  assert.equal(next(fork).action, 'blocked')
  const casing = setup([pr(1, { sourceRepo: 'EXAMPLE/ECORP' })])
  assert.equal(next(casing).action, 'audit')
})

test('help describes the complete stdin interface without state access', () => {
  const help = run(fixture(), 'help')
  assert.match(help.help, /schedulerWake/)
  assert.match(help.help, /claimId/)
})

test('integration: a complete empty inventory preserves absent active work until explicitly blocked', () => {
  const dir = setup()
  const claim = start(dir)
  run(dir, 'sync', { owner, complete: true, prs: [] })
  assert.equal(run(dir, 'show').prs['1'].present, false)
  assert.equal(next(dir).action, 'reconcile')
  assert.equal(next(dir).claimId, claim.claimId)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', reason: 'PR no longer open; retain worktree' }))
  assert.equal(next(dir).action, 'none')
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
})

test('integration: gate changes resume same round and expose saved evidence; conflicting revisions retain WIP', () => {
  const dir = setup()
  const claim = start(dir)
  run(dir, 'save', saveInput(claim, { phase: 'auditing', reason: 'Resume session 17', evidence: ['session-17.json'] }))
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { gateKey: key(2) })] })
  const resumed = next(dir)
  assert.equal(resumed.claimId, claim.claimId)
  assert.notEqual(resumed.action, 'reconcile')
  assert.deepEqual(resumed.evidence, ['session-17.json'])
  assert.equal(resumed.reason, 'Resume session 17')
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { branch: 'renamed' })] })
  assert.equal(next(dir).action, 'reconcile')
  assert.equal(next(dir).claimId, claim.claimId)
  run(dir, 'save', saveInput(claim), false)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', reason: 'Branch changed' }))
  assert.equal(run(dir, 'show').prs['1'].cycles[0].reason, 'Branch changed')
})

test('integration: a finding discovered then verified fixed within one round counts as progress', () => {
  const dir = setup()
  const claim = start(dir)
  run(dir, 'save', saveInput(claim, { phase: 'fixing', findings: [{ id: 'new', status: 'open', evidence: ['red.txt'] }] }))
  run(dir, 'save', saveInput(claim, { findings: [{ id: 'new', status: 'fixed', evidence: ['red.txt', 'green.txt'] }] }))
  assert.equal(run(dir, 'show').prs['1'].cycles[0].noProgress, 0)
})

test('integration: published rebinds old head to verified candidate without another round or stale reviews', () => {
  const dir = setup()
  const claim = start(dir)
  const snapshot = pr(1, { head: sha(12), gateKey: key(2) })
  const receipts = reviewers({ ...claim, head: snapshot.head })
  const push = { repo, branch: snapshot.branch, before: claim.head, head: snapshot.head, sourceRef: 'push.json', pushedAt: new Date().toISOString() }
  const input = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head, snapshot, push, reviewers: receipts }
  run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
  assert.equal(next(dir).action, 'reconcile')
  for (const bad of [
    { ...input, push: { ...push, before: sha(90) } },
    { ...input, snapshot: { ...snapshot, sourceRepo: 'fork/ecorp' } },
    { ...input, reviewers: [] },
    { ...input, push: { ...push, pushedAt: '2000-01-01T00:00:00.000Z' } },
  ]) run(dir, 'published', bad, false)
  const rebound = run(dir, 'published', input)
  assert.equal(rebound.head, snapshot.head)
  assert.equal(rebound.round, claim.round)
  assert.equal(rebound.startedAt, claim.startedAt)
  assert.equal(run(dir, 'published', input).claimId, claim.claimId, 'uncertain acknowledgement is idempotent')
  run(dir, 'save', saveInput(rebound, { phase: 'waiting', technicalVerdict: 'NICE', reviewers: receipts }))
  assert.equal(next(dir).action, 'none')
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, gateKey: key(3) }] })
  const gate = next(dir)
  assert.equal(gate.action, 'check')
  run(dir, 'save', saveInput(gate))
  const c = run(dir, 'show').prs['1'].cycles[0]
  assert.equal(c.rounds, 1)
  assert.equal(c.technicalVerdict, 'NICE')
})
