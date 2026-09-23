import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { snapshot } from '../scripts/executor-snapshot.mjs'

const pr = (number) => ({
  number, head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'team/repo' } },
  base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'team/repo' } }, state: 'open', draft: false,
})

// GitHub response fields used by the fingerprints; unrelated response fields are omitted.
const details = {
  reviews: { id: 7, commit_id: 'a'.repeat(40), state: 'APPROVED', body: '',
    submitted_at: '2026-09-17T00:00:00Z' },
  review_comments: { id: 8, commit_id: 'a'.repeat(40), path: 'README.md', body: 'feedback',
    updated_at: '2026-09-17T00:00:00Z' },
  discussion: { id: 9, body: 'feedback', updated_at: '2026-09-17T00:00:00Z' },
  check_runs: { id: 10, head_sha: 'a'.repeat(40), name: 'test', status: 'completed', conclusion: 'success' },
  statuses: { id: 11, context: 'ci/test', state: 'success' },
}
const detailOperation = (endpoint) => endpoint.includes('/reviews?') ? 'reviews' :
  endpoint.includes('/issues/') ? 'discussion' : endpoint.includes('/comments?') ? 'review_comments' :
    endpoint.includes('/check-runs?') ? 'check_runs' : 'statuses'
const detailPages = (operation, pages) => JSON.stringify(operation === 'check_runs' ?
  pages.map((check_runs) => ({ check_runs })) : pages)

test('same-SHA target retarget changes only gate freshness and target identity, including blocked PRs', () => {
  for (const blocked of [false, true]) {
    let baseRef = 'main'
    const calls = []
    const invoke = (args) => {
      calls.push(args)
      const endpoint = args.at(-1)
      if (endpoint.includes('/pulls?')) {
        const pull = pr(1)
        pull.base.ref = baseRef
        pull.base.extra = 'synthetic-secret-unused-field'
        return JSON.stringify([[pull]])
      }
      if (blocked && endpoint.includes('/reviews?')) {
        throw Object.assign(new Error('synthetic-secret-auth'), { status: 4, signal: null })
      }
      return endpoint.includes('/check-runs?') ? '[{"check_runs":[]}]' : '[[]]'
    }
    const main = snapshot('team/repo', invoke).prs[0]
    const originalCalls = calls.splice(0)
    baseRef = 'release'
    const release = snapshot('team/repo', invoke).prs[0]
    assert.deepEqual(calls, originalCalls, 'retargeting needs no extra GitHub reads')
    assert.equal(main.baseRef, 'main')
    assert.equal(release.baseRef, 'release')
    assert.equal(release.base, main.base)
    assert.equal(release.head, main.head)
    assert.equal(release.reviewKey, main.reviewKey, 'retarget alone is not a new code audit')
    assert.notEqual(release.gateKey, main.gateKey, 'target-specific gates must be reevaluated')
    const { baseRef: beforeRef, gateKey: beforeGate, ...before } = main
    const { baseRef: afterRef, gateKey: afterGate, ...after } = release
    assert.deepEqual(after, before)
    assert.deepEqual(snapshot('team/repo', invoke).prs[0], release, 'unchanged target stays quiet')
    assert.doesNotMatch(JSON.stringify([main, release]), /synthetic-secret/)
  }
})

test('real GitHub inventory requires a valid base.ref and preserves valid branch names exactly', () => {
  for (const baseRef of [
    undefined, null, false, 1, [], {}, '', ' ', ' main', 'main ', 'main\n', 'main\u0000',
    '-main', '/main', 'main/', 'main//release', '.main', 'release/.main', 'main..release',
    'main.lock', 'main.lock/release', 'main.', 'main@{1}', '@', 'HEAD',
    'main~1', 'main^', 'main:release', 'main?', 'main*', 'main[1]', 'main\\release',
  ]) {
    const pull = pr(1)
    pull.base.ref = baseRef
    let calls = 0
    assert.throws(() => snapshot('team/repo', () => {
      calls++
      return JSON.stringify([[pull]])
    }), /Invalid or out-of-scope PR/)
    assert.equal(calls, 1, 'invalid target identity is fatal before detail reads')
  }
  for (const baseRef of ['main', 'release/2026.09', 'Stack/Feature_1', 'rélease/修正']) {
    const pull = pr(1)
    pull.base.ref = baseRef
    const result = snapshot('team/repo', (args) => args.at(-1).includes('/pulls?') ?
      JSON.stringify([[pull]]) : args.at(-1).includes('/check-runs?') ? '[{"check_runs":[]}]' : '[[]]')
    assert.equal(result.prs[0].baseRef, baseRef)
  }
})

