import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CI_LIMITS, CI_SCOPE, createMetadataReader, hostedSelection, main, observeCi, parseArgs, renderHandoff } from './ci_maintenance.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const now = () => new Date('2026-09-18T16:00:00.000Z')
const selection = { runId: 123, attempt: 1, headSha: 'a'.repeat(40), previous: null }
const rootRoute = `repos/${CI_SCOPE.repository}/actions`
function fixture() {
  return {
    workflow: { id: 456, name: CI_SCOPE.workflow_name, path: CI_SCOPE.workflow_path },
    run: { id: 123, run_attempt: 1, head_sha: selection.headSha, head_branch: 'codex/example', workflow_id: 456,
      path: CI_SCOPE.workflow_path, repository: { id: CI_SCOPE.repository_id, full_name: CI_SCOPE.repository },
      head_repository: { id: CI_SCOPE.repository_id }, status: 'completed', conclusion: 'failure', event: 'pull_request',
      run_started_at: '2026-09-18T15:00:00Z', updated_at: '2026-09-18T15:01:00Z' },
    jobs: [{ id: 789, run_id: 123, run_attempt: 1, head_sha: selection.headSha, name: 'Web model coverage', status: 'completed', conclusion: 'failure',
      steps: [{ number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Measure every declared production web model', status: 'completed', conclusion: 'failure' }] }],
    artifacts: [],
  }
}
function readerFor(data = fixture(), transform = value => value) {
  const calls = []
  const reader = createMetadataReader({ run: async args => {
    calls.push(args)
    const route = args.at(-1); let value
    if (route === `${rootRoute}/workflows/repository-checks.yml`) value = data.workflow
    else if (/\/jobs\?per_page=100&page=[12]$/u.test(route)) {
      const page = Number(route.at(-1)); value = { total_count: data.jobs.length, jobs: data.jobs.slice((page - 1) * 100, page * 100) }
    } else if (route.endsWith('/artifacts?per_page=20&page=1')) value = { total_count: data.artifacts.length, artifacts: data.artifacts }
    else value = data.run
    return JSON.stringify(transform(structuredClone(value), route, calls.length))
  } })
  return { reader, calls }
}
const artifact = (overrides = {}) => ({ id: 321, name: 'web-model-coverage', expired: false, digest: `sha256:${'b'.repeat(64)}`,
  workflow_run: { id: 123, repository_id: CI_SCOPE.repository_id, head_repository_id: CI_SCOPE.repository_id, head_sha: selection.headSha }, ...overrides })
const previousOption = receipt => { const bytes = Buffer.from(JSON.stringify(receipt)); return { bytes, reference: { path: '/not-read-by-pure-observer', sha256: sha(bytes) } } }
function temporary(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ecorp-ci-maintenance-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('ecorp-ci-maintenance-')); assert.equal(lstatSync(directory).isSymbolicLink(), false)
    rmSync(directory, { recursive: true })
  })
  return directory
}

test('exact terminal metadata produces actionable failure and missing-evidence findings using GET only', async () => {
  const { reader, calls } = readerFor()
  const receipt = await observeCi(selection, { reader, now })
  assert.equal(receipt.status, 'recorded'); assert.equal(receipt.findings.length, 6)
  assert.deepEqual(receipt.findings.filter(row => row.rule !== 'EXPECTED_JOB_MISSING').map(row => row.rule).sort(), ['EVIDENCE_ARTIFACT_MISSING', 'JOB_REQUIRES_REVIEW'])
  assert.equal(receipt.github_mutations, 0); assert.equal(receipt.executable, false)
  assert.equal(receipt.read_evidence.downloaded_artifact_bytes, 0); assert.equal(receipt.assurance.test_counts_or_coverage_claimed, false)
  assert.equal(calls.length, 5)
  assert.ok(calls.every(args => args[0] === 'api' && args[1] === '--hostname' && args[2] === 'github.com' && args[3] === '--method' && args[4] === 'GET'))
  assert.match(renderHandoff(receipt), /actions\/runs\/123\/job\/789/u)
})

test('listed artifact is run-scoped metadata and never establishes content or attempt verification', async () => {
  const data = fixture(); data.artifacts = [artifact()]
  const receipt = await observeCi(selection, { reader: readerFor(data).reader, now })
  assert.equal(receipt.findings.filter(row => row.rule !== 'EXPECTED_JOB_MISSING').length, 1)
  assert.equal(receipt.observation.artifacts[0].attempt_binding, 'not-exposed-by-api')
  assert.equal(receipt.observation.artifacts[0].bytes_read, false)
  assert.equal(receipt.assurance.artifact_contents_verified, false)
})

for (const [name, mutate, code] of [
  ['active parent', d => { d.run.status = 'in_progress'; d.run.conclusion = null }, 'run_not_terminal'],
  ['wrong repository', d => { d.run.repository.id++ }, 'run_binding_mismatch'],
  ['foreign head repository', d => { d.run.head_repository.id++ }, 'run_binding_mismatch'],
  ['different workflow', d => { d.workflow.path = '.github/workflows/other.yml' }, 'workflow_binding_mismatch'],
  ['different head', d => { d.run.head_sha = 'c'.repeat(40) }, 'run_binding_mismatch'],
  ['different attempt', d => { d.run.run_attempt++ }, 'run_binding_mismatch'],
  ['job from other attempt', d => { d.jobs[0].run_attempt++ }, 'job_binding_mismatch'],
  ['job from other head', d => { d.jobs[0].head_sha = 'c'.repeat(40) }, 'job_binding_mismatch'],
  ['duplicate job', d => { d.jobs.push(structuredClone(d.jobs[0])) }, 'job_binding_mismatch'],
  ['unfinished job', d => { d.jobs[0].status = 'in_progress' }, 'incomplete_job_metadata'],
  ['foreign artifact', d => { const a = artifact(); a.workflow_run.head_sha = 'c'.repeat(40); d.artifacts = [a] }, 'artifact_binding_mismatch'],
  ['excess artifacts', d => { d.artifacts = Array.from({ length: 21 }, (_, i) => artifact({ id: i + 1 })) }, 'incomplete_artifact_pagination'],
]) test(`refuses ${name}`, async () => {
  const data = fixture(); mutate(data)
  await assert.rejects(observeCi(selection, { reader: readerFor(data).reader, now }), { code })
})

test('complete bounded job pagination is required and supported', async () => {
  const data = fixture(); data.jobs = Array.from({ length: 101 }, (_, i) => ({ ...data.jobs[0], id: i + 1, name: `Job ${i + 1}`, steps: [] }))
  const { reader, calls } = readerFor(data)
  assert.equal((await observeCi(selection, { reader, now })).observation.jobs.length, 101)
  assert.ok(calls.some(args => args.at(-1).endsWith('page=2')))
  const incomplete = readerFor(data, (value, route) => route.includes('/jobs?') ? { ...value, jobs: value.jobs.slice(0, 1) } : value)
  await assert.rejects(observeCi(selection, { reader: incomplete.reader, now }), { code: 'incomplete_job_pagination' })
})

test('pagination total drift and final run drift refuse a completed observation', async () => {
  const data = fixture(); data.jobs = Array.from({ length: 101 }, (_, i) => ({ ...data.jobs[0], id: i + 1, name: `Job ${i + 1}`, steps: [] }))
  const changed = readerFor(data, (value, route) => route.endsWith('page=2') ? { ...value, total_count: 102 } : value)
  await assert.rejects(observeCi(selection, { reader: changed.reader, now }), { code: 'incomplete_job_pagination' })
  const drift = readerFor(fixture(), (value, route, call) => call === 5 ? { ...value, conclusion: 'cancelled' } : value)
  await assert.rejects(observeCi(selection, { reader: drift.reader, now }), { code: 'run_changed_during_observation' })
})

test('expired artifacts and unexplained parent failure remain reviewable rather than passing', async () => {
  const data = fixture(); data.artifacts = [artifact({ expired: true })]; data.jobs[0].conclusion = 'success'
  const receipt = await observeCi(selection, { reader: readerFor(data).reader, now })
  assert.deepEqual(receipt.findings.filter(row => row.rule !== 'EXPECTED_JOB_MISSING').map(row => row.rule).sort(), ['EVIDENCE_ARTIFACT_EXPIRED', 'PARENT_CONCLUSION_REVIEW'])
  assert.ok(!renderHandoff(receipt).includes('/job/null'))
})

test('same-source replay is a no-op; changed facts retain revisions and mark no-longer-observed findings', async () => {
  const first = await observeCi(selection, { reader: readerFor().reader, now }), prior = previousOption(first)
  const options = { ...selection, previous: prior.reference }
  const second = await observeCi(options, { reader: readerFor().reader, previousBytes: prior.bytes, now })
  assert.equal(second.status, 'no-op'); assert.deepEqual(second.new_or_changed_finding_ids, [])
  assert.equal(second.observation_key, first.observation_key); assert.match(renderHandoff(second), /No new review work/u)
  const data = fixture(); data.run.conclusion = 'success'; data.jobs[0].conclusion = 'success'
  data.jobs[0].steps[1].conclusion = 'success'; data.artifacts = [artifact()]
  const changed = await observeCi(options, { reader: readerFor(data).reader, previousBytes: prior.bytes, now })
  assert.equal(changed.status, 'changed'); assert.equal(changed.findings.filter(row => row.rule !== 'EXPECTED_JOB_MISSING').length, 0)
  assert.equal(changed.no_longer_observed_finding_ids.length, 2); assert.equal(changed.assurance.source_repair_claimed, false)
})

test('previous hash tampering refuses before network reads', async () => {
  const { reader, calls } = readerFor()
  await assert.rejects(observeCi({ ...selection, previous: { sha256: '0'.repeat(64) } }, { reader, previousBytes: Buffer.from('{}'), now }), { code: 'previous_bytes_mismatch' })
  assert.equal(calls.length, 0)
})

test('forged previous findings fail integrity or semantic reconstruction; source changes require a new scope', async () => {
  const first = await observeCi(selection, { reader: readerFor().reader, now })
  const changed = structuredClone(first); changed.findings[0].recommendation = 'Invented approval'
  let prior = previousOption(changed)
  await assert.rejects(observeCi({ ...selection, previous: prior.reference }, { reader: readerFor().reader, previousBytes: prior.bytes, now }), { code: 'previous_integrity_mismatch' })
  const { integrity_sha256: _old, ...body } = changed; changed.integrity_sha256 = sha(canonical(body)); prior = previousOption(changed)
  await assert.rejects(observeCi({ ...selection, previous: prior.reference }, { reader: readerFor().reader, previousBytes: prior.bytes, now }), { code: 'previous_facts_mismatch' })
  prior = previousOption(first); const data = fixture(); data.run.head_sha = 'b'.repeat(40); data.jobs[0].head_sha = 'b'.repeat(40)
  await assert.rejects(observeCi({ ...selection, headSha: 'b'.repeat(40), previous: prior.reference }, { reader: readerFor(data).reader, previousBytes: prior.bytes, now }), { code: 'previous_source_mismatch' })
})

test('newer prior observations and attempts do not flow backward', async () => {
  const first = await observeCi(selection, { reader: readerFor().reader, now }), prior = previousOption(first)
  await assert.rejects(observeCi({ ...selection, previous: prior.reference }, { reader: readerFor().reader, previousBytes: prior.bytes,
    now: () => new Date('2026-09-18T15:59:59Z') }), { code: 'previous_observation_newer' })
  const data = fixture(); data.run.run_attempt = 2; data.jobs[0].run_attempt = 2
  const newer = previousOption(await observeCi({ ...selection, attempt: 2 }, { reader: readerFor(data).reader, now }))
  await assert.rejects(observeCi({ ...selection, previous: newer.reference }, { reader: readerFor().reader, previousBytes: newer.bytes, now }), { code: 'previous_attempt_newer' })
})

test('secret-bearing fields and supplied links never enter a receipt or executable Markdown', async () => {
  const secret = 'ghp_' + 'A'.repeat(35), data = fixture()
  data.run.secret = secret; data.run.repository.owner = { login: 'private-owner', token: secret }
  data.jobs[0].runner_name = secret; data.jobs[0].html_url = 'https://evil.invalid/secret'
  data.jobs[0].steps[1].name = `failure ${secret} [click](https://evil.invalid) <script>`
  data.artifacts = [artifact({ name: secret, archive_download_url: 'https://evil.invalid/zip' })]
  const receipt = await observeCi(selection, { reader: readerFor(data).reader, now })
  const stored = JSON.stringify(receipt), rendered = renderHandoff(receipt)
  assert.ok(!stored.includes(secret) && !stored.includes('private-owner') && !stored.includes('archive_download_url'))
  assert.ok(!rendered.includes(secret) && !rendered.includes('<script>') && !rendered.includes('[click](https://evil.invalid)'))
  assert.ok(rendered.includes('[REDACTED]') || rendered.includes('\\[REDACTED\\]'))
})

test('native read budget rejects alternate endpoints, oversized metadata and late responses', async () => {
  let calls = 0
  const reader = createMetadataReader({ run: async () => { calls++; return '{}' } })
  await assert.rejects(reader.get(`repos/${CI_SCOPE.repository}/issues`), { code: 'route_not_allowed' }); assert.equal(calls, 0)
  const large = createMetadataReader({ run: async () => Buffer.alloc(CI_LIMITS.response_bytes + 1) })
  await assert.rejects(large.get(`${rootRoute}/workflows/repository-checks.yml`), { code: 'read_budget_exhausted' })
  let clock = 0
  const late = createMetadataReader({ clock: () => clock, run: async () => { clock = CI_LIMITS.duration_ms + 1; return '{}' } })
  await assert.rejects(late.get(`${rootRoute}/workflows/repository-checks.yml`), { code: 'read_budget_exhausted' })
})

test('omitting all required jobs cannot turn one replacement success job into a complete maintenance result', async () => {
  const data = fixture(); data.run.conclusion = 'success'
  data.jobs = [{ ...data.jobs[0], name: 'Unexpected replacement', conclusion: 'success', steps: [] }]
  const receipt = await observeCi(selection, { reader: readerFor(data).reader, now })
  assert.equal(receipt.findings.length, 5)
  assert.ok(receipt.findings.every(row => row.rule === 'EXPECTED_JOB_MISSING' && row.job_id === null))
  assert.ok(receipt.findings.some(row => row.job_name === 'Web model coverage'))
  assert.match(renderHandoff(receipt), /Required Repository checks job is absent/u)
})

for (const conclusion of ['skipped', 'neutral']) test(`required ${conclusion} job needs review even when an earlier run artifact is listed`, async () => {
  const data = fixture(); data.run.conclusion = 'success'
  data.jobs[0].conclusion = conclusion; data.jobs[0].steps = []
  data.artifacts = [artifact()]
  const receipt = await observeCi(selection, { reader: readerFor(data).reader, now })
  const finding = receipt.findings.find(row => row.rule === 'EXPECTED_JOB_NOT_EXECUTED')
  assert.ok(finding, 'A required gate did not execute successfully and cannot disappear from the handoff')
  assert.equal(finding.job_id, 789); assert.equal(finding.conclusion, conclusion)
  assert.match(renderHandoff(receipt), /Required Repository checks job did not report a successful execution/u)
  assert.equal(receipt.assurance.test_counts_or_coverage_claimed, false)
})

test('failed GETs consume the finite shared admission budget without retries', async () => {
  let calls = 0
  const reader = createMetadataReader({ run: async () => { calls++; throw Error('Withheld service detail') } })
  for (let i = 0; i < CI_LIMITS.requests; i++) await assert.rejects(reader.get(`${rootRoute}/workflows/repository-checks.yml`), { code: 'github_metadata_unavailable' })
  await assert.rejects(reader.get(`${rootRoute}/workflows/repository-checks.yml`), { code: 'read_budget_exhausted' })
  assert.equal(calls, CI_LIMITS.requests); assert.equal(reader.evidence().attempted_requests, CI_LIMITS.requests)
  assert.deepEqual(reader.evidence().requests, [])
})

test('CLI writes new bounded files and refuses output reuse; failures retain no raw API error', async t => {
  const directory = temporary(t), output = path.join(directory, 'result')
  const args = ['observe', '--run-id', '123', '--run-attempt', '1', '--head-sha', selection.headSha, '--out', output]
  const result = await main(args, { env: {}, reader: readerFor().reader, now })
  assert.equal(result.status, 'recorded'); assert.ok(existsSync(path.join(output, 'receipt.json')))
  const before = readFileSync(path.join(output, 'receipt.json'))
  await assert.rejects(main(args, { env: {}, reader: readerFor().reader, now }), { code: 'EEXIST' })
  assert.ok(before.equals(readFileSync(path.join(output, 'receipt.json'))))
  const failedOutput = path.join(directory, 'failed'), secret = 'private API failure text'
  await assert.rejects(main([...args.slice(0, -1), failedOutput], { env: {}, reader: createMetadataReader({ run: async () => { throw Error(secret) } }), now }), { code: 'github_metadata_unavailable' })
  assert.ok(!readFileSync(path.join(failedOutput, 'failure.json'), 'utf8').includes(secret))
})

test('hosted context binds default observer branch, event and exact parent; local mode makes no hosted claim', t => {
  const directory = temporary(t), eventPath = path.join(directory, 'event.json')
  const event = { action: 'completed', repository: { id: CI_SCOPE.repository_id }, workflow_run: { id: 123, run_attempt: 1,
    head_sha: selection.headSha, head_repository: { id: CI_SCOPE.repository_id }, status: 'completed',
    workflow_id: 456, path: CI_SCOPE.workflow_path, name: CI_SCOPE.workflow_name } }
  writeFileSync(eventPath, JSON.stringify(event))
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: CI_SCOPE.repository,
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'b'.repeat(40), GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKFLOW_REF: `${CI_SCOPE.repository}/.github/workflows/ci-maintenance.yml@refs/heads/main` }
  assert.equal(hostedSelection(env, selection).kind, 'github-actions-context')
  assert.throws(() => hostedSelection({ ...env, GITHUB_REF: 'refs/pull/326/merge' }, selection), { code: 'untrusted_workflow_context' })
  assert.throws(() => hostedSelection(env, { ...selection, attempt: 2 }), { code: 'workflow_event_binding_mismatch' })
  assert.equal(hostedSelection({}, selection).hosted_execution_claimed, false)
})

