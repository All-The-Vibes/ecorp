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
  round: claim.round,
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
  // These fixtures model the older save schema, before live attempt fencing.
  if (command === 'save') { const { round, ...legacy } = input; input = legacy }
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
  appendHistorical(dir, 'next', { owner, gateNumber: 1 })
  const ciGate = run(dir, 'show').active
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

const historicalPreactivation = (baseRef = 'release', feedback = true) => {
  const history = oldTargetPublication(baseRef), { dir, claim, receipts, snapshot } = history
  if (feedback) {
    appendHistorical(dir, 'next', { owner, feedbackNumber: 1 })
    appendHistorical(dir, 'feedback', feedbackInput(run(dir, 'show').active))
    appendHistorical(dir, 'next', { owner, gateNumber: 1 })
    run(dir, 'save', saveInput(run(dir, 'show').active))
  } else {
    // Accepted direct NICE, interrupted before enable and before any feedback.
    const events = JSON.parse(journalBytes(dir)).events
    writeJournal(dir, events.slice(0, events.findLastIndex((e) => e.command === 'published') + 1))
    appendHistorical(dir, 'save', saveInput(claim, { technicalVerdict: 'NICE', reviewers: receipts }))
    history.snapshot = claim.publication.snapshot
  }
  return { ...history, acceptanceProof: proof(claim, receipts, feedback ? snapshot : history.snapshot) }
}
const historicalActivation = (baseRef = 'release') => {
  const history = historicalPreactivation(baseRef), { dir, snapshot, acceptanceProof } = history
  appendHistorical(dir, 'enable', { owner, acceptanceProof })
  run(dir, 'sync', { owner, complete: true, prs: [snapshot, pr(2)] })
  return { ...history, acceptanceProof }
}
const journalBytes = (dir) => readFileSync(join(dir, 'state.json'), 'utf8')
const assertHistoryPrefix = (dir, bytes) => {
  const old = JSON.parse(bytes).events, events = JSON.parse(journalBytes(dir)).events
  assert.equal(JSON.stringify(events.slice(0, old.length)), JSON.stringify(old),
    'every original event, input and receipt stays byte-identical')
}

for (const feedback of [true, false]) {
  test(`EX-PREACTIVATION-CANARY-RECOVERY: accepted prefix STOP before enable, old feedback=${feedback}`, (t) => {
    const { dir, snapshot, acceptanceProof } = historicalPreactivation('release', feedback)
    const old = run(dir, 'show'), prefix = journalBytes(dir), p = old.prs['1']
    t.diagnostic(`SA11-01 synthetic accepted prefix STOP before enable: ${join(dir, 'state.json')}`)
    assert.equal(old.enabled, false)
    assert.equal(old.active, null)
    assert.equal(p.blockedClaim ?? null, null)
    assert.equal(p.cycles[0].technicalVerdict, 'NICE')
    assert.deepEqual([p.cycles[0].rounds, p.cycles[0].noProgress, old.wakes.at(-1).chargedRounds], [1, 1, 0])
    run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
    assert.equal(journalBytes(dir), prefix, 'identical remote input is a no-op')
    run(dir, 'wake', wakeInput('preactivation-fresh-wake'))
    const beforeAdmission = journalBytes(dir)
    const claim = next(dir)
    assert.equal(claim.action, 'audit', 'retained conflicting publication is pending before first activation')
    assert.equal(claim.number, 1)
    assert.deepEqual(claim.snapshot, snapshot)
    assert.equal(claim.round, null)
    assert.deepEqual(run(dir, 'show').prs['1'].cycles, p.cycles)
    assert.equal(next(dir).claimId, claim.claimId)
    const admitted = journalBytes(dir)
    for (const input of [{ owner, feedbackNumber: 1 }, { owner, gateNumber: 2 }]) run(dir, 'next', input, false)
    run(dir, 'enable', { owner, acceptanceProof }, false)
    assert.equal(journalBytes(dir), admitted)
    assert.equal(run(dir, 'next', { owner, gateNumber: 1 }).action, 'audit')
    const charged = run(dir, 'begin', beginInput(claim))
    assert.equal(charged.round, 2)
    const state = run(dir, 'show')
    assert.equal(state.prs['1'].cycles.length, 1)
    assert.equal(state.prs['1'].cycles[0].noProgress, 2)
    assert.equal(state.wakes.at(-1).chargedRounds, 1)
    assert.deepEqual(state.wakes.slice(0, -1), old.wakes)
    assert.deepEqual(state.prs['1'].publications, p.publications)
    assert.deepEqual(state.prs['1'].feedbackReviews, p.feedbackReviews)
    assertHistoryPrefix(dir, beforeAdmission)
  })
}

test('EX-PREACTIVATION-CANARY-RECOVERY: gates cannot consume correction and fresh NICE needs a new publication and full proof', () => {
  const { dir, snapshot, acceptanceProof } = historicalPreactivation()
  const old = run(dir, 'show'), prefix = journalBytes(dir)
  for (const gateKey of [snapshot.gateKey, key(900)]) {
    run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, gateKey }, pr(2)] })
    const bytes = journalBytes(dir)
    assert.match(run(dir, 'next', { owner, gateNumber: 1 }, false).error, /pending audit/)
    run(dir, 'next', { owner, feedbackNumber: 1 }, false)
    run(dir, 'enable', { owner, acceptanceProof }, false)
    run(dir, 'next', { owner, publicationRecovery: true }, false)
    assert.equal(journalBytes(dir), bytes)
  }
  const claimedPrefix = JSON.parse(journalBytes(dir)).events
  const unpublished = fixture()
  writeJournal(unpublished, claimedPrefix)
  const audit = start(unpublished)
  run(unpublished, 'save', saveInput(audit, { technicalVerdict: 'NICE', reviewers: reviewers(audit) }))
  const nice = run(unpublished, 'show'), bytes = journalBytes(unpublished)
  assert.match(run(unpublished, 'enable', { owner, acceptanceProof: proof(audit, nice.prs['1'].cycles[0].completion.reviewers) }, false).error,
    /publication.*source\/target/)
  assert.equal(next(unpublished).action, 'none', 'NICE does not authorize another free correction')
  assert.equal(journalBytes(unpublished), bytes)
  assert.equal(nice.enabled, false)

  const corrected = publishComplete(dir)
  assert.equal(corrected.claim.round, 2)
  assert.equal(next(dir).action, 'none', 'PR2 still lacks activation authority')
  const good = proof(corrected.claim, corrected.receipts)
  for (const change of [
    { reviewers: acceptanceProof.reviewers }, { push: acceptanceProof.push },
    { ci: acceptanceProof.ci }, { copilot: acceptanceProof.copilot },
    { schedulerWake: { ...good.schedulerWake, at: '2000-01-01T00:00:00.000Z' } },
    { fixers: [] }, { audits: {} }, { quietNoopRef: '' }, { resumeRef: '' },
  ]) {
    const bytes = journalBytes(dir)
    run(dir, 'enable', { owner, acceptanceProof: { ...good, ...change } }, false)
    assert.equal(journalBytes(dir), bytes)
  }
  run(dir, 'enable', { owner, acceptanceProof: good })
  const state = run(dir, 'show')
  assert.equal(state.activation.valid, true)
  assert.equal(state.activations.length, 1)
  assert.equal(state.prs['1'].cycles.length, 1)
  assert.equal(state.prs['1'].cycles[0].noProgress, 2)
  assert.equal(state.wakes.at(-1).chargedRounds, old.wakes.at(-1).chargedRounds + 1)
  assert.deepEqual(state.prs['1'].publications[0], old.prs['1'].publications[0])
  assertHistoryPrefix(dir, prefix)
  const accepted = journalBytes(dir)
  run(dir, 'enable', { owner, acceptanceProof: good })
  assert.equal(journalBytes(dir), accepted)
  assert.equal(next(dir).number, 2)
})

for (const stage of ['uncharged', 'charged', 'published']) {
  test(`EX-PREACTIVATION-CANARY-RECOVERY: retained ${stage} correction survives gate changes and resumes once`, () => {
    const history = historicalPreactivation(), { dir } = history
    let snapshot = history.snapshot, claim = stage === 'uncharged' ? next(dir) : start(dir)
    if (stage === 'published') {
      snapshot = { ...snapshot, head: sha(13) }
      bindRubric(dir, snapshot)
      claim = run(dir, 'published', { ...beginInput(claim), snapshot, reviewers: reviewers({ ...claim, head: snapshot.head }),
        push: { repo, branch: snapshot.branch, before: claim.head, head: snapshot.head,
          sourceRef: 'corrective-publication.json', pushedAt: new Date().toISOString() } })
    }
    const before = run(dir, 'show')
    assert.ok(before.prs['1'].correctiveAudit.publicationKey)
    for (let n = 1; n <= 2; n++) {
      run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, gateKey: key(910 + n) }] })
      assert.equal(next(dir).claimId, claim.claimId, 'active work survives gates')
      run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
      run(dir, 'wake', wakeInput(`preactivation-interrupted-${n}`))
      const bytes = journalBytes(dir), blocked = run(dir, 'show')
      assert.equal(next(dir).claimId, claim.claimId, 'gate changes must not replace blocked correction')
      assert.equal(next(dir).action, 'blocked')
      run(dir, 'next', { owner, gateNumber: 1 }, false)
      run(dir, 'begin', beginInput(claim), false)
      assert.equal(journalBytes(dir), bytes)
      const resumed = run(dir, 'resume', resumeInput(claim))
      for (const field of ['claimId', 'round', 'startedAt', 'snapshot']) assert.deepEqual(resumed[field], claim[field])
      assert.deepEqual(run(dir, 'show').prs['1'].correctiveAudit, blocked.prs['1'].correctiveAudit)
    }
    const state = run(dir, 'show')
    assert.equal(state.sequence, before.sequence)
    assert.equal(state.prs['1'].cycles[0].rounds, before.prs['1'].cycles[0].rounds)
    assert.equal(state.prs['1'].cycles[0].noProgress, before.prs['1'].cycles[0].noProgress)
    assert.ok(state.wakes.slice(before.wakes.length).every((w) => w.chargedRounds === 0))
    if (stage !== 'uncharged') run(dir, 'begin', beginInput(claim), false)
    else assert.equal(run(dir, 'begin', beginInput(claim)).round, 2)
  })
}

test('EX-PREACTIVATION-CANARY-RECOVERY: retry retains the original claim, spends actual wake capacity and never refunds', () => {
  const { dir, snapshot } = historicalPreactivation()
  let claim = start(dir), findings = []
  for (let n = 1; n <= 3; n++) {
    findings = progressFailure(dir, claim, findings)
    run(dir, 'save', saveInput(claim, { phase: 'blocked', findings }))
    run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, gateKey: key(920 + n) }] })
    if (n === 3) {
      const bytes = journalBytes(dir)
      assert.equal(next(dir).action, 'wait')
      assert.equal(journalBytes(dir), bytes)
    } else assert.equal(next(dir).claimId, claim.claimId)
    assert.equal(run(dir, 'resume', resumeInput(claim)).claimId, claim.claimId)
    run(dir, 'save', saveInput(claim, { phase: 'fixing', findings }), false)
    if (n === 3) {
      const before = run(dir, 'show'), bytes = journalBytes(dir)
      assert.match(run(dir, 'retry', retryInput(claim), false).error, /wake round capacity/)
      assert.equal(journalBytes(dir), bytes)
      run(dir, 'wake', wakeInput('preactivation-next-capacity'))
      assert.deepEqual(run(dir, 'show').wakes.slice(0, -1), before.wakes)
    }
    const retried = run(dir, 'retry', retryInput(claim))
    assert.equal(retried.claimId, claim.claimId)
    assert.equal(retried.round, claim.round + 1)
    run(dir, 'retry', retryInput(claim), false)
    claim = retried
  }
  const state = run(dir, 'show')
  assert.equal(state.prs['1'].cycles.length, 1)
  assert.equal(claim.round, 5)
  assert.deepEqual(state.wakes.map((w) => w.chargedRounds), [3, 1])
})

test('EX-PREACTIVATION-CANARY-RECOVERY: no-progress stop survives new wakes and historical NICE cannot renew a cycle', () => {
  const { dir, snapshot } = historicalPreactivation()
  const claim = start(dir)
  failedReview(dir, claim)
  run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
  const before = run(dir, 'show')
  run(dir, 'wake', wakeInput('preactivation-no-reset'))
  const bytes = journalBytes(dir)
  assert.equal(next(dir).action, 'none')
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  run(dir, 'resume', resumeInput(claim), false)
  assert.equal(journalBytes(dir), bytes)
  assert.deepEqual(run(dir, 'show').prs['1'], before.prs['1'])
  assert.equal(before.prs['1'].cycles[0].noProgress, 2)

  const history = historicalPreactivation(), old = run(history.dir, 'show')
  run(history.dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, head: sha(88) }] })
  appendHistorical(history.dir, 'next', { owner })
  const retained = run(history.dir, 'show').active
  const prefix = journalBytes(history.dir)
  for (const blocked of [false, true]) {
    const isolated = fixture()
    writeJournal(isolated, JSON.parse(prefix).events)
    if (blocked) {
      run(isolated, 'save', saveInput(retained, { phase: 'blocked' }))
      assert.equal(next(isolated).claimId, retained.claimId, 'retain even an old unmarked correction')
      run(isolated, 'resume', resumeInput(retained))
    }
    const started = run(isolated, 'begin', beginInput(retained)), state = run(isolated, 'show')
    assert.equal(started.round, 2)
    assert.equal(state.prs['1'].cycles.length, 1)
    assert.equal(state.prs['1'].cycles[0].noProgress, old.prs['1'].cycles[0].noProgress + 1)
    assertHistoryPrefix(isolated, prefix)
  }
  // The same accepted old begin really DID renew: historical decisions stay readable.
  appendHistorical(history.dir, 'begin', beginInput(retained))
  const accepted = journalBytes(history.dir)
  assert.deepEqual(run(history.dir, 'show').prs['1'].cycles.map((c) => c.rounds), [1, 1])
  assert.equal(journalBytes(history.dir), accepted)
})

test('EX-PREACTIVATION-CANARY-RECOVERY: ongoing authority and native capacity are required, not another approval', () => {
  const { dir, snapshot } = historicalPreactivation()
  const original = JSON.parse(journalBytes(dir)).events
  for (const authority of [false, true]) {
    const isolated = fixture()
    writeJournal(isolated, original.filter((e) => e.command !== 'wake' && (authority || e.command !== 'autonomy')))
    for (const gateKey of [snapshot.gateKey, key(930)]) {
      run(isolated, 'sync', { owner, complete: true, prs: [{ ...snapshot, gateKey }] })
      const bytes = journalBytes(isolated)
      assert.equal(next(isolated).action, authority ? 'wait' : 'none')
      run(isolated, 'next', { owner, gateNumber: 1 }, false)
      assert.equal(journalBytes(isolated), bytes)
    }
    if (!authority) run(isolated, 'autonomy', autonomyInput())
    run(isolated, 'wake', wakeInput('preactivation-first-capacity'))
    assert.equal(start(isolated).round, 2)
  }
})

test('EX-PREACTIVATION-CANARY-RECOVERY: current eligibility, stale scope and same-head target rollback stay fenced', () => {
  const { dir, snapshot, acceptanceProof } = historicalPreactivation()
  const prefix = journalBytes(dir)
  for (const change of [{ sourceRepo: 'fork/ecorp' }, { sourceRepo: null }, { state: 'closed' }, { readError: 'DETAIL_READ_FAILED' }]) {
    const isolated = fixture()
    writeJournal(isolated, JSON.parse(prefix).events)
    run(isolated, 'sync', { owner, complete: true, prs: [{ ...snapshot, ...change }, pr(2)] })
    const selected = next(isolated)
    assert.notEqual(selected.action, 'audit')
    assert.notEqual(selected.number, 2)
    assert.equal(run(isolated, 'show').wakes.at(-1).chargedRounds, 0)
  }
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, baseRef: 'main' }] })
  run(dir, 'enable', { owner, acceptanceProof }, false)
  run(dir, 'next', { owner, feedbackNumber: 1 }, false)
  const claim = next(dir)
  assert.equal(claim.action, 'audit', 'rollback cannot launder the conflicting publication')
  const claimed = journalBytes(dir)
  for (const change of [
    { sourceRepo: 'fork/ecorp' }, { sourceRepo: null }, { state: 'closed' }, { readError: 'DETAIL_READ_FAILED' },
    { base: sha(88) }, { head: sha(88) }, { branch: 'different-source' }, { baseRef: 'release' }, { reviewKey: key(88) },
  ]) {
    const isolated = fixture()
    writeJournal(isolated, JSON.parse(claimed).events)
    run(isolated, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, ...change }] })
    assert.equal(next(isolated).action, 'reconcile')
    const bytes = journalBytes(isolated)
    run(isolated, 'begin', beginInput(claim), false)
    assert.equal(journalBytes(isolated), bytes)
    run(isolated, 'save', saveInput(claim, { phase: 'blocked' }))
    run(isolated, 'resume', resumeInput(claim), false)
  }
})

test('EX-PREACTIVATION-CANARY-RECOVERY: healthy bootstrap needs no corrective claim or extra charge', () => {
  const { dir, snapshot, acceptanceProof } = historicalPreactivation('main')
  const before = run(dir, 'show'), prefix = journalBytes(dir)
  run(dir, 'wake', wakeInput('healthy-bootstrap'))
  run(dir, 'sync', { owner, complete: true, prs: [snapshot, pr(2)] })
  assert.equal(next(dir).action, 'none')
  const gate = run(dir, 'next', { owner, gateNumber: 1 })
  assert.equal(gate.action, 'check')
  run(dir, 'begin', beginInput(gate), false)
  run(dir, 'save', saveInput(gate))
  run(dir, 'enable', { owner, acceptanceProof })
  const after = run(dir, 'show')
  assert.equal(after.activation.valid, true)
  assert.equal(after.prs['1'].correctiveAudit, undefined)
  assert.deepEqual(after.prs['1'].cycles[0].completion, before.prs['1'].cycles[0].completion)
  assert.equal(after.prs['1'].cycles[0].rounds, 1)
  assert.equal(after.prs['1'].cycles[0].noProgress, 1)
  assert.ok(after.wakes.every((w) => w.chargedRounds === 0))
  assert.equal(next(dir).number, 2)
  assertHistoryPrefix(dir, prefix)
})

test('EX-PREACTIVATION-CANARY-RECOVERY: old admitted gate remains read-only and cannot discharge pending correction', () => {
  const { dir } = historicalPreactivation()
  appendHistorical(dir, 'next', { owner, gateNumber: 1 })
  const before = run(dir, 'show'), gate = before.active, bytes = journalBytes(dir)
  assert.equal(gate.action, 'check')
  assert.equal(next(dir).claimId, gate.claimId)
  run(dir, 'begin', beginInput(gate), false)
  assert.equal(journalBytes(dir), bytes)
  run(dir, 'save', saveInput(gate))
  const claim = next(dir), state = run(dir, 'show')
  assert.equal(claim.action, 'audit')
  assert.equal(claim.round, null)
  assert.deepEqual(state.prs['1'].cycles[0].completion, before.prs['1'].cycles[0].completion)
  assert.equal(state.prs['1'].cycles[0].rounds, before.prs['1'].cycles[0].rounds)
  assert.deepEqual(state.wakes, before.wakes)
  assertHistoryPrefix(dir, bytes)
})