for (const [label, draft] of [
  ['omitted', undefined], ['null', null], ['string', 'synthetic-secret-draft'],
  ['number', 0], ['object', { token: 'synthetic-secret-draft' }], ['array', []],
]) {
  test(`F02: live inventory rejects ${label} draft before detail reads`, () => {
    let calls = 0
    assert.throws(() => snapshot('team/repo', (args) => {
      calls++
      if (args.at(-1).includes('/pulls?')) {
        return JSON.stringify([[{ ...pr(1), draft, body: 'synthetic-secret-body' }]])
      }
      return detailPages(detailOperation(args.at(-1)), [[]])
    }), (error) => {
      assert.ok(error instanceof Error)
      assert.deepEqual(error.readFailure,
        { operation: 'inventory', kind: 'INVALID_RESPONSE', exitCode: null, signal: null })
      assert.equal(error.message, 'Invalid or out-of-scope PR')
      assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`, /synthetic-secret/)
      return true
    })
    assert.equal(calls, 1, 'malformed draft must be fatal before detail reads')
  })
}

test('F02: live inventory preserves explicit boolean drafts and their gate fingerprints', () => {
  const result = snapshot('team/repo', (args) => args.at(-1).includes('/pulls?') ?
    JSON.stringify([[{ ...pr(1), draft: true }], [{ ...pr(2), draft: false }]]) :
    detailPages(detailOperation(args.at(-1)), [[]]))
  assert.equal(result.complete, true)
  assert.deepEqual(result.prs.map(({ number, draft }) => ({ number, draft })),
    [{ number: 1, draft: true }, { number: 2, draft: false }])
  assert.ok(result.prs.every((pull) => !Object.hasOwn(pull, 'readError') && !Object.hasOwn(pull, 'readFailure')))
  assert.equal(result.prs[0].reviewKey, result.prs[1].reviewKey)
  assert.notEqual(result.prs[0].gateKey, result.prs[1].gateKey)
})

test('complete paginated inventory tracks heads, feedback and checks; read failures are not empty success', () => {
  let comment = 'first'
  const calls = []
  const invoke = (args) => {
    calls.push(args)
    const endpoint = args.at(-1)
    if (endpoint.includes('/pulls?')) return JSON.stringify([[pr(1)], [pr(2)]])
    if (endpoint.includes('/check-runs?')) return JSON.stringify([{ check_runs: [] }])
    if (endpoint.includes('/issues/')) return JSON.stringify([[{ ...details.discussion, body: comment }]])
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
    const operation = detailOperation(endpoint)
    return detailPages(operation, [[details[operation]]])
  }
  const healthy = snapshot('team/repo', invoke)
  let previousKeys
  for (const [operation, endpoint] of [
    ['reviews', '/pulls/1/reviews?'], ['review_comments', '/pulls/1/comments?'],
    ['discussion', '/issues/1/comments?'],
    ['check_runs', `/commits/${pulls[0].head.sha}/check-runs?`],
    ['statuses', `/commits/${pulls[0].head.sha}/statuses?`],
  ]) {
    for (const [response, kind, exitCode = null, signal = null] of [
      [Object.assign(new Error('HTTP 401: synthetic-secret-one at 2026-09-16T00:00:00Z'),
        { status: 4, signal: null, stderr: 'synthetic-secret-stderr', stdout: 'synthetic-secret-body',
          headers: { authorization: 'synthetic-secret-header' } }), 'COMMAND_FAILED', 4],
      [Object.assign(new Error('HTTP 404: synthetic-secret-two at 2026-09-17T00:00:00Z'),
        { status: 4, signal: null }), 'COMMAND_FAILED', 4],
      ...['SIGTERM', 'SIGKILL', 'SIGINT'].map((signal) =>
        [Object.assign(new Error('synthetic-secret-timeout'), { status: null, signal }),
          'COMMAND_FAILED', null, signal]),
      [Object.assign(new Error('synthetic-secret-signal'),
        { status: 1, signal: 'synthetic-secret-signal' }), 'COMMAND_FAILED', 1],
      [Object.assign(new Error('synthetic-secret-spawn'),
        { status: null, signal: null, code: 'ENOENT' }), 'COMMAND_FAILED'],
      ...['[]', '{}', '[{}]', '[null]', '[[null]]', '[[1]]', '[["synthetic-secret-row"]]',
        '[[[]]]', '[{"check_runs":[null]}]'].map((response) => [response, 'INVALID_RESPONSE']),
      ['invalid JSON synthetic-secret-body', 'INVALID_JSON'],
    ]) {
      const fail = (args) => {
        if (!args.at(-1).includes(endpoint)) return invoke(args)
        if (response instanceof Error) throw response
        return response
      }
      const result = snapshot('team/repo', fail)
      assert.equal(result.complete, true, 'complete describes the open PR inventory')
      assert.deepEqual(result.prs.map(({ number }) => number), [1, 2])
      const { readError, readFailure, reviewKey, gateKey, ...identity } = result.prs[0]
      const { reviewKey: healthyReview, gateKey: healthyGate, ...healthyIdentity } = healthy.prs[0]
      assert.equal(readError, 'DETAIL_READ_FAILED')
      assert.deepEqual(readFailure, { operation, kind, exitCode, signal })
      assert.deepEqual(identity, healthyIdentity)
      assert.match(reviewKey, /^[a-f0-9]{64}$/)
      assert.match(gateKey, /^[a-f0-9]{64}$/)
      assert.notEqual(reviewKey, healthyReview)
      assert.notEqual(gateKey, healthyGate)
      assert.deepEqual(result.prs[1], healthy.prs[1])
      assert.equal(Object.hasOwn(result.prs[1], 'readError'), false)
      assert.equal(Object.hasOwn(result.prs[1], 'readFailure'), false)
      assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|2026-09-1[67]T/)
      assert.deepEqual(snapshot('team/repo', fail), result, 'unchanged fault is stable')
      if (previousKeys) assert.deepEqual({ reviewKey, gateKey }, previousKeys,
        'diagnostic variations cannot change review or gate fingerprints')
      previousKeys = { reviewKey, gateKey }
    }
  }
  assert.throws(() => snapshot('team/repo', () => { throw new Error('API denied') }), /API denied/)
  assert.throws(() => snapshot('team/repo', (args) =>
    args.at(-1).includes('/pulls?') ? JSON.stringify([[pulls[0]], {}]) : invoke(args)), /Incomplete page/)
})

test('reviews command failure and statuses invalid response retain distinct safe diagnostics', () => {
  const collect = (failedOperation) => snapshot('team/repo', (args) => {
    const endpoint = args.at(-1)
    if (endpoint.includes('/pulls?')) return JSON.stringify([[pr(1)]])
    if (endpoint.includes(`/${failedOperation}?`)) {
      if (failedOperation === 'reviews') {
        throw Object.assign(new Error('synthetic-secret-auth'), { status: 4, signal: null })
      }
      return '{"synthetic-secret-body":true}'
    }
    return endpoint.includes('/check-runs?') ? '[{"check_runs":[]}]' : '[[]]'
  }).prs[0]
  const auth = collect('reviews'), shape = collect('statuses')
  assert.deepEqual(auth.readFailure,
    { operation: 'reviews', kind: 'COMMAND_FAILED', exitCode: 4, signal: null })
  assert.deepEqual(shape.readFailure,
    { operation: 'statuses', kind: 'INVALID_RESPONSE', exitCode: null, signal: null })
  assert.notDeepEqual(auth.readFailure, shape.readFailure)
  assert.equal(auth.reviewKey, shape.reviewKey)
  assert.equal(auth.gateKey, shape.gateKey)
  assert.doesNotMatch(JSON.stringify([auth, shape]), /synthetic-secret/)
})

test('unexpected internal errors escape rather than becoming API unavailability', (t) => {
  const invoke = (args) => {
    if (args.at(-1).includes('/pulls?')) return JSON.stringify([[pr(1)]])
    const operation = detailOperation(args.at(-1))
    return detailPages(operation, [[details[operation], { ...details[operation], id: 12 }]])
  }
  for (const error of [new Error('internal'), new TypeError('internal'), new SyntaxError('internal')]) {
    assert.throws(() => snapshot('team/repo', (args) => {
      if (args.at(-1).includes('/reviews?')) throw error
      return invoke(args)
    }), (caught) => caught === error)
  }
  const error = new TypeError('fingerprint bug')
  t.mock.method(String.prototype, 'localeCompare', () => { throw error })
  try {
    assert.throws(() => snapshot('team/repo', invoke), (caught) => caught === error)
  } finally {
    t.mock.restoreAll()
  }
})

test('CLI captures native command failures without leaking stderr; inventory and internal failures stay fatal', () => {
  const helper = new URL('../scripts/executor-snapshot.mjs', import.meta.url).href
  for (const [failure, expected] of [
    ['detail', null],
    ['inventory', { operation: 'inventory', kind: 'COMMAND_FAILED', status: 4, signal: null }],
    ['json', { operation: 'inventory', kind: 'INVALID_JSON', status: null, signal: null }],
    ...['shape', 'absent', 'identity', 'duplicate'].map((failure) =>
      [failure, { operation: 'inventory', kind: 'INVALID_RESPONSE', status: null, signal: null }]),
    ['signal', { operation: 'inventory', kind: 'COMMAND_FAILED', status: null, signal: 'SIGTERM' }],
    ['unsafe-signal', { operation: 'inventory', kind: 'COMMAND_FAILED', status: null, signal: null }],
    ...['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
      'AggregateError'].map((errorType) => [errorType,
      { operation: 'snapshot', kind: 'INTERNAL', status: null, signal: null, errorType }]),
    ['non-error', { operation: 'snapshot', kind: 'INTERNAL', status: null, signal: null, errorType: null }],
  ]) {
    // Exercise the real CLI and native failure shape without invoking gh or accessing credentials.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import cp from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      import { fileURLToPath } from 'node:url'
      const nativeExec = cp.execFileSync
      const failure = ${JSON.stringify(failure)}
      cp.execFileSync = (command, args, options) => {
        if (failure === 'json') return 'synthetic-secret-invalid-json'
        if (failure === 'shape') return '[{"synthetic-secret-body":true}]'
        if (failure === 'absent') return '[]'
        if (failure === 'identity') return '[[{"number":0,"body":"synthetic-secret-body"}]]'
        if (failure === 'duplicate') return ${JSON.stringify(JSON.stringify([[pr(1), pr(1)]]))}
        if (failure === 'signal' || failure === 'unsafe-signal') {
          throw Object.assign(new Error('synthetic-secret-command'), {
            status: null, signal: failure === 'signal' ? 'SIGTERM' : 'synthetic-secret-signal',
            stderr: 'synthetic-secret-stderr', stdout: 'synthetic-secret-stdout'
          })
        }
        if (failure !== 'inventory' && args.at(-1).includes('/pulls?')) {
          return ${JSON.stringify(JSON.stringify([[pr(1)]]))}
        }
        if (failure.endsWith('Error')) {
          const error = failure === 'AggregateError' ? new AggregateError([], 'synthetic-secret-internal') :
            new globalThis[failure]('synthetic-secret-internal')
          error.name = 'synthetic-secret-name'
          error.stack = 'synthetic-secret-stack'
          throw error
        }
        if (failure === 'non-error') throw { name: 'synthetic-secret-name', message: 'synthetic-secret-message' }
        return nativeExec(process.execPath, ['-e',
          "process.stdout.write('synthetic-secret-body'); process.stderr.write('synthetic-secret-stderr'); process.exit(4)"
        ], options)
      }
      syncBuiltinESMExports()
      process.argv = [process.execPath, fileURLToPath(${JSON.stringify(helper)}), 'team/repo']
      await import(${JSON.stringify(helper)})
    `], { encoding: 'utf8', timeout: 10_000 })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/)
    assert.equal(result.status, failure === 'detail' ? 0 : 1)
    if (failure === 'detail') {
      assert.equal(result.stderr, '')
      const item = JSON.parse(result.stdout).prs[0]
      assert.equal(item.readError, 'DETAIL_READ_FAILED')
      assert.deepEqual(item.readFailure,
        { operation: 'reviews', kind: 'COMMAND_FAILED', exitCode: 4, signal: null })
    } else {
      assert.equal(result.stdout, '', 'fatal failures cannot emit a complete inventory')
      assert.deepEqual(JSON.parse(result.stderr), expected, failure)
    }
  }
})

