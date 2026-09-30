import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import * as jsxRuntime from 'react/jsx-runtime'
import * as model from './contractRevision.ts'
import { id, contract, policy, run, panelHarness, elements, text, evaluate } from './contractRevisionHarness.mjs'

const completeContract = () => ({
  ...contract(), objective: '  Keep\nall lines  ', expected_output: 'Source\nplus evidence',
  source_repository: 'All-The-Vibes/ecorp', source_base_ref: 'refs/heads/main', source_base_commit: 'a'.repeat(40),
  workspace_connection_id: id(20), deadline_at: '2026-10-01T12:00:00-05:00',
  acceptance_tests: ['Retain\nmultiline criteria', 'Second criterion'], allowed_tools: ['read', 'edit'],
  prohibited_actions: ['Do not publish'], references: ['https://example.invalid/reference'],
  budget_tokens: 1200, budget_cost_microusd: 1800, model: 'pinned-model', reasoning_effort: 'high',
  secret_refs: [{ secret_id: id(21), env_name: 'SCOPED_REF', tool: 'read', resource: 'repository:fixture' }],
  deliverable: { form: 'typed_artifact_set', paths: ['src/result.json'], commit_after_verification: false },
})
const completePolicy = () => ({ checks: [
  { type: 'artifact', min_bytes: 1 }, { type: 'file', path: 'result.md', min_bytes: 2 },
  { type: 'screenshot', path: 'evidence/view.png', min_bytes: 100 },
  { type: 'json_schema', path: 'result.json', required_keys: ['status', 'value'] },
  { type: 'command', program: 'python', args: ['-c', 'print("literal\\ntext")'], timeout_ms: 100,
    cache_suppression: 'python_interpreter' },
  { type: 'test', program: 'python', args: ['-m', 'unittest'], timeout_ms: 60000,
    cache_suppression: 'python_environment' },
  { type: 'test', program: 'node', args: ['--test'], timeout_ms: 1000,
    cache_suppression: 'node_compile_cache' },
], manual_gate: { type: 'independent_review', roles: ['owner', 'member'], exclude_requester: true } })
function draftFor(c = contract(), p = policy()) {
  const h = panelHarness()
  h.button('Revise contract').props.onClick()
  h.edit('Revision reason', 'Clarify existing scope')
  const d = structuredClone(h.draft())
  d.contractJson = JSON.stringify(c, null, 2); d.policyJson = JSON.stringify(p, null, 2)
  d.before.contract = structuredClone(c); d.before.policy = structuredClone(p)
  return d
}
const parse = (c, p = policy()) => model.parseContractRevision(JSON.stringify(c), JSON.stringify(p))

test('all current native contract fields and verifier variants roundtrip without normalization or mutation', () => {
  const c = completeContract(), p = completePolicy(), original = structuredClone({ c, p })
  const parsed = parse(c, p)
  assert.deepEqual(parsed.errors, {})
  assert.deepEqual(model.contractRevisionErrors(parsed.contract, parsed.policy), {})
  const draft = draftFor(c, p), request = model.revisionRequest(draft, parsed.contract, parsed.policy)
  assert.deepEqual(request.contract, c); assert.deepEqual(request.verification_policy, p)
  assert.deepEqual({ c, p }, original)
  assert.equal(request.source_run_id, null); assert.equal(request.next_action, 'redispatch')
})

test('native optional fields, deliverable defaults and every deliverable form retain exact JSON shape', () => {
  for (const form of ['commit_branch', 'patch', 'archive', 'typed_artifact_set', 'review_only_report', undefined]) {
    const c = completeContract()
    c.deliverable = form === undefined ? {} : { form, paths: ['result.md'], commit_after_verification: true }
    const parsed = parse(c)
    assert.deepEqual(parsed.contract, c)
    assert.deepEqual(model.contractRevisionErrors(parsed.contract, parsed.policy), {})
  }
  const c = contract(), p = policy()
  for (const field of ['source_repository', 'source_base_ref', 'source_base_commit', 'workspace_connection_id',
    'budget_cost_microusd', 'deadline_at', 'secret_refs', 'model', 'reasoning_effort', 'deliverable']) delete c[field]
  delete p.manual_gate
  const parsed = parse(c, p)
  assert.deepEqual(parsed.contract, c); assert.deepEqual(parsed.policy, p)
  assert.deepEqual(model.contractRevisionErrors(parsed.contract, parsed.policy), {})
})

