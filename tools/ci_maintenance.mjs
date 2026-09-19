import { createHash } from 'node:crypto'
import { execFile as executeCallback } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nativeGhPath } from '../scenarios/repo-steward/lib/github.mjs'
import { markdown, safeText } from '../scenarios/repo-steward/lib/common.mjs'

// Read-only CI metadata, never logs, artifact bytes, source execution or writes to GitHub.
const execute = promisify(executeCallback)
const SELF = fileURLToPath(import.meta.url)
export const CI_SCOPE = Object.freeze({ repository: 'All-The-Vibes/ecorp', repository_id: 1350844062,
  workflow_path: '.github/workflows/repository-checks.yml', workflow_name: 'Repository checks', default_branch: 'main' })
export const CI_LIMITS = Object.freeze({ requests: 12, duration_ms: 120000, request_ms: 20000,
  response_bytes: 2 * 1024 * 1024, jobs: 200, steps_per_job: 100, artifacts: 20,
  receipt_bytes: 1024 * 1024, markdown_bytes: 65536 })
const EXPECTED_ARTIFACTS = Object.freeze({
  'Node regressions (ubuntu-latest)': 'repository-checks-ubuntu-latest',
  'Node regressions (windows-latest)': 'repository-checks-windows-latest',
  'Web model coverage': 'web-model-coverage',
  'Rust unit and SQLx coverage (Linux)': 'rust-sqlx-coverage-linux',
  'Rust unit coverage (Windows/MSVC)': 'rust-unit-coverage-windows',
})
const CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', 'neutral', 'skipped'])
const GOOD = new Set(['success', 'neutral', 'skipped'])
const HASH = /^[a-f0-9]{64}$/u, SHA = /^[a-f0-9]{40}$/u
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const digest = value => hash(canonical(value))
const CONTRACT = digest({ schema: 1, classifier_revision: 3, scope: CI_SCOPE, limits: CI_LIMITS, expected_artifacts: EXPECTED_ARTIFACTS,
  authority: 'read-only metadata; no content verification or downstream effect' })