test('missing pages are rejected while a confirmed empty repository is complete', () => {
  assert.deepEqual(snapshot('team/repo', () => '[[]]'), { complete: true, prs: [] })
  assert.throws(() => snapshot('team/repo', () => '[]'), /Incomplete response: .*\/pulls\?/)
  for (const response of ['{}', '[null]', '[[null]]', 'invalid JSON synthetic-secret-body']) {
    assert.throws(() => snapshot('team/repo', () => response))
  }
  const result = snapshot('team/repo', (args) => args.at(-1).includes('/pulls?') ?
    JSON.stringify([[pr(1)]]) : args.at(-1).includes('/check-runs?') ? '[{"check_runs":[]}]' : '[[]]')
  assert.equal(result.complete, true)
  assert.equal(Object.hasOwn(result.prs[0], 'readError'), false, 'empty detail collections are complete')
  assert.equal(Object.hasOwn(result.prs[0], 'readFailure'), false)
})

for (const operation of Object.keys(details)) {
  test(`EX-MALFORMED-DETAILS: ${operation} rejects missing or mistyped core fields per PR`, () => {
    const pulls = [pr(1), { ...pr(2), head: { ...pr(2).head, sha: 'c'.repeat(40) } }]
    const collect = (row) => snapshot('team/repo', (args) => {
      const endpoint = args.at(-1)
      if (endpoint.includes('/pulls?')) return JSON.stringify(pulls.map((pull) => [pull]))
      const current = detailOperation(endpoint)
      const firstPR = endpoint.includes('/1/') || endpoint.includes(pulls[0].head.sha)
      // A valid first page must not hide an invalid later page or discard another PR.
      return detailPages(current, [[details[current]],
        [firstPR && current === operation ? row : details[current]]])
    })
    const healthy = collect(details[operation])
    assert.ok(healthy.prs.every((pull) => !Object.hasOwn(pull, 'readError')))
    const fields = { ...details[operation], ...(operation === 'statuses' ? { sha: 'a'.repeat(40) } : {}) }
    const malformed = [['empty object', {}]]
    for (const field of Object.keys(fields)) {
      const optional = (operation === 'reviews' && field === 'submitted_at') ||
        (operation === 'discussion' && field === 'body') || (operation === 'statuses' && field === 'sha')
      const nullable = (operation === 'reviews' && ['commit_id', 'submitted_at'].includes(field)) ||
        (operation === 'check_runs' && field === 'conclusion')
      const invalid = field === 'id' ? [undefined, null, false, '7', 0, -1, 1.5, 2 ** 53, {}, []] :
        [false, 7, {}, [], ...(!optional ? [undefined] : []), ...(!nullable ? [null] : []),
          ...(field !== 'body' ? [''] : [])]
      for (const value of invalid) malformed.push([`${field}=${JSON.stringify(value)}`, { ...fields, [field]: value }])
    }
    for (const [label, row] of malformed) {
      const result = collect({ ...row, unused: 'synthetic-secret-untrusted-payload' })
      assert.equal(result.complete, true, label)
      assert.deepEqual(result.prs.map(({ number }) => number), [1, 2], label)
      assert.equal(result.prs[0].readError, 'DETAIL_READ_FAILED', label)
      assert.deepEqual(result.prs[0].readFailure,
        { operation, kind: 'INVALID_RESPONSE', exitCode: null, signal: null }, label)
      const { reviewKey, gateKey, ...identity } = healthy.prs[0]
      assert.deepEqual(result.prs[0], { ...identity, readError: 'DETAIL_READ_FAILED',
        readFailure: result.prs[0].readFailure, reviewKey: result.prs[0].reviewKey, gateKey: result.prs[0].gateKey }, label)
      assert.notEqual(result.prs[0].reviewKey, reviewKey, label)
      assert.notEqual(result.prs[0].gateKey, gateKey, label)
      assert.deepEqual(result.prs[1], healthy.prs[1], label)
      assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/, label)
    }
  })
}

