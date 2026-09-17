import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
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
  sourceRepo: repo, branch: `fix-${number}`, state: 'open', baseRef: 'main', draft: false,
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
const proof = (claim, receipts, ciSnapshot = claim.snapshot) => ({
  number: claim.number, base: claim.base, head: claim.head, reviewers: receipts,
  ci: { base: claim.base, head: claim.head, gateKey: ciSnapshot.gateKey, baseRef: ciSnapshot.baseRef ?? null,
    status: 'passed', sourceRef: 'https://ci.example/run/1', verifiedAt: new Date().toISOString() },
  push: claim.publication?.push ?? { repo, branch: 'fix-1', before: sha(9), head: claim.head, sourceRef: 'evidence/real-push.json', pushedAt: new Date().toISOString() },
  schedulerWake: { id: 'native-wake-1', at: new Date().toISOString(), sourceRef: 'evidence/native-wake.json' },
  resumeRef: 'evidence/resume.json', quietNoopRef: 'evidence/quiet-noop.json',
  copilot: { reviewId: 123, head: claim.head, automatic: true, sourceRef: 'https://github.com/example/ecorp/pull/1#pullrequestreview-123' },
  audits: { atvRef: 'evidence/atv.json', ponytailRef: 'evidence/ponytail.json' },
  fixers: [{ issueId: 'finding-1', agentId: 'fixer-1', model: 'gpt-6-astra', sourceRef: 'evidence/fixer.json', redRef: 'evidence/red.txt', greenRef: 'evidence/green.txt' }],
})

const feedbackClaim = (dir) => run(dir, 'next', { owner, feedbackNumber: 1 })
const feedbackInput = (a, extra = {}) => ({
  owner, number: a.number, claimId: a.claimId, base: a.base, head: a.head,
  receipt: {
    reviewerId: `${a.claimId}-gatechecker`, model: 'gpt-6-astra', runtime: 'native',
    claimId: a.claimId, snapshot: a.snapshot, rubricKey: a.rubricKey,
    disposition: 'NO_ACTIONABLE_FINDINGS', completedAt: new Date().toISOString(),
    sourceRef: `evidence/${a.claimId}-triage.json`, generationSourceRef: `evidence/${a.claimId}-generation.json`,
    coverage: { feedbackRef: 'all-feedback.json', resolvedThreadsRef: 'all-threads.json', templateApplicabilityRef: 'template-applicability.json' },
    ...extra,
  },
})
const roundThreePublication = (fast = false) => {
  const dir = setup([pr(1, { baseRef: 'main' })])
  let claim = start(dir), findings = []
  for (let round = 1; round <= 3; round++) {
    const finding = { id: `round-${round}`, status: 'open', evidence: [`red-${round}.log`] }
    findings.push(finding)
    run(dir, 'save', saveInput(claim, { phase: 'fixing', findings }))
    findings = findings.map((f) => ({ ...f, status: 'fixed', evidence: [...new Set([...f.evidence, `green-${f.id}.log`])] }))
    if (round < 3) {
      failedReview(dir, claim, findings)
      claim = run(dir, 'retry', retryInput(claim))
    } else run(dir, 'save', saveInput(claim, { phase: 'reviewing', findings }))
  }
  const snapshot = { ...claim.snapshot, head: sha(12) }
  bindRubric(dir, snapshot)
  const receipts = reviewers({ ...claim, head: snapshot.head })
  const push = { repo, branch: snapshot.branch, before: claim.head, head: snapshot.head,
    sourceRef: 'evidence/original-push.json', pushedAt: new Date().toISOString() }
  const currentSnapshot = { ...snapshot, reviewKey: key(2), gateKey: key(2) }
  const rebound = run(dir, 'published', { owner, number: 1, claimId: claim.claimId,
    base: claim.base, head: claim.head, snapshot: fast ? currentSnapshot : snapshot, push, reviewers: receipts })
  run(dir, 'save', saveInput(rebound, fast
    ? { phase: 'blocked', findings, reason: 'Unreviewed fast readback feedback' }
    : { phase: 'waiting', findings, technicalVerdict: 'NICE', reviewers: receipts }))
  if (!fast) run(dir, 'sync', { owner, complete: true, prs: [currentSnapshot] })
  return { dir, claim: rebound, receipts, push, snapshot: currentSnapshot, findings }
}

test('blocked feedback releases the writer without consuming feedback or hiding another PR', () => {
  const dir = setup([pr(), pr(2)])
  const published = publishComplete(dir)
  run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) })
  run(dir, 'sync', { owner, complete: true, prs: [{ ...published.snapshot, reviewKey: key(2) }, pr(2)] })
  const before = run(dir, 'show').prs['1'].cycles[0].completion
  const gate = feedbackClaim(dir)
  run(dir, 'feedback', feedbackInput(gate, { disposition: 'BLOCKED' }))
  assert.equal(run(dir, 'show').active, null, 'unknown feedback cannot hold the whole queue')
  assert.deepEqual(run(dir, 'show').prs['1'].cycles[0].completion, before, 'unknown is not processed NICE')
  const other = next(dir)
  assert.equal(other.number, 2)
  run(dir, 'save', saveInput(other, { phase: 'blocked', reason: 'Uncharged preparation unavailable' }))
  const resumed = feedbackClaim(dir)
  assert.notEqual(resumed.claimId, gate.claimId)
  assert.equal(resumed.snapshot.reviewKey, key(2))
  run(dir, 'feedback', feedbackInput(resumed))
  const state = run(dir, 'show')
  assert.equal(state.prs['1'].feedbackReviews.length, 2)
  assert.equal(state.prs['1'].cycles[0].rounds, 1)
  assert.ok(state.prs['2'].blockedClaim)
})

for (const fast of [false, true]) test(`EX-SAMECODE-FEEDBACK: round-three ${fast ? 'fast readback' : 'later Copilot'} triage retains original PASS/push and separately checks current CI`, () => {
  const { dir, claim, receipts, push, snapshot, findings } = roundThreePublication(fast)
  const before = run(dir, 'show').prs['1']
  run(dir, 'enable', { owner, acceptanceProof: proof(claim, receipts, snapshot) }, false)
  const gate = feedbackClaim(dir)
  assert.equal(gate.action, 'feedback')
  assert.equal(gate.round, null)
  assert.equal(next(dir).claimId, gate.claimId)
  for (const [command, input] of [
    ['begin', { owner, number: 1, claimId: gate.claimId, base: gate.base, head: gate.head }],
    ['retry', retryInput(gate)], ['save', saveInput(gate, { phase: 'fixing', findings })],
    ['save', saveInput(gate, { phase: 'blocked', findings })],
    ['published', { owner, number: 1, claimId: gate.claimId, base: gate.base, head: gate.head, snapshot, push, reviewers: receipts }],
  ]) run(dir, command, input, false)
  run(dir, 'feedback', feedbackInput(gate))
  let state = run(dir, 'show'), c = state.prs['1'].cycles[0]
  assert.equal(c.rounds, 3)
  assert.equal(c.noProgress, before.cycles[0].noProgress, 'triage cannot credit code progress')
  assert.equal(c.technicalVerdict, 'NICE')
  assert.deepEqual(c.completion.reviewers, receipts)
  assert.deepEqual(state.prs['1'].publications, before.publications)
  assert.equal(state.prs['1'].feedbackReviews[0].claim.claimId, gate.claimId)
  run(dir, 'enable', { owner, acceptanceProof: proof(claim, receipts, snapshot) }, false)
  const ciGate = next(dir)
  assert.equal(ciGate.action, 'check')
  run(dir, 'save', saveInput(ciGate, { findings, evidence: ['current-CI-target-gates.json'] }))
  const good = proof(claim, receipts, snapshot)
  run(dir, 'enable', { owner, acceptanceProof: { ...good,
    fixers: [{ ...good.fixers[0], agentId: `${gate.claimId}-gatechecker` }] } }, false)
  for (const ci of [
    { ...good.ci, gateKey: key(1) }, { ...good.ci, baseRef: 'release' },
    { ...good.ci, verifiedAt: push.pushedAt }, { ...good.ci, status: 'pending' },
  ]) run(dir, 'enable', { owner, acceptanceProof: { ...good, ci } }, false)
  run(dir, 'enable', { owner, acceptanceProof: good })
  state = run(dir, 'show')
  assert.equal(state.enabled, true)
  assert.equal(state.prs['1'].cycles.length, 1)
  assert.equal(state.prs['1'].cycles[0].rounds, 3)
  assert.deepEqual(state.acceptanceProof.push, push)
})

test('EX-SAMECODE-FEEDBACK: actionable at cap invalidates readiness without resetting or granting another triage', () => {
  const { dir, claim, receipts, snapshot } = roundThreePublication()
  const gate = feedbackClaim(dir)
  run(dir, 'feedback', feedbackInput(gate, { disposition: 'ACTIONABLE_FINDINGS' }))
  const state = run(dir, 'show'), c = state.prs['1'].cycles[0]
  assert.equal(c.technicalVerdict, 'NAUGHTY')
  assert.equal(c.completion, null)
  assert.equal(c.rounds, 3)
  run(dir, 'enable', { owner, acceptanceProof: proof(claim, receipts, snapshot) }, false)
  run(dir, 'next', { owner, feedbackNumber: 1 }, false)
  assert.match(next(dir).reason, /round limit/)
  assert.equal(run(dir, 'show').prs['1'].cycles.length, 1)
})

test('EX-SAMECODE-FEEDBACK: exact independent complete fresh receipt required; unknown stays pending', () => {
  const { dir, receipts } = roundThreePublication()
  const gate = feedbackClaim(dir), good = feedbackInput(gate)
  const pendingAudit = run(dir, 'show').prs['1'].seenAudit
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  for (const change of [
    { model: 'other' }, { runtime: 'cli' }, { reviewerId: owner },
    { reviewerId: receipts[0].reviewerId }, { sourceRef: receipts[0].sourceRef },
    { completedAt: '2000-01-01T00:00:00.000Z' }, { completedAt: '2999-01-01T00:00:00.000Z' },
    { claimId: 'other' }, { snapshot: { ...gate.snapshot, reviewKey: key(90) } },
    { rubricKey: key(90) }, { disposition: 'UNKNOWN' }, { generationSourceRef: '' },
    { coverage: { feedbackRef: 'partial.json' } }, { coverage: { ...good.receipt.coverage, resolvedThreadsRef: '' } },
  ]) {
    run(dir, 'feedback', { ...good, receipt: { ...good.receipt, ...change } }, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  }
  run(dir, 'feedback', feedbackInput(gate, { disposition: 'BLOCKED' }))
  assert.equal(next(dir).action, 'none', 'unknown waits quietly without holding the writer')
  assert.equal(run(dir, 'show').prs['1'].seenAudit, pendingAudit)
  run(dir, 'feedback', good, false)
  const resumed = feedbackClaim(dir)
  run(dir, 'feedback', feedbackInput(resumed, { reviewerId: 'fresh-native-checker',
    sourceRef: 'fresh-triage.json', generationSourceRef: 'fresh-generation.json' }))
  assert.equal(run(dir, 'show').prs['1'].feedbackReviews.length, 2)
})

test('EX-SAMECODE-FEEDBACK: actionable below cap returns to original charged loop and records exact triage evidence', () => {
  const dir = setup(), published = publishComplete(dir)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...published.snapshot, reviewKey: key(2) }] })
  const gate = feedbackClaim(dir), input = feedbackInput(gate, { disposition: 'ACTIONABLE_FINDINGS' })
  run(dir, 'feedback', input)
  const claim = start(dir), state = run(dir, 'show')
  assert.equal(claim.action, 'audit')
  assert.equal(claim.round, 2)
  assert.equal(state.prs['1'].cycles.length, 1)
  assert.deepEqual(state.prs['1'].feedbackReviews[0].receipt, input.receipt)
  assert.ok(state.prs['1'].cycles[0].evidence.includes(input.receipt.sourceRef))
  const pair = reviewers(claim)
  for (const change of [{ reviewerId: input.receipt.reviewerId }, { sourceRef: input.receipt.sourceRef }]) {
    run(dir, 'save', saveInput(claim, { phase: 'waiting', technicalVerdict: 'NICE',
      reviewers: [{ ...pair[0], ...change }, pair[1]] }), false)
  }
})

test('EX-SAMECODE-FEEDBACK: code/base/source/branch/target changes cannot claim or complete metadata triage', () => {
  const { dir, snapshot } = roundThreePublication()
  const journal = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  for (const change of [
    { head: sha(90) }, { base: sha(90) }, { sourceRepo: 'fork/ecorp' }, { sourceRepo: null },
    { branch: 'other' }, { baseRef: 'release' }, { readError: 'DETAIL_READ_FAILED' }, { state: 'closed' },
  ]) {
    const isolated = fixture()
    writeJournal(isolated, journal.events)
    run(isolated, 'sync', { owner, complete: true, prs: [{ ...snapshot, ...change }] })
    run(isolated, 'next', { owner, feedbackNumber: 1 }, false)
  }
  const gate = feedbackClaim(dir)
  run(dir, 'rubric', { owner, base: gate.base, head: gate.head, sourceRef: 'changed.json', sha256: key(999), criteria }, false)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, reviewKey: key(3) }] })
  run(dir, 'feedback', feedbackInput(gate), false)
  run(dir, 'feedback', feedbackInput(gate, { disposition: 'BLOCKED' }))
  const freshGate = feedbackClaim(dir)
  assert.equal(freshGate.snapshot.reviewKey, key(3))
  run(dir, 'feedback', feedbackInput(freshGate, { reviewerId: `${gate.claimId}-gatechecker` }), false)
})

