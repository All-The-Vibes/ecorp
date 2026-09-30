// Owned deterministic acceptance. Seeded cancelled history is never runtime completion.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { resolve, join, basename, dirname, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).reduce((items, value, index, all) => index % 2 ? items : [...items, [value, all[index + 1]]], []))
const qa = resolve(args['--qa-root'] ?? ''), pg = resolve(args['--postgres-bin'] ?? '')
assert.ok(isAbsolute(args['--qa-root'] ?? '') && basename(dirname(qa)) === 'qa' && /^pr265-run-activity-issue258-[a-z0-9-]+$/i.test(basename(qa)))
assert.equal(realpathSync(qa), qa)
const load = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const ownership = load(join(qa, 'ownership.json'))
assert.equal(ownership.purpose, 'pr265-run-activity'); assert.equal(ownership.test_owned, true)
assert.equal(ownership.schema_version, 2); assert.equal(resolve(ownership.workspace), qa)
const product = resolve(ownership.plan.product), { server, web } = ownership.plan, { demo, source } = ownership
assert.ok(relative(product, qa).startsWith('..'))
assert.equal(ownership.plan.runner_id, 'pr265-activity-qa')
assert.equal(ownership.plan.database.host, '127.0.0.1'); assert.equal(ownership.plan.database.name, 'pr265_activity')
for (const origin of [server, web]) assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{4}$/)
execFileSync('pwsh', ['-NoProfile', '-File', join(product, 'tools/qa_factory_run_activity.ps1'), '-Phase', 'Status', '-QaRoot', qa, '-PostgresBin', pg], { timeout: 30000, stdio: 'pipe' })
const { completeGraphFixtureLaunch } = await import(pathToFileURL(join(product, 'tools/task_graph_fixture.mjs')))
const prepared = load(join(qa, 'evidence/acceptance.json')), mid = prepared.mission_id
assert.equal(prepared.status, 'prepared')
const sourceReceipt = load(args['--source-receipt'])
assert.equal(resolve(sourceReceipt.worktree), product)
assert.equal(sourceReceipt.identity.head, ownership.plan.product_commit)
const reportPath = join(qa, 'evidence/issue258-review-browser.json')
assert.ok(!existsSync(reportPath), 'Preserve prior attempt; do not replay native effects')
const hash = (data) => createHash('sha256').update(data).digest('hex')
const report = {
  issue: 258, pr: 385, status: 'accepting', started_at: new Date().toISOString(),
  actual_human_reviews: 0,
  review_scope: 'Two scripted decisions by development actor Bob; no human review claimed.',
  scope: 'Owned browser/server/PostgreSQL/native fake-process runner. Seeded cancelled historical rows are explicitly synthetic. No AI inference, production OIDC or real GitHub effects.',
  source_receipt: args['--source-receipt'], source_receipt_sha256: hash(readFileSync(args['--source-receipt'])),
  operations: [], checks: {}, screenshots: {}, failures: [],
}
const save = () => { report.updated_at = new Date().toISOString(); writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(reportPath + '.tmp', reportPath) }
const check = (name, value = true) => { report.checks[name] = value; save(); console.log('PASS ' + name) }
save()
const api = (suffix) => `/api/corps/${demo.corp_id}${suffix}`
async function request(route, body) {
  assert.ok(route.startsWith('/api/') && !route.startsWith('//'))
  const response = await fetch(server + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  assert.equal(response.status, 200, `${route.split('?')[0]} returned ${response.status}; body withheld`)
  return response.json()
}
function intent(name, route) {
  assert.ok(!report.operations.some((operation) => operation.name === name), 'Do not duplicate native effects: ' + name)
  const operation = { name, route, started_at: new Date().toISOString(), completed: false }
  report.operations.push(operation); save(); return operation
}
async function post(name, route, body) {
  const operation = intent(name, route), result = await request(route, body)
  operation.completed = true; save(); return result
}
const snapshot = (actor = demo.alice_actor_id) => request(api(`/snapshot?actor_id=${actor}`))
async function graph() {
  const { snapshot: s } = await snapshot(), tasks = s.tasks.filter((task) => task.mission_id === mid)
  return { mission: s.missions.find((mission) => mission.id === mid), tasks, runs: s.runs.filter((run) => tasks.some((task) => task.id === run.task_id)) }
}
async function wait(probe, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  do { const result = await probe(); if (result) return result; await new Promise((done) => setTimeout(done, 150)) } while (Date.now() < deadline)
  throw new Error('Timed out: ' + label)
}
function sql(statement) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('PG')))
  Object.assign(env, { PGHOST: '127.0.0.1', PGPORT: String(ownership.plan.database.port), PGDATABASE: 'pr265_activity', PGUSER: 'pr265_qa' })
  try {
    return execFileSync(join(pg, 'psql.exe'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', env, timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch (error) { throw new Error('Owned SQL failed: ' + String(error.stderr ?? '').slice(0, 1200)) }
}
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'"
const notify = (name) => post(name, api(`/rooms/${demo.room_id}/messages`), { actor_id: demo.alice_actor_id, body: 'Issue 258 owned acceptance: ' + name, mentions: [], reply_to_id: null, link: { kind: 'mission', id: mid }, idempotency_key: randomUUID() })
const historyUrl = (filters = {}, actor = demo.alice_actor_id, corp = demo.corp_id) => server + `/api/corps/${corp}/history?` + new URLSearchParams({ actor_id: actor, kind: 'event', page_size: '25', ...filters })

// Historical cancelled rows exceed both old UI caps and the 250-event snapshot window.
const template = (await graph()).tasks.find((task) => task.depth === 0)
assert.ok(template && template.contract && template.verification_policy)
const agent = (await snapshot()).snapshot.agents.find((item) => item.id === template.assigned_agent_id)
assert.ok(agent)
const records = Array.from({ length: 67 }, (_, index) => ({ mission: randomUUID(), task: randomUUID(), run: randomUUID(), title: `Issue258 literal %_ historical ${String(index).padStart(3, '0')}` }))
const events = Array.from({ length: 267 }, (_, index) => ({ id: randomUUID(), run: records[index % records.length].run }))
const outside = { corp: randomUUID(), actor: randomUUID(), room: randomUUID(), mission: randomUUID() }
const setup = intent('seed-cancelled-history', 'owned PostgreSQL fixture only')
sql(`BEGIN;
  ${records.map((r) => `
  INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,created_at,description,budget_tokens,original_budget_tokens,budget_cost_microusd,original_budget_cost_microusd)
    VALUES('${r.mission}','${demo.corp_id}','${demo.room_id}','${demo.alice_actor_id}',${quote(r.title)},'cancelled',now()-interval '1 day','Explicitly seeded cancelled history; not runtime evidence',100000,100000,5000000,5000000);
  INSERT INTO tasks(id,mission_id,corp_id,title,objective,status,assigned_agent_id,plan_key,contract,verification_policy,created_at)
    VALUES('${r.task}','${r.mission}','${demo.corp_id}',${quote(r.title)},'Synthetic cancelled history only','cancelled','${agent.id}','${r.task}',${quote(JSON.stringify(template.contract))}::jsonb,${quote(JSON.stringify(template.verification_policy))}::jsonb,now()-interval '1 day');
  INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,status,summary,created_at,assignment_token,workspace_run_id)
    VALUES('${r.run}','${demo.corp_id}','${r.task}','${agent.id}','issue258-historical-fixture','cancelled','Synthetic history; no accepted result',now()-interval '1 day',gen_random_uuid(),'${r.run}');`).join('\n')}
  ${events.map((event, index) => `INSERT INTO events(id,corp_id,room_id,actor_id,type,aggregate_type,aggregate_id,idempotency_key,payload,created_at,causation_id)
    VALUES('${event.id}','${demo.corp_id}','${demo.room_id}','${agent.actor_id}','run.cancelled','run','${event.run}','${event.id}','{"token":"issue258-private-payload-canary","message":"Never display this raw payload"}',now()-interval '1 day',${index ? quote(events[index - 1].id) : 'NULL'});`).join('\n')}
  INSERT INTO corps(id,slug,name) VALUES('${outside.corp}','issue258-${outside.corp}','Outside history fixture');
  INSERT INTO actors(id,corp_id,name,kind,role) VALUES('${outside.actor}','${outside.corp}','Outside actor','human','owner');
  INSERT INTO rooms(id,corp_id,name,purpose) VALUES('${outside.room}','${outside.corp}','Outside room','Cross-Corp history denial');
  INSERT INTO room_memberships(room_id,actor_id,role) VALUES('${outside.room}','${outside.actor}','owner');
  INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,budget_tokens,original_budget_tokens,budget_cost_microusd,original_budget_cost_microusd) VALUES('${outside.mission}','${outside.corp}','${outside.room}','${outside.actor}','issue258-outside-corp-canary','cancelled',100000,100000,5000000,5000000);
COMMIT;`)
setup.completed = true
report.fixture = { records, events, outside, runtime_mission: mid, native_root_tasks: prepared.root_task_ids, cancelled_history_only: true }; save()
assert.equal((await snapshot()).snapshot.missions.filter((m) => records.some((r) => r.mission === m.id)).length, 67)