test('EX-MALFORMED-DETAILS: valid optional and nullable GitHub fields remain usable and fingerprinted', () => {
  const collect = (operation, row) => snapshot('team/repo', (args) => {
    if (args.at(-1).includes('/pulls?')) return JSON.stringify([[pr(1)]])
    const current = detailOperation(args.at(-1))
    return detailPages(current, [[current === operation ? row : details[current]]])
  }).prs[0]
  for (const [operation, variants] of [
    ['reviews', [{ body: '' }, { commit_id: null },
      { state: 'PENDING', submitted_at: null }, { state: 'PENDING', submitted_at: undefined }]],
    ['review_comments', [{ body: '' }]],
    ['discussion', [{ body: '' }, { body: undefined }]],
    ['check_runs', [{ status: 'queued', conclusion: null }, { status: 'in_progress', conclusion: null }]],
    ['statuses', [{ sha: undefined }, { sha: 'a'.repeat(40) }]],
  ]) {
    const original = collect(operation, details[operation])
    for (const variant of variants) {
      const row = { ...details[operation], ...variant }
      const result = collect(operation, row)
      assert.equal(Object.hasOwn(result, 'readError'), false, `${operation}: ${JSON.stringify(variant)}`)
      assert.equal(Object.hasOwn(result, 'readFailure'), false)
      assert.deepEqual(collect(operation, row), result, 'valid payload is stable')
      const changed = JSON.stringify(row) !== JSON.stringify(details[operation])
      if (changed) assert.notEqual(result[operation === 'check_runs' || operation === 'statuses' ? 'gateKey' : 'reviewKey'],
        original[operation === 'check_runs' || operation === 'statuses' ? 'gateKey' : 'reviewKey'])
    }
  }
})