test('EX-PREACTIVATION-CANARY-RECOVERY: exhausted historical NICE cannot fund changed-head begin or resume', () => {
  const { dir, snapshot } = historicalPreactivation()
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, reviewKey: key(3) }] })
  appendHistorical(dir, 'next', { owner })
  let claim = run(dir, 'show').active
  appendHistorical(dir, 'begin', beginInput(claim))
  claim = run(dir, 'show').active
  appendHistorical(dir, 'save', saveInput(claim, { technicalVerdict: 'NICE', reviewers: reviewers(claim) }))
  assert.equal(run(dir, 'show').prs['1'].cycles[0].noProgress, 2)
  run(dir, 'wake', wakeInput('historical-nice-is-not-progress'))
  const stopped = journalBytes(dir)
  assert.equal(next(dir).action, 'none')
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  assert.equal(journalBytes(dir), stopped)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, head: sha(88) }] })
  appendHistorical(dir, 'next', { owner })
  claim = run(dir, 'show').active
  const prefix = journalBytes(dir)
  for (const blocked of [false, true]) {
    const isolated = fixture()
    writeJournal(isolated, JSON.parse(prefix).events)
    if (blocked) run(isolated, 'save', saveInput(claim, { phase: 'blocked' }))
    const before = run(isolated, 'show'), bytes = journalBytes(isolated)
    assert.match(run(isolated, blocked ? 'resume' : 'begin', blocked ? resumeInput(claim) : beginInput(claim), false).error,
      /no-progress limit exhausted/)
    assert.equal(journalBytes(isolated), bytes)
    assert.deepEqual(run(isolated, 'show'), before)
    assert.equal(before.prs['1'].cycles.length, 1)
    assert.equal(before.prs['1'].cycles[0].rounds, 2)
  }
})

for (const baseRef of ['release', 'main']) {
  test(`EX-HISTORICAL-ACTIVATION-FENCE: ${baseRef} historical enable has explicit current validity and fences fresh PR2`, () => {
    const { dir, acceptanceProof } = historicalActivation(baseRef)
    const bytes = journalBytes(dir), before = run(dir, 'show'), valid = baseRef === 'main'
    const selected = next(dir)
    assert.equal(selected.action, 'audit')
    assert.equal(selected.number, valid ? 2 : 1, 'invalid activation admits only its corrective canary')
    assert.equal(before.enabled, true, 'the historical outcome remains true')
    assert.deepEqual(before.acceptanceProof, acceptanceProof)
    assert.equal(before.activation.valid, valid)
    if (!valid) {
      assert.match(before.activation.reason, /publication.*source\/target/)
      run(dir, 'wake', wakeInput('different-native-wake'))
      const afterWake = journalBytes(dir)
      assert.equal(next(dir).claimId, selected.claimId)
      for (const input of [{ owner, gateNumber: 2 }, { owner, feedbackNumber: 2 }]) {
        run(dir, 'next', input, false)
        assert.equal(journalBytes(dir), afterWake)
      }
      assert.deepEqual(run(dir, 'show').activation, before.activation, 'wake cannot renew activation')
      assert.equal(run(dir, 'show').wakes.at(-1).chargedRounds, 0)
    } else {
      const charged = run(dir, 'begin', { owner, number: 2, claimId: selected.claimId,
        base: selected.base, head: selected.head })
      assert.equal(charged.round, 1, 'valid same-target activation still admits and charges PR2')
    }
    assertHistoryPrefix(dir, bytes)
  })
}

for (const phase of ['uncharged', 'auditing', 'reviewing']) {
  test(`EX-HISTORICAL-ACTIVATION-FENCE: retained PR2 ${phase} cannot advance but can retain a block`, () => {
    const { dir } = historicalActivation()
    appendHistorical(dir, 'next', { owner })
    let claim = run(dir, 'show').active
    const identity = { owner, number: 2, claimId: claim.claimId, base: claim.base, head: claim.head }
    bindRubric(dir, claim)
    if (phase !== 'uncharged') {
      appendHistorical(dir, 'begin', identity)
      claim = run(dir, 'show').active
    }
    const findings = [{ id: 'retained-finding', status: 'open', evidence: ['old-failure.json'] }]
    if (phase === 'reviewing') {
      appendHistorical(dir, 'save', saveInput(claim, {
        phase, findings, technicalVerdict: 'NAUGHTY', evidence: ['old-review.json'],
      }))
    }
    const before = run(dir, 'show'), bytes = journalBytes(dir), retained = before.prs['2'].cycles[0].findings
    const continued = next(dir)
    assert.equal(continued.action, 'reconcile', 'next must not tell the driver to continue invalid authority')
    assert.match(continued.reason, /activation.*publication.*source\/target/)
    assert.equal(continued.claimId, claim.claimId)
    const candidate = { ...claim.snapshot, head: sha(13) }
    bindRubric(dir, candidate)
    const afterBinding = journalBytes(dir)
    for (const [command, input] of [
      ['begin', identity],
      ['retry', { ...identity, round: claim.round, reviewRef: 'old-review.json' }],
      ['save', saveInput(claim, { phase: 'fixing', findings: retained })],
      ['save', saveInput(claim, { phase: 'waiting', findings: retained })],
      ['save', saveInput(claim, { phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(claim) })],
      ['save', saveInput(claim, { phase: 'blocked',
        findings: retained.map((f) => ({ ...f, status: 'fixed', evidence: [...f.evidence, 'laundered-green.json'] })),
        technicalVerdict: 'NICE' })],
      ['published', { ...identity, snapshot: candidate, reviewers: reviewers({ ...claim, head: candidate.head }),
        push: { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
          sourceRef: 'new-push.json', pushedAt: new Date().toISOString() } }],
    ]) {
      assert.match(run(dir, command, input, false).error, /activation.*publication.*source\/target/)
      assert.equal(journalBytes(dir), afterBinding, `${command} cannot append or spend under invalid activation`)
    }
    if (phase === 'reviewing') {
      run(dir, 'save', saveInput(claim, { phase: 'blocked',
        findings: retained.map((f) => ({ ...f, status: 'fixed', evidence: [...f.evidence, 'laundered-green.json'] })) }), false)
      assert.equal(journalBytes(dir), afterBinding, 'a blocked save cannot credit new progress')
    }
    run(dir, 'save', saveInput(claim, { phase: 'blocked', findings: retained, reason: 'Preserve invalid activation work' }))
    const blocked = run(dir, 'show'), blockedBytes = journalBytes(dir)
    assert.equal(blocked.active, null)
    assert.equal(blocked.prs['2'].blockedClaim.claim.claimId, claim.claimId)
    assert.equal(blocked.prs['2'].cycles[0].rounds, before.prs['2'].cycles[0].rounds)
    assert.equal(blocked.prs['2'].cycles[0].noProgress, before.prs['2'].cycles[0].noProgress)
    assert.deepEqual(blocked.wakes, before.wakes)
    assert.match(run(dir, 'resume', { ...identity, round: claim.round,
      clearance: { sourceRef: 'actual-clearance.json', verifiedAt: new Date().toISOString() } }, false).error,
    /activation.*publication.*source\/target/)
    assert.equal(journalBytes(dir), blockedBytes)
    assertHistoryPrefix(dir, bytes)
  })
}

test('EX-HISTORICAL-ACTIVATION-FENCE: retained PR2 gates and feedback cannot launder activation', () => {
  const { dir, snapshot } = historicalActivation()
  appendHistorical(dir, 'next', { owner })
  let claim = run(dir, 'show').active
  appendHistorical(dir, 'begin', { owner, number: 2, claimId: claim.claimId, base: claim.base, head: claim.head })
  claim = run(dir, 'show').active
  const candidate = { ...claim.snapshot, head: sha(13) }
  bindRubric(dir, candidate)
  const receipts = reviewers({ ...claim, head: candidate.head })
  appendHistorical(dir, 'published', { owner, number: 2, claimId: claim.claimId,
    base: claim.base, head: claim.head, snapshot: candidate, reviewers: receipts,
    push: { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
      sourceRef: 'old-pr2-push.json', pushedAt: new Date().toISOString() } })
  claim = run(dir, 'show').active
  assert.match(run(dir, 'published', claim.publication, false).error, /activation/,
    'even exact publication ACK cannot tell the driver invalid work may continue')
  appendHistorical(dir, 'save', saveInput(claim, { technicalVerdict: 'NICE', reviewers: receipts }))
  const bytes = journalBytes(dir)
  assert.match(run(dir, 'next', { owner, gateNumber: 2 }, false).error, /activation/)
  assert.equal(journalBytes(dir), bytes)
  appendHistorical(dir, 'next', { owner, gateNumber: 2 })
  const gate = run(dir, 'show').active
  assert.equal(next(dir).action, 'reconcile')
  run(dir, 'save', saveInput(gate), false)
  run(dir, 'save', saveInput(gate, { phase: 'blocked' }))
  run(dir, 'sync', { owner, complete: true, prs: [snapshot, { ...candidate, reviewKey: key(2) }] })
  run(dir, 'next', { owner, feedbackNumber: 2 }, false)
  appendHistorical(dir, 'next', { owner, feedbackNumber: 2 })
  const feedback = run(dir, 'show').active, pending = journalBytes(dir)
  assert.equal(next(dir).action, 'reconcile')
  for (const disposition of ['NO_ACTIONABLE_FINDINGS', 'ACTIONABLE_FINDINGS']) {
    assert.match(run(dir, 'feedback', feedbackInput(feedback, { disposition }), false).error, /activation/)
    assert.equal(journalBytes(dir), pending)
  }
  run(dir, 'feedback', feedbackInput(feedback, { disposition: 'BLOCKED' }))
  assert.equal(run(dir, 'show').active, null)
  assert.equal(run(dir, 'show').activation.valid, false)
  assertHistoryPrefix(dir, bytes)
})

test('EX-UNCHANGED-CANARY-RECOVERY: correction needs genuinely new full acceptance and retains invalid proof', () => {
  const { dir, snapshot, acceptanceProof } = historicalActivation()
  const old = run(dir, 'show'), bytes = journalBytes(dir)
  // Identical remote input: the invalid activation itself is the pending work.
  run(dir, 'sync', { owner, complete: true, prs: [snapshot, pr(2)] })
  assert.equal(journalBytes(dir), bytes)
  assert.equal(next(dir).action, 'audit')
  const corrected = publishComplete(dir)
  assert.equal(corrected.claim.number, 1)
  assert.equal(corrected.claim.round, 2)
  const admission = JSON.parse(journalBytes(dir)).events.find((e) => e.id === corrected.claim.claimId)
  assert.equal(admission.activationFence, true, 'new canary-only selection is pinned for exact replay')
  assert.equal(admission.canaryRecovery, true)
  let state = run(dir, 'show')
  assert.equal(state.activation.valid, false, 'a later clean publication cannot silently replace the old activation basis')
  assert.deepEqual(state.acceptanceProof, acceptanceProof)
  assert.equal(next(dir).action, 'none', 'broad intake still needs full acceptance')
  const quiet = journalBytes(dir)
  assert.equal(next(dir).action, 'none', 'NICE cannot trigger another free audit before enable')
  assert.equal(journalBytes(dir), quiet)
  run(dir, 'next', { owner, activationFence: false }, false)
  const good = proof(corrected.claim, corrected.receipts)
  for (const change of [
    { reviewers: acceptanceProof.reviewers }, { push: acceptanceProof.push },
    { ci: acceptanceProof.ci }, { copilot: acceptanceProof.copilot },
    { schedulerWake: { ...good.schedulerWake, at: '2000-01-01T00:00:00.000Z' } },
    { fixers: [] }, { audits: {} }, { quietNoopRef: '' }, { resumeRef: '' },
  ]) run(dir, 'enable', { owner, acceptanceProof: { ...good, ...change } }, false)
  run(dir, 'enable', { owner, acceptanceProof: good })
  state = run(dir, 'show')
  assert.equal(state.activation.valid, true)
  assert.deepEqual(state.acceptanceProof, good)
  assert.equal(state.activations.length, 2)
  assert.equal(state.activations[0].valid, false)
  assert.deepEqual(state.activations[0].acceptanceProof, acceptanceProof)
  assert.deepEqual(state.activations[1].acceptanceProof, good)
  assert.deepEqual(state.autonomy, old.autonomy)
  assert.equal(state.prs['1'].cycles.length, 1)
  assert.equal(state.prs['1'].cycles[0].rounds, 2)
  assert.equal(state.prs['1'].cycles[0].noProgress, old.prs['1'].cycles[0].noProgress + 1,
    'new NICE alone is not verified finding progress')
  assert.equal(state.wakes[0].chargedRounds, old.wakes[0].chargedRounds + 1)
  assertHistoryPrefix(dir, bytes)
  const accepted = journalBytes(dir)
  run(dir, 'enable', { owner, acceptanceProof: good })
  assert.equal(journalBytes(dir), accepted, 'replacement acceptance exact ACK is still idempotent')
  run(dir, 'enable', { owner, acceptanceProof: { ...good, resumeRef: 'different.json' } }, false)
  const other = next(dir)
  assert.equal(other.number, 2)
  assert.equal(run(dir, 'begin', { owner, number: 2, claimId: other.claimId, base: other.base, head: other.head }).round, 1)
})

test('EX-UNCHANGED-CANARY-RECOVERY: consumed signature is pending audit, never an explicit gate or old approval', () => {
  const { dir, snapshot, acceptanceProof } = historicalActivation('release')
  const old = run(dir, 'show'), bytes = journalBytes(dir), c = old.prs['1'].cycles[0]
  assert.equal(old.activation.valid, false)
  assert.equal(old.active, null)
  assert.equal(old.prs['1'].blockedClaim, null)
  assert.equal(c.rounds, 1)
  assert.equal(c.noProgress, 1)
  assert.ok(old.wakes.at(-1).chargedRounds < 3)
  assert.match(run(dir, 'next', { owner, gateNumber: 1 }, false).error, /pending audit/)
  run(dir, 'next', { owner, feedbackNumber: 1 }, false)
  run(dir, 'enable', { owner, acceptanceProof }, false)
  run(dir, 'next', { owner: 'other' }, false)
  run(dir, 'next', { owner, canaryRecovery: true }, false)
  assert.equal(journalBytes(dir), bytes)
  run(dir, 'wake', wakeInput('unchanged-recovery'))
  run(dir, 'sync', { owner, complete: true, prs: [snapshot, pr(2)] })
  const claim = next(dir), admitted = run(dir, 'show')
  assert.equal(claim.action, 'audit', 'unchanged invalid activation must be independently re-audited')
  assert.equal(claim.number, 1)
  assert.deepEqual(claim.snapshot, snapshot, 'current target is used, not the conflicting old main claim')
  assert.equal(claim.round, null)
  assert.deepEqual(admitted.prs['1'].cycles, old.prs['1'].cycles)
  assert.deepEqual(admitted.prs['1'].publications, old.prs['1'].publications)
  assert.deepEqual(admitted.autonomy, old.autonomy)
  assert.equal(admitted.wakes.at(-1).chargedRounds, 0)
  const started = run(dir, 'begin', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head })
  run(dir, 'save', saveInput(started, { technicalVerdict: 'NICE', reviewers: acceptanceProof.reviewers }), false)
  const charged = run(dir, 'show')
  assert.equal(started.round, 2)
  assert.equal(charged.prs['1'].cycles[0].noProgress, 2)
  assert.equal(charged.wakes.at(-1).chargedRounds, 1)
  assert.deepEqual(charged.wakes.slice(0, -1), old.wakes)
  assertHistoryPrefix(dir, bytes)
})

for (const charged of [false, true]) {
  test(`EX-UNCHANGED-CANARY-RECOVERY: ${charged ? 'charged' : 'preparation'} interruption resumes exactly without duplicate admission`, () => {
    const { dir } = historicalActivation()
    let claim = next(dir)
    assert.equal(claim.action, 'audit')
    if (charged) claim = start(dir)
    const before = run(dir, 'show'), bytes = journalBytes(dir)
    for (let n = 0; n < 2; n++) {
      assert.equal(next(dir).claimId, claim.claimId)
      assert.equal(run(dir, 'next', { owner, gateNumber: 1 }).action, 'audit', 'explicit gate cannot steal active audit')
    }
    assert.equal(journalBytes(dir), bytes)
    for (let n = 0; n < 2; n++) {
      run(dir, 'save', saveInput(claim, { phase: 'blocked', reason: 'Interrupted local preparation/tooling' }))
      const blocked = journalBytes(dir)
      assert.equal(next(dir).action, 'none', 'retained work needs resume, not a replacement free audit')
      assert.match(run(dir, 'next', { owner, gateNumber: 1 }, false).error, /pending audit/)
      assert.equal(journalBytes(dir), blocked)
      run(dir, 'wake', wakeInput(`interruption-${n}`))
      assert.equal(next(dir).action, 'none')
      const resumed = run(dir, 'resume', resumeInput(claim))
      assert.equal(resumed.claimId, claim.claimId)
      assert.equal(resumed.round, claim.round)
      assert.equal(resumed.startedAt, claim.startedAt)
    }
    const after = run(dir, 'show')
    assert.equal(after.sequence, before.sequence)
    assert.equal(after.prs['1'].cycles[0].rounds, before.prs['1'].cycles[0].rounds)
    assert.equal(after.prs['1'].cycles[0].noProgress, before.prs['1'].cycles[0].noProgress)
    assert.deepEqual(after.wakes.slice(0, before.wakes.length), before.wakes)
    assert.ok(after.wakes.slice(before.wakes.length).every((w) => w.chargedRounds === 0))
    assertHistoryPrefix(dir, bytes)
  })
}

test('EX-UNCHANGED-CANARY-RECOVERY: correction cannot reopen an exhausted no-progress stop on a new wake', () => {
  const { dir } = historicalActivation()
  assert.equal(next(dir).action, 'audit')
  const claim = start(dir)
  failedReview(dir, claim)
  run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
  const before = run(dir, 'show'), bytes = journalBytes(dir)
  run(dir, 'wake', wakeInput('not-a-progress-reset'))
  const stopped = journalBytes(dir)
  assert.equal(next(dir).action, 'none')
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  run(dir, 'resume', resumeInput(claim), false)
  run(dir, 'retry', retryInput(claim), false)
  assert.equal(journalBytes(dir), stopped)
  const after = run(dir, 'show')
  assert.deepEqual(after.prs['1'], before.prs['1'])
  assert.equal(after.prs['1'].cycles[0].noProgress, 2)
  assert.equal(after.wakes.at(-1).chargedRounds, 0)
  assertHistoryPrefix(dir, bytes)
})

test('EX-UNCHANGED-CANARY-RECOVERY: current eligibility and stale source/template/target fences survive admission', () => {
  const { dir, snapshot } = historicalActivation()
  const prefix = JSON.parse(journalBytes(dir)).events
  for (const change of [
    { sourceRepo: 'foreign/ecorp' }, { sourceRepo: null }, { state: 'closed' },
    { readError: 'DETAIL_READ_FAILED' },
  ]) {
    const guarded = fixture()
    writeJournal(guarded, prefix)
    run(guarded, 'sync', { owner, complete: true, prs: [{ ...snapshot, ...change }, pr(2)] })
    const selected = next(guarded)
    assert.notEqual(selected.action, 'audit')
    assert.notEqual(selected.number, 2)
    assert.equal(run(guarded, 'show').wakes.at(-1).chargedRounds, 0)
    assertHistoryPrefix(guarded, JSON.stringify({ events: prefix }))
  }
  const claim = next(dir)
  assert.equal(claim.action, 'audit')
  const claimed = JSON.parse(journalBytes(dir)).events
  for (const change of [
    { sourceRepo: 'foreign/ecorp' }, { sourceRepo: null }, { state: 'closed' },
    { readError: 'DETAIL_READ_FAILED' }, { baseRef: 'main' }, { branch: 'other' },
    { base: sha(88) }, { head: sha(88) }, { reviewKey: key(88) },
  ]) {
    const stale = fixture()
    writeJournal(stale, claimed)
    run(stale, 'sync', { owner, complete: true, prs: [{ ...snapshot, ...change }, pr(2)] })
    assert.equal(next(stale).action, 'reconcile')
    const bytes = journalBytes(stale)
    run(stale, 'begin', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head }, false)
    run(stale, 'save', saveInput(claim, { technicalVerdict: 'NICE', reviewers: reviewers(claim) }), false)
    assert.equal(journalBytes(stale), bytes)
    run(stale, 'save', saveInput(claim, { phase: 'blocked' }))
    run(stale, 'resume', resumeInput(claim), false)
  }
})

