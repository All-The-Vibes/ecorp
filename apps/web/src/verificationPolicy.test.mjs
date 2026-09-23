import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendVerifierCheck, defaultVerifierCheck, removeVerifierCheck, replaceVerifierCheck,
  setManualVerificationGate, verificationPolicyErrors, verificationTypeLabel, verifierCheckSummary,
} from './verificationPolicy.ts'
const policy = (checks = [defaultVerifierCheck()], manual_gate = null) => ({ checks, manual_gate })

const defaults = [
  { type: 'artifact', min_bytes: 1 },
  { type: 'file', path: 'README.md', min_bytes: 1 },
  { type: 'command', program: 'git', args: ['status', '--short'], timeout_ms: 60_000 },
  { type: 'test', program: 'pnpm', args: ['test'], timeout_ms: 60_000 },
  { type: 'json_schema', path: 'evidence/result.json', required_keys: ['status'] },
  { type: 'screenshot', path: 'evidence/browser.png', min_bytes: 1_000 },
]
for (const expected of defaults) {
  test(`${expected.type} defaults retain the current wire shape and do not share mutable values`, () => {
    const first = defaultVerifierCheck(expected.type)
    const second = defaultVerifierCheck(expected.type)
    assert.deepEqual(first, expected)
    assert.notEqual(first, second)
    if (first.args) assert.notEqual(first.args, second.args)
    if (first.required_keys) assert.notEqual(first.required_keys, second.required_keys)
    assert.deepEqual(verificationPolicyErrors(policy([first])), [])
  })
}

test('check summaries preserve paths, argument boundaries, byte floors, JSON keys, and rounded timeouts', () => {
  assert.equal(verifierCheckSummary(defaultVerifierCheck()), 'Provider artifact · at least 1 byte')
  assert.equal(verifierCheckSummary(defaultVerifierCheck('file')), 'File README.md · at least 1 byte')
  assert.equal(verifierCheckSummary(defaultVerifierCheck('screenshot')), `Screenshot evidence/browser.png · at least ${(1000).toLocaleString()} bytes`)
  assert.equal(verifierCheckSummary(defaultVerifierCheck('json_schema')), 'JSON evidence/result.json · keys: ["status"]')
  assert.equal(verifierCheckSummary(defaultVerifierCheck('command')), 'Command · ["git","status","--short"] · 60s')
  assert.equal(verifierCheckSummary({ type: 'test', program: 'node', args: ['one two', '--test'], timeout_ms: 1499 }), 'Test · ["node","one two","--test"] · 1s')
})

test('array summaries distinguish item boundaries and preserve exact argument and key values', () => {
  for (const type of ['command', 'test']) {
    const check = { type, program: 'tool directory/runner.exe', args: ['one two'], timeout_ms: 2000 }
    assert.notEqual(verifierCheckSummary(check), verifierCheckSummary({ ...check, args: ['one', 'two'] }))
    for (const args of [[], ['one two', 'two  spaces', '', 'quoted "value"', 'back\\slash', 'line\nfeed', '\ttab', '>target&other']]) {
      const summary = verifierCheckSummary({ ...check, args })
      assert.deepEqual(JSON.parse(summary.slice(summary.indexOf('['), summary.lastIndexOf(']') + 1)), [check.program, ...args])
      assert.ok(summary.endsWith(' · 2s'))
    }
  }
  const schema = { type: 'json_schema', path: 'schema.json', required_keys: ['one, two'] }
  assert.notEqual(verifierCheckSummary(schema), verifierCheckSummary({ ...schema, required_keys: ['one', 'two'] }))
  assert.deepEqual(JSON.parse(verifierCheckSummary(schema).split(' · keys: ')[1]), schema.required_keys)
})

test('byte-counted summaries use singular byte only for the one-byte floor', () => {
  for (const type of ['artifact', 'file', 'screenshot']) {
    assert.ok(verifierCheckSummary({ ...defaultVerifierCheck(type), min_bytes: 1 }).endsWith('at least 1 byte'))
    assert.ok(verifierCheckSummary({ ...defaultVerifierCheck(type), min_bytes: 2 }).endsWith('at least 2 bytes'))
  }
})

