import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { snapshot } from '../scripts/executor-snapshot.mjs'

const script = fileURLToPath(new URL('../scripts/executor-state.mjs', import.meta.url))
const owner = 'native-task-1'
const repo = 'example/ecorp'
const sha = (n) => n.toString(16).padStart(40, '0')
const key = (n) => n.toString(16).padStart(64, '0')
const init = { owner, repo, model: 'gpt-6-astra', policySha: sha(99), canary: 1 }
const criteria = ['CORRECTNESS', 'DURABILITY', 'SECURITY', 'TEMPLATE', 'VERIFICATION', 'COMPLETENESS', 'SIMPLICITY', 'TRUTHFULNESS']
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
const bindRubric = (dir, claim) => run(dir, 'rubric', {
  owner, base: claim.base, head: claim.head, sourceRef: 'evidence/trusted-rubric.json', sha256: key(500), criteria,
})
const start = (dir) => {
  const claim = next(dir)
  bindRubric(dir, claim)
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
  criteria: criteria.map((id) => ({ id, result: 'PASS', sourceRef: `evidence/rubric-${id}.json` })),
}))
const complete = (dir) => {
  const claim = start(dir)
  const receipts = reviewers(claim)
  run(dir, 'save', saveInput(claim, { phase: 'complete', technicalVerdict: 'NICE', reviewers: receipts }))
  return { claim, receipts }
}
const publishComplete = (dir) => {
  const claim = start(dir)
  const snapshot = pr(claim.number, { ...claim.snapshot, head: sha(Number.parseInt(claim.head, 16) + 1) })
  bindRubric(dir, snapshot)
  const receipts = reviewers({ ...claim, head: snapshot.head })
  const push = { repo, branch: snapshot.branch, before: claim.head, head: snapshot.head, sourceRef: 'evidence/actual-push.json', pushedAt: new Date().toISOString() }
  const rebound = run(dir, 'published', {
    owner, number: claim.number, claimId: claim.claimId, base: claim.base, head: claim.head, snapshot, push, reviewers: receipts,
  })
  run(dir, 'save', saveInput(rebound, { phase: 'waiting', technicalVerdict: 'NICE', reviewers: receipts }))
  return { claim: rebound, receipts, push, snapshot }
}
const proof = (claim, receipts) => ({
  number: claim.number, base: claim.base, head: claim.head, reviewers: receipts,
  ci: { base: claim.base, head: claim.head, status: 'passed', sourceRef: 'https://ci.example/run/1', verifiedAt: new Date().toISOString() },
  push: claim.publication?.push ?? { repo, branch: 'fix-1', before: sha(9), head: claim.head, sourceRef: 'evidence/real-push.json', pushedAt: new Date().toISOString() },
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

test('waiting PR does not hide other PRs; fork execution stays blocked with read-only receipts', () => {
  const others = [pr(2), pr(3, { sourceRepo: 'fork/ecorp' }), pr(4, { readError: 'DETAIL_READ_FAILED' }), pr(5)]
  const dir = setup([pr(), ...others])
  assert.equal(next(dir).number, 1)
  const gate = next(dir)
  run(dir, 'save', saveInput(gate))
  assert.equal(next(dir).action, 'none', 'canary restricts scheduling until enable')
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(12) }), ...others] })
  const { claim, receipts } = publishComplete(dir)
  run(dir, 'enable', { owner, acceptanceProof: proof(claim, receipts) })
  const second = next(dir)
  assert.equal(second.number, 2)
  run(dir, 'save', saveInput(second, { phase: 'blocked' }))
  const fork = next(dir)
  assert.equal(fork.number, 3)
  assert.equal(fork.action, 'read-only')
  assert.match(fork.reason, /fork/)
  assert.equal(run(dir, 'show').prs['3'].cycles[0].technicalVerdict, null)
  run(dir, 'read-only', readOnlyInput(fork))
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
  const noPush = setup(), unpublished = complete(noPush)
  run(noPush, 'enable', { owner, acceptanceProof: proof(unpublished.claim, unpublished.receipts) }, false)
  const { claim, receipts } = publishComplete(dir)
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
  const prior = publishComplete(stale)
  run(stale, 'sync', { owner, complete: true, prs: [pr(1, { readError: 'DETAIL_READ_FAILED' })] })
  run(stale, 'enable', { owner, acceptanceProof: proof(prior.claim, prior.receipts) }, false)
  run(stale, 'sync', { owner, complete: true, prs: [pr(1, { base: sha(30) })] })
  run(stale, 'enable', { owner, acceptanceProof: proof(prior.claim, prior.receipts) }, false)
})

test('manual canary alone cannot activate without native wake, resume, quiet, automatic review and fixer receipts', () => {
  const dir = setup()
  const { claim, receipts } = publishComplete(dir)
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
  assert.equal(next(dir).action, 'read-only')
  assert.equal(run(dir, 'show').prs['2'].present, true)
  const fork = setup([pr(1, { sourceRepo: 'fork/ecorp' })])
  run(fork, 'sync', { owner, complete: true, prs: [pr(1, { sourceRepo: null })] })
  run(fork, 'sync', { owner, complete: true, prs: [pr()] })
  assert.equal(next(fork).action, 'read-only')
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
  bindRubric(dir, { ...claim, head: snapshot.head })
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

// Synthetic CLI fixtures prove transition guards, not actual reviewer authenticity.
const retryInput = (claim, reviewRef = 'evidence/failed-review.json') => ({
  owner, number: claim.number, claimId: claim.claimId, base: claim.base, head: claim.head,
  round: claim.round, reviewRef,
})
const failedReview = (dir, claim, findings = []) => run(dir, 'save', saveInput(claim, {
  phase: 'reviewing', technicalVerdict: 'NAUGHTY', reason: 'Actual failed review retained',
  evidence: ['evidence/failed-review.json', 'worktree/session.json'], findings,
}))

test('E1: unchanged remote failure -> charged retry -> local correction -> fresh review survives replay', () => {
  const dir = setup(), claim = start(dir)
  const open = { id: 'E1', status: 'open', evidence: ['red.log'] }
  failedReview(dir, claim, [open])
  const staleReviews = reviewers(claim)
  const before = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  const retried = run(dir, 'retry', retryInput(claim))
  assert.equal(retried.claimId, claim.claimId)
  assert.equal(retried.head, claim.head)
  assert.equal(retried.round, 2)
  assert.ok(retried.startedAt > claim.startedAt)
  assert.deepEqual(next(dir).findings, [open])
  assert.deepEqual(next(dir).evidence, ['evidence/failed-review.json', 'worktree/session.json'])
  const charged = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'retry', retryInput(claim), false)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), charged, 'replayed retry cannot charge again')
  const fixed = { ...open, status: 'fixed', evidence: ['red.log', 'green.log'] }
  run(dir, 'save', saveInput(retried, { phase: 'fixing', findings: [fixed], evidence: ['green.log'] }))
  run(dir, 'save', saveInput(retried, {
    phase: 'complete', technicalVerdict: 'NICE', findings: [fixed], reviewers: staleReviews,
  }), false)
  run(dir, 'save', saveInput(retried, {
    phase: 'complete', technicalVerdict: 'NICE', findings: [fixed], reviewers: reviewers(retried),
  }))
  const state = run(dir, 'show'), c = state.prs['1'].cycles[0]
  assert.equal(state.prs['1'].snapshot.head, claim.head)
  assert.equal(c.rounds, 2)
  assert.equal(c.noProgress, 0)
  assert.equal(c.technicalVerdict, 'NICE')
  assert.ok(c.evidence.includes('worktree/session.json'))
  assert.ok(c.evidence.includes('evidence/failed-review.json'))
  assert.ok(c.evidence.includes('green.log'))
  assert.equal(next(dir).action, 'none')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, before.length), before)
})