// Full synthetic old-policy lineage, including its accepted conflicting publication.
// Historical events replay unchanged; only new admissions use the current fence.
const oldTargetPublication = (baseRef) => {
  const { dir, claim } = historicalClaim()
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('feedback-target'))
  for (const target of new Set(['main', baseRef])) {
    run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, baseRef: target }] })
  }
  const snapshot = { ...claim.snapshot, baseRef, head: sha(12) }
  bindRubric(dir, snapshot)
  const publication = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
    snapshot, reviewers: reviewers({ ...claim, head: snapshot.head }),
    push: { repo, branch: snapshot.branch, before: claim.head, head: snapshot.head,
      sourceRef: 'synthetic-old-policy-push.json', pushedAt: new Date().toISOString() } }
  appendHistorical(dir, 'published', publication)
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  const active = run(dir, 'show').active
  assert.equal(active.snapshot.baseRef, undefined)
  assert.equal(active.effectiveBaseRef, 'main')
  assert.equal(next(dir).action, baseRef === 'main' ? 'audit' : 'reconcile')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  run(dir, 'save', saveInput(active, { phase: 'blocked',
    evidence: ['retained-target-conflict.json'], reason: 'Retain publication for reconciliation' }))
  const feedbackSnapshot = { ...snapshot, reviewKey: key(2) }
  run(dir, 'sync', { owner, complete: true, prs: [feedbackSnapshot] })
  return { dir, claim: active, receipts: publication.reviewers, snapshot: feedbackSnapshot }
}
const appendHistorical = (dir, command, input) => {
  const events = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).events
  events.push({ version: 2, id: `old-accepted-${command}-${events.length}`,
    at: new Date().toISOString(), command, input,
    ...(command === 'next' ? { admission: 'unclaimed-round' } : {}) })
  writeJournal(dir, events)
}

for (const baseRef of ['release', 'main']) {
  test(`EX-TARGET-FEEDBACK-BASIS: old publication on ${baseRef} cannot launder a retained target conflict`, () => {
    const { dir, claim, receipts, snapshot } = oldTargetPublication(baseRef)
    const before = run(dir, 'show'), bytes = readFileSync(join(dir, 'state.json'), 'utf8')
    if (baseRef === 'release') {
      assert.match(run(dir, 'next', { owner, feedbackNumber: 1 }, false).error, /publication.*source\/target/)
      run(dir, 'next', { owner, gateNumber: 1 }, false)
      run(dir, 'enable', { owner, acceptanceProof: proof(claim, receipts, snapshot) }, false)
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
      assert.deepEqual(run(dir, 'show'), before, 'retain conflict, evidence, counters and original history')
      return
    }
    const gate = feedbackClaim(dir)
    run(dir, 'feedback', feedbackInput(gate))
    const ciGate = run(dir, 'next', { owner, gateNumber: 1 })
    run(dir, 'save', saveInput(ciGate, { evidence: ['current-CI-target-gates.json'] }))
    run(dir, 'enable', { owner, acceptanceProof: proof(claim, receipts, snapshot) })
    const state = run(dir, 'show')
    assert.equal(state.enabled, true)
    assert.equal(state.prs['1'].blockedClaim, null)
    assert.equal(state.prs['1'].cycles[0].rounds, before.prs['1'].cycles[0].rounds)
    assert.equal(state.prs['1'].cycles[0].noProgress, before.prs['1'].cycles[0].noProgress)
    assert.deepEqual(state.wakes, before.wakes)
    assert.deepEqual(state.prs['1'].publications, before.prs['1'].publications)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, before.events),
      JSON.parse(bytes).events)
  })
}

for (const stale of [false, true]) {
  test(`EX-TARGET-FEEDBACK-BASIS: retained unsafe feedback claim stays readable, stale=${stale}, but cannot complete`, () => {
    const { dir, snapshot } = oldTargetPublication('release')
    appendHistorical(dir, 'next', { owner, feedbackNumber: 1 })
    const gate = run(dir, 'show').active
    assert.equal(gate.action, 'feedback', 'old admitted claim remains readable')
    if (stale) run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, reviewKey: key(3) }] })
    const before = run(dir, 'show'), bytes = readFileSync(join(dir, 'state.json'), 'utf8')
    for (const disposition of ['NO_ACTIONABLE_FINDINGS', 'ACTIONABLE_FINDINGS']) {
      assert.match(run(dir, 'feedback', feedbackInput(gate, { disposition }), false).error,
        /publication.*source\/target|stale feedback/)
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
    }
    run(dir, 'feedback', feedbackInput(gate, { disposition: 'BLOCKED' }))
    const state = run(dir, 'show'), p = state.prs['1'], old = before.prs['1']
    assert.equal(state.active, null, 'read-only blocked receipt still releases the writer')
    assert.equal(p.cycles[0].completion, null)
    assert.equal(p.cycles[0].technicalVerdict, null)
    assert.deepEqual(p.blockedClaim, old.blockedClaim)
    assert.deepEqual(p.publications, old.publications)
    assert.equal(p.cycles[0].rounds, old.cycles[0].rounds)
    assert.equal(p.cycles[0].noProgress, old.cycles[0].noProgress)
    assert.ok(p.cycles[0].evidence.includes('retained-target-conflict.json'))
    assert.deepEqual(state.wakes, before.wakes)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, before.events),
      JSON.parse(bytes).events)
  })
}

test('EX-TARGET-FEEDBACK-BASIS: old accepted unsafe completion and enable replay but grant no new authority', () => {
  const { dir, claim, receipts, snapshot } = oldTargetPublication('release')
  appendHistorical(dir, 'next', { owner, feedbackNumber: 1 })
  const gate = run(dir, 'show').active
  appendHistorical(dir, 'feedback', feedbackInput(gate))
  const ciGate = run(dir, 'next', { owner, gateNumber: 1 })
  run(dir, 'save', saveInput(ciGate, { evidence: ['current-CI-target-gates.json'] }))
  const good = proof(claim, receipts, snapshot)
  const before = run(dir, 'show'), bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(before.prs['1'].cycles[0].technicalVerdict, 'NICE', 'do not reinterpret historical completion')
  assert.equal(before.prs['1'].blockedClaim, null, 'even old histories that cleared the claim stay fenced')
  assert.match(run(dir, 'enable', { owner, acceptanceProof: good }, false).error, /publication.*source\/target/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  const later = fixture()
  writeJournal(later, JSON.parse(bytes).events)
  run(later, 'sync', { owner, complete: true, prs: [{ ...snapshot, reviewKey: key(3) }] })
  assert.match(run(later, 'next', { owner, feedbackNumber: 1 }, false).error, /publication.*source\/target/)

  appendHistorical(dir, 'enable', { owner, acceptanceProof: good })
  const enabledBytes = readFileSync(join(dir, 'state.json'), 'utf8'), enabled = run(dir, 'show')
  assert.equal(enabled.enabled, true, 'historical enable is retained, not a fresh approval')
  assert.match(run(dir, 'enable', { owner, acceptanceProof: good }, false).error, /publication.*source\/target/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), enabledBytes)
  assert.deepEqual(run(dir, 'show'), enabled)
})

test('EX-SAMECODE-FEEDBACK: unreviewed and NAUGHTY candidates cannot use the metadata route', () => {
  const dir = setup()
  run(dir, 'next', { owner, feedbackNumber: 1 }, false)
  const claim = start(dir)
  failedReview(dir, claim)
  run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { reviewKey: key(2) })] })
  run(dir, 'next', { owner, feedbackNumber: 1 }, false)
})

test('EX-SAMECODE-FEEDBACK: later approval/feedback needs its own generation receipt even after successful triage', () => {
  const dir = setup(), published = publishComplete(dir)
  const snapshot = { ...published.snapshot, reviewKey: key(2) }
  run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
  const first = feedbackClaim(dir), receipt = feedbackInput(first)
  run(dir, 'feedback', receipt)
  run(dir, 'save', saveInput(next(dir)))
  const good = proof(published.claim, published.receipts, snapshot)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, reviewKey: key(3) }] })
  run(dir, 'enable', { owner, acceptanceProof: good }, false)
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  const second = feedbackClaim(dir)
  for (const extra of [{ sourceRef: receipt.receipt.sourceRef }, { reviewerId: receipt.receipt.reviewerId },
    { generationSourceRef: receipt.receipt.generationSourceRef }]) {
    run(dir, 'feedback', feedbackInput(second, extra), false)
  }
  run(dir, 'feedback', feedbackInput(second))
  run(dir, 'save', saveInput(next(dir)))
  run(dir, 'enable', { owner, acceptanceProof: good }, false)
  run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts, second.snapshot) })
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
})

test('EX-SAMECODE-FEEDBACK: explicit claim is canary/owner/one-writer fenced and cannot replace active work', () => {
  const dir = setup(), published = publishComplete(dir)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...published.snapshot, reviewKey: key(2) }] })
  for (const input of [
    { owner, feedbackNumber: 2 }, { owner: 'other', feedbackNumber: 1 },
    { owner, feedbackNumber: 1, gateNumber: 1 }, { owner, feedbackNumber: 0 },
  ]) run(dir, 'next', input, false)
  const gate = feedbackClaim(dir), bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'next', { owner, feedbackNumber: 2 }, false)
  const locked = fixture()
  writeJournal(locked, JSON.parse(bytes).events)
  writeFileSync(join(locked, 'executor.lock'), 'original-writer')
  run(locked, 'feedback', feedbackInput(gate), false)
  assert.equal(readFileSync(join(locked, 'executor.lock'), 'utf8'), 'original-writer')
  assert.equal(readFileSync(join(locked, 'state.json'), 'utf8'), bytes)
  const busy = setup(), audit = next(busy)
  run(busy, 'next', { owner, feedbackNumber: 1 }, false)
  assert.equal(next(busy).claimId, audit.claimId)
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
  assert.match(help.help, /ci:\{base,head,gateKey,baseRef,/)
  assert.match(help.help, /gateObservedAt/)
  assert.match(help.help, /feedbackNumber:positiveInteger/)
  assert.match(help.help, /generationSourceRef/)
  assert.match(help.help, /templateApplicabilityRef/)
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
  const observedAt = run(dir, 'show').prs['1'].gateObservedAt
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
  assert.equal(run(dir, 'show').prs['1'].gateObservedAt, observedAt, 'publication and ACK retain the first synced observation')
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

test('A02: five live failed-review/correction cycles cannot share one charge', () => {
  const dir = setup(), claim = start(dir)
  for (let n = 1; n <= 5; n++) {
    const review = saveInput(claim, { phase: 'reviewing', technicalVerdict: 'NAUGHTY',
      evidence: [`failed-review-${n}.json`], reason: `Failed review ${n}` })
    run(dir, 'save', review, n === 1)
    const before = readFileSync(join(dir, 'state.json'), 'utf8')
    assert.match(run(dir, 'save', saveInput(claim, { phase: 'fixing',
      evidence: [`correction-${n}.json`] }), false).error, /explicit retry/)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before)
  }
  const c = run(dir, 'show').prs['1'].cycles[0]
  assert.equal(c.rounds, 1)
  assert.equal(c.noProgress, 1)
  assert.equal(c.phase, 'reviewing')
  assert.deepEqual(c.evidence, ['failed-review-1.json'])
})

test('A02: exact failed receipt is a no-op, not permission to change review, findings or verdict', () => {
  const dir = setup(), claim = start(dir)
  const finding = { id: 'bug', status: 'open', evidence: ['red.log'] }
  const receipt = saveInput(claim, { phase: 'reviewing', technicalVerdict: 'NAUGHTY',
    findings: [finding], evidence: ['failed-review.json'] })
  run(dir, 'save', receipt)
  const before = readFileSync(join(dir, 'state.json'), 'utf8')
  for (let n = 0; n < 3; n++) run(dir, 'save', receipt)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before)
  for (const change of [
    { phase: 'auditing' }, { phase: 'fixing' }, { technicalVerdict: null },
    { evidence: ['another-review.json'] }, { reason: 'Another review attempt' },
    { findings: [{ ...finding, status: 'fixed', evidence: ['red.log', 'green.log'] }] },
    { phase: 'blocked', findings: [{ ...finding, status: 'fixed', evidence: ['red.log', 'green.log'] }] },
    { phase: 'waiting', findings: [{ ...finding, status: 'fixed', evidence: ['red.log', 'green.log'] }] },
    { phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(claim),
      findings: [{ ...finding, status: 'fixed', evidence: ['red.log', 'green.log'] }] },
  ]) assert.match(run(dir, 'save', { ...receipt, ...change }, false).error, /explicit retry/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before)
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(20) })] })
  assert.match(run(dir, 'save', receipt, false).error, /stale revision/, 'receipt ACK cannot bypass freshness')
})

test('A02: blocked recovery and gate checks cannot erase a failed review or charge a retry implicitly', () => {
  const dir = setup(), claim = start(dir)
  failedReview(dir, claim)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', evidence: ['tool-unavailable.json'] }))
  const gate = run(dir, 'next', { owner, gateNumber: 1 })
  run(dir, 'save', saveInput(gate, { evidence: ['gate-check.json'] }))
  const resumed = run(dir, 'resume', resumeInput(claim))
  assert.equal(resumed.round, 1)
  assert.equal(resumed.startedAt, claim.startedAt)
  assert.match(run(dir, 'save', saveInput(resumed, { phase: 'fixing' }), false).error, /explicit retry/)
  const retried = run(dir, 'retry', retryInput(resumed))
  assert.equal(retried.round, 2)
  assert.ok(retried.startedAt > resumed.startedAt)
  run(dir, 'save', saveInput(retried, { phase: 'fixing' }))
  failedReview(dir, retried)
  assert.match(run(dir, 'retry', retryInput(retried), false).error, /limit exhausted/)
})

