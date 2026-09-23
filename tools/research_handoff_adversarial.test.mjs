import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { negativeFixtureCases, negativeFixtureSelection, applyNegativeResearchFixture } from '../scripts/research-negative-fixture.mjs'
import { initialAdversarialCoverage, adversarialCoverageResult, requiredAdversarialCases,
  negativeAuthority, assertNativeNegativeOutcome, assertNegativePlan } from './research_handoff_adversarial.mjs'
import { researchDemo } from './research_handoff_browser.mjs'

// Synthetic state below tests the observer contract, not native rejection or E2E acceptance.
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const nonce = '00000000-0000-4000-8000-000000000098'
const source = { repository: 'all-the-vibes/ecorp', base_ref: 'test', base_commit: 'a'.repeat(40) }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const command = "const fs=require('node:fs');for(const p of process.argv.slice(1)){const b=fs.readFileSync(p);const s=new TextDecoder('utf-8',{fatal:true}).decode(b);if(!b.length||b.length>6144)process.exit(1);if(p.endsWith('.json'))JSON.parse(s)}"

function nativeShape(case_id) {
  const mission = { id: id(1), corp_id: researchDemo.corp_id, room_id: researchDemo.room_id,
    requested_by: researchDemo.alice_actor_id, status: 'failed', strategy: 'parallel-specialists' }
  const tasks = ['specialist-a', 'specialist-b', 'synthesis'].map((key, i) => {
    const paths = [`handoffs/${key}.md`, `handoffs/${key}-probe.json`]
    return { id: id(10 + i), mission_id: mission.id, corp_id: mission.corp_id, plan_key: key,
      depth: i === 2 ? 1 : 0, depends_on: i === 2 ? [id(10), id(11)] : [],
      status: i === 2 ? 'pending' : case_id === 'failed-parent' ? 'failed' : 'verification_failed', verification_status: 'failed',
      attempt_count: i === 2 ? 0 : 1, max_attempts: 1, required_adapter: 'fake-process', assigned_agent_id: id(30 + i),
      contract: { expected_output: `Verified research files: ${paths.join(', ')}`,
        write_scope: paths, source_repository: source.repository,
        source_base_ref: source.base_ref, source_base_commit: source.base_commit,
        deliverable: { form: 'typed_artifact_set', commit_after_verification: false, paths } },
      verification_policy: { manual_gate: null, checks: [
        { type: 'artifact', min_bytes: 1 }, ...paths.map(path => ({ type: 'file', path, min_bytes: 1 })),
        { type: 'command', program: 'node', args: ['-e', command, ...paths], timeout_ms: 5000 },
      ] },
    }
  })
  const runs = tasks.slice(0, 2).map((task, i) => ({ id: id(20 + i), task_id: task.id,
    corp_id: mission.corp_id, status: 'failed', verification_status: 'failed', workspace_disposition: 'preserved' }))
  const events = runs.flatMap((run, i) => {
    const files = tasks[i].contract.deliverable.paths.map((path, index) => {
      if (case_id === 'missing-file' && index === 0) return { path, missing: true }
      const content = case_id === 'invalid-probe' && index === 1 ? '{"observed":'
        : case_id === 'oversized-file' && index === 0 ? 'x'.repeat(6145) : 'text\n'
      return { path, bytes: case_id === 'oversized-file' && index === 0 ? 6145 : content.length, sha256: sha(content) }
    })
    return [
      { type: 'run.started', aggregate_id: run.id, payload: {} },
      { type: 'run.output', aggregate_id: run.id, payload: { text: `ISSUE297 NEGATIVE FIXTURE: ${JSON.stringify({ case_id, nonce, run_id: run.id, files })}` } },
      { type: case_id === 'failed-parent' ? 'run.failed' : 'run.verification_failed',
        aggregate_id: run.id, payload: { error: 'Issue297 explicitly constructed failed parent.' } },
    ]
  })
  const verification_evidence = runs.flatMap((run, i) => tasks[i].verification_policy.checks.map((check, check_index) => ({
    run_id: run.id, task_id: tasks[i].id, corp_id: mission.corp_id, check_index,
    kind: check.type, status: check_index === 3 || (case_id === 'missing-file' && check_index === 1) ? 'failed' : 'passed',
    payload: check_index === 3 ? { exit_code: 1, requested_program: 'node', args: check.args,
      resolved_executable: { canonical_path_sha256: 'a'.repeat(64) },
      stderr: case_id === 'missing-file' ? 'ENOENT' : case_id === 'invalid-probe' ? 'SyntaxError' : '' }
      : check_index === 1 || check_index === 2
        ? JSON.parse(events.find(e => e.aggregate_id === run.id && e.type === 'run.output').payload.text
          .slice('ISSUE297 NEGATIVE FIXTURE: '.length)).files[check_index - 1] : {},
  })))
  const state = { snapshot: { missions: [mission], tasks, runs, events, verification_evidence } }
  return { state, scope: { case_id, nonce, mission_id: mission.id, run_ids: runs.map(run => run.id), authority: negativeAuthority(state, mission.id) } }
}