const CI_WORKFLOW_SCOPE = Object.freeze({ ...CI_SCOPE, workflow_path: '.github/workflows/ci.yml', workflow_name: 'CI' })
const CI_EXPECTED_JOBS = Object.freeze({
  quality: null,
  integration: 'integration-evidence',
  'runner-platforms (ubuntu-latest)': 'runner-platform-ubuntu-latest',
  'runner-platforms (windows-latest)': 'runner-platform-windows-latest',
  'runner-platforms (macos-latest)': 'runner-platform-macos-latest',
  'desktop-windows': null,
})
// Keep the existing Repository checks receipt/classifier contract unchanged.
// CI has a separate contract; a required job need not produce an artifact.
const WORKFLOWS = Object.freeze([
  Object.freeze({ scope: CI_SCOPE, route: 'actions/workflows/repository-checks.yml', jobs: EXPECTED_ARTIFACTS, contract: CONTRACT }),
  Object.freeze({ scope: CI_WORKFLOW_SCOPE, route: 'actions/workflows/ci.yml', jobs: CI_EXPECTED_JOBS,
    contract: digest({ schema: 1, classifier_revision: 4, scope: CI_WORKFLOW_SCOPE, limits: CI_LIMITS,
      required_jobs: CI_EXPECTED_JOBS, authority: 'read-only metadata; no content verification or downstream effect' }) }),
])
function workflowProfile(workflowPath) {
  const profile = WORKFLOWS.find(candidate => candidate.scope.workflow_path === workflowPath)
  requireThat(profile, 'workflow_binding_mismatch')
  return profile
}
export class CiMaintenanceError extends Error { constructor(code) { super(code); this.code = code } }
const requireThat = (condition, code) => { if (!condition) throw new CiMaintenanceError(code) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const equal = (left, right) => canonical(left) === canonical(right)
const text = (value, maximum = 256) => { requireThat(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum, 'invalid_metadata_text'); return safeText(value, maximum) }
const api = tail => `repos/${CI_SCOPE.repository}/${tail}`
const runUrl = id => `https://github.com/${CI_SCOPE.repository}/actions/runs/${id}`

export function parseArgs(values) {
  requireThat(values[0] === 'observe' && values.length % 2 === 1, 'invalid_arguments')
  const options = {}
  for (let i = 1; i < values.length; i += 2) {
    requireThat(['--run-id', '--run-attempt', '--head-sha', '--out', '--previous', '--previous-sha256'].includes(values[i])
      && !Object.hasOwn(options, values[i]) && typeof values[i + 1] === 'string' && values[i + 1].length > 0, 'invalid_arguments')
    options[values[i]] = values[i + 1]
  }
  for (const key of ['--run-id', '--run-attempt']) requireThat(/^[1-9][0-9]*$/u.test(options[key] ?? '') && positive(Number(options[key])), 'invalid_identity')
  requireThat(SHA.test(options['--head-sha'] ?? '') && typeof options['--out'] === 'string' && path.isAbsolute(options['--out']), 'invalid_arguments')
  requireThat(Boolean(options['--previous']) === Boolean(options['--previous-sha256']), 'previous_pin_required')
  if (options['--previous']) requireThat(path.isAbsolute(options['--previous']) && HASH.test(options['--previous-sha256']), 'previous_pin_required')
  return { runId: Number(options['--run-id']), attempt: Number(options['--run-attempt']), headSha: options['--head-sha'],
    output: path.resolve(options['--out']), previous: options['--previous'] ? { path: options['--previous'], sha256: options['--previous-sha256'] } : null }
}

function ordinary(file, maximum) {
  const absolute = path.resolve(file), normalized = value => process.platform === 'win32' ? value.toLowerCase() : value
  for (let current = absolute;;) {
    const stat = lstatSync(current); requireThat(!stat.isSymbolicLink(), 'redirected_path')
    const next = path.dirname(current); if (next === current) break; current = next
  }
  requireThat(normalized(realpathSync(absolute)) === normalized(absolute), 'redirected_path')
  const stat = lstatSync(absolute)
  requireThat(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum, 'invalid_file_bound')
  const bytes = readFileSync(absolute); requireThat(bytes.length === stat.size, 'file_changed'); return bytes
}
function newOutput(directory) {
  const parent = path.dirname(directory), normalized = value => process.platform === 'win32' ? value.toLowerCase() : value
  for (let current = parent;;) {
    const stat = lstatSync(current); requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'redirected_path')
    const next = path.dirname(current); if (next === current) break; current = next
  }
  requireThat(normalized(realpathSync(parent)) === normalized(parent), 'redirected_path')
  mkdirSync(directory) // No overwrite, implicit retry or old-state cleanup.
  const owner = lstatSync(directory)
  return (name, value, maximum = CI_LIMITS.receipt_bytes) => {
    const stat = lstatSync(directory)
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === owner.dev && stat.ino === owner.ino
      && stat.birthtimeMs === owner.birthtimeMs && normalized(realpathSync(directory)) === normalized(directory), 'output_changed')
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value, null, 2) + '\n')
    requireThat(bytes.length <= maximum, 'output_bound')
    writeFileSync(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 })
    return { file: name, sha256: hash(bytes), bytes: bytes.length }
  }
}