test('manual gates and omitted, null and explicit cache controls retain their authority exactly', () => {
  const gates = [undefined, null, { type: 'human_approval', roles: ['admin'] },
    ...[false, true].map(exclude_requester => ({ type: 'independent_review', roles: ['member'], exclude_requester }))]
  for (const gate of gates) for (const control of [undefined, null, 'node_compile_cache', 'python_interpreter', 'python_environment']) {
    const p = { checks: [{ type: 'command', program: 'node', args: ['literal\nargument', ''], timeout_ms: 1000 }] }
    if (gate !== undefined) p.manual_gate = gate
    if (control !== undefined) p.checks[0].cache_suppression = control
    const parsed = parse(contract(), p)
    assert.deepEqual(parsed.policy, p)
    assert.deepEqual(model.contractRevisionErrors(parsed.contract, parsed.policy), {})
  }
})

test('malformed exact JSON and unsupported native field types fail without coercion', () => {
  for (const value of [null, [], 42, {}, { ...contract(), allowed_tools: 'read' },
    { ...contract(), source_repository: 1 }, { ...contract(), secret_refs: null },
    { ...contract(), deliverable: { paths: 'result.md' } }]) {
    assert.equal(parse(value).contract, null)
  }
  for (const value of [null, [], {}, { checks: [{ type: 'shell', program: 'node' }] },
    { checks: [{ type: 'file', path: 2, min_bytes: 1 }] },
    { checks: [{ type: 'test', program: 'node', args: [], timeout_ms: 100, cache_suppression: 'unknown' }] },
    { ...policy(), manual_gate: { type: 'independent_review', roles: ['owner'] } }]) {
    assert.equal(parse(contract(), value).policy, null)
  }
  const raw = model.parseContractRevision('{"objective":', '{"checks":')
  assert.ok(raw.errors.contract); assert.ok(raw.errors.policy)
})

test('unknown fields that native decoding would discard cannot silently become saved authority', () => {
  for (const change of [c => { c.unknown = true }, c => { c.secret_refs[0].value = 'not-a-real-secret' },
    c => { c.deliverable.unknown = true }]) {
    const c = completeContract(); change(c)
    assert.ok(Object.keys(model.contractRevisionErrors(c, policy())).length)
  }
  for (const change of [p => { p.unknown = true }, p => { p.checks[0].unknown = true },
    p => { p.manual_gate.unknown = true }]) {
    const p = completePolicy(); change(p)
    assert.ok(model.contractRevisionErrors(contract(), p).policy)
  }
})

test('resume rejects changes to each immutable authority field but retains native default equivalence', () => {
  const c = completeContract(), p = completePolicy(), before = draftFor(c, p).before
  const replacements = {
    budget_tokens: 1300, budget_cost_microusd: 1900, source_repository: 'owner/other',
    source_base_ref: 'next', source_base_commit: 'b'.repeat(40), workspace_connection_id: id(99),
    secret_refs: [], model: 'another-model', reasoning_effort: 'low', deliverable: null,
  }
  for (const [key, value] of Object.entries(replacements)) {
    assert.ok(model.contractRevisionErrors({ ...c, [key]: value }, p, before, 'resume')[key], key)
  }
  const native = { ...contract(), budget_cost_microusd: 1000000,
    deliverable: { form: 'review_only_report', paths: [], commit_after_verification: false } }
  const omitted = structuredClone(native)
  for (const key of ['budget_cost_microusd', 'source_repository', 'source_base_ref', 'source_base_commit',
    'workspace_connection_id', 'secret_refs', 'model', 'reasoning_effort']) delete omitted[key]
  omitted.deliverable = {}
  assert.deepEqual(model.contractRevisionErrors(omitted, policy(), draftFor(native).before, 'resume'), {})
  for (const [beforeId, afterId] of [[null, id(20)], [id(20), null]]) {
    assert.ok(model.contractRevisionErrors({ ...contract(), workspace_connection_id: afterId }, policy(),
      draftFor({ ...contract(), workspace_connection_id: beforeId }).before, 'resume').workspace_connection_id)
  }
})