test('E1: retry requires retained failed-review phase/evidence and exact owner, claim, revision and round', () => {
  const dir = setup(), claim = start(dir)
  const input = retryInput(claim)
  run(dir, 'retry', input, false)
  run(dir, 'save', saveInput(claim, { phase: 'fixing', technicalVerdict: 'NAUGHTY' }))
  run(dir, 'retry', input, false)
  failedReview(dir, claim)
  for (const bad of [
    { ...input, owner: 'other' }, { ...input, number: 2 }, { ...input, claimId: 'other' },
    { ...input, head: sha(42) }, { ...input, base: sha(42) },
    { ...input, round: undefined }, { ...input, round: 2 }, { ...input, round: '1' },
    { ...input, reviewRef: '' }, { ...input, reviewRef: 'unretained-review.json' },
    { ...input, reset: true },
  ]) {
    const before = readFileSync(join(dir, 'state.json'), 'utf8')
    run(dir, 'retry', bad, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before)
  }
  for (const change of [{ head: sha(20) }, { base: sha(20) }, { reviewKey: key(20) },
    { sourceRepo: 'fork/ecorp' }, { sourceRepo: null }, { branch: 'other' },
    { readError: 'DETAIL_READ_FAILED' }]) {
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, change)] })
    run(dir, 'retry', input, false)
    assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
  }
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { gateKey: key(2) })] })
  assert.equal(run(dir, 'retry', input).round, 2, 'gate-only change retains claim eligibility')
})

test('legacy save sequences remain replayable; retry still requires the retained reviewing phase', () => {
  const dir = setup(), claim = start(dir)
  failedReview(dir, claim)
  // Previously accepted journal events must not become corrupt after a policy update.
  run(dir, 'save', saveInput(claim, { phase: 'fixing', reason: 'Legacy within-round progress' }))
  assert.equal(run(dir, 'show').active.round, 1)
  run(dir, 'retry', retryInput(claim), false)
  failedReview(dir, claim)
  assert.equal(run(dir, 'retry', retryInput(claim)).round, 2)
})

test('E1: unchanged-remote retry stops after two no-progress rounds without discarding the claim', () => {
  const dir = setup(), first = start(dir)
  failedReview(dir, first)
  const second = run(dir, 'retry', retryInput(first))
  failedReview(dir, second)
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.match(run(dir, 'retry', retryInput(second), false).error, /limit exhausted/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  const state = run(dir, 'show'), c = state.prs['1'].cycles[0]
  assert.equal(c.rounds, 2)
  assert.equal(c.noProgress, 2)
  assert.equal(c.phase, 'reviewing')
  assert.equal(c.technicalVerdict, 'NAUGHTY')
  assert.equal(next(dir).claimId, first.claimId)
  run(dir, 'save', saveInput(second, { phase: 'blocked', technicalVerdict: 'NAUGHTY' }))
  run(dir, 'retry', retryInput(second), false)
  assert.equal(next(dir).action, 'none')
})

test('E1: real within-round progress permits retries but never a fourth charged round', () => {
  const dir = setup()
  let claim = start(dir), findings = []
  for (let round = 1; round <= 3; round++) {
    const finding = { id: `bug-${round}`, status: 'open', evidence: [`red-${round}.log`] }
    run(dir, 'save', saveInput(claim, { phase: 'fixing', findings: [...findings, finding] }))
    findings = [...findings, { ...finding, status: 'fixed', evidence: [...finding.evidence, `green-${round}.log`] }]
    failedReview(dir, claim, findings)
    if (round < 3) {
      claim = run(dir, 'retry', retryInput(claim))
      const c = run(dir, 'show').prs['1'].cycles[0]
      assert.equal(c.rounds, round + 1)
      assert.equal(c.noProgress, 1, 'verified prior-round progress then pessimistic new charge')
    }
  }
  assert.match(run(dir, 'retry', retryInput(claim), false).error, /limit exhausted/)
  const c = run(dir, 'show').prs['1'].cycles[0]
  assert.equal(c.rounds, 3)
  assert.deepEqual(c.findings, findings)
  assert.equal(run(dir, 'show').prs['1'].cycles.length, 1)
})

test('E1: retry evidence belongs to the latest failed review, not merely an older retained artifact', () => {
  const dir = setup(), first = start(dir), open = { id: 'bug', status: 'open', evidence: ['red.log'] }
  failedReview(dir, first, [open])
  const second = run(dir, 'retry', retryInput(first))
  const fixed = { ...open, status: 'fixed', evidence: ['red.log', 'green.log'] }
  run(dir, 'save', saveInput(second, { phase: 'fixing', findings: [fixed] }))
  run(dir, 'save', saveInput(second, { phase: 'reviewing', technicalVerdict: 'NAUGHTY',
    findings: [fixed], evidence: ['evidence/latest-review.json'], reason: 'Fresh failed review' }))
  run(dir, 'retry', retryInput(second), false)
  assert.equal(run(dir, 'retry', retryInput(second, 'evidence/latest-review.json')).round, 3)
  assert.ok(next(dir).evidence.includes('evidence/failed-review.json'), 'old report remains retained')
})

test('blocked snapshots accept only the optional safe readFailure descriptor and retain source guards', () => {
  const dir = setup()
  const descriptor = { operation: 'reviews', kind: 'COMMAND_FAILED', exitCode: 1, signal: null }
  for (const operation of ['reviews', 'review_comments', 'discussion', 'check_runs', 'statuses']) {
    for (const kind of ['COMMAND_FAILED', 'INVALID_JSON', 'INVALID_RESPONSE']) {
      const readFailure = { ...descriptor, operation, kind }
      run(dir, 'sync', { owner, complete: true, prs: [pr(1, { readError: 'DETAIL_READ_FAILED', readFailure })] })
      assert.deepEqual(run(dir, 'show').prs['1'].snapshot.readFailure, readFailure)
    }
  }
  for (const signal of [null, 'SIGTERM', 'SIGKILL', 'SIGINT']) {
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, {
      readError: 'DETAIL_READ_FAILED', readFailure: { ...descriptor, exitCode: null, signal },
    })] })
  }
  assert.equal(next(dir).action, 'blocked')
  for (const readFailure of [
    'secret diagnostic', null, {}, { ...descriptor, operation: 'shell' },
    { ...descriptor, kind: 'raw diagnostic' }, { ...descriptor, exitCode: '1' },
    { ...descriptor, exitCode: 1.5 }, { ...descriptor, signal: 'secret' },
    { ...descriptor, stderr: 'secret' }, { ...descriptor, signal: undefined },
  ]) run(dir, 'sync', { owner, complete: true, prs: [pr(1, { readError: 'DETAIL_READ_FAILED', readFailure })] }, false)
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { readFailure: descriptor })] }, false)
  for (const sourceRepo of ['fork/ecorp', null]) {
    const fork = setup([pr(1, { sourceRepo, readError: 'DETAIL_READ_FAILED', readFailure: descriptor })])
    const claim = next(fork)
    assert.equal(claim.action, 'read-only')
    run(fork, 'read-only', readOnlyInput(claim, { verdict: 'BLOCKED' }))
    run(fork, 'sync', { owner, complete: true, prs: [pr(1, { sourceRepo })] })
    assert.equal(next(fork).action, 'read-only')
  }
  const fork = setup([pr(1, { sourceRepo: 'fork/ecorp', readError: 'DETAIL_READ_FAILED', readFailure: descriptor })])
  run(fork, 'sync', { owner, complete: true, prs: [pr()] })
  assert.equal(next(fork).action, 'read-only', 'descriptor must not launder original fork identity')
})