test('CLI accepts only bounded exact selection and a complete prior pin', () => {
  const directory = path.resolve(os.tmpdir(), 'new-ci-observation')
  const args = ['observe', '--run-id', '123', '--run-attempt', '1', '--head-sha', selection.headSha, '--out', directory]
  assert.equal(parseArgs(args).runId, 123)
  for (const changed of [[], [...args, '--token', 'forbidden'], [...args, '--previous', directory], [...args, '--run-id', '124'],
    args.map(value => value === '123' ? '1e3' : value), args.map(value => value === selection.headSha ? 'main' : value)]) {
    assert.throws(() => parseArgs(changed))
  }
})

function ciFixture() {
  const data = fixture()
  data.workflow = { id: 654, name: 'CI', path: '.github/workflows/ci.yml' }
  Object.assign(data.run, { workflow_id: 654, path: data.workflow.path, conclusion: 'success' })
  const reports = {
    quality: null, integration: 'integration-evidence',
    'runner-platforms (ubuntu-latest)': 'runner-platform-ubuntu-latest',
    'runner-platforms (windows-latest)': 'runner-platform-windows-latest',
    'runner-platforms (macos-latest)': 'runner-platform-macos-latest',
    'desktop-windows': null,
  }
  data.jobs = Object.keys(reports).map((name, i) => ({ ...data.jobs[0], id: 800 + i, name, conclusion: 'success', steps: [] }))
  data.artifacts = Object.values(reports).filter(Boolean).map((name, i) => artifact({ id: 900 + i, name }))
  return data
}
function ciReader(data, transform = value => value) {
  const calls = []
  const reader = createMetadataReader({ run: async args => {
    const route = args.at(-1); calls.push(route)
    const value = route.endsWith('/workflows/ci.yml') ? data.workflow
      : route.endsWith('/workflows/repository-checks.yml') ? fixture().workflow
        : /\/jobs\?per_page=100&page=[12]$/u.test(route) ? { total_count: data.jobs.length, jobs: data.jobs.slice((Number(route.at(-1)) - 1) * 100, Number(route.at(-1)) * 100) }
          : route.endsWith('/artifacts?per_page=20&page=1') ? { total_count: data.artifacts.length, artifacts: data.artifacts }
            : data.run
    return JSON.stringify(transform(structuredClone(value), route))
  } })
  return { reader, calls }
}

