// Standalone native acceptance, run only by the fresh owned stack driver.
// No synthetic terminal rows, browser state injection or external GitHub writes.
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { captureOwnedTestServerManifest, verifyOwnedTestProcess } from './owned_test_stack.mjs'
import { readFixtureSourceIdentity } from './fixture_source_identity.mjs'

const execFile = promisify(execFileCallback)
const root = path.resolve(import.meta.dirname, '..')
assert.equal(process.env.CRONY_REVIEW_REVISION_TEST, '1', 'Explicit owned fixture opt-in required')
assert.ok(path.isAbsolute(process.env.CRONY_REVIEW_REVISION_FIXTURE ?? ''), 'Absolute fixture receipt required')
const fixture = JSON.parse(await readFile(process.env.CRONY_REVIEW_REVISION_FIXTURE, 'utf8'))
assert.equal(fixture.test_owned, true)
assert.equal(await realpath(fixture.product_root), await realpath(root))
const qa = await realpath(fixture.qa_root)
const source = await realpath(fixture.source)
const remote = await realpath(fixture.remote)
const output = await realpath(fixture.output)
assert.ok(!qa.startsWith(root + path.sep) && qa !== root)
for (const child of [source, remote]) assert.ok(child.startsWith(qa + path.sep), 'Fixture path must be owned')
const server = fixture.server_url
const web = fixture.web_url
for (const origin of [server, web]) {
  const url = new URL(origin)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(url.port && !['8791', '8793', '5187', '5291', '15191', '15193'].includes(url.port))
  assert.equal(url.origin, origin)
}
for (const role of ['server', 'web']) {
  const processRecord = fixture.processes[role]
  const manifest = await captureOwnedTestServerManifest({
    root: qa, server: role === 'server' ? server : web, binary: processRecord.executable,
    pidPath: path.join(output, `${role}-native-identity.json`), pid: processRecord.pid,
  })
  assert.equal(Date.parse(manifest.server_creation), Date.parse(processRecord.started_utc))
  await verifyOwnedTestProcess({ root: qa, server: manifest.server_url, binary: processRecord.executable, manifest })
}
const identity = readFixtureSourceIdentity(source)
assert.equal(identity.repository, 'all-the-vibes/ecorp')
const { corp_id: corp, alice_actor_id: alice, bob_actor_id: bob } = fixture.demo
const binary = path.join(root, 'target', 'debug', process.platform === 'win32' ? 'crony-cli.exe' : 'crony-cli')
const statePath = path.join(qa, 'github-boundary.json')
const credentialPath = path.join(qa, 'publisher.credential')
const publisherId = `review-revision-fixture-${randomUUID()}`
const secrets = []
let browser, enrollment
const report = {
  schema_version: 1, started_at: new Date().toISOString(), passed: false,
  scope: 'Real Chrome/App/server/runner/Git; fake-process provider and fake GitHub; local bare publication remote. Development actors are not human signoff.',
  product_root: root, qa_root: qa, server, web, scenarios: [],
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function safe(value) {
  let text = String(value)
  for (const secret of secrets) if (secret) text = text.split(secret).join('[withheld]')
  return text
}
async function save() { await writeFile(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n') }
async function stage(name, action) {
  report.stage = name
  await save()
  console.log(name)
  const receipt = await action()
  report.scenarios.push({ name, passed: true, receipt })
  await save()
  return receipt
}
async function git(args, cwd = source) {
  return (await execFile('git', args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
}
async function sourceCheckoutState() {
  return { head: await git(['rev-parse', 'HEAD']), status: await git(['status', '--porcelain=v1']), tree: await git(['rev-parse', 'HEAD^{tree}']) }
}
async function sourceState() {
  return { ...await sourceCheckoutState(), refs: await git(['show-ref']) }
}
async function productSourceFiles() {
  const files = (await git(['ls-files', '--cached', '--others', '--exclude-standard'], root)).split(/\r?\n/).filter(Boolean).sort()
  return Promise.all(files.map(async (file) => ({ path: file, sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') })))
}
async function request(suffix, body, headers = {}) {
  const response = await fetch(server + suffix, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000), redirect: 'error',
  })
  const text = await response.text()
  let result
  try { result = JSON.parse(text) } catch { result = { error: text } }
  return { status: response.status, body: result }
}
async function ok(suffix, body) {
  const response = await request(suffix, body)
  assert.ok(response.status >= 200 && response.status < 300, safe(`${suffix}: ${response.status} ${JSON.stringify(response.body)}`))
  return response.body
}
async function snapshot() { return (await ok(`/api/corps/${corp}/snapshot?actor_id=${alice}`)).snapshot }
async function context(item) { return ok(`/api/corps/${corp}/factory/work-items/${item}/publication-context?actor_id=${alice}`) }
async function waitFor(label, predicate, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await snapshot()
    const result = predicate(state)
    if (result) return { state, result }
    await delay(200)
  }
  throw new Error(`Timed out: ${label}`)
}
async function command(args, env = {}, failure) {
  let stdout, stderr, code = 0
  try {
    ({ stdout, stderr } = await execFile(binary, ['--server', server, ...args], {
      cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ECORP_GITHUB_CLI_PREFIX_ARGS_JSON: JSON.stringify([path.join(root, 'tools', 'fake_github_cli.mjs')]),
        ECORP_FAKE_GITHUB_STATE: statePath, ECORP_PUBLICATION_TEST_REMOTE_URL: remote,
        ECORP_GITHUB_COMMAND_TIMEOUT_MS: '10000', ECORP_SOURCE_GIT_COMMAND_TIMEOUT_MS: '10000', ...env },
    }))
  } catch (error) { code = error.code ?? 1; stdout = error.stdout ?? ''; stderr = error.stderr ?? String(error.message) }
  for (const secret of secrets) {
    assert.ok(!stdout.includes(secret), 'CLI stdout exposed a fixture credential')
    assert.ok(!stderr.includes(secret), 'CLI stderr exposed a fixture credential')
  }
  if (failure) {
    assert.notEqual(code, 0, 'Expected a rejected operation')
    assert.match(stderr, failure)
    return { exit_code: code, detail: safe(stderr.trim()) }
  }
  assert.equal(code, 0, safe(stderr))
  return JSON.parse(stdout)
}
async function publish(f, deliverable, key, authorization, failure) {
  return command(['factory-publish', corp, alice, f.item,
    '--source-deliverable-id', deliverable.id, '--authorization-id', authorization,
    '--authorization-reason', 'Owned acceptance authorizes only the local branch and fake pull request.',
    '--idempotency-key', key, '--publisher-id', publisherId,
    '--publisher-credential-file', credentialPath, '--wait-seconds', '90', '--lease-seconds', '120',
    '--github-cli', process.execPath], {}, failure)
}
async function boundary(f) {
  let state = {
    repository: identity.repository,
    project: { id: 'PVT_REVIEW_REVISION', owner: identity.owner, number: 7, status_field_id: 'PVTSSF_REVIEW_REVISION',
      status_options: [{ id: 'progress', name: 'In Progress' }, { id: 'review', name: 'In Review' }] },
    items: [], issues: {}, updates: [], pull_requests: [], next_pr_number: 950001,
  }
  try { state = JSON.parse(await readFile(statePath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  assert.equal(state.repository, identity.repository)
  assert.ok(!state.items.some((item) => item.id === f.projectItem), 'Each fixture is claimed once')
  state.items.push({ id: f.projectItem, status: 'In Progress', content: { ...f.issue, type: 'Issue', repository: identity.repository } })
  state.issues[f.issue.number] = f.issue
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n')
}
const verificationPolicy = { checks: [
  { type: 'artifact', min_bytes: 12 },
  { type: 'file', path: 'portable-untracked.txt', min_bytes: 1 },
  { type: 'command', program: 'node', args: ['-e', "const f=require('node:fs'),a=require('node:assert/strict');a.match(f.readFileSync('README.md','utf8'),/Portable deliverable fixture: tracked change/);a.equal(f.readFileSync('portable-untracked.txt','utf8'),'portable untracked source\\n')"], timeout_ms: 10000 },
], manual_gate: null }
async function createItem(number) {
  const base = await git(['rev-parse', 'main'])
  const issue = { id: `I_REVIEW_REVISION_${number}`, number, title: `Owned review revision ${number} [portable-deliverable]`,
    body: 'Apply a second bounded source correction after publication. [portable-deliverable]',
    url: `${identity.url}/issues/${number}`, state: 'OPEN', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    labels: [{ name: 'factory:ready' }], repository: { nameWithOwner: identity.repository } }
  const projectItem = `PVTI_REVIEW_REVISION_${number}`
  const policy = {
    schema_version: 1, source_of_truth: 'github_project', project_owner: identity.owner, project_number: 7,
    project_status: 'In Progress', required_label: 'factory:ready', dependencies: [], repository_allowlist: [identity.repository],
    source_base_ref: 'main', source_base_commit: base, source_commit_upgrade_required: false,
    adapter_allowlist: ['fake-process'], strategy_allowlist: ['single'], model: null, reasoning_effort: null,
    write_scope: ['**'], allowed_tools: ['filesystem', 'shell'],
    prohibited_actions: ['modify files outside the assigned worktree', 'use undeclared long-lived credentials', 'merge or deploy without a separate current authorization'],
    secret_ids: [], verification_required: true, deliverable_form: 'commit_branch', budget_tokens: 100000,
    budget_cost_microusd: 1000000, auto_merge: false, verification_policy: verificationPolicy,
    publication: { allowed: true, repository_allowlist: [identity.repository], base_ref: 'main', branch_prefix: 'ecorp/',
      status_before: 'In Progress', review_status: 'In Review', auto_merge: false, merge: false, deploy: false },
  }
  const materialization = { actor_id: alice, title: issue.title, description: issue.body, preferred_adapter: 'fake-process',
    strategy: 'single', budget_tokens: policy.budget_tokens, budget_cost_microusd: policy.budget_cost_microusd,
    deliverable: { form: 'commit_branch', commit_after_verification: true, paths: [] },
    contract: { objective: issue.body, expected_output: 'Verified portable source changes.', acceptance_tests: ['All saved checks pass.'],
      allowed_tools: policy.allowed_tools, prohibited_actions: policy.prohibited_actions, references: [issue.url], write_scope: policy.write_scope },
    verification_policy: verificationPolicy }
  const preflight = await ok(`/api/corps/${corp}/factory/preflight`, { ...materialization,
    source_repository_owner: identity.owner, source_repository_name: identity.name, policy })
  assert.equal(preflight.valid, true)
  const claim = await ok(`/api/corps/${corp}/factory/work-items/claim`, {
    actor_id: alice, source_project_owner: policy.project_owner, source_project_number: policy.project_number,
    source_project_item_id: projectItem, source_repository_owner: identity.owner, source_repository_name: identity.name,
    source_issue_number: number, source_issue_node_id: issue.id, source_issue_url: issue.url, source_title: issue.title,
    source_revision: issue.updatedAt, idempotency_key: randomUUID(), lease_seconds: 3600, policy,
  })
  assert.equal(claim.replayed, false)
  secrets.push(claim.claim_token)
  const f = { issue, projectItem, item: claim.work_item.id, token: claim.claim_token, base }
  await boundary(f)
  const materialized = await ok(`/api/corps/${corp}/factory/work-items/${f.item}/materialize`, {
    ...materialization, claim_token: f.token, expected_version: claim.work_item.version, idempotency_key: randomUUID(),
  })
  f.mission = materialized.mission_id
  const held = await snapshot()
  const tasks = held.tasks.filter((task) => task.mission_id === f.mission)
  assert.equal(tasks.length, 1)
  assert.equal(held.runs.filter((run) => run.task_id === tasks[0].id).length, 0)
  await ok(`/api/corps/${corp}/missions/${f.mission}/contract-revisions`, {
    actor_id: alice, task_id: tasks[0].id, expected_contract_version: tasks[0].contract_version, next_action: 'redispatch',
    source_run_id: null, reason: 'Configure this fresh held fixture with explicit checks before execution.',
    idempotency_key: randomUUID(), description: issue.body, contract: tasks[0].contract, verification_policy: verificationPolicy,
  })
  // The original provider uses native managed worktree branches. Its configured
  // checkout must stay intact; the correction also preserves all source refs.
  const preservation = await sourceCheckoutState()
  await ok(`/api/corps/${corp}/missions/${f.mission}/launch`, { requested_by: alice })
  const terminal = await waitFor('original mission completion', (state) => state.missions.find((m) => m.id === f.mission && ['completed', 'failed', 'cancelled'].includes(m.status)))
  assert.equal(terminal.result.status, 'completed')
  const current = await context(f.item)
  assert.equal(current.work_item.state, 'verified')
  const candidates = terminal.state.source_deliverables.filter((d) => d.task_id === tasks[0].id && d.integration_state === 'ready_for_review')
  assert.equal(candidates.length, 1, 'Completed source task must have one deliverable ready for review')
  f.deliverable = candidates[0]
  f.originalRun = terminal.state.runs.find((r) => r.id === f.deliverable.run_id)
  f.originalTask = terminal.state.tasks.find((task) => task.id === f.deliverable.task_id)
  f.originalMission = terminal.state.missions.find((mission) => mission.id === f.mission)
  assert.equal(f.originalRun.status, 'completed')
  assert.equal(f.originalRun.execution_mode, 'provider')
  assert.equal(tasks[0].required_adapter, 'fake-process')
  assert.ok(f.originalRun.artifact_id, 'Deterministic provider must produce actual evidence')
  assert.notEqual(await realpath(f.originalRun.workspace_path), source)
  assert.deepEqual(await sourceCheckoutState(), preservation, 'Provider must not modify configured checkout')
  report.setup_items ??= []
  report.setup_items.push({ item: f.item, mission: f.mission, run: f.originalRun.id,
    execution_mode: f.originalRun.execution_mode, adapter: tasks[0].required_adapter,
    provider_session_id: f.originalRun.provider_session_id, artifact_id: f.originalRun.artifact_id,
    workspace: f.originalRun.workspace_path, base, deliverable: f.deliverable,
    checks: checkEvidence(terminal.state, f.originalRun.id), source_checkout_preserved: true })
  await save()
  return f
}
function checkEvidence(state, runId) {
  const evidence = state.verification_evidence.filter((e) => e.run_id === runId).sort((a, b) => a.check_index - b.check_index)
  assert.equal(evidence.length, verificationPolicy.checks.length)
  assert.ok(evidence.every((e) => e.status === 'passed'))
  return evidence
}

const revisionsPath = (f) => `/api/corps/${corp}/factory/work-items/${f.item}/review-revisions`
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
async function fakeState() { return JSON.parse(await readFile(statePath, 'utf8')) }
async function changeFake(action) {
  const state = await fakeState()
  action(state)
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n')
}
function effectCounts(state) {
  return { pull_requests: state.pull_requests.length, pr_create_calls: state.pr_create_calls ?? 0,
    project_updates: state.item_edits ?? 0, effects: state.effect_log?.length ?? 0 }
}
function originalRecords(f, state) {
  return { mission: state.missions.find((m) => m.id === f.mission),
    task: state.tasks.find((t) => t.id === f.originalTask.id),
    run: state.runs.find((r) => r.id === f.originalRun.id),
    deliverable: state.source_deliverables.find((d) => d.id === f.deliverable.id) }
}
async function publishOriginal(f) {
  const branch = `ecorp/issue-${f.issue.number}-${f.deliverable.head_commit.slice(0, 12)}`
  await changeFake((state) => { state.branch_heads = { ...state.branch_heads, [branch]: f.deliverable.head_commit } })
  const key = randomUUID(), authorization = randomUUID()
  const result = await publish(f, f.deliverable, key, authorization)
  const current = await context(f.item)
  assert.equal(current.work_item.state, 'published')
  assert.equal(current.publication.state, 'published')
  assert.equal(current.publication.commit_sha, f.deliverable.head_commit)
  assert.equal(current.publication.branch, branch)
  assert.equal(await git(['rev-parse', `refs/heads/${branch}`], remote), f.deliverable.head_commit)
  f.publication = current.publication
  f.original = originalRecords(f, await snapshot())
  f.deliverable = f.original.deliverable
  return { publication: f.publication, result, checks: checkEvidence(await snapshot(), f.originalRun.id) }
}
function rejected(response, pattern) {
  assert.ok([400, 403, 409, 422].includes(response.status), safe(JSON.stringify(response)))
  if (pattern) assert.match(response.body.error ?? JSON.stringify(response.body), pattern)
  return response
}
async function startBrowser() {
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' })
  report.browser_version = browser.version()
  report.external_requests = []
  report.browser_errors = []
  await browserContext.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if ([server, web].includes(url.origin)) return route.continue()
    report.external_requests.push(url.origin + url.pathname)
    return route.abort()
  })
  const page = await browserContext.newPage()
  page.on('pageerror', (error) => report.browser_errors.push(safe(error.message)))
  return page
}
async function openMission(page, missionId, actor = alice) {
  await page.goto(web + '/#missions', { waitUntil: 'domcontentloaded' })
  await page.locator('.live-indicator.live-live').waitFor()
  await page.locator('#operator-actor').selectOption(actor)
  const title = (await snapshot()).missions.find((m) => m.id === missionId).title
  await page.locator('#missions .mission-selector button').filter({ has: page.getByText(title, { exact: true }) }).click()
  const card = page.locator('#missions').getByTestId(`mission-${missionId}`)
  await card.waitFor()
  return card
}
async function clickPost(page, target, pathname) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === pathname && r.request().method() === 'POST'),
    target.click(),
  ])
  const result = await response.json()
  assert.equal(response.status(), 200, safe(JSON.stringify(result)))
  return { path: pathname, request: response.request().postDataJSON(), result }
}
async function authorizeInApp(page, f, summary) {
  const card = await openMission(page, f.mission)
  const panel = card.getByTestId('review-revision-panel')
  await panel.getByLabel('Finding 1 summary', { exact: true }).fill(summary)
  await panel.getByRole('combobox', { name: 'Finding 1 kind', exact: true }).selectOption('correctness')
  await panel.getByLabel('Repository path (optional)', { exact: true }).fill('README.md')
  await panel.getByLabel('Line (optional)', { exact: true }).fill('1')
  await panel.getByLabel('HTTPS evidence link (optional)', { exact: true }).fill(f.publication.pull_request_url)
  const receipt = await clickPost(page, panel.getByRole('button', { name: 'Authorize correction', exact: true }), revisionsPath(f))
  assert.equal(receipt.request.actor_id, alice)
  assert.equal(receipt.request.publication_id, f.publication.id)
  assert.equal(receipt.request.published_head_commit, f.publication.commit_sha)
  assert.match(receipt.request.idempotency_key, uuidPattern)
  const revision = receipt.result.revision
  assert.equal(revision.state, 'pending')
  assert.equal(revision.authorized_by, alice)
  assert.equal(revision.source_head_commit, f.publication.commit_sha)
  assert.notEqual(revision.mission_id, f.mission)
  assert.deepEqual(revision.findings, receipt.request.findings)
  const replay = await ok(receipt.path, receipt.request)
  assert.equal(replay.replayed, true)
  assert.equal(replay.revision.id, revision.id)
  const state = await snapshot()
  assert.equal(state.runs.filter((r) => r.task_id === revision.task_id).length, 0, 'Authorization must not launch execution')
  assert.equal(state.missions.filter((m) => m.id === revision.mission_id).length, 1)
  assert.equal((await context(f.item)).work_item.mission_id, f.mission)
  assert.deepEqual(originalRecords(f, state), f.original)
  await card.waitFor()
  assert.equal(await card.getAttribute('data-run-id'), f.originalRun.id)
  return { ...receipt, replayed: true, original_selected: true, explicit_launch_required: true }
}

try {
  report.product_head = await git(['rev-parse', 'HEAD'], root)
  report.source_files = await productSourceFiles()
  enrollment = await ok(`/api/corps/${corp}/factory/publication-publishers/credentials`, { actor_id: alice, publisher_id: publisherId, expires_in_seconds: 3600 })
  secrets.push(enrollment.credential)
  await writeFile(credentialPath, enrollment.credential, { flag: 'wx', mode: 0o600 })
  const f = await createItem(950001)
  await stage('Original provider execution, persisted checks and native publication', () => publishOriginal(f))
  const preservation = await sourceState()
  const before = await context(f.item)
  const invalidBase = { actor_id: alice, expected_version: before.work_item.version, idempotency_key: randomUUID(),
    publication_id: f.publication.id, published_head_commit: f.publication.commit_sha,
    observed_source_revision: f.issue.updatedAt,
    findings: [{ kind: 'correctness', summary: 'A controlled fixture requires another tracked correction.', source_url: f.publication.pull_request_url, path: 'README.md', line: 1 }] }
  await stage('Stale source, version, head and widened authority rejected', async () => {
    const results = []
    for (const patch of [
      { expected_version: before.work_item.version + 1 },
      { observed_source_revision: 'unverified-new-issue-revision' },
      { published_head_commit: 'f'.repeat(40) },
      { verification_policy: { checks: [], manual_gate: null } },
      { allowed_tools: ['undeclared-tool'] },
      { budget_tokens: 200000 },
      { source_base_ref: 'other-base' },
    ]) results.push({ changed_field: Object.keys(patch)[0], ...rejected(await request(revisionsPath(f), { ...invalidBase, ...patch, idempotency_key: randomUUID() })) })
    assert.deepEqual(await ok(`${revisionsPath(f)}?actor_id=${alice}`), [])
    assert.equal((await context(f.item)).work_item.version, before.work_item.version)
    assert.deepEqual(originalRecords(f, await snapshot()), f.original)
    return results
  })
  const page = await startBrowser()
  const authorization = await stage('Actual App authorizes one separate correction with exact replay', () =>
    authorizeInApp(page, f, 'Add the second tracked fixture correction while preserving the accepted publication.'))
  const r = authorization.result.revision
  await stage('Inherited contracts, residual budgets and remaining attempts', async () => {
    const state = await snapshot()
    const task = state.tasks.find((t) => t.id === r.task_id)
    const mission = state.missions.find((m) => m.id === r.mission_id)
    const priorRuns = state.runs.filter((run) => run.task_id === f.originalTask.id)
    const usedTokens = priorRuns.reduce((sum, run) => sum + run.input_tokens + run.output_tokens, 0)
    const usedCost = priorRuns.reduce((sum, run) => sum + run.cost_microusd, 0)
    const tokens = Math.min(f.originalTask.contract.budget_tokens, f.originalMission.budget_tokens) - usedTokens
    const cost = Math.min(f.originalTask.contract.budget_cost_microusd, f.originalMission.budget_cost_microusd) - usedCost
    assert.deepEqual(task.contract, { ...f.originalTask.contract, objective: task.contract.objective, budget_tokens: tokens, budget_cost_microusd: cost })
    assert.ok(task.contract.objective.startsWith(f.originalTask.contract.objective + '\n\n'))
    assert.ok(task.contract.objective.includes(f.publication.commit_sha))
    assert.equal(task.max_attempts, f.originalTask.max_attempts - f.originalTask.attempt_count)
    assert.deepEqual(task.verification_policy.checks, verificationPolicy.checks)
    assert.equal(task.verification_policy.manual_gate.type, 'independent_review')
    assert.equal(task.required_adapter, 'fake-process')
    assert.deepEqual(task.depends_on, [])
    assert.equal(mission.requested_by, f.originalMission.requested_by)
    assert.equal(mission.room_id, f.originalMission.room_id)
    assert.equal(mission.budget_tokens, tokens)
    assert.equal(mission.budget_cost_microusd, cost)
    return { original_task: f.originalTask.id, correction_task: task.id, remaining_tokens: tokens, remaining_cost_microusd: cost,
      remaining_attempts: task.max_attempts, saved_checks: task.verification_policy, scope_preserved: true }
  })
  await stage('Actual App opens and explicitly starts the correction mission', async () => {
    const originalCard = page.locator('#missions').getByTestId(`mission-${f.mission}`)
    await originalCard.getByTestId('review-revision-panel').getByRole('button', { name: 'Open correction mission', exact: true }).first().click()
    const card = page.locator('#missions').getByTestId(`mission-${r.mission_id}`)
    await card.waitFor()
    const launch = await clickPost(page, card.getByRole('button', { name: 'Start mission', exact: true }), `/api/corps/${corp}/missions/${r.mission_id}/launch`)
    assert.equal(launch.request.requested_by, alice)
    return launch
  })
  const waiting = await waitFor('correction independent review', (state) => state.runs.find((run) =>
    run.task_id === r.task_id && ['waiting_for_approval', 'failed', 'completed', 'verification_failed'].includes(run.status)))
  assert.equal(waiting.result.status, 'waiting_for_approval', safe(JSON.stringify(waiting.result)))
  const correctionRun = waiting.result
  await stage('Runner preserves exact seed ancestry and reruns every saved check', async () => {
    assert.equal(correctionRun.execution_mode, 'provider')
    // The fake process executes through the native runner but has no real
    // provider session, selected model or reasoning configuration.
    for (const key of ['provider_session_id', 'model', 'reasoning_effort']) assert.equal(correctionRun[key], null)
    const workspace = await realpath(correctionRun.workspace_path)
    assert.notEqual(workspace, source)
    assert.notEqual(workspace, await realpath(f.originalRun.workspace_path))
    assert.ok(workspace.startsWith(qa + path.sep))
    await git(['merge-base', '--is-ancestor', f.publication.commit_sha, 'HEAD'], workspace)
    const beforeReadme = await git(['show', `${f.publication.commit_sha}:README.md`], workspace)
    const correctedReadme = await readFile(path.join(workspace, 'README.md'), 'utf8')
    assert.equal((beforeReadme.match(/Portable deliverable fixture: tracked change\./g) ?? []).length, 1)
    assert.equal((correctedReadme.match(/Portable deliverable fixture: tracked change\./g) ?? []).length, 2)
    assert.equal(await readFile(path.join(workspace, 'portable-untracked.txt'), 'utf8'), 'portable untracked source\n')
    assert.deepEqual(await sourceState(), preservation)
    assert.deepEqual(originalRecords(f, waiting.state), f.original)
    return { run_id: correctionRun.id, execution_mode: correctionRun.execution_mode, provider_session_id: correctionRun.provider_session_id,
      workspace, source_head: f.publication.commit_sha, correction_head: await git(['rev-parse', 'HEAD'], workspace),
      checks: checkEvidence(waiting.state, correctionRun.id), original_result_and_source_preserved: true }
  })
  await stage('Pending correction fences adoption and publication; requester cannot review', async () => {
    const current = await context(f.item)
    const adoption = rejected(await request(`${revisionsPath(f)}/${r.id}/adopt`, {
      actor_id: alice, expected_version: current.work_item.version, idempotency_key: randomUUID(),
      observed_source_revision: f.issue.updatedAt, reason: 'Premature fixture adoption must be rejected.',
    }), /completed|review|verification|replacement/i)
    const review = rejected(await request(`/api/corps/${corp}/runs/${correctionRun.id}/verification-decision`, {
      actor_id: alice, approved: true, note: 'The fixture requester must not self-review.', decision_key: randomUUID(),
    }))
    const publication = rejected(await request(`/api/corps/${corp}/factory/work-items/${f.item}/publication`, {
      actor_id: alice, source_deliverable_id: f.deliverable.id, target_repository: identity.repository,
      base_ref: 'main', branch: f.publication.branch, title: f.issue.title, body: 'Pending correction must fence publication.',
      authorization_id: randomUUID(), authorization_reason: 'Owned fixture publication fence probe.',
      effect_key: randomUUID(), idempotency_key: randomUUID(), publisher_id: publisherId, lease_seconds: 120,
    }, { 'x-crony-publication-publisher-credential': enrollment.credential }))
    assert.equal((await context(f.item)).work_item.mission_id, f.mission)
    assert.equal((await fakeState()).pull_requests.length, 1)
    return { adoption, requester_review: review, publication }
  })
  const decision = await stage('Actual App records fresh independent fixture review', async () => {
    const card = await openMission(page, r.mission_id, bob)
    assert.equal(await card.getAttribute('data-run-id'), correctionRun.id)
    await page.screenshot({ path: path.join(output, 'correction-awaiting-review.png'), fullPage: true })
    const receipt = await clickPost(page, card.getByRole('button', { name: 'Accept evidence', exact: true }),
      `/api/corps/${corp}/runs/${correctionRun.id}/verification-decision`)
    assert.equal(receipt.request.actor_id, bob)
    assert.equal(receipt.request.approved, true)
    assert.match(receipt.request.decision_key, uuidPattern)
    const persisted = await waitFor('browser review persisted', (state) => state.verification_requests.find((review) =>
      review.run_id === correctionRun.id && review.status === 'approved'))
    assert.equal(persisted.result.decided_by, bob)
    return { ...receipt, persisted_review: persisted.result, assurance: 'Development fixture principal; not human signoff.' }
  })
  await waitFor('reviewed correction completed', (state) => state.runs.find((run) => run.id === correctionRun.id && run.status === 'completed'))
  const adoption = await stage('Actual App adopts the verified correction; replay preserves lineage', async () => {
    const card = await openMission(page, r.mission_id)
    const panel = card.getByTestId('review-revision-panel')
    await panel.getByLabel('Adoption or abandonment reason', { exact: true }).fill('Adopt the exact corrected source after saved checks and the fresh fixture review.')
    const receipt = await clickPost(page, panel.getByRole('button', { name: 'Adopt verified correction', exact: true }), `${revisionsPath(f)}/${r.id}/adopt`)
    const adopted = receipt.result.revision
    assert.equal(adopted.state, 'adopted')
    assert.equal(adopted.result_run_id, correctionRun.id)
    assert.equal(adopted.review_decision_id, decision.request.decision_key)
    assert.notEqual(adopted.result_commit, f.publication.commit_sha)
    assert.equal(receipt.result.work_item.mission_id, r.mission_id)
    assert.equal(receipt.result.work_item.state, 'verified')
    assert.equal(receipt.result.work_item.policy.source_base_commit, f.base)
    const retry = await ok(receipt.path, receipt.request)
    assert.equal(retry.replayed, true)
    assert.deepEqual(retry.revision, adopted)
    assert.deepEqual(originalRecords(f, await snapshot()), f.original)
    assert.deepEqual(await sourceState(), preservation)
    return { ...receipt, replayed: true }
  })
  const resultDeliverable = (await snapshot()).source_deliverables.find((d) => d.id === adoption.result.revision.result_deliverable_id)
  assert.ok(resultDeliverable)
  const expectedBranch = `ecorp/issue-${f.issue.number}-review-${r.id.replaceAll('-', '')}`
  await changeFake((state) => { state.branch_heads[expectedBranch] = resultDeliverable.head_commit })
  const publishKey = randomUUID(), publishAuthorization = randomUUID()
  await stage('Drifted predecessor PR rejected before superseding remote effects', async () => {
    const counts = effectCounts(await fakeState())
    await changeFake((state) => { state.pull_requests.find((pr) => pr.number === f.publication.pull_request_number).headRefOid = 'f'.repeat(40) })
    let rejection
    try { rejection = await publish(f, resultDeliverable, publishKey, publishAuthorization, /predecessor|head|commit|match|drift/i) }
    finally { await changeFake((state) => { state.pull_requests.find((pr) => pr.number === f.publication.pull_request_number).headRefOid = f.publication.commit_sha }) }
    assert.deepEqual(effectCounts(await fakeState()), counts)
    assert.equal(await git(['rev-parse', `refs/heads/${f.publication.branch}`], remote), f.publication.commit_sha)
    return { rejection, unchanged_effects: counts, retry_key: publishKey }
  })
  await stage('Recovery and repeated publication create one superseding branch and PR', async () => {
    const result = await publish(f, resultDeliverable, publishKey, publishAuthorization)
    const counts = effectCounts(await fakeState())
    const retry = await publish(f, resultDeliverable, publishKey, publishAuthorization)
    const current = await context(f.item)
    assert.equal(current.work_item.state, 'published')
    assert.equal(current.publication.state, 'published')
    assert.equal(current.publication.supersedes_publication_id, f.publication.id)
    assert.equal(current.publication.branch, expectedBranch)
    assert.equal(current.publication.commit_sha, resultDeliverable.head_commit)
    assert.equal(current.publication_history.length, 2)
    assert.deepEqual(current.publication_history.find((p) => p.id === f.publication.id), f.publication)
    const state = await fakeState()
    assert.deepEqual(effectCounts(state), counts)
    assert.equal(state.pull_requests.length, 2)
    assert.equal(state.pr_create_calls, 2)
    const replacement = state.pull_requests.find((pr) => pr.headRefName === expectedBranch)
    assert.equal(replacement.headRefOid, resultDeliverable.head_commit)
    assert.ok(replacement.body.includes(`Supersedes ${f.publication.pull_request_url}`))
    assert.ok(replacement.body.includes(r.id))
    assert.equal(state.item_edits, 1, 'Already In Review must not receive a duplicate Project transition')
    const projectEffects = state.effect_log.filter((effect) => effect.kind === 'project_status')
    assert.equal(projectEffects.length, 1)
    assert.equal(projectEffects[0].item_id, f.projectItem)
    assert.equal(projectEffects[0].status, 'In Review')
    assert.equal(projectEffects[0].pull_request_count, 1, 'The only transition belongs to the original publication')
    const branches = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads'], remote)).split(/\r?\n/)
    assert.equal(branches.length, 3)
    assert.equal(await git(['rev-parse', `refs/heads/${expectedBranch}`], remote), resultDeliverable.head_commit)
    assert.equal(await git(['rev-parse', `refs/heads/${f.publication.branch}`], remote), f.publication.commit_sha)
    await git(['merge-base', '--is-ancestor', f.publication.commit_sha, resultDeliverable.head_commit], remote)
    assert.deepEqual(originalRecords(f, await snapshot()), f.original)
    assert.deepEqual(await sourceState(), preservation)
    return { publication: current.publication, result, retry, branches, effects: counts, predecessor_preserved: true }
  })
  await stage('Actual App history and exact correction navigation survive reload and mobile layout', async () => {
    let card = await openMission(page, f.mission)
    let panel = card.getByTestId('review-revision-panel')
    await panel.getByText('Last recorded review head', { exact: true }).waitFor()
    assert.ok((await panel.innerText()).includes(f.publication.commit_sha))
    assert.ok((await panel.innerText()).includes(resultDeliverable.head_commit))
    assert.ok((await panel.innerText()).includes(authorization.request.findings[0].summary))
    await panel.getByText('Publication history', { exact: true }).click()
    await panel.getByText('Superseding publication', { exact: false }).waitFor()
    await page.screenshot({ path: path.join(output, 'correction-published-history.png'), fullPage: true })
    await panel.getByRole('button', { name: 'Inspect correction run', exact: true }).click()
    card = page.locator('#missions').getByTestId(`mission-${r.mission_id}`)
    await card.waitFor()
    assert.equal(await card.getAttribute('data-run-id'), correctionRun.id)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.live-indicator.live-live').waitFor()
    await card.waitFor()
    assert.equal(await card.getAttribute('data-run-id'), correctionRun.id)
    panel = card.getByTestId('review-revision-panel')
    await panel.getByText('Last recorded review head', { exact: true }).waitFor()
    assert.ok((await panel.innerText()).includes(resultDeliverable.head_commit))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(output, 'correction-mobile.png'), fullPage: true })
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
    assert.ok(dimensions.scroll <= dimensions.width, `Mobile overflow: ${JSON.stringify(dimensions)}`)
    await page.setViewportSize({ width: 1440, height: 1100 })
    return { mission_id: r.mission_id, run_id: correctionRun.id, dimensions,
      screenshots: ['correction-awaiting-review.png', 'correction-published-history.png', 'correction-mobile.png'] }
  })
  const abandonedFixture = await createItem(950002)
  await stage('Second original publication for explicit abandonment', () => publishOriginal(abandonedFixture))
  const abandonmentAuthorization = await authorizeInApp(page, abandonedFixture, 'This fixture correction will be explicitly abandoned before execution.')
  const abandonedRevision = abandonmentAuthorization.result.revision
  await stage('Actual App explicitly abandons unstarted work with terminal replay', async () => {
    const card = await openMission(page, abandonedFixture.mission)
    const panel = card.getByTestId('review-revision-panel')
    await panel.getByLabel('Adoption or abandonment reason', { exact: true }).fill('The owned fixture intentionally abandons this unstarted correction.')
    const receipt = await clickPost(page, panel.getByRole('button', { name: 'Abandon correction', exact: true }),
      `${revisionsPath(abandonedFixture)}/${abandonedRevision.id}/abandon`)
    assert.equal(receipt.result.revision.state, 'abandoned')
    assert.equal(receipt.result.work_item.state, 'published')
    assert.equal(receipt.result.work_item.mission_id, abandonedFixture.mission)
    const replay = await ok(receipt.path, receipt.request)
    assert.equal(replay.replayed, true)
    const state = await snapshot()
    assert.equal(state.runs.filter((run) => run.task_id === abandonedRevision.task_id).length, 0)
    assert.equal(state.missions.find((m) => m.id === abandonedRevision.mission_id).status, 'cancelled')
    assert.deepEqual(originalRecords(abandonedFixture, state), abandonedFixture.original)
    const newRequest = { ...abandonmentAuthorization.request, idempotency_key: randomUUID(), expected_version: receipt.result.work_item.version }
    const denied = rejected(await request(revisionsPath(abandonedFixture), newRequest), /already.*correction|resume.*mission/i)
    assert.equal((await ok(`${revisionsPath(abandonedFixture)}?actor_id=${alice}`)).length, 1)
    return { ...receipt, replayed: true, terminal_reauthorization: denied }
  })
  await stage('Completed replay also fails closed on a native predecessor branch advance', async () => {
    // This final controlled action advances only an explicitly owned local bare
    // fixture ref. It is not a provider write or an external/force push.
    const counts = effectCounts(await fakeState())
    const branch = `refs/heads/${f.publication.branch}`
    const tree = await git(['rev-parse', `${f.publication.commit_sha}^{tree}`], remote)
    const drift = await git(['-c', 'user.name=ECorp acceptance fixture', '-c', 'user.email=acceptance@example.invalid',
      'commit-tree', tree, '-p', f.publication.commit_sha, '-m', 'Controlled unverified published-branch advance'], remote)
    await git(['merge-base', '--is-ancestor', f.publication.commit_sha, drift], remote)
    await git(['update-ref', branch, drift, f.publication.commit_sha], remote)
    const result = await publish(f, resultDeliverable, publishKey, publishAuthorization, /remote publication branch .* points to /i)
    assert.ok(result.detail.includes(f.publication.branch))
    assert.ok(result.detail.includes(drift))
    assert.ok(result.detail.includes(f.publication.commit_sha))
    assert.deepEqual(effectCounts(await fakeState()), counts)
    assert.equal((await context(f.item)).publication.commit_sha, resultDeliverable.head_commit)
    assert.deepEqual(originalRecords(f, await snapshot()), f.original)
    return { result, controlled_fixture_ref: branch, recorded_original: f.publication.commit_sha, observed_drift: drift,
      effects_unchanged: counts, fixture_ref_preserved_for_inspection: true }
  })
  assert.deepEqual(report.external_requests, [])
  assert.deepEqual(report.browser_errors, [])
  report.passed = true
} catch (error) {
  report.failure = safe(error.stack ?? error)
  try {
    const page = browser?.contexts()[0]?.pages()[0]
    if (page) await page.screenshot({ path: path.join(output, 'acceptance-failure.png'), fullPage: true })
  } catch (screenshotError) { report.failure_screenshot_error = safe(screenshotError.message) }
  process.exitCode = 1
} finally {
  try { if (browser) await browser.close() } catch (error) { report.browser_cleanup_error = safe(error.message); report.passed = false; process.exitCode = 1 }
  try {
    if (enrollment) {
      const revoked = await ok(`/api/corps/${corp}/factory/publication-publishers/credentials/${enrollment.credential_id}/revoke`, { actor_id: alice, reason: 'Owned fixture complete; revoke ephemeral publisher credential.' })
      assert.equal(revoked.revoked, true)
      report.publisher_credential_revoked = true
    }
  } catch (error) { report.credential_cleanup_error = safe(error.message); report.passed = false; process.exitCode = 1 }
  await rm(credentialPath, { force: true })
  enrollment = null
  try {
    assert.equal(await git(['rev-parse', 'HEAD'], root), report.product_head)
    assert.deepEqual(await productSourceFiles(), report.source_files)
    report.source_unchanged = true
  } catch (error) { report.source_unchanged = false; report.source_validation_error = safe(error.message); report.passed = false; process.exitCode = 1 }
  report.finished_at = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ passed: report.passed, scenarios_passed: report.scenarios.length, stage: report.stage, failure: report.failure, report: path.join(output, 'acceptance.json') }))
  secrets.fill('')
}