export function hostedSelection(env, options) {
  if (env.GITHUB_ACTIONS !== 'true') return { kind: 'local-cli', hosted_execution_claimed: false }
  requireThat(env.GITHUB_EVENT_NAME === 'workflow_run' && env.GITHUB_REPOSITORY === CI_SCOPE.repository
    && env.GITHUB_REF === `refs/heads/${CI_SCOPE.default_branch}` && SHA.test(env.GITHUB_SHA ?? '')
    && env.GITHUB_WORKFLOW_REF === `${CI_SCOPE.repository}/.github/workflows/ci-maintenance.yml@refs/heads/${CI_SCOPE.default_branch}`, 'untrusted_workflow_context')
  requireThat(typeof env.GITHUB_EVENT_PATH === 'string' && path.isAbsolute(env.GITHUB_EVENT_PATH), 'missing_workflow_event')
  const event = JSON.parse(ordinary(env.GITHUB_EVENT_PATH, CI_LIMITS.response_bytes))
  requireThat(event.action === 'completed' && event.repository?.id === CI_SCOPE.repository_id
    && event.workflow_run?.id === options.runId && event.workflow_run.run_attempt === options.attempt
    && event.workflow_run.head_sha === options.headSha && event.workflow_run.head_repository?.id === CI_SCOPE.repository_id
    && event.workflow_run.status === 'completed', 'workflow_event_binding_mismatch')
  const profile = workflowProfile(event.workflow_run.path)
  requireThat(positive(event.workflow_run.workflow_id) && event.workflow_run.name === profile.scope.workflow_name,
    'workflow_event_binding_mismatch')
  return { kind: 'github-actions-context', workflow_source_sha: env.GITHUB_SHA,
    parent_workflow: { id: event.workflow_run.workflow_id, path: profile.scope.workflow_path, name: profile.scope.workflow_name },
    authenticated_person_claimed: false, environment_is_not_independent_attestation: true }
}

export function createMetadataReader({ run, clock = () => Date.now(), env = process.env } = {}) {
  const started = clock(), requests = []; let consumed = 0, attempted = 0
  const invoke = run ?? (async (args, timeout) => {
    const clean = { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' }
    for (const key of ['GH_DEBUG', 'DEBUG', 'GH_PAGER', 'PAGER', 'GH_FORCE_TTY']) delete clean[key]
    try { return (await execute(nativeGhPath(), args, { env: clean, windowsHide: true, timeout,
      maxBuffer: CI_LIMITS.response_bytes - consumed, encoding: 'buffer' })).stdout }
    catch { throw new CiMaintenanceError('github_metadata_unavailable') }
  })
  return {
    async get(route) {
      requireThat(WORKFLOWS.some(profile => route === api(profile.route))
        || new RegExp(`^repos/${CI_SCOPE.repository}/actions/runs/[1-9][0-9]*/attempts/[1-9][0-9]*(?:/jobs\\?per_page=100&page=[12])?$`, 'u').test(route)
        || new RegExp(`^repos/${CI_SCOPE.repository}/actions/runs/[1-9][0-9]*/artifacts\\?per_page=20&page=1$`, 'u').test(route), 'route_not_allowed')
      const remaining = CI_LIMITS.duration_ms - (clock() - started)
      requireThat(attempted < CI_LIMITS.requests && remaining > 0 && consumed < CI_LIMITS.response_bytes, 'read_budget_exhausted')
      attempted++ // A failed or malformed GET still consumes its admission.
      let raw
      try { raw = Buffer.from(await invoke(['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', route], Math.min(remaining, CI_LIMITS.request_ms))) }
      catch (error) { throw new CiMaintenanceError(error instanceof CiMaintenanceError ? error.code : 'github_metadata_unavailable') }
      consumed += raw.length; requireThat(consumed <= CI_LIMITS.response_bytes && clock() - started <= CI_LIMITS.duration_ms, 'read_budget_exhausted')
      let value
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) } catch { throw new CiMaintenanceError('invalid_github_json') }
      requireThat(object(value), 'invalid_github_response')
      requests.push({ route, sha256: hash(raw), bytes: raw.length })
      return value
    },
    evidence() { return { requests: [...requests], attempted_requests: attempted, response_bytes: consumed, github_mutations: 0, downloaded_artifact_bytes: 0, downloaded_logs: false } },
  }
}