const runtime = '<USERPROFILE>/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { chromium } = await import(pathToFileURL(join(runtime, 'index.mjs')))
const { expect: baseExpect } = await import(pathToFileURL(join(runtime, 'test.mjs')))
const expect = baseExpect.configure({ timeout: 15000 })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
await context.route('**/*', (route) => [web + '/', server + '/', 'data:', 'blob:'].some((prefix) => route.request().url().startsWith(prefix)) ? route.continue() : route.abort())
await context.addInitScript(({ prefix }) => {
  const Native = window.WebSocket, state = { blocked: false, sockets: new Set() }
  window.__issue258Transport = state
  window.WebSocket = class extends Native {
    constructor(...parameters) {
      super(...parameters)
      if (!this.url.startsWith(prefix)) return
      state.sockets.add(this); this.addEventListener('close', () => state.sockets.delete(this))
      if (state.blocked) this.close()
    }
  }
}, { prefix: server.replace('http', 'ws') + '/ws/corps/' })
const page = await context.newPage(), pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))
const panel = () => page.getByTestId('history-browser')
const rows = () => panel().locator('[data-testid="history-entries"] > li[data-history-id]')
const ids = () => rows().evaluateAll((elements) => elements.map((element) => element.dataset.historyId))
const card = (mission = mid) => page.locator(`[data-mission-id="${mission}"]`)
const evidence = (mission = mid) => page.locator(`#mission-evidence-${mission}`)
async function capture(name) {
  const file = `${name}-${randomUUID().slice(0, 8)}.png`
  await page.screenshot({ path: join(qa, 'evidence', file), fullPage: true }); report.screenshots[name] = file; save()
}
async function ready() {
  await expect(panel().getByText('Loading authorized history…', { exact: true })).toHaveCount(0)
  await expect(panel().getByTestId('history-entries')).toBeAttached()
  await expect(panel().getByRole('status').filter({ hasText: /^\d+ records? on this page\./ })).toBeVisible()
  await expect(panel().getByRole('alert')).toHaveCount(0)
}
async function refreshHistory() {
  const response = page.waitForResponse((r) => r.url().startsWith(server + api('/history?')) && r.request().method() === 'GET')
  await panel().getByRole('button', { name: 'Refresh history', exact: true }).click()
  assert.equal((await response).status(), 200); await ready()
}
async function history() {
  await page.getByRole('link', { name: 'Audit', exact: true }).click()
  await expect(panel()).toBeVisible(); await ready()
}
async function apply(kind, { search = '', room = demo.room_id, status = '', mission = '', attributed = '' } = {}) {
  await panel().getByRole('combobox', { name: 'Record type', exact: true }).selectOption(kind)
  await panel().getByLabel('Search titles, IDs or status', { exact: true }).fill(search)
  await panel().getByRole('combobox', { name: 'Room', exact: true }).selectOption(room)
  await panel().getByRole('combobox', { name: 'Attributed actor', exact: true }).selectOption(attributed)
  const statusControl = panel().getByRole(kind === 'event' ? 'textbox' : 'combobox', { name: kind === 'event' ? 'Event type' : 'Status', exact: true })
  if (kind === 'event') await statusControl.fill(status); else await statusControl.selectOption(status)
  await panel().getByLabel('Mission ID (optional)', { exact: true }).fill(mission)
  const response = page.waitForResponse((r) => r.url().startsWith(server + api('/history?')) && r.request().method() === 'GET')
  await panel().getByRole('button', { name: 'Apply filters', exact: true }).click()
  assert.equal((await response).status(), 200); await ready()
  await expect(panel().getByRole('heading', { name: 'History results · page 1', exact: true })).toBeFocused()
}
async function next() {
  const response = page.waitForResponse((r) => r.url().startsWith(server + api('/history?')))
  await panel().getByRole('button', { name: 'Next page', exact: true }).click()
  assert.equal((await response).status(), 200); await ready()
  await expect(panel().getByRole('heading', { name: /History results · page/ })).toBeFocused()
}
async function actor(id) {
  const response = page.waitForResponse((r) => r.url() === server + api(`/snapshot?actor_id=${id}`) && r.request().method() === 'GET')
  await page.locator('#operator-actor').selectOption(id)
  assert.equal((await response).status(), 200)
  await expect(page.locator('#operator-actor')).toHaveValue(id)
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
}
const selectionKey = (actorId = demo.alice_actor_id) => 'ecorp:work-selection:v1:' + JSON.stringify([server, demo.corp_id, actorId])
async function selected(choice, actorId = demo.alice_actor_id) {
  await expect.poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), selectionKey(actorId))).toEqual(choice)
  await expect(card(choice.missionId).getByTestId('selected-work-context')).toContainText(choice.missionId)
  if (choice.runId) await expect(evidence(choice.missionId)).toHaveValue(choice.runId)
}
async function openRun(run, mission, actorId = demo.alice_actor_id) {
  await history(); await apply('run', { search: run.id })
  await expect(rows()).toHaveCount(1)
  await rows().getByRole('button', { name: 'Open exact run', exact: true }).click()
  await selected({ missionId: mission, taskId: run.task_id, runId: run.id }, actorId)
}
async function browserPost(name, route, action) {
  const operation = intent(name, route)
  const responsePromise = page.waitForResponse((r) => r.url() === server + route && r.request().method() === 'POST')
  await action(); const response = await responsePromise
  assert.equal(response.status(), 200, `${name} returned ${response.status()}`)
  operation.completed = true; save(); return response.json()
}