test('complete TF02/03 enumeration includes omitted native boundaries explicitly', () => {
  assert.deepEqual(requiredAdversarialCases, [
    'missing-file', 'altered-content', 'undeclared-file', 'cross-corp', 'cross-task', 'cross-run', 'cross-recovery',
    'cross-room', 'traversal', 'destination-symlink', 'destination-reparse', 'file-count-limit',
    'oversized-file', 'wire-file-byte-limit', 'aggregate-byte-limit', 'prompt-byte-limit',
    'envelope-byte-limit', 'exact-limit-control', 'parent-tree-isolation', 'invalid-probe',
    'failed-parent', 'cancelled-parent', 'unauthorized-artifact',
  ])
  const rows = initialAdversarialCoverage()
  assert.equal(rows.filter(row => row.status === 'not_executed').length, 23)
  const result = adversarialCoverageResult(rows)
  assert.equal(result.accepted, false)
  assert.equal(result.native_cases_observed, 0)
  assert.deepEqual(result.missing_cases, [...requiredAdversarialCases])
  for (const bad of [[], rows.slice(1), [...rows, rows[0]], rows.map(row => ({ ...row, status: 'passed' }))]) {
    assert.throws(() => adversarialCoverageResult(bad))
  }
})

for (const case_id of negativeFixtureCases) {
  test(`${case_id}: observer requires exact native construction and rejection assertions`, () => {
    const { state, scope } = nativeShape(case_id)
    const proof = assertNativeNegativeOutcome(state, scope)
    assert.equal(proof.assertions.length, 4)
    const coverage = initialAdversarialCoverage().map(row => row.case_id === case_id ? proof : row)
    assert.equal(adversarialCoverageResult(coverage).accepted, false)
    assert.equal(adversarialCoverageResult(coverage).native_cases_observed, 1)
    for (const mutate of [
      s => { s.snapshot.missions[0].status = 'completed' },
      s => { s.snapshot.tasks[2].attempt_count = 1 },
      s => { s.snapshot.tasks[0].contract.write_scope = ['**'] },
      s => { s.snapshot.runs[0].workspace_disposition = 'removed' },
      s => { s.snapshot.runs[0].status = 'cancelled' },
      s => { s.snapshot.runs[0].corp_id = id(999) },
      s => { s.snapshot.runs[0].task_id = s.snapshot.runs[1].task_id },
      s => { s.snapshot.runs.push({ id: id(77), task_id: s.snapshot.tasks[2].id }) },
      s => { s.snapshot.events = s.snapshot.events.filter(e => e.type !== 'run.output') },
      s => { s.snapshot.events.push({ type: 'run.completed', aggregate_id: s.snapshot.runs[0].id }) },
      s => { const e = s.snapshot.events.find(e => e.type === 'run.output'); e.payload.text = e.payload.text.replace(nonce, id(777)) },
      s => { s.snapshot.events.push(s.snapshot.events.find(e => e.type === 'run.output')) },
    ]) {
      const modified = structuredClone(state); mutate(modified)
      assert.throws(() => assertNativeNegativeOutcome(modified, scope))
    }
    if (case_id !== 'failed-parent') {
      for (const mutate of [
        s => { s.snapshot.verification_evidence.pop() },
        s => { s.snapshot.verification_evidence[0].check_index = 1 },
        s => { s.snapshot.verification_evidence[0].status = 'failed' },
        s => { s.snapshot.verification_evidence[3].payload.exit_code = null },
        s => { s.snapshot.verification_evidence[3].payload.resolved_executable = null },
        s => { s.snapshot.verification_evidence[2].payload.sha256 = 'b'.repeat(64) },
      ]) { const modified = structuredClone(state); mutate(modified); assert.throws(() => assertNativeNegativeOutcome(modified, scope)) }
    }
    for (const invalid of [
      { ...proof, assertions: [] }, { ...proof, assertions: proof.assertions.slice(1) },
      { ...proof, evidence_scope: 'unit-test' }, { ...proof, snapshot_sha256: null },
      { ...proof, case_id: 'cross-task' },
    ]) assert.throws(() => adversarialCoverageResult(
      initialAdversarialCoverage().map(row => row.case_id === invalid.case_id ? invalid : row)))
  })
}

