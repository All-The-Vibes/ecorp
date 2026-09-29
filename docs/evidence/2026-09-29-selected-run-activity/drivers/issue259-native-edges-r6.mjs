// Retrospective issue259 acceptance. Uses only the already-owned native PR265 stack.
// Each case has a new, immutable receipt. Never resets fixtures or manufactures run states.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { resolve, join, basename, dirname, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const argv = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => index % 2 ? out : [...out, [value, all[index + 1]]], []))
const qa = resolve(argv['--qa-root'] ?? '')
assert.ok(isAbsolute(argv['--qa-root'] ?? '') && basename(dirname(qa)) === 'qa' && /^pr265-run-activity-issue259-[a-z0-9-]+$/i.test(basename(qa)))
assert.equal(realpathSync(qa), qa)
const pg = resolve(argv['--postgres-bin'] ?? '')
const caseName = argv['--case']
assert.ok(['offline', 'suspension', 'quarantine'].includes(caseName))
const owner = JSON.parse(readFileSync(join(qa, 'ownership.json'), 'utf8'))
assert.equal(owner.purpose, 'pr265-run-activity'); assert.equal(owner.test_owned, true)
assert.equal(owner.schema_version, 2); assert.equal(resolve(owner.workspace), qa)
const product = resolve(owner.plan.product), { server, web } = owner.plan
assert.ok(relative(product, qa).startsWith('..'))
assert.equal(owner.plan.runner_id, 'pr265-activity-qa')
assert.equal(owner.plan.database.host, '127.0.0.1'); assert.equal(owner.plan.database.name, 'pr265_activity')
for (const origin of [server, web]) assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{4}$/)
execFileSync('pwsh', ['-NoProfile', '-File', join(product, 'tools/qa_factory_run_activity.ps1'), '-Phase', 'Status', '-QaRoot', qa, '-PostgresBin', pg], { stdio: 'pipe', timeout: 30000 })
const original = JSON.parse(readFileSync(join(qa, 'evidence/issue259-browser.json'), 'utf8'))
assert.equal(original.status, 'accepted', 'Finish the independent browser acceptance before native edge cases')
const prepared = JSON.parse(readFileSync(join(qa, 'evidence/acceptance.json'), 'utf8'))
const { demo, source } = owner
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
const identity = () => ({ head: git(product, 'rev-parse', 'HEAD'), diff_sha256: hash(execFileSync('git', ['-C', product, 'diff', '--binary', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })) })
assert.deepEqual(identity(), original.source)
const reportPath = join(qa, 'evidence', 'issue259-native-' + caseName + '-r6.json')
assert.equal(existsSync(reportPath), false, 'Existing native case receipt: reconcile its exact resources instead of duplicating mutations')
const report = { issue: 259, case: caseName, source: identity(), status: 'running', started_at: new Date().toISOString(), scope: 'Owned browser/server/PostgreSQL/native deterministic runner; no AI inference or remote GitHub effects', operations: [], checks: {}, screenshots: {}, failures: [] }
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
function save() { report.updated_at = new Date().toISOString(); writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(reportPath + '.tmp', reportPath) }
function check(name, value = true) { report.checks[name] = value; save(); console.log('PASS ' + name) }
const api = (suffix) => '/api/corps/' + demo.corp_id + suffix
async function request(route, body, expectedStatus = 200) {
  assert.ok([200, 204].includes(expectedStatus))
  assert.ok(route.startsWith('/api/') && !route.startsWith('//'))
  const response = await fetch(server + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  assert.equal(response.status, expectedStatus, route.split('?')[0] + ' returned ' + response.status + '; body withheld')
  if (expectedStatus === 204) { assert.equal(await response.text(), ''); return {} }
  return response.json()
}
async function post(name, route, body, expectedStatus = 200) {
  assert.ok(!report.operations.some((entry) => entry.name === name), 'Reconcile existing operation ' + name)
  const op = { name, route, expected_status: expectedStatus, at: new Date().toISOString(), completed: false }; report.operations.push(op); save()
  const result = await request(route, body, expectedStatus)
  op.completed = true; op.http_status = expectedStatus
  op.ids = Object.fromEntries(['mission_id', 'task_id', 'run_id'].filter((key) => result[key]).map((key) => [key, result[key]]))
  if (result.work_item) op.work_item_id = result.work_item.id
  save(); return result
}
const snapshot = () => request(api('/snapshot?actor_id=' + demo.alice_actor_id))
async function graph(mid) {
  const state = (await snapshot()).snapshot, tasks = state.tasks.filter((task) => task.mission_id === mid)
  return { state, mission: state.missions.find((mission) => mission.id === mid), tasks, runs: state.runs.filter((run) => tasks.some((task) => task.id === run.task_id)), item: state.factory_work_items.find((item) => item.mission_id === mid) }
}
async function wait(probe, label, timeout = 70000) {
  const until = Date.now() + timeout
  do { const value = await probe(); if (value) return value; await new Promise((done) => setTimeout(done, 150)) } while (Date.now() < until)
  throw new Error('Timed out: ' + label + '; preserve exact fixture resources')
}
function sourceIntact() {
  assert.deepEqual({ head: git(join(qa, 'source'), 'rev-parse', 'HEAD'), status: git(join(qa, 'source'), 'status', '--porcelain'), readme_sha256: hash(readFileSync(join(qa, 'source/README.md'))) }, prepared.source_before)
}
function ownedWorkspace(run) {
  assert.equal(run.runner_id, owner.plan.runner_id)
  assert.equal(run.workspace_base_commit, source.base_commit)
  const path = realpathSync(run.workspace_path), inside = relative(join(qa, 'runner'), path)
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside))
  assert.equal(resolve(git(path, 'rev-parse', '--show-toplevel')), path)
  return path
}
let claimToken
async function fixture(number, title, manualReview) {
  const nonce = randomUUID(), revision = new Date().toISOString()
  const issue = { number, id: 'I_ISSUE259_' + nonce, item: 'PVTI_ISSUE259_' + nonce, title, body: 'Owned issue259 native acceptance only. Preserve all source and evidence; no external publication.', revision, url: 'https://github.com/ecorp-fixture/pr265-run-activity/issues/' + number }
  const policy = { schema_version: 1, source_of_truth: 'github_project', project_status: 'Todo', repository_allowlist: [source.repository], source_base_ref: source.base_ref, source_base_commit: source.base_commit, adapter_allowlist: ['fake-process'], strategy_allowlist: ['single'], model: null, reasoning_effort: null, write_scope: ['**'], allowed_tools: ['filesystem', 'shell'], prohibited_actions: ['modify files outside the assigned worktree', 'publish, merge, or deploy'], secret_ids: [], verification_required: true, budget_tokens: 100000, budget_cost_microusd: 10000000, auto_merge: false }
  const material = { actor_id: demo.alice_actor_id, title, description: issue.body, preferred_adapter: 'fake-process', strategy: 'single', budget_tokens: policy.budget_tokens, budget_cost_microusd: policy.budget_cost_microusd, deliverable: { form: 'archive', commit_after_verification: false }, contract: { objective: title, expected_output: 'A native source-bound result or recorded native safety rejection.', acceptance_tests: ['Native evidence binds the exact run and preserved source.'], allowed_tools: policy.allowed_tools, prohibited_actions: policy.prohibited_actions, references: [], write_scope: ['**'] } }
  const beforeCount = (await snapshot()).snapshot.factory_work_items.length
  const preflight = await post('preflight', api('/factory/preflight'), { ...material, source_repository_owner: 'ecorp-fixture', source_repository_name: 'pr265-run-activity', policy })
  assert.equal(preflight.valid, true); assert.equal(preflight.task_count, 1)
  assert.equal((await snapshot()).snapshot.factory_work_items.length, beforeCount)
  const claim = await post('claim', api('/factory/work-items/claim'), { actor_id: demo.alice_actor_id, source_project_owner: 'ecorp-fixture', source_project_number: 265, source_project_item_id: issue.item, source_repository_owner: 'ecorp-fixture', source_repository_name: 'pr265-run-activity', source_issue_number: number, source_issue_node_id: issue.id, source_issue_url: issue.url, source_title: title, source_revision: revision, idempotency_key: 'issue259-' + nonce, lease_seconds: 600, policy })
  assert.equal(claim.replayed, false)
  claimToken = claim.claim_token
  const materialized = await post('materialize', api('/factory/work-items/' + claim.work_item.id + '/materialize'), { ...material, claim_token: claimToken, expected_version: claim.work_item.version, idempotency_key: 'issue259-materialize-' + nonce })
  const result = { mid: materialized.mission_id, item: claim.work_item.id, issue }
  report.fixture = result; save()
  const held = await graph(result.mid)
  assert.equal(held.mission.status, 'ready'); assert.equal(held.runs.length, 0); assert.equal(held.tasks.length, 1)
  if (manualReview) {
    const task = held.tasks[0]
    await post('independent-review-contract', api('/missions/' + result.mid + '/contract-revisions'), { actor_id: demo.alice_actor_id, task_id: task.id, expected_contract_version: task.contract_version, next_action: 'redispatch', source_run_id: null, reason: 'Independent native review before quarantine acceptance.', idempotency_key: randomUUID(), description: issue.body, contract: task.contract, verification_policy: { ...task.verification_policy, manual_gate: { type: 'independent_review', roles: ['owner', 'admin', 'manager', 'member'], exclude_requester: true } } })
  }
  return result
}