try {
  await page.goto(web + '/#activity', { waitUntil: 'networkidle' })
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 }); await ready()
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true)
  await page.getByRole('link', { name: 'Missions', exact: true }).click()
  // The established first-view policy displays the newest authorized mission.
  // MissionCard then pins that initial work context, including when no run exists.
  // Exact explicit selections must never be substituted; they are tested below.
  await expect(card()).toBeVisible()
  await expect(page.locator('.mission-console').getByText('No missions yet', { exact: true })).toHaveCount(0)
  await expect(page.locator('#mission-work-switch')).toHaveValue(mid)
  const missionOptionCount = await page.locator('#mission-work-switch option').count()
  assert.ok(missionOptionCount > 1)
  const initialChoice = { missionId: mid, taskId: null, runId: null }
  await selected(initialChoice)
  await capture('first-visit-existing-mission')
  check('first_visit_with_authorized_missions_is_not_empty', {
    available_options: missionOptionCount, default_mission_id: mid, persisted_selection: initialChoice,
    selection_policy: 'Existing newest-mission display and initial context pinning; exact explicit selections are tested separately',
  })
  const missionLayout = await page.locator('.mission-console').evaluate((element) => {
    const rect = (selector) => {
      const box = element.querySelector(selector).getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }
    }
    return { browse: rect('.history-browse'), selector: rect('.mission-selector'), detail: rect('.mission-list'), viewport: innerWidth }
  })
  report.observed_mission_layout = missionLayout; save()
  assert.ok(missionLayout.browse.left <= missionLayout.selector.left + 1 && missionLayout.browse.right >= missionLayout.detail.right - 1, 'History browse controls span the full desktop mission grid')
  assert.ok(missionLayout.detail.left >= missionLayout.selector.right - 1, 'Selected mission stays to the right of its desktop selector')
  assert.ok(Math.abs(missionLayout.detail.top - missionLayout.selector.top) <= 1, 'Selected mission and selector start on the same desktop row')
  assert.ok(missionLayout.detail.width > missionLayout.selector.width, 'The selected mission retains the main detail column')
  check('mission_desktop_layout', missionLayout)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.mission-selector')).toBeHidden()
  await expect(page.locator('#mission-work-switch')).toBeVisible()
  await expect(card()).toBeVisible()
  const mobileMission = await page.locator('.mission-console').evaluate((element) => {
    const box = element.getBoundingClientRect(), detail = element.querySelector('.mission-list').getBoundingClientRect()
    const controls = [...element.querySelectorAll('button,input,select,summary')].filter((control) => control.getClientRects().length)
    return { left: box.left, right: box.right, width: innerWidth, client_width: element.clientWidth, scroll_width: element.scrollWidth,
      detail_width: detail.width, controls: controls.length,
      clipped: controls.filter((control) => { const rect = control.getBoundingClientRect(); return rect.left < 0 || rect.right > innerWidth + 1 }).map((control) => control.tagName) }
  })
  assert.ok(mobileMission.left >= 0 && mobileMission.right <= 391 && mobileMission.scroll_width <= mobileMission.client_width + 1)
  assert.ok(mobileMission.detail_width >= mobileMission.client_width - 2)
  assert.deepEqual(mobileMission.clipped, [])
  await selected(initialChoice)
  await capture('mission-layout-390px')
  check('mission_mobile_layout', mobileMission)
  await page.setViewportSize({ width: 1440, height: 1050 })
  await history()
  const previousIds = await ids(), previousApplied = await panel().getByTestId('history-applied').innerText()
  assert.ok(previousIds.length > 0)
  const attemptedRequests = []
  const trackHistory = (request) => { if (request.url().startsWith(server + api('/history?'))) attemptedRequests.push(request.url()) }
  page.on('request', trackHistory)
  try {
    await panel().getByRole('textbox', { name: 'Event type', exact: true }).fill('not.a.real.event')
    await panel().getByRole('button', { name: 'Apply filters', exact: true }).click()
    await expect(panel().getByRole('alert')).toContainText('supported status or event type')
    assert.deepEqual(await ids(), previousIds)
    assert.equal(await panel().getByTestId('history-applied').innerText(), previousApplied)
    assert.deepEqual(attemptedRequests, [])
    await capture('unsupported-event-filter-preserves-results')
    const denied = await fetch(historyUrl({ status: 'not.a.real.event' }))
    assert.equal(denied.status, 400)
    check('unsupported_event_filter_rejected_before_request', { existing_results: previousIds.length, browser_requests: 0, native_server_status: denied.status, applied_filters_unchanged: true })
  } finally { page.off('request', trackHistory) }
  await apply('event', { status: 'other' })
  await expect(panel().getByRole('alert')).toHaveCount(0)
  check('server_other_projection_remains_supported', { records: await rows().count() })
  await expect(panel().getByTestId('history-limits')).toContainText('not a complete export or a count of all work')
  const timings = {}, late = { id: randomUUID(), run: records[0].run }
  for (const kind of ['mission', 'task', 'run', 'event']) {
    await apply(kind, kind === 'event' ? { status: 'run.cancelled', attributed: agent.actor_id } : { search: 'Issue258 literal %_' })
    const expected = kind === 'event' ? events.toReversed().map((event) => event.id) : records.map((r) => r[kind]).sort().reverse()
    const seen = [], began = Date.now(); let pages = 0
    while (true) {
      const current = await ids(); assert.ok(current.length <= 25); seen.push(...current); pages++
      if (pages === 1 && kind === 'event') {
        const op = intent('late-event', 'owned PostgreSQL fixture only')
        sql(`INSERT INTO events(id,corp_id,room_id,actor_id,type,aggregate_type,aggregate_id,idempotency_key,payload) VALUES('${late.id}','${demo.corp_id}','${demo.room_id}','${agent.actor_id}','run.cancelled','run','${late.run}','${late.id}','{"fixture":"late cancelled historical event; not runtime completion"}');`)
        op.completed = true; report.fixture.late = late; save()
        await notify('history-page-stays-stable')
        await expect.poll(ids).toEqual(current)
      }
      if (!(await panel().getByRole('button', { name: 'Next page', exact: true }).isEnabled())) break
      await next(); assert.ok(pages < 20)
    }
    assert.deepEqual(seen, expected, kind + ' stable keyset order and exact complete fixture set')
    assert.equal(new Set(seen).size, seen.length)
    timings[kind] = { records: seen.length, pages, duration_ms: Date.now() - began, exact_ids: seen }
  }
  check('all_kinds_beyond_caps_no_gaps_or_duplicates', timings)
  await refreshHistory()
  assert.equal((await ids())[0], late.id)
  check('late_event_requires_explicit_refresh', { id: late.id, old_search_count: 267, refreshed_first: late.id })
  await capture('event-history-desktop')
  // Causal event navigation clears other filters, but exact authorization still applies.
  await rows().filter({ has: page.getByRole('button', { name: 'Open causal event', exact: true }) }).first().getByRole('button', { name: 'Open causal event', exact: true }).click()
  await ready(); await expect(rows()).toHaveCount(1)
  assert.equal((await ids())[0], events[events.length - 2].id)
  await expect(panel().getByTestId('history-applied')).toContainText(events[events.length - 2].id)
  assert.ok(!(await panel().innerText()).includes('issue258-private-payload-canary'))
  const eventResponse = await fetch(historyUrl({ status: 'run.cancelled', room_id: demo.room_id }))
  assert.equal(eventResponse.status, 200); assert.equal(eventResponse.headers.get('cache-control'), 'no-store')
  assert.ok(!(await eventResponse.text()).includes('issue258-private-payload-canary'))
  await apply('event', { search: 'issue258-private-payload-canary' })
  await expect(rows()).toHaveCount(0); await expect(panel()).toContainText('No authorized records match')
  check('safe_summaries_attribution_cause_and_payload_search', { causal_event_id: events[events.length - 2].id, raw_payload_not_returned: true })
  // Draft changes cannot silently alter the applied search or current results.
  await apply('mission', { search: 'Issue258 literal %_' }); const beforeDraft = await ids()
  await panel().getByLabel('Search titles, IDs or status', { exact: true }).fill('not-applied-yet')
  assert.deepEqual(await ids(), beforeDraft)
  await expect(panel().getByTestId('history-applied')).toContainText('Issue258 literal %_')
  check('draft_vs_applied_filters', { first_page_records: beforeDraft.length })
  // Deliberate browser transport faults are identified separately from native denial.
  const routePattern = server + api('/history?') + '**'
  let release, enteredResolve
  const hold = new Promise((done) => { release = done }), entered = new Promise((done) => { enteredResolve = done })
  const delayed = async (route) => { enteredResolve(); await hold; await route.continue() }
  await page.route(routePattern, delayed)
  await panel().getByRole('button', { name: 'Refresh history', exact: true }).click(); await entered
  await expect(panel()).toContainText('Loading authorized history…'); await expect(rows()).toHaveCount(0)
  release(); await ready(); await page.unroute(routePattern, delayed)
  const fail = (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"issue258-private-error-canary"}' })
  await page.route(routePattern, fail)
  await panel().getByRole('button', { name: 'Refresh history', exact: true }).click()
  await expect(panel().getByRole('alert')).toBeVisible(); await expect(rows()).toHaveCount(0)
  assert.ok(!(await panel().innerText()).includes('issue258-private-error-canary'))
  await page.unroute(routePattern, fail)
  await refreshHistory()
  check('synthetic_transport_loading_error_and_recovery', { native_failures_simulated: false, browser_faults_injected: true })
  // An old mission outside the eight shortcuts opens its exact stored task/run.
  const old = records[0], oldRun = { id: old.run, task_id: old.task }
  await openRun(oldRun, old.mission)
  await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.live-live')).toBeVisible()
  await selected({ missionId: old.mission, taskId: old.task, runId: old.run })
  await page.getByRole('link', { name: 'Factory', exact: true }).click()
  await page.getByRole('link', { name: 'Missions', exact: true }).click()
  await selected({ missionId: old.mission, taskId: old.task, runId: old.run })
  check('old_exact_selection_navigation_reload', old)
  // Launch the genuinely prepared graph through the changed history navigation.
  await history(); await apply('mission', { search: mid })
  await rows().getByRole('button', { name: 'Open exact mission', exact: true }).click()
  assert.equal((await graph()).runs.length, 0)
  // Reuse the repository's strict native graph reconciliation. Only a known
  // root-claim conflict may reach the completion flow, and replay is permitted
  // only after that flow proves all native work and review evidence complete.
  let launchCalls = 0
  const launchProof = await completeGraphFixtureLaunch(async () => {
    const route = api(`/missions/${mid}/launch`)
    if (launchCalls++ === 0) {
      const operation = intent('browser-launch', route)
      const responsePromise = page.waitForResponse((r) => r.url() === server + route && r.request().method() === 'POST')
      await card().getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click()
      const response = await responsePromise
      operation.response_status = response.status(); operation.completed = true; save()
      return { status: response.status(), body: await response.json() }
    }
    assert.equal(launchCalls, 2, 'At most one post-completion reconciliation')
    const beforeReplay = await graph()
    assert.equal(beforeReplay.mission.status, 'completed')
    assert.equal(beforeReplay.runs.length, 3)
    assert.ok(beforeReplay.runs.every((run) => run.status === 'completed' && run.workspace_disposition === 'preserved'))
    const operation = intent('completed-launch-replay', route)
    const response = await page.evaluate(async ({ url, requestedBy }) => {
      const result = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requested_by: requestedBy }), signal: AbortSignal.timeout(20000) })
      return { status: result.status, body: await result.json() }
    }, { url: server + route, requestedBy: demo.alice_actor_id })
    operation.response_status = response.status; operation.completed = true; save()
    const afterReplay = await graph()
    assert.deepEqual(afterReplay.runs.map((run) => run.id).sort(), beforeReplay.runs.map((run) => run.id).sort())
    assert.ok(afterReplay.tasks.every((task) => task.attempt_count === 1))
    return response
  }, async () => {
    const running = await wait(async () => { const g = await graph(); return g.runs.length === 2 && g.runs.every((r) => r.status === 'running') && g }, 'two native roots running')
    const roots = running.runs.toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    report.native_roots = roots.map(({ id, task_id }) => ({ id, task_id })); save()
    await openRun(roots[0], mid)
    await expect(card().getByTestId('selected-work-context')).toContainText(roots[0].id)
    const disconnected = await page.evaluate(() => {
      const state = window.__issue258Transport; state.blocked = true
      const sockets = [...state.sockets].filter((socket) => socket.readyState < WebSocket.CLOSING)
      for (const socket of sockets) socket.close(1000, 'Issue258 browser disconnect')
      return sockets.length
    })
    assert.ok(disconnected > 0); await expect(page.locator('.live-live')).toHaveCount(0)
    const waiting = await wait(async () => { const g = await graph(); return g.runs.length === 2 && g.runs.every((r) => r.status === 'waiting_for_approval' && r.artifact_id && r.workspace_disposition === 'preserved') && g }, 'native persisted evidence with client disconnected')
    await page.evaluate(() => { window.__issue258Transport.blocked = false })
    await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
    await selected({ missionId: mid, taskId: roots[0].task_id, runId: roots[0].id })
    await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.live-live')).toBeVisible()
    await selected({ missionId: mid, taskId: roots[0].task_id, runId: roots[0].id })
    check('native_runner_survives_browser_disconnect_exact_selection', { mission_id: mid, runs: waiting.runs.map(({ id, task_id, status, artifact_id, artifact_sha256, verification_status }) => ({ id, task_id, status, artifact_id, artifact_sha256, verification_status })) })
    // Task-only navigation to the unstarted dependency clears a different task's run.
    const dependent = waiting.tasks.find((task) => task.depth > 0)
    await history(); await apply('task', { search: dependent.id })
    await rows().getByRole('button', { name: 'Open exact task', exact: true }).click()
    await selected({ missionId: mid, taskId: dependent.id, runId: null })
    await expect(evidence()).toHaveValue('')
    check('task_only_link_clears_prior_run', { task_id: dependent.id })
    // A removed/expired exact ID remains unavailable instead of defaulting.
    const missing = randomUUID(), missingChoice = { missionId: mid, taskId: roots[0].task_id, runId: missing }
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), { key: selectionKey(), value: missingChoice })
    await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.live-live')).toBeVisible()
    await expect(card().getByTestId('selected-work-context')).toContainText('No other work was substituted')
    await expect(evidence()).toHaveValue('')
    await expect(card().getByTestId('provider-evidence')).toHaveCount(0)
    assert.deepEqual(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), selectionKey()), missingChoice)
    check('missing_exact_run_does_not_substitute', missingChoice)
    // Genuine room revocation and cross-Corp denial, not intercepted responses.
    await actor(demo.bob_actor_id); await openRun(roots[0], mid, demo.bob_actor_id)
    const originalMembership = JSON.parse(sql(`SELECT row_to_json(r) FROM room_memberships r WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}';`))
    try {
      assert.equal(sql(`WITH c AS (DELETE FROM room_memberships WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}' RETURNING actor_id) SELECT count(*) FROM c;`), '1')
      const denied = await fetch(historyUrl({ room_id: demo.room_id }, demo.bob_actor_id))
      assert.equal(denied.status, 404); assert.equal(denied.headers.get('cache-control'), 'no-store')
      const revokedSnapshot = (await snapshot(demo.bob_actor_id)).snapshot
      assert.ok(!revokedSnapshot.rooms.some((r) => r.id === demo.room_id))
      assert.ok(!revokedSnapshot.missions.some((m) => m.id === mid))
      assert.ok(!revokedSnapshot.runs.some((r) => roots.some((root) => root.id === r.id)))
      // Reload invokes development bootstrap, which intentionally restores demo memberships.
      // Reauthorize through the actual actor switch without replaying that fixture setup.
      await actor(demo.eve_actor_id); await actor(demo.bob_actor_id)
      assert.equal(sql(`SELECT count(*) FROM room_memberships WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}';`), '0')
      await expect(card()).toHaveCount(0)
      await expect(page.getByText('Selected mission unavailable', { exact: true })).toBeVisible()
      assert.deepEqual(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), selectionKey(demo.bob_actor_id)), { missionId: mid, taskId: roots[0].task_id, runId: roots[0].id })
      await history()
      const hiddenIds = new Set([mid, ...records.flatMap((r) => [r.mission, r.task, r.run]), ...events.map((e) => e.id), late.id])
      assert.ok(!(await ids()).some((id) => hiddenIds.has(id)))
      assert.ok(!(await panel().innerText()).includes('Issue258 literal %_'))
      const scoped = await fetch(historyUrl({}, demo.bob_actor_id)); assert.equal(scoped.status, 200)
      const scopedPage = await scoped.json()
      assert.ok(!scopedPage.entries.some((r) => r.room_id === demo.room_id))
      assert.equal(sql(`SELECT count(*) FROM room_memberships WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}';`), '0')
      await capture('revoked-room-history')
    } finally {
      sql(`INSERT INTO room_memberships(room_id,actor_id,role,joined_at) VALUES('${demo.room_id}','${demo.bob_actor_id}',${quote(originalMembership.role)},${quote(originalMembership.joined_at)}) ON CONFLICT DO NOTHING;`)
      assert.equal(sql(`SELECT count(*) FROM room_memberships WHERE actor_id='${demo.bob_actor_id}' AND room_id='${demo.room_id}' AND role=${quote(originalMembership.role)};`), '1')
    }
    const cross = await fetch(historyUrl({ kind: 'mission' }, demo.alice_actor_id, outside.corp))
    assert.equal(cross.status, 403)
    const unlinkedRoom = await fetch(historyUrl({ kind: 'mission', room_id: outside.room }))
    assert.equal(unlinkedRoom.status, 404)
    await actor(demo.eve_actor_id); await history()
    const guest = await fetch(historyUrl({ room_id: demo.room_id }, demo.eve_actor_id)); assert.equal(guest.status, 404)
    assert.ok(!(await panel().innerText()).includes(records[0].title))
    check('native_current_room_corp_and_guest_denial', { room_revocation_status: 404, cross_corp_status: 403, cross_corp_room_status: 404, guest_room_status: 404, original_membership_restored: true })
    // Decisions use the exact run found in history and a distinct authorized reviewer.
    await actor(demo.bob_actor_id)
    for (const run of roots) {
      await openRun(run, mid, demo.bob_actor_id)
      const requestRecord = (await snapshot()).snapshot.verification_requests.find((r) => r.run_id === run.id)
      assert.equal(requestRecord.status, 'pending')
      const artifact = waiting.runs.find((r) => r.id === run.id)
      await expect(card().getByTestId('provider-evidence')).toHaveAttribute('data-artifact-id', artifact.artifact_id)
      const downloaded = await fetch(server + artifact.artifact_uri + '?actor_id=' + demo.bob_actor_id)
      assert.equal(downloaded.status, 200); assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())), artifact.artifact_sha256)
      await browserPost('accept-' + run.id, api(`/runs/${run.id}/verification-decision`), () => card().getByRole('button', { name: 'Accept evidence', exact: true }).click())
      await wait(async () => (await graph()).runs.find((r) => r.id === run.id).status === 'completed', 'exact run accepted')
      await selected({ missionId: mid, taskId: run.task_id, runId: run.id }, demo.bob_actor_id)
    }
    const completed = await wait(async () => { const g = await graph(); return g.mission.status === 'completed' && g.runs.length === 3 && g.runs.every((r) => r.status === 'completed' && r.workspace_disposition === 'preserved') && g }, 'native dependent task and mission completion')
    const s = (await snapshot()).snapshot
    assert.ok(completed.tasks.every((t) => t.attempt_count === 1 && t.verification_status === 'passed'))
    const reviews = s.verification_requests.filter((r) => roots.some((run) => run.id === r.run_id))
    assert.equal(reviews.length, 2); assert.ok(reviews.every((r) => r.status === 'approved' && r.decided_by === demo.bob_actor_id))
    const nativeEvidence = s.verification_evidence.filter((e) => completed.runs.some((r) => r.id === e.run_id))
    assert.ok(nativeEvidence.length >= 3 && nativeEvidence.every((e) => e.status === 'passed'))
    const retained = completed.runs.map((run) => {
      const workspace = realpathSync(run.workspace_path), rel = relative(join(qa, 'runner'), workspace)
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel))
      assert.equal(run.runner_id, ownership.plan.runner_id); assert.equal(run.workspace_base_commit, source.base_commit)
      assert.equal(hash(readFileSync(join(workspace, 'result.md'))), run.artifact_sha256)
      return { run_id: run.id, task_id: run.task_id, artifact_id: run.artifact_id, artifact_sha256: run.artifact_sha256, workspace: relative(qa, workspace), verification_status: run.verification_status }
    })
    assert.equal(execFileSync('git', ['-C', join(qa, 'source'), 'status', '--porcelain'], { encoding: 'utf8' }).trim(), prepared.source_before.status)
    assert.equal(execFileSync('git', ['-C', join(qa, 'source'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), prepared.source_before.head)
    assert.equal(hash(readFileSync(join(qa, 'source/README.md'))), prepared.source_before.readme_sha256)
    assert.equal(s.pull_request_publications.length, 0)
    check('native_exact_reviews_artifacts_and_completed_graph', { mission_id: mid, retained_runs: retained, reviews, evidence: nativeEvidence.map(({ id, run_id, status, kind }) => ({ id, run_id, status, kind })), source_unchanged: true, github_effects: 0 })
    return completed
  }, prepared.root_task_ids)
  assert.equal(launchCalls, launchProof.initialStatus === 409 ? 2 : 1)
  if (launchProof.initialStatus === 409) {
    assert.deepEqual([...launchProof.launched.run_ids].sort(), report.native_roots.map((run) => run.id).sort())
  }
  check('native_launch_completion_and_replay', {
    initial_status: launchProof.initialStatus, launch_calls: launchCalls,
    known_root_task_ids: prepared.root_task_ids,
    reconciled_after_completion: launchProof.initialStatus === 409,
    replayed: launchProof.launched.replayed,
    returned_run_ids: launchProof.launched.run_ids,
    policy: 'Existing completeGraphFixtureLaunch; rejects unknown tasks, mixed dispatch failures and incomplete missions; no active-work retries',
  })
  // Keyboard focus and narrow layout use the same real history endpoint.
  await history(); await apply('mission', { search: 'Issue258 literal %_' })
  await page.setViewportSize({ width: 390, height: 844 })
  await panel().getByLabel('Search titles, IDs or status', { exact: true }).focus()
  const nextButton = panel().getByRole('button', { name: 'Next page', exact: true })
  for (let index = 0; index < 90 && !(await nextButton.evaluate((element) => element === document.activeElement)); index++) await page.keyboard.press('Tab')
  await expect(nextButton).toBeFocused()
  const response = page.waitForResponse((r) => r.url().startsWith(server + api('/history?')))
  await page.keyboard.press('Enter'); assert.equal((await response).status(), 200); await ready()
  await expect(panel().getByRole('heading', { name: 'History results · page 2', exact: true })).toBeFocused()
  const bounds = await panel().evaluate((element) => {
    const rect = element.getBoundingClientRect(), controls = [...element.querySelectorAll('button,input,select,summary')].filter((control) => control.getClientRects().length)
    return { left: rect.left, right: rect.right, width: innerWidth, client_width: element.clientWidth, scroll_width: element.scrollWidth,
      controls: controls.length, clipped: controls.filter((control) => { const box = control.getBoundingClientRect(); return box.left < 0 || box.right > innerWidth + 1 }).map((control) => control.tagName) }
  })
  assert.ok(bounds.left >= 0 && bounds.right <= 391 && bounds.scroll_width <= bounds.client_width + 1); assert.deepEqual(bounds.clipped, [])
  await capture('history-390px-keyboard-page-two')
  check('keyboard_390px_reduced_motion', { ...bounds, reduced_motion: true, pagination_focus: true })
  assert.deepEqual(pageErrors, [])
  report.status = 'accepted'; report.completed_at = new Date().toISOString(); save()
} catch (error) {
  report.status = 'failed'; report.failures.push({ at: new Date().toISOString(), error: String(error.stack ?? error).slice(0, 7000) }); save()
  try { await capture('failure') } catch { /* original failure retained */ }
  throw error
} finally { await context.close(); await browser.close() }