test('EX-UNCHANGED-CANARY-RECOVERY: historical marked gate and unmarked audit decisions replay exactly', () => {
  const { dir } = historicalActivation()
  const events = JSON.parse(journalBytes(dir)).events
  const gateId = 'old-fenced-gate'
  events.push({ version: 2, id: gateId, at: new Date().toISOString(), command: 'next',
    input: { owner, gateNumber: 1 }, admission: 'detail-read-recovery', activationFence: true })
  writeJournal(dir, events)
  const gate = run(dir, 'show').active
  assert.equal(gate.action, 'check', 'old activationFence alone cannot acquire new admission semantics')
  assert.equal(gate.claimId, gateId)
  appendHistorical(dir, 'save', saveInput(gate, { phase: 'blocked' }))
  appendHistorical(dir, 'next', { owner })
  const bytes = journalBytes(dir), before = run(dir, 'show')
  assert.equal(before.active.number, 2, 'old unmarked selection is still its original PR2 audit')
  assert.equal(before.active.action, 'audit')
  assert.equal(next(dir).action, 'reconcile')
  assert.deepEqual(run(dir, 'show'), before)
  assert.equal(journalBytes(dir), bytes)
})

test('EX-UNCHANGED-CANARY-RECOVERY: admission needs ongoing authority and actual wake capacity', () => {
  const { dir, snapshot } = historicalActivation()
  const original = JSON.parse(journalBytes(dir)).events
  for (const authority of [false, true]) {
    const missing = fixture()
    // Synthetic historical variant with no native wake, optionally no autonomy.
    writeJournal(missing, original.filter((e) => e.command !== 'wake' && (authority || e.command !== 'autonomy')))
    const bytes = journalBytes(missing), before = run(missing, 'show')
    assert.equal(next(missing).action, authority ? 'wait' : 'none')
    run(missing, 'next', { owner, gateNumber: 1 }, false)
    assert.equal(journalBytes(missing), bytes)
    if (!authority) run(missing, 'autonomy', autonomyInput())
    run(missing, 'wake', wakeInput('first-real-capacity'))
    assert.equal(next(missing).action, 'audit')
    assert.deepEqual(run(missing, 'show').prs['1'].cycles, before.prs['1'].cycles)
    assertHistoryPrefix(missing, bytes)
  }
  // Old accepted non-canary charges share the wake; invalidation never refunds them.
  run(dir, 'sync', { owner, complete: true, prs: [snapshot, pr(2), pr(3), pr(4)] })
  for (const number of [2, 3, 4]) {
    appendHistorical(dir, 'next', { owner })
    const claim = run(dir, 'show').active
    assert.equal(claim.number, number)
    appendHistorical(dir, 'begin', { owner, number, claimId: claim.claimId, base: claim.base, head: claim.head })
    appendHistorical(dir, 'save', saveInput(claim))
  }
  const before = run(dir, 'show'), bytes = journalBytes(dir)
  assert.equal(before.wakes.at(-1).chargedRounds, 3)
  assert.equal(next(dir).action, 'wait')
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  assert.equal(journalBytes(dir), bytes)
  run(dir, 'wake', wakeInput('new-capacity-not-new-authority'))
  const claim = start(dir), after = run(dir, 'show')
  assert.equal(claim.number, 1)
  assert.equal(claim.round, 2)
  assert.deepEqual(after.wakes.slice(0, -1), before.wakes)
  assert.equal(after.wakes.at(-1).chargedRounds, 1)
  assertHistoryPrefix(dir, bytes)
})

test('EX-UNCHANGED-CANARY-RECOVERY: already exhausted historical correction stays stopped without a marker', () => {
  const { dir, snapshot } = historicalActivation()
  // Retained pre-upgrade history already spent its last no-progress attempt.
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, reviewKey: key(3) }] })
  appendHistorical(dir, 'next', { owner })
  const claim = run(dir, 'show').active
  appendHistorical(dir, 'begin', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head })
  appendHistorical(dir, 'save', saveInput(claim, { phase: 'blocked', technicalVerdict: 'NAUGHTY' }))
  const before = run(dir, 'show'), bytes = journalBytes(dir)
  assert.equal(before.prs['1'].correctiveAudit, undefined)
  assert.equal(before.prs['1'].cycles[0].noProgress, 2)
  for (const id of ['still-stopped', 'still-stopped-again']) {
    run(dir, 'wake', wakeInput(id))
    const stopped = journalBytes(dir)
    assert.equal(next(dir).action, 'none')
    run(dir, 'next', { owner, gateNumber: 1 }, false)
    run(dir, 'resume', resumeInput({ ...claim, round: 2 }), false)
    assert.equal(journalBytes(dir), stopped)
    assert.deepEqual(run(dir, 'show').prs['1'], before.prs['1'])
  }
  assertHistoryPrefix(dir, bytes)
})

test('EX-UNCHANGED-CANARY-RECOVERY: a newer remote head cannot renew a cycle from conflicted NICE', () => {
  const { dir, snapshot } = historicalActivation()
  const old = run(dir, 'show'), bytes = journalBytes(dir)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, head: sha(88), baseRef: 'current-target' }, pr(2)] })
  const claim = start(dir), state = run(dir, 'show')
  assert.equal(claim.number, 1)
  assert.equal(claim.head, sha(88))
  assert.equal(claim.snapshot.baseRef, 'current-target')
  assert.equal(claim.round, 2, 'invalid old NICE cannot authorize a fresh cycle')
  assert.equal(state.prs['1'].cycles.length, 1)
  assert.equal(state.prs['1'].cycles[0].noProgress, old.prs['1'].cycles[0].noProgress + 1)
  assert.equal(state.prs['1'].cycles[0].completion, null)
  assertHistoryPrefix(dir, bytes)
})

const legacyCorrectionHistory = (exhausted = false, baseRef = 'release') => {
  const history = historicalActivation(baseRef), { dir, snapshot } = history
  if (exhausted) {
    run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, reviewKey: key(3) }] })
    appendHistorical(dir, 'next', { owner })
    const claim = run(dir, 'show').active
    appendHistorical(dir, 'begin', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head })
    const charged = run(dir, 'show').active
    appendHistorical(dir, 'save', saveInput(charged, {
      phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(charged),
    }))
  }
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, head: sha(88) }] })
  return history
}
const legacyCorrectionClaim = (dir) => {
  // Retained 6ca8ddc next envelope: activationFence, but no canaryRecovery marker.
  // This synthetic fixture stays runnable without Git history or operator state.
  const events = JSON.parse(journalBytes(dir)).events
  events.push({ version: 2, id: 'legacy-correction-claim', at: new Date().toISOString(),
    command: 'next', input: { owner }, admission: 'detail-read-recovery', activationFence: true })
  writeJournal(dir, events)
  const state = run(dir, 'show')
  assert.equal(state.prs['1'].correctiveAudit, undefined)
  assert.equal(state.active.action, 'audit')
  assert.equal(state.active.round, null)
  return state.active
}
const beginInput = (claim) => ({
  owner, number: claim.number, claimId: claim.claimId, base: claim.base, head: claim.head,
})

for (const blocked of [false, true]) {
  test(`EX-LEGACY-CORRECTION-BOUNDS: exhausted unmarked ${blocked ? 'resume' : 'begin'} cannot renew invalid NICE`, () => {
    const { dir } = legacyCorrectionHistory(true), claim = legacyCorrectionClaim(dir)
    if (blocked) run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
    const before = run(dir, 'show'), bytes = journalBytes(dir)
    assert.equal(before.activation.valid, false)
    assert.equal(before.prs['1'].cycles[0].rounds, 2)
    assert.equal(before.prs['1'].cycles[0].noProgress, 2)
    assert.match(run(dir, blocked ? 'resume' : 'begin',
      blocked ? resumeInput(claim) : beginInput(claim), false).error, /no-progress limit exhausted/)
    assert.equal(journalBytes(dir), bytes, 'denial appends no event or charge')
    assert.deepEqual(run(dir, 'show'), before)
  })

  test(`EX-LEGACY-CORRECTION-BOUNDS: under-bound unmarked ${blocked ? 'resume then begin' : 'begin'} replays without a new cycle`, () => {
    const { dir, acceptanceProof } = legacyCorrectionHistory(), claim = legacyCorrectionClaim(dir)
    if (blocked) {
      run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
      const before = run(dir, 'show')
      assert.equal(run(dir, 'resume', resumeInput(claim)).round, null)
      const resumed = run(dir, 'show')
      assert.deepEqual(resumed.wakes, before.wakes)
      assert.equal(resumed.prs['1'].cycles.length, 1)
    }
    const before = run(dir, 'show'), bytes = journalBytes(dir)
    const charged = run(dir, 'begin', beginInput(claim)), after = run(dir, 'show')
    assert.equal(charged.round, 2)
    assert.deepEqual(after.active, charged, 'restart must replay the same charged round')
    assert.equal(after.prs['1'].cycles.length, 1)
    assert.equal(after.prs['1'].cycles[0].rounds, 2)
    assert.equal(after.prs['1'].cycles[0].noProgress, 2)
    assert.equal(after.wakes.at(-1).chargedRounds, before.wakes.at(-1).chargedRounds + 1)
    assert.deepEqual(after.autonomy, before.autonomy)
    assert.deepEqual(after.activation, before.activation)
    assertHistoryPrefix(dir, bytes)
    // Fresh independent review/publication and the complete enable proof remain mandatory.
    bindRubric(dir, charged)
    const candidate = { ...charged.snapshot, head: sha(89) }
    bindRubric(dir, candidate)
    const receipts = reviewers({ ...charged, head: candidate.head })
    const rebound = run(dir, 'published', { ...beginInput(charged), snapshot: candidate, reviewers: receipts,
      push: { repo, branch: candidate.branch, before: charged.head, head: candidate.head,
        sourceRef: 'synthetic-legacy-correction-push.json', pushedAt: new Date().toISOString() } })
    run(dir, 'save', saveInput(rebound, { phase: 'complete', technicalVerdict: 'NICE', reviewers: receipts }))
    assert.equal(run(dir, 'show').activation.valid, false)
    run(dir, 'enable', { owner, acceptanceProof }, false)
    const good = proof(rebound, receipts)
    run(dir, 'enable', { owner, acceptanceProof: { ...good, fixers: [] } }, false)
    run(dir, 'enable', { owner, acceptanceProof: good })
    const enabled = run(dir, 'show')
    assert.equal(enabled.activation.valid, true)
    assert.deepEqual(enabled.activations.map((a) => a.valid), [false, true])
    assert.deepEqual(enabled.activations[0].acceptanceProof, acceptanceProof)
    assert.equal(enabled.prs['1'].cycles.length, 1)
    assert.equal(enabled.prs['1'].cycles[0].noProgress, 2)
    assert.deepEqual(enabled.wakes, after.wakes)
    assertHistoryPrefix(dir, bytes)
  })
}

test('EX-LEGACY-CORRECTION-BOUNDS: exact charged unfinished legacy correction resumes at the breaker', () => {
  const { dir, snapshot } = historicalActivation()
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, reviewKey: key(3) }] })
  const claim = legacyCorrectionClaim(dir)
  appendHistorical(dir, 'begin', beginInput(claim))
  const charged = run(dir, 'show').active
  assert.equal(charged.round, 2)
  run(dir, 'save', saveInput(charged, { phase: 'blocked' }))
  const before = run(dir, 'show'), bytes = journalBytes(dir)
  const resumed = run(dir, 'resume', resumeInput(charged)), after = run(dir, 'show')
  for (const field of ['claimId', 'round', 'startedAt']) assert.equal(resumed[field], charged[field])
  assert.equal(after.active.round, 2)
  assert.equal(after.prs['1'].cycles.length, 1)
  assert.equal(after.prs['1'].cycles[0].noProgress, 2)
  assert.deepEqual(after.wakes, before.wakes)
  assert.deepEqual(after.activation, before.activation)
  run(dir, 'begin', beginInput(charged), false)
  assertHistoryPrefix(dir, bytes)
})

test('EX-LEGACY-CORRECTION-BOUNDS: valid activation still renews changed-head work past the old cycle bound', () => {
  const { dir } = legacyCorrectionHistory(true, 'main'), claim = next(dir)
  run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
  const before = run(dir, 'show')
  assert.equal(before.activation.valid, true)
  assert.equal(before.prs['1'].cycles[0].noProgress, 2)
  run(dir, 'resume', resumeInput(claim))
  const resumed = run(dir, 'show')
  assert.equal(run(dir, 'begin', beginInput(claim)).round, 1)
  const after = run(dir, 'show')
  assert.equal(after.prs['1'].cycles.length, 2)
  assert.deepEqual(after.prs['1'].cycles[0], resumed.prs['1'].cycles[0])
  assert.equal(after.prs['1'].cycles[1].noProgress, 1)
  assert.equal(after.wakes.at(-1).chargedRounds, before.wakes.at(-1).chargedRounds + 1)
})

test('EX-LEGACY-CORRECTION-BOUNDS: old already-accepted resume and renewed charge replay unchanged', () => {
  const { dir } = legacyCorrectionHistory(true), claim = legacyCorrectionClaim(dir)
  appendHistorical(dir, 'save', saveInput(claim, { phase: 'blocked' }))
  appendHistorical(dir, 'resume', resumeInput(claim))
  appendHistorical(dir, 'begin', beginInput(claim))
  const bytes = journalBytes(dir), before = run(dir, 'show')
  assert.equal(before.activation.valid, false)
  assert.equal(before.active.round, 1)
  assert.deepEqual(before.prs['1'].cycles.map((c) => [c.rounds, c.noProgress]), [[2, 2], [1, 1]])
  assert.equal(next(dir).claimId, before.active.claimId)
  assert.deepEqual(run(dir, 'show'), before)
  assert.equal(journalBytes(dir), bytes)
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
  run(dir, 'save', saveInput(claim, { phase: 'fixing', technicalVerdict: 'NAUGHTY' }), false)
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
H4sIAAAAAAAACu2bTXMcN5KG7/srKurMopAAEgnQJ1mmbcV4bYcke3d25EMikSBr1KzmVFXrYx3+7xtoUpbYtjxLUXLsjh2hgyLI
RhfyQSbefLP4Y/9c52XcTv0JHPX6XKd16U/+9mM/lv6k15gkh1gGEMHBY4Uhas2DstikEm0o2h/1vPYnvTU2DCYNQE+MO/F0YujY
Ofiv/qiX7cUFT23BcRrX/qgfp8vd2p/82F9si276k/7sch3CwMs6c3/Ub19MOvcnvQE2LC4N4NkPBGwH9iJDACqQnLItrj/qZ73c
9if9/c1meHKuw/dj1uWeyna+7I/6y+1mlFePz7k/6cH5UJFcxGioBrA2xyrkrM3iAK0jqUAS2yPzxPOr/sQZ/9NPR9fhqIDRGe+G
GrIfvM9miJjzQNl46y1gxfTOcKA99kg3w7G8muTtcMj24nKjq/Yn67zTo/5yvoIx7S5yi4gzdNRnXrQ/6bNF61LwSkhBuIoxGj0j
KBjvK+KeDlN/1J8rt28zqM5YSUg52ABQpBZFjK4C5IApOqzJSe2P+mW7m0Uf/VZg88yTnPcnPVdeVad747LsdKA0VJZ1O78aZLus
w+WsdTOenTfsy8ptb/32Uqf+qC8z1/X1VndzOwfn63q5nNy7dzau57t8LNuLe7/y7fcud5vNPWdoD//5qC/+oq8aX5sCI7E3aku2
aEosotlCjFkUE0stMSdjUTgiUcgchCVQCIiGfX/Un/GqV4tVb1E8J5NiYMguBCsabNJSqgk5cA2BQBnEk4CLCYgVDVsDtUqWvh2b
N+DCHcCpt+CI2CcOFYqruTp2laAYo9ZoZlRXo70lONkWfXnvYrdZx8sNv9J52I0fgVI4oJSjtwFCAR9zMdGrIELJsaWgq4UkQVCb
CTJlTSmiDz4XxWpCMAbiDUrRcZSSbSUGIVuBPbnig0WSiCaGgowVLES20SYGhVyM9SEUrTalA0p4B0rCgCH6HD2BKVmCRyPW5ARA
NdgaU3ExRjqk9Dp//kli2UTDrIvyLOfDOU9lW+tHoIUHtDBClVpDSknJB+cyG3XeK2pypFnIK/gkAE5DNWxtyw/w6KvHhHKDVnBR
HFY2qSafr5KOUaWgTyVXKcFlDuhTyOhCtZFQU6DsYyghVT6g5e9Aq1TjXGIEb1wIOQA5A86rLQwmiA0pgREf3yunVuWLof13uArl
sDwbN5uPQMsf0PLRFVPJF7LMJvhkwRcnLjkjhVNBpgoBAhUDZIxDTNEWMNFV41JyN2gBu8YpmaQ1o7cYUcQGg6GJgMI1Qk6Ggs0Y
LXpvLaFHKiFAjIXpBi2b7kLLWTVktUCOPmBiirmgixFa7QXjpVXoUt0hrbKsz15sNu/idJVZ4M3wXOexjjoPwnKuywdHZdMhqsQ5
UWFCqES1KmUJ5ELTDcZSYucrWQhUkzhxIbvsY8wmSLWKvpSbZbA4skZckFQLGTLoY0gVrY/iyBmbs3ovmVgcBIjWB5YSvSscqot8
gMr9jMpZJiJbwFVMGKCyNZgdcVBGJLTRcXXMb1Blo4ZCVEKp7MFwIZcIWVsJJ98qh/duXxhul1jTOo/5no00XPA0Vl3WQc5Vnl1u
x+nDqwub3KG6qE3hhSjsYoq1JIHKRm3jhNlnddYHl1AdWsIiyOI9qlPrvTXCN4GZnFU5iK9kGIrPFAqpUQNUIzBlKGozoBcRqCmb
EowzDAnIGucOgJm75BZmChWC1SYsqEbDaiMkluBS5ZxMKBr3Qv/2uWWtG5ZVdR6ns6Eol81Wnr0TVuXN8p60zAGtWpNWoRSMQzWa
sqdUWQWT9y5CybVmU4qSkPUSFEIMUnMuWasI5QMtiFHa7VZTpurJ+SQRJHmqbLiwq1jVKOZcqAg6jBRdyiEblzGxvUkrxrvcWyYk
SkU4oSPklKrXWINjIBUI0dZULFZ4P1oEw7LyvO4uh+e8GQuvrTX88LhiPMDlPIoGF2P1LmrAiM5WydCKCceMLNUlozlmxUBMbKl4
ZBdLdmTgpnRPrrhEamxAxZY5HFA5GpshRQuWjVdRFxSTd2wLWRu989lTKLZEc4DL3QEX5+grMpMNPlUuVp11lSVhcRoJUXMJmsIt
q2FVXnez3rNxD2zVgXdlXIfn8DFgHVZCDoVRYqiltZJCAGycAyZTnROuGnxkQmSibLJQ8CTGVgpWS477huANLIwkkTxg8Nx0cmgX
HVc1qJwTpGBrZdOiXqGakFJBI+jVBtVcEG7CorvkVs3JxZKEQ5VgrbPiBEtTPQZtND5hE75wW1hXGXY5D6teXG4amw/PiA4Tqlhi
VauRqi0OUs2WSlWBIqKxFBtR9lWKXBE2OWUAkzBUY00Q0RuMmEISsCb4IuwrOFurxRRFHXg10RQLntkldcb4GA0UMOiT96laa+MB
o7t0WRBEDEgqYNgCxYI5KHtOhGhFjZKHpnPfs/754Vpo7NbtPGzG6dm7teAdaB12WRYt1OokiyZICJRLBccxOkpM2UQThbwkzhgE
klUfS8meffUlsr+ZUeBTAZVYFIoUDzFYZqcJDKYQoV1kTW+KjwIQ2BniEo0W8jkm8ge3Fd2l/BGThNK6gkpaikioBaqPnkqMwSUl
DFVNfs+M2p7NfJF1kvPhbN5OrT/ebdZl2IvotL8VPrAqpMNaGAxRBldjoiTW+dh6ZUDw1cQY9t1JQZPBQQhVSs1KobAXisl5ALrZ
H8dgmASE1BpXA1cyORIYVWtrNlJiDcUmDmKLBAspBM4ITdQ3e+smuXCXPIuSxKh4i4U45Nzu4qzNQWGvRTAg+4B7v/P25K6zDd94
hbuXHyHNwmGapQSWbXRqbJTCXDBHi6lAqTWSFgErNVrDypJcaFLcYtCIGKq39qYoTGhMDjVZFKGgSMEm19o4hRgyBRcMuGiU0Wmh
TKU4im6/euuA9CYsvAssYxhcrSDVQ67JVAlar5yvXPbKUJOt4f3S7LpJDjAs5zxrGXi3nm/ncX31EZDhIbKSTfRV0FVm8SBFbCCV
EmM0hJZc9ZWjr9lFsaxRbKhiNDoPwlhuIsNic2RAoeSC8yoJWp8d0EdwDYzaZmmU1s2VUpoxbFtvZ2tw5DweIIM7IPPOcqFcLEml
yBlVU6nRUmFlYxDVZNZ9m397ZG0i0tquFzyXjwEJDiBFoxCbgxcoBsFiHYQk6kPrWZ0LMRov1ljHGqCNbVLKCCpkTXRWblq6BSOD
QYNNwdtEhiyjKaECm5CQm1Rs/bCzIJGsj8AZKKoHLQhSbkJyd5mYRO/AmeCSgLcpi9HmqyVq125V9jHWnIO/S16h+bkGzirb5zp/
jLRyh6MS9VoLNOPPy/7eFysRAhtQokq12OSl+e3obbUmQUjUZFfLmGz5pplhpGiwJRCCSQWl2cTROQCw5JJXl0mrbQJDi2eyHpDE
Jio5BoPlwMywdxmVmEqJMftSRQIniZaTj9WaZkLVkl2Otnr3i/b4nxC7iuVrUJvxeXM28COAsofTkmTZocRmPLFxudomt6sl8qwY
rCFwFTI5rNkYDpjZBaTsDaqN2fqD1MrZeW98cmpicZZFEhRBANeiwtpGYpD3pcgnSgxeWkvsE4QSsf/ph1tOZ98MT7VKDGTMIMm3
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
  assert.match(run(dir, 'save', last, false).error, /round/, 'missing-round legacy receipt is replay-only, not a live ACK')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), legacyJournal)
  assert.match(run(dir, 'save', { ...last, round: state.active.round, reason: 'New uncharged correction' }, false).error, /explicit retry/)
  assert.match(run(dir, 'save', { ...last, round: state.active.round, phase: 'reviewing',
    evidence: ['new-failed-review.json'] }, false).error, /explicit retry/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), legacyJournal)
  // A permitted terminal block appends v2 without changing any historical event bytes.
  run(dir, 'save', { ...last, round: state.active.round, phase: 'blocked', reason: 'Preserve legacy unfinished work' })
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
    run(dir, 'save', { ...history.at(-1).input, round: claim.round, phase: 'blocked', reason: 'Verified temporary tool failure' })
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

