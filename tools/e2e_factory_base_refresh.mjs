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
assert.equal(process.env.CRONY_BASE_REFRESH_TEST, '1', 'Explicit owned fixture opt-in required')
assert.ok(path.isAbsolute(process.env.CRONY_BASE_REFRESH_FIXTURE ?? ''), 'Absolute fixture receipt required')
const fixture = JSON.parse(await readFile(process.env.CRONY_BASE_REFRESH_FIXTURE, 'utf8'))
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
const publisherId = `base-refresh-fixture-${randomUUID()}`
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
function controls(version, revision, reason) {
  return { expected_version: version, operation_key: randomUUID(), observed_source_revision: revision, reason }
}
function controlArgs(control) {
  return Object.entries(control).flatMap(([key, value]) => ['--' + key.replaceAll('_', '-'), String(value)])
}
async function refresh(f, operation, control, extras = [], failure) {
  return command(['factory-base-refresh', corp, alice, f.item, '--github-cli', process.execPath, operation, ...extras, ...controlArgs(control)],
    { ECORP_FACTORY_CLAIM_TOKEN: f.token }, failure)
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
  await writeFile(statePath, JSON.stringify({
    repository: identity.repository,
    project: { id: 'PVT_BASE_REFRESH', owner: identity.owner, number: 7, status_field_id: 'PVTSSF_BASE_REFRESH',
      status_options: [{ id: 'progress', name: 'In Progress' }, { id: 'review', name: 'In Review' }] },
    items: [{ id: f.projectItem, status: 'In Progress', content: { ...f.issue, type: 'Issue', repository: identity.repository } }],
    issues: { [f.issue.number]: f.issue }, updates: [], pull_requests: [], next_pr_number: 840001,
  }, null, 2) + '\n')
}
const verificationPolicy = { checks: [
  { type: 'artifact', min_bytes: 12 },
  { type: 'file', path: 'portable-untracked.txt', min_bytes: 1 },
  { type: 'command', program: 'node', args: ['-e', "const f=require('node:fs'),a=require('node:assert/strict');a.match(f.readFileSync('README.md','utf8'),/Portable deliverable fixture: tracked change/);a.equal(f.readFileSync('portable-untracked.txt','utf8'),'portable untracked source\\n')"], timeout_ms: 10000 },
], manual_gate: null }
async function createItem(number) {
  const base = await git(['rev-parse', 'main'])
  const issue = { id: `I_BASE_REFRESH_${number}`, number, title: `Owned base refresh ${number} [portable-deliverable]`,
    body: 'Preserve tracked and untracked source changes across an advanced base. [portable-deliverable]',
    url: `${identity.url}/issues/${number}`, state: 'OPEN', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    labels: [{ name: 'factory:ready' }], repository: { nameWithOwner: identity.repository } }
  const projectItem = `PVTI_BASE_REFRESH_${number}`
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
  // checkout must stay intact; refresh additionally preserves all source refs.
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
async function approveInApp(r) {
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' })
  const blocked = [], browserErrors = []
  await browserContext.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if ([server, web].includes(url.origin)) return route.continue()
    blocked.push(url.origin + url.pathname)
    return route.abort()
  })
  const page = await browserContext.newPage()
  page.on('pageerror', (error) => browserErrors.push(safe(error.message)))
  await page.goto(web + '/#missions', { waitUntil: 'domcontentloaded' })
  await page.locator('.live-indicator.live-live').waitFor()
  await page.locator('#operator-actor').selectOption(bob)
  const title = (await snapshot()).missions.find((m) => m.id === r.mission_id).title
  const button = page.locator('#missions .mission-selector button').filter({ has: page.getByText(title, { exact: true }) })
  await button.click()
  const card = page.getByTestId(`mission-${r.mission_id}`)
  await card.waitFor()
  assert.equal(await card.getAttribute('data-run-id'), r.run_id)
  await page.screenshot({ path: path.join(output, 'refresh-awaiting-review.png'), fullPage: true })
  const decisionPath = `/api/corps/${corp}/runs/${r.run_id}/verification-decision`
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === decisionPath && response.request().method() === 'POST'),
    card.getByRole('button', { name: 'Accept evidence', exact: true }).click(),
  ])
  assert.equal(response.status(), 200)
  const body = response.request().postDataJSON()
  assert.equal(body.actor_id, bob)
  assert.equal(body.approved, true)
  assert.match(body.decision_key, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
  const completed = await waitFor('browser decision persisted', (s) => s.verification_requests.find((v) => v.run_id === r.run_id && v.status === 'approved'))
  assert.equal(completed.result.decided_by, bob)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.live-indicator.live-live').waitFor()
  await page.screenshot({ path: path.join(output, 'refresh-reviewed-reload.png'), fullPage: true })
  assert.deepEqual(blocked, [])
  assert.deepEqual(browserErrors, [])
  const result = { browser_version: browser.version(), request: body, persisted_review: completed.result, screenshots: ['refresh-awaiting-review.png', 'refresh-reviewed-reload.png'], external_requests: blocked }
  await browser.close()
  browser = null
  return result
}