test('resume preserves prohibitions and uses component-aware path and tool narrowing', () => {
  const c = { ...contract(), allowed_tools: ['read', 'edit'], write_scope: ['src/**', 'README.md'] }
  const before = draftFor(c).before
  const narrow = { ...c, objective: 'Correct only the parser', allowed_tools: ['read'],
    write_scope: ['src/parser.ts'], prohibited_actions: [...c.prohibited_actions, 'Do not change APIs'] }
  assert.deepEqual(model.contractRevisionErrors(narrow, policy(), before, 'resume'), {})
  for (const path of ['src-other/file', 'README.md/child', '../src/file', '/src/file', '**', 'src/../secret']) {
    assert.ok(model.contractRevisionErrors({ ...c, write_scope: [path] }, policy(), before, 'resume').write_scope, path)
  }
  assert.ok(model.contractRevisionErrors({ ...c, allowed_tools: ['shell'] }, policy(), before, 'resume').allowed_tools)
  assert.ok(model.contractRevisionErrors({ ...c, prohibited_actions: ['A different prohibition'] }, policy(), before, 'resume').prohibited_actions)
})

test('Factory correction retains ordered verifier kinds and the complete manual gate', () => {
  const c = contract(), p = completePolicy(), before = draftFor(c, p).before
  assert.deepEqual(model.contractRevisionErrors(c, p, before, 'resume', true), {})
  for (const changed of [{ ...p, checks: p.checks.slice(1) }, { ...p, checks: [...p.checks].reverse() },
    { ...p, manual_gate: null }, { ...p, manual_gate: { ...p.manual_gate, exclude_requester: false } }]) {
    assert.ok(model.contractRevisionErrors(c, changed, before, 'resume', true).policy)
  }
  const updated = structuredClone(p); updated.checks[1].path = 'corrected.md'
  assert.deepEqual(model.contractRevisionErrors(c, updated, before, 'resume', true), {}, 'explicit native-supported check edits remain available')
})

test('native-valid ref punctuation and Unicode paths remain usable while control paths are rejected', () => {
  const c = { ...completeContract(), source_base_ref: 'refs/heads/topic]', write_scope: ['文書/**'] }
  assert.deepEqual(model.contractRevisionErrors(c, policy()), {})
  for (const control of ['\u0000', '\u001f', '\u007f']) {
    assert.ok(model.contractRevisionErrors({ ...c, source_base_ref: 'refs/heads/topic' + control }, policy()).source_base_ref)
  }
  for (const nativeValid of ['\u0085', '\u009f']) {
    assert.deepEqual(model.contractRevisionErrors({ ...c, source_base_ref: 'refs/heads/topic' + nativeValid }, policy()), {})
  }
  for (const path of ['src/\u0085file', 'src/\u009ffile']) {
    assert.ok(model.contractRevisionErrors({ ...contract(), write_scope: [path] }, policy()).write_scope)
  }
})

test('byte bounds, malformed source tuples, verifier limits and scoped references show field errors', () => {
  for (const [key, value] of [['objective', '界'.repeat(33334)], ['budget_tokens', 1.5],
    ['budget_cost_microusd', 0], ['workspace_connection_id', 'connection'], ['deadline_at', 'tomorrow'],
    ['model', ' '], ['reasoning_effort', 'infinite']]) {
    assert.ok(model.contractRevisionErrors({ ...contract(), [key]: value }, policy())[key], key)
  }
  assert.ok(model.contractRevisionErrors({ ...contract(), source_repository: 'owner/repo' }, policy()).source_repository)
  const c = completeContract(); c.secret_refs.push({ ...c.secret_refs[0] })
  assert.ok(model.contractRevisionErrors(c, policy()).secret_refs)
  for (const check of [{ type: 'artifact', min_bytes: 1.5 },
    { type: 'command', program: '-unsafe', args: [], timeout_ms: 1000 },
    { type: 'file', path: '../outside', min_bytes: 1 },
    { type: 'json_schema', path: 'result.json', required_keys: [''] }]) {
    assert.ok(model.contractRevisionErrors(contract(), { checks: [check] }).policy)
  }
})