function runProjection(value, options, workflowId, profile) {
  requireThat(value.id === options.runId && value.run_attempt === options.attempt && value.workflow_id === workflowId
    && value.path === profile.scope.workflow_path && value.head_sha === options.headSha
    && value.repository?.id === CI_SCOPE.repository_id && value.repository.full_name === CI_SCOPE.repository
    && value.head_repository?.id === CI_SCOPE.repository_id, 'run_binding_mismatch')
  requireThat(value.status === 'completed' && CONCLUSIONS.has(value.conclusion), 'run_not_terminal')
  requireThat(['push', 'pull_request', 'workflow_dispatch'].includes(value.event) && time(value.run_started_at) && time(value.updated_at), 'invalid_run_metadata')
  requireThat(typeof value.head_branch === 'string' && value.head_branch.length > 0 && value.head_branch.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value.head_branch), 'invalid_run_metadata')
  return { id: value.id, attempt: value.run_attempt, head_sha: value.head_sha, head_branch: text(value.head_branch),
    head_branch_sha256: hash(value.head_branch), workflow_id: workflowId, workflow_path: profile.scope.workflow_path,
    repository_id: CI_SCOPE.repository_id, repository: CI_SCOPE.repository, event: value.event, status: value.status,
    conclusion: value.conclusion, started_at: new Date(value.run_started_at).toISOString(), updated_at: new Date(value.updated_at).toISOString() }
}
function jobsProjection(rows, run, profile) {
  requireThat(rows.length > 0 && rows.length <= CI_LIMITS.jobs, 'invalid_job_bound')
  const identities = new Set(), names = new Set()
  return rows.map(row => {
    requireThat(positive(row.id) && !identities.has(row.id) && row.run_id === run.id && row.run_attempt === run.attempt
      && row.head_sha === run.head_sha, 'job_binding_mismatch'); identities.add(row.id)
    const name = text(row.name), nameHash = hash(row.name)
    requireThat(!names.has(nameHash), 'ambiguous_job_name'); names.add(nameHash)
    requireThat(row.status === 'completed' && CONCLUSIONS.has(row.conclusion) && Array.isArray(row.steps)
      && row.steps.length <= CI_LIMITS.steps_per_job, 'incomplete_job_metadata')
    const numbers = new Set()
    const steps = row.steps.map(step => {
      requireThat(positive(step.number) && !numbers.has(step.number) && ['queued', 'pending', 'in_progress', 'completed'].includes(step.status)
        && (step.conclusion === null || CONCLUSIONS.has(step.conclusion)), 'invalid_step_metadata'); numbers.add(step.number)
      return { number: step.number, name: text(step.name), status: step.status, conclusion: step.conclusion }
    }).sort((a, b) => a.number - b.number)
    return { id: row.id, name, name_sha256: nameHash, status: row.status, conclusion: row.conclusion,
      expected_artifact: Object.hasOwn(profile.jobs, row.name) ? profile.jobs[row.name] : null, steps }
  }).sort((a, b) => a.name_sha256.localeCompare(b.name_sha256))
}
function artifactsProjection(rows, run, profile) {
  const ids = new Set(), known = new Set(Object.values(profile.jobs).filter(Boolean))
  return rows.map(row => {
    requireThat(positive(row.id) && !ids.has(row.id) && typeof row.name === 'string' && row.name.length <= 256
      && typeof row.expired === 'boolean' && row.workflow_run?.id === run.id
      && row.workflow_run.repository_id === CI_SCOPE.repository_id && row.workflow_run.head_repository_id === CI_SCOPE.repository_id
      && row.workflow_run.head_sha === run.head_sha, 'artifact_binding_mismatch'); ids.add(row.id)
    requireThat(row.digest === undefined || row.digest === null || /^sha256:[a-f0-9]{64}$/u.test(row.digest), 'invalid_artifact_digest')
    return { id: row.id, name: known.has(row.name) ? row.name : null, name_sha256: hash(row.name), expired: row.expired,
      api_digest: row.digest ?? null, bytes_read: false, attempt_binding: 'not-exposed-by-api' }
  }).sort((a, b) => a.id - b.id)
}