test('A02: publication after a failed review requires a charged retry too', () => {
  const dir = setup(), claim = start(dir), candidate = pr(1, { head: sha(12) })
  failedReview(dir, claim)
  bindRubric(dir, candidate)
  const receipts = reviewers({ ...claim, head: candidate.head })
  const input = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
    snapshot: candidate, reviewers: receipts,
    push: { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
      sourceRef: 'push.json', pushedAt: new Date().toISOString() } }
  const before = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.match(run(dir, 'published', input, false).error, /explicit retry/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before)
  const retried = run(dir, 'retry', retryInput(claim))
  const freshInput = { ...input, reviewers: reviewers({ ...retried, head: candidate.head }),
    push: { ...input.push, pushedAt: new Date().toISOString() } }
  const published = run(dir, 'published', freshInput)
  failedReview(dir, published)
  const publishedBytes = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'published', freshInput)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), publishedBytes, 'exact publication ACK is not another attempt')
})

// Only synthetic/temp state is written. Retained v1 fixture is embedded below,
// so CI never needs access to any operator's live state or receipts.
const writeJournal = (dir, events, version = 2) => {
  if (!existsSync(dir)) mkdirSync(dir)
  const sha256 = createHash('sha256').update(JSON.stringify(events)).digest('hex')
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version, events, sha256 }) + '\n')
}

// Explicit synthetic historical inputs, never missing-target live CLI submissions.
const historicalSetup = (prs = [pr(1, { baseRef: undefined })], version = 1) => {
  const dir = fixture(), at = '2026-09-01T00:00:00.000Z'
  writeJournal(dir, [
    { id: 'historical-init', at, command: 'init', input: init },
    { id: 'historical-sync', at, command: 'sync', input: { owner, complete: true, prs } },
  ].map((e) => version === 2 ? { ...e, version } : e), version)
  return dir
}
const historicalClaim = (version = 1, charged = true) => {
  const dir = historicalSetup(undefined, version)
  const events = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  const at = events[0].at
  events.push({ id: 'historical-claim', at, command: 'next', input: { owner } })
  if (charged) events.push({ id: 'historical-begin', at, command: 'begin',
    input: { owner, number: 1, claimId: 'historical-claim', base: sha(10), head: sha(11) } })
  writeJournal(dir, events.map((e) => version === 2 ? { ...e, version } : e), version)
  return { dir, claim: run(dir, 'show').active }
}

for (const autonomous of [false, true]) {
  for (const command of ['begin', 'retry', 'save', 'published', 'resume', 'ACK']) {
    test(`EX-LEGACY-TARGET-FENCE: first main then release fences ${command}, autonomy=${autonomous}`, () => {
      const { dir, claim } = historicalClaim(1, command !== 'begin')
      const original = JSON.parse(readFileSync(join(dir, 'state.json'))).events
      assert.equal(claim.snapshot.baseRef, undefined)
      if (autonomous) {
        run(dir, 'autonomy', autonomyInput())
        run(dir, 'wake', wakeInput('target-fence'))
      }
      if (command === 'resume') run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
      const main = { ...claim.snapshot, baseRef: 'main' }
      run(dir, 'sync', { owner, complete: true, prs: [main] })
      if (command === 'resume') {
        // Prove first observation supports exact recovery, then retain it blocked again.
        assert.equal(run(dir, 'resume', resumeInput(claim)).claimId, claim.claimId)
        run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
      } else {
        assert.equal(next(dir).action, 'audit')
        if (command !== 'begin') run(dir, 'save', saveInput(claim, { phase: 'fixing' }))
      }
      if (command === 'retry') failedReview(dir, claim)
      const candidate = { ...main, head: sha(12) }
      bindRubric(dir, candidate)
      const publication = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
        snapshot: candidate, reviewers: reviewers({ ...claim, head: candidate.head }),
        push: { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
          sourceRef: 'synthetic-target-push.json', pushedAt: new Date().toISOString() } }
      let active = claim
      if (command === 'ACK') {
        active = run(dir, 'published', publication)
        assert.equal(active.snapshot.baseRef, undefined, 'original unknown target is not rewritten')
        const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
        assert.equal(run(dir, 'published', publication).action, 'audit')
        run(dir, 'sync', { owner, complete: true, prs: [candidate] })
        assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes, 'unchanged read and exact ACK are no-ops')
      }
      const before = run(dir, 'show')
      run(dir, 'sync', { owner, complete: true,
        prs: [{ ...(command === 'ACK' ? candidate : main), baseRef: 'release' }] })
      const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
      const input = command === 'begin' ? {
        owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
      } : command === 'retry' ? retryInput(claim)
        : command === 'save' ? saveInput(claim, { phase: 'fixing' })
          : command === 'resume' ? resumeInput(claim)
            : command === 'ACK' ? publication
              : { ...publication, snapshot: { ...candidate, baseRef: 'release' } }
      assert.match(run(dir, command === 'ACK' ? 'published' : command, input, false).error, /target conflicts|readback conflicts/)
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
      if (command !== 'resume') {
        assert.equal(next(dir).action, 'reconcile')
        run(dir, 'save', saveInput(active, { phase: 'blocked' }))
      }
      const after = run(dir, 'show')
      assert.equal(after.prs['1'].blockedClaim.claim.snapshot.baseRef, undefined)
      assert.equal(after.prs['1'].cycles[0].rounds, before.prs['1'].cycles[0].rounds)
      assert.equal(after.prs['1'].cycles[0].noProgress, before.prs['1'].cycles[0].noProgress)
      assert.deepEqual(after.wakes, before.wakes)
      assert.deepEqual(after.prs['1'].publications, before.prs['1'].publications)
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, original.length), original)
    })
  }
}

for (const version of [1, 2]) test(`EX-LEGACY-TARGET-FENCE: missing live targets rejected; historical v${version} replays unchanged`, () => {
  const { dir, claim } = historicalClaim(version)
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(run(dir, 'show').active.snapshot.baseRef, undefined)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  assert.match(run(dir, 'sync', { owner, complete: true, prs: [claim.snapshot] }, false).error, /baseRef/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  const candidate = { ...claim.snapshot, head: sha(12) }
  bindRubric(dir, candidate)
  const before = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.match(run(dir, 'published', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
    snapshot: candidate, reviewers: reviewers({ ...claim, head: candidate.head }),
    push: { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
      sourceRef: 'synthetic-unknown-push.json', pushedAt: new Date().toISOString() } }, false).error, /baseRef/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, baseRef: 'main' }] })
  assert.equal(next(dir).action, 'audit')
  assert.equal(run(dir, 'show').active.snapshot.baseRef, undefined)
})

for (const outcome of ['fixing', 'published', 'resumed']) {
  test(`EX-LEGACY-TARGET-REPLAY: old accepted ${outcome} stays readable without admitting new effects`, () => {
    const { dir, claim } = historicalClaim()
    run(dir, 'autonomy', autonomyInput())
    run(dir, 'wake', wakeInput('old-policy'))
    if (outcome === 'resumed') run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
    const main = { ...claim.snapshot, baseRef: 'main' }
    run(dir, 'sync', { owner, complete: true, prs: [main] })
    run(dir, 'sync', { owner, complete: true, prs: [{ ...main, baseRef: 'release' }] })
    const candidate = { ...main, baseRef: 'release', head: sha(12) }
    bindRubric(dir, candidate)
    const publication = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
      snapshot: candidate, reviewers: reviewers({ ...claim, head: candidate.head }),
      push: { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
        sourceRef: 'synthetic-old-policy-push.json', pushedAt: new Date().toISOString() } }
    // Historical admissions accepted by 7498b4b, not new live submissions.
    const command = outcome === 'published' ? 'published' : outcome === 'resumed' ? 'resume' : 'save'
    const input = outcome === 'published' ? publication : outcome === 'resumed' ? resumeInput(claim)
      : saveInput(claim, { phase: 'fixing', evidence: ['retained-old-correction.json'] })
    const events = JSON.parse(readFileSync(join(dir, 'state.json'))).events
    events.push({ version: 2, id: 'old-accepted-retarget', at: new Date().toISOString(), command, input })
    writeJournal(dir, events)
    const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
    const state = run(dir, 'show')
    assert.equal(state.active.claimId, claim.claimId)
    assert.equal(state.active.snapshot.baseRef, undefined)
    assert.equal(state.active.effectiveBaseRef, 'main')
    assert.equal(state.prs['1'].cycles[0].rounds, 1)
    assert.equal(state.prs['1'].cycles[0].noProgress, 1)
    if (outcome === 'published') assert.equal(state.prs['1'].publications[0].snapshot.baseRef, 'release')
    else if (outcome === 'fixing') assert.ok(state.prs['1'].cycles[0].evidence.includes('retained-old-correction.json'))
    const active = next(dir)
    assert.equal(active.action, 'reconcile')
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
    run(dir, 'save', saveInput(active, { phase: 'fixing' }), false)
    run(dir, 'save', saveInput(active, { phase: 'complete', technicalVerdict: 'NICE',
      reviewers: outcome === 'published' ? publication.reviewers : reviewers(active) }), false)
    run(dir, 'published', publication, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes, 'new effects and exact unsafe ACK stay fenced')
    run(dir, 'save', saveInput(active, { phase: 'blocked' }))
    run(dir, 'resume', resumeInput(active), false)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, events.length), events)
    assert.equal(run(dir, 'show').prs['1'].blockedClaim.claim.claimId, claim.claimId)
  })
}

test('A02: CLI stamps v2; replay rejects new bad saves even with a valid checksum', () => {
  const dir = setup(), claim = start(dir)
  failedReview(dir, claim)
  const stored = JSON.parse(readFileSync(join(dir, 'state.json')))
  assert.equal(stored.version, 2)
  assert.ok(stored.events.every((e) => e.version === 2))
  for (const change of [
    { phase: 'fixing' }, { phase: 'auditing' },
    { phase: 'reviewing', technicalVerdict: 'NAUGHTY', evidence: ['new-failure.json'] },
  ]) {
    const broken = fixture()
    writeJournal(broken, [...stored.events, { version: 2, id: 'bad-new-event',
      at: new Date().toISOString(), command: 'save', input: saveInput(claim, change) }])
    const bytes = readFileSync(join(broken, 'state.json'), 'utf8')
    assert.match(run(broken, 'show', undefined, false).error, /explicit retry/)
    assert.equal(readFileSync(join(broken, 'state.json'), 'utf8'), bytes)
  }
})

test('A02: callers cannot select legacy admission and v2 journals cannot downgrade midstream', () => {
  const dir = setup(), claim = start(dir)
  failedReview(dir, claim)
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8'), stored = JSON.parse(bytes)
  for (const extra of [{ version: 1 }, { legacy: true }, { eventVersion: 1 }, { failureReceiptVersion: 1 }]) {
    assert.match(run(dir, 'save', saveInput(claim, { phase: 'fixing', ...extra }), false).error, /fields/)
  }
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  for (const marker of [{}, { version: 1 }, { version: null }, { version: 3 }]) {
    const broken = fixture()
    writeJournal(broken, [...stored.events, { ...marker, id: 'downgrade-event',
      at: new Date().toISOString(), command: 'save', input: saveInput(claim, { phase: 'fixing' }) }])
    assert.match(run(broken, 'show', undefined, false).error, /version/)
  }
  const broken = fixture()
  writeJournal(broken, stored.events, 1)
  assert.match(run(broken, 'show', undefined, false).error, /version/)
})