test('restoring a draft rejects inconsistent action, source and Factory scope or a result without a request', () => {
  const d = draftFor()
  const read = value => model.readRevisionDraft(() => ({ getItem: () => JSON.stringify(value) }), d.target.scopeKey)
  assert.deepEqual(read(d).draft, d)
  for (const target of [
    { ...d.target, nextAction: 'resume', sourceRunId: null },
    { ...d.target, nextAction: 'redispatch', sourceRunId: id(6) },
    { ...d.target, recoveryKey: 'unverifiable' },
    { ...d.target, nextAction: 'resume', sourceRunId: id(6), recoveryKey: JSON.stringify([id(99), id(4), id(2), id(30), 1, 0, 'budget']) },
  ]) {
    assert.equal(read({ ...d, target }).draft, null)
    assert.ok(read({ ...d, target }).error)
  }
  assert.equal(read({ ...d, result: { status: 'unknown', message: 'Earlier request may have saved' } }).draft, null)
  const target = { ...d.target, nextAction: 'resume', sourceRunId: id(6),
    recoveryKey: JSON.stringify([id(1), id(4), id(2), id(30), 1, 0, 'budget']) }
  assert.ok(read({ ...d, target }).draft)
})

test('ordinary recovery chooses a provable latest lineage independently of snapshot order', () => {
  const first = run(), latest = run({ id: id(8), resumed_from_run_id: first.id })
  for (const values of [[first, latest], [latest, first]]) {
    assert.equal(model.ordinaryContractRevisionSource(values, first.task_id), latest.id)
    assert.equal(model.ordinaryContractRevisionSource(values, first.task_id, first.id), null)
  }
  const other = run({ id: id(9), workspace_run_id: id(9) })
  assert.equal(model.ordinaryContractRevisionSource([first, other], first.task_id), null)
  assert.equal(model.ordinaryContractRevisionSource([first, other], first.task_id, first.id), first.id)
})

test('recovery rejects active, completed, stopped, quarantined, disconnected and cyclic lineage', () => {
  const first = run()
  for (const change of [{ status: 'completed' }, { status: 'running' }, { breaker_stage: 'stop' },
    { workspace_disposition: 'quarantined' }, { workspace_path: null }, { provider_session_id: null },
    { resumed_from_run_id: id(9) }, { resumed_from_run_id: first.id }]) {
    assert.equal(model.ordinaryContractRevisionSource([{ ...first, ...change }], first.task_id), null)
  }
  for (const descendant of [run({ id: id(8), resumed_from_run_id: first.id, status: 'running' }),
    run({ id: id(8), resumed_from_run_id: first.id, breaker_stage: 'stop' }),
    run({ id: id(8), resumed_from_run_id: first.id, workspace_disposition: 'quarantined' }),
    run({ id: id(8), resumed_from_run_id: first.id, agent_id: id(99) })]) {
    assert.equal(model.ordinaryContractRevisionSource([first, descendant], first.task_id), null)
  }
})

test('only an exact pre-dispatch failure is skipped and only verifier-only ancestry inherits a provider session', () => {
  const first = run(), skipped = run({ id: id(8), resumed_from_run_id: first.id, provider_session_id: null,
    workspace_path: null, workspace_disposition: null, workspace_detail: 'dispatch_not_started' })
  assert.equal(model.ordinaryContractRevisionSource([first, skipped], first.task_id), first.id)
  for (const change of [{ status: 'cancelled' }, { workspace_path: '/owned/path' },
    { workspace_disposition: 'preserved' }, { workspace_detail: null }]) {
    assert.equal(model.ordinaryContractRevisionSource([first, { ...skipped, ...change }], first.task_id), null)
  }
  const verifier = run({ id: id(8), resumed_from_run_id: first.id, provider_session_id: null, execution_mode: 'verification_only' })
  assert.equal(model.ordinaryContractRevisionSource([first, verifier], first.task_id), verifier.id)
  assert.equal(model.ordinaryContractRevisionSource([first, { ...verifier, execution_mode: 'provider' }], first.task_id), null)
})