for (const base of [sha(10), sha(100)]) test(`deploy: rejects ${base === sha(100) ? 'empty-diff' : 'unrelated-base'} reviews before persisting`, () => {
  const dir = setup(), policySha = sha(100)
  bindRubric(dir, { base, head: policySha })
  const input = { owner, previousPolicySha: init.policySha, policySha,
    reviewers: reviewers({ claimId: 'actual-policy-review', base, head: policySha }),
    validation: { policySha, status: 'passed', sourceRef: 'validation.json', verifiedAt: new Date().toISOString() } }
  for (const exactRubricBound of [false, true]) {
    if (exactRubricBound) bindRubric(dir, { base: init.policySha, head: policySha })
    const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
    run(dir, 'deploy', input, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
    assert.equal(run(dir, 'show').deployments.length, 1)
  }
})

test('deploy: exact transition requires its prebound complete 13-row rubric and fresh matching receipts', () => {
  const dir = setup(), base = init.policySha, head = sha(100)
  const required = [...criteria, 'LOCAL_TESTS', 'TDD_EVIDENCE', 'DOCUMENTATION', 'DEPENDENCY_INTEGRITY', 'POLICY_PROVENANCE']
  const input = { owner, previousPolicySha: base, policySha: head,
    reviewers: reviewers({ claimId: 'full-policy-review', base, head }).map((r) => ({
      ...r, criteria: required.map((id) => ({ id, result: 'PASS', sourceRef: `evidence/policy-${id}.json` })),
    })),
    validation: { policySha: head, status: 'passed', sourceRef: 'validation.json', verifiedAt: new Date().toISOString() } }
  bindRubric(dir, { base: sha(10), head })
  let bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'deploy', input, false)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  const binding = { owner, base, head, sourceRef: 'trusted-policy-rubric.json', sha256: key(501), criteria: required }
  run(dir, 'rubric', binding)
  bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'deploy', input, false) // Receipts predate this exact rubric binding.
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  input.reviewers = input.reviewers.map((r) => ({ ...r, completedAt: new Date().toISOString() }))
  for (const bad of [
    { ...input, previousPolicySha: sha(10) },
    { ...input, reviewers: input.reviewers.map((r) => ({ ...r, criteria: r.criteria.slice(0, -1) })) },
    ...[{ base: sha(10) }, { head: sha(101) }].map((change) => ({
      ...input, reviewers: [input.reviewers[0], { ...input.reviewers[1], ...change }],
    })),
  ]) {
    run(dir, 'deploy', bad, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  }
  run(dir, 'deploy', input)
  const state = run(dir, 'show')
  assert.deepEqual(state.rubrics[`${base}:${head}`].binding, binding)
  assert.deepEqual(state.deployments.at(-1).reviewers, input.reviewers)
  assert.equal(state.deployments.at(-1).previousPolicySha, base)
  const help = run(fixture(), 'help').help
  assert.match(help, /Reviewers and their bound rubric must cover previousPolicySha -> policySha/)
  assert.match(help, /Historical accepted deployments replay unchanged/)
})

for (const base of [sha(10), sha(100)]) test(`deploy: historical ${base === sha(100) ? 'empty-diff' : 'unrelated-base'} acceptance replays unchanged and the next transition uses retained policy`, () => {
  const dir = setup(), policySha = sha(100)
  bindRubric(dir, { base, head: policySha })
  const historical = { owner, previousPolicySha: init.policySha, policySha,
    reviewers: reviewers({ claimId: 'historical-policy-review', base, head: policySha }),
    validation: { policySha, status: 'passed', sourceRef: 'historical-validation.json', verifiedAt: new Date().toISOString() } }
  appendHistorical(dir, 'deploy', historical)
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8'), before = run(dir, 'show')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  assert.deepEqual(before.deployments.at(-1).reviewers, historical.reviewers)
  assert.equal(before.rubrics[`${init.policySha}:${policySha}`], undefined, 'never invent missing transition coverage')
  const originalEvents = JSON.parse(bytes).events
  const upgrade = deploymentInput(dir, policySha, sha(101))
  const wrongBase = deploymentInput(dir, init.policySha, upgrade.policySha)
  const upgradeBytes = readFileSync(join(dir, 'state.json'), 'utf8')
  for (const bad of [
    wrongBase,
    { ...wrongBase, previousPolicySha: policySha },
    { ...upgrade, reviewers: historical.reviewers },
    ...['reviewerId', 'sourceRef'].map((field) => ({
      ...upgrade, reviewers: upgrade.reviewers.map((r, n) => ({ ...r, [field]: historical.reviewers[n][field] })),
    })),
  ]) {
    run(dir, 'deploy', bad, false)
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), upgradeBytes)
  }
  run(dir, 'deploy', upgrade)
  const after = run(dir, 'show')
  assert.deepEqual(after.deployments.slice(0, 2), before.deployments)
  assert.deepEqual(after.config, before.config)
  assert.deepEqual(after.deployments.at(-1).reviewers, upgrade.reviewers)
  assert.equal(after.deployments.at(-1).previousPolicySha, policySha)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).events.slice(0, originalEvents.length), originalEvents)
})

test('deploy: unchanged exact-base review pair still supports publication in the same charged round', () => {
  const dir = setup([pr(1, { base: init.policySha })]), claim = start(dir)
  const input = deploymentInput(dir)
  input.reviewers = reviewers({ ...claim, head: input.policySha })
  run(dir, 'deploy', input)
  const snapshot = { ...claim.snapshot, head: input.policySha }
  const publication = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
    snapshot, reviewers: input.reviewers,
    push: { repo, branch: snapshot.branch, before: claim.head, head: snapshot.head,
      sourceRef: 'evidence/same-base-push.json', pushedAt: new Date().toISOString() } }
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  const altered = input.reviewers.map((r) => ({ ...r, completedAt: new Date().toISOString() }))
  assert.match(run(dir, 'published', { ...publication, reviewers: altered }, false).error, /retained review decision/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
  const published = run(dir, 'published', publication)
  run(dir, 'save', saveInput(published, { technicalVerdict: 'NICE', reviewers: input.reviewers }))
  const state = run(dir, 'show')
  assert.deepEqual(state.deployments.at(-1).reviewers, input.reviewers)
  assert.deepEqual(state.prs['1'].publications.at(-1).reviewers, input.reviewers)
  assert.equal(state.prs['1'].cycles[0].rounds, claim.round)
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
  const deployment = deploymentInput(dir, init.policySha, candidate.head)
  assert.notEqual(deployment.reviewers[0].base, receipts[0].base, 'policy and PR reviews cover different actual bases')
  const beforeDeploy = run(dir, 'show')
  run(dir, 'deploy', deployment)
  assert.deepEqual(run(dir, 'show').active, beforeDeploy.active)
  assert.deepEqual(run(dir, 'show').prs, beforeDeploy.prs)
  const push = { repo, branch: candidate.branch, before: legacy.head, head: candidate.head,
    sourceRef: 'evidence/original-normal-push.json', pushedAt: new Date().toISOString() }
  const publication = { owner, number: 1, claimId: retried.claimId, base: retried.base, head: retried.head,
    snapshot: readbackRace ? { ...candidate, reviewKey: key(2), gateKey: key(2) } : candidate, push, reviewers: receipts }
  const beforeRejected = readFileSync(join(dir, 'state.json'), 'utf8')
  run(dir, 'published', { ...publication, reviewers: deployment.reviewers }, false)
  const alteredPair = deployment.reviewers.map((r) => ({ ...r, base: candidate.base, completedAt: new Date().toISOString() }))
  assert.match(run(dir, 'published', { ...publication, reviewers: alteredPair,
    push: { ...push, pushedAt: new Date().toISOString() } }, false).error, /retained review decision/)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), beforeRejected)
  const differentCandidate = { ...candidate, head: sha(101) }
  bindRubric(dir, differentCandidate)
  const rewrittenPair = deployment.reviewers.map((r) => ({
    ...r, base: differentCandidate.base, head: differentCandidate.head, completedAt: new Date().toISOString(),
  }))
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
  assert.deepEqual(run(dir, 'show').deployments.at(-1).reviewers, deployment.reviewers)
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

for (const gateWait of [false, true]) for (const autonomous of [false, true]) for (const round of [2, 3]) {
  test(`${gateWait ? 'EX-GATE-WAIT-RESUME' : 'EX-FINAL-CHARGE-RESUME'}: ${autonomous ? 'ongoing' : 'interactive'} unfinished round ${round} survives repeated ${gateWait ? 'gate waits' : 'detail outages'} without charges`, () => {
    const dir = setup()
    if (autonomous) {
      run(dir, 'autonomy', autonomyInput())
      run(dir, 'wake', wakeInput('final-charge'))
    }
    let claim, snapshot, findings = []
    if (round === 2 && gateWait) {
      const first = start(dir)
      failedReview(dir, first)
      claim = run(dir, 'retry', retryInput(first))
      snapshot = claim.snapshot
    } else if (round === 2) {
      const published = publishComplete(dir)
      snapshot = { ...published.snapshot, reviewKey: key(2) }
      run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
      run(dir, 'feedback', feedbackInput(feedbackClaim(dir), { disposition: 'ACTIONABLE_FINDINGS' }))
      claim = start(dir)
    } else {
      claim = start(dir)
      for (let previous = 1; previous < round; previous++) {
        findings = progressFailure(dir, claim, findings)
        claim = run(dir, 'retry', retryInput(claim))
      }
      snapshot = claim.snapshot
    }
    const finding = { id: 'unfinished-fix', status: 'open', evidence: ['final-red.log'] }
    findings.push(finding)
    run(dir, 'save', saveInput(claim, { phase: 'fixing', findings, evidence: ['retained-worktree.json'] }))
    const admitted = run(dir, 'show'), admittedCycle = admitted.prs['1'].cycles[0]
    assert.equal(claim.round, round)
    assert.equal(admittedCycle.noProgress, round === 2 ? 2 : 1)
    assert.equal(admitted.active.failureEvidence, null)
    assert.equal(admittedCycle.technicalVerdict, null)
    assert.equal(admittedCycle.completion, null)
    for (let interruption = 1; interruption <= 2; interruption++) {
      run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, readError: 'DETAIL_READ_FAILED' }] })
      assert.equal(next(dir).action, 'reconcile')
      run(dir, 'save', saveInput(claim, { phase: 'blocked', findings,
        evidence: [`detail-outage-${interruption}.json`], reason: 'Transient detail read unavailable' }))
      run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
      if (gateWait) {
        const retained = JSON.stringify(run(dir, 'show').prs['1'].blockedClaim)
        for (const phase of ['waiting', 'blocked', 'waiting']) {
          const gate = run(dir, 'next', { owner, gateNumber: 1 })
          assert.equal(gate.action, 'check')
          assert.equal(gate.round, null)
          const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
          assert.match(run(dir, 'resume', resumeInput(claim), false).error, /active claim/)
          assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
          run(dir, 'save', saveInput(gate, { phase, findings,
            evidence: [`current-ci-${interruption}-${phase}.json`] }))
          const checked = run(dir, 'show')
          assert.equal(checked.prs['1'].cycles[0].phase, phase)
          assert.equal(JSON.stringify(checked.prs['1'].blockedClaim), retained)
          assert.equal(checked.prs['1'].cycles[0].rounds, admittedCycle.rounds)
          assert.equal(checked.prs['1'].cycles[0].noProgress, admittedCycle.noProgress)
          assert.deepEqual(checked.wakes, admitted.wakes)
        }
      }
      const blocked = run(dir, 'show'), before = JSON.parse(readFileSync(join(dir, 'state.json'))).events
      const input = resumeInput(claim)
      for (const bad of [
        { ...input, clearance: undefined },
        { ...input, clearance: { ...input.clearance, sourceRef: '' } },
        { ...input, clearance: { ...input.clearance, verifiedAt: '2000-01-01T00:00:00.000Z' } },
        { ...input, clearance: { ...input.clearance, verifiedAt: '9999-01-01T00:00:00.000Z' } },
        { ...input, owner: 'other' }, { ...input, number: 2 }, { ...input, claimId: 'other' },
        { ...input, base: sha(88) }, { ...input, head: sha(88) }, { ...input, round: round - 1 },
        { ...input, unfinished: true },
      ]) {
        const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
        run(dir, 'resume', bad, false)
        assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
      }
      const resumed = run(dir, 'resume', resumeInput(claim)), restored = run(dir, 'show')
      assert.equal(resumed.claimId, claim.claimId)
      assert.equal(resumed.round, round)
      assert.equal(resumed.startedAt, claim.startedAt)
      assert.deepEqual(restored.active, blocked.prs['1'].blockedClaim.claim)
      assert.deepEqual(restored.wakes, admitted.wakes)
      assert.equal(restored.sequence, blocked.sequence)
      const c = restored.prs['1'].cycles[0]
      assert.equal(c.rounds, admittedCycle.rounds)
      assert.equal(c.noProgress, admittedCycle.noProgress)
      assert.equal(c.phase, 'fixing')
      assert.equal(c.technicalVerdict, null)
      assert.deepEqual(c.findings, findings)
      assert.ok(blocked.prs['1'].cycles[0].evidence.every((ref) => c.evidence.includes(ref)))
      assert.ok(c.evidence.includes(input.clearance.sourceRef))
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, before.length), before)
      const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
      run(dir, 'begin', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head }, false)
      run(dir, 'retry', retryInput(claim), false)
      run(dir, 'resume', resumeInput(claim), false)
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
    }
    // A real failed review cannot borrow the unfinished-charge exception.
    const failed = fixture()
    writeJournal(failed, JSON.parse(readFileSync(join(dir, 'state.json'))).events)
    failedReview(failed, claim, findings)
    const failure = run(failed, 'show').active
    run(failed, 'retry', retryInput(claim), false)
    run(failed, 'save', saveInput(claim, { phase: 'blocked', findings }))
    if (gateWait) {
      const gate = run(failed, 'next', { owner, gateNumber: 1 })
      run(failed, 'save', saveInput(gate, { findings }))
    }
    const stopped = readFileSync(join(failed, 'state.json'), 'utf8')
    if (round === 2 || !autonomous) {
      assert.match(run(failed, 'resume', resumeInput(claim), false).error, /exhausted/)
      assert.equal(readFileSync(join(failed, 'state.json'), 'utf8'), stopped)
    } else {
      run(failed, 'resume', resumeInput(claim))
      assert.deepEqual(run(failed, 'show').active.failureEvidence, failure.failureEvidence)
      assert.deepEqual(run(failed, 'show').active.failureReceipt, failure.failureReceipt)
      run(failed, 'save', saveInput(claim, { phase: 'fixing', findings }), false)
      assert.match(run(failed, 'retry', retryInput(claim), false).error, /wake/)
    }
    assert.deepEqual(run(failed, 'show').wakes, admitted.wakes)
    const fixed = findings.map((f) => f.id === finding.id
      ? { ...f, status: 'fixed', evidence: [...f.evidence, 'final-green.log'] } : f)
    run(dir, 'save', saveInput(claim, { phase: 'fixing', findings: fixed, evidence: ['final-green.log'] }))
    run(dir, 'save', saveInput(claim, { phase: 'complete', findings: fixed,
      technicalVerdict: 'NICE', reviewers: reviewers(claim) }))
    const completed = run(dir, 'show')
    assert.equal(completed.prs['1'].cycles[0].technicalVerdict, 'NICE')
    assert.equal(completed.prs['1'].cycles[0].rounds, round)
    assert.deepEqual(completed.wakes, admitted.wakes)
    run(dir, 'resume', resumeInput(claim), false)
  })
}

for (const phase of ['auditing', 'reviewing']) {
  test(`EX-FINAL-CHARGE-RESUME: persisted ${phase} checkpoint retains scope, decision and historical target guards`, () => {
    const dir = phase === 'reviewing' ? historicalSetup() : setup()
    const first = start(dir)
    failedReview(dir, first)
    const claim = run(dir, 'retry', retryInput(first))
    if (phase === 'reviewing') run(dir, 'save', saveInput(claim, { phase }))
    const prefix = JSON.parse(readFileSync(join(dir, 'state.json'))).events
    assert.equal(run(dir, 'show').prs['1'].cycles[0].noProgress, 2)
    // A retained technical decision is not an unfinished charge, even without failureEvidence.
    const decided = fixture()
    writeJournal(decided, prefix)
    appendHistorical(decided, 'save', saveInput(claim, { phase: 'blocked', technicalVerdict: 'NAUGHTY' }))
    const stopped = readFileSync(join(decided, 'state.json'), 'utf8')
    assert.equal(run(decided, 'show').prs['1'].blockedClaim.claim.failureEvidence, null)
    assert.match(run(decided, 'resume', resumeInput(claim), false).error, /exhausted/)
    assert.equal(readFileSync(join(decided, 'state.json'), 'utf8'), stopped)
    run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
    const snapshot = { ...claim.snapshot, baseRef: 'main' }
    run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
    for (const change of [
      { head: sha(88) }, { base: sha(88) }, { reviewKey: key(88) }, { baseRef: 'release' },
      { branch: 'other' }, { sourceRepo: 'foreign/ecorp' }, { sourceRepo: null },
      { state: 'closed' }, { readError: 'DETAIL_READ_FAILED' },
    ]) {
      run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, ...change }] })
      const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
      assert.match(run(dir, 'resume', resumeInput(claim), false).error, /conflicts/)
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
    }
    run(dir, 'sync', { owner, complete: true, prs: [] })
    run(dir, 'resume', resumeInput(claim), false)
    run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
    const gate = run(dir, 'next', { owner, gateNumber: 1 })
    assert.match(run(dir, 'resume', resumeInput(claim), false).error, /active claim/)
    run(dir, 'save', saveInput(gate, { phase: 'waiting' }))
    const recovered = run(dir, 'resume', resumeInput(claim)), state = run(dir, 'show')
    assert.equal(recovered.claimId, claim.claimId)
    assert.equal(recovered.snapshot.baseRef, claim.snapshot.baseRef)
    assert.equal(state.prs['1'].cycles[0].phase, phase)
    assert.equal(state.prs['1'].cycles[0].noProgress, 2)
    assert.equal(state.prs['1'].cycles[0].rounds, 2)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, prefix.length), prefix)
  })
}

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