const runtime = '<USERPROFILE>/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { chromium } = await import(pathToFileURL(join(runtime, 'index.mjs')))
const { expect } = await import(pathToFileURL(join(runtime, 'test.mjs')))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
await context.route('**/*', (route) => [web + '/', server + '/', 'data:', 'blob:'].some((prefix) => route.request().url().startsWith(prefix)) ? route.continue() : route.abort())
const page = await context.newPage(), errors = []
page.on('pageerror', (error) => errors.push(error.message))
const inspector = () => page.locator('.world-inspector')
const activity = (mid) => page.locator('[data-mission-id="' + mid + '"]').getByTestId('run-activity-panel')
const agentActivity = () => inspector().getByTestId('run-activity-panel')
async function capture(name) { const filename = 'native-' + caseName + '-' + name + '-' + randomUUID().slice(0, 8) + '.png'; await page.screenshot({ path: join(qa, 'evidence', filename), fullPage: true }); report.screenshots[name] = filename; save() }
async function factoryView(item) {
  if (await inspector().count()) await page.keyboard.press('Escape')
  await page.getByRole('link', { name: 'Factory', exact: true }).click()
  const sourceItem = (await snapshot()).snapshot.factory_work_items.find((entry) => entry.id === item)
  assert.ok(sourceItem && Number.isInteger(sourceItem.source_issue_number))
  const picker = page.locator('#factory-work-switch')
  if (await picker.isVisible()) {
    await picker.selectOption(item)
  } else {
    const entry = page.getByRole('navigation', { name: 'Factory work items', exact: true })
      .getByRole('button', { name: new RegExp('GitHub #' + sourceItem.source_issue_number + ' · ') })
    await expect(entry).toHaveCount(1)
    await expect(entry).toBeVisible()
    await entry.click()
  }
  await expect(picker).toHaveValue(item)
  const dossier = page.locator('[data-factory-item-id="' + item + '"]')
  await expect(dossier).toBeVisible(); return dossier
}
async function missionView(f, run) {
  const dossier = await factoryView(f.item)
  await dossier.getByRole('button', { name: /^(Open mission and results|Open run and results|Review this run)$/ }).first().click()
  await expect(activity(f.mid)).toBeVisible()
  if (run && await page.locator('#mission-evidence-' + f.mid).count()) await page.locator('#mission-evidence-' + f.mid).selectOption(run)
  if (run) await expect(activity(f.mid)).toHaveAttribute('data-run-id', run)
}
async function agentView(mid, run) {
  await activity(mid).getByRole('button', { name: 'View run agent', exact: true }).click()
  await expect(agentActivity()).toBeVisible()
  await expect(agentActivity()).toHaveAttribute('data-run-id', run)
  await expect(inspector().getByRole('button', { name: /^(Claim live control|Renew control|Emergency stop|Interrupt turn)$/ })).toHaveCount(0)
}
async function launch(f) {
  await missionView(f)
  const held = await graph(f.mid)
  assert.equal(held.mission.status, 'ready'); assert.equal(held.item.state, 'mission_created')
  assert.equal(held.runs.length, 0)
  const route = api('/missions/' + f.mid + '/launch')
  const op = { name: 'browser-launch', route, at: new Date().toISOString(), completed: false }; report.operations.push(op); save()
  const responsePromise = page.waitForResponse((response) => response.url() === server + route && response.request().method() === 'POST')
  await page.locator('[data-mission-id="' + f.mid + '"]').getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
  assert.equal((await responsePromise).status(), 200); op.completed = true; save()
  // Match the existing Factory controller after the actual browser launch.
  // Launch is not an intake transition; retain the claim/version/idempotency guard.
  const running = await post('factory-native-running', api('/factory/work-items/' + f.item + '/transition'), {
    actor_id: demo.alice_actor_id, claim_token: claimToken, expected_version: held.item.version,
    idempotency_key: 'issue259-running-' + randomUUID(), state: 'running', failure_detail: null,
  })
  assert.equal(running.replayed, false)
  assert.equal(running.work_item.id, f.item); assert.equal(running.work_item.mission_id, f.mid)
  assert.equal(running.work_item.state, 'running'); assert.equal(running.work_item.version, held.item.version + 1)
  check('native_factory_launch_transition', { item: f.item, mission: f.mid, before_version: held.item.version, after_version: running.work_item.version })
}