const deploymentInput = (dir, previousPolicySha = init.policySha, policySha = sha(100)) => {
  bindRubric(dir, { base: previousPolicySha, head: policySha })
  return {
  owner, previousPolicySha, policySha,
  reviewers: reviewers({ claimId: `policy-${policySha}`, base: previousPolicySha, head: policySha }),
  validation: { policySha, status: 'passed', sourceRef: 'evidence/policy-validation.log', verifiedAt: new Date().toISOString() },
  }
}

test('deploy: owner-bound bootstrap roll-forward preserves init, claims, rounds, findings and all prior journal events', () => {
  const dir = setup(), claim = start(dir)
  failedReview(dir, claim, [{ id: 'E1', status: 'open', evidence: ['red.log'] }])
  const input = deploymentInput(dir)
  const before = run(dir, 'show'), journal = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  run(dir, 'deploy', input)
  const after = run(dir, 'show')
  for (const field of ['config', 'prs', 'active', 'sequence', 'enabled', 'acceptanceProof']) {
    assert.deepEqual(after[field], before[field], field)
  }
  assert.equal(after.config.policySha, init.policySha, 'original init stays immutable')
  assert.equal(after.deployments[0].policySha, init.policySha)
  assert.equal(after.deployments.at(-1).policySha, input.policySha)
  assert.deepEqual(after.deployments.at(-1).reviewers, input.reviewers)
  assert.deepEqual(after.deployments.at(-1).validation, input.validation)
  assert.deepEqual(after.usedReviewers, before.usedReviewers, 'deployment records a decision without consuming technical review IDs')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, journal.length), journal)
  const deployedBytes = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'deploy', input, false)
  run(dir, 'init', { ...init, policySha: input.policySha }, false)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), deployedBytes)
  assert.equal(run(dir, 'retry', retryInput(claim)).round, 2, 'deployment neither resets nor consumes rounds')
  const second = deploymentInput(dir, input.policySha, sha(101))
  run(dir, 'deploy', second)
  assert.equal(run(dir, 'show').deployments.length, 3)
})

test('deploy: unknown, unauthorized, stale and unstructured evidence cannot update policy or enable broad intake', () => {
  const dir = setup(), good = deploymentInput(dir)
  for (const bad of [
    { ...good, owner: 'other' }, { ...good, owner: undefined }, { ...good, unknown: true },
    { ...good, previousPolicySha: sha(98) }, { ...good, policySha: init.policySha },
    { ...good, policySha: 'bad' }, { ...good, policySha: 'a'.repeat(64) },
    { ...good, reviewers: 'NICE' }, { ...good, reviewers: [] },
    { ...good, reviewers: [good.reviewers[0], good.reviewers[0]] },
    ...[
      { sourceRef: good.reviewers[0].sourceRef }, { head: sha(8) }, { base: sha(8) },
      { reviewerId: owner }, { model: 'other' }, { criteria: [] }, { verdict: 'NAUGHTY' },
      { completedAt: '2000-01-01T00:00:00.000Z' }, { completedAt: '9999-01-01T00:00:00.000Z' },
    ].map((change) => ({ ...good, reviewers: [good.reviewers[0], { ...good.reviewers[1], ...change }] })),
    { ...good, validation: undefined }, { ...good, validation: 'passed' },
    ...[{ policySha: sha(8) }, { status: 'failed' }, { sourceRef: '' },
      { verifiedAt: '2000-01-01T00:00:00.000Z' }, { extra: true }]
      .map((change) => ({ ...good, validation: { ...good.validation, ...change } })),
  ]) {
    const before = readFileSync(join(dir, 'state.json'), 'utf8')
    run(dir, 'deploy', bad, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before)
  }
  run(dir, 'deploy-unknown', good, false)
  run(dir, 'deploy', good)
  const second = deploymentInput(dir, good.policySha, sha(101))
  for (const field of ['reviewerId', 'sourceRef']) {
    run(dir, 'deploy', { ...second, reviewers: second.reviewers.map((r, n) => ({
      ...r, [field]: good.reviewers[n][field],
    })) }, false)
  }
  const { claim, receipts } = publishComplete(dir)
  run(dir, 'enable', { owner, acceptanceProof: proof(claim, receipts) })
  run(dir, 'deploy', second, false)
  const help = run(fixture(), 'help').help
  for (const field of ['retry', 'round', 'reviewRef', 'deploy', 'previousPolicySha', 'validation', 'readFailure']) {
    assert.ok(help.includes(field), field)
  }
})