export function deriveFindings(observation) {
  const profile = workflowProfile(observation.run.workflow_path)
  const findingDigest = identity => digest(profile.scope === CI_SCOPE ? identity : { ...identity, workflow: profile.scope.workflow_path })
  const findings = []
  for (const [name, expectedArtifact] of Object.entries(profile.jobs)) {
    const nameHash = hash(name)
    if (observation.jobs.some(job => job.name_sha256 === nameHash)) continue
    const body = { id: `CI-${findingDigest({ rule: 'EXPECTED_JOB_MISSING', job: nameHash }).slice(0, 24)}`,
      rule: 'EXPECTED_JOB_MISSING', job_name: name, job_name_sha256: nameHash, artifact_name: expectedArtifact,
      recommendation: `Required ${profile.scope.workflow_name} job is absent from complete attempt metadata. Inspect the producer workflow and admission; no passing tests or coverage are inferred.` }
    findings.push({ ...body, revision: digest(body), job_id: null })
  }
  for (const job of observation.jobs) {
    const add = (rule, detail) => {
      const id = `CI-${findingDigest({ rule, job: job.name_sha256 }).slice(0, 24)}`
      const body = { id, rule, job_name: job.name, job_name_sha256: job.name_sha256, ...detail }
      findings.push({ ...body, revision: digest(body), job_id: job.id })
    }
    if (!GOOD.has(job.conclusion)) add(job.conclusion === 'cancelled' ? 'JOB_CANCELLED' : 'JOB_REQUIRES_REVIEW', {
      conclusion: job.conclusion, affected_steps: job.steps.filter(step => step.status !== 'completed' || step.conclusion === null || !GOOD.has(step.conclusion)),
      recommendation: job.conclusion === 'cancelled' ? 'Inspect why this attempt was cancelled before choosing any further run.' : 'Inspect the linked job and failed steps; no repair or rerun is authorized by this observation.',
    })
    if (Object.keys(profile.jobs).some(name => hash(name) === job.name_sha256)
      && ['skipped', 'neutral'].includes(job.conclusion)) add('EXPECTED_JOB_NOT_EXECUTED', {
      conclusion: job.conclusion,
      recommendation: `Required ${profile.scope.workflow_name} job did not report a successful execution. Inspect its admission and conclusion; a run-scoped artifact cannot establish that this attempt executed the gate.`,
    })
    if (job.expected_artifact && job.conclusion !== 'skipped') {
      const available = observation.artifacts.filter(row => row.name === job.expected_artifact)
      if (!available.length) add('EVIDENCE_ARTIFACT_MISSING', { artifact_name: job.expected_artifact,
        recommendation: 'Expected report artifact is not listed for this run. Inspect evidence production; no passing test or coverage claim is inferred.' })
      else if (available.every(row => row.expired)) add('EVIDENCE_ARTIFACT_EXPIRED', { artifact_name: job.expected_artifact,
        recommendation: 'Listed report evidence has expired. Do not use metadata as a replacement for unavailable report contents.' })
    }
  }
  if (!GOOD.has(observation.run.conclusion) && observation.jobs.every(job => GOOD.has(job.conclusion))) {
    const body = { id: `CI-${digest({ rule: 'PARENT_CONCLUSION_REVIEW', workflow: profile.scope.workflow_path }).slice(0, 24)}`,
      rule: 'PARENT_CONCLUSION_REVIEW', job_name: profile.scope.workflow_name, job_name_sha256: hash(profile.scope.workflow_name),
      conclusion: observation.run.conclusion,
      recommendation: 'The terminal parent conclusion requires review although listed jobs do not explain it. Inspect the native run; no passing outcome is inferred.' }
    findings.push({ ...body, revision: digest(body), job_id: null })
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id))
}
function semantics(observation) {
  const profile = workflowProfile(observation.run.workflow_path)
  return { conclusion: observation.run.conclusion, jobs: observation.jobs.map(job => ({ name_sha256: job.name_sha256,
    status: job.status, conclusion: job.conclusion, steps: job.steps })),
    artifact_states: [...new Set(Object.values(profile.jobs).filter(Boolean))].sort().map(name => ({ name,
      state: observation.artifacts.some(row => row.name === name && !row.expired) ? 'listed-run-scope-only'
        : observation.artifacts.some(row => row.name === name) ? 'expired' : 'not-listed' })) }
}
const scopeOf = run => ({ repository_id: run.repository_id, workflow_id: run.workflow_id, workflow_path: run.workflow_path,
  head_sha: run.head_sha, head_branch_sha256: run.head_branch_sha256, event: run.event })