test('native plan must retain the exact source, checks, attempts, and declared handoff paths', () => {
  const { state, scope } = nativeShape('missing-file')
  state.snapshot.missions[0].status = 'ready'
  state.snapshot.runs = []
  for (const task of state.snapshot.tasks) task.attempt_count = 0
  assertNegativePlan(state, scope.mission_id, source)
  for (const mutate of [
    s => { s.snapshot.tasks[0].verification_policy.checks.pop() },
    s => { s.snapshot.tasks[0].verification_policy.checks[3].args[1] = 'process.exit(0)' },
    s => { s.snapshot.tasks[0].max_attempts = 2 },
    s => { s.snapshot.tasks[0].contract.source_base_commit = 'b'.repeat(40) },
    s => { s.snapshot.tasks[1].contract.deliverable.paths = ['other.txt'] },
    s => { s.snapshot.tasks[2].depends_on = [] },
    s => { s.snapshot.tasks[0].verification_policy.manual_gate = { type: 'human_approval' } },
  ]) { const changed = structuredClone(state); mutate(changed); assert.throws(() => assertNegativePlan(changed, scope.mission_id, source)) }
})

test('fake-only fault markers require exact operator nonce and reject unknown or duplicate markers', () => {
  assert.equal(negativeFixtureSelection('ordinary mission'), null)
  const marker = `MISSION: [issue297-adversarial:missing-file:${nonce}]`
  assert.deepEqual(negativeFixtureSelection(marker, { CRONY_ISSUE297_ADVERSARIAL_NONCE: nonce }), { case_id: 'missing-file', nonce })
  assert.deepEqual(negativeFixtureSelection(`${marker}\nOBJECTIVE: Independently produce one concrete approach for this mission: ${marker.slice(9)}`,
    { CRONY_ISSUE297_ADVERSARIAL_NONCE: nonce }), { case_id: 'missing-file', nonce })
  for (const [mission, env] of [
    [marker, {}], [marker, { CRONY_ISSUE297_ADVERSARIAL_NONCE: id(97) }],
    [marker.replace('missing-file', 'cross-run'), { CRONY_ISSUE297_ADVERSARIAL_NONCE: nonce }],
    [`${marker}\n${marker}`, { CRONY_ISSUE297_ADVERSARIAL_NONCE: nonce }],
    [`${marker} [issue297-adversarial:malformed]`, { CRONY_ISSUE297_ADVERSARIAL_NONCE: nonce }],
    ['[issue297-adversarial:malformed]', {}],
  ]) assert.throws(() => negativeFixtureSelection(mission, env))
})