test('deploy: retains the actual independently reviewed base without retagging it as the previous policy SHA', () => {
  const dir = setup(), policySha = sha(100), base = sha(10)
  bindRubric(dir, { base, head: policySha })
  const input = { owner, previousPolicySha: init.policySha, policySha,
    reviewers: reviewers({ claimId: 'actual-policy-review', base, head: policySha }),
    validation: { policySha, status: 'passed', sourceRef: 'validation.json', verifiedAt: new Date().toISOString() } }
  run(dir, 'deploy', input)
  assert.deepEqual(run(dir, 'show').deployments.at(-1).reviewers, input.reviewers)
})

test('A2: two equally partial reports omitting SECURITY cannot authorize NICE', () => {
  const dir = setup(), claim = start(dir)
  const partial = reviewers(claim).map((r) => ({ ...r, criteria: r.criteria.filter((c) => c.id !== 'SECURITY') }))
  run(dir, 'save', saveInput(claim, { phase: 'complete', technicalVerdict: 'NICE', reviewers: partial }), false)
  run(dir, 'save', saveInput(claim, { phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(claim) }))
})

test('A2: exact rubric binding is immutable, owner-bound, complete and predates actual receipts', () => {
  const dir = setup(), claim = next(dir)
  run(dir, 'begin', retryInput(claim), false)
  const begun = run(dir, 'begin', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head })
  run(dir, 'save', saveInput(begun, { phase: 'fixing', reason: 'Legacy unbound journal remains replayable' }))
  assert.equal(run(dir, 'show').active.round, 1)
  const old = reviewers(begun)
  run(dir, 'save', saveInput(begun, { phase: 'complete', technicalVerdict: 'NICE', reviewers: old }), false)
  const binding = { owner, base: claim.base, head: claim.head, sourceRef: 'trusted.json', sha256: key(90), criteria }
  for (const bad of [
    { ...binding, owner: 'other' }, { ...binding, extra: true }, { ...binding, sha256: 'bad' },
    { ...binding, criteria: ['rubric'] }, { ...binding, criteria: criteria.filter((id) => id !== 'SECURITY') },
    { ...binding, criteria: [...criteria, 'SECURITY'] }, { ...binding, sourceRef: '' },
  ]) run(dir, 'rubric', bad, false)
  run(dir, 'rubric', binding)
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'rubric', binding)
  for (const change of [{ sourceRef: 'other' }, { sha256: key(91) }, { criteria: [...criteria, 'EXTRA'] }]) {
    run(dir, 'rubric', { ...binding, ...change }, false)
  }
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  run(dir, 'save', saveInput(begun, { phase: 'complete', technicalVerdict: 'NICE', reviewers: old }), false)
  run(dir, 'save', saveInput(begun, { phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(begun) }))
  assert.deepEqual(run(dir, 'show').rubrics[`${claim.base}:${claim.head}`].binding, binding)
})

test('B01: honest post-push feedback review enables with the original canonical publication, never a retimestamped push', () => {
  const dir = setup(), published = publishComplete(dir)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...published.snapshot, reviewKey: key(2) }] })
  const claim = start(dir), receipts = reviewers(claim)
  assert.ok(published.push.pushedAt < claim.startedAt)
  run(dir, 'save', saveInput(claim, { phase: 'waiting', technicalVerdict: 'NICE', reviewers: receipts }))
  const acceptanceProof = { ...proof(claim, receipts), push: published.push }
  for (const change of [{ pushedAt: new Date().toISOString() }, { sourceRef: 'invented-push' }, { before: sha(8) }]) {
    run(dir, 'enable', { owner, acceptanceProof: { ...acceptanceProof, push: { ...published.push, ...change } } }, false)
  }
  run(dir, 'enable', { owner, acceptanceProof })
  const state = run(dir, 'show')
  assert.equal(state.prs['1'].cycles[0].rounds, 2)
  assert.equal(state.enabled, true)
  assert.deepEqual(state.prs['1'].publications.at(-1).push, published.push)
  assert.deepEqual(state.prs['1'].publications.at(-1).reviewers, published.receipts)
})

test('A3/B02: unprocessed same-head feedback fences enable; actual fresh review preserves the original push', () => {
  const dir = setup(), published = publishComplete(dir)
  const originalCompletion = run(dir, 'show').prs['1'].cycles[0].completion
  run(dir, 'sync', { owner, complete: true, prs: [{ ...published.snapshot, reviewKey: key(3) }] })
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) }, false)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  assert.deepEqual(run(dir, 'show').prs['1'].cycles[0].completion, originalCompletion)
  const claim = start(dir), receipts = reviewers(claim)
  run(dir, 'save', saveInput(claim, { phase: 'waiting', technicalVerdict: 'NICE', reviewers: receipts }))
  run(dir, 'enable', { owner, acceptanceProof: { ...proof(claim, receipts), push: published.push } })
  assert.equal(run(dir, 'show').enabled, true)
  assert.deepEqual(run(dir, 'show').prs['1'].publications[0].reviewers, published.receipts)
})

test('A3/B02: changed required CI waits for an uncharged gate check, not another technical review', () => {
  const dir = setup(), published = publishComplete(dir)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...published.snapshot, gateKey: key(3) }] })
  run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) }, false)
  const gate = next(dir)
  assert.equal(gate.action, 'check')
  run(dir, 'save', saveInput(gate, { evidence: ['evidence/new-required-CI.json'] }))
  const acceptanceProof = proof(published.claim, published.receipts)
  run(dir, 'enable', { owner, acceptanceProof: { ...acceptanceProof, ci: { ...acceptanceProof.ci, status: 'pending' } } }, false)
  run(dir, 'enable', { owner, acceptanceProof })
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
})

