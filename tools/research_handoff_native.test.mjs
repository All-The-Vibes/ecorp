import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { adversarialExecutors, requiredAdversarialCases, serverAssertions, verifierCases } from './research_handoff_native_catalog.mjs'
import { nativeCoverageResult, validateBuildReceipt, validateFixtureResult } from './research_handoff_native.mjs'

// Synthetic receipts test only the driver's contract. They are never native coverage.
const nonce = '96b721a7-137f-4cef-bfc3-aa9084d45770'
function specimen(mapping) {
  const runner = mapping.lane === 'runner'
  const receipt = { schema_version: 1, nonce, case_id: mapping.case_id,
    evidence_scope: mapping.evidence_scope, qualification: 'Synthetic contract specimen only',
    status: mapping.case_id === 'exact-limit-control' ? 'native_control_observed' : 'native_rejection_observed',
    positive_controls: runner ? [
      'native_assignment_provider_started', 'native_exact_byte_readback', 'native_read_write_permissions',
      'legitimate_retained_checkpoint', 'exact_file_count_limit', 'exact_utf8_file_byte_limit',
      'exact_file_byte_limit', 'exact_serialized_aggregate_limit', 'same_destination_plain_file_control',
      'native_destination_link_resolves_exact_target', 'relative_internal_symlink_checkpoint',
      'fresh_owned_worktree_base_and_head',
      'native_verifier_unchanged_control', 'exact_6144_byte_note_control',
    ] : ['real_signed_artifacts_read_verified', 'persisted_two_parent_selection',
      'native_resolver_exact_declared_bytes', 'recovered_provider_and_verifier_runs_distinct',
      'restored_control_resolves_identically'],
    rejection_assertions: ['native_materializer_rejection', 'no_adapter_entry', 'no_provider_start',
      'workspace_preserved', 'owned_sentinel_unchanged', 'no_dependency_writes', 'native_os_parent_read_denied',
      'real_fake_process_fault', 'signed_download_not_claimed', 'native_verifier_exact_check_rejected',
      'four_native_verifier_assertions', 'provider_artifact_present'],
    observations: verifierCases.includes(mapping.case_id) ? {
      passed: false, checks: Array.from({ length: 4 }, (_, index) =>
        ({ passed: index !== (mapping.case_id === 'missing-file' ? 1 : 3) })),
    } : ['aggregate-byte-limit', 'exact-limit-control'].includes(mapping.case_id)
      ? { file_count_limit: 8, file_byte_limit: 12288, aggregate_wire_limit: 65536, rejected_wire_bytes: 65537 }
      : { parent: { attempted: true, denied: true } },
    fixture_schema_removed: true, full_stack: false, provider_inference: false,
    nonvacuity_controls: ['exactly_one_persisted_dependency_receipt',
      'rejection_preserves_persisted_receipt', 'restored_replay_is_idempotent'],
    native_rejection_assertions: serverAssertions[mapping.case_id],
  }
  return { receipt, row: { ...mapping, nonce }, result: { error: null, signal: null, status: 0,
    stderr: '', stdout: encode(receipt, mapping.executor) } }
}
function encode(receipt, entrypoint, passed = true) {
  return `running 1 test\ntest ${entrypoint} ...\nISSUE297_NATIVE_FIXTURE:${JSON.stringify(receipt)}\n` +
    `test result: ${passed ? 'ok. 1 passed; 0 failed' : 'FAILED. 0 passed; 1 failed'}; 0 ignored; 0 measured; 0 filtered out\n`
}

test('all 23 cases have executors but no initial execution credit', () => {
  const rows = adversarialExecutors().map(row => ({ ...row, status: 'not_executed' }))
  assert.deepEqual(rows.map(row => row.case_id), requiredAdversarialCases)
  assert.ok(rows.every(row => row.implemented && row.executor))
  assert.equal(rows.filter(row => row.lane === 'runner').length, 10)
  assert.equal(rows.filter(row => row.lane === 'server').length, 13)
  assert.equal(rows.filter(row => row.evidence_scope === 'native-runner-verifier').length, 3)
  const result = nativeCoverageResult(rows)
  assert.equal(result.accepted, false)
  assert.equal(result.native_observed.length, 0)
  assert.equal(result.incomplete_cases.length, 23)
  for (const bad of [[], rows.slice(1), [...rows, rows[0]], rows.map(row => ({ ...row, status: 'passed' }))]) {
    assert.throws(() => nativeCoverageResult(bad))
  }
})