export function validatePrevious(bytes, expectedSha256, source) {
  const profile = workflowProfile(source.workflow_path)
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= CI_LIMITS.receipt_bytes && HASH.test(expectedSha256)
    && hash(bytes) === expectedSha256, 'previous_bytes_mismatch')
  let previous
  try { previous = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new CiMaintenanceError('invalid_previous_receipt') }
  requireThat(previous.schema_version === 1 && previous.kind === 'ecorp-ci-maintenance-observation'
    && previous.contract_sha256 === profile.contract && previous.github_mutations === 0 && previous.executable === false
    && object(previous.observation) && Array.isArray(previous.observation.jobs) && Array.isArray(previous.observation.artifacts)
    && previous.observation.jobs.length > 0 && previous.observation.jobs.length <= CI_LIMITS.jobs
    && previous.observation.jobs.every(job => object(job) && Array.isArray(job.steps) && job.steps.length <= CI_LIMITS.steps_per_job)
    && previous.observation.artifacts.length <= CI_LIMITS.artifacts
    && Array.isArray(previous.findings) && previous.findings.length <= CI_LIMITS.jobs * 2 + Object.keys(EXPECTED_ARTIFACTS).length + 1 && time(previous.observed_at), 'invalid_previous_receipt')
  const { integrity_sha256, ...body } = previous
  requireThat(HASH.test(integrity_sha256 ?? '') && digest(body) === integrity_sha256, 'previous_integrity_mismatch')
  requireThat(equal(scopeOf(previous.observation.run), scopeOf(source)), 'previous_source_mismatch')
  requireThat(previous.observation.run.id !== source.id || previous.observation.run.attempt <= source.attempt, 'previous_attempt_newer')
  requireThat(time(previous.observation.run.started_at) && Date.parse(previous.observation.run.started_at) <= Date.parse(source.started_at), 'previous_run_newer')
  requireThat(equal(deriveFindings(previous.observation), previous.findings)
    && digest(semantics(previous.observation)) === previous.semantic_sha256, 'previous_facts_mismatch')
  return previous
}