test('B02 publication race: readback feedback cannot be attributed to pre-push reviews; canonical push and retry ACK survive', () => {
  const dir = setup(), claim = start(dir)
  const candidate = pr(1, { head: sha(12) })
  bindRubric(dir, candidate)
  const receipts = reviewers({ ...claim, head: candidate.head })
  const push = { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
    sourceRef: 'evidence/genuine-push.json', pushedAt: new Date().toISOString() }
  const readback = { ...candidate, reviewKey: key(2), gateKey: key(2) }
  const input = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
    snapshot: readback, push, reviewers: receipts }
  const rebound = run(dir, 'published', input)
  assert.equal(rebound.action, 'reconcile')
  assert.equal(rebound.snapshot.reviewKey, claim.snapshot.reviewKey)
  assert.equal(run(dir, 'show').prs['1'].snapshot.reviewKey, readback.reviewKey)
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.deepEqual(run(dir, 'published', input), rebound)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  run(dir, 'save', saveInput(rebound, { phase: 'waiting', technicalVerdict: 'NICE', reviewers: receipts }), false)
  run(dir, 'enable', { owner, acceptanceProof: { ...proof(rebound, receipts), push } }, false)
  assert.equal(next(dir).action, 'reconcile')
  run(dir, 'save', saveInput(rebound, { phase: 'blocked', reason: 'New automatic finding arrived with push readback' }))
  run(dir, 'resume', resumeInput(rebound), false)
  const feedback = start(dir)
  assert.equal(feedback.round, 2)
  const alteredPair = receipts.map((r) => ({ ...r, completedAt: new Date().toISOString() }))
  assert.match(run(dir, 'save', saveInput(feedback, { phase: 'waiting', technicalVerdict: 'NICE', reviewers: alteredPair }), false).error,
    /review decision/, 'publication decision is not reusable in another round even before NICE consumed its IDs')
  const freshReceipts = reviewers(feedback)
  run(dir, 'save', saveInput(feedback, { phase: 'waiting', technicalVerdict: 'NICE', reviewers: freshReceipts }))
  run(dir, 'enable', { owner, acceptanceProof: { ...proof(feedback, freshReceipts), push } })
  const state = run(dir, 'show')
  assert.equal(state.enabled, true)
  assert.equal(state.prs['1'].publications.length, 1)
  assert.deepEqual(state.prs['1'].publications[0].push, push)
  assert.equal(state.prs['1'].cycles[0].rounds, 2)
})

const readOnlyInput = (claim, extra = {}) => ({
  owner, number: claim.number, claimId: claim.claimId, base: claim.base, head: claim.head,
  receipt: { reviewerId: 'read-only-reviewer', model: 'gpt-6-astra', verdict: 'FAIL',
    sourceRef: 'evidence/read-only-review.json', completedAt: new Date().toISOString(), ...extra },
})
test('B04: fork read-only audit survives selection/restart and requires an explicit receipt before consumption', () => {
  const dir = setup([pr(1, { sourceRepo: 'fork/ecorp' })])
  const claim = next(dir)
  assert.equal(claim.action, 'read-only')
  assert.ok(claim.claimId)
  assert.equal(next(dir).claimId, claim.claimId)
  assert.equal(run(dir, 'show').prs['1'].seen, null)
  run(dir, 'begin', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head }, false)
  run(dir, 'retry', retryInput({ ...claim, round: 1 }), false)
  run(dir, 'save', saveInput(claim, { phase: 'fixing' }), false)
  run(dir, 'save', saveInput(claim, { phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(claim) }), false)
  run(dir, 'published', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
    snapshot: pr(1, { head: sha(12) }), push: {}, reviewers: [] }, false)
  const input = readOnlyInput(claim)
  for (const bad of [
    { ...input, owner: 'other' }, { ...input, claimId: 'other' }, { ...input, head: sha(88) },
    { ...input, receipt: 'NICE' },
    readOnlyInput(claim, { verdict: 'NICE' }), readOnlyInput(claim, { model: 'other' }),
    readOnlyInput(claim, { sourceRef: '' }), readOnlyInput(claim, { completedAt: '2000-01-01T00:00:00.000Z' }),
    readOnlyInput(claim, { execute: true }),
  ]) run(dir, 'read-only', bad, false)
  run(dir, 'read-only', input)
  const state = run(dir, 'show')
  assert.deepEqual(state.prs['1'].readOnlyReviews[0].receipt, input.receipt)
  assert.match(state.prs['1'].blockedReason, /fork/)
  assert.equal(state.prs['1'].cycles[0].rounds, 0)
  assert.equal(state.prs['1'].cycles[0].technicalVerdict, null)
  assert.equal(next(dir).action, 'none')
  run(dir, 'read-only', input, false)
  run(dir, 'enable', { owner, acceptanceProof: proof(claim, []) }, false)
})

test('B04: stale fork audit is retained as BLOCKED without consuming a newer revision', () => {
  const dir = setup([pr(1, { sourceRepo: null })]), claim = next(dir)
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { sourceRepo: null, head: sha(12) })] })
  assert.equal(next(dir).action, 'reconcile')
  run(dir, 'read-only', readOnlyInput(claim, { verdict: 'PASS' }), false)
  run(dir, 'read-only', readOnlyInput(claim, { verdict: 'BLOCKED' }))
  assert.equal(next(dir).action, 'read-only')
  assert.notEqual(next(dir).claimId, claim.claimId)
  assert.equal(run(dir, 'show').prs['1'].readOnlyReviews[0].snapshot.head, claim.head)
})

test('B03: same-SHA retarget from snapshot to CLI queues only a gate check', () => {
  const dir = fixture()
  run(dir, 'init', init)
  const inventory = (baseRef) => snapshot(repo, (args) => {
    if (args.at(-1).includes('/pulls?')) return JSON.stringify([[
      { number: 1, base: { sha: sha(10), ref: baseRef, repo: { full_name: repo } },
        head: { sha: sha(11), ref: 'fix-1', repo: { full_name: repo } }, state: 'open' },
    ]])
    return args.at(-1).includes('/check-runs?') ? '[{"check_runs":[]}]' : '[[]]'
  })
  run(dir, 'sync', { owner, ...inventory('main') })
  const claim = start(dir)
  run(dir, 'save', saveInput(claim))
  run(dir, 'sync', { owner, ...inventory('release') })
  const gate = next(dir)
  assert.equal(gate.action, 'check')
  assert.equal(gate.snapshot.baseRef, 'release')
  run(dir, 'save', saveInput(gate, { evidence: ['release-protections.json'] }))
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
  assert.equal(next(dir).action, 'none')
  for (const baseRef of [null, '', 7, [], {}]) {
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, { baseRef })] }, false)
  }
})

