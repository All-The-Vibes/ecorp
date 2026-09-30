// Owned budget-display acceptance. Synthetic ledger fixtures are not runtime or human decisions.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { resolve, join, basename, dirname, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
assert.equal(argv.length, 6)
const args = Object.fromEntries(argv.reduce((items, value, index) => index % 2 ? items : [...items, [value, argv[index + 1]]], []))
assert.deepEqual(Object.keys(args).sort(), ['--postgres-bin', '--qa-root', '--source-receipt'])
const qa = resolve(args['--qa-root']), pg = resolve(args['--postgres-bin'])
assert.ok(isAbsolute(args['--qa-root']) && basename(dirname(qa)) === 'qa' && /^pr265-run-activity-issue261-[a-z0-9-]+$/i.test(basename(qa)))
assert.equal(realpathSync(qa), qa)
const load = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const ownership = load(join(qa, 'ownership.json'))
assert.equal(ownership.purpose, 'pr265-run-activity'); assert.equal(ownership.test_owned, true)
assert.equal(ownership.schema_version, 2); assert.equal(resolve(ownership.workspace), qa)
const product = resolve(ownership.plan.product), { server, web } = ownership.plan, { demo, source } = ownership
assert.equal(product, '<USERPROFILE>\\.codex\\worktrees\\issue261-budgets\\ecorp')
assert.ok(relative(product, qa).startsWith('..'))
assert.equal(ownership.plan.runner_id, 'pr265-activity-qa')
assert.equal(ownership.plan.database.host, '127.0.0.1'); assert.equal(ownership.plan.database.name, 'pr265_activity')
for (const origin of [server, web]) assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{4}$/)
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'userprofile',
    'homedrive', 'homepath', 'localappdata', 'appdata', 'programfiles', 'programfiles(x86)',
    'programdata', 'systemdrive', 'number_of_processors', 'processor_architecture'].includes(key.toLowerCase())))