test('empty and oversized policies remain invalid, with the 16-check boundary accepted', () => {
  assert.deepEqual(verificationPolicyErrors(policy([])), ['Add at least one verifier check.'])
  assert.deepEqual(verificationPolicyErrors(policy(Array.from({ length: 16 }, () => defaultVerifierCheck()))), [])
  assert.deepEqual(verificationPolicyErrors(policy(Array.from({ length: 17 }, () => defaultVerifierCheck()))), ['Verifier policies support at most 16 checks.'])
})

for (const value of [0, -1, NaN, Infinity]) {
  test(`invalid byte floor ${value} is reported for every byte-counted check`, () => {
    const checks = ['artifact', 'file', 'screenshot'].map((type) => ({ ...defaultVerifierCheck(type), min_bytes: value }))
    assert.deepEqual(verificationPolicyErrors(policy(checks)), [1, 2, 3].map((n) => `Check ${n} needs a positive byte floor.`))
  })
}

test('validation preserves check order and reports missing paths, programs, timeout bounds, and JSON keys', () => {
  assert.deepEqual(verificationPolicyErrors(policy([
    { type: 'file', path: '  ', min_bytes: 1 },
    { type: 'command', program: '', args: [], timeout_ms: 99 },
    { type: 'test', program: 'node', args: [], timeout_ms: 60001 },
    { type: 'json_schema', path: '', required_keys: [] },
  ])), [
    'Check 1 needs a repository path.',
    'Check 2 needs an executable program.',
    'Check 2 timeout must be between 100 and 60,000 ms.',
    'Check 3 timeout must be between 100 and 60,000 ms.',
    'Check 4 needs a repository path.',
    'Check 4 needs at least one required JSON key.',
  ])
  for (const type of ['command', 'test']) {
    for (const timeout_ms of [100, 60000]) assert.deepEqual(verificationPolicyErrors(policy([{ ...defaultVerifierCheck(type), timeout_ms }])), [])
    for (const timeout_ms of [NaN, Infinity]) assert.match(verificationPolicyErrors(policy([{ ...defaultVerifierCheck(type), timeout_ms }]))[0], /timeout must be/)
  }
})

test('manual gates require allowed roles without changing requester-exclusion semantics', () => {
  for (const type of ['human_approval', 'independent_review']) {
    assert.deepEqual(verificationPolicyErrors(policy(undefined, { type, roles: [] })), ['The manual gate needs at least one eligible role.'])
    assert.deepEqual(verificationPolicyErrors(policy(undefined, { type, roles: ['guest'] })), ['Manual-gate roles must be owner, admin, manager, or member.'])
    for (const exclude_requester of [true, false]) {
      assert.deepEqual(verificationPolicyErrors(policy(undefined, { type, roles: ['owner', 'admin', 'manager', 'member'], exclude_requester })), [])
    }
  }
})

test('preserves the existing advisory-validator scope; server schema/path authorization remains authoritative', () => {
  // These are current quirks, not newly authorized runner behavior. The existing
  // editor checks presence and numeric bounds; the server validates full input.
  assert.deepEqual(verificationPolicyErrors(policy([
    { type: 'file', path: '../outside', min_bytes: 1.5 },
    { type: 'command', program: 'node', args: [], timeout_ms: 100.5 },
    { type: 'json_schema', path: 'result.json', required_keys: [' ', 'status', 'status'] },
  ], { type: 'independent_review', roles: ['owner', 'owner'], exclude_requester: false })), [])
  assert.throws(() => verificationPolicyErrors(null), TypeError)
  assert.throws(() => verificationPolicyErrors({ checks: null }), TypeError)
})