test('B03: retarget during active work fences publication and leaves a fresh gate check after save', () => {
  const dir = setup([pr(1, { baseRef: 'main' })]), claim = start(dir)
  const candidate = pr(1, { baseRef: 'main', head: sha(12) })
  bindRubric(dir, candidate)
  const receipts = reviewers({ ...claim, head: candidate.head })
  const push = { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
    sourceRef: 'evidence/actual-push.json', pushedAt: new Date().toISOString() }
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { baseRef: 'release' })] })
  for (const baseRef of ['main', 'release']) {
    run(dir, 'published', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
      snapshot: { ...candidate, baseRef }, push, reviewers: receipts }, false)
  }
  assert.equal(next(dir).claimId, claim.claimId, 'technical work remains retained')
  run(dir, 'save', saveInput(claim))
  const gate = next(dir)
  assert.equal(gate.action, 'check')
  assert.equal(gate.snapshot.baseRef, 'release')
  run(dir, 'save', saveInput(gate, { evidence: ['actual-release-protection-read.json'] }))
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
})

test('B03: explicit bounded live gate recheck handles unchanged dependency/thread/protection state without audit charges', () => {
  const dir = setup(), published = publishComplete(dir)
  assert.equal(next(dir).action, 'none')
  const original = run(dir, 'show').prs['1'].cycles[0]
  for (const evidence of ['dependency-merged.json', 'thread-resolved.json', 'branch-protections.json']) {
    const gate = run(dir, 'next', { owner, gateNumber: 1 })
    assert.equal(gate.action, 'check')
    assert.equal(gate.round, null)
    assert.equal(next(dir).claimId, gate.claimId, 'interrupted external gate read resumes')
    run(dir, 'begin', { owner, number: 1, claimId: gate.claimId, base: gate.base, head: gate.head }, false)
    run(dir, 'save', saveInput(gate, { phase: 'blocked', evidence: [evidence], reason: 'Actual live gate read retained' }))
    assert.equal(next(dir).action, 'none')
    const c = run(dir, 'show').prs['1'].cycles[0]
    assert.equal(c.rounds, original.rounds)
    assert.equal(c.noProgress, original.noProgress)
    assert.deepEqual(c.completion, original.completion)
    assert.ok(c.evidence.includes(evidence))
  }
  run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) })
})

test('B03: gate targeting cannot steal a live claim, leave canary scope, bypass feedback, or authorize fork execution', () => {
  const dir = setup([pr(), pr(2)])
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  const claim = start(dir)
  const before = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'next', { owner, gateNumber: 2 }, false)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before)
  assert.equal(run(dir, 'next', { owner, gateNumber: 1 }).claimId, claim.claimId)
  run(dir, 'save', saveInput(claim))
  for (const input of [{ owner: 'other', gateNumber: 1 }, { owner, gateNumber: 2 },
    { owner, gateNumber: 99 }, { owner, gateNumber: 0 }, { owner, gateNumber: '1' },
    { owner, gateNumber: 1, unknown: true }]) run(dir, 'next', input, false)
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { reviewKey: key(20) })] })
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  assert.equal(next(dir).action, 'audit')
  const fork = setup([pr(1, { sourceRepo: 'fork/ecorp' })]), read = next(fork)
  run(fork, 'read-only', readOnlyInput(read))
  const gate = run(fork, 'next', { owner, gateNumber: 1 })
  assert.equal(gate.action, 'read-only')
  run(fork, 'begin', { owner, number: 1, claimId: gate.claimId, base: gate.base, head: gate.head }, false)
})