execFileSync('pwsh', ['-NoProfile', '-File', join(product, 'tools/qa_factory_run_activity.ps1'), '-Phase', 'Status', '-QaRoot', qa, '-PostgresBin', pg], { timeout: 30000, stdio: 'pipe', env: childEnv, windowsHide: true })
const prepared = load(join(qa, 'evidence/acceptance.json')), mid = prepared.mission_id
assert.equal(prepared.status, 'prepared')
const sourceReceipt = load(args['--source-receipt'])
assert.equal(resolve(sourceReceipt.worktree), product)
assert.equal(sourceReceipt.identity.head, ownership.plan.product_commit)
const reportPath = join(qa, 'evidence/issue261-browser.json')
assert.ok(!existsSync(reportPath), 'Preserve every attempt; do not replay effects')
const hash = (data) => createHash('sha256').update(data).digest('hex')
const report = {
  issue: 261, status: 'accepting', started_at: new Date().toISOString(),
  scope: 'Owned browser/server/PostgreSQL/native fake-process runner. Separate cancelled synthetic ledger rows test presentation, never provider recovery or actual human decisions. No production identity, real provider inference or real GitHub effects.',
  source_receipt: args['--source-receipt'], source_receipt_sha256: hash(readFileSync(args['--source-receipt'])),
  source_files_sha256: sourceReceipt.physical_files_sha256,
  operations: [], checks: {}, screenshots: {}, failures: [],
  limitations: ['Executive presentation is pending issue 264; issue 261 is not complete.', 'Fake-process has no resumable provider session. No resumed provider session or budget grant is claimed.', 'Historical approved/pending rows are explicitly synthetic UI fixtures. Scripted demo-actor runtime verification decisions are not human reviews.'],
}
const save = () => { report.updated_at = new Date().toISOString(); writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(reportPath + '.tmp', reportPath) }
const check = (name, evidence = true) => { report.checks[name] = evidence; save(); console.log('PASS ' + name) }
save()
const api = (suffix, corp = demo.corp_id) => `/api/corps/${corp}${suffix}`
async function request(route, body) {
  assert.ok(route.startsWith('/api/') && !route.startsWith('//'))
  const response = await fetch(server + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error' })
  assert.equal(response.status, 200, `${route.split('?')[0]} returned ${response.status}; body withheld`)
  return response.json()
}
function intent(name, route) {
  assert.ok(!report.operations.some((operation) => operation.name === name), 'Never duplicate an uncertain effect: ' + name)
  const operation = { name, route, started_at: new Date().toISOString(), completed: false }
  report.operations.push(operation); save(); return operation
}
const snapshot = (actor = demo.alice_actor_id) => request(api(`/snapshot?actor_id=${actor}`))
async function graph() {
  const { snapshot: s } = await snapshot(), tasks = s.tasks.filter((task) => task.mission_id === mid)
  return { mission: s.missions.find((mission) => mission.id === mid), tasks, runs: s.runs.filter((run) => tasks.some((task) => task.id === run.task_id)) }
}
async function wait(probe, label, timeout = 90000) {
  const deadline = Date.now() + timeout
  do { const result = await probe(); if (result) return result; await new Promise((done) => setTimeout(done, 150)) } while (Date.now() < deadline)
  throw new Error('Timed out: ' + label)
}
function sql(statement) {
  const env = { ...childEnv, PGHOST: '127.0.0.1', PGPORT: String(ownership.plan.database.port), PGDATABASE: 'pr265_activity', PGUSER: 'pr265_qa' }
  try { return execFileSync(join(pg, 'psql.exe'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', env, timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim() }
  catch (error) { throw new Error('Owned fixture SQL failed: ' + String(error.stderr ?? '').slice(0, 1600)) }
}
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'"
const uuid = () => randomUUID()
const tokens = (value) => Number(value).toLocaleString('en-US') + ' tokens'
const dollars = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number(value) / 1000000)
function ledger(mission) {
  return JSON.parse(sql(`SELECT json_build_object('tokens', COALESCE(SUM(r.input_tokens+r.output_tokens),0)::text,'cost',COALESCE(SUM(r.cost_microusd),0)::text,'runs',COUNT(r.id),'agents',COUNT(DISTINCT r.agent_id)) FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.corp_id='${demo.corp_id}' AND t.mission_id='${mission}';`))
}
let browser, page, expect, context
const pageErrors = [], requests = []
const panel = () => page.getByTestId('budget-overview')
const row = (mission) => panel().locator(`[data-budget-overview-mission="${mission}"]`)
const card = (mission = mid) => page.locator(`[data-mission-id="${mission}"]`)
const selectionKey = (actorId = demo.alice_actor_id) => 'ecorp:work-selection:v1:' + JSON.stringify([server, demo.corp_id, actorId])
async function capture(name) {
  const file = `${name}-${uuid().slice(0, 8)}.png`
  await panel().screenshot({ path: join(qa, 'evidence', file) }); report.screenshots[name] = file; save()
}
async function refreshed() {
  const currentActor = await page.locator('#operator-actor').inputValue()
  const response = page.waitForResponse((r) => r.url() === server + api(`/snapshot?actor_id=${currentActor}`) && r.request().method() === 'GET')
  await panel().getByRole('button', { name: 'Refresh budgets', exact: true }).click()
  assert.equal((await response).status(), 200)
  await expect(panel().getByTestId('budget-overview-totals')).toBeVisible()
}
async function expand() {
  const details = panel().locator('details.budget-overview-missions')
  if (!(await details.evaluate((element) => element.open))) await details.locator(':scope > summary').click()
}
async function metric(parent, label, expectedTokens, expectedCost) {
  const labelPattern = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
  const item = parent.locator(':scope > div').filter({ has: page.locator('dt').filter({ hasText: labelPattern }) })
  // Native selectors are matched by the rendered semantic label, not implementation imports.
  await expect(item).toHaveCount(1)
  await expect(item.locator('dd > strong')).toHaveText(expectedTokens)
  await expect(item.locator('dd > span')).toHaveText(new RegExp('^' + expectedCost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' '))
}
async function rowMetric(mission, label, expectedTokens, expectedCost) {
  await metric(row(mission).locator('dl'), label, expectedTokens, expectedCost)
}
async function openBudget(mission) {
  await refreshed(); await expand()
  await row(mission).getByRole('button', { name: 'Open mission budget', exact: true }).click()
  await expect(page.locator(`[data-budget-id="${mission}"]`)).toBeFocused()
  const choice = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), selectionKey(await page.locator('#operator-actor').inputValue()))
  assert.equal(choice.missionId, mission)
  await expect(card(mission)).toBeVisible()
}
async function actor(id) {
  if ((await page.locator('#operator-actor').inputValue()) === id) { await refreshed(); return }
  const response = page.waitForResponse((r) => r.url() === server + api(`/snapshot?actor_id=${id}`) && r.request().method() === 'GET')
  await page.locator('#operator-actor').selectOption(id)
  assert.equal((await response).status(), 200)
  await expect(page.locator('#operator-actor')).toHaveValue(id)
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
  await expect(panel().getByTestId('budget-overview-totals')).toBeVisible()
}
async function browserPost(name, route, action) {
  const operation = intent(name, route)
  const responsePromise = page.waitForResponse((r) => r.url() === server + route && r.request().method() === 'POST')
  await action(); const response = await responsePromise
  assert.equal(response.status(), 200, `${name} returned ${response.status()}`)
  operation.completed = true; save(); return response.json()
}
function noBudgetMutations() {
  assert.deepEqual(requests.filter((r) => r.method !== 'GET' && /budget-revisions|budget-policy|\/resume(?:\?|$)/u.test(r.path)), [])
}

try {
  const initial = (await snapshot()).snapshot, template = (await graph()).tasks.find((task) => task.depth === 0)
  const nativeAgents = [...new Set((await graph()).tasks.filter((t) => t.depth === 0).map((t) => t.assigned_agent_id))]
  assert.equal(nativeAgents.length, 2)
  assert.ok(initial.agents.some((agent) => agent.id === nativeAgents[0]))
  const synthetic = {
    rich: { id: uuid(), title: 'Synthetic multi-worker ledger', tasks: [uuid(), uuid(), uuid()], runs: Array.from({ length: 5 }, uuid), approved: uuid(), pending: uuid() },
    missing: { id: uuid(), title: 'Synthetic missing attempt history', task: uuid(), run: uuid() },
    unknown: { id: uuid(), title: 'Synthetic revised ceiling without receipt', task: uuid(), run: uuid() },
    auditor: { actor: uuid(), agent: uuid() }, outside: { corp: uuid(), actor: uuid(), room: uuid(), mission: uuid() },
  }
  report.fixture = { ...synthetic, native_mission: mid, synthetic_only: ['rich', 'missing', 'unknown', 'auditor', 'outside'], native_workers: nativeAgents }; save()
  const { rich, missing, unknown, auditor, outside } = synthetic
  const taskSql = (id, mission, agent, attempts, title) => `INSERT INTO tasks(id,mission_id,corp_id,title,objective,status,assigned_agent_id,plan_key,contract,verification_policy,max_attempts,attempt_count) VALUES('${id}','${mission}','${demo.corp_id}',${quote(title)},'Synthetic ledger display only, not a native completed task','cancelled','${agent}','${id}',${quote(JSON.stringify(template.contract))}::jsonb,${quote(JSON.stringify(template.verification_policy))}::jsonb,5,${attempts});`
  const runSql = (id, task, agent, input, output, cost, stage = 'healthy', parent = null) => `INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,status,summary,input_tokens,output_tokens,cost_microusd,breaker_stage,resumed_from_run_id,assignment_token,workspace_run_id) VALUES('${id}','${demo.corp_id}','${task}','${agent}','issue261-synthetic-ledger','cancelled','Explicitly synthetic ledger presentation; no provider execution',${input},${output},${cost},'${stage}',${parent ? quote(parent) : 'NULL'},gen_random_uuid(),'${id}');`
  const missionSql = (mission, original, current, originalCost, currentCost) => `INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,description,budget_tokens,original_budget_tokens,budget_cost_microusd,original_budget_cost_microusd) VALUES('${mission.id}','${demo.corp_id}','${demo.room_id}','${demo.alice_actor_id}',${quote(mission.title)},'cancelled','Explicitly synthetic historical ledger fixture; no actual human decision or runtime completion',${current},${original},${currentCost},${originalCost});`
  const seed = intent('seed-synthetic-ledger', 'owned PostgreSQL fixture only')
  sql(`BEGIN;
    INSERT INTO actors(id,corp_id,name,kind,role) VALUES('${auditor.actor}','${demo.corp_id}','Synthetic auditor fixture','agent','agent');
    INSERT INTO agents(id,corp_id,actor_id,name,role,adapter,status,accent) VALUES('${auditor.agent}','${demo.corp_id}','${auditor.actor}','Synthetic auditor fixture','auditor','fake-process','offline','#9944bb');
    ${missionSql(rich, 1000, 2000, 1000000, 2000000)}
    ${missionSql(missing, 5000, 5000, 5000000, 5000000)}
    ${missionSql(unknown, 1000, 1500, 1000000, 1500000)}
    ${taskSql(rich.tasks[0], rich.id, nativeAgents[0], 3, 'Synthetic worker retry and resume lineage')}
    ${taskSql(rich.tasks[1], rich.id, nativeAgents[1], 1, 'Synthetic second worker')}
    ${taskSql(rich.tasks[2], rich.id, auditor.agent, 1, 'Synthetic auditor usage')}
    ${taskSql(missing.task, missing.id, nativeAgents[0], 2, 'Synthetic omitted older attempt')}
    ${taskSql(unknown.task, unknown.id, nativeAgents[0], 1, 'Synthetic unreported usage')}
    ${runSql(rich.runs[0], rich.tasks[0], nativeAgents[0], 100, 10, 125000, 'suspend')}
    ${runSql(rich.runs[1], rich.tasks[0], nativeAgents[0], 200, 20, 250000)}
    ${runSql(rich.runs[2], rich.tasks[0], nativeAgents[0], 300, 30, 0, 'healthy', rich.runs[0])}
    ${runSql(rich.runs[3], rich.tasks[1], nativeAgents[1], 50, 5, 1)}
    ${runSql(rich.runs[4], rich.tasks[2], auditor.agent, 25, 5, 10000)}
    ${runSql(missing.run, missing.task, nativeAgents[0], 80, 20, 0)}
    ${runSql(unknown.run, unknown.task, nativeAgents[0], 0, 0, 0)}
    INSERT INTO mission_budget_revisions(id,corp_id,mission_id,proposed_by,status,version,current_budget_tokens,current_budget_cost_microusd,proposed_budget_tokens,proposed_budget_cost_microusd,consumed_tokens_at_proposal,consumed_cost_microusd_at_proposal,rationale,idempotency_key,proposal_request,decided_by,decision_note,decision_key,decision_request,decided_at)
      VALUES('${rich.approved}','${demo.corp_id}','${rich.id}','${demo.alice_actor_id}','approved',1,1000,1000000,2000,2000000,110,125000,'Synthetic prior revision for rendering only; no actual human approval',gen_random_uuid(),'{"fixture":true}','${demo.bob_actor_id}','Synthetic decision record, not a human review',gen_random_uuid(),'{"fixture":true}',now());
    INSERT INTO mission_budget_revisions(id,corp_id,mission_id,proposed_by,status,version,current_budget_tokens,current_budget_cost_microusd,proposed_budget_tokens,proposed_budget_cost_microusd,consumed_tokens_at_proposal,consumed_cost_microusd_at_proposal,rationale,idempotency_key,proposal_request)
      VALUES('${rich.pending}','${demo.corp_id}','${rich.id}','${demo.alice_actor_id}','pending',2,2000,2000000,3000,3000000,745,385001,'Synthetic pending proposal for rendering only; never submitted or granted',gen_random_uuid(),'{"fixture":true}');
    INSERT INTO corps(id,slug,name) VALUES('${outside.corp}','issue261-${outside.corp}','Outside budget fixture');
    INSERT INTO actors(id,corp_id,name,kind,role) VALUES('${outside.actor}','${outside.corp}','Outside actor','human','owner');
    INSERT INTO rooms(id,corp_id,name,purpose) VALUES('${outside.room}','${outside.corp}','Outside room','Cross-Corp budget denial');
    INSERT INTO room_memberships(room_id,actor_id,role) VALUES('${outside.room}','${outside.actor}','owner');
    INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,description,budget_tokens,original_budget_tokens,budget_cost_microusd,original_budget_cost_microusd) VALUES('${outside.mission}','${outside.corp}','${outside.room}','${outside.actor}','issue261-outside-corp-canary','cancelled','Synthetic inaccessible fixture',8000,8000,8000000,8000000);
  COMMIT;`)
  seed.completed = true; save()
  const revisionDigest = () => hash(sql(`SELECT row_to_json(b)::text FROM mission_budget_revisions b WHERE b.mission_id='${rich.id}' ORDER BY b.id;`))
  const revisionsBefore = revisionDigest()
  assert.deepEqual(ledger(rich.id), { tokens: '745', cost: '385001', runs: 5, agents: 3 })
  const runtime = '<USERPROFILE>/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
  const { chromium } = await import(pathToFileURL(join(runtime, 'index.mjs')))
  const { expect: baseExpect } = await import(pathToFileURL(join(runtime, 'test.mjs')))
  expect = baseExpect.configure({ timeout: 15000 })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  await context.route('**/*', (route) => [web + '/', server + '/', 'data:', 'blob:'].some((prefix) => route.request().url().startsWith(prefix)) ? route.continue() : route.abort())
  await context.addInitScript(({ prefix }) => {
    const Native = window.WebSocket, state = { blocked: false, sockets: new Set() }
    window.__issue261Transport = state
    window.WebSocket = class extends Native {
      constructor(...parameters) {
        super(...parameters)
        if (!this.url.startsWith(prefix)) return
        state.sockets.add(this); this.addEventListener('close', () => state.sockets.delete(this))
        if (state.blocked) this.close()
      }
    }
  }, { prefix: server.replace('http', 'ws') + '/ws/corps/' })
  page = await context.newPage()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => { if (request.url().startsWith(server + '/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname }) })
  await page.goto(web + '/#missions', { waitUntil: 'networkidle' })
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
  await expect(panel().getByTestId('budget-overview-totals')).toBeVisible()
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true)
  await expect(panel()).toContainText('Snapshot-limited totals')
  await expect(panel()).toContainText('No time filter; includes completed work returned in this snapshot.')
  await expect(panel()).toContainText('These totals are not a shared pool or permission to spend.')
  await expect(panel()).toContainText('1 budget requests need a decision')
  await expect(panel().getByRole('button', { name: `${rich.title} · inspect pending revision 2`, exact: true })).toBeVisible()
  assert.equal(await panel().locator('details.budget-overview-missions').evaluate((element) => element.open), false)
  await expect(panel().getByTestId('budget-cost-provenance')).toContainText('Measured and estimated cost are unavailable')
  await expect(panel().getByTestId('budget-cost-provenance')).toContainText('Zero reported cost is not evidence of free work')
  await expect(panel()).toContainText('Auditor-led extension and audit status are unavailable')
  assert.ok(!(await panel().innerText()).includes('issue261-outside-corp-canary'))
  const aggregate = JSON.parse(sql(`SELECT json_build_object('original_tokens',SUM(original_budget_tokens)::text,'current_tokens',SUM(budget_tokens)::text,'original_cost',SUM(original_budget_cost_microusd)::text,'current_cost',SUM(budget_cost_microusd)::text) FROM missions WHERE corp_id='${demo.corp_id}' AND room_id='${demo.room_id}';`))
  await metric(panel().getByTestId('budget-overview-totals'), 'Original authority', tokens(aggregate.original_tokens), dollars(aggregate.original_cost))
  await metric(panel().getByTestId('budget-overview-totals'), 'Current authority', tokens(aggregate.current_tokens), dollars(aggregate.current_cost))
  await metric(panel().getByTestId('budget-overview-totals'), 'Recorded consumption', '845 tokens', '$0.385001')
  await metric(panel().getByTestId('budget-overview-totals'), 'Ledger remainder', 'Unavailable', 'Unavailable')
  await expand()
  await rowMetric(rich.id, 'Original', '1,000 tokens', '$1.00')
  await rowMetric(rich.id, 'Current', '2,000 tokens', '$2.00')
  await rowMetric(rich.id, 'Consumed', '745 tokens', '$0.385001')
  await rowMetric(rich.id, 'Remaining', '1,255 tokens', '$1.614999')
  await expect(row(rich.id)).toContainText('5 unique runs · 3 participating agents · 1 resumed runs')
  await expect(row(rich.id)).toContainText('4 runs report a positive cost · 1 unpriced · 0 without reported usage')
  await rowMetric(missing.id, 'Remaining', 'Unavailable', 'Unavailable')
  await expect(row(missing.id)).toContainText('Usage history is incomplete or invalid')
  await expect(row(unknown.id)).toContainText('its matching approval receipt is unavailable')
  check('synthetic_ledger_matches_independent_sql_once', { rich: ledger(rich.id), aggregate, expected_consumption_tokens: 845, expected_consumption_microusd: 385001, aggregate_remainder_withheld: true, pending_not_authority: true, fixtures_are_synthetic: true })
  await capture('budget-overview-desktop')
  await panel().getByRole('button', { name: `${rich.title} · inspect pending revision 2`, exact: true }).click()
  await expect(page.locator(`[data-budget-revision-id="${rich.pending}"]`)).toBeFocused()
  await expect(page.locator(`[data-budget-revision-id="${rich.pending}"]`)).toContainText('Synthetic pending proposal')
  await expand()
  await row(rich.id).getByRole('button', { name: 'Revision 1 · approved', exact: true }).click()
  await expect(page.locator(`[data-budget-revision-id="${rich.approved}"]`)).toBeFocused()
  await row(rich.id).getByRole('button', { name: `Inspect suspension ${rich.runs[0].slice(0, 8)} & existing recovery controls`, exact: true }).click()
  await expect(page.locator(`#mission-evidence-${rich.id}`)).toHaveValue(rich.runs[0])
  assert.deepEqual(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), selectionKey()), { missionId: rich.id, taskId: rich.tasks[0], runId: rich.runs[0] })
  assert.equal(revisionDigest(), revisionsBefore); noBudgetMutations()
  check('exact_synthetic_revision_and_terminated_suspension_drilldown', { approved: rich.approved, pending: rich.pending, suspended_original: rich.runs[0], later_resumed_row: rich.runs[2], revisions_unchanged: true, no_budget_grant_or_provider_resume: true })

  // Genuine browser-to-server-to-runner acceptance, separate from the seeded ledger cases.
  await openBudget(mid)
  assert.equal((await graph()).runs.length, 0)
  await browserPost('native-browser-launch', api(`/missions/${mid}/launch`), () => card().getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click())
  const running = await wait(async () => { const g = await graph(); return g.runs.length === 2 && g.runs.every((run) => run.status === 'running') && g }, 'two genuine native roots running')
  const roots = running.runs.toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  report.native_roots = roots.map(({ id, task_id }) => ({ id, task_id })); save()
  const disconnected = await page.evaluate(() => {
    const state = window.__issue261Transport; state.blocked = true
    const sockets = [...state.sockets].filter((socket) => socket.readyState < WebSocket.CLOSING)
    for (const socket of sockets) socket.close(1000, 'Issue261 browser disconnect')
    return sockets.length
  })
  assert.ok(disconnected > 0)
  await expect(page.locator('.live-live')).toHaveCount(0)
  await expect(panel().getByTestId('budget-overview-totals')).toHaveCount(0)
  await expect(panel()).toContainText('Budget data is stale')
  const waiting = await wait(async () => { const g = await graph(); return g.runs.length === 2 && g.runs.every((run) => run.status === 'waiting_for_approval' && run.artifact_id && run.workspace_disposition === 'preserved') && g }, 'native persisted evidence while browser disconnected')
  await page.evaluate(() => { window.__issue261Transport.blocked = false })
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
  await refreshed(); await expand()
  const beforeReview = ledger(mid)
  await rowMetric(mid, 'Consumed', tokens(beforeReview.tokens), dollars(beforeReview.cost))
  check('native_runner_survival_and_reconnected_ledger', { mission: mid, ledger: beforeReview, run_ids: waiting.runs.map((run) => run.id), persisted_artifacts: waiting.runs.map(({ artifact_id, artifact_sha256 }) => ({ artifact_id, artifact_sha256 })), offline_totals_hidden: true })
  await actor(demo.bob_actor_id)
  for (const run of roots) {
    await openBudget(mid)
    await page.locator(`#mission-evidence-${mid}`).selectOption(run.id)
    await expect(card().getByTestId('selected-work-context')).toContainText(run.id)
    const review = (await snapshot()).snapshot.verification_requests.find((r) => r.run_id === run.id)
    assert.equal(review.status, 'pending')
    const artifact = waiting.runs.find((r) => r.id === run.id)
    const downloaded = await fetch(server + artifact.artifact_uri + '?actor_id=' + demo.bob_actor_id)
    assert.equal(downloaded.status, 200)
    assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())), artifact.artifact_sha256)
    await browserPost('scripted-demo-review-' + run.id, api(`/runs/${run.id}/verification-decision`), () => card().getByRole('button', { name: 'Accept evidence', exact: true }).click())
    await wait(async () => (await graph()).runs.find((r) => r.id === run.id)?.status === 'completed', 'exact native verification decision persisted')
  }
  const completed = await wait(async () => { const g = await graph(); return g.mission.status === 'completed' && g.runs.length === 3 && g.runs.every((run) => run.status === 'completed' && run.workspace_disposition === 'preserved') && g }, 'native dependent task completion')
  const completedSnapshot = (await snapshot()).snapshot
  assert.ok(completed.tasks.every((task) => task.attempt_count === 1 && task.verification_status === 'passed'))
  const reviews = completedSnapshot.verification_requests.filter((r) => roots.some((run) => run.id === r.run_id))
  assert.equal(reviews.length, 2)
  assert.ok(reviews.every((r) => r.status === 'approved' && r.decided_by === demo.bob_actor_id))
  const retained = completed.runs.map((run) => {
    const workspace = realpathSync(run.workspace_path), rel = relative(join(qa, 'runner'), workspace)
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel))
    assert.equal(run.runner_id, ownership.plan.runner_id); assert.equal(run.workspace_base_commit, source.base_commit)
    assert.equal(hash(readFileSync(join(workspace, 'result.md'))), run.artifact_sha256)
    return { run_id: run.id, task_id: run.task_id, artifact_id: run.artifact_id, artifact_sha256: run.artifact_sha256, workspace: relative(qa, workspace), verification_status: run.verification_status }
  })
  await refreshed(); await expand()
  const finalLedger = ledger(mid)
  await rowMetric(mid, 'Consumed', tokens(finalLedger.tokens), dollars(finalLedger.cost))
  assert.equal(finalLedger.runs, completed.runs.length)
  assert.equal(finalLedger.agents, new Set(completed.runs.map((run) => run.agent_id)).size)
  await expect(row(mid)).toContainText(`${finalLedger.runs} unique runs · ${finalLedger.agents} participating agents · 0 resumed runs`)
  assert.equal(completedSnapshot.pull_request_publications.length, 0)
  assert.equal(execFileSync('git', ['-C', join(qa, 'source'), 'status', '--porcelain'], { encoding: 'utf8', env: childEnv, windowsHide: true }).trim(), prepared.source_before.status)
  assert.equal(execFileSync('git', ['-C', join(qa, 'source'), 'rev-parse', 'HEAD'], { encoding: 'utf8', env: childEnv, windowsHide: true }).trim(), prepared.source_before.head)
  assert.equal(hash(readFileSync(join(qa, 'source/README.md'))), prepared.source_before.readme_sha256)
  check('native_complete_graph_and_consumption_after_scripted_reviews', { mission: mid, ledger: finalLedger, retained_runs: retained, review_ids: reviews.map((review) => review.id), source_unchanged: true, actual_human_reviews: 0, github_effects: 0 })

  // Real server authorization denial. Reload would replay development bootstrap; never reload during revocation.
  const membership = JSON.parse(sql(`SELECT row_to_json(r) FROM room_memberships r WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}';`))
  try {
    assert.equal(sql(`WITH c AS (DELETE FROM room_memberships WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}' RETURNING actor_id) SELECT COUNT(*) FROM c;`), '1')
    const revoked = (await snapshot(demo.bob_actor_id)).snapshot
    assert.ok(!revoked.rooms.some((room) => room.id === demo.room_id))
    assert.ok(!revoked.missions.some((m) => [mid, rich.id, missing.id, unknown.id].includes(m.id)))
    assert.equal(revoked.mission_budget_revisions.filter((r) => r.mission_id === rich.id).length, 0)
    await actor(demo.eve_actor_id); await actor(demo.bob_actor_id)
    assert.equal(sql(`SELECT COUNT(*) FROM room_memberships WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}';`), '0')
    await expect(panel()).toContainText('No missions are available in this authorized snapshot')
    for (const title of [rich.title, missing.title, unknown.title]) assert.ok(!(await panel().innerText()).includes(title))
    await expect(card()).toHaveCount(0)
    const denied = await fetch(server + api(`/snapshot?actor_id=${demo.bob_actor_id}`, outside.corp))
    assert.equal(denied.status, 403)
    check('native_revoked_room_and_cross_corp_scope', { membership_absent_through_browser_reauthorization: true, hidden_missions: [mid, rich.id, missing.id, unknown.id], cross_corp_http_status: 403, intercepted_denial: false })
    await capture('revoked-budget-scope')
  } finally {
    sql(`INSERT INTO room_memberships(room_id,actor_id,role,joined_at) VALUES('${demo.room_id}','${demo.bob_actor_id}',${quote(membership.role)},${quote(membership.joined_at)}) ON CONFLICT DO NOTHING;`)
    assert.equal(sql(`SELECT COUNT(*) FROM room_memberships WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}' AND role=${quote(membership.role)} AND joined_at=${quote(membership.joined_at)};`), '1')
  }
  await actor(demo.eve_actor_id)
  await expect(panel()).toContainText('No missions are available in this authorized snapshot')
  await actor(demo.alice_actor_id); await expand()

  // Fault injection is browser transport evidence, separate from the real denial above.
  const pattern = server + api('/snapshot?') + '**'
  const failing = (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic fixture transport failure"}' })
  await page.route(pattern, failing)
  await panel().getByRole('button', { name: 'Refresh budgets', exact: true }).click()
  await expect(panel()).toContainText('The authorized snapshot could not be refreshed')
  await expect(panel().getByTestId('budget-overview-totals')).toHaveCount(0)
  assert.ok(!(await panel().innerText()).includes(rich.title))
  await page.unroute(pattern, failing); await refreshed()
  check('synthetic_transport_failure_hides_previous_budget_values', { browser_fault_injected: true, server_failure_claimed: false, recovered: true })

  // Advance only the browser clock after a successful native receipt. No product threshold/policy is altered.
  await page.clock.install()
  await refreshed()
  const requestsBefore = requests.filter((r) => r.path.endsWith('/snapshot')).length
  await page.clock.fastForward(61000)
  await expect(panel()).toContainText('Budget data is stale')
  await expect(panel().getByTestId('budget-overview-totals')).toHaveCount(0)
  check('browser_freshness_expiry_hides_totals', { simulated_browser_elapsed_ms: 61000, source_receipt_was_native: true, snapshot_requests_during_clock_advance: requests.filter((r) => r.path.endsWith('/snapshot')).length - requestsBefore })
  await page.clock.resume(); await refreshed(); await expand()
  await page.setViewportSize({ width: 390, height: 844 })
  const pendingButton = panel().getByRole('button', { name: `${rich.title} · inspect pending revision 2`, exact: true })
  await panel().getByRole('button', { name: 'Refresh budgets', exact: true }).focus()
  for (let i = 0; i < 70 && !(await pendingButton.evaluate((element) => element === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(pendingButton).toBeFocused(); await page.keyboard.press('Enter')
  await expect(page.locator(`[data-budget-revision-id="${rich.pending}"]`)).toBeFocused()
  await expand()
  const geometry = await panel().evaluate((element) => ({ width: innerWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
  assert.ok(geometry.left >= 0 && geometry.right <= 391 && geometry.scrollWidth <= geometry.clientWidth + 1)
  await expect(row(rich.id)).toContainText('745 tokens')
  await capture('budget-overview-390px')
  check('keyboard_390px_reduced_motion_exact_revision', { geometry, exact_revision: rich.pending, reduced_motion: await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches) })
  assert.equal(revisionDigest(), revisionsBefore); noBudgetMutations()
  assert.deepEqual(pageErrors, [])
  check('read_only_budget_projection_no_duplicate_effects', { revision_digest_before: revisionsBefore, revision_digest_after: revisionDigest(), budget_mutations: 0, browser_page_errors: 0 })
  report.status = 'accepted'; report.completed_at = new Date().toISOString(); save()
} catch (error) {
  report.status = 'failed'; report.failures.push({ message: error.message, stack: error.stack }); report.page_errors = pageErrors; save()
  if (page) { try { await page.screenshot({ path: join(qa, 'evidence/issue261-failure.png'), fullPage: true }) } catch {} }
  throw error
} finally {
  if (browser) await browser.close()
  report.browser_closed = true; report.request_counts = requests.reduce((counts, r) => { counts[r.method] = (counts[r.method] ?? 0) + 1; return counts }, {})
  save()
}
