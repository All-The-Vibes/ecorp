import assert from 'node:assert/strict'
import test from 'node:test'
import { snapshot } from '../scripts/executor-snapshot.mjs'

const pr = (number) => ({
  number, head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'team/repo' } },
  base: { sha: 'b'.repeat(40), repo: { full_name: 'team/repo' } }, state: 'open', draft: false,
})

test('complete paginated inventory tracks heads, feedback and checks; read failures are not empty success', () => {
  let comment = 'first'
  const calls = []
  const invoke = (args) => {
    calls.push(args)
    const endpoint = args.at(-1)
    if (endpoint.includes('/pulls?')) return JSON.stringify([[pr(1)], [pr(2)]])
    if (endpoint.includes('/check-runs?')) return JSON.stringify([{ check_runs: [] }])
    if (endpoint.includes('/issues/')) return JSON.stringify([[{ id: 7, body: comment }]])
    return '[[]]'
  }
  const first = snapshot('team/repo', invoke)
  assert.equal(first.complete, true)
  assert.deepEqual(first.prs.map(({ number }) => number), [1, 2])
  assert.ok(calls.every((args) => args.includes('--paginate') && args.includes('--slurp')))
  assert.deepEqual(snapshot('team/repo', invoke), first)
  comment = 'new actionable feedback'
  const second = snapshot('team/repo', invoke)
  assert.notEqual(second.prs[0].reviewKey, first.prs[0].reviewKey)
  assert.equal(second.prs[0].gateKey, first.prs[0].gateKey)
  assert.throws(() => snapshot('team/repo', () => { throw new Error('API denied') }), /API denied/)
  assert.throws(() => snapshot('team/repo', () => '{}'), /Incomplete/)
  assert.throws(() => snapshot('team/repo', () => '[{}]'), /Incomplete/)
  assert.throws(() => snapshot('team/repo;echo bad', invoke), /Invalid repository/)
  assert.throws(() => snapshot('elsewhere/repo', invoke), /out-of-scope/)
  const missingChecks = snapshot('team/repo', (args) =>
    args.at(-1).includes('/check-runs?') ? '[]' : invoke(args))
  assert.equal(missingChecks.complete, true)
  assert.deepEqual(missingChecks.prs.map(({ readError }) => readError),
    ['DETAIL_READ_FAILED', 'DETAIL_READ_FAILED'])
})

test('one PR detail failure retains both PRs with stable safe fingerprints and normal identity', () => {
  const pulls = [pr(1), { ...pr(2), head: { ...pr(2).head, sha: 'c'.repeat(40) } }]
  const invoke = (args) => {
    const endpoint = args.at(-1)
    if (endpoint.includes('/pulls?')) return JSON.stringify(pulls.map((pull) => [pull]))
    if (endpoint.includes('/check-runs?')) return JSON.stringify([{ check_runs: [
      { id: 8, head_sha: pulls[1].head.sha, name: 'test', status: 'completed', conclusion: 'success' },
    ] }])
    return JSON.stringify([[{ id: 7, body: 'feedback', state: 'APPROVED' }]])
  }
  const healthy = snapshot('team/repo', invoke)
  for (const endpoint of [
    '/pulls/1/reviews?', '/pulls/1/comments?', '/issues/1/comments?',
    `/commits/${pulls[0].head.sha}/check-runs?`, `/commits/${pulls[0].head.sha}/statuses?`,
  ]) {
    let previous
    for (const response of [
      new Error('HTTP 401: synthetic-secret-one at 2026-09-16T00:00:00Z'),
      new Error('HTTP 404: synthetic-secret-two at 2026-09-17T00:00:00Z'),
      '[]', '{}', '[{}]', 'invalid JSON',
    ]) {
      const result = snapshot('team/repo', (args) => {
        if (!args.at(-1).includes(endpoint)) return invoke(args)
        if (response instanceof Error) throw response
        return response
      })
      assert.equal(result.complete, true, 'complete describes the open PR inventory')
      assert.deepEqual(result.prs.map(({ number }) => number), [1, 2])
      const { readError, reviewKey, gateKey, ...identity } = result.prs[0]
      const { reviewKey: healthyReview, gateKey: healthyGate, ...healthyIdentity } = healthy.prs[0]
      assert.equal(readError, 'DETAIL_READ_FAILED')
      assert.deepEqual(identity, healthyIdentity)
      assert.match(reviewKey, /^[a-f0-9]{64}$/)
      assert.match(gateKey, /^[a-f0-9]{64}$/)
      assert.notEqual(reviewKey, healthyReview)
      assert.notEqual(gateKey, healthyGate)
      assert.deepEqual(result.prs[1], healthy.prs[1])
      assert.equal(Object.hasOwn(result.prs[1], 'readError'), false)
      assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|2026-09-1[67]T/)
      if (previous) assert.deepEqual(result, previous, 'error text and time cannot change fingerprints')
      previous = result
    }
  }
  assert.throws(() => snapshot('team/repo', () => { throw new Error('API denied') }), /API denied/)
  assert.throws(() => snapshot('team/repo', (args) =>
    args.at(-1).includes('/pulls?') ? JSON.stringify([[pulls[0]], {}]) : invoke(args)), /Incomplete page/)
})

test('missing pages are rejected while a confirmed empty repository is complete', () => {
  assert.deepEqual(snapshot('team/repo', () => '[[]]'), { complete: true, prs: [] })
  assert.throws(() => snapshot('team/repo', () => '[]'), /Incomplete response: .*\/pulls\?/)
})