for (const [label, headRef] of [
  ['omitted', undefined], ['null', null], ['boolean', false], ['number', 1], ['array', []], ['object', {}],
  ...['', ' ', ' feature', 'feature ', 'feature\n', 'feature\u0000', '-feature', '/feature',
    'feature/', 'feature//fix', '.feature', 'fix/.feature', 'feature..fix', 'feature.lock',
    'feature.lock/fix', 'feature.', 'feature@{1}', '@', 'HEAD', 'feature~1', 'feature^',
    'feature:fix', 'feature?', 'feature*', 'feature[1]', 'feature\\fix']
    .map((value, index) => ['invalid-git-ref-' + index, value]),
]) {
  test('PR304-HEAD-REF: ' + label + ' is rejected before detail requests', () => {
    const pull = pr(1)
    pull.head.ref = headRef
    pull.body = 'synthetic-secret-source-body'
    const calls = []
    assert.throws(() => snapshot('team/repo', (args) => {
      calls.push(args.at(-1))
      return args.at(-1).includes('/pulls?') ? JSON.stringify([[pull]]) :
        detailPages(detailOperation(args.at(-1)), [[]])
    }), (error) => {
      assert.deepEqual(error.readFailure,
        { operation: 'inventory', kind: 'INVALID_RESPONSE', exitCode: null, signal: null })
      assert.equal(error.message, 'Invalid or out-of-scope PR')
      assert.doesNotMatch(error.message + JSON.stringify(error), /synthetic-secret/)
      return true
    })
    assert.equal(calls.length, 1, 'only the open-PR inventory was requested')
  })
}

test('PR304-HEAD-REF: valid source branches preserve their exact spelling', () => {
  for (const headRef of ['feature', 'release/2026.09', 'Stack/Feature_1', 'rélease/修正']) {
    const pull = pr(1)
    pull.head.ref = headRef
    const result = snapshot('team/repo', (args) => args.at(-1).includes('/pulls?') ?
      JSON.stringify([[pull]]) : detailPages(detailOperation(args.at(-1)), [[]]))
    assert.equal(result.complete, true)
    assert.equal(result.prs[0].branch, headRef)
    assert.equal(result.prs[0].baseRef, 'main')
    assert.equal(Object.hasOwn(result.prs[0], 'readError'), false)
  }
})