async function ownedFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'issue297-negative-fixture-'))
  let passed = false
  t.after(async () => {
    if (passed) await rm(root, { recursive: true })
    else console.error(`Preserved failed source-bound fixture: ${root}`)
  })
  return { root, done() { passed = true } }
}

for (const case_id of negativeFixtureCases) {
  test(`${case_id}: real checked-in fake process constructs the opted-in negative, not native acceptance`, async (t) => {
    const fixture = await ownedFixture(t)
    const workspace = path.join(fixture.root, 'workspaces', 'runs', 'owned')
    await mkdir(workspace, { recursive: true })
    const runId = randomUUID()
    const files = ['handoffs/specialist-a.md', 'handoffs/specialist-a-probe.json']
    const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]))
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/fake-agent.mjs', import.meta.url)),
      '--run-id', runId, '--workdir', workspace, '--mission',
      `MISSION: [issue297-adversarial:${case_id}:${nonce}]\nOBJECTIVE: Independently produce one concrete approach for this mission: [issue297-adversarial:${case_id}:${nonce}]\nEXPECTED OUTPUT: Verified research files: ${files.join(', ')}`,
    ], { env: { ...environment, CRONY_ISSUE297_ADVERSARIAL_NONCE: nonce }, timeout: 10000,
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 })
    await writeFile(path.join(fixture.root, 'child.stdout.txt'), child.stdout)
    await writeFile(path.join(fixture.root, 'child.stderr.txt'), child.stderr)
    assert.equal(child.error, undefined)
    assert.equal(child.status, 0, child.stderr)
    const events = child.stdout.trim().split(/\r?\n/).map(JSON.parse)
    const marker = events.filter(e => e.text?.startsWith('ISSUE297 NEGATIVE FIXTURE: '))
    assert.equal(marker.length, 1)
    const proof = JSON.parse(marker[0].text.slice('ISSUE297 NEGATIVE FIXTURE: '.length))
    assert.equal(proof.case_id, case_id)
    assert.equal(proof.run_id, runId)
    assert.equal(proof.nonce, nonce)
    if (case_id === 'missing-file') await assert.rejects(readFile(path.join(workspace, files[0])), { code: 'ENOENT' })
    if (case_id === 'oversized-file') assert.equal((await readFile(path.join(workspace, files[0]))).length, 6145)
    if (case_id === 'invalid-probe') assert.equal(await readFile(path.join(workspace, files[1]), 'utf8'), '{"observed":')
    if (case_id === 'failed-parent') {
      assert.equal(events.filter(e => e.type === 'failed').length, 1)
      assert.equal(events.filter(e => ['artifact', 'completed'].includes(e.type)).length, 0)
    } else assert.equal(events.filter(e => e.type === 'completed').length, 1)
    fixture.done()
  })
}

test('negative file mutator rejects unapproved paths before filesystem effects', async () => {
  await assert.rejects(applyNegativeResearchFixture({ selection: { case_id: 'missing-file', nonce },
    files: ['../outside.md', 'handoffs/specialist-a-probe.json'], workspace: 'not-used', runId: id(50) }),
  /exact native research paths/)
})

test('real adversarial CLI with nonce but no QA context cannot emit success or fall back', () => {
  const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]))
  const child = spawnSync(process.execPath, [
    fileURLToPath(new URL('./e2e_research_handoff.mjs', import.meta.url)),
    '--case', 'adversarial', '--require-owned-qa',
  ], { env: { ...environment, CRONY_RESEARCH_HANDOFF_TEST: '1', CRONY_ISSUE297_ADVERSARIAL_NONCE: nonce },
    timeout: 5000, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 1)
  assert.equal(child.stdout, '')
  const failure = JSON.parse(child.stderr)
  assert.equal(failure.phase, 'failed')
  assert.equal(failure.checkpoint, null)
  assert.match(failure.error, /ECORP_ISSUE297_QA_CONTEXT/)
})