const failedWaitingThirdRound = ({ legacy = false, nullable = false, canonical = true, dir = setup(), snapshot = pr() } = {}) => {
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('failed-wait-first'))
  run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
  let claim = start(dir), findings = []
  for (let round = 1; round <= 3; round++) {
    const open = { id: `wait-${round}`, status: 'open', evidence: [`red-${round}.log`] }
    run(dir, 'save', saveInput(claim, { phase: 'fixing', findings: [...findings, open] }))
    findings = [...findings, { ...open, status: 'fixed', evidence: [...open.evidence, `green-${round}.log`] },
      { id: `remaining-${round}`, status: 'open', evidence: [`review-${round}.json`] }]
    const failure = saveInput(claim, { phase: 'reviewing', technicalVerdict: 'NAUGHTY',
      findings, evidence: ['evidence/failed-review.json'], reason: 'Genuine progress; another finding remains' })
    if (round < 3 || canonical) run(dir, 'save', failure)
    else appendHistorical(dir, 'save', { ...failure, phase: 'fixing' })
    if (round < 3) claim = run(dir, 'retry', retryInput(claim))
  }
  const waiting = saveInput(claim, { phase: 'waiting', findings, technicalVerdict: nullable ? null : 'NAUGHTY',
    evidence: ['next-native-wake.json'], reason: 'Native wake capacity exhausted; retain failed work' })
  if (legacy) appendHistorical(dir, 'save', waiting)
  else run(dir, 'save', waiting)
  return { dir, claim, findings }
}

for (const legacy of [false, true]) for (const nullable of [false, true]) {
  test(`EX-FAILED-WAIT-RECOVERY: ${legacy ? 'old prefix' : 'live'} third-charge ${nullable ? 'null projection' : 'NAUGHTY'} wait recovers exact claim before charged round four`, () => {
    const { dir, claim, findings } = failedWaitingThirdRound({ legacy, nullable })
    const prefix = journalBytes(dir), waiting = run(dir, 'show'), p = waiting.prs['1']
    assert.equal(waiting.active, null)
    assert.equal(p.cycles[0].phase, 'waiting')
    assert.equal(p.cycles[0].technicalVerdict, nullable ? null : 'NAUGHTY')
    assert.equal(p.cycles[0].rounds, 3)
    assert.equal(p.cycles[0].noProgress, 0)
    assert.equal(p.blockedClaim?.claim.claimId, claim.claimId)
    assert.equal(p.blockedClaim.retryOnly, true)
    assert.equal(p.blockedClaim.claim.startedAt, claim.startedAt)
    assert.equal(next(dir).action, 'wait')
    assert.equal(journalBytes(dir), prefix, 'reads and exhausted next do not rewrite the accepted prefix')
    run(dir, 'retry', retryInput(claim), false)
    run(dir, 'wake', wakeInput('failed-wait-second'))
    const beforeRoute = journalBytes(dir), route = next(dir)
    assert.equal(route.action, 'blocked')
    assert.equal(route.recovery, 'resume')
    assert.equal(route.retryRequired, true)
    assert.equal(route.claimId, claim.claimId)
    assert.equal(route.round, 3)
    assert.equal(journalBytes(dir), beforeRoute, 'routing cannot create another audit or charge')
    const resumed = run(dir, 'resume', resumeInput(claim))
    assert.equal(resumed.claimId, claim.claimId)
    assert.equal(resumed.startedAt, claim.startedAt)
    assert.deepEqual(resumed.snapshot, claim.snapshot)
    assert.equal(resumed.retryRequired, true)
    assert.deepEqual(run(dir, 'show').active, p.blockedClaim.claim, 'resume restores the exact retained claim')
    assert.deepEqual(run(dir, 'show').wakes.map((w) => w.chargedRounds), [3, 0])
    const beforeRetry = journalBytes(dir)
    for (const phase of ['auditing', 'fixing', 'reviewing']) {
      assert.match(run(dir, 'save', saveInput(resumed, { phase, findings }), false).error, /explicit retry/)
    }
    run(dir, 'save', saveInput(resumed, { phase: 'complete', findings, technicalVerdict: 'NICE',
      reviewers: reviewers(resumed) }), false)
    assert.match(run(dir, 'published', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
      snapshot: { ...claim.snapshot, head: sha(12) }, push: {}, reviewers: [] }, false).error, /explicit retry/)
    run(dir, 'retry', retryInput(resumed, 'not-failed-proof.json'), false)
    assert.equal(journalBytes(dir), beforeRetry)
    const fourth = run(dir, 'retry', retryInput(resumed))
    assert.equal(next(dir).retryRequired, undefined, 'only a new failed review can require another retry')
    assert.equal(fourth.claimId, claim.claimId)
    assert.equal(fourth.round, 4)
    assert.ok(fourth.startedAt > claim.startedAt)
    assert.equal(fourth.head, claim.head)
    assert.equal(fourth.snapshot.reviewKey, claim.snapshot.reviewKey)
    const state = run(dir, 'show'), c = state.prs['1'].cycles[0]
    assert.equal(state.prs['1'].cycles.length, 1)
    assert.equal(c.rounds, 4)
    assert.equal(c.noProgress, 1)
    assert.deepEqual(c.findings, findings)
    assert.ok(c.evidence.includes('next-native-wake.json'))
    assert.deepEqual(state.wakes.map((w) => w.chargedRounds), [3, 1])
    assert.deepEqual(state.autonomy, waiting.autonomy)
    assertHistoryPrefix(dir, prefix)
    run(dir, 'retry', retryInput(resumed), false)
    run(dir, 'save', saveInput(fourth, { phase: 'fixing', findings }))
  })
}

for (const version of [1, 2]) test(`EX-FAILED-WAIT-RECOVERY: old v${version} first terminal failure and nullable hidden proof remain retry-only`, () => {
  for (const nullable of [false, true]) {
    const dir = setup(), claim = start(dir)
    const findings = [{ id: 'old-open', status: 'open', evidence: ['old-red.log'] }]
    appendHistorical(dir, 'save', saveInput(claim, { phase: 'waiting', findings, technicalVerdict: 'NAUGHTY' }))
    if (nullable) {
      // A second old noncanonical projection may hide the verdict, never the proof.
      const old = JSON.parse(journalBytes(dir)).events
      const terminal = old.pop()
      old.push({ ...terminal, input: { ...terminal.input, phase: 'fixing' } },
        { ...terminal, id: `${terminal.id}-wait`, input: { ...terminal.input, technicalVerdict: null } })
      writeJournal(dir, old)
    }
    if (version === 1) writeJournal(dir, JSON.parse(journalBytes(dir)).events.map(({ version, admission, ...e }) => e), 1)
    const prefix = journalBytes(dir), before = run(dir, 'show')
    assert.equal(before.prs['1'].cycles[0].technicalVerdict, nullable ? null : 'NAUGHTY')
    assert.equal(before.prs['1'].blockedClaim?.retryOnly, true)
    assert.equal(journalBytes(dir), prefix)
    const resumed = run(dir, 'resume', resumeInput(claim))
    const restarted = next(dir)
    assert.equal(restarted.retryRequired, true, 'restart after resume must still expose the charged-retry route')
    assert.deepEqual(restarted.failureEvidence, ['evidence/attempt.json'], 'surface only journal-derived failed proof')
    run(dir, 'save', saveInput(resumed, { phase: 'fixing', findings }), false)
    const retried = run(dir, 'retry', retryInput(resumed, 'evidence/attempt.json'))
    assert.equal(retried.round, 2)
    assert.equal(run(dir, 'show').prs['1'].cycles[0].noProgress, 2)
    assertHistoryPrefix(dir, prefix)
  }
})

test('EX-FAILED-WAIT-RECOVERY: current owner, exact checkpoint, scope and clearance fence recovery', () => {
  const { dir, claim } = failedWaitingThirdRound({ legacy: true, nullable: true, canonical: false })
  run(dir, 'wake', wakeInput('failed-wait-scope'))
  const resume = resumeInput(claim), prefix = journalBytes(dir)
  for (const bad of [{ owner: 'other' }, { number: 2 }, { claimId: 'other' }, { head: sha(19) },
    { base: sha(19) }, { round: null }, { round: 2 },
    { clearance: { sourceRef: 'old.json', verifiedAt: '2000-01-01T00:00:00.000Z' } }]) {
    run(dir, 'resume', { ...resume, ...bad }, false)
    assert.equal(journalBytes(dir), prefix)
  }
  for (const change of [{ head: sha(12) }, { base: sha(12) }, { reviewKey: key(2) },
    { branch: 'other' }, { baseRef: 'release' }, { sourceRepo: 'fork/ecorp' }, { sourceRepo: null },
    { readError: 'DETAIL_READ_FAILED' }, { state: 'closed' }, null]) {
    const isolated = fixture()
    writeJournal(isolated, JSON.parse(prefix).events)
    run(isolated, 'sync', { owner, complete: true, prs: change ? [{ ...claim.snapshot, ...change }] : [] })
    const stale = journalBytes(isolated)
    run(isolated, 'resume', resumeInput(claim), false)
    assert.equal(journalBytes(isolated), stale)
    assert.notEqual(next(isolated).recovery, 'resume')
  }
  const resumed = run(dir, 'resume', resume)
  assert.equal(run(dir, 'retry', retryInput(resumed)).round, 4)
  assertHistoryPrefix(dir, prefix)
})

test('EX-FAILED-WAIT-RECOVERY: legacy target first observation fences a later same-SHA retarget', () => {
  const { dir, claim } = failedWaitingThirdRound({ legacy: true })
  const events = JSON.parse(journalBytes(dir)).events
  for (const e of events) if (e.command === 'sync') for (const p of e.input.prs) delete p.baseRef
  writeJournal(dir, events)
  run(dir, 'wake', wakeInput('failed-wait-target'))
  run(dir, 'sync', { owner, complete: true, prs: [pr()] })
  assert.equal(run(dir, 'show').prs['1'].blockedClaim?.claim.effectiveBaseRef, 'main')
  run(dir, 'sync', { owner, complete: true, prs: [pr(1, { baseRef: 'release' })] })
  run(dir, 'resume', resumeInput(claim), false)
  assert.notEqual(next(dir).recovery, 'resume')
})

test('EX-FAILED-WAIT-RECOVERY: absent authority or wake never funds another attempt', () => {
  const { dir, claim } = failedWaitingThirdRound({ legacy: true })
  const events = JSON.parse(journalBytes(dir)).events
  for (const authority of [false, true]) {
    const isolated = fixture()
    writeJournal(isolated, events.filter((e) => !['wake', 'autonomy'].includes(e.command)))
    if (authority) run(isolated, 'autonomy', autonomyInput())
    const prefix = journalBytes(isolated)
    if (!authority) {
      run(isolated, 'resume', resumeInput(claim), false)
      assert.equal(journalBytes(isolated), prefix)
    } else {
      assert.equal(next(isolated).action, 'wait')
      const resumed = run(isolated, 'resume', resumeInput(claim))
      const uncharged = journalBytes(isolated)
      assert.match(run(isolated, 'retry', retryInput(resumed), false).error, /wake/)
      run(isolated, 'save', saveInput(resumed, { phase: 'fixing',
        findings: run(isolated, 'show').prs['1'].cycles[0].findings }), false)
      assert.equal(journalBytes(isolated), uncharged)
    }
  }
})

test('EX-FAILED-WAIT-RECOVERY: genuine no-progress two stays stopped through new wakes and gate waits', () => {
  const dir = setup()
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('failed-wait-stalled'))
  const first = start(dir)
  failedReview(dir, first)
  const second = run(dir, 'retry', retryInput(first))
  failedReview(dir, second)
  run(dir, 'save', saveInput(second, { technicalVerdict: 'NAUGHTY' }))
  run(dir, 'wake', wakeInput('failed-wait-still-stalled'))
  const gate = run(dir, 'next', { owner, gateNumber: 1 })
  run(dir, 'save', saveInput(gate))
  const prefix = journalBytes(dir)
  assert.match(run(dir, 'resume', resumeInput(second), false).error, /exhausted/)
  const route = next(dir)
  assert.equal(route.action, 'blocked')
  assert.match(route.reason, /no-progress/)
  assert.notEqual(route.recovery, 'resume')
  assert.equal(journalBytes(dir), prefix)
  const state = run(dir, 'show')
  assert.equal(state.prs['1'].cycles[0].noProgress, 2)
  assert.deepEqual(state.wakes.map((w) => w.chargedRounds), [2, 0])
})

test('EX-FAILED-WAIT-RECOVERY: another PR proceeds while exact failed wait and gate-only evidence are retained', () => {
  const dir = setup(), published = publishComplete(dir)
  run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) })
  const { claim, findings } = failedWaitingThirdRound({ dir, snapshot: { ...published.snapshot, head: sha(14) } })
  run(dir, 'wake', wakeInput('failed-wait-fairness'))
  const retained = run(dir, 'show').prs['1'].blockedClaim
  run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, gateKey: key(2) }, pr(2)] })
  const other = next(dir)
  assert.equal(other.number, 2)
  run(dir, 'resume', resumeInput(claim), false)
  run(dir, 'save', saveInput(other, { phase: 'blocked' }))
  const gate = run(dir, 'next', { owner, gateNumber: 1 })
  run(dir, 'save', saveInput(gate, { findings }))
  assert.deepEqual(run(dir, 'show').prs['1'].blockedClaim, retained)
  assert.equal(next(dir).recovery, 'resume')
  assert.equal(run(dir, 'resume', resumeInput(claim)).claimId, claim.claimId)
})

test('EX-FAILED-WAIT-RECOVERY: old later audit admissions keep their identities, charges and outcomes', () => {
  const { dir, claim, findings } = failedWaitingThirdRound({ legacy: true })
  appendHistorical(dir, 'wake', wakeInput('old-later-wake'))
  appendHistorical(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, reviewKey: key(2) }] })
  appendHistorical(dir, 'next', { owner })
  const events = JSON.parse(journalBytes(dir)).events, id = events.at(-1).id
  const later = { ...claim, claimId: id, round: 4 }
  appendHistorical(dir, 'begin', { owner, number: 1, claimId: id, base: claim.base, head: claim.head })
  appendHistorical(dir, 'save', saveInput(later, { phase: 'fixing', findings }))
  const prefix = journalBytes(dir), state = run(dir, 'show')
  assert.equal(state.active.claimId, id)
  assert.equal(state.active.round, 4)
  assert.equal(state.prs['1'].cycles[0].phase, 'fixing')
  assert.deepEqual(state.wakes.map((w) => w.chargedRounds), [3, 1])
  assert.equal(state.prs['1'].blockedClaim, undefined)
  assert.equal(journalBytes(dir), prefix)
  assert.equal(next(dir).claimId, id)
  assertHistoryPrefix(dir, prefix)
})

test('EX-FAILED-WAIT-RECOVERY: recovery notice cannot starve a previously selected PR with new pending input', () => {
  const dir = setup(), published = publishComplete(dir)
  run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) })
  const { claim } = failedWaitingThirdRound({ dir, snapshot: { ...published.snapshot, head: sha(14) } })
  run(dir, 'wake', wakeInput('failed-wait-reselection'))
  run(dir, 'sync', { owner, complete: true, prs: [claim.snapshot, pr(2)] })
  const other = next(dir)
  assert.equal(other.number, 2)
  run(dir, 'save', saveInput(other, { phase: 'blocked' }))
  run(dir, 'sync', { owner, complete: true, prs: [claim.snapshot, pr(2, { reviewKey: key(2) })] })
  const pending = next(dir)
  assert.equal(pending.number, 2, 'a mutation-free recovery notice must not pin the queue ahead of pending work')
  assert.equal(pending.action, 'audit')
  run(dir, 'save', saveInput(pending, { phase: 'blocked' }))
  assert.equal(next(dir).recovery, 'resume')
  assert.equal(run(dir, 'show').prs['1'].blockedClaim.claim.claimId, claim.claimId)
})