export async function observeCi(options, { reader = createMetadataReader(), now = () => new Date(), previousBytes = null,
  executionContext = { kind: 'local-cli', hosted_execution_claimed: false } } = {}) {
  requireThat(positive(options.runId) && positive(options.attempt) && SHA.test(options.headSha ?? ''), 'invalid_identity')
  if (options.previous) requireThat(Buffer.isBuffer(previousBytes) && previousBytes.length > 0
    && previousBytes.length <= CI_LIMITS.receipt_bytes && HASH.test(options.previous.sha256 ?? '')
    && hash(previousBytes) === options.previous.sha256, 'previous_bytes_mismatch')
  const route = api(`actions/runs/${options.runId}/attempts/${options.attempt}`)
  const selected = await reader.get(route)
  const profile = workflowProfile(selected.path)
  const workflow = await reader.get(api(profile.route))
  requireThat(positive(workflow.id) && workflow.path === profile.scope.workflow_path
    && workflow.name === profile.scope.workflow_name, 'workflow_binding_mismatch')
  const run = runProjection(selected, options, workflow.id, profile)
  if (executionContext.kind === 'github-actions-context') requireThat(equal(executionContext.parent_workflow,
    { id: workflow.id, path: profile.scope.workflow_path, name: profile.scope.workflow_name }), 'workflow_event_binding_mismatch')
  const jobs = []; let total = null
  for (let page = 1; page <= 2; page++) {
    const response = await reader.get(`${route}/jobs?per_page=100&page=${page}`)
    requireThat(Number.isSafeInteger(response.total_count) && response.total_count > 0 && response.total_count <= CI_LIMITS.jobs
      && Array.isArray(response.jobs) && response.jobs.length <= 100 && (total === null || total === response.total_count), 'incomplete_job_pagination')
    total = response.total_count; jobs.push(...response.jobs)
    requireThat(jobs.length <= total, 'incomplete_job_pagination')
    if (jobs.length === total) break
    requireThat(response.jobs.length === 100 && page < 2, 'incomplete_job_pagination')
  }
  requireThat(jobs.length === total, 'incomplete_job_pagination')
  const artifactResponse = await reader.get(api(`actions/runs/${run.id}/artifacts?per_page=20&page=1`))
  requireThat(Number.isSafeInteger(artifactResponse.total_count) && artifactResponse.total_count >= 0
    && artifactResponse.total_count <= CI_LIMITS.artifacts && Array.isArray(artifactResponse.artifacts)
    && artifactResponse.artifacts.length === artifactResponse.total_count, 'incomplete_artifact_pagination')
  const observation = { run, jobs: jobsProjection(jobs, run, profile), artifacts: artifactsProjection(artifactResponse.artifacts, run, profile) }
  requireThat(equal(runProjection(await reader.get(route), options, workflow.id, profile), run), 'run_changed_during_observation')
  const observedAt = now().toISOString(), findings = deriveFindings(observation), semantic = digest(semantics(observation))
  const previous = options.previous ? validatePrevious(previousBytes, options.previous.sha256, run) : null
  if (previous) requireThat(Date.parse(previous.observed_at) <= Date.parse(observedAt), 'previous_observation_newer')
  const old = new Map((previous?.findings ?? []).map(finding => [finding.id, finding.revision]))
  const currentIds = new Set(findings.map(finding => finding.id))
  const changed = findings.filter(finding => old.get(finding.id) !== finding.revision).map(finding => finding.id)
  const resolved = [...old.keys()].filter(id => !currentIds.has(id)).sort()
  const status = previous ? previous.semantic_sha256 === semantic ? 'no-op' : 'changed' : 'recorded'
  const body = { schema_version: 1, kind: 'ecorp-ci-maintenance-observation', contract_sha256: profile.contract,
    observed_at: observedAt, status, source_url: runUrl(run.id), execution_context: executionContext,
    observation, semantic_sha256: semantic, findings, new_or_changed_finding_ids: changed, no_longer_observed_finding_ids: resolved,
    previous_receipt_sha256: options.previous?.sha256 ?? null,
    observation_key: digest({ scope: scopeOf(run), run_id: run.id, attempt: run.attempt, semantic }),
    read_evidence: reader.evidence(), github_mutations: 0, executable: false,
    assurance: { metadata_only: true, reads_non_atomic: true, artifact_contents_verified: false,
      artifact_attempt_binding: 'not-exposed-by-api', test_counts_or_coverage_claimed: false,
      source_repair_claimed: false, authenticated_reviewer_claimed: false, future_authority: 'none',
      previous_hash_proves_integrity_not_service_authenticity: true } }
  return { ...body, integrity_sha256: digest(body) }
}