test('check transformations create new drafts while retaining unchanged evidence checks and gate identity', () => {
  const first = Object.freeze(defaultVerifierCheck())
  const second = Object.freeze(defaultVerifierCheck('file'))
  const gate = Object.freeze({ type: 'independent_review', roles: Object.freeze(['owner']), exclude_requester: true })
  const original = Object.freeze({ ...policy(Object.freeze([first, second]), gate), context: 'unchanged' })
  const added = appendVerifierCheck(original)
  assert.notEqual(added, original)
  assert.notEqual(added.checks, original.checks)
  assert.equal(added.checks[0], first)
  assert.equal(added.checks[1], second)
  assert.deepEqual(added.checks[2], defaultVerifierCheck('file'))
  const replacement = defaultVerifierCheck('test')
  const replaced = replaceVerifierCheck(original, 1, replacement)
  assert.equal(replaced.checks[0], first)
  assert.equal(replaced.checks[1], replacement)
  const removed = removeVerifierCheck(original, 0)
  assert.deepEqual(removed.checks, [second])
  for (const result of [added, replaced, removed]) {
    assert.equal(result.manual_gate, gate)
    assert.equal(result.context, 'unchanged')
  }
  assert.deepEqual(original.checks, [first, second])
})

test('gate transitions preserve checks and retain current deliberate resets even when reselecting a gate type', () => {
  const checks = Object.freeze([Object.freeze(defaultVerifierCheck())])
  const original = Object.freeze(policy(checks, Object.freeze({ type: 'independent_review', roles: Object.freeze(['admin']), exclude_requester: false })))
  const independent = setManualVerificationGate(original, 'independent_review')
  assert.deepEqual(independent.manual_gate, { type: 'independent_review', roles: ['member', 'manager', 'admin', 'owner'], exclude_requester: true })
  const human = setManualVerificationGate(original, 'human_approval')
  assert.deepEqual(human.manual_gate, { type: 'human_approval', roles: ['owner', 'admin'] })
  const none = setManualVerificationGate(original, 'none')
  assert.equal(none.manual_gate, null)
  for (const result of [independent, human, none]) assert.equal(result.checks, checks)
  assert.equal(original.manual_gate.exclude_requester, false)
})

test('verification labels retain their current wording and fallback formatting', () => {
  assert.equal(verificationTypeLabel('artifact'), 'Artifact')
  assert.equal(verificationTypeLabel('json_schema'), 'Json Schema')
  assert.equal(verificationTypeLabel('human_approval'), 'Human Approval')
  assert.equal(verificationTypeLabel('independent_review'), 'Independent Review')
  assert.equal(verificationTypeLabel('future_gate'), 'Future Gate')
})


test('policy edits preserve explicit cache controls and legacy omission on the wire', () => {
  for (const type of ['command', 'test']) {
    for (const value of [undefined, null, 'python_interpreter', 'python_environment', 'node_compile_cache']) {
      const check = defaultVerifierCheck(type)
      if (value !== undefined) check.cache_suppression = value
      const original = policy([check])
      const before = JSON.stringify(original)
      let draft = appendVerifierCheck(original)
      draft = replaceVerifierCheck(draft, 1, { type: 'file', path: 'result.txt', min_bytes: 10 })
      draft = setManualVerificationGate(draft, 'human_approval')
      draft = removeVerifierCheck(draft, 1)
      assert.deepEqual(verificationPolicyErrors(draft), [])
      const wire = JSON.parse(JSON.stringify(draft)).checks[0]
      assert.deepEqual(wire, check)
      assert.equal(Object.hasOwn(wire, 'cache_suppression'), value !== undefined)
      assert.equal(JSON.stringify(original), before)
    }
  }
})


test('completion summaries distinguish explicit cache requests and preserve null or omitted policies', () => {
  const labels = {
    python_interpreter: 'Python interpreter (-B)',
    python_environment: 'Python environment',
    node_compile_cache: 'Node compile cache',
  }
  for (const type of ['command', 'test']) {
    const check = { type, program: 'python3', args: ['one two'], timeout_ms: 1499 }
    const legacy = `${type === 'test' ? 'Test' : 'Command'} · ["python3","one two"] · 1s`
    assert.equal(verifierCheckSummary(check), legacy)
    assert.equal(verifierCheckSummary({ ...check, cache_suppression: null }), legacy)
    for (const [cache_suppression, label] of Object.entries(labels)) {
      assert.equal(verifierCheckSummary({ ...check, cache_suppression }),
        `${legacy} · Requested cache control: ${label} (requires a compatible runner)`)
    }
  }
})