try {
  report.product_head = await git(['rev-parse', 'HEAD'], root)
  report.source_files = await productSourceFiles()
  enrollment = await ok(`/api/corps/${corp}/factory/publication-publishers/credentials`, { actor_id: alice, publisher_id: publisherId, expires_in_seconds: 3600 })
  secrets.push(enrollment.credential)
  await writeFile(credentialPath, enrollment.credential, { flag: 'wx', mode: 0o600 })
  const f = await createItem(840001)
  // Both original runs use the exact source advertised by this enrolled runner.
  // Advancing that source later is a controlled test action, never a runner write.
  const failedFixture = await createItem(840002)
  await boundary(f)
  await stage('Original provider run and canonical export', async () => ({ item: f.item, mission: f.mission, run: f.originalRun.id, base: f.base, deliverable: f.deliverable, checks: checkEvidence(await snapshot(), f.originalRun.id) }))
  await writeFile(path.join(source, 'BASE_ADVANCED.txt'), 'Accepted prerequisite on main.\n')
  await git(['add', '--', 'BASE_ADVANCED.txt'])
  await git(['commit', '-m', 'Owned fixture prerequisite advances main'])
  const newBase = await git(['rev-parse', 'HEAD'])
  await git(['push', remote, 'main:main'])
  const preservation = await sourceState()
  await stage('Stale publication rejected before durable effects', async () => {
    const result = await publish(f, f.deliverable, randomUUID(), randomUUID(), /base|commit|advanced/i)
    assert.equal((await context(f.item)).publication, null)
    return result
  })
  const before = await context(f.item)
  const control = controls(before.work_item.version, f.issue.updatedAt, 'Re-verify the unchanged portable delta on the advanced main.')
  const extra = ['--source-deliverable-id', f.deliverable.id, '--new-base-commit', newBase]
  await stage('Changed issue authority and replacement checks rejected', async () => {
    const original = await readFile(statePath, 'utf8')
    const changed = JSON.parse(original)
    changed.issues[f.issue.number].updatedAt = new Date(Date.now() + 60000).toISOString()
    await writeFile(statePath, JSON.stringify(changed))
    const revision = await refresh(f, 'authorize', control, extra, /revision|changed/i)
    changed.issues[f.issue.number] = { ...f.issue, url: 'https://github.com/other/ecorp/issues/840001' }
    await writeFile(statePath, JSON.stringify(changed))
    const repository = await refresh(f, 'authorize', control, extra, /identity|repository|url/i)
    await writeFile(statePath, original)
    const replacement = await request(`/api/corps/${corp}/factory/work-items/${f.item}/base-refreshes`, {
      actor_id: alice, claim_token: f.token, expected_version: control.expected_version, idempotency_key: control.operation_key,
      source_deliverable_id: f.deliverable.id, new_base_commit: newBase, observed_source_revision: f.issue.updatedAt,
      reason: control.reason, verification_policy: { checks: [], manual_gate: null },
    })
    assert.equal(replacement.status, 422)
    assert.deepEqual(await ok(`/api/corps/${corp}/factory/work-items/${f.item}/base-refreshes?actor_id=${alice}`), [])
    return { changed_revision: revision, changed_repository: repository, replacement_policy_status: replacement.status }
  })
  const authorized = await refresh(f, 'authorize', control, extra)
  const r = authorized.refresh
  await stage('Authorization retry converges on one governed run', async () => {
    const retry = await refresh(f, 'authorize', control, extra)
    assert.equal(retry.replayed, true)
    assert.equal(retry.refresh.id, r.id)
    assert.equal(retry.refresh.run_id, r.run_id)
    assert.equal((await context(f.item)).work_item.mission_id, f.mission)
    return { refresh: r, operation_key: control.operation_key, replayed: retry.replayed }
  })
  const waiting = await waitFor('refresh independent review', (s) => s.runs.find((run) => run.id === r.run_id && ['waiting_for_approval', 'failed', 'completed'].includes(run.status)))
  assert.equal(waiting.result.status, 'waiting_for_approval', JSON.stringify(waiting.result))
  await stage('Saved verification checks run without a provider allocation', async () => {
    const run = waiting.result
    assert.equal(run.execution_mode, 'verification_only')
    for (const key of ['provider_session_id', 'model', 'reasoning_effort']) assert.equal(run[key], null)
    for (const key of ['input_tokens', 'output_tokens', 'cost_microusd', 'budget_tokens_limit', 'budget_cost_microusd_limit']) assert.equal(run[key], 0)
    const task = waiting.state.tasks.find((t) => t.id === r.task_id)
    assert.deepEqual(task.verification_policy.checks, verificationPolicy.checks)
    assert.equal(task.verification_policy.manual_gate.type, 'independent_review')
    return { run_id: run.id, execution_mode: run.execution_mode, provider_session_id: run.provider_session_id, token_cost_totals: [run.input_tokens, run.output_tokens, run.cost_microusd], checks: checkEvidence(waiting.state, run.id) }
  })
  await stage('Pending refresh fences publication and adoption; requester cannot review', async () => {
    // The native publisher rejects a stale remote base before contacting the
    // server. Exercise the server's independent pending-refresh fence directly
    // with the fixture's enrolled publisher credential as well.
    const publication = await publish(f, f.deliverable, randomUUID(), randomUUID(), /remote base .*not verified commit/i)
    const serverPublication = await request(`/api/corps/${corp}/factory/work-items/${f.item}/publication`, {
      actor_id: alice, source_deliverable_id: f.deliverable.id, target_repository: identity.repository,
      base_ref: 'main', branch: `ecorp/issue-${f.issue.number}-${f.deliverable.head_commit.slice(0, 12)}`,
      title: f.issue.title, body: 'Owned acceptance checks the pending refresh fence.',
      authorization_id: randomUUID(), authorization_reason: 'Owned acceptance authorizes only the local fixture publication.',
      effect_key: randomUUID(), idempotency_key: randomUUID(), publisher_id: publisherId, lease_seconds: 120,
    }, { 'x-crony-publication-publisher-credential': enrollment.credential })
    assert.equal(serverPublication.status, 400)
    assert.match(serverPublication.body.error, /publication is fenced while a base refresh awaits adoption or abandonment/)
    const adoption = await refresh(f, 'adopt', controls((await context(f.item)).work_item.version, f.issue.updatedAt, 'Premature adoption must be rejected.'), [r.id], /completed|review|verification|ready/i)
    const review = await request(`/api/corps/${corp}/runs/${r.run_id}/verification-decision`, { actor_id: alice, approved: true, note: 'Fixture requester must not self-review.', decision_key: randomUUID() })
    assert.ok([403, 409].includes(review.status))
    assert.equal((await context(f.item)).work_item.mission_id, f.mission)
    assert.equal((await context(f.item)).publication, null)
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).pull_requests.length, 0)
    return { publication, server_publication: serverPublication, adoption, requester_review_status: review.status }
  })
  await stage('Actual App independent review persists across reload', () => approveInApp(r))
  await waitFor('reviewed run terminal', (s) => s.runs.find((run) => run.id === r.run_id && run.status === 'completed'))
  const adoptionControl = controls((await context(f.item)).work_item.version, f.issue.updatedAt, 'Adopt only the fully verified and independently reviewed refresh.')
  const adopted = await refresh(f, 'adopt', adoptionControl, [r.id])
  await stage('Adoption and retry preserve immutable result lineage', async () => {
    const retry = await refresh(f, 'adopt', adoptionControl, [r.id])
    assert.equal(retry.replayed, true)
    assert.equal(adopted.refresh.state, 'adopted')
    assert.equal(retry.refresh.result_commit, adopted.refresh.result_commit)
    assert.equal(adopted.work_item.mission_id, r.mission_id)
    assert.equal(adopted.work_item.policy.source_base_commit, newBase)
    assert.ok(adopted.refresh.review_decision_id)
    assert.deepEqual(await sourceState(), preservation)
    return { refresh: adopted.refresh, operation_key: adoptionControl.operation_key, original_source_preserved: true }
  })
  const state = await snapshot()
  const resultDeliverable = state.source_deliverables.find((d) => d.id === adopted.refresh.result_deliverable_id)
  assert.ok(resultDeliverable)
  const expectedBranch = `ecorp/issue-${f.issue.number}-${resultDeliverable.head_commit.slice(0, 12)}`
  // The fake API needs the expected PR identity. The native remote checks below
  // independently prove that the publisher actually pushed that exact commit.
  const fakeState = JSON.parse(await readFile(statePath, 'utf8'))
  fakeState.branch_heads = { [expectedBranch]: resultDeliverable.head_commit }
  await writeFile(statePath, JSON.stringify(fakeState, null, 2) + '\n')
  const publishKey = randomUUID(), authorization = randomUUID()
  await stage('Publish exact refreshed commit with one branch and pull request', async () => {
    const result = await publish(f, resultDeliverable, publishKey, authorization)
    const retry = await publish(f, resultDeliverable, publishKey, authorization)
    const current = await context(f.item)
    assert.equal(current.publication.state, 'published')
    const remoteState = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(remoteState.pull_requests.length, 1)
    assert.equal(remoteState.pr_create_calls, 1)
    assert.equal(remoteState.pull_requests[0].headRefName, expectedBranch)
    assert.equal(remoteState.pull_requests[0].headRefOid, adopted.refresh.result_commit)
    const published = current.publication
    const branches = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads'], remote)).split(/\r?\n/)
    assert.equal(branches.length, 2)
    const publicationBranch = branches.find((branch) => branch !== 'refs/heads/main')
    assert.equal(publicationBranch, `refs/heads/${expectedBranch}`)
    assert.equal(await git(['rev-parse', publicationBranch], remote), adopted.refresh.result_commit)
    assert.equal(await git(['show', `${publicationBranch}:BASE_ADVANCED.txt`], remote), 'Accepted prerequisite on main.')
    assert.match(await git(['show', `${publicationBranch}:README.md`], remote), /Portable deliverable fixture/)
    assert.equal(await git(['show', `${publicationBranch}:portable-untracked.txt`], remote), 'portable untracked source')
    assert.deepEqual(await sourceState(), preservation)
    return { publication: published, first_response: result, replay_response: retry, branch_count: branches.length, fake_pr_count: 1, exact_commit: adopted.refresh.result_commit }
  })
  await boundary(failedFixture)
  await writeFile(path.join(source, 'README.md'), 'Conflicting prerequisite replaces the original final line.\n')
  await git(['add', '--', 'README.md'])
  await git(['commit', '-m', 'Owned fixture introduces a conflicting main change'])
  const conflictBase = await git(['rev-parse', 'HEAD'])
  await git(['push', remote, 'main:main'])
  const conflictPreservation = await sourceState()
  await stage('Conflicting base fails safely and can be explicitly abandoned', async () => {
    const authorization = controls((await context(failedFixture.item)).work_item.version, failedFixture.issue.updatedAt, 'Attempt the known conflicting base without automatic conflict resolution.')
    const started = await refresh(failedFixture, 'authorize', authorization, ['--source-deliverable-id', failedFixture.deliverable.id, '--new-base-commit', conflictBase])
    const failed = await waitFor('conflicting reconstruction failure', (s) => s.runs.find((run) => run.id === started.refresh.run_id && ['failed', 'completed', 'waiting_for_approval'].includes(run.status)))
    assert.equal(failed.result.status, 'failed')
    assert.match(failed.result.summary ?? '', /conflict|reconstruct|merge/i)
    const original = failed.state.runs.find((run) => run.id === failedFixture.originalRun.id)
    assert.equal(original.status, 'completed')
    assert.equal((await context(failedFixture.item)).work_item.mission_id, failedFixture.mission)
    const control = controls((await context(failedFixture.item)).work_item.version, failedFixture.issue.updatedAt, 'Abandon the failed conflicting refresh and preserve both workspaces.')
    const abandoned = await refresh(failedFixture, 'abandon', control, [started.refresh.id])
    const retry = await refresh(failedFixture, 'abandon', control, [started.refresh.id])
    assert.equal(abandoned.refresh.state, 'abandoned')
    assert.equal(retry.replayed, true)
    assert.equal(abandoned.work_item.mission_id, failedFixture.mission)
    assert.deepEqual(await sourceState(), conflictPreservation)
    return { refresh: abandoned.refresh, failure_run_id: failed.result.id, failure_summary: failed.result.summary, operation_key: control.operation_key, original_result_preserved: true, replayed: retry.replayed }
  })
  report.passed = true
} catch (error) {
  report.failure = safe(error.stack ?? error)
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