// Exact 15,370-byte preflight copy retained on 2026-09-16, not the live journal.
// gzip/base64 keeps the full real inventory and three legacy saves inside this owned test file.
const legacyJournal = gunzipSync(Buffer.from(`
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
WTLxkJH8UChAcI7JCfzW8JScvzk8nfTljVnyez4X+lJdrjwUy2nw1vCQco5DjNUFBqq6t27f+VwpupvPlfVsnN5+sNtPHG45AL99
tsiGx4uHt8Dy1tDlTegCRR+TqUNR8YMPqQyJCg0g0SALeAr110OHcAL+GCEezMP5ub4duTpOZZzOrobgLdV2y5tc0+dj0Um0P/lb
/+Dk6dPvFp2Xp0+XRc63ddRNefr0eF9pnz69nsLoS5XW1y1Pn+5zrv1AdLxc28cmvlzOt+swaznebM/6ow+56NmsOu2X/eHoKnan
/zk8/vr+t4+//ObJcPrv3z75674I/k57HJdt8yE+zl5fL/7be374+Juv7j853VeUVeV8GoU33+tcRmnH5ev7333x5ZO/3jx5Hzoe
825axws9/vuyNzk/xIJ5HuX4onyQ1S5ZnvGZDqsu6/I6kLcsDZfnV7Xh6uvG6Wx/vXDb8En/gKfSPF7t/rdvxnTNHeFxWronn33W
yXaeVZpFvHzSvc7Vjl/wuHbjVPRSp6LT2ulLlnWQn7/tatgme3P5uHvyYtvVWZfz7n57/6d7zNPK3aJLey1p6ebdNI3T2Sfd5S5v
rj/UTdu1e6Vrd92K/LeWLr/q1nMd57Z6O0TL8XsNez96LX3rRuSagIiGGNAMnmoauIob2shOmkWA+wb218pnPAE49uh/u3zefve/
mYk/n5v7su54091/8v29b7fTq5XHTbf3n7ttbSepq9vdVLpT6HaTnPN0pmWY9WK7ajfrOr/qilaVteP2S7a7GJdlnM66hat2ZeSz
abusoyzH3WO95LmdmKuT8WI7P9N56XjWn8/edNawL9qNU3ddecpbB3P/mXVW/aTbzuPZOPGme3MQx6XbTZe75VzL/mHyvOXSjdPK
z9qTLJw3Wo67B7t5bud43m9r1ouWAfBJt+zyov/YtR/tt3+vji+vf+lit6xd1k7OeT7T0r0Y1/Ptbu3+vt3NE2/u5V0507VrL3Ss
x7e/8f8sim+K4odYdY9veVOihuuC+KGeOm+3azvCl8NbNfMqxD/8Lvrt15VUHV9q2+A7FMn/V431sU/EDzek2juD+Fri/KvIuN83
rNcK+HVUH50+efThT+R7P85nD+9/8fU3j588fPD4d36oH96Iujq+bIrujaJo7/aQ1DA0j37wXOuQjHFD8QJ7FxjCr/bY/qT9o2OT
/klDdstr6k9h/8e4wz5I4Wmy/5dPP/DH/4r880385zX55zX55zX5r3BNHv34oY/T/4X69E7s33366OGD4cE3358+uv/Faf8H2/63
33361cPHXw5fPfz69A+4/c9PTz/79P6Dvwyfn3794A+3+y/uPzkdHp1+/uj08Zd/tL1//s2jvwyPTr9/ePofeyf99k7CQS/xHtbC
7V3Gn43ET7fr+S/c4bed47cd4atANv9v1nU3T1q6z+8//Kq5hM916nbT+I+ddnLt1b2O91u+dF117oqW3eVrH/mTbuEL7dYX2+5q
Gt9EyvzGe96+aFbz1KbyG768bGZjHTe67M3CReeRN3vvedYr33E/De5mveRxXo67r7c3TOvtfG0wsqzj82v3+5vXruTeN3ztC7b1
ebPpKo+b/fpXR6XtnMdJy3H/U8O9nLPF0N4ooJCRA5BP0VshMrWNviWDxUhWisNUMLW/pxNEYjQBYqAUsZZMCfqf/u1/AD42Vt0K
PAAA
`, 'base64')).toString('utf8')

test('A02: actual retained v1 journal replays unchanged, but its live continuation is not legacy', () => {
  const dir = fixture()
  mkdirSync(dir)
  writeFileSync(join(dir, 'state.json'), legacyJournal)
  const stored = JSON.parse(legacyJournal), state = run(dir, 'show'), c = state.prs['304'].cycles[0]
  assert.equal(stored.sha256, 'c76b5a61749842c770fc82acb125872cd359d59be99c557a5061867985fdb791')
  assert.equal(state.events, 7)
  assert.equal(state.active.round, 1)
  assert.equal(c.phase, 'fixing')
  assert.equal(c.technicalVerdict, 'NAUGHTY')
  assert.equal(c.findings.length, 9)
  assert.deepEqual(state.rubrics, {})
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), legacyJournal)
  const last = stored.events.at(-1).input
  run(dir, 'save', last)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), legacyJournal, 'exact legacy receipt ACK is not a new correction')
  assert.match(run(dir, 'save', { ...last, reason: 'New uncharged correction' }, false).error, /explicit retry/)
  assert.match(run(dir, 'save', { ...last, phase: 'reviewing',
    evidence: ['new-failed-review.json'] }, false).error, /explicit retry/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), legacyJournal)
  // A permitted terminal block appends v2 without changing any historical event bytes.
  run(dir, 'save', { ...last, phase: 'blocked', reason: 'Preserve legacy unfinished work' })
  const updated = JSON.parse(readFileSync(join(dir, 'state.json')))
  assert.equal(updated.version, 2)
  assert.equal(updated.events.at(-1).version, 2)
  assert.equal(JSON.stringify(updated.events.slice(0, 7)), JSON.stringify(stored.events))
  assert.equal(run(dir, 'show').prs['304'].cycles[0].rounds, 1)
  // Bad FIRST v2 events after the accepted legacy prefix must be guarded on replay too.
  const broken = fixture()
  writeJournal(broken, [...stored.events, { version: 2, id: 'first-v2',
    at: new Date().toISOString(), command: 'save', input: { ...last, reason: 'New attempt' } }])
  assert.match(run(broken, 'show', undefined, false).error, /explicit retry/)
})

test('A02: actual legacy failed-review prefix can explicitly retry without rewriting its original charge', () => {
  const stored = JSON.parse(legacyJournal), dir = fixture()
  writeJournal(dir, stored.events.slice(0, 5), 1)
  const state = run(dir, 'show'), claim = state.active, old = state.prs['304'].cycles[0]
  const retried = run(dir, 'retry', { ...retryInput(claim, claim.failureEvidence[0]), owner: state.config.owner })
  assert.equal(retried.round, 2)
  assert.ok(retried.startedAt > claim.startedAt)
  assert.deepEqual(run(dir, 'show').prs['304'].cycles[0].findings, old.findings)
  const events = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  assert.equal(events.at(-1).version, 2)
  assert.deepEqual(events.slice(0, 5), stored.events.slice(0, 5))
})

for (const phase of ['fixing', 'auditing']) for (const verdict of ['NAUGHTY', null]) for (const recover of [false, true])
test(`full legacy checkpoint reaches charged retry (${phase}/${verdict ?? 'pending'})${recover ? ' after block/resume' : ' directly'}`, () => {
  const dir = fixture(), original = JSON.parse(legacyJournal)
  const history = original.events.slice()
  if (verdict === null || phase !== 'fixing') history.push({
    id: 'legacy-pending-correction', at: new Date().toISOString(), command: 'save',
    input: { ...history.at(-1).input, phase, technicalVerdict: verdict },
  })
  writeJournal(dir, history, 1)
  let state = run(dir, 'show'), claim = state.active
  const prior = structuredClone(state.prs['304'].cycles[0])
  assert.equal(state.events, history.length)
  assert.equal(prior.phase, phase)
  assert.equal(prior.technicalVerdict, verdict)
  assert.equal(claim.failureReceiptVersion, 1)
  if (recover) {
    run(dir, 'save', { ...history.at(-1).input, phase: 'blocked', reason: 'Verified temporary tool failure' })
    run(dir, 'resume', { ...resumeInput(claim), owner: state.config.owner })
    state = run(dir, 'show')
    claim = state.active
    assert.equal(state.prs['304'].cycles[0].phase, phase)
  }
  const request = { ...retryInput(claim, claim.failureEvidence[0]), owner: state.config.owner }
  for (const bad of [{ ...request, owner: 'other' }, { ...request, round: 2 },
    { ...request, reviewRef: 'unrelated-report' }]) run(dir, 'retry', bad, false)
  const retried = run(dir, 'retry', request)
  assert.equal(retried.claimId, claim.claimId)
  assert.equal(retried.round, 2, 'legacy work must consume a real new charge')
  assert.equal(retried.failureEvidence, null)
  assert.equal(retried.failureReceiptVersion, null)
  assert.deepEqual(run(dir, 'show').prs['304'].cycles[0].findings, prior.findings)
  const events = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  assert.deepEqual(events.slice(0, 7), original.events, 'no truncation or rewrite of the actual checkpoint')
  assert.deepEqual(events.slice(0, history.length), history)
  assert.equal(events.at(-1).version, 2)
  assert.equal(events.at(-1).command, 'retry')
  run(dir, 'retry', request, false)
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
  const acceptanceProof = proof(published.claim, published.receipts, gate.snapshot)
  run(dir, 'enable', { owner, acceptanceProof: { ...acceptanceProof, ci: { ...acceptanceProof.ci, status: 'pending' } } }, false)
  run(dir, 'enable', { owner, acceptanceProof })
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
})

test('EX-CI-GENERATION: old same-head green cannot enable after a changed failed gate is saved blocked', () => {
  const dir = setup(), published = publishComplete(dir)
  const oldGreen = proof(published.claim, published.receipts)
  const original = run(dir, 'show').prs['1']
  const events = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).events
  assert.equal(original.gateObservedAt, events.find((e) => e.command === 'published').at, 'publication readback starts the new-head generation')
  run(dir, 'sync', { owner, complete: true, prs: [{ ...published.snapshot, gateKey: key(3) }] })
  const gate = next(dir)
  assert.equal(gate.action, 'check')
  run(dir, 'save', saveInput(gate, {
    phase: 'blocked', evidence: ['evidence/required-CI-rerun-failed.json'], reason: 'Required CI now fails on the same head',
  }))
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.match(run(dir, 'enable', { owner, acceptanceProof: oldGreen }, false).error, /current CI/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes, 'rejected activation cannot mutate the journal')
  const state = run(dir, 'show')
  assert.equal(state.enabled, false)
  assert.equal(state.prs['1'].cycles[0].phase, 'blocked')
  assert.equal(state.prs['1'].cycles[0].technicalVerdict, 'NICE')
  assert.deepEqual(state.prs['1'].cycles[0].completion, original.cycles[0].completion)
  assert.deepEqual(state.prs['1'].publications, original.publications)
  assert.ok(oldGreen.ci.verifiedAt < state.prs['1'].gateObservedAt)
  // Neither changing just the gate key nor just the timestamp repairs an old receipt.
  for (const ci of [
    { ...oldGreen.ci, gateKey: gate.snapshot.gateKey },
    { ...oldGreen.ci, verifiedAt: new Date().toISOString() },
  ]) assert.match(run(dir, 'enable', { owner, acceptanceProof: { ...oldGreen, ci } }, false).error, /current CI/)

  const passed = { ...published.snapshot, gateKey: key(4) }
  run(dir, 'sync', { owner, complete: true, prs: [passed] })
  const refreshed = next(dir)
  run(dir, 'save', saveInput(refreshed, {
    phase: 'blocked', evidence: ['evidence/current-required-CI-passed.json', 'evidence/human-approval-pending.json'],
    reason: 'All required CI passed; human approval still pending',
  }))
  const currentProof = proof(published.claim, published.receipts, passed)
  currentProof.ci.sourceRef = 'evidence/current-required-CI-passed.json'
  run(dir, 'enable', { owner, acceptanceProof: currentProof })
  const enabled = run(dir, 'show')
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.prs['1'].cycles[0].phase, 'blocked', 'technical activation is not human approval')
  assert.equal(enabled.prs['1'].cycles[0].rounds, original.cycles[0].rounds)
  assert.deepEqual(enabled.prs['1'].cycles[0].completion, original.cycles[0].completion)
  assert.deepEqual(enabled.prs['1'].publications, original.publications)
  assert.deepEqual(enabled.acceptanceProof, currentProof)
})

test('EX-CI-GENERATION: target round trips fence old receipts even when SHAs and gateKey return unchanged', () => {
  const dir = setup([pr(1, { baseRef: 'main' })]), published = publishComplete(dir)
  const oldGreen = proof(published.claim, published.receipts)
  for (const baseRef of ['release', 'main']) {
    run(dir, 'sync', { owner, complete: true, prs: [{ ...published.snapshot, baseRef }] })
    const gate = next(dir)
    assert.equal(gate.action, 'check')
    run(dir, 'save', saveInput(gate, { phase: 'blocked', reason: 'Target protections need current CI evidence' }))
    assert.match(run(dir, 'enable', { owner, acceptanceProof: oldGreen }, false).error, /current CI/)
    const freshWrongTarget = { ...oldGreen, ci: { ...oldGreen.ci, baseRef: 'wrong-target', verifiedAt: new Date().toISOString() } }
    assert.match(run(dir, 'enable', { owner, acceptanceProof: freshWrongTarget }, false).error, /current CI/)
  }
  const good = proof(published.claim, published.receipts)
  for (const change of [
    { base: sha(99) }, { head: sha(99) }, { gateKey: key(99) }, { baseRef: null },
    { verifiedAt: 'not-a-date' }, { verifiedAt: '9999-01-01T00:00:00.000Z' },
    { gateKey: undefined }, { baseRef: undefined }, { unknown: true },
  ]) run(dir, 'enable', { owner, acceptanceProof: { ...good, ci: { ...good.ci, ...change } } }, false)
  run(dir, 'enable', { owner, acceptanceProof: good })
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
})

test('EX-CI-GENERATION: current CI permits draft and dependency waits without changing their metadata', () => {
  const dir = setup([pr(1, { baseRef: 'main', draft: true })]), published = publishComplete(dir)
  const good = proof(published.claim, published.receipts)
  const gate = run(dir, 'next', { owner, gateNumber: 1 })
  run(dir, 'save', saveInput(gate, {
    phase: 'blocked', evidence: ['evidence/dependency-pending.json'], reason: 'Draft with an unmerged dependency; required CI passed',
  }))
  const original = run(dir, 'show').prs['1']
  run(dir, 'enable', { owner, acceptanceProof: good })
  const enabled = run(dir, 'show')
  assert.equal(enabled.enabled, true)
  assert.deepEqual(enabled.prs['1'], original, 'activation must not clear draft/dependency waits or rewrite technical history')
})