try {
  await page.goto(web + '/#factory', { waitUntil: 'networkidle' })
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
  sourceIntact()
  const initial = await snapshot()
  assert.ok(initial.snapshot.runs.every((run) => ['completed', 'failed', 'cancelled', 'lost', 'waiting_for_approval'].includes(run.status)))
  assert.equal(initial.runners.length, 1); assert.equal(initial.runners[0].status, 'connected')
  if (caseName === 'offline') {
    const f = { mid: original.prepared_graph.mission_id, item: original.prepared_graph.factory_work_item_id }
    const g = await graph(f.mid), run = g.runs.find((candidate) => ![original.older_run_id, original.newer_run_id].includes(candidate.id))
    assert.ok(run && g.mission.status === 'completed' && g.runs.every((candidate) => candidate.status === 'completed'))
    await missionView(f, run.id)
    const statesBefore = g.runs.map(({ id, status, workspace_fingerprint }) => ({ id, status, workspace_fingerprint })).toSorted((a, b) => a.id.localeCompare(b.id))
    await post('native-offline', '/api/demo/runners/pr265-activity-qa/disconnect', { reconnect_delay_ms: 47000 })
    await wait(async () => (await snapshot()).runners[0].status === 'grace', 'native runner grace')
    await expect(activity(f.mid)).toContainText('Runner: Grace', { timeout: 10000 })
    await wait(async () => (await snapshot()).runners[0].status === 'offline', 'native runner offline after grace')
    await expect(activity(f.mid)).toContainText('Runner: Offline', { timeout: 20000 })
    await capture('mission-offline')
    await agentView(f.mid, run.id); await expect(agentActivity()).toContainText('Runner: Offline'); await capture('agent-offline')
    await wait(async () => (await snapshot()).runners[0].status === 'connected', 'native automatic reconnect')
    await expect(agentActivity()).toContainText('Runner: Connected', { timeout: 20000 })
    await page.keyboard.press('Escape'); await expect(activity(f.mid)).toBeVisible()
    assert.deepEqual((await graph(f.mid)).runs.map(({ id, status, workspace_fingerprint }) => ({ id, status, workspace_fingerprint })).toSorted((a, b) => a.id.localeCompare(b.id)), statesBefore)
    check('native_grace_offline_reconnect', { grace_seconds: 30, requested_disconnect_ms: 47000, exact_run: run.id, both_surfaces: true, history_unchanged: true })
  } else if (caseName === 'suspension') {
    await post('budget-policy', api('/budget-policy'), { actor_id: demo.alice_actor_id, actor_tokens_per_24h: 10000000, actor_cost_microusd_per_24h: 1000000000, corp_tokens_per_24h: 100000000, corp_cost_microusd_per_24h: 10000000000, no_progress_event_limit: 100, repeated_tool_limit: 100 }, 204)
    const f = await fixture(2591, '[budget-loop] issue259 native suspension', false)
    await launch(f)
    const final = await wait(async () => { const g = await graph(f.mid); return g.runs.length === 1 && g.runs[0].breaker_stage === 'suspend' && g.runs[0].status === 'cancelled' && g.state.events.some((event) => event.aggregate_id === g.runs[0].id && event.type === 'run.session_terminated' && event.payload.provider_process_alive === false) && g }, 'native token suspension and confirmed teardown')
    const run = final.runs[0]
    assert.equal(final.mission.status, 'cancelled'); assert.equal(final.item.state, 'running')
    const stages = final.state.circuit_breaker_incidents.filter((entry) => entry.run_id === run.id).map((entry) => entry.stage)
    for (const stage of ['steer', 'constrain', 'suspend']) assert.ok(stages.includes(stage))
    await expect(activity(f.mid)).toHaveAttribute('data-run-id', run.id)
    await expect(activity(f.mid)).toContainText('This run is suspended'); await expect(activity(f.mid)).toContainText('Provider termination confirmed')
    await expect(activity(f.mid)).toContainText('budget · Suspend'); await capture('mission-suspended')
    await agentView(f.mid, run.id); await expect(agentActivity()).toContainText('This run is suspended'); await expect(agentActivity()).toContainText('Provider termination confirmed'); await capture('agent-suspended')
    const dossier = await factoryView(f.item)
    await expect(dossier).toContainText('Intake · Running')
    await expect(dossier).toContainText('mission is Cancelled')
    await expect(dossier).toContainText('Intake state is not proof of an active provider')
    await capture('factory-running-cancelled')
    check('native_suspension', { mission_id: f.mid, run_id: run.id, factory_item_id: f.item, factory_state: final.item.state, mission_status: final.mission.status, stages, workspace_disposition: run.workspace_disposition, terminal_event_ids: final.state.events.filter((event) => event.aggregate_id === run.id && ['run.breaker_transition', 'run.session_terminated', 'run.cancelled'].includes(event.type)).map(({ id, seq, type }) => ({ id, seq, type })), mission_agent_factory: true })
  } else {
    const f = await fixture(2592, '[portable-deliverable] issue259 native quarantine', true)
    await launch(f)
    const held = await wait(async () => { const g = await graph(f.mid); return g.runs.length === 1 && g.runs[0].status === 'waiting_for_approval' && g.runs[0].workspace_disposition === 'preserved' && g.runs[0].workspace_fingerprint && g }, 'independent native outcome review and retained checkpoint')
    const sourceRun = held.runs[0], workspace = ownedWorkspace(sourceRun)
    await post('reject-source-review', api('/runs/' + sourceRun.id + '/verification-decision'), { actor_id: demo.bob_actor_id, approved: false, note: 'Owned negative acceptance: require exact retained-source recovery.', decision_key: randomUUID() })
    const recoveryRoute = api('/factory/work-items/' + f.item + '/verification-recoveries')
    const recovery = await request(recoveryRoute + '?actor_id=' + demo.alice_actor_id)
    assert.equal(recovery.source_run_id, sourceRun.id)
    assert.equal(recovery.workspace_fingerprint, sourceRun.workspace_fingerprint)
    assert.equal((await graph(f.mid)).runs.find((run) => run.id === sourceRun.id).status, 'failed')
    const renewed = await post('renew-claim', api('/factory/work-items/' + f.item + '/renew'), { actor_id: demo.alice_actor_id, claim_token: claimToken, expected_version: recovery.work_item.version, idempotency_key: randomUUID(), lease_seconds: 600 })
    // This fixture requests an archive without a verification commit. The API's
    // optional exported-head guard is distinct from the workspace's actual HEAD.
    assert.equal(recovery.expected_head_commit, null)
    const observedHeadBefore = git(workspace, 'rev-parse', 'HEAD')
    assert.match(observedHeadBefore, /^[0-9a-f]{40}$/)
    assert.equal(observedHeadBefore, source.base_commit)
    check('native_archive_checkpoint_contract', {
      deliverable_form: 'archive', commit_after_verification: false,
      api_expected_head_commit: recovery.expected_head_commit, observed_head_before: observedHeadBefore,
    })
    const sentinel = join(workspace, 'issue259-quarantine-sentinel.txt'), bytes = Buffer.from('Deliberate owned-fixture fingerprint mismatch; preserve this file.\n')
    const mutation = { name: 'owned-source-mismatch', workspace: relative(qa, workspace), file: basename(sentinel), sha256: hash(bytes), completed: false }; report.operations.push(mutation); save()
    writeFileSync(sentinel, bytes, { flag: 'wx' }); mutation.completed = true; save()
    const decision = await post('verifier-only-recovery', recoveryRoute, { actor_id: demo.alice_actor_id, claim_token: claimToken, expected_factory_version: renewed.work_item.version, idempotency_key: randomUUID(), source_run_id: sourceRun.id, mode: 'verifier_only', reason: 'Negative native acceptance: admission must quarantine the changed owned worktree.', observed_source_revision: f.issue.revision, reviewed_source_snapshot: { source_revision: f.issue.revision, issue_number: f.issue.number, issue_node_id: f.issue.id, issue_url: f.issue.url, title: f.issue.title, body: f.issue.body, repository: source.repository, project_owner: 'ecorp-fixture', project_number: 265, project_item_id: f.issue.item }, contract_revision_id: null, expected_workspace_fingerprint: recovery.workspace_fingerprint, expected_head_commit: recovery.expected_head_commit })
    const failed = await wait(async () => { const g = await graph(f.mid); const run = g.runs.find((candidate) => candidate.id !== sourceRun.id && candidate.execution_mode === 'verification_only' && candidate.status === 'failed' && candidate.workspace_disposition === 'quarantined'); return run && { g, run } }, 'native verifier-only fingerprint rejection and quarantine')
    assert.equal(failed.g.runs.length, 2)
    assert.equal(ownedWorkspace(failed.run), workspace)
    assert.equal(failed.run.workspace_fingerprint, null)
    assert.equal(hash(readFileSync(sentinel)), hash(bytes))
    const observedHeadAfter = git(workspace, 'rev-parse', 'HEAD')
    assert.equal(observedHeadAfter, observedHeadBefore)
    await missionView(f, failed.run.id)
    await expect(activity(f.mid)).toContainText('Quarantined')
    await expect(activity(f.mid)).toContainText('Source integrity quarantine')
    await expect(activity(f.mid)).toContainText('Verifier-only run; no provider')
    await capture('mission-quarantined')
    await agentView(f.mid, failed.run.id)
    await expect(agentActivity()).toContainText('Quarantined')
    await expect(agentActivity()).toContainText('Verifier-only run; no provider')
    await capture('agent-quarantined')
    check('native_quarantine', { mission_id: f.mid, source_run_id: sourceRun.id, verifier_run_id: failed.run.id, factory_item_id: f.item, recovery_id: decision.recovery?.id ?? decision.recovery_id ?? null, expected_checkpoint: recovery.workspace_fingerprint, api_expected_head_commit: recovery.expected_head_commit, observed_head_before: observedHeadBefore, observed_head_after: observedHeadAfter, quarantined_workspace: relative(qa, workspace), no_new_fingerprint: true, sentinel_preserved_sha256: hash(bytes), no_replacement_provider_run: true, event_ids: failed.g.state.events.filter((event) => event.aggregate_id === failed.run.id).map(({ id, seq, type }) => ({ id, seq, type })) })
  }
  sourceIntact(); check('configured_fixture_source_unchanged')
  assert.equal((await snapshot()).snapshot.pull_request_publications.length, 0)
  assert.deepEqual(identity(), report.source); assert.deepEqual(errors, [])
  report.page_errors = errors; report.status = 'accepted'; report.finished_at = new Date().toISOString(); save()
  console.log(JSON.stringify({ status: report.status, case: caseName, receipt: reportPath }))
} catch (error) {
  report.status = 'failed'; report.failures.push({ at: new Date().toISOString(), error: error.message.slice(0, 1800) }); report.page_errors = errors; save()
  try { await capture('failure'); console.log((await page.locator('body').innerText()).slice(0, 2000)) } catch {}
  throw error
} finally { claimToken = undefined; await browser.close() }