for (const readbackRace of [false, true]) test(`bootstrap: legacy failure -> retry/recover -> reviewed deploy/publication -> ${readbackRace ? 'readback race' : 'later feedback'} -> enable`, () => {
  const dir = setup([pr(1, { head: init.policySha })])
  const selected = next(dir)
  const legacy = run(dir, 'begin', { owner, number: 1, claimId: selected.claimId, base: selected.base, head: selected.head })
  const open = { id: 'E1', status: 'open', evidence: ['evidence/actual-E1-red.log'] }
  failedReview(dir, legacy, [open])
  const original = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  assert.ok(original.every((e) => ['init', 'sync', 'next', 'begin', 'save'].includes(e.command)), 'legacy pre-NICE commands only')
  assert.deepEqual(run(dir, 'show').rubrics, {}, 'no silently invented legacy rubric')
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: init.policySha, baseRef: 'main' })] })
  const retried = run(dir, 'retry', retryInput(legacy))
  assert.equal(retried.round, 2)
  assert.equal(retried.head, legacy.head)
  assert.equal(retried.snapshot.baseRef, 'main', 'new round binds the fresh inventory, including the added target identity')
  const fixed = { ...open, status: 'fixed', evidence: [...open.evidence, 'evidence/actual-E1-green.log'] }
  run(dir, 'save', saveInput(retried, { phase: 'fixing', findings: [fixed], evidence: ['worktree/corrected-candidate.json'] }))
  run(dir, 'save', saveInput(retried, { phase: 'blocked', findings: [fixed],
    evidence: ['evidence/local-tool-failure.json'], reason: 'Local validation tool temporarily unavailable' }))
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: init.policySha, baseRef: 'main' })] })
  assert.equal(next(dir).action, 'none')
  const suspended = run(dir, 'show').prs['1'].cycles[0], clearance = resumeInput(retried)
  const recovered = run(dir, 'resume', clearance)
  assert.equal(recovered.claimId, retried.claimId)
  assert.equal(recovered.startedAt, retried.startedAt)
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, suspended.rounds)
  assert.equal(run(dir, 'show').prs['1'].cycles[0].noProgress, suspended.noProgress)
  const candidate = pr(1, { head: sha(100), baseRef: 'main' })
  bindRubric(dir, candidate) // BEFORE the actual normalized two-PASS pair.
  const receipts = reviewers({ ...retried, head: candidate.head })
  const beforeDeploy = run(dir, 'show')
  run(dir, 'deploy', { owner, previousPolicySha: init.policySha, policySha: candidate.head, reviewers: receipts,
    validation: { policySha: candidate.head, status: 'passed', sourceRef: 'evidence/candidate-validation.log', verifiedAt: new Date().toISOString() } })
  assert.deepEqual(run(dir, 'show').active, beforeDeploy.active)
  assert.deepEqual(run(dir, 'show').prs, beforeDeploy.prs)
  const push = { repo, branch: candidate.branch, before: legacy.head, head: candidate.head,
    sourceRef: 'evidence/original-normal-push.json', pushedAt: new Date().toISOString() }
  const publication = { owner, number: 1, claimId: retried.claimId, base: retried.base, head: retried.head,
    snapshot: readbackRace ? { ...candidate, reviewKey: key(2), gateKey: key(2) } : candidate, push, reviewers: receipts }
  const alteredPair = receipts.map((r) => ({ ...r, completedAt: new Date().toISOString() }))
  assert.match(run(dir, 'published', { ...publication, reviewers: alteredPair,
    push: { ...push, pushedAt: new Date().toISOString() } }, false).error, /retained review decision/)
  const differentCandidate = { ...candidate, head: sha(101) }
  bindRubric(dir, differentCandidate)
  const rewrittenPair = receipts.map((r) => ({ ...r, head: differentCandidate.head, completedAt: new Date().toISOString() }))
  assert.match(run(dir, 'published', { ...publication, snapshot: differentCandidate,
    push: { ...push, head: differentCandidate.head, pushedAt: new Date().toISOString() },
    reviewers: rewrittenPair }, false).error, /retained review decision/)
  assert.deepEqual(run(dir, 'show').usedReviewers, [], 'failed cross-candidate reuse does not consume the valid pair')
  const rebound = run(dir, 'published', publication)
  assert.equal(rebound.round, 2)
  const publishedBytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.deepEqual(run(dir, 'published', publication), rebound)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), publishedBytes)
  if (readbackRace) {
    assert.equal(rebound.action, 'reconcile')
    run(dir, 'save', saveInput(rebound, { phase: 'waiting', findings: [fixed], technicalVerdict: 'NICE', reviewers: receipts }), false)
    run(dir, 'save', saveInput(rebound, { phase: 'blocked', findings: [fixed],
      evidence: ['evidence/new-readback-feedback.json'], reason: 'Unreviewed feedback arrived in publication readback' }))
    run(dir, 'resume', resumeInput(rebound), false)
  } else {
    run(dir, 'save', saveInput(rebound, { phase: 'waiting', findings: [fixed], technicalVerdict: 'NICE', reviewers: receipts }))
  }
  assert.deepEqual(run(dir, 'show').deployments.at(-1).reviewers, receipts)
  assert.deepEqual(run(dir, 'show').prs['1'].publications.at(-1).reviewers, receipts)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...candidate, reviewKey: key(2), gateKey: key(2) }] })
  run(dir, 'enable', { owner, acceptanceProof: { ...proof(rebound, receipts), push } }, false)
  const feedback = start(dir)
  assert.equal(feedback.round, 3, 'original bound retained, not a new cycle')
  const refreshedOldPair = receipts.map((r) => ({ ...r, completedAt: new Date().toISOString() }))
  run(dir, 'save', saveInput(feedback, { phase: 'waiting', findings: [fixed], technicalVerdict: 'NICE', reviewers: refreshedOldPair }), false)
  const freshReceipts = reviewers(feedback)
  run(dir, 'save', saveInput(feedback, { phase: 'waiting', findings: [fixed], technicalVerdict: 'NICE', reviewers: freshReceipts }))
  run(dir, 'enable', { owner, acceptanceProof: { ...proof(feedback, freshReceipts), push } })
  const state = run(dir, 'show')
  assert.equal(state.enabled, true)
  assert.deepEqual(state.config, init)
  assert.equal(state.deployments[0].policySha, init.policySha)
  assert.equal(state.deployments[1].policySha, candidate.head)
  assert.equal(state.prs['1'].cycles.length, 1)
  assert.equal(state.prs['1'].cycles[0].rounds, 3)
  assert.equal(state.prs['1'].publications.length, 1)
  assert.deepEqual(state.prs['1'].publications[0].push, push)
  assert.deepEqual(state.usedReviewers, [...(readbackRace ? [] : receipts), ...freshReceipts].map((r) => r.reviewerId))
  assert.ok(state.prs['1'].cycles[0].evidence.includes(clearance.clearance.sourceRef))
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, original.length), original)
})

const resumeInput = (claim) => ({
  owner, number: claim.number, claimId: claim.claimId, base: claim.base, head: claim.head, round: claim.round,
  clearance: { sourceRef: 'evidence/verified-local-clearance.json', verifiedAt: new Date().toISOString() },
})

test('E1 recovery: transient technical BLOCKED resumes the exact charged work after restart and verified clearance', () => {
  const dir = setup(), claim = start(dir)
  const finding = { id: 'E1', status: 'open', evidence: ['red.log'] }
  run(dir, 'save', saveInput(claim, { phase: 'fixing', findings: [finding],
    evidence: ['worktree/session-17.json'], reason: 'Resume actual session 17' }))
  run(dir, 'save', saveInput(claim, { phase: 'blocked', findings: [finding],
    evidence: ['evidence/tool-unavailable.json'], reason: 'Credential/tooling unavailable' }))
  const blocked = run(dir, 'show')
  assert.equal(blocked.active, null)
  run(dir, 'sync', { owner, complete: true, prs: [pr()] })
  assert.equal(next(dir).action, 'none', 'no automatic hot loop while blocked')
  const input = resumeInput(claim), resumed = run(dir, 'resume', input)
  assert.equal(resumed.claimId, claim.claimId)
  assert.equal(resumed.round, claim.round)
  assert.equal(resumed.startedAt, claim.startedAt)
  assert.equal(resumed.action, 'audit')
  const state = run(dir, 'show'), c = state.prs['1'].cycles[0]
  assert.equal(state.sequence, blocked.sequence)
  assert.equal(c.rounds, blocked.prs['1'].cycles[0].rounds)
  assert.equal(c.noProgress, blocked.prs['1'].cycles[0].noProgress)
  assert.equal(c.phase, 'fixing')
  assert.equal(c.reason, 'Resume actual session 17')
  assert.deepEqual(c.findings, [finding])
  for (const ref of ['worktree/session-17.json', 'evidence/tool-unavailable.json', input.clearance.sourceRef]) {
    assert.ok(c.evidence.includes(ref), ref)
  }
  run(dir, 'resume', input, false)
  const fixed = { ...finding, status: 'fixed', evidence: ['red.log', 'green.log'] }
  run(dir, 'save', saveInput(resumed, { phase: 'fixing', findings: [fixed], evidence: ['green.log'] }))
  run(dir, 'save', saveInput(resumed, { phase: 'waiting', findings: [fixed], technicalVerdict: 'NICE', reviewers: reviewers(resumed) }))
  assert.equal(next(dir).action, 'none', 'unchanged external CI wait stays quiet')
  run(dir, 'resume', resumeInput(claim), false)
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
})