test('EX-FAILED-WAIT-RECOVERY: completed NICE CI-only waits never become executable checkpoints', () => {
  const dir = setup(), claim = start(dir)
  run(dir, 'save', saveInput(claim, { technicalVerdict: 'NICE', reviewers: reviewers(claim) }))
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('nice-ci-only'))
  const prefix = journalBytes(dir)
  assert.equal(run(dir, 'show').prs['1'].blockedClaim, undefined)
  assert.equal(next(dir).action, 'none')
  run(dir, 'resume', resumeInput(claim), false)
  run(dir, 'retry', retryInput(claim), false)
  assert.equal(journalBytes(dir), prefix)
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
      failedReview(dir, claim, findings)
      run(dir, 'save', saveInput(claim, { phase: 'blocked', findings, reason: 'Retained failed-review stop' }))
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
    if (e.command === 'save') { const { round, ...legacy } = e.input; e.input = legacy }
    return e
  })
  const gate = { number: 1, claimId: 'historical-gate', base: snapshot.base, head: snapshot.head }
  const { round, ...legacyGateSave } = saveInput(gate, { findings, evidence: ['historical-gate.json'] })
  const at = new Date().toISOString(), envelope = version === 2 ? { version: 2 } : {}
  history.push({ ...envelope, id: gate.claimId, at, command: 'next', input: { owner, gateNumber: 1 } },
    { ...envelope, id: 'historical-gate-save', at, command: 'save',
      input: legacyGateSave })
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
    assert.equal(audit.round, !change || change.head || change.base ? 1 : 2)
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
  'H4sIAAAAAAAACu0d21LjOPadr3D5eRR0s2zxxtJ0LbX0pWh6tna2pqZ0M3gmOFnbobtrin/fshMgdnxREqcHepQXSCRL50hH5+6jP488z/99tshSMfVPvD+PPM/z/HuT5cks9U88/NPyF3Nv0iL3T7z/Vt+9Vc/23tWvifZPPJ8ajgQMGZAo0IDqIAIRMRhoISiLUMBDGPhrT4mifApDzADkAIXXGJ3A6AShCY2iX9Z7qtndnUirSZI0KdabknS+KJ6wWf04+5KarOydiiK5N6AQ+R8ArT3meX5m5rOyi/kq7uZTc2zULJvXu9zNtClXyr+ZF4ABkReZqPeYz6aJ+vbpVpS9oNWHkfoQSqQi++afeOjp14fVfw8/bbcBITRSKxQBCBUHFMUEREhCQIXkGBHKlbTcgAiSrg3Iv6VqlA1Qs3LdC+OfeEW2MPV1zdbpr7kIq07p4k5Ws6Cfmk1S5MZ+S2B9V6sRbo3QW4wgN0fIzH1ivvzLfNtimK4P2hz+RhTmYIPns0WmzNXgEVkudiZSdVt2jJOvoG20QlTb7M/mJm15XuTmysRlhzuRtHTQmYhLEovFNDcbrYusOqO3RTHPT46Pb5LidiEnanZ3XIP7eL6YTo+RX3v8Ye3br3ufPyG4YkxjEBjCAGXIAGliApTSocZKcx4Rm/OHJ5gGXecvNV93ZoDPGK5Doe+SfIWTv0jVVCR3RoNstki1v+NKhCxmJtIIYExCQCOMQMSxAhFlSCnMEZbabiWCAHetRLaQWTIOL9qLX+zHK57OWnUAzH2iTarMcZEt8qLchgrJye/5LG08ditwwPY+/iimDbacJYXJErHBf/2zD1dX52fX788/fWqcUf/N56vTf1xcXlz/p9ny6fzs81XL79fn7z5enl6fN3//+fzq4u3F2en1xYf3zbazD+8+Xp5fn7dB8Oni3cfLi7O2ma4+X//z7efL6qlRzzuhKpA6lIDHJgBUmwBwHQaAGCw5iRjEIbOjck54F5VLc1PjibsTebu89KsDf7ELA/v+B2d/Fh1ERoWQARNyBqgiCEgWx4DS0ERhSFhErLaMTAhhPxpjUo4x/RiMiQZaQKo0ENJEgMZaAi4IAWEcIy4RZxhZUjkLaBeVzxdymuS3RjvmBFukeirm+e2suRY9Zsu+Rst+p/3ABssBzZUtjJUBU6XXUBkwU/qMlD1MlIcaUc0X+e0mQQ17MoYxlyaeZdtQX9Pg3Zv62qWNUMVCTEGJ+KaoWa2I0aed/ItC/Ev3ei4p3tg4Gx672vMi8PhIm0k86Fry/hI3RnNXlnJGJ6pa4PcXZ02xuObH6d0F9Mvmgx07br+0ALXRRJ+q0La13rPc7FYknqggX0wrND+edvVpR2upLoG1GZawb4zwsDloD8Sd+s1YAD9PMAq8HVrXWNA+Dj8KrB2a4FiwPg4/Cqw92ulY8K5PMQrMPVrzWDCvTzEO/XZp82NB/DzBODS8bmMciI7XpuiCufHLr7XvDYxGFb3YiV58ENGLneh1oteJXid6nejtgPdViN6jtpad4yFBHEisDDCCQkCVEkAgpIGJtRI8otJE6/K40+1IJzDsdDvm4t44j+OmxuDPb1eTfxFJkaQ39dZH0tn0nj+L/6Iwd/Nig5B+rQ0UJ6lO0pvKZVJvKYy6TRMlpj/36C1+ZkS+jDX/ewmnF88y7+yi2ct5Zno223OemQ0qcOrhXvA69dCph049dOphD0bOM/M4gvPM1KjAid694HWi14leJ3qd6O1q3d8zI2nMKVYxCDjUgEZagAhpAzSJuNGUcy1CO88MRdC9GbKn9jBeohWJ6ObwY6VakSjo1k9+wDdDWvZJ6PMsm1X0+ub8+vTi8rer89M3v709vbg8f9P+wFuRTBdVKtUmByrRzESxetdiSQZ5C3fx/0jSR2nw7vR954Sl9+5rUpzNtGkj9nKBk5vl237pYjptND8ckOGEXMVEhwxQVCqsCCEQCRGAABkShjJWFBo7hsPD1/0qDAtEqKERAAVcAAoZBIKgEHBhBI51AAW2WolgEoWdb0U61tv2OSjrdS/lvY6X8iJCFIxJeZQYBRTT8o2PiAFGieYaCR3bcSI2CVD4qjkRRyFBXIVAC84BhRADwY0BmEVGaxMTE3CblYgmFHdyou/5utKWW/v943N7E2+gmcGIM4ADEQOqBAJcSghigZQ0AsXcWBFvNOHwJURUX/yO1QWei6ha7pmLqD4dtIAF1m7dLZbWRVSdW9e5dZ1b17l1O+F9FW7d+pyjit6/eUT1cKLXRVSd6HWi14leJ3q74H0VoveorWXnEhvIhJqpMo5KaZnrTgFnkAEOiSG4jLYiq1p7fIJ5t2fGufXttAcXUX0a7SW59Vv2yUVUd2Q4KmYcIxwCxEtXsGEccK0lgDAMdAgjriKrknp8EtLOknqvIo7BFA05ikOgjGaAch0DyWMMWEhiiRDTlNisBIYTipBjvS+G9bqI6uuIqMIAYci4ADKgCtBARIALygDTXMfSiBBxaHf+Qt5ZQ++v4UTV31UMZq2QnYKxjjGOWSRirqQOqCAxYwIGJIhDI4OQhJKaSHCCEUSKEhhzQ7CRmhFuaDl+BcsTjayKb6tZGic3a2gNsZSBYk/9Dp89y1U3S1WvVndV7jBfx8LySIoTy46ytvO+XEbMXnxBRVfp9aUVVFxjCLI8+V3OxFXh4SaHHJ2w1eskbFcp9LUS9qpwbU3gPTJybebT2be77tsf9r3uYDVDtw9/dfVDqzg2qZBTo+sKki+UMvNCpMp8zGazeGWXrRqX+vWTVEL1w9ZRorMrjeWvPGCHU7IPpmBbK9e9inWPUt2rUHcr0zsr0utHzA43f56Z3KTFhunn58ZUemiAJcRUURPhGErJoNLU4IAZrFWIRMw4k4SgspQ+ITTGwlBDZARVgAhTYa2aRjnm6UIn1dHSIoQEIlwqrRiGPNaSR1EQYYRkEBGqkYShkUgGJpYsZCYSUiAUshhJGAtRH3hqVFGdvGBdWf+mpqZpvzZLk5asKK9bEVVDOvuYzW4yk7c1diZE9WVd2eRdNTKvbHOnhlLBbDO1nr0BSzNkw9R/Cfb8Ptl6z3u+uavLs5z1BnAbeaWrx0RJ1CsWNSJdP1FAV16c1xXzGDc/zhu028alkXHoxPMsgvaet0fg3uvWLEfIm/N6FcXHT9v2e551IN/z7CJfPahaB/S99qCdBRYDwf3xkBgM8u+OQ2/AfzwMBgL/u8PfmwQwHvwDyQC7wz+YGDAeDhYJArvjMZgsMB4eFkkDu+MxkEAwHhaDiQS74zCYVDAeFhbJBV5LgoG3kWTQge3oasRmrp/n1IhDqhEdOYCeUyOcGrE1Bk6N6IDfqRFb4+HUiB9VjTjq67He+vz/mnurcux+kLnJ7jtlZksKjJzO1B9GXz36xZ696VVzdemXqhKuBlx/FjGrvsuw9inD+/3v0tq4Danz+i+X0OMSepateyX0NN3TbReDWV4NZrMSe18PNgpl7nRF2A6XhG2ub5+TuCUpddyS1PZ23RhW3Rg2nYVFt3Nx6kOWpx625dp1DWs7zk7N2N+Ga9WUemEftN7GAN3Cctse8gGbbQy4B+217aEesNTGgHrQStseagv7bAzIrWyz7aG3sMrGOaAWFtkOdD5ki41C6cN22A60PmyBjULvNtbXpu3VtLw28BtZwLe5bv+2Ar6lBPYhi2A7Ae8EvBPwPVA7AW8BvRPwDchfmYCvfW9mBA4kqeEJJ7wptFb6wFnps2xzw+znzFzLqUN1L8VR2/+P6NZzu4UqvbD19Ojc/G+xyqVcJXb6i7z0/W46O3Z2YuysHO2cV7d1JP3IW88yv1+lv6OofGnr6OH/GT+ttzaRAAA=', 'base64')).toString('utf8'))

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

// Upgrade stops BEFORE the old policy's recovery sync/next, not after its second audit.
const legacyDetailPrefix = (version = 2, admission = 'unclaimed-round') => {
  const dir = fixture()
  const events = detailRecoveryOldPolicy.journal.events.slice(0, 10).map((event) => {
    const e = structuredClone(event)
    if (version === 1) delete e.version
    if (e.command === 'next' && admission) e.admission = admission
    else delete e.admission
    return e
  })
  writeJournal(dir, events, version)
  return { dir, events, healthy: structuredClone(events.find((e) => e.command === 'published').input.snapshot) }
}

for (const [version, admission] of [[1, null], [2, null], [2, 'unclaimed-round']]) {
  for (const explicit of [false, true]) test(`EX-LEGACY-DETAIL-RECOVERY: interrupted v${version}/${admission ?? 'untagged'} prefix recovers ${explicit ? 'explicit' : 'ordinary'} gates without charges`, () => {
    const { dir, events, healthy } = legacyDetailPrefix(version, admission)
    const interrupted = run(dir, 'show'), original = interrupted.prs['1'].cycles[0]
    assert.equal(original.technicalVerdict, 'NICE')
    assert.notEqual(interrupted.prs['1'].seenAudit, original.completion.auditKey, 'old failed read really clobbered seenAudit')
    run(dir, 'autonomy', autonomyInput())
    run(dir, 'wake', wakeInput('legacy-detail-recovery'))
    const before = run(dir, 'show')
    assert.equal(next(dir).action, 'none', 'unavailable old observation remains quiet')
    run(dir, 'sync', { owner, complete: true, prs: [healthy] })
    const gate = explicit ? run(dir, 'next', { owner, gateNumber: 1 }) : next(dir)
    assert.equal(gate.action, 'check', 'identical completed generation is not a second audit')
    assert.equal(gate.round, null)
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'))).events.at(-1).admission, 'detail-read-recovery')
    run(dir, 'begin', { owner, number: 1, claimId: gate.claimId, base: gate.base, head: gate.head }, false)
    run(dir, 'save', saveInput(gate, { evidence: ['legacy-recovered-gates.json'] }))
    const recovered = run(dir, 'show'), c = recovered.prs['1'].cycles[0]
    assert.equal(c.rounds, original.rounds)
    assert.equal(c.noProgress, original.noProgress)
    assert.deepEqual(c.completion, original.completion)
    assert.deepEqual(recovered.wakes, before.wakes)
    assert.deepEqual(recovered.prs['1'].publications, before.prs['1'].publications)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, events.length), events)
    assert.equal(next(dir).action, 'none')
    run(dir, 'sync', { owner, complete: true, prs: [{ ...healthy, reviewKey: key(2) }] })
    const triage = feedbackClaim(dir)
    run(dir, 'feedback', feedbackInput(triage, { disposition: 'ACTIONABLE_FINDINGS' }))
    assert.equal(start(dir).round, 2, 'real actionable feedback still gets the next audit round')
    assert.equal(run(dir, 'show').wakes[0].chargedRounds, 1)
  })
}

test('EX-LEGACY-DETAIL-RECOVERY: original wake charge survives interrupted old read recovery', () => {
  const dir = setup()
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('old-charged-wake'))
  const { snapshot } = publishComplete(dir)
  const before = run(dir, 'show')
  run(dir, 'sync', { owner, complete: true, prs: [detailFailure(snapshot)] })
  appendHistorical(dir, 'next', { owner })
  const prefix = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  assert.notEqual(run(dir, 'show').prs['1'].seenAudit, before.prs['1'].seenAudit)
  run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
  const gate = next(dir)
  assert.equal(gate.action, 'check')
  run(dir, 'save', saveInput(gate))
  const recovered = run(dir, 'show')
  assert.deepEqual(recovered.wakes, before.wakes)
  assert.equal(recovered.wakes[0].chargedRounds, 1)
  assert.deepEqual(recovered.prs['1'].cycles, before.prs['1'].cycles)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, prefix.length), prefix)
})

for (const change of [null, { base: sha(20) }, { head: sha(20) }, { reviewKey: key(20) },
  { branch: 'other' }, { baseRef: 'release' }, { sourceRepo: 'fork/ecorp' }, { readError: 'DETAIL_READ_FAILED' }]) {
  test(`EX-LEGACY-DETAIL-RECOVERY: ${change ? JSON.stringify(change) : 'no completion'} cannot borrow an old healthy observation`, () => {
    const { dir, healthy } = legacyDetailPrefix()
    if (!change) {
      // Publication and its readback alone are not a completed review.
      const events = JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, 7)
      writeJournal(dir, events)
      run(dir, 'save', saveInput(run(dir, 'show').active))
      run(dir, 'sync', { owner, complete: true, prs: [detailFailure(healthy)] })
      appendHistorical(dir, 'next', { owner })
    }
    run(dir, 'sync', { owner, complete: true, prs: [{ ...healthy, ...change }] })
    run(dir, 'next', { owner, gateNumber: 1 }, false)
    assert.equal(next(dir).action, change?.readError ? 'blocked' : change?.sourceRepo ? 'read-only' : 'audit')
  })
}

test('EX-LEGACY-DETAIL-RECOVERY: first-ever old failed read still requires an audit', () => {
  const dir = setup([detailFailure(pr())])
  appendHistorical(dir, 'next', { owner })
  run(dir, 'sync', { owner, complete: true, prs: [pr()] })
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  assert.equal(start(dir).round, 1)
})

test('EX-LEGACY-DETAIL-RECOVERY: conflicting historical publication and completion cannot authorize recovered gates', () => {
  const { dir, snapshot } = oldTargetPublication('release')
  appendHistorical(dir, 'next', { owner, feedbackNumber: 1 })
  appendHistorical(dir, 'feedback', feedbackInput(run(dir, 'show').active))
  assert.equal(run(dir, 'show').prs['1'].cycles[0].technicalVerdict, 'NICE', 'retain old accepted unsafe NICE')
  run(dir, 'sync', { owner, complete: true, prs: [detailFailure(snapshot)] })
  appendHistorical(dir, 'next', { owner })
  const prefix = JSON.parse(readFileSync(join(dir, 'state.json'))).events
  run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  assert.equal(next(dir).action, 'audit', 'unsafe completion is not recovered audit evidence')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))).events.slice(0, prefix.length), prefix)
})

test('EX-LEGACY-DETAIL-RECOVERY: earlier detail-read-observation recovery decisions still replay unchanged', () => {
  const dir = fixture(), events = structuredClone(detailRecoveryOldPolicy.journal.events)
  for (const n of [11, 17]) events[n].admission = 'detail-read-observation'
  writeJournal(dir, events)
  const bytes = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.deepEqual(run(dir, 'show'), detailRecoveryOldPolicy.state)
  assert.equal(next(dir).action, 'none')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), bytes)
})

test('EX-LEGACY-DETAIL-RECOVERY: pending round-limit input never becomes an uncharged recovered gate', () => {
  const { dir } = roundThreePublication()
  const pending = run(dir, 'show').prs['1'].publications.at(-1).snapshot
  run(dir, 'sync', { owner, complete: true, prs: [detailFailure(pending)] })
  appendHistorical(dir, 'next', { owner })
  run(dir, 'sync', { owner, complete: true, prs: [pending] })
  appendHistorical(dir, 'next', { owner })
  const before = run(dir, 'show')
  assert.equal(before.prs['1'].pendingRoundLimit.auditKey, before.prs['1'].cycles[0].completion.auditKey,
    'even a retained matching NICE cannot discharge an old unclaimed round-limit stop')
  run(dir, 'sync', { owner, complete: true, prs: [detailFailure(pending)] })
  appendHistorical(dir, 'next', { owner })
  run(dir, 'sync', { owner, complete: true, prs: [pending] })
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  assert.equal(next(dir).reason, 'round limit exhausted')
  assert.deepEqual(run(dir, 'show').prs['1'].pendingRoundLimit, before.prs['1'].pendingRoundLimit)
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('pending-after-old-read'))
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  assert.equal(start(dir).round, 4)
})

for (const stage of ['preparation', 'charged-progress', 'charged-no-progress']) {
  test(`EX-CORRECTIVE-CLAIM-RETENTION: gate-only changes retain ${stage} through wakes and verified resume`, () => {
    const { dir, snapshot, acceptanceProof } = historicalActivation()
    const claim = stage === 'preparation' ? next(dir) : start(dir)
    let findings = []
    if (stage === 'charged-progress') {
      findings = [{ id: 'retention-fix', status: 'open', evidence: ['retention-red.log'] }]
      run(dir, 'save', saveInput(claim, { phase: 'fixing', findings }))
      findings = [{ ...findings[0], status: 'fixed', evidence: ['retention-red.log', 'retention-green.log'] }]
    }
    run(dir, 'save', saveInput(claim, { phase: 'blocked', findings, reason: 'Local validation interrupted' }))
    const before = run(dir, 'show'), prefix = journalBytes(dir), p = before.prs['1']
    assert.equal(p.cycles[0].noProgress, stage === 'charged-progress' ? 0 : stage === 'preparation' ? 1 : 2)
    for (let n = 1; n <= 2; n++) {
      run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, gateKey: key(900 + n) }, pr(2)] })
      run(dir, 'wake', wakeInput(`retention-${stage}-${n}`))
      const bytes = journalBytes(dir)
      for (let repeat = 0; repeat < 2; repeat++) {
        const selected = next(dir)
        assert.equal(selected.action, 'blocked', 'gate metadata must not allocate a replacement audit')
        assert.equal(selected.claimId, claim.claimId)
        assert.equal(selected.round, claim.round)
        assert.match(selected.reason, /resume/)
      }
      run(dir, 'next', { owner, gateNumber: 1 }, false)
      run(dir, 'next', { owner, feedbackNumber: 1 }, false)
      run(dir, 'enable', { owner, acceptanceProof }, false)
      run(dir, 'begin', { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head }, false)
      const clearance = resumeInput(claim)
      run(dir, 'resume', { ...clearance, clearance: { ...clearance.clearance, verifiedAt: '2000-01-01T00:00:00.000Z' } }, false)
      assert.equal(journalBytes(dir), bytes, 'observation and rejected recovery cannot consume pending work')
      const state = run(dir, 'show'), retained = state.prs['1']
      for (const field of ['blockedClaim', 'correctiveAudit', 'cycles', 'seen', 'seenAudit', 'selected', 'publications']) {
        assert.deepEqual(retained[field], p[field], field)
      }
      assert.equal(state.active, null)
      assert.equal(state.sequence, before.sequence)
      assert.deepEqual(state.activation, before.activation)
      assert.deepEqual(state.wakes.slice(0, before.wakes.length), before.wakes)
      assert.ok(state.wakes.slice(before.wakes.length).every((w) => w.chargedRounds === 0))
    }
    const resumed = run(dir, 'resume', resumeInput(claim))
    assert.equal(resumed.claimId, claim.claimId)
    assert.equal(resumed.round, claim.round)
    assert.equal(resumed.startedAt, claim.startedAt)
    assert.deepEqual(resumed.snapshot, claim.snapshot, 'gate observations do not rebind the retained claim')
    assert.deepEqual(run(dir, 'show').prs['1'].correctiveAudit, p.correctiveAudit)
    const begin = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head }
    if (stage === 'preparation') {
      assert.equal(run(dir, 'begin', begin).round, p.cycles[0].rounds + 1)
      assert.equal(run(dir, 'show').wakes.at(-1).chargedRounds, 1)
    } else {
      run(dir, 'begin', begin, false)
      assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, claim.round)
      assert.equal(run(dir, 'show').wakes.at(-1).chargedRounds, 0)
    }
    assertHistoryPrefix(dir, prefix)
  })
}

test('EX-CORRECTIVE-CLAIM-RETENTION: failed review stays stopped across gate changes and wakes', () => {
  const { dir, snapshot } = historicalActivation(), claim = start(dir)
  failedReview(dir, claim)
  run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
  const before = run(dir, 'show')
  assert.ok(before.prs['1'].blockedClaim.claim.failureEvidence)
  assert.equal(before.prs['1'].cycles[0].noProgress, 2)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, gateKey: key(910) }, pr(2)] })
  run(dir, 'wake', wakeInput('retention-failed-review'))
  const bytes = journalBytes(dir)
  assert.equal(next(dir).claimId, claim.claimId)
  assert.match(run(dir, 'resume', resumeInput(claim), false).error, /exhausted/)
  run(dir, 'retry', retryInput(claim), false)
  run(dir, 'next', { owner, gateNumber: 1 }, false)
  assert.equal(journalBytes(dir), bytes)
  const after = run(dir, 'show')
  assert.deepEqual(after.prs['1'].blockedClaim, before.prs['1'].blockedClaim)
  assert.deepEqual(after.prs['1'].correctiveAudit, before.prs['1'].correctiveAudit)
  assert.deepEqual(after.prs['1'].cycles, before.prs['1'].cycles)
  assert.equal(after.wakes.at(-1).chargedRounds, 0)
})