test('CI workflow: exact Windows runner failure produces a scoped read-only handoff', async () => {
  const data = ciFixture(); data.run.conclusion = 'failure'
  const windows = data.jobs.find(job => job.name === 'runner-platforms (windows-latest)')
  windows.conclusion = 'failure'
  windows.steps = [{ number: 1, name: 'Run runner tests', status: 'completed', conclusion: 'failure' }]
  const { reader, calls } = ciReader(data)
  const receipt = await observeCi(selection, { reader, now })
  assert.equal(receipt.observation.run.workflow_path, '.github/workflows/ci.yml')
  assert.deepEqual(receipt.findings.map(finding => [finding.rule, finding.job_id]), [['JOB_REQUIRES_REVIEW', windows.id]])
  assert.match(renderHandoff(receipt), /^# CI: review handoff/u)
  assert.ok(calls.includes(`${rootRoute}/workflows/ci.yml`))
  assert.ok(!calls.includes(`${rootRoute}/workflows/repository-checks.yml`))
  assert.equal(calls.length, 5)
  assert.equal(receipt.github_mutations, 0)
  assert.equal(receipt.assurance.source_repair_claimed, false)
})

test('CI workflow: complete successful jobs need only their own declared report artifacts', async () => {
  const receipt = await observeCi(selection, { reader: ciReader(ciFixture()).reader, now })
  assert.deepEqual(receipt.findings, [])
  assert.equal(receipt.observation.jobs.length, 6)
  assert.equal(receipt.observation.artifacts.length, 4)
  assert.equal(receipt.assurance.artifact_contents_verified, false)
})

test('CI workflow: required artifact-free jobs remain required and must execute', async () => {
  const data = ciFixture()
  data.jobs = data.jobs.filter(job => job.name !== 'quality')
  data.jobs.find(job => job.name === 'desktop-windows').conclusion = 'skipped'
  const receipt = await observeCi(selection, { reader: ciReader(data).reader, now })
  assert.ok(receipt.findings.some(finding => finding.rule === 'EXPECTED_JOB_MISSING' && finding.job_name === 'quality'))
  assert.ok(receipt.findings.some(finding => finding.rule === 'EXPECTED_JOB_NOT_EXECUTED' && finding.job_name === 'desktop-windows'))
  assert.ok(!receipt.findings.some(finding => finding.rule.startsWith('EVIDENCE_ARTIFACT_')))
})

test('Repository checks retains its published contract and previous-receipt no-op semantics', async () => {
  const receipt = await observeCi(selection, { reader: readerFor().reader, now })
  assert.equal(receipt.contract_sha256, '9f7e997a220b5ac5c16a32c22a5396137d9a2fe4d9686e82efa18e34548df7e6')
  const prior = previousOption(receipt)
  const replay = await observeCi({ ...selection, previous: prior.reference }, { reader: readerFor().reader, now, previousBytes: prior.bytes })
  assert.equal(replay.status, 'no-op')
  assert.deepEqual(replay.findings, receipt.findings)
  assert.equal(replay.semantic_sha256, receipt.semantic_sha256)
})

for (const conclusion of ['skipped', 'neutral']) {
  test(`CI completeness refuses ${conclusion} artifact-free required jobs`, async () => {
    const data = ciFixture()
    for (const job of data.jobs.filter(job => ['quality', 'desktop-windows'].includes(job.name))) job.conclusion = conclusion
    const receipt = await observeCi(selection, { reader: ciReader(data).reader, now })
    assert.deepEqual(receipt.findings.map(finding => [finding.rule, finding.job_name]).sort(), [
      ['EXPECTED_JOB_NOT_EXECUTED', 'desktop-windows'], ['EXPECTED_JOB_NOT_EXECUTED', 'quality'],
    ])
  })
}

test('CI completeness rejects replacement jobs and requires only CI report metadata', async () => {
  const data = ciFixture()
  data.jobs = [{ ...data.jobs[0], name: 'replacement-only' }]
  const missing = await observeCi(selection, { reader: ciReader(data).reader, now })
  assert.equal(missing.findings.length, 6)
  assert.ok(missing.findings.every(finding => finding.rule === 'EXPECTED_JOB_MISSING'))
  const complete = ciFixture(); complete.artifacts = [artifact()]
  const reports = await observeCi(selection, { reader: ciReader(complete).reader, now })
  assert.equal(reports.findings.length, 4)
  assert.ok(reports.findings.every(finding => finding.rule === 'EVIDENCE_ARTIFACT_MISSING'))
  assert.equal(reports.observation.artifacts[0].name, null, 'Repository checks artifact does not satisfy CI evidence')
})

test('CI observation is not a parent-pass claim and does not inspect diagnostic artifacts', async () => {
  const data = ciFixture(); data.run.conclusion = 'failure'
  data.artifacts.push(artifact({ id: 999, name: 'runner-platform-windows-readiness-1' }))
  const { reader, calls } = ciReader(data)
  const receipt = await observeCi(selection, { reader, now })
  assert.deepEqual(receipt.findings.map(finding => finding.rule), ['PARENT_CONCLUSION_REVIEW'])
  assert.equal(receipt.findings[0].job_name, 'CI')
  assert.ok(calls.every(route => !/\/logs|\/zip|\/download/u.test(route)))
  assert.equal(receipt.read_evidence.downloaded_artifact_bytes, 0)
  assert.equal(receipt.assurance.artifact_attempt_binding, 'not-exposed-by-api')
})

test('workflow profiles cannot reuse each other\'s receipts even at the same source', async () => {
  const legacy = await observeCi(selection, { reader: readerFor().reader, now })
  const ci = await observeCi(selection, { reader: ciReader(ciFixture()).reader, now })
  assert.notEqual(ci.contract_sha256, legacy.contract_sha256)
  for (const [previous, reader] of [[legacy, ciReader(ciFixture()).reader], [ci, readerFor().reader]]) {
    const prior = previousOption(previous)
    await assert.rejects(observeCi({ ...selection, previous: prior.reference }, { reader, now, previousBytes: prior.bytes }), { code: 'invalid_previous_receipt' })
  }
  const prior = previousOption(ci)
  const replay = await observeCi({ ...selection, previous: prior.reference }, { reader: ciReader(ciFixture()).reader, now, previousBytes: prior.bytes })
  assert.equal(replay.status, 'no-op')
})

for (const [name, mutate, code] of [
  ['unknown workflow path', data => { data.run.path = '.github/workflows/arbitrary.yml' }, 'workflow_binding_mismatch'],
  ['workflow-ID substitution', data => { data.run.workflow_id++ }, 'run_binding_mismatch'],
  ['workflow-name substitution', data => { data.workflow.name = 'Repository checks' }, 'workflow_binding_mismatch'],
  ['workflow-path substitution', data => { data.workflow.path = CI_SCOPE.workflow_path }, 'workflow_binding_mismatch'],
  ['foreign repository', data => { data.run.repository.id++ }, 'run_binding_mismatch'],
  ['fork head repository', data => { data.run.head_repository.id++ }, 'run_binding_mismatch'],
  ['wrong source head', data => { data.run.head_sha = 'c'.repeat(40) }, 'run_binding_mismatch'],
  ['wrong attempt', data => { data.run.run_attempt++ }, 'run_binding_mismatch'],
  ['active CI parent', data => { data.run.status = 'in_progress'; data.run.conclusion = null }, 'run_not_terminal'],
]) test(`CI identity refuses ${name}`, async () => {
  const data = ciFixture(); mutate(data)
  const { reader, calls } = ciReader(data)
  await assert.rejects(observeCi(selection, { reader, now }), { code })
  assert.ok(calls.every(route => !route.includes('arbitrary.yml')))
})

test('reader allowlist admits exactly the two workflow metadata routes', async () => {
  let calls = 0
  const reader = createMetadataReader({ run: async () => { calls++; return '{}' } })
  for (const file of ['repository-checks.yml', 'ci.yml']) await reader.get(`${rootRoute}/workflows/${file}`)
  for (const file of ['ci-maintenance.yml', '../ci.yml', 'ci.yml?ref=other', 'other.yml']) {
    await assert.rejects(reader.get(`${rootRoute}/workflows/${file}`), { code: 'route_not_allowed' })
  }
  assert.equal(calls, 2)
})

test('hosted CI event binds workflow identity to the selected native parent', async t => {
  const directory = temporary(t), eventPath = path.join(directory, 'event.json'), data = ciFixture()
  const event = { action: 'completed', repository: { id: CI_SCOPE.repository_id }, workflow_run: {
    id: selection.runId, run_attempt: selection.attempt, head_sha: selection.headSha,
    head_repository: { id: CI_SCOPE.repository_id }, status: 'completed', workflow_id: data.workflow.id,
    path: data.workflow.path, name: data.workflow.name,
  } }
  writeFileSync(eventPath, JSON.stringify(event))
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: CI_SCOPE.repository,
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'b'.repeat(40), GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKFLOW_REF: `${CI_SCOPE.repository}/.github/workflows/ci-maintenance.yml@refs/heads/main` }
  const context = hostedSelection(env, selection)
  assert.deepEqual(context.parent_workflow, data.workflow)
  const receipt = await observeCi(selection, { reader: ciReader(data).reader, now, executionContext: context })
  assert.equal(receipt.execution_context.workflow_source_sha, env.GITHUB_SHA)
  await assert.rejects(observeCi(selection, { reader: ciReader(data).reader, now,
    executionContext: { ...context, parent_workflow: { ...context.parent_workflow, id: 456 } } }), { code: 'workflow_event_binding_mismatch' })
  for (const change of [{ path: '.github/workflows/unknown.yml' }, { name: 'Repository checks' },
    { workflow_id: null }, { head_repository: { id: 1234 } }]) {
    writeFileSync(eventPath, JSON.stringify({ ...event, workflow_run: { ...event.workflow_run, ...change } }))
    assert.throws(() => hostedSelection(env, selection))
  }
})

test('workflow trigger keeps trusted observer checkout and read-only scopes for both producers', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci-maintenance.yml', import.meta.url), 'utf8')
  assert.match(workflow, /workflows: \[Repository checks, CI\]/u)
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u)
  assert.match(workflow, /persist-credentials: false/u)
  assert.match(workflow, /contents: read\s+actions: read/u)
  assert.doesNotMatch(workflow, /contents: write|actions: write|head_sha.*checkout/u)
})