test('E1 recovery: exact owner, retained round/revision, fresh clearance and no competing live claim are required', () => {
  const dir = setup(), claim = start(dir)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', reason: 'Local tool unavailable' }))
  const input = resumeInput(claim)
  for (const bad of [
    { ...input, owner: 'other' }, { ...input, claimId: 'other' }, { ...input, number: 2 },
    { ...input, base: sha(88) }, { ...input, head: sha(88) }, { ...input, round: 2 },
    { ...input, extra: true }, { ...input, clearance: 'cleared' }, { ...input, clearance: undefined },
    { ...input, clearance: { ...input.clearance, sourceRef: '' } },
    { ...input, clearance: { ...input.clearance, verifiedAt: '2000-01-01T00:00:00.000Z' } },
    { ...input, clearance: { ...input.clearance, verifiedAt: '9999-01-01T00:00:00.000Z' } },
  ]) {
    const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
    run(dir, 'resume', bad, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  }
  const gate = run(dir, 'next', { owner, gateNumber: 1 })
  assert.notEqual(gate.claimId, claim.claimId)
  assert.match(run(dir, 'resume', resumeInput(claim), false).error, /active claim/)
  run(dir, 'save', saveInput(gate, { phase: 'blocked', evidence: ['gate-check.json'] }))
  for (const change of [{ head: sha(12) }, { base: sha(12) }, { reviewKey: key(2) },
    { branch: 'other' }, { sourceRepo: 'fork/ecorp' }, { sourceRepo: null },
    { readError: 'DETAIL_READ_FAILED' }, { state: 'closed' }]) {
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, change)] })
    run(dir, 'resume', resumeInput(claim), false)
  }
  run(dir, 'sync', { owner, complete: true, prs: [] })
  run(dir, 'resume', resumeInput(claim), false)
  run(dir, 'sync', { owner, complete: true, prs: [pr()] })
  assert.equal(run(dir, 'resume', resumeInput(claim)).claimId, claim.claimId)
  const waiting = setup(), ci = start(waiting)
  run(waiting, 'save', saveInput(ci))
  run(waiting, 'resume', resumeInput(ci), false)
  assert.equal(next(waiting).action, 'none')
  const fork = setup([pr(1, { sourceRepo: 'fork/ecorp' })]), read = next(fork)
  run(fork, 'read-only', readOnlyInput(read, { verdict: 'BLOCKED' }))
  run(fork, 'resume', resumeInput({ ...read, round: 1 }), false)
})

test('E1 recovery: exhausted stops cannot be reopened by local clearance or an uncharged gate check', () => {
  for (const limit of [2, 3]) {
    const dir = setup()
    let claim, findings = []
    for (let round = 1; round <= limit; round++) {
      claim = start(dir)
      if (limit === 3) {
        const finding = { id: `bug-${round}`, status: 'open', evidence: [`red-${round}.log`] }
        run(dir, 'save', saveInput(claim, { phase: 'fixing', findings: [...findings, finding] }))
        findings.push({ ...finding, status: 'fixed', evidence: [...finding.evidence, `green-${round}.log`] })
      }
      run(dir, 'save', saveInput(claim, { phase: 'blocked', findings, reason: 'Retained technical block' }))
      if (round < limit) run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(11 + round) })] })
    }
    const before = readFileSync(join(dir, 'state.json'), 'utf8')
    assert.match(run(dir, 'resume', resumeInput(claim), false).error, /exhausted/)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before)
    const gate = run(dir, 'next', { owner, gateNumber: 1 })
    run(dir, 'save', saveInput(gate, { findings }))
    assert.match(run(dir, 'resume', resumeInput(claim), false).error, /exhausted/)
    const c = run(dir, 'show').prs['1'].cycles[0]
    assert.equal(c.rounds, limit)
    if (limit === 2) assert.equal(c.noProgress, 2)
  }
})

test('legacy target: first observed baseRef permits same-round recovery/publication but still requires gate acknowledgment', () => {
  const dir = setup(), claim = start(dir)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', reason: 'Local tool unavailable' }))
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { baseRef: 'main' })] })
  const resumed = run(dir, 'resume', resumeInput(claim))
  assert.equal(resumed.round, claim.round)
  assert.equal(resumed.snapshot.baseRef, undefined, 'missing historical target is not invented')
  const candidate = pr(1, { head: sha(12), baseRef: 'main' })
  bindRubric(dir, candidate)
  const receipts = reviewers({ ...resumed, head: candidate.head })
  const push = { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
    sourceRef: 'original-push.json', pushedAt: new Date().toISOString() }
  const input = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
    snapshot: candidate, push, reviewers: receipts }
  run(dir, 'published', { ...input, snapshot: { ...candidate, baseRef: undefined } }, false)
  const rebound = run(dir, 'published', input)
  run(dir, 'save', saveInput(rebound, { phase: 'waiting', technicalVerdict: 'NICE', reviewers: receipts }))
  run(dir, 'enable', { owner, acceptanceProof: proof(rebound, receipts) }, false)
  const gate = next(dir)
  assert.equal(gate.action, 'check')
  assert.equal(gate.snapshot.baseRef, 'main')
  run(dir, 'save', saveInput(gate, { evidence: ['actual-main-protection-read.json'] }))
  run(dir, 'enable', { owner, acceptanceProof: proof(rebound, receipts) })
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
  const known = setup([pr(1, { baseRef: 'main' })]), original = start(known)
  run(known, 'save', saveInput(original, { phase: 'blocked', reason: 'Local tool unavailable' }))
  run(known, 'sync', { owner, complete: true, prs: [pr(1, { baseRef: 'release' })] })
  assert.match(run(known, 'resume', resumeInput(original), false).error, /target conflicts/)
})