test('EX-CI-GENERATION: legacy pre-enable journal replays original timestamps and metadata without rewriting', () => {
  const dir = setup(), selected = next(dir)
  const begun = run(dir, 'begin', { owner, number: 1, claimId: selected.claimId, base: selected.base, head: selected.head })
  failedReview(dir, begun, [{ id: 'retained', status: 'open', evidence: ['original-red.log'] }])
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  const journal = JSON.parse(bytes)
  assert.ok(journal.events.every((e) => ['init', 'sync', 'next', 'begin', 'save'].includes(e.command)))
  assert.equal(bytes.includes('gateObservedAt'), false, 'generation is derived, not added to historical event inputs')
  const state = run(dir, 'show')
  assert.equal(state.prs['1'].gateObservedAt, journal.events.find((e) => e.command === 'sync').at)
  assert.equal(state.active.startedAt, begun.startedAt)
  assert.equal(state.active.round, 1)
  assert.equal(state.prs['1'].cycles[0].technicalVerdict, 'NAUGHTY')
  assert.deepEqual(state.config, init)
  assert.equal(state.enabled, false)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  run(dir, 'sync', { owner, complete: true, prs: [pr(), pr(2)] })
  assert.equal(run(dir, 'show').prs['1'].gateObservedAt, state.prs['1'].gateObservedAt, 'another PR changing cannot age this generation')
  const updated = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'sync', { owner, complete: true, prs: [pr(), pr(2)] })
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), updated, 'unchanged sync is still a journal no-op')
  assert.deepEqual(JSON.parse(updated).events.slice(0, journal.events.length), journal.events)
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
  const dir = historicalSetup([pr(1, { head: init.policySha, baseRef: undefined })])
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

// Synthetic receipts prove structure/accounting, not direct-user or native-wake authenticity.
const autonomyInput = () => ({ owner, sourceRef: 'receipts/direct-user-autonomy.json', approvedAt: new Date().toISOString() })
const wakeInput = (id) => ({ owner, id, sourceRef: `receipts/native-wake-${id}.json`, startedAt: new Date().toISOString() })
const progressFailure = (dir, claim, findings = []) => {
  const finding = { id: `bug-${claim.round}`, status: 'open', evidence: [`red-${claim.round}.log`] }
  run(dir, 'save', saveInput(claim, { phase: 'fixing', findings: [...findings, finding] }))
  const fixed = [...findings, finding].map((f) => ({
    ...f, status: 'fixed', evidence: [...f.evidence, `green-${claim.round}.log`],
  }))
  failedReview(dir, claim, fixed)
  return fixed
}
const blockedThirdRound = (extra = { baseRef: 'main' }) => {
  const dir = extra.baseRef === undefined ? historicalSetup([pr(1, extra)]) : setup([pr(1, extra)])
  let claim = start(dir), findings = []
  for (let round = 1; round <= 3; round++) {
    findings = progressFailure(dir, claim, findings)
    if (round < 3) claim = run(dir, 'retry', retryInput(claim))
  }
  run(dir, 'save', saveInput(claim, { phase: 'blocked', findings, technicalVerdict: 'NAUGHTY',
    reason: 'Original three rounds exhausted', evidence: ['round-three-block.json'] }))
  return { dir, claim, findings }
}

test('EX-AUTONOMY: retained third round continues in bounded native wakes without another approval', () => {
  const fixture = blockedThirdRound(), { dir } = fixture
  let { claim, findings } = fixture
  const before = run(dir, 'show'), original = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  run(dir, 'resume', resumeInput(claim), false)
  const grant = autonomyInput()
  run(dir, 'autonomy', grant)
  const granted = run(dir, 'show')
  assert.deepEqual(granted.config, before.config)
  assert.deepEqual(granted.prs, before.prs)
  assert.equal(granted.enabled, false)
  const unready = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(next(dir).action, 'wait')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), unready)
  const firstWake = wakeInput('turn-1')
  run(dir, 'wake', firstWake)
  const resumed = run(dir, 'resume', resumeInput(claim))
  assert.equal(resumed.claimId, claim.claimId)
  assert.equal(resumed.startedAt, claim.startedAt)
  assert.equal(resumed.round, 3)
  assert.deepEqual(resumed.failureReceipt, before.prs['1'].blockedClaim.claim.failureReceipt)
  run(dir, 'save', saveInput(resumed, { phase: 'fixing', findings }), false)
  for (let round = 4; round <= 6; round++) {
    const previous = claim
    claim = run(dir, 'retry', retryInput(previous))
    assert.equal(claim.round, round)
    assert.equal(claim.claimId, previous.claimId)
    const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
    run(dir, 'retry', retryInput(previous), false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
    findings = progressFailure(dir, claim, findings)
  }
  assert.match(run(dir, 'retry', retryInput(claim), false).error, /wake/)
  assert.equal(next(dir).claimId, claim.claimId, 'already charged work remains recoverable')
  run(dir, 'save', saveInput(claim, { phase: 'blocked', findings, technicalVerdict: 'NAUGHTY',
    reason: 'Native wake batch exhausted' }))
  const exhausted = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(next(dir).action, 'wait')
  run(dir, 'autonomy', grant)
  run(dir, 'wake', firstWake)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), exhausted)
  assert.equal(run(dir, 'show').wakes[0].chargedRounds, 3)
  run(dir, 'wake', wakeInput('turn-2'))
  const beforeAck = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'wake', firstWake)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), beforeAck, 'old ACK must not restore/reset an earlier wake')
  run(dir, 'resume', resumeInput(claim))
  claim = run(dir, 'retry', retryInput(claim))
  assert.equal(claim.round, 7)
  const state = run(dir, 'show')
  assert.deepEqual(state.wakes.map((w) => w.chargedRounds), [3, 1])
  assert.equal(state.prs['1'].cycles.length, 1)
  assert.equal(state.prs['1'].cycles[0].rounds, 7)
  assert.equal(state.prs['1'].cycles[0].noProgress, 1)
  assert.deepEqual(state.config, before.config)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, original.length), original)
})

test('EX-PREINIT-AUTHORITY: original request predates init and survives autonomy, native wake and begin', () => {
  const dir = fixture()
  const input = { ...autonomyInput(), sourceRef: join(dir, '..', 'original-user-request.json') }
  // Synthetic source receipts exercise chronology, not actual user/native authenticity.
  writeFileSync(input.sourceRef, JSON.stringify(input))
  const sourceBytes = readFileSync(input.sourceRef, 'utf8')
  run(dir, 'init', init)
  const initialized = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  assert.ok(input.approvedAt < initialized[0].at)
  const grant = run(dir, 'autonomy', input)
  assert.deepEqual(grant.input, input)
  assert.equal(grant.repo, repo)
  assert.ok(grant.recordedAt >= initialized[0].at)
  assert.ok(grant.recordedAt > input.approvedAt)
  const granted = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(JSON.parse(granted).events.at(-1).at, grant.recordedAt)
  assert.deepEqual(run(dir, 'autonomy', input), grant)
  assert.equal(next(dir).action, 'wait')
  for (const startedAt of [input.approvedAt, initialized[0].at]) {
    assert.match(run(dir, 'wake', { ...wakeInput('pre-admission'), startedAt }, false).error, /stale/)
  }
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), granted)

  const wake = { ...wakeInput('preinit-native-turn'), sourceRef: join(dir, 'native-wake.json') }
  writeFileSync(wake.sourceRef, JSON.stringify(wake))
  const wakeBytes = readFileSync(wake.sourceRef, 'utf8')
  run(dir, 'wake', wake)
  run(dir, 'sync', { owner, complete: true, prs: [pr()] })
  const claim = start(dir)
  assert.equal(claim.round, 1)
  const beforeAck = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.deepEqual(run(dir, 'autonomy', input), grant)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), beforeAck)
  const state = run(dir, 'show')
  assert.deepEqual(state.autonomy, grant)
  assert.deepEqual(state.config, init)
  assert.equal(state.enabled, false)
  assert.equal(state.wakes[0].chargedRounds, 1)
  assert.deepEqual(state.wakes[0].input, wake)
  assert.equal(state.prs['1'].cycles[0].noProgress, 1)
  assert.deepEqual(JSON.parse(beforeAck).events.slice(0, initialized.length), initialized)
  assert.equal(readFileSync(input.sourceRef, 'utf8'), sourceBytes)
  assert.equal(readFileSync(wake.sourceRef, 'utf8'), wakeBytes)
})

test('EX-AUTONOMY: grant is immutable and owner/repo-bound; missing wakes cannot charge prepared work', () => {
  const dir = setup([pr(), pr(2)]), claim = next(dir), input = autonomyInput()
  const before = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'wake', wakeInput('ungranted'), false)
  for (const bad of [
    { ...input, owner: 'other' }, { ...input, repo: 'other/ecorp' }, { ...input, reset: true },
    { ...input, sourceRef: '' }, { ...input, sourceRef: ' padded ' },
    { ...input, approvedAt: undefined }, { ...input, approvedAt: 'not-a-time' },
    { ...input, approvedAt: null }, { ...input, approvedAt: 0 },
    { ...input, approvedAt: '2026-02-30T00:00:00.000Z' },
    { ...input, approvedAt: '2026-01-01T00:00:00Z' },
    { ...input, approvedAt: '9999-01-01T00:00:00.000Z' },
  ]) {
    run(dir, 'autonomy', bad, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before)
  }
  const grant = run(dir, 'autonomy', input)
  assert.deepEqual(grant.input, input)
  assert.equal(grant.repo, repo)
  const granted = readFileSync(join(dir, 'state.json'), 'utf8')
  for (const change of [{ sourceRef: 'different-message.json' }, { approvedAt: new Date().toISOString() }]) {
    assert.match(run(dir, 'autonomy', { ...input, ...change }, false).error, /immutable/)
  }
  const begin = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head }
  assert.match(run(dir, 'begin', begin, false).error, /wake/)
  assert.deepEqual(run(dir, 'autonomy', input), grant)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), granted)
  run(dir, 'wake', wakeInput('prepared-turn'))
  const started = run(dir, 'begin', begin)
  run(dir, 'begin', begin, false)
  assert.equal(started.round, 1)
  run(dir, 'save', saveInput(started, { phase: 'blocked' }))
  assert.equal(next(dir).action, 'none', 'autonomy alone never enables broad intake')
  const state = run(dir, 'show')
  assert.equal(state.enabled, false)
  assert.deepEqual(state.config, init)
  assert.equal(state.wakes[0].chargedRounds, 1)
  assert.equal(state.prs['2'].selected, 0)
  run(dir, 'extend', { owner }, false)
})

test('EX-AUTONOMY: wake identity/source/freshness are fenced, including a truthful mid-turn batch admission', () => {
  const dir = setup(), nativeStartedAt = run(dir, 'show').deployments[0].deployedAt
  const input = autonomyInput(), grant = run(dir, 'autonomy', input)
  const sourceRef = join(dir, 'native-turn-receipt.json')
  const native = { id: 'actual-native-turn', nativeStartedAt, observedAt: new Date().toISOString() }
  writeFileSync(sourceRef, JSON.stringify(native))
  const first = { ...wakeInput(native.id), sourceRef }
  assert.ok(nativeStartedAt < grant.recordedAt, 'turn actually began before this mid-turn grant')
  assert.ok(first.startedAt >= grant.recordedAt, 'batch starts after recorded authority')
  run(dir, 'wake', first)
  assert.deepEqual(JSON.parse(readFileSync(sourceRef)), native, 'never retimestamp the source receipt')
  const baseline = readFileSync(join(dir, 'state.json'), 'utf8')
  for (const bad of [
    { ...wakeInput('new'), owner: 'other' }, { ...wakeInput('new'), extra: true },
    { ...wakeInput('new'), id: '' }, { ...wakeInput('new'), id: ' padded ' },
    { ...wakeInput('new'), sourceRef: '' }, { ...wakeInput('new'), sourceRef: ' padded ' },
    { ...wakeInput('new'), sourceRef: input.sourceRef },
    { ...wakeInput('new'), startedAt: undefined }, { ...wakeInput('new'), startedAt: 'bad' },
    { ...wakeInput('new'), startedAt: nativeStartedAt },
    { ...wakeInput('new'), startedAt: first.startedAt },
    { ...wakeInput('new'), startedAt: '9999-01-01T00:00:00.000Z' },
    { ...first, id: 'different-id' }, { ...first, sourceRef: 'different-source.json' },
    { ...first, startedAt: new Date().toISOString() },
  ]) {
    run(dir, 'wake', bad, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), baseline)
  }
  const second = wakeInput('next-native-turn')
  run(dir, 'wake', second)
  const latest = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'wake', first)
  run(dir, 'wake', second)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), latest)
  assert.equal(run(dir, 'show').wakes.at(-1).input.id, second.id)
})

test('EX-AUTONOMY: three charges are global, and wait preserves the pending queue for the next native wake', () => {
  const dir = setup([pr(), pr(2), pr(3), pr(4), pr(5)]), published = publishComplete(dir)
  run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) })
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('batch-1'))
  for (const number of [2, 3, 4]) {
    const claim = start(dir)
    assert.equal(claim.number, number)
    run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
  }
  const state = run(dir, 'show'), bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(state.wakes[0].chargedRounds, 3)
  for (let n = 0; n < 3; n++) assert.equal(next(dir).action, 'wait')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  assert.equal(state.prs['5'].selected, 0)
  assert.equal(state.prs['5'].seen, null)
  const gate = run(dir, 'next', { owner, gateNumber: 2 })
  assert.equal(gate.action, 'check', 'explicit gates do not require another work batch')
  run(dir, 'save', saveInput(gate))
  assert.equal(run(dir, 'show').wakes[0].chargedRounds, 3)
  run(dir, 'wake', wakeInput('batch-2'))
  const nextClaim = start(dir)
  assert.equal(nextClaim.number, 5)
  assert.deepEqual(run(dir, 'show').wakes.map((w) => w.chargedRounds), [3, 1])
  assert.equal(run(dir, 'show').prs['2'].cycles[0].noProgress, 1)
})