const editorSource = await readFile(new URL('./ContractRevisionEditor.tsx', import.meta.url), 'utf8')
function editorHarness(c = completeContract(), p = completePolicy(), supplied = {}) {
  let draft = draftFor(c, p)
  const changes = [], VerificationPolicyEditor = () => null
  const globals = { exports: {}, window: {}, require: name => {
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (name === './contractRevision') return model
    if (name === './VerificationPolicyEditor') return { VerificationPolicyEditor }
    throw new Error(name)
  } }
  evaluate(editorSource, globals)
  const render = () => {
    const parsed = model.parseContractRevision(draft.contractJson, draft.policyJson)
    return globals.exports.ContractRevisionEditor({ draft, contract: parsed.contract, policy: parsed.policy,
      errors: parsed.contract && parsed.policy ? model.contractRevisionErrors(parsed.contract, parsed.policy) : parsed.errors,
      disabled: false, idPrefix: 'revision-unit', onChange: patch => { changes.push(patch); draft = { ...draft, ...patch } }, ...supplied })
  }
  const field = label => {
    const node = elements(render()).find(n => n.type === 'label' && text(n).trim().startsWith(label))
    assert.ok(node, label)
    return elements(node).find(n => n.type === 'textarea')
  }
  return { render, field, changes, VerificationPolicyEditor, draft: () => draft }
}

test('guided editing preserves every unedited authority field, list entry and verifier including whitespace', () => {
  const c = completeContract(), p = completePolicy(), h = editorHarness(c, p)
  h.field('Task objective').props.onChange({ target: { value: '  New\nobjective  ' } })
  h.field('Acceptance criteria 1').props.onChange({ target: { value: '  First\ncriterion  ' } })
  assert.deepEqual(JSON.parse(h.draft().contractJson), { ...c, objective: '  New\nobjective  ',
    acceptance_tests: ['  First\ncriterion  ', c.acceptance_tests[1]] })
  assert.deepEqual(JSON.parse(h.draft().policyJson), p)
  assert.deepEqual(h.draft().before.contract, c)
  assert.match(text(h.render()), /Before and after/)
  assert.match(text(h.render()), /New\nobjective/)
})

test('exact and guided views share one draft and omitted optional fields stay omitted', () => {
  const h = editorHarness()
  const c = contract(), p = { checks: [{ type: 'artifact', min_bytes: 3 }] }
  delete c.secret_refs; delete c.budget_cost_microusd; delete c.deliverable
  const raw = JSON.stringify(c, null, 4) + '\n'
  h.field('Typed task contract').props.onChange({ target: { value: raw } })
  assert.equal(h.draft().contractJson, raw)
  assert.equal(h.field('Task objective').props.value, c.objective)
  h.field('Task objective').props.onChange({ target: { value: 'Narrower objective' } })
  assert.deepEqual(JSON.parse(h.draft().contractJson), { ...c, objective: 'Narrower objective' })
  h.field('Typed verifier policy').props.onChange({ target: { value: JSON.stringify(p) } })
  const verifier = elements(h.render()).find(n => n.type === h.VerificationPolicyEditor)
  verifier.props.onChange({ ...verifier.props.policy, checks: [{ type: 'artifact', min_bytes: 4 }] })
  assert.deepEqual(JSON.parse(h.draft().policyJson), { checks: [{ type: 'artifact', min_bytes: 4 }] })
})

test('authority errors and malformed exact JSON are visible outside closed disclosures and associated with inputs', () => {
  const h = editorHarness({ ...contract(), budget_tokens: 0 })
  const view = h.render(), detail = elements(view).find(n => n.type === 'details' && n.props.className === 'contract-authority-details')
  assert.equal(detail.props.open, true)
  assert.ok(elements(view).some(n => n.props.role === 'status' && /budget tokens/i.test(text(n))))
  assert.match(h.field('Typed task contract').props['aria-describedby'], /budget_tokens-error/)
  h.field('Typed task contract').props.onChange({ target: { value: '{"objective":' } })
  const malformed = h.render(), exact = elements(malformed).find(n => n.type === 'details' && n.props.className === 'contract-exact-editor')
  assert.equal(exact.props.open, true)
  assert.equal(h.field('Typed task contract').props['aria-invalid'], true)
  const ids = elements(malformed).map(n => n.props.id).filter(Boolean)
  assert.equal(new Set(ids).size, ids.length, 'error and control IDs must be unique')
})