export function renderHandoff(receipt) {
  const { run } = receipt.observation
  const profile = workflowProfile(run.workflow_path)
  const lines = [`# ${profile.scope.workflow_name}: review handoff`, '', `Status: **${receipt.status}**. Parent conclusion: **${run.conclusion}**.`, '',
    `Source: [run ${run.id}, attempt ${run.attempt}](${runUrl(run.id)}) at \`${run.head_sha}\`.`, '',
    `${receipt.findings.length} observed findings; ${receipt.new_or_changed_finding_ids.length} new or changed; ${receipt.no_longer_observed_finding_ids.length} no longer observed.`, '',
    'Metadata-only, read-only observation. Artifact contents, test totals and coverage were not read or verified. Artifact listings are run-scoped, not proof of the selected attempt.', '',
    receipt.status === 'no-op' ? 'No new review work: the same-source semantic observation is unchanged.' : 'Review the linked native jobs before choosing any further action.', '']
  if (receipt.status !== 'no-op') for (const finding of receipt.findings.slice(0, 50)) {
    lines.push(`## ${markdown(finding.rule)} — ${markdown(finding.job_name)}`, '',
      `[Inspect ${finding.job_id === null ? 'run' : 'job'}](${runUrl(run.id)}${finding.job_id === null ? '' : `/job/${finding.job_id}`}) · Finding \`${finding.id}\``, '', markdown(finding.recommendation))
    for (const step of (finding.affected_steps ?? []).slice(0, 10)) lines.push(`- Step ${step.number}: ${markdown(step.name)} — ${markdown(step.conclusion ?? step.status)}`)
    if (finding.artifact_name) lines.push(`- Expected artifact: \`${finding.artifact_name}\``)
    lines.push('')
  }
  if (receipt.findings.length > 50) lines.push('The complete bounded finding set remains in receipt.json; this handoff displays the first 50.', '')
  lines.push('No issue, comment, label, source change, workflow rerun or deployment was requested. A finding no longer observed is not proof of a repaired source. Hashes bind bytes, not authenticated historical approval.', '')
  return lines.join('\n')
}

export async function main(argv = process.argv.slice(2), { env = process.env, reader, now } = {}) {
  const options = parseArgs(argv), output = newOutput(options.output)
  try {
    const context = hostedSelection(env, options)
    if (context.kind === 'github-actions-context') {
      const head = (await execute('git', ['-C', path.dirname(path.dirname(SELF)), 'rev-parse', 'HEAD'], { windowsHide: true, timeout: 10000, encoding: 'utf8' })).stdout.trim()
      requireThat(head === context.workflow_source_sha, 'untrusted_observer_checkout')
    }
    const previousBytes = options.previous ? ordinary(options.previous.path, CI_LIMITS.receipt_bytes) : null
    const receipt = await observeCi(options, { reader: reader ?? createMetadataReader({ env }), now, previousBytes, executionContext: context })
    const markdownText = renderHandoff(receipt)
    requireThat(Buffer.byteLength(markdownText) <= CI_LIMITS.markdown_bytes, 'output_bound')
    const saved = output('receipt.json', receipt)
    output('handoff.md', markdownText, CI_LIMITS.markdown_bytes)
    const summary = { status: receipt.status, run_id: options.runId, run_attempt: options.attempt, head_sha: options.headSha,
      findings: receipt.findings.length, new_or_changed: receipt.new_or_changed_finding_ids.length,
      no_longer_observed: receipt.no_longer_observed_finding_ids.length, receipt: saved, github_mutations: 0,
      artifact_contents_read: false, observer_sha256: hash(readFileSync(SELF)) }
    output('summary.json', summary)
    return summary
  } catch (error) {
    const code = error instanceof CiMaintenanceError ? error.code : 'ci_metadata_observation_failed'
    try { output('failure.json', { status: 'incomplete', error: code, github_mutations: 0, automatically_retried: false, retained: true }) } catch { /* Preserve a replaced or conflicting output without another write. */ }
    throw new CiMaintenanceError(code)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ status: 'incomplete', error: error instanceof CiMaintenanceError ? error.code : 'ci_metadata_observation_failed', github_mutations: 0 }) + '\n')
    process.exitCode = 1
  })
}