test('EX-AUTONOMY: a new wake cannot clear a PR no-progress circuit breaker', () => {
  const dir = setup()
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('stall-1'))
  const first = start(dir)
  failedReview(dir, first)
  const second = run(dir, 'retry', retryInput(first))
  failedReview(dir, second)
  const before = run(dir, 'show').prs['1'].cycles[0]
  assert.equal(before.noProgress, 2)
  run(dir, 'wake', wakeInput('stall-2'))
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.match(run(dir, 'retry', retryInput(second), false).error, /no-progress/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  run(dir, 'save', saveInput(second, { phase: 'blocked' }))
  run(dir, 'resume', resumeInput(second), false)
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(12) })] })
  assert.match(next(dir).reason, /no-progress/)
  const state = run(dir, 'show')
  assert.equal(state.prs['1'].cycles[0].rounds, 2)
  assert.equal(state.prs['1'].cycles[0].noProgress, 2)
  assert.deepEqual(state.wakes.map((w) => w.chargedRounds), [2, 0])
})

test('EX-AUTONOMY: unchanged fork claims remain resumable read-only work, never audit authority', () => {
  for (const sourceRepo of ['fork/ecorp', null]) {
    const dir = setup([pr(1, { sourceRepo })])
    run(dir, 'autonomy', autonomyInput())
    run(dir, 'wake', wakeInput('fork-turn'))
    const claim = next(dir)
    assert.equal(claim.action, 'read-only')
    assert.equal(next(dir).action, 'read-only')
    const begin = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head }
    run(dir, 'begin', begin, false)
    run(dir, 'save', saveInput(claim, { phase: 'blocked' }), false)
    run(dir, 'read-only', readOnlyInput(claim))
    assert.equal(run(dir, 'show').wakes[0].chargedRounds, 0)
    assert.equal(run(dir, 'show').prs['1'].cycles[0].technicalVerdict, null)
  }
})

test('EX-AUTONOMY: completed cycles retain total PR charges and cannot reset a native wake batch', () => {
  const dir = setup()
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('cycle-batch-1'))
  for (let n = 0; n < 3; n++) {
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(11 + n) })] })
    complete(dir)
  }
  const cycles = run(dir, 'show').prs['1'].cycles
  assert.deepEqual(cycles.map((c) => c.rounds), [1, 1, 1])
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(14) })] })
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(next(dir).action, 'wait')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  run(dir, 'wake', wakeInput('cycle-batch-2'))
  start(dir)
  const state = run(dir, 'show')
  assert.deepEqual(state.prs['1'].cycles.slice(0, 3), cycles)
  assert.equal(state.prs['1'].cycles.reduce((total, c) => total + c.rounds, 0), 4)
  assert.deepEqual(state.wakes.map((w) => w.chargedRounds), [3, 1])
})

test('EX-AUTONOMY: original blocked recovery remains exact, unfinished, eligible and non-competing', () => {
  const { dir, claim, findings } = blockedThirdRound()
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('recovery'))
  const input = resumeInput(claim), bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  for (const bad of [
    { ...input, owner: 'other' }, { ...input, number: 2 }, { ...input, claimId: 'other' },
    { ...input, base: sha(99) }, { ...input, head: sha(99) }, { ...input, round: null },
    { ...input, round: 4 }, { ...input, round: '3' }, { ...input, clearance: undefined },
    { ...input, clearance: { sourceRef: 'old', verifiedAt: claim.startedAt } },
    { ...input, reset: true },
  ]) {
    run(dir, 'resume', bad, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  }
  const gate = run(dir, 'next', { owner, gateNumber: 1 })
  assert.match(run(dir, 'resume', input, false).error, /active claim/)
  run(dir, 'save', saveInput(gate, { phase: 'blocked', findings }))
  for (const change of [
    { head: sha(12) }, { base: sha(12) }, { reviewKey: key(2) }, { branch: 'other' },
    { baseRef: 'release' }, { sourceRepo: 'fork/ecorp' }, { sourceRepo: null },
    { state: 'closed' }, { readError: 'DETAIL_READ_FAILED' }, null,
  ]) {
    run(dir, 'sync', { owner, complete: true, prs: change ? [{ ...claim.snapshot, ...change }] : [] })
    const prior = readFileSync(join(dir, 'state.json'), 'utf8')
    run(dir, 'resume', resumeInput(claim), false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), prior)
  }
  run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, gateKey: key(2) }] })
  assert.equal(run(dir, 'resume', resumeInput(claim)).round, 3)
  assert.equal(run(dir, 'show').wakes[0].chargedRounds, 0, 'recovery itself is not another attempt')
})

test('EX-AUTONOMY: legacy journals retain original events, charges and failed-review provenance', () => {
  const dir = fixture()
  mkdirSync(dir)
  writeFileSync(join(dir, 'state.json'), legacyJournal)
  const original = JSON.parse(legacyJournal), state = run(dir, 'show')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), legacyJournal)
  const invoke = (command, input) => run(dir, command, { ...input, owner: state.config.owner })
  invoke('autonomy', autonomyInput())
  invoke('wake', wakeInput('legacy-continuation'))
  let claim = state.active, findings = state.prs['304'].cycles[0].findings
  for (let round = 2; round <= 4; round++) {
    claim = invoke('retry', retryInput(claim, claim.failureEvidence[0]))
    assert.equal(claim.round, round)
    const open = { id: `new-${round}`, status: 'open', evidence: [`red-${round}.log`] }
    invoke('save', saveInput(claim, { phase: 'fixing', findings: [...findings, open] }))
    findings = [...findings, { ...open, status: 'fixed', evidence: [...open.evidence, `green-${round}.log`] }]
    invoke('save', saveInput(claim, { phase: 'reviewing', technicalVerdict: 'NAUGHTY',
      evidence: [`failed-round-${round}.json`], findings }))
    claim = run(dir, 'show').active
  }
  const after = run(dir, 'show'), journal = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  assert.equal(after.wakes[0].chargedRounds, 3)
  assert.equal(after.prs['304'].cycles[0].rounds, 4)
  assert.equal(claim.claimId, state.active.claimId)
  assert.deepEqual(after.config, state.config)
  assert.deepEqual(journal.slice(0, original.events.length), original.events)
  assert.ok(journal.slice(original.events.length).every((e) => e.version === 2))
})

test('EX-AUTONOMY: publication, feedback and activation work at the wake limit without more charges', () => {
  const fixture = blockedThirdRound(), { dir } = fixture
  let { claim, findings } = fixture
  const grant = autonomyInput()
  run(dir, 'autonomy', grant)
  run(dir, 'wake', wakeInput('publication'))
  run(dir, 'resume', resumeInput(claim))
  for (let round = 4; round <= 6; round++) {
    claim = run(dir, 'retry', retryInput(claim))
    if (round < 6) findings = progressFailure(dir, claim, findings)
  }
  run(dir, 'save', saveInput(claim, { phase: 'reviewing', findings }))
  const candidate = { ...claim.snapshot, head: sha(12), reviewKey: key(2), gateKey: key(2) }
  bindRubric(dir, candidate)
  const receipts = reviewers({ ...claim, head: candidate.head })
  const push = { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
    sourceRef: 'batch-push.json', pushedAt: new Date().toISOString() }
  const publication = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
    snapshot: candidate, push, reviewers: receipts }
  const rebound = run(dir, 'published', publication)
  assert.equal(rebound.action, 'reconcile', 'fast feedback is not silently consumed')
  const publishedBytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.deepEqual(run(dir, 'published', publication), rebound)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), publishedBytes)
  run(dir, 'save', saveInput(rebound, { phase: 'blocked', findings, reason: 'Read-only feedback triage needed' }))
  assert.equal(next(dir).action, 'wait')
  run(dir, 'feedback', feedbackInput(feedbackClaim(dir)))
  const gate = run(dir, 'next', { owner, gateNumber: 1 })
  run(dir, 'save', saveInput(gate, { findings, evidence: ['current-gates.json'] }))
  run(dir, 'enable', { owner, acceptanceProof: proof(rebound, receipts, candidate) })
  run(dir, 'autonomy', grant)
  const state = run(dir, 'show')
  assert.equal(state.enabled, true)
  assert.equal(state.prs['1'].cycles[0].rounds, 6)
  assert.equal(state.prs['1'].cycles[0].technicalVerdict, 'NICE')
  assert.equal(state.wakes[0].chargedRounds, 3)
  assert.deepEqual(state.prs['1'].publications[0].push, push)
  assert.deepEqual(state.prs['1'].cycles[0].completion.reviewers, receipts)
})

test('EX-AUTONOMY: direct source/target guards survive publication', () => {
  const baseRef = 'main'
  const { dir: seed, claim, findings } = blockedThirdRound({ baseRef })
  run(seed, 'autonomy', autonomyInput())
  run(seed, 'wake', wakeInput('scope'))
  run(seed, 'resume', resumeInput(claim))
  const fourth = run(seed, 'retry', retryInput(claim)), candidate = { ...claim.snapshot, head: sha(12) }
  bindRubric(seed, candidate)
  const receipts = reviewers({ ...fourth, head: candidate.head }), currentReceipts = reviewers(fourth)
  const publication = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
    snapshot: candidate, reviewers: receipts,
    push: { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
      sourceRef: 'scope-push.json', pushedAt: new Date().toISOString() } }
  const history = JSON.parse(readFileSync(join(seed, 'state.json'))).events
  for (const change of [
    { baseRef: 'release' }, { baseRef: baseRef === undefined ? 'main' : undefined },
    { sourceRepo: 'fork/ecorp' }, { sourceRepo: null }, { branch: 'other' }, { base: sha(90) },
  ]) {
    const dir = fixture()
    writeJournal(dir, history)
    if (Object.hasOwn(change, 'baseRef') && change.baseRef === undefined) {
      writeJournal(dir, [...history, { version: 2, id: 'historical-missing-target',
        at: new Date().toISOString(), command: 'sync',
        input: { owner, complete: true, prs: [{ ...claim.snapshot, ...change }] } }])
    } else run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, ...change }] })
    const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
    run(dir, 'save', saveInput(fourth, { phase: 'fixing', findings }), false)
    run(dir, 'save', saveInput(fourth, { phase: 'complete', findings,
      technicalVerdict: 'NICE', reviewers: currentReceipts }), false)
    run(dir, 'published', { ...publication, snapshot: { ...candidate, ...change } }, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
    assert.equal(next(dir).action, 'reconcile')
    run(dir, 'save', saveInput(fourth, { phase: 'blocked', findings }))
    assert.equal(run(dir, 'show').prs['1'].blockedClaim.claim.claimId, claim.claimId)
  }
  const rebound = run(seed, 'published', publication)
  assert.equal(rebound.action, 'audit')
  run(seed, 'sync', { owner, complete: true, prs: [{ ...candidate, baseRef: 'release' }] })
  run(seed, 'published', publication, false)
  run(seed, 'save', saveInput(rebound, { phase: 'complete', findings,
    technicalVerdict: 'NICE', reviewers: receipts }), false)
  run(seed, 'sync', { owner, complete: true, prs: [candidate] })
  run(seed, 'save', saveInput(rebound, { phase: 'complete', findings,
    technicalVerdict: 'NICE', reviewers: receipts }))
  assert.equal(run(seed, 'show').prs['1'].cycles[0].technicalVerdict, 'NICE')
})

test('EX-AUTONOMY: legacy first-observed target permits original recovery and publication, not a known retarget', () => {
  const { dir, claim, findings } = blockedThirdRound({ baseRef: undefined })
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('legacy-target'))
  run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, baseRef: 'main' }] })
  assert.equal(run(dir, 'resume', resumeInput(claim)).claimId, claim.claimId)
  const fourth = run(dir, 'retry', retryInput(claim))
  assert.equal(fourth.snapshot.baseRef, 'main', 'ordinary new charge binds the observed target')
  run(dir, 'sync', { owner, complete: true, prs: [{ ...fourth.snapshot, baseRef: 'release' }] })
  run(dir, 'save', saveInput(fourth, { phase: 'fixing', findings }), false)
  assert.equal(next(dir).action, 'reconcile')
  // A legacy already-charged claim may also publish after its first target observation.
  const legacy = historicalSetup(), original = start(legacy)
  run(legacy, 'autonomy', autonomyInput())
  const candidate = { ...original.snapshot, head: sha(12), baseRef: 'main' }
  run(legacy, 'sync', { owner, complete: true, prs: [{ ...original.snapshot, baseRef: 'main' }] })
  bindRubric(legacy, candidate)
  const receipts = reviewers({ ...original, head: candidate.head })
  const rebound = run(legacy, 'published', { owner, number: 1, claimId: original.claimId,
    base: original.base, head: original.head, snapshot: candidate, reviewers: receipts,
    push: { repo, branch: candidate.branch, before: original.head, head: candidate.head,
      sourceRef: 'legacy-push.json', pushedAt: new Date().toISOString() } })
  assert.equal(rebound.snapshot.baseRef, undefined, 'do not invent a historical target')
  run(legacy, 'save', saveInput(rebound, { phase: 'waiting', technicalVerdict: 'NICE', reviewers: receipts }))
  assert.equal(run(legacy, 'next', { owner, gateNumber: 1 }).snapshot.baseRef, 'main')
})