test('EX-CORRECTIVE-CLAIM-RETENTION: retained failed review below bounds still requires a charged retry', () => {
  const { dir, snapshot } = historicalActivation(), claim = start(dir)
  const findings = progressFailure(dir, claim)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', findings }))
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, gateKey: key(911) }, pr(2)] })
  const before = run(dir, 'show')
  assert.equal(next(dir).claimId, claim.claimId)
  run(dir, 'resume', resumeInput(claim))
  assert.match(run(dir, 'save', saveInput(claim, { phase: 'fixing', findings }), false).error, /retry/)
  const retry = run(dir, 'retry', retryInput(claim)), after = run(dir, 'show')
  assert.equal(retry.claimId, claim.claimId)
  assert.equal(retry.round, claim.round + 1)
  assert.equal(after.wakes.at(-1).chargedRounds, before.wakes.at(-1).chargedRounds + 1)
  assert.deepEqual(after.prs['1'].correctiveAudit, before.prs['1'].correctiveAudit)
  run(dir, 'retry', retryInput(claim), false)
})

test('EX-CORRECTIVE-CLAIM-RETENTION: changed code, feedback and scope cannot resume the retained correction', () => {
  const { dir, snapshot } = historicalActivation(), claim = next(dir)
  run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
  const prefix = journalBytes(dir), before = run(dir, 'show')
  for (const change of [
    { head: sha(920) }, { base: sha(920) }, { reviewKey: key(920) },
    { branch: 'different-source' }, { baseRef: 'different-target' },
    { sourceRepo: 'fork/ecorp' }, { sourceRepo: null }, { readError: 'DETAIL_READ_FAILED' }, { state: 'closed' },
  ]) {
    const isolated = fixture()
    writeJournal(isolated, JSON.parse(prefix).events)
    run(isolated, 'sync', { owner, complete: true, prs: [{ ...snapshot, ...change }, pr(2)] })
    run(isolated, 'resume', resumeInput(claim), false)
    const selected = next(isolated), state = run(isolated, 'show')
    assert.notEqual(selected.claimId, claim.claimId, 'conflicting input is not eligible for exact recovery')
    assert.deepEqual(state.prs['1'].blockedClaim, before.prs['1'].blockedClaim)
    assert.deepEqual(state.prs['1'].cycles, before.prs['1'].cycles)
    assert.deepEqual(state.wakes, before.wakes)
    if (change.head || change.base || change.reviewKey || change.branch || change.baseRef) {
      assert.equal(selected.action, 'audit', 'genuinely changed input still gets bounded current-scope work')
      assert.deepEqual(selected.snapshot, { ...snapshot, ...change })
    } else assert.notEqual(selected.action, 'audit')
    assertHistoryPrefix(isolated, prefix)
  }
})

for (const activated of [false, true]) {
  test(`EX-CORRECTIVE-CLAIM-RETENTION: ordinary blocked claim keeps gate checks, valid activation=${activated}`, () => {
    const dir = setup()
    if (activated) {
      const published = publishComplete(dir)
      run(dir, 'enable', { owner, acceptanceProof: proof(published.claim, published.receipts) })
      run(dir, 'sync', { owner, complete: true, prs: [pr(1, { head: published.snapshot.head, reviewKey: key(2) })] })
    }
    const claim = start(dir)
    run(dir, 'save', saveInput(claim, { phase: 'blocked' }))
    const before = run(dir, 'show')
    run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, gateKey: key(930) }] })
    const gate = next(dir)
    assert.equal(gate.action, 'check')
    run(dir, 'save', saveInput(gate, { phase: 'blocked' }))
    const state = run(dir, 'show')
    assert.deepEqual(state.prs['1'].blockedClaim, before.prs['1'].blockedClaim)
    assert.equal(state.prs['1'].cycles[0].rounds, before.prs['1'].cycles[0].rounds)
    assert.equal(state.prs['1'].cycles[0].noProgress, before.prs['1'].cycles[0].noProgress)
    assert.equal(run(dir, 'resume', resumeInput(claim)).claimId, claim.claimId)
  })
}

test('EX-CORRECTIVE-CLAIM-RETENTION: old canaryRecovery replacement and dependent charge replay unchanged', () => {
  const { dir, snapshot } = historicalActivation(), claim = start(dir)
  const findings = [{ id: 'historical-retention-fix', status: 'open', evidence: ['red.log'] }]
  run(dir, 'save', saveInput(claim, { phase: 'fixing', findings }))
  const fixed = [{ ...findings[0], status: 'fixed', evidence: ['red.log', 'green.log'] }]
  run(dir, 'save', saveInput(claim, { phase: 'blocked', findings: fixed }))
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, gateKey: key(940) }, pr(2)] })
  const events = JSON.parse(journalBytes(dir)).events
  const id = 'historical-corrective-replacement'
  events.push({ version: 2, id, at: new Date().toISOString(), command: 'next',
    input: { owner }, admission: 'detail-read-recovery', activationFence: true, canaryRecovery: true })
  writeJournal(dir, events)
  const replacement = run(dir, 'show').active
  assert.equal(replacement.claimId, id)
  assert.equal(replacement.action, 'audit')
  appendHistorical(dir, 'begin', { owner, number: 1, claimId: id, base: replacement.base, head: replacement.head })
  appendHistorical(dir, 'save', saveInput(replacement, { phase: 'blocked', findings: fixed }))
  const bytes = journalBytes(dir), before = run(dir, 'show')
  assert.equal(before.prs['1'].cycles[0].rounds, claim.round + 1)
  assert.equal(before.prs['1'].correctiveAudit.claimId, id)
  assert.equal(before.prs['1'].blockedClaim.claim.claimId, id)
  assert.equal(before.wakes.at(-1).chargedRounds, 2, 'historical duplicate charges are never refunded')
  assert.deepEqual(run(dir, 'show'), before)
  assert.equal(journalBytes(dir), bytes)
  run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, gateKey: key(941) }, pr(2)] })
  assert.equal(next(dir).claimId, id, 'only new admission is guarded; retain the historically current claim')
  assert.equal(run(dir, 'resume', resumeInput({ ...replacement, round: claim.round + 1 })).claimId, id)
  assertHistoryPrefix(dir, bytes)
})

for (const phase of ['auditing', 'fixing', 'waiting', 'blocked', 'complete']) {
  test(`EX-TERMINAL-FAILURE: first ${phase}/NAUGHTY requires canonical admission before persistence`, () => {
    const dir = setup(), claim = start(dir)
    run(dir, 'save', saveInput(claim, { phase: 'reviewing', reason: 'Review dispatched' }))
    const bytes = journalBytes(dir)
    run(dir, 'save', saveInput(claim, { phase, technicalVerdict: 'NAUGHTY',
      evidence: ['first-failed-review.json'], reason: 'Reviewer A failed; reviewer B unavailable' }), false)
    assert.equal(journalBytes(dir), bytes)
    assert.equal(run(dir, 'show').active.startedAt, claim.startedAt)
  })
}

test('EX-TERMINAL-FAILURE: canonical failure plus unavailable second reviewer resumes only to charged retry', () => {
  const dir = setup()
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('terminal-failure'))
  const claim = start(dir), findings = [{ id: 'still-open', status: 'open', evidence: ['red.log'] }]
  const receipt = saveInput(claim, { phase: 'reviewing', technicalVerdict: 'NAUGHTY',
    findings, evidence: ['first-failed-review.json'], reason: 'Reviewer A failed' })
  run(dir, 'save', receipt)
  const ack = journalBytes(dir)
  run(dir, 'save', receipt)
  assert.equal(journalBytes(dir), ack, 'canonical failed receipt ACK stays a no-op')
  run(dir, 'save', saveInput(claim, { phase: 'blocked', technicalVerdict: 'NAUGHTY',
    findings, evidence: ['reviewer-b-unavailable.json'], reason: 'Reviewer B unavailable; A remains failed' }))
  const blocked = run(dir, 'show'), prefix = journalBytes(dir)
  assert.equal(blocked.prs['1'].cycles[0].phase, 'blocked')
  assert.equal(blocked.prs['1'].cycles[0].technicalVerdict, 'NAUGHTY')
  assert.deepEqual(blocked.prs['1'].blockedClaim.claim.failureEvidence, receipt.evidence)
  const resumed = run(dir, 'resume', resumeInput(claim))
  assert.equal(resumed.round, 1)
  assert.equal(resumed.startedAt, claim.startedAt)
  for (const phase of ['auditing', 'fixing', 'reviewing']) {
    assert.match(run(dir, 'save', saveInput(claim, { phase, findings }), false).error, /explicit retry/)
  }
  const candidate = { ...claim.snapshot, head: sha(12) }
  bindRubric(dir, candidate)
  const stale = reviewers({ ...claim, head: candidate.head })
  const publication = { owner, number: 1, claimId: claim.claimId, base: claim.base, head: claim.head,
    snapshot: candidate, reviewers: stale, push: { repo, branch: candidate.branch,
      before: claim.head, head: candidate.head, sourceRef: 'push.json', pushedAt: new Date().toISOString() } }
  const unchanged = journalBytes(dir)
  assert.match(run(dir, 'published', publication, false).error, /explicit retry/)
  assert.equal(journalBytes(dir), unchanged)
  const retried = run(dir, 'retry', retryInput(claim, receipt.evidence[0]))
  assert.equal(retried.round, 2)
  assert.ok(retried.startedAt > claim.startedAt)
  assert.equal(run(dir, 'show').wakes[0].chargedRounds, 2)
  run(dir, 'retry', retryInput(claim, receipt.evidence[0]), false)
  run(dir, 'published', publication, false)
  const fixed = findings.map((f) => ({ ...f, status: 'fixed', evidence: [...f.evidence, 'green.log'] }))
  run(dir, 'save', saveInput(retried, { phase: 'fixing', findings: fixed }))
  const freshReviews = reviewers({ ...retried, head: candidate.head })
  const published = run(dir, 'published', { ...publication, reviewers: freshReviews,
    push: { ...publication.push, pushedAt: new Date().toISOString() } })
  run(dir, 'save', saveInput(published, { phase: 'complete', technicalVerdict: 'NICE',
    findings: fixed, reviewers: freshReviews }))
  assertHistoryPrefix(dir, prefix)
})

for (const version of [1, 2]) for (const phase of ['auditing', 'fixing', 'reviewing', 'waiting', 'blocked']) {
  test(`EX-TERMINAL-FAILURE: old v${version} first ${phase}/NAUGHTY remains readable but needs a new charge`, () => {
    const dir = setup(), claim = start(dir)
    const findings = [{ id: 'historical-open', status: 'open', evidence: ['historical-red.log'] }]
    const failure = saveInput(claim, { phase, technicalVerdict: 'NAUGHTY', findings,
      evidence: ['historical-failed-review.json'], reason: 'Old accepted first failed review' })
    appendHistorical(dir, 'save', failure)
    const old = JSON.parse(journalBytes(dir)).events
    if (version === 1) writeJournal(dir, old.map(({ version, admission, ...e }) => e), 1)
    const prefix = journalBytes(dir), before = run(dir, 'show')
    assert.equal(journalBytes(dir), prefix, 'read never rewrites original accepted history')
    assert.equal(before.prs['1'].cycles[0].phase, phase)
    assert.equal(before.prs['1'].cycles[0].technicalVerdict, 'NAUGHTY')
    if (phase === 'waiting') {
      const gate = run(dir, 'next', { owner, gateNumber: 1 })
      run(dir, 'begin', { owner, number: 1, claimId: gate.claimId, base: gate.base, head: gate.head }, false)
      run(dir, 'save', saveInput(gate, { phase: 'fixing', findings }), false)
      run(dir, 'save', saveInput(gate, { findings }))
      run(dir, 'sync', { owner, complete: true, prs: [pr(1, { reviewKey: key(2) })] })
      assert.equal(start(dir).round, 2, 'new audit input charges rather than resuming terminal waiting')
    } else {
      if (phase === 'blocked') run(dir, 'resume', resumeInput(claim))
      const active = next(dir)
      assert.equal(active.startedAt, claim.startedAt)
      const bytes = journalBytes(dir)
      for (const nextPhase of ['auditing', 'fixing', 'reviewing']) {
        assert.match(run(dir, 'save', saveInput(active, { phase: nextPhase, findings }), false).error, /explicit retry/)
      }
      assert.equal(journalBytes(dir), bytes)
      const retry = retryInput(active, failure.evidence[0])
      run(dir, 'retry', { ...retry, reviewRef: 'not-the-failure.json' }, false)
      const retried = run(dir, 'retry', retry)
      assert.equal(retried.round, 2)
      assert.ok(retried.startedAt > claim.startedAt)
      assert.equal(run(dir, 'show').prs['1'].cycles[0].noProgress, 2)
      run(dir, 'save', saveInput(retried, { phase: 'fixing', findings }))
      failedReview(dir, retried, findings)
      run(dir, 'save', saveInput(retried, { phase: 'blocked', findings, technicalVerdict: 'NAUGHTY' }))
      assert.match(run(dir, 'resume', resumeInput(retried), false).error, /exhausted/)
    }
    assertHistoryPrefix(dir, prefix)
  })
}

test('EX-TERMINAL-FAILURE: five old accepted bypass cycles retain history but cannot admit a sixth', () => {
  const dir = setup()
  run(dir, 'autonomy', autonomyInput())
  run(dir, 'wake', wakeInput('old-terminal-bypass'))
  const claim = start(dir), findings = [{ id: 'unfixed', status: 'open', evidence: ['red.log'] }]
  for (let n = 1; n <= 5; n++) {
    appendHistorical(dir, 'save', saveInput(claim, { phase: 'reviewing', findings }))
    appendHistorical(dir, 'save', saveInput(claim, { phase: 'blocked', technicalVerdict: 'NAUGHTY',
      findings, evidence: [`old-failure-${n}.json`] }))
    appendHistorical(dir, 'resume', resumeInput(claim))
    appendHistorical(dir, 'save', saveInput(claim, { phase: 'fixing', findings }))
  }
  const prefix = journalBytes(dir), before = run(dir, 'show')
  assert.equal(before.active.startedAt, claim.startedAt)
  assert.equal(before.prs['1'].cycles[0].phase, 'fixing')
  assert.equal(before.prs['1'].cycles[0].technicalVerdict, null)
  assert.equal(before.prs['1'].cycles[0].rounds, 1)
  assert.equal(before.wakes[0].chargedRounds, 1)
  assert.equal(journalBytes(dir), prefix)
  for (const phase of ['fixing', 'auditing', 'reviewing']) {
    assert.match(run(dir, 'save', saveInput(claim, { phase, findings }), false).error, /explicit retry/)
  }
  const candidate = { ...claim.snapshot, head: sha(12) }
  assert.match(run(dir, 'published', { owner, number: 1, claimId: claim.claimId,
    base: claim.base, head: claim.head, snapshot: candidate, reviewers: reviewers(candidate),
    push: { repo, branch: candidate.branch, before: claim.head, head: candidate.head,
      sourceRef: 'new-push.json', pushedAt: new Date().toISOString() } }, false).error, /explicit retry/)
  assert.equal(journalBytes(dir), prefix)
  run(dir, 'save', saveInput(claim, { phase: 'blocked', findings }))
  const resumed = run(dir, 'resume', resumeInput(claim))
  assert.equal(resumed.startedAt, claim.startedAt)
  const retried = run(dir, 'retry', retryInput(claim, 'old-failure-1.json'))
  assert.equal(retried.round, 2)
  assert.equal(run(dir, 'show').wakes[0].chargedRounds, 2)
  assert.equal(run(dir, 'show').prs['1'].cycles[0].noProgress, 2)
  assertHistoryPrefix(dir, prefix)
})

test('EX-TERMINAL-FAILURE: technical-null tool/prose blocks resume the existing charge, caller fields grant no provenance', () => {
  const dir = setup(), claim = start(dir)
  run(dir, 'save', saveInput(claim, { phase: 'blocked',
    reason: 'NAUGHTY appears in tool output, not a technical decision' }))
  const resumed = run(dir, 'resume', resumeInput(claim))
  assert.equal(resumed.round, 1)
  assert.equal(resumed.startedAt, claim.startedAt)
  run(dir, 'save', saveInput(resumed, { phase: 'fixing' }))
  for (const extra of [{ failureReceiptVersion: 1 }, { failureEvidence: ['fake.json'] },
    { failureReceipt: {} }, { failedReviews: {} }, { legacy: true }]) {
    assert.match(run(dir, 'save', saveInput(resumed, { phase: 'fixing', ...extra }), false).error, /fields/)
  }
  run(dir, 'retry', retryInput(resumed), false)
  assert.equal(run(dir, 'show').prs['1'].cycles[0].rounds, 1)
})

test('EX-TERMINAL-FAILURE: old failure hidden by null checkpoints cannot use unfinished-charge bounds', () => {
  const dir = setup(), first = start(dir)
  failedReview(dir, first)
  const claim = run(dir, 'retry', retryInput(first))
  appendHistorical(dir, 'save', saveInput(claim, { phase: 'fixing', technicalVerdict: 'NAUGHTY',
    evidence: ['old-terminal-failure.json'] }))
  appendHistorical(dir, 'save', saveInput(claim, { phase: 'fixing' }))
  appendHistorical(dir, 'save', saveInput(claim, { phase: 'blocked' }))
  const prefix = journalBytes(dir), state = run(dir, 'show')
  assert.equal(state.prs['1'].cycles[0].noProgress, 2)
  assert.equal(state.prs['1'].cycles[0].technicalVerdict, null, 'accepted old projection stays unchanged')
  assert.equal(state.prs['1'].blockedClaim.claim.failureEvidence, null)
  assert.match(run(dir, 'resume', resumeInput(claim), false).error, /exhausted/)
  assert.equal(journalBytes(dir), prefix)
})

test('EX-TERMINAL-FAILURE: old terminal failure retry honors batch capacity without another permission', () => {
  const dir = setup()
  const authority = autonomyInput()
  run(dir, 'autonomy', authority)
  run(dir, 'wake', wakeInput('first-terminal-batch'))
  let claim = start(dir), findings = []
  for (let round = 1; round < 3; round++) {
    findings = progressFailure(dir, claim, findings)
    claim = run(dir, 'retry', retryInput(claim))
  }
  appendHistorical(dir, 'save', saveInput(claim, { phase: 'blocked', technicalVerdict: 'NAUGHTY',
    findings, evidence: ['old-first-terminal-failure.json'] }))
  const prefix = journalBytes(dir)
  const resumed = run(dir, 'resume', resumeInput(claim))
  assert.equal(resumed.startedAt, claim.startedAt)
  const retry = retryInput(claim, 'old-first-terminal-failure.json')
  assert.match(run(dir, 'retry', retry, false).error, /wake/)
  run(dir, 'save', saveInput(claim, { phase: 'fixing', findings }), false)
  run(dir, 'wake', wakeInput('second-terminal-batch'))
  assert.equal(run(dir, 'retry', retry).round, 4)
  const state = run(dir, 'show')
  assert.deepEqual(state.wakes.map((w) => w.chargedRounds), [3, 1])
  assert.deepEqual(state.autonomy.input, authority)
  assert.equal(state.prs['1'].cycles.length, 1)
  assertHistoryPrefix(dir, prefix)
})