for (const mapping of adversarialExecutors().filter(row => row.lane !== 'owned-live-stack')) {
  test(`${mapping.case_id}: exact native test/nonce/assertions required; infrastructure is not rejection`, () => {
    const { receipt, row, result } = specimen(mapping)
    assert.ok(validateFixtureResult(result, row).status.startsWith('native_'))
    for (const mutate of [
      r => { r.case_id = 'different' }, r => { r.nonce = 'different' },
      r => { r.schema_version = 0 }, r => { r.evidence_scope = 'native-full-stack-required' },
      r => { r.positive_controls = [] }, r => { r.positive_controls.push(r.positive_controls[0]) },
      ...(mapping.lane === 'server' ? [
        r => { r.native_rejection_assertions = [] }, r => { r.nonvacuity_controls = [] },
        r => { r.fixture_schema_removed = false }, r => { r.full_stack = true },
        r => { r.provider_inference = true },
      ] : [r => { r.rejection_assertions = [] }, r => { r.status = 'passed' }]),
    ]) {
      const changed = structuredClone(receipt)
      mutate(changed)
      assert.throws(() => validateFixtureResult({ ...result, stdout: encode(changed, mapping.executor) }, row))
    }
    for (const changed of [
      { ...result, status: 1 }, { ...result, status: null }, { ...result, error: 'ETIMEDOUT' },
      { ...result, error: 'ENOENT' }, { ...result, signal: 'SIGTERM' },
      { ...result, stdout: result.stdout + result.stdout },
      { ...result, stdout: result.stdout.replace('running 1 test', 'running 0 tests') },
      { ...result, stdout: result.stdout.replace('0 ignored', '1 ignored') },
      { ...result, stdout: result.stdout.replace(mapping.executor, 'unrelated_test') },
      { ...result, stdout: 'test result: ok. 0 passed; 0 failed; 0 ignored;' },
    ]) assert.throws(() => validateFixtureResult(changed, row))
  })
}

test('unsupported platform and readable parent tree remain nonzero unqualified observations', () => {
  for (const mapping of adversarialExecutors().filter(row =>
    ['parent-tree-isolation', 'destination-symlink', 'destination-reparse'].includes(row.case_id))) {
    const { receipt, row, result } = specimen(mapping)
    receipt.status = 'unqualified'
    receipt.rejection_assertions = []
    receipt.observations = { parent: { attempted: true, denied: false, readable: true, exact: true } }
    const failed = { ...result, status: 101, stdout: encode(receipt, mapping.executor, false) }
    assert.equal(validateFixtureResult(failed, row).status, 'unqualified')
    assert.throws(() => validateFixtureResult({ ...failed, status: 0 }, row))
    receipt.status = 'native_rejection_observed'
    assert.throws(() => validateFixtureResult({ ...result, stdout: encode(receipt, mapping.executor) }, row))
  }
})

test('even complete synthetic fixture coverage cannot credit any live lane or claim acceptance', () => {
  const rows = adversarialExecutors().map(mapping => {
    if (mapping.lane === 'owned-live-stack') return { ...mapping, status: 'not_executed' }
    const { row, result } = specimen(mapping)
    return { ...row, execution: result, ...validateFixtureResult(result, row),
      binary_sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64) }
  })
  const result = nativeCoverageResult(rows)
  assert.equal(result.native_observed.length, 23)
  assert.equal(result.incomplete_cases.length, 0)
  for (const field of ['accepted', 'full_stack', 'browser', 'r4', 'owner_acceptance']) assert.equal(result[field], false)
  const unpinned = structuredClone(rows)
  delete unpinned.find(row => row.lane === 'runner').binary_sha256
  assert.throws(() => nativeCoverageResult(unpinned))
  const invented = structuredClone(rows)
  invented[0].lane = 'owned-live-stack'
  assert.throws(() => nativeCoverageResult(invented))
})

test('production, foreign-checkout, wrong-binary and failed build receipts cannot admit fixtures', () => {
  const root = path.resolve('.')
  const binary = path.join(root, 'target', 'debug', 'fixture.exe')
  const records = [{ reason: 'compiler-artifact', target: { name: 'crony-runner' },
    profile: { test: true }, executable: binary,
    manifest_path: path.join(root, 'crates', 'crony-runner', 'Cargo.toml') },
  { reason: 'build-finished', success: true }]
  validateBuildReceipt(records, { lane: 'runner', root, binary })
  for (const mutate of [
    r => { r[0].profile.test = false }, r => { r[0].executable += '.other' },
    r => { r[0].manifest_path = path.join(root, 'foreign', 'Cargo.toml') },
    r => { r[0].target.name = 'crony-server' }, r => { r[1].success = false },
    r => { r.pop() }, r => { r.push(r[1]) },
  ]) {
    const changed = structuredClone(records)
    mutate(changed)
    assert.throws(() => validateBuildReceipt(changed, { lane: 'runner', root, binary }))
  }
})

test('native CLI without explicit admitted manifest refuses with no default live target', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./research_handoff_native.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 5000, windowsHide: true })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  const report = JSON.parse(result.stderr)
  assert.equal(report.accepted, false)
  assert.equal(report.phase, 'refused')
})