test('EX-PRESTART-RESUME: first-ever preparation block recovers the exact uncharged audit and begins once', () => {
  const dir = setup(), claim = next(dir)
  const begin = { owner, number: claim.number, claimId: claim.claimId, base: claim.base, head: claim.head }
  assert.equal(claim.action, 'audit')
  assert.equal(claim.round, null)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', reason: 'Worktree preparation failed',
    evidence: ['evidence/preparation-failed.json'] }))
  const blocked = run(dir, 'show'), original = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  assert.equal(blocked.active, null)
  assert.equal(blocked.prs['1'].cycles[0].rounds, 0)
  assert.equal(blocked.prs['1'].cycles[0].noProgress, 0)
  run(dir, 'sync', { owner, complete: true, prs: [pr()] })
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(next(dir).action, 'none', 'blocked audit must not hot-loop')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  const input = resumeInput(claim)
  for (const bad of [
    { ...input, owner: 'other' }, { ...input, number: 2 }, { ...input, claimId: 'other' },
    { ...input, head: sha(99) }, { ...input, base: sha(99) },
    { ...input, round: 0 }, { ...input, round: 1 }, { ...input, round: undefined },
    { ...input, clearance: undefined }, { ...input, reset: true },
    { ...input, clearance: { ...input.clearance, sourceRef: '' } },
    { ...input, clearance: { ...input.clearance, verifiedAt: '2000-01-01T00:00:00.000Z' } },
    { ...input, clearance: { ...input.clearance, verifiedAt: '9999-01-01T00:00:00.000Z' } },
  ]) {
    run(dir, 'resume', bad, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  }
  const resumed = run(dir, 'resume', input), recovered = run(dir, 'show')
  assert.deepEqual(recovered.active, claim, 'claim identity, snapshot, start and uncharged round stay exact')
  assert.equal(recovered.sequence, blocked.sequence)
  assert.equal(recovered.prs['1'].cycles[0].rounds, 0)
  assert.equal(recovered.prs['1'].cycles[0].noProgress, 0)
  assert.equal(recovered.prs['1'].cycles[0].phase, 'pending')
  assert.deepEqual(resumed.evidence, ['evidence/preparation-failed.json', input.clearance.sourceRef])
  run(dir, 'resume', input, false)
  // A second preparation failure still needs a fresh explicit recovery, not a new claim.
  run(dir, 'save', saveInput(resumed, { phase: 'blocked', reason: 'Preparation still unavailable' }))
  assert.equal(next(dir).action, 'none')
  run(dir, 'resume', input, false)
  assert.equal(run(dir, 'resume', resumeInput(claim)).claimId, claim.claimId)
  const begun = run(dir, 'begin', begin)
  assert.equal(begun.claimId, claim.claimId)
  assert.equal(begun.round, 1)
  assert.ok(begun.startedAt)
  const charged = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'begin', begin, false)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), charged)
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
  assert.deepEqual(JSON.parse(charged).events.slice(0, original.length), original)
  const help = run(fixture(), 'help').help
  assert.match(help, /round:positiveInteger\|null/)
  assert.match(help, /round:null recovers an uncharged audit; begin must then charge/)
})

test('EX-PRESTART-RESUME: gates cannot replace audit recovery; conflicts and read-only claims stay fenced', () => {
  const dir = historicalSetup(), claim = next(dir)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', reason: 'Preparation unavailable' }))
  const retained = run(dir, 'show').prs['1'].blockedClaim
  const gate = run(dir, 'next', { owner, gateNumber: 1 })
  assert.equal(gate.action, 'check')
  run(dir, 'begin', { owner, number: 1, claimId: gate.claimId, base: gate.base, head: gate.head }, false)
  assert.match(run(dir, 'resume', resumeInput(claim), false).error, /active claim/)
  run(dir, 'save', saveInput(gate, { phase: 'blocked', evidence: ['gate-check.json'] }))
  assert.deepEqual(run(dir, 'show').prs['1'].blockedClaim, retained)
  run(dir, 'resume', resumeInput(gate), false)
  for (const change of [{ head: sha(12) }, { base: sha(12) }, { reviewKey: key(2) },
    { branch: 'other' }, { sourceRepo: 'fork/ecorp' }, { sourceRepo: null },
    { readError: 'DETAIL_READ_FAILED' }, { state: 'closed' }]) {
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, change)] })
    const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
    run(dir, 'resume', resumeInput(claim), false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  }
  run(dir, 'sync', { owner, complete: true, prs: [] })
  run(dir, 'resume', resumeInput(claim), false)
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { baseRef: 'main', gateKey: key(2) })] })
  const resumed = run(dir, 'resume', resumeInput(claim))
  assert.equal(resumed.snapshot.baseRef, undefined, 'legacy target is not invented during recovery')
  assert.equal(resumed.round, null)
  const known = setup([pr(1, { baseRef: 'main' })]), original = next(known)
  run(known, 'save', saveInput(original, { phase: 'blocked' }))
  run(known, 'sync', { owner, complete: true, prs: [pr(1, { baseRef: 'release' })] })
  assert.match(run(known, 'resume', resumeInput(original), false).error, /target conflicts/)
  for (const sourceRepo of ['fork/ecorp', null]) {
    const fork = setup([pr(1, { sourceRepo })]), read = next(fork)
    run(fork, 'save', saveInput(read, { phase: 'blocked' }), false)
    run(fork, 'read-only', readOnlyInput(read, { verdict: 'BLOCKED' }))
    run(fork, 'resume', resumeInput(read), false)
    assert.equal(run(fork, 'show').prs['1'].blockedClaim, undefined)
  }
})

test('EX-PRESTART-RESUME: blocked preparation leaves other PRs schedulable without stealing active work', () => {
  const dir = setup([pr(), pr(2), pr(3)]), published = publishComplete(dir)
  run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) })
  const claim = next(dir)
  assert.equal(claim.number, 2)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', reason: 'Preparation unavailable' }))
  const other = next(dir)
  assert.equal(other.number, 3)
  assert.match(run(dir, 'resume', resumeInput(claim), false).error, /active claim/)
  run(dir, 'save', saveInput(other))
  assert.equal(next(dir).action, 'none')
  assert.equal(run(dir, 'resume', resumeInput(claim)).claimId, claim.claimId)
  assert.equal(run(dir, 'show').prs['2'].cycles[0].rounds, 0)
})

for (const [rounds, changedHead] of [[1, true], [3, true], [1, false]]) {
  test(`EX-PRESTART-RESUME: prebegin after NICE at round ${rounds}, changed head=${changedHead}, preserves history until begin`, () => {
    const dir = setup()
    let prior, findings = []
    for (let round = 1; round <= rounds; round++) {
      prior = start(dir)
      const open = { id: `bug-${round}`, status: 'open', evidence: [`red-${round}.log`] }
      run(dir, 'save', saveInput(prior, { phase: 'fixing', findings: [...findings, open] }))
      findings.push({ ...open, status: 'fixed', evidence: [...open.evidence, `green-${round}.log`] })
      run(dir, 'save', saveInput(prior, round === rounds
        ? { phase: 'complete', findings, technicalVerdict: 'NICE', reviewers: reviewers(prior) }
        : { phase: 'waiting', findings }))
      if (round < rounds) run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(11 + round) })] })
    }
    const completed = run(dir, 'show').prs['1'].cycles[0]
    const snapshot = { ...prior.snapshot, ...(changedHead ? { head: sha(50) } : { reviewKey: key(50) }) }
    run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
    const claim = next(dir)
    assert.equal(claim.action, 'audit')
    assert.equal(claim.round, null)
    run(dir, 'save', saveInput(claim, { phase: 'blocked', findings, reason: 'New audit preparation failed' }))
    assert.equal(next(dir).action, 'none')
    const before = run(dir, 'show'), resumed = run(dir, 'resume', resumeInput(claim)), after = run(dir, 'show')
    assert.equal(resumed.claimId, claim.claimId)
    assert.equal(resumed.round, null)
    assert.equal(resumed.startedAt, null)
    assert.equal(after.prs['1'].cycles.length, 1, 'resume cannot start a new cycle')
    assert.equal(after.sequence, before.sequence)
    const recovered = after.prs['1'].cycles[0]
    for (const field of ['rounds', 'noProgress', 'findings', 'completion', 'technicalVerdict', 'phase', 'reason']) {
      assert.deepEqual(recovered[field], completed[field], field)
    }
    assert.ok(recovered.evidence.includes(resumeInput(claim).clearance.sourceRef))
    const begin = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head }
    assert.equal(run(dir, 'begin', begin).round, changedHead ? 1 : rounds + 1)
    run(dir, 'begin', begin, false)
    const cycles = run(dir, 'show').prs['1'].cycles
    assert.equal(cycles.length, changedHead ? 2 : 1)
    assert.equal(cycles.at(-1).technicalVerdict, null, 'previous NICE does not complete this audit')
    assert.equal(cycles.at(-1).completion, null)
    assert.equal(cycles.at(-1).noProgress, 1)
    if (changedHead) assert.deepEqual(cycles[0], recovered, 'prior NICE history stays intact')
  })
}

test('EX-PRESTART-RESUME: uncharged recovery within unfinished history keeps bounds and rejects a superseded budget position', () => {
  const dir = setup(), first = start(dir)
  run(dir, 'save', saveInput(first, { phase: 'blocked' }))
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(12) })] })
  const claim = next(dir)
  run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
  const resumed = run(dir, 'resume', resumeInput(claim))
  assert.equal(resumed.round, null)
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
  run(dir, 'save', saveInput(resumed, { phase: 'blocked' }))
  // A different revision spends the remaining no-progress round without replacing blockedClaim.
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(13) })] })
  const second = start(dir)
  run(dir, 'save', saveInput(second))
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: claim.head })] })
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.match(run(dir, 'resume', resumeInput(claim), false).error, /no matching retained/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  assert.match(next(dir).reason, /no-progress/)
  const cycles = run(dir, 'show').prs['1'].cycles
  assert.equal(cycles.length, 1)
  assert.equal(cycles[0].rounds, 2)
  assert.equal(cycles[0].noProgress, 2)
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
  const dir = historicalSetup(), claim = start(dir)
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
  run(dir, 'enable', { owner, acceptanceProof: proof(rebound, receipts, gate.snapshot) })
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
  const known = setup([pr(1, { baseRef: 'main' })]), original = start(known)
  run(known, 'save', saveInput(original, { phase: 'blocked', reason: 'Local tool unavailable' }))
  run(known, 'sync', { owner, complete: true, prs: [pr(1, { baseRef: 'release' })] })
  assert.match(run(known, 'resume', resumeInput(original), false).error, /target conflicts/)
})

// Synthetic original-ceiling stops: no blocked audit claim ever existed.
const unclaimedRoundStop = ({ enabled = false, stalled = false } = {}) => {
  const dir = setup()
  if (enabled) {
    const published = publishComplete(dir)
    run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) })
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(20), baseRef: 'main' })] })
  }
  let findings = []
  for (let n = 0; n < 3; n++) {
    const claim = start(dir)
    if (!stalled || n === 0) {
      const finding = { id: `stop-${n}`, status: 'open', evidence: [`red-${n}.log`] }
      run(dir, 'save', saveInput(claim, { phase: 'fixing', findings: [...findings, finding] }))
      findings.push({ ...finding, status: 'fixed', evidence: [...finding.evidence, `green-${n}.log`] })
    }
    run(dir, 'save', saveInput(claim, { findings }))
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: sha(21 + n), baseRef: 'main' })] })
  }
  const stopped = next(dir)
  assert.equal(stopped.action, 'blocked')
  assert.equal(stopped.reason, 'round limit exhausted')
  assert.equal(stopped.claimId, null)
  return { dir, findings, snapshot: pr(1, { head: sha(23), baseRef: 'main' }) }
}

test('EX-UNCLAIMED-ROUND-STOP: unchanged generation re-enters next/begin only with autonomy and wake capacity', () => {
  const { dir, findings } = unclaimedRoundStop()
  const before = run(dir, 'show'), original = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  assert.equal(before.active, null)
  assert.equal(before.prs['1'].blockedClaim, undefined)
  assert.equal(next(dir).action, 'none', 'interactive ceiling remains quiet and unchanged')
  run(dir, 'autonomy', autonomyInput())
  const waiting = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(next(dir).action, 'wait')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), waiting)
  run(dir, 'wake', wakeInput('unclaimed'))
  const claim = next(dir)
  assert.equal(claim.action, 'audit')
  assert.equal(claim.head, sha(23))
  assert.equal(claim.round, null)
  assert.equal(run(dir, 'show').wakes[0].chargedRounds, 0)
  assert.equal(next(dir).claimId, claim.claimId)
  const charged = start(dir)
  assert.equal(charged.round, 4)
  const chargedState = run(dir, 'show')
  assert.equal(chargedState.prs['1'].cycles.length, 1)
  assert.equal(chargedState.prs['1'].cycles[0].noProgress, 1)
  assert.equal(chargedState.wakes[0].chargedRounds, 1)
  assert.deepEqual(chargedState.prs['1'].cycles[0].findings, findings)
  assert.equal(chargedState.prs['1'].seenAudit, before.prs['1'].seenAudit)
  run(dir, 'save', saveInput(charged, { phase: 'complete', findings, technicalVerdict: 'NICE', reviewers: reviewers(charged) }))
  run(dir, 'wake', wakeInput('after-completion'))
  assert.equal(next(dir).action, 'none', 'completed generation must not requeue')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, original.length), original)
})