for (const autonomous of [false, true]) {
  test(`EX-SAVE-ATTEMPT-FENCE: byte-identical F1 after same-head retry cannot poison round 2, autonomy=${autonomous}`, () => {
    const dir = setup()
    if (autonomous) {
      run(dir, 'autonomy', autonomyInput())
      run(dir, 'wake', wakeInput('save-attempt'))
    }
    const first = start(dir), open = { id: 'SA10-01', status: 'open', evidence: ['round-1-red.log'] }
    const failure = saveInput(first, { phase: 'reviewing', technicalVerdict: 'NAUGHTY',
      findings: [open], evidence: ['round-1-failed-review.json'], reason: 'Round 1 independent reviewer failed' })
    const f1 = JSON.stringify(failure)
    run(dir, 'save', JSON.parse(f1))
    const ack = journalBytes(dir)
    run(dir, 'save', JSON.parse(f1))
    assert.equal(journalBytes(dir), ack, 'same-attempt canonical failure ACK is still a no-op')
    const second = run(dir, 'retry', retryInput(first, failure.evidence[0]))
    for (const field of ['claimId', 'base', 'head']) assert.equal(second[field], first[field])
    assert.equal(second.round, 2)
    const before = run(dir, 'show'), bytes = journalBytes(dir)
    assert.equal(before.active.failureEvidence, null)
    assert.equal(before.prs['1'].cycles[0].noProgress, 2)
    assert.match(run(dir, 'save', JSON.parse(f1), false).error, /round/)
    assert.equal(journalBytes(dir), bytes, 'stale failure cannot append or change the current charge')
    assert.deepEqual(run(dir, 'show'), before, 'failure receipt, findings, noProgress and wake charges stay exact')

    const fixed = { ...open, status: 'fixed', evidence: [...open.evidence, 'round-2-green.log'] }
    run(dir, 'save', saveInput(second, { phase: 'fixing', findings: [fixed], evidence: ['round-2-green.log'] }))
    run(dir, 'save', saveInput(second, { phase: 'reviewing', findings: [fixed], evidence: ['round-2-review.json'] }))
    run(dir, 'save', saveInput(second, { phase: 'complete', findings: [fixed],
      technicalVerdict: 'NICE', reviewers: reviewers(second) }))
    const after = run(dir, 'show'), c = after.prs['1'].cycles[0]
    assert.equal(c.technicalVerdict, 'NICE', 'old failure cannot trip the breaker before real round-2 correction/review')
    assert.equal(c.rounds, 2)
    assert.equal(c.noProgress, 0, 'only verified round-2 progress clears the pessimistic counter')
    assert.deepEqual(after.wakes, before.wakes)
    assertHistoryPrefix(dir, bytes)
  })
}

test('EX-SAVE-ATTEMPT-FENCE: every delayed phase including NICE is fenced before any mutation', () => {
  const dir = setup(), first = start(dir)
  failedReview(dir, first)
  const second = run(dir, 'retry', retryInput(first))
  const before = run(dir, 'show'), bytes = journalBytes(dir)
  for (const [phase, technicalVerdict] of [
    ['auditing', null], ['fixing', null], ['reviewing', null],
    ['waiting', null], ['blocked', null], ['waiting', 'NICE'], ['complete', 'NICE'],
  ]) {
    const input = saveInput(first, { phase, technicalVerdict,
      ...(technicalVerdict === 'NICE' ? { reviewers: reviewers(second) } : {}) })
    assert.match(run(dir, 'save', input, false).error, /round/, `${phase}/${technicalVerdict}`)
    assert.equal(journalBytes(dir), bytes)
    assert.deepEqual(run(dir, 'show'), before)
    // Identical payload with the actual dispatched round is otherwise admissible.
    const current = fixture()
    writeJournal(current, JSON.parse(bytes).events)
    run(current, 'save', { ...input, round: second.round })
    assert.equal(run(current, 'show').prs['1'].cycles[0].phase, phase)
  }
})

test('EX-SAVE-ATTEMPT-FENCE: missing and malformed rounds cannot enter live saves or borrow legacy admission', () => {
  const dir = setup(), claim = start(dir), before = run(dir, 'show'), bytes = journalBytes(dir)
  for (const round of [undefined, null, 0, -1, 1.5, '1', false, {}, [], Number.MAX_SAFE_INTEGER + 1, 2]) {
    assert.match(run(dir, 'save', saveInput(claim, { phase: 'fixing', round }), false).error, /round/)
    assert.equal(journalBytes(dir), bytes)
  }
  for (const extra of [{ live: false }, { legacy: true }, { version: 1 }, { eventVersion: 1 }]) {
    assert.match(run(dir, 'save', saveInput(claim, { phase: 'fixing', round: undefined, ...extra }), false).error, /fields/)
    assert.equal(journalBytes(dir), bytes)
  }
  assert.deepEqual(run(dir, 'show'), before)
  run(dir, 'save', saveInput(claim, { phase: 'fixing' }))
  assert.equal(run(dir, 'show').active.round, 1)
})

test('EX-SAVE-ATTEMPT-FENCE: explicit null gates preserve charges; stale prebegin null cannot save a charged attempt', () => {
  const dir = setup(), uncharged = next(dir), pending = saveInput(uncharged, { phase: 'blocked' })
  assert.equal(pending.round, null)
  const claim = run(dir, 'begin', beginInput(uncharged)), bytes = journalBytes(dir)
  assert.match(run(dir, 'save', pending, false).error, /round/)
  assert.equal(journalBytes(dir), bytes)
  run(dir, 'save', saveInput(claim))
  for (const phase of ['waiting', 'blocked']) {
    const gate = run(dir, 'next', { owner, gateNumber: 1 }), before = run(dir, 'show'), bytes = journalBytes(dir)
    assert.equal(gate.round, null)
    for (const round of [undefined, 0, 1, 'null']) {
      assert.match(run(dir, 'save', saveInput(gate, { phase, round }), false).error, /round/)
      assert.equal(journalBytes(dir), bytes)
    }
    run(dir, 'save', saveInput(gate, { phase, round: null }))
    const after = run(dir, 'show')
    assert.equal(after.active, null)
    assert.deepEqual(after.prs['1'].cycles, before.prs['1'].cycles.map((c) => ({ ...c, phase })))
  }
})

for (const version of [1, 2]) {
  test(`EX-SAVE-ATTEMPT-FENCE: old accepted v${version} stale failure replays deeply unchanged and missing round stays replay-only`, () => {
    const dir = setup(), first = start(dir)
    const { round, ...failure } = saveInput(first, { phase: 'reviewing', technicalVerdict: 'NAUGHTY',
      evidence: ['old-F1.json'], reason: 'Old accepted round-1 failure' })
    appendHistorical(dir, 'save', failure)
    const second = run(dir, 'retry', retryInput(first, failure.evidence[0]))
    const before = run(dir, 'show')
    appendHistorical(dir, 'save', failure) // Historically admitted stale F1; never a new live call.
    if (version === 1) {
      writeJournal(dir, JSON.parse(journalBytes(dir)).events.map(({ version, admission, ...e }) => e), 1)
    }
    const bytes = journalBytes(dir), p = before.prs['1']
    const expected = { ...before, events: before.events + 1,
      active: { ...before.active, failureEvidence: failure.evidence, failureReceipt: failure, failureReceiptVersion: version },
      prs: { ...before.prs, '1': { ...p, cycles: p.cycles.map((c) => ({
        ...c, phase: failure.phase, technicalVerdict: failure.technicalVerdict, reason: failure.reason,
      })) } },
    }
    assert.equal(expected.active.round, second.round)
    assert.equal(expected.prs['1'].cycles[0].noProgress, 2, 'old accepted accounting is not repaired or refunded')
    for (let read = 0; read < 2; read++) {
      assert.deepEqual(run(dir, 'show'), expected)
      assert.equal(journalBytes(dir), bytes)
    }
    assert.match(run(dir, 'save', failure, false).error, /round/, 'old input cannot select replay compatibility live')
    assert.equal(journalBytes(dir), bytes)
    assert.deepEqual(run(dir, 'show'), expected)
  })
}

// Synthetic owned histories only: these receipts test accounting, not actual reviews.
const baseRenewalNiceHistory = (rounds = 1, autonomous = false) => {
  const dir = setup()
  if (autonomous) {
    run(dir, 'autonomy', autonomyInput())
    run(dir, 'wake', wakeInput('base-renewal-initial'))
  }
  let claim, findings = []
  for (let round = 1; round <= rounds; round++) {
    run(dir, 'sync', { owner, complete: true, prs: [pr(1, { reviewKey: key(round) })] })
    claim = start(dir)
    if (rounds === 3 && round === 1) {
      const open = { id: 'synthetic-progress', status: 'open', evidence: ['synthetic-red.log'] }
      run(dir, 'save', saveInput(claim, { phase: 'fixing', findings: [open] }))
      findings = [{ ...open, status: 'fixed', evidence: [...open.evidence, 'synthetic-green.log'] }]
    }
    run(dir, 'save', saveInput(claim, { findings, ...(round === rounds
      ? { phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(claim) } : {}) }))
  }
  return { dir, claim, findings }
}

for (const autonomous of [false, true]) {
  test(`F2-BASE-ONLY-CYCLE-RENEWAL: repeated base-only and mixed revisions renew only after NICE, autonomy=${autonomous}`, () => {
    const { dir, claim } = baseRenewalNiceHistory(1, autonomous)
    let previous = run(dir, 'show').prs['1'].cycles
    for (const change of [{ base: sha(20) }, { base: sha(30) }, { base: sha(30), head: sha(40) },
      { base: sha(50), head: sha(60) }]) {
      const snapshot = { ...claim.snapshot, ...change }
      run(dir, 'sync', { owner, complete: true, prs: [snapshot] })
      if (autonomous && previous.length === 3) {
        const bytes = journalBytes(dir)
        assert.equal(next(dir).action, 'wait', 'a fresh cycle cannot reset the native wake cap')
        assert.equal(journalBytes(dir), bytes)
        run(dir, 'wake', wakeInput('base-renewal-next'))
      }
      const selected = next(dir)
      assert.equal(selected.action, 'audit')
      assert.deepEqual(run(dir, 'show').prs['1'].cycles, previous, 'next never resets counters')
      bindRubric(dir, selected)
      const started = run(dir, 'begin', beginInput(selected))
      assert.equal(started.round, 1)
      const state = run(dir, 'show'), cycles = state.prs['1'].cycles
      assert.deepEqual(cycles.slice(0, -1), previous)
      assert.equal(cycles.at(-1).noProgress, 1)
      assert.equal(cycles.at(-1).completion, null)
      assert.equal(cycles.at(-1).technicalVerdict, null)
      assert.deepEqual([started.base, started.head], [snapshot.base, snapshot.head])
      run(dir, 'save', saveInput(started, { phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(started) }))
      previous = run(dir, 'show').prs['1'].cycles
      assert.equal(next(dir).action, autonomous && previous.length === 3 ? 'wait' : 'none')
    }
    const state = run(dir, 'show')
    assert.deepEqual(state.prs['1'].cycles.map((c) => [c.rounds, c.noProgress]), Array(5).fill([1, 1]))
    if (autonomous) assert.deepEqual(state.wakes.map((w) => w.chargedRounds), [3, 2])
  })

  for (const rounds of [2, 3]) test(`F2-BASE-ONLY-CYCLE-RENEWAL: bounded NICE round ${rounds} admits next and uncharged resume/begin, autonomy=${autonomous}`, () => {
    const { dir, claim, findings } = baseRenewalNiceHistory(rounds, autonomous)
    const completed = run(dir, 'show').prs['1'].cycles[0]
    assert.equal(completed.rounds, rounds)
    assert.equal(completed.noProgress, 2)
    if (autonomous && rounds === 3) run(dir, 'wake', wakeInput('base-renewal-at-bound'))
    run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, base: sha(20) }] })
    const selected = next(dir)
    assert.equal(selected.action, 'audit')
    assert.equal(selected.round, null)
    assert.deepEqual(run(dir, 'show').prs['1'].cycles, [completed])
    run(dir, 'save', saveInput(selected, { phase: 'blocked', findings }))
    const blocked = run(dir, 'show'), bytes = journalBytes(dir)
    const resumed = run(dir, 'resume', resumeInput(selected)), recovered = run(dir, 'show')
    assert.equal(resumed.claimId, selected.claimId)
    assert.equal(resumed.round, null)
    assert.equal(resumed.startedAt, null)
    assert.equal(recovered.prs['1'].cycles.length, 1)
    for (const field of ['rounds', 'noProgress', 'findings', 'completion', 'technicalVerdict', 'phase', 'reason']) {
      assert.deepEqual(recovered.prs['1'].cycles[0][field], completed[field], field)
    }
    assert.deepEqual(recovered.wakes, blocked.wakes, 'resume cannot charge or reset a wake')
    const started = run(dir, 'begin', beginInput(resumed)), after = run(dir, 'show')
    assert.equal(started.round, 1)
    assert.deepEqual(after.prs['1'].cycles[0], recovered.prs['1'].cycles[0])
    assert.equal(after.prs['1'].cycles[1].noProgress, 1)
    if (autonomous) assert.equal(after.wakes.at(-1).chargedRounds, blocked.wakes.at(-1).chargedRounds + 1)
    assertHistoryPrefix(dir, bytes)
    run(dir, 'begin', beginInput(resumed), false)
    assert.deepEqual(run(dir, 'show'), after)
  })

  for (const verdict of ['NAUGHTY', null]) test(`F2-BASE-ONLY-CYCLE-RENEWAL: failed ${verdict} cycles cannot renew, autonomy=${autonomous}`, () => {
    const dir = setup()
    if (autonomous) {
      run(dir, 'autonomy', autonomyInput())
      run(dir, 'wake', wakeInput('failed-base-renewal'))
    }
    const first = start(dir)
    failedReview(dir, first)
    run(dir, 'save', saveInput(first, { phase: 'blocked', technicalVerdict: verdict }))
    for (const base of [sha(20), sha(30)]) {
      run(dir, 'sync', { owner, complete: true, prs: [pr(1, { base })] })
      const selected = next(dir)
      if (base === sha(20)) {
        const second = run(dir, 'begin', beginInput(selected))
        assert.equal(second.round, 2)
        run(dir, 'save', saveInput(second, { phase: 'blocked' }))
      } else {
        assert.equal(selected.action, 'blocked')
        assert.match(selected.reason, /no-progress/)
      }
    }
    const state = run(dir, 'show')
    assert.deepEqual(state.prs['1'].cycles.map((c) => [c.rounds, c.noProgress]), [[2, 2]])
    if (autonomous) assert.equal(state.wakes[0].chargedRounds, 2)
  })

  test(`F2-BASE-ONLY-CYCLE-RENEWAL: same base/head feedback retains the original bound, autonomy=${autonomous}`, () => {
    const { dir, claim } = baseRenewalNiceHistory(1, autonomous)
    assert.equal(next(dir).action, 'none')
    run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, reviewKey: key(2) }] })
    const second = start(dir)
    assert.equal(second.round, 2)
    run(dir, 'save', saveInput(second, { phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(second) }))
    run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, reviewKey: key(3) }] })
    assert.match(next(dir).reason, /no-progress/)
    assert.deepEqual(run(dir, 'show').prs['1'].cycles.map((c) => [c.rounds, c.noProgress]), [[2, 2]])
  })
}

for (const activated of [false, true]) {
  test(`F2-BASE-ONLY-CYCLE-RENEWAL: ${activated ? 'invalid activation' : 'canonical publication correction'} cannot renew a base-only diff`, () => {
    const { dir, snapshot } = activated ? historicalActivation() : historicalPreactivation()
    run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, base: sha(20) }] })
    const selected = next(dir), old = run(dir, 'show')
    run(dir, 'save', saveInput(selected, { phase: 'blocked' }))
    const resumed = run(dir, 'resume', resumeInput(selected))
    const started = run(dir, 'begin', beginInput(resumed))
    assert.equal(started.round, 2, 'historical conflicted NICE is not normal completed-cycle authority')
    bindRubric(dir, started)
    run(dir, 'save', saveInput(started, { phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(started) }))
    const bounded = run(dir, 'show')
    assert.deepEqual(bounded.prs['1'].cycles.map((c) => [c.rounds, c.noProgress]), [[2, 2]])
    assert.equal(bounded.wakes.at(-1).chargedRounds, old.wakes.at(-1).chargedRounds + 1)
    run(dir, 'sync', { owner, complete: true, prs: [{ ...snapshot, base: sha(30) }] })
    assert.match(next(dir).reason, /no-progress/)
    assert.equal(run(dir, 'show').prs['1'].cycles.length, 1)
  })
}

for (const [version, admission] of [[1, undefined], [2, undefined], [2, 'unclaimed-round'],
  [2, 'detail-read-observation'], [2, 'detail-read-recovery']]) {
  for (const stage of ['accepted', 'claimed', 'blocked']) {
    test(`F2-BASE-ONLY-CYCLE-RENEWAL: old v${version}/${admission ?? 'untagged'} base-only ${stage} prefix keeps its decisions across upgrade`, () => {
      const { dir, claim } = baseRenewalNiceHistory()
      run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, base: sha(20) }] })
      appendHistorical(dir, 'next', { owner })
      const events = JSON.parse(journalBytes(dir)).events
      if (admission) events.at(-1).admission = admission
      else delete events.at(-1).admission
      writeJournal(dir, events)
      const selected = run(dir, 'show').active
      assert.equal(selected.claimId, events.at(-1).id)
      bindRubric(dir, selected)
      if (stage === 'accepted') {
        appendHistorical(dir, 'begin', beginInput(selected))
        const charged = run(dir, 'show').active
        assert.equal(charged.round, 2, 'old accepted base-only begin keeps the original cycle')
        appendHistorical(dir, 'save', saveInput(charged, {
          phase: 'complete', technicalVerdict: 'NICE', reviewers: reviewers(charged),
        }))
      } else if (stage === 'blocked') appendHistorical(dir, 'save', saveInput(selected, { phase: 'blocked' }))
      if (version === 1) {
        writeJournal(dir, JSON.parse(journalBytes(dir)).events.map(({ version, admission, ...e }) => e), 1)
      }
      const bytes = journalBytes(dir), before = run(dir, 'show')
      assert.equal(before.prs['1'].cycles.length, 1)
      assert.equal(before.prs['1'].cycles[0].rounds, stage === 'accepted' ? 2 : 1)
      assert.deepEqual(run(dir, 'show'), before)
      assert.equal(journalBytes(dir), bytes)
      let pending = selected
      if (stage === 'accepted') {
        run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, base: sha(30) }] })
        pending = next(dir)
        assert.equal(pending.action, 'audit')
      } else if (stage === 'blocked') pending = run(dir, 'resume', resumeInput(selected))
      const recovered = run(dir, 'show')
      const started = run(dir, 'begin', beginInput(pending)), after = run(dir, 'show')
      assert.equal(started.round, 1, 'new begin, including an old claim, uses the complete revision')
      assert.equal(after.prs['1'].cycles.length, 2)
      assert.deepEqual(after.prs['1'].cycles[0], recovered.prs['1'].cycles[0])
      assert.equal(after.prs['1'].cycles[1].noProgress, 1)
      assertHistoryPrefix(dir, bytes)
      assert.deepEqual(run(dir, 'show'), after, 'new admission must also replay with its exact new accounting')
    })
  }
}

test('F2-BASE-ONLY-CYCLE-RENEWAL: live base/head decisions get a separate validated replay marker, never a caller option', () => {
  const { dir, claim } = baseRenewalNiceHistory()
  run(dir, 'sync', { owner, complete: true, prs: [{ ...claim.snapshot, base: sha(20) }] })
  run(dir, 'next', { owner, baseHeadRenewal: true }, false)
  const selected = next(dir)
  run(dir, 'begin', { ...beginInput(selected), baseHeadRenewal: true }, false)
  run(dir, 'save', saveInput(selected, { phase: 'blocked' }))
  run(dir, 'resume', { ...resumeInput(selected), baseHeadRenewal: true }, false)
  run(dir, 'resume', resumeInput(selected))
  run(dir, 'begin', beginInput(selected))
  const bytes = journalBytes(dir), events = JSON.parse(bytes).events
  const marked = events.filter((e) => e.baseHeadRenewal)
  assert.deepEqual(marked.map((e) => e.command), ['next', 'resume', 'begin'])
  assert.equal(marked[0].admission, 'detail-read-recovery', 'existing admission decisions keep their meaning')
  const before = run(dir, 'show')
  assert.equal(before.active.round, 1)
  assert.deepEqual(before.prs['1'].cycles.map((c) => [c.rounds, c.noProgress]), [[1, 1], [1, 1]])
  for (const change of [{ baseHeadRenewal: false }, { baseHeadRenewal: 'true' }, { command: 'sync' }, { version: 1 }]) {
    const broken = fixture(), history = structuredClone(events)
    Object.assign(history.find((e) => e.baseHeadRenewal), change)
    writeJournal(broken, history)
    assert.match(run(broken, 'show', undefined, false).error, /renewal marker/)
  }
  assert.equal(journalBytes(dir), bytes)
  assert.deepEqual(run(dir, 'show'), before)
})