test('EX-UNCLAIMED-ROUND-STOP: actionable feedback at cap cannot be consumed by a gate check', () => {
  const { dir, findings } = roundThreePublication()
  const feedback = feedbackClaim(dir)
  run(dir, 'feedback', feedbackInput(feedback, { disposition: 'ACTIONABLE_FINDINGS' }))
  assert.equal(next(dir).reason, 'round limit exhausted')
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.match(run(dir, 'next', { owner, gateNumber: 1 }, false).error, /pending audit/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('actionable-stop'))
  const claim = start(dir)
  assert.equal(claim.round, 4)
  failedReview(dir, claim, findings)
  run(dir, 'save', saveInput(claim, { phase: 'fixing', findings }), false)
  assert.equal(run(dir, 'show').prs['1'].cycles[0].technicalVerdict, 'NAUGHTY')
})

for (const version of [1, 2]) test(`EX-UNCLAIMED-ROUND-STOP: v${version} stopped generation and later gate saves replay unchanged`, () => {
  const { dir, findings, snapshot } = unclaimedRoundStop()
  // Reproduce the OLD admitted gate after the ceiling stop, not a new executable claim.
  const history = JSON.parse(readFileSync(join(dir, 'state.json'))).events.map(({ admission, ...e }) => {
    if (version === 1) delete e.version
    return e
  })
  const gate = { number: 1, claimId: 'historical-gate', base: snapshot.base, head: snapshot.head }
  const at = new Date().toISOString(), envelope = version === 2 ? { version: 2 } : {}
  history.push({ ...envelope, id: gate.claimId, at, command: 'next', input: { owner, gateNumber: 1 } },
    { ...envelope, id: 'historical-gate-save', at, command: 'save',
      input: saveInput(gate, { findings, evidence: ['historical-gate.json'] }) })
  writeJournal(dir, history, version)
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8'), before = run(dir, 'show')
  assert.equal(before.active, null)
  assert.equal(before.prs['1'].blockedClaim, undefined)
  assert.equal(before.prs['1'].cycles[0].rounds, 3)
  assert.ok(before.prs['1'].cycles[0].evidence.includes('historical-gate.json'))
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput(`legacy-stop-${version}`))
  assert.equal(next(dir).action, 'audit')
  assert.equal(start(dir).round, 4)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, history.length), history)
  assert.equal(run(dir, 'show').wakes[0].chargedRounds, 1, 'new admission must also replay exactly')
})

test('EX-UNCLAIMED-ROUND-STOP: current source/target, changed generations and canary fences still govern admission', () => {
  const { dir: seed, snapshot } = unclaimedRoundStop()
  const history = JSON.parse(readFileSync(join(seed, 'state.json'))).events
  for (const [change, expected] of [
    [{ head: sha(88) }, 'audit'], [{ reviewKey: key(88) }, 'audit'],
    [{ sourceRepo: 'fork/ecorp' }, 'read-only'], [{ sourceRepo: null }, 'read-only'],
    [{ readError: 'DETAIL_READ_FAILED' }, 'blocked'], [{ state: 'closed' }, 'none'],
    [{ baseRef: 'release' }, 'audit'], [{ gateKey: key(88) }, 'audit'],
  ]) {
    const dir = fixture()
    writeJournal(dir, history)
    run(dir, 'autonomy', autonomyInput())
    run(dir, 'wake', wakeInput('scope-stop'))
    run(dir, 'sync', { owner, complete: true, prs: [pr(2), { ...snapshot, ...change }] })
    if (change.baseRef) assert.match(run(dir, 'next', { owner, gateNumber: 1 }, false).error, /pending audit input/)
    const claim = next(dir)
    assert.equal(claim.action, expected, JSON.stringify(change))
    if (expected === 'audit') {
      assert.deepEqual(claim.snapshot, { ...snapshot, ...change }, 'claim current input, never stale stopped snapshot')
      assert.equal(claim.round, null, 'unclaimed pending work needs a fresh charge')
      assert.equal(start(dir).round, 4)
      assert.equal(run(dir, 'show').prs['1'].cycles.at(-1).completion, null, 'old reviews cannot complete the new audit')
    } else if (claim.claimId) {
      run(dir, 'begin', { owner, number: claim.number, claimId: claim.claimId, base: claim.base, head: claim.head }, false)
    }
  }
  const dir = fixture()
  writeJournal(dir, history)
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('absent-stop'))
  run(dir, 'sync', { owner, complete: true, prs: [pr(2)] })
  assert.equal(next(dir).action, 'none', 'absent stopped PR never grants broad intake')
})

test('EX-UNCLAIMED-ROUND-STOP: no-progress stays hard and stopped work does not starve other PRs', () => {
  for (const stalled of [false, true]) {
    const { dir, snapshot } = unclaimedRoundStop({ enabled: true, stalled })
    run(dir, 'autonomy', autonomyInput())
    run(dir, 'wake', wakeInput('fair-stop'))
    run(dir, 'sync', { owner, complete: true, prs: [snapshot, pr(2)] })
    const other = start(dir)
    assert.equal(other.number, 2, 'least-selected eligible work still goes first')
    run(dir, 'save', saveInput(other))
    const nextClaim = next(dir)
    assert.equal(nextClaim.action, stalled ? 'none' : 'audit')
    const state = run(dir, 'show')
    assert.equal(state.prs['1'].cycles.at(-1).rounds, 3)
    assert.equal(state.prs['1'].cycles.at(-1).noProgress, stalled ? 2 : 0)
    assert.equal(state.wakes[0].chargedRounds, 1)
  }
})

const detailFailure = (snapshot, operation = 'reviews') => ({
  ...snapshot, readError: 'DETAIL_READ_FAILED', reviewKey: key(900), gateKey: key(901),
  readFailure: { operation, kind: 'COMMAND_FAILED', exitCode: 1, signal: null },
})

for (const explicit of [false, true]) test(`EX-DETAIL-RECOVERY: identical published NICE recovers by ${explicit ? 'explicit' : 'ordinary'} uncharged gates, then actionable feedback audits`, () => {
  const dir = setup()
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('detail-recovery'))
  const published = publishComplete(dir), before = run(dir, 'show')
  assert.equal(before.prs['1'].cycles[0].noProgress, 1, 'retain the original pessimistic charge')
  for (let n = 0; n < 3; n++) {
    run(dir, 'sync', { owner, complete: true, prs: [detailFailure(published.snapshot)] })
    const blocked = next(dir), unavailable = run(dir, 'show')
    assert.equal(blocked.action, 'blocked')
    assert.equal(blocked.claimId, null)
    assert.match(blocked.reason, /DETAIL_READ_FAILED/)
    assert.equal(unavailable.active, null)
    assert.equal(unavailable.prs['1'].blockedClaim, undefined)
    assert.equal(unavailable.prs['1'].seenAudit, before.prs['1'].seenAudit, 'a failed read is not a processed audit')
    assert.notEqual(unavailable.prs['1'].seen, before.prs['1'].seen, 'record failure separately for quietness')
    const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
    assert.equal(next(dir).action, 'none')
    run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) }, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes, 'unknown evidence never enables intake')
    run(dir, 'sync', { owner, complete: true, prs: [published.snapshot] })
    const gate = explicit ? run(dir, 'next', { owner, gateNumber: 1 }) : next(dir)
    assert.equal(gate.action, 'check')
    assert.equal(gate.round, null)
    run(dir, 'begin', { owner, number: 1, claimId: gate.claimId, base: gate.base, head: gate.head }, false)
    run(dir, 'save', saveInput(gate, { evidence: [`evidence/recovered-gate-${n}.json`] }))
    const recovered = run(dir, 'show')
    assert.equal(recovered.prs['1'].cycles[0].rounds, 1)
    assert.equal(recovered.prs['1'].cycles[0].noProgress, 1)
    assert.deepEqual(recovered.prs['1'].cycles[0].completion, before.prs['1'].cycles[0].completion)
    assert.deepEqual(recovered.prs['1'].publications, before.prs['1'].publications)
    assert.deepEqual(recovered.wakes, before.wakes)
    assert.equal(next(dir).action, 'none')
  }
  run(dir, 'sync', { owner, complete: true, prs: [{ ...published.snapshot, reviewKey: key(2) }] })
  const triage = feedbackClaim(dir)
  run(dir, 'feedback', feedbackInput(triage, { disposition: 'ACTIONABLE_FINDINGS' }))
  const audit = start(dir)
  assert.equal(audit.action, 'audit')
  assert.equal(audit.round, 2, 'only the actual new actionable generation spends another round')
  const state = run(dir, 'show')
  assert.equal(state.wakes[0].chargedRounds, 2)
  assert.equal(state.prs['1'].cycles[0].noProgress, 2)
  assert.equal(state.prs['1'].cycles[0].completion, null)
})

for (const change of [null, { head: sha(20) }, { base: sha(20) }, { reviewKey: key(20) }]) {
  test(`EX-DETAIL-RECOVERY: ${change ? JSON.stringify(change) : 'first-ever read'} errors leave the healthy generation unaudited`, () => {
    const dir = setup()
    const healthy = change ? { ...publishComplete(dir).snapshot, ...change } : pr()
    const before = run(dir, 'show')
    for (const operation of ['reviews', 'check_runs']) {
      run(dir, 'sync', { owner, complete: true, prs: [detailFailure(healthy, operation)] })
      assert.equal(next(dir).action, 'blocked')
      assert.equal(run(dir, 'show').prs['1'].seenAudit, before.prs['1'].seenAudit)
      assert.equal(next(dir).action, 'none')
    }
    run(dir, 'sync', { owner, complete: true, prs: [healthy] })
    run(dir, 'next', { owner, gateNumber: 1 }, false)
    const audit = start(dir)
    assert.equal(audit.action, 'audit')
    assert.deepEqual(audit.snapshot, healthy)
    assert.equal(audit.round, !change || change.head ? 1 : 2)
    assert.equal(run(dir, 'show').prs['1'].cycles.at(-1).completion, null)
  })
}

for (const charged of [false, true]) test(`EX-DETAIL-RECOVERY: interrupted ${charged ? 'charged' : 'uncharged'} active work retains its exact claim and resumes`, () => {
  const dir = setup(), claim = charged ? start(dir) : next(dir), before = run(dir, 'show')
  run(dir, 'sync', { owner, complete: true, prs: [detailFailure(pr())] })
  assert.equal(next(dir).action, 'reconcile')
  assert.equal(next(dir).claimId, claim.claimId)
  assert.equal(run(dir, 'show').prs['1'].seenAudit, before.prs['1'].seenAudit)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', reason: 'Details unavailable' }))
  assert.equal(next(dir).action, 'blocked')
  assert.equal(run(dir, 'show').prs['1'].seenAudit, before.prs['1'].seenAudit)
  run(dir, 'sync', { owner, complete: true, prs: [pr()] })
  const resumed = run(dir, 'resume', resumeInput(claim))
  assert.equal(resumed.claimId, claim.claimId)
  assert.equal(resumed.round, claim.round)
  assert.equal(resumed.startedAt, claim.startedAt)
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, charged ? 1 : 0)
  assert.equal(run(dir, 'show').prs['1'].cycles[0].noProgress, charged ? 1 : 0)
  if (!charged) assert.equal(start(dir).round, 1)
})

test('EX-DETAIL-RECOVERY: unreadable published PR remains quiet without starving other eligible PRs', () => {
  const dir = setup(), published = publishComplete(dir)
  run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) })
  const before = run(dir, 'show')
  run(dir, 'sync', { owner, complete: true, prs: [detailFailure(published.snapshot)] })
  assert.equal(next(dir).action, 'blocked')
  assert.equal(run(dir, 'show').prs['1'].seenAudit, before.prs['1'].seenAudit)
  run(dir, 'sync', { owner, complete: true, prs: [detailFailure(published.snapshot), pr(2)] })
  const other = start(dir)
  assert.equal(other.number, 2)
  run(dir, 'save', saveInput(other))
  assert.equal(next(dir).action, 'none')
  run(dir, 'sync', { owner, complete: true, prs: [published.snapshot, pr(2)] })
  const recovered = next(dir)
  assert.equal(recovered.number, 1)
  assert.equal(recovered.action, 'check')
})

// Frozen before the fix using bfc0573's CLI: the old recovery admitted a second
// audit/begin/NICE, then hit noProgress=2. Later accepted events depend on that
// historical claim decision; neither its spent rounds nor its events may change.
const detailRecoveryOldPolicy = JSON.parse(gunzipSync(Buffer.from(
  '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', 'base64')).toString('utf8'))

for (const admission of [undefined, 'unclaimed-round']) {
  for (const version of admission ? [2] : [1, 2]) test(
    `EX-DETAIL-RECOVERY: old accepted v${version}/${admission ?? 'untagged'} recovery history replays byte-for-byte`, () => {
      const dir = fixture()
      const events = detailRecoveryOldPolicy.journal.events.map((event) => {
        const e = structuredClone(event)
        if (version === 1) delete e.version
        if (e.command === 'next' && admission) e.admission = admission
        else delete e.admission
        return e
      })
      writeJournal(dir, events, version)
      const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
      const state = run(dir, 'show')
      assert.deepEqual(state, detailRecoveryOldPolicy.state, 'old claim decisions and all counters stay unchanged')
      assert.equal(state.prs['1'].cycles[0].rounds, 2)
      assert.equal(state.prs['1'].cycles[0].noProgress, 2)
      assert.equal(next(dir).action, 'none', 'no default reset or invented recovery for exhausted history')
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
    })
}
