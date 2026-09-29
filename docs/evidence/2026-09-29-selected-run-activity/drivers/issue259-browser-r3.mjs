// Owned native acceptance for issue 259. Reuses PR265's supervisor and prepared graph.
// Node Playwright is already installed in the desktop runtime. No dependency/TLS changes.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { resolve, join, basename, dirname, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).reduce((items, value, index, all) => index % 2 ? items : [...items, [value, all[index + 1]]], []))
const qa = resolve(args['--qa-root'] ?? '')
assert.ok(isAbsolute(args['--qa-root'] ?? '') && basename(dirname(qa)) === 'qa' && /^pr265-run-activity-issue259-[a-z0-9-]+$/i.test(basename(qa)))
assert.equal(realpathSync(qa), qa)
const pg = resolve(args['--postgres-bin'] ?? '')
const ownership = JSON.parse(readFileSync(join(qa, 'ownership.json'), 'utf8'))
assert.equal(ownership.purpose, 'pr265-run-activity')
assert.equal(ownership.test_owned, true)
assert.equal(ownership.schema_version, 2)
assert.equal(resolve(ownership.workspace), qa)
const product = resolve(ownership.plan.product)
assert.ok(!relative(product, qa).startsWith('..') === false)
assert.equal(ownership.plan.runner_id, 'pr265-activity-qa')
assert.equal(ownership.plan.database.host, '127.0.0.1')
assert.equal(ownership.plan.database.name, 'pr265_activity')
const { server, web } = ownership.plan
for (const origin of [server, web]) assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{4}$/)
execFileSync('pwsh', ['-NoProfile', '-File', join(product, 'tools/qa_factory_run_activity.ps1'), '-Phase', 'Status', '-QaRoot', qa, '-PostgresBin', pg], { timeout: 30000, stdio: 'pipe' })
const prepared = JSON.parse(readFileSync(join(qa, 'evidence/acceptance.json'), 'utf8'))
assert.equal(prepared.status, 'prepared')
const { demo, source } = ownership
const mid = prepared.mission_id
const reportPath = join(qa, 'evidence/issue259-browser.json')
const hash = (data) => createHash('sha256').update(data).digest('hex')
const git = (...parameters) => execFileSync('git', ['-C', product, ...parameters], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sourceIdentity = () => ({ head: git('rev-parse', 'HEAD'), diff_sha256: hash(execFileSync('git', ['-C', product, 'diff', '--binary', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })) })
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {
  issue: 259, suite: 'owned-native-run-activity-surfaces', status: 'accepting', started_at: new Date().toISOString(),
  source: sourceIdentity(), scope: 'Browser/server/PostgreSQL/native deterministic runner, no AI inference or real GitHub effects',
  prepared_graph: { mission_id: mid, factory_work_item_id: prepared.work_item_id, task_ids: prepared.root_task_ids },
  operations: [], checks: {}, screenshots: {}, failures: [],
}
assert.deepEqual(sourceIdentity(), report.source, 'The reviewed source changed; retain prior evidence and use a new receipt')
const save = () => { report.updated_at = new Date().toISOString(); writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(reportPath + '.tmp', reportPath) }
save()
const api = (suffix) => `/api/corps/${demo.corp_id}${suffix}`
async function request(route, body) {
  assert.ok(route.startsWith('/api/') && !route.startsWith('//'))
  const response = await fetch(server + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  assert.equal(response.status, 200, `${body === undefined ? 'GET' : 'POST'} ${route.split('?')[0]} returned ${response.status}; response body withheld`)
  return response.json()
}
function intent(name, route) {
  assert.ok(!report.operations.some((operation) => operation.name === name), `Existing ${name}; reconcile the native result before retrying`)
  const operation = { name, route, started_at: new Date().toISOString(), completed: false }
  report.operations.push(operation); save(); return operation
}
async function post(name, route, body) {
  const operation = intent(name, route)
  const result = await request(route, body)
  operation.completed = true
  operation.ids = Object.fromEntries(['mission_id', 'run_id', 'task_id'].filter((key) => result[key]).map((key) => [key, result[key]]))
  save(); return result
}
const snapshot = (actor = demo.alice_actor_id) => request(api(`/snapshot?actor_id=${actor}`))
async function graph() {
  const { snapshot: s } = await snapshot()
  const tasks = s.tasks.filter((task) => task.mission_id === mid)
  return { mission: s.missions.find((mission) => mission.id === mid), tasks, runs: s.runs.filter((run) => tasks.some((task) => task.id === run.task_id)) }
}
async function wait(probe, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  do { const value = await probe(); if (value) return value; await new Promise((done) => setTimeout(done, 150)) } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}; preserve the exact native fixture`)
}
function check(name, value = true) { report.checks[name] = value; save(); console.log('PASS ' + name) }
function sql(statement) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('PG')))
  Object.assign(env, { PGHOST: '127.0.0.1', PGPORT: String(ownership.plan.database.port), PGDATABASE: 'pr265_activity', PGUSER: 'pr265_qa' })
  return execFileSync(join(pg, 'psql.exe'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', env, timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const notify = (name) => post(name, api(`/rooms/${demo.room_id}/messages`), { actor_id: demo.alice_actor_id, body: 'Issue 259 owned acceptance event: ' + name, mentions: [], reply_to_id: null, link: { kind: 'mission', id: mid }, idempotency_key: randomUUID() })
async function retain() {
  const g = await graph(), { snapshot: s } = await snapshot(), records = []
  for (const run of g.runs) {
    assert.equal(run.runner_id, ownership.plan.runner_id)
    assert.equal(run.workspace_disposition, 'preserved')
    const workspace = realpathSync(run.workspace_path)
    const rel = relative(join(qa, 'runner'), workspace)
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel))
    assert.equal(run.workspace_base_commit, source.base_commit)
    const events = s.events.filter((event) => event.aggregate_id === run.id)
    for (const type of ['run.started', 'run.session_terminated', 'run.workspace_preserved']) assert.ok(events.some((event) => event.type === type), type)
    assert.ok(events.some((event) => event.type === 'run.session_terminated' && event.payload.provider_process_alive === false))
    const artifact = readFileSync(join(workspace, 'result.md'))
    assert.equal(hash(artifact), run.artifact_sha256)
    const response = await fetch(server + run.artifact_uri + '?actor_id=' + demo.bob_actor_id)
    assert.equal(response.status, 200); assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(artifact))
    records.push({ run_id: run.id, task_id: run.task_id, artifact_id: run.artifact_id, artifact_sha256: hash(artifact), status: run.status, workspace: relative(qa, workspace), fingerprint: run.workspace_fingerprint, events: events.filter((event) => ['run.started', 'run.session_terminated', 'run.workspace_preserved', 'run.completed', 'run.verification_waiting'].includes(event.type)).map(({ id, seq, type }) => ({ id, seq, type })) })
  }
  const readSource = (...parameters) => execFileSync('git', ['-C', join(qa, 'source'), ...parameters], { encoding: 'utf8' }).trim()
  assert.deepEqual({ head: readSource('rev-parse', 'HEAD'), status: readSource('status', '--porcelain'), readme_sha256: hash(readFileSync(join(qa, 'source/README.md'))) }, prepared.source_before)
  assert.equal(s.pull_request_publications.length, 0)
  return records
}

const runtime = '<USERPROFILE>/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { chromium } = await import(pathToFileURL(join(runtime, 'index.mjs')))
const { expect } = await import(pathToFileURL(join(runtime, 'test.mjs')))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
await context.route('**/*', (route) => [web + '/', server + '/', 'data:', 'blob:'].some((prefix) => route.request().url().startsWith(prefix)) ? route.continue() : route.abort())
await context.addInitScript(({ prefix }) => {
  const NativeWebSocket = window.WebSocket
  const transport = { blocked: false, sockets: new Set() }
  window.__issue259Transport = transport
  window.WebSocket = class extends NativeWebSocket {
    constructor(...parameters) {
      super(...parameters)
      if (!this.url.startsWith(prefix)) return
      transport.sockets.add(this)
      this.addEventListener('close', () => transport.sockets.delete(this))
      if (transport.blocked) this.close()
    }
  }
}, { prefix: server.replace('http', 'ws') + '/ws/corps/' })
const page = await context.newPage(), errors = []
page.on('pageerror', (error) => errors.push(error.message))
async function capture(name) {
  const file = name + '-' + randomUUID().slice(0, 8) + '.png'
  await page.screenshot({ path: join(qa, 'evidence', file), fullPage: true })
  report.screenshots[name] = file; save()
}
async function factory() {
  await page.getByRole('link', { name: 'Factory', exact: true }).click()
  const panel = page.getByTestId('factory-panel'); await expect(panel).toBeVisible(); return panel
}
const factoryDetails = () => page.getByTestId('factory-panel').getByTestId('run-activity-details')
const card = () => page.locator(`[data-mission-id="${mid}"]`)
const missionActivity = () => card().getByTestId('run-activity-panel')
const inspector = () => page.locator('.world-inspector')
const agentActivity = () => inspector().getByTestId('run-activity-panel')
async function openMission(runId) {
  const panel = await factory()
  await panel.getByRole('button', { name: /^(Open mission and results|Open run and results)$/ }).first().click()
  await expect(card()).toBeVisible()
  await expect(missionActivity()).toBeVisible()
  if (runId) { await page.locator(`#mission-evidence-${mid}`).selectOption(runId); await expect(missionActivity()).toHaveAttribute('data-run-id', runId) }
  return card()
}
async function openAgent(runId) {
  await expect(missionActivity()).toBeVisible()
  await missionActivity().getByRole('button', { name: 'View run agent', exact: true }).click()
  await expect(inspector()).toBeVisible(); await expect(agentActivity()).toBeVisible(); await expect(agentActivity()).toHaveAttribute('data-run-id', runId)
  return inspector()
}
async function inspectorLayout() {
  const bounds = await inspector().evaluate((element) => {
    const box = element.getBoundingClientRect()
    const controls = [...element.querySelectorAll('button, input, textarea, select, summary, [data-testid="run-activity-panel"]')]
      .filter((control) => control.getClientRects().length > 0)
    return {
      viewport_width: innerWidth, viewport_height: innerHeight,
      left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      client_width: element.clientWidth, scroll_width: element.scrollWidth,
      controls_checked: controls.length,
      clipped_controls: controls.filter((control) => {
        const rect = control.getBoundingClientRect()
        return rect.left < box.left - 1 || rect.right > box.right + 1
      }).map((control) => ({ tag: control.tagName, class: control.className })),
    }
  })
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport_width + 1)
  assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.viewport_height + 1)
  assert.ok(bounds.scroll_width <= bounds.client_width + 1, JSON.stringify(bounds))
  assert.ok(bounds.controls_checked > 3)
  assert.deepEqual(bounds.clipped_controls, [], 'Inspector controls must fit inside its horizontal bounds')
  return bounds
}
async function actor(id) {
  await page.locator('#operator-actor').selectOption(id)
  await expect(page.locator('#operator-actor')).toHaveValue(id)
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
}
async function disconnect() {
  const count = await page.evaluate(() => {
    const t = window.__issue259Transport; t.blocked = true
    const sockets = [...t.sockets].filter((socket) => socket.readyState < WebSocket.CLOSING)
    for (const socket of sockets) socket.close(1000, 'Issue 259 deliberate browser disconnect')
    return sockets.length
  })
  assert.ok(count > 0)
  await expect(page.locator('.live-live')).not.toBeVisible({ timeout: 15000 })
}
async function reconnect() {
  await page.evaluate(() => { window.__issue259Transport.blocked = false })
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
}
async function browserPost(name, route, click) {
  const operation = intent(name, route)
  const responsePromise = page.waitForResponse((response) => response.url() === server + route && response.request().method() === 'POST')
  await click(); const response = await responsePromise
  assert.equal(response.status(), 200, `${name} returned ${response.status()}`)
  operation.completed = true; save()
  return response.json()
}
async function keyboardPanel(panel, start) {
  const summary = panel.locator('summary')
  await start.focus()
  for (let index = 0; index < 90; index++) {
    await page.keyboard.press('Tab')
    if (await summary.evaluate((element) => element === document.activeElement)) break
    assert.ok(index < 89, 'The activity disclosure must be keyboard reachable')
  }
  assert.equal(await summary.evaluate((element) => element.matches(':focus-visible')), true)
  const before = await panel.locator('details').getAttribute('open')
  await page.keyboard.press('Enter')
  if (before === null) await expect(panel.locator('details')).toHaveAttribute('open', '')
  else await expect(panel.locator('details')).not.toHaveAttribute('open', '')
  assert.ok(await panel.locator('ol li').count() <= 5)
}

try {
  await page.goto(web + '/#factory', { waitUntil: 'networkidle' })
  await expect(page.locator('.live-live')).toBeVisible({ timeout: 20000 })
  if (!report.checks.browser_dispatch) {
    assert.equal((await graph()).runs.length, 0, 'Do not relaunch existing work')
    await openMission()
    await expect(missionActivity()).toContainText('No run in view')
    await expect(missionActivity()).toContainText('missing run is not proof')
    await capture('mission-ready-unknown-run')
    check('idle_no_selected_run', { mission: mid, native_runs: 0 })
    await browserPost('browser-launch', api(`/missions/${mid}/launch`), () => card().getByTestId('work-result-card').getByRole('button', { name: 'Start mission', exact: true }).click())
    const g = await wait(async () => { const value = await graph(); return value.runs.length === 2 && value.runs.every((run) => run.status === 'running') && value }, 'two real running roots')
    const roots = g.runs.toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    report.older_run_id = roots[0].id; report.newer_run_id = roots[1].id; save()
    const newer = roots[1].id
    await page.locator(`#mission-evidence-${mid}`).selectOption(newer)
    await expect(missionActivity()).toContainText('Provider run reported active')
    await expect(missionActivity()).toContainText('Task in focus')
    await capture('mission-running-desktop')
    await openAgent(newer)
    await expect(agentActivity()).toContainText('Provider run reported active')
    await expect(inspector().getByRole('button', { name: 'Claim live control', exact: true })).toBeVisible()
    await capture('agent-running-desktop')
    check('inspector_desktop_bounds', await inspectorLayout())
    await inspector().getByRole('button', { name: 'Queue note', exact: true }).scrollIntoViewIfNeeded()
    await capture('agent-controls-desktop')
    check('browser_dispatch', { root_runs: roots.map((run) => run.id), mission_and_agent_current: true, provider: 'native fake-process' })
  }
  const older = report.older_run_id, newer = report.newer_run_id
  if (!report.checks.browser_disconnect_review_replay) {
    if (!await inspector().isVisible()) { await openMission(newer); await openAgent(newer) }
    const before = await graph()
    await disconnect()
    await expect(agentActivity()).toContainText('Live updates are unavailable')
    await expect(inspector().getByRole('button', { name: 'Claim live control', exact: true })).toHaveCount(0)
    await capture('agent-browser-disconnected')
    await page.keyboard.press('Escape')
    await expect(inspector()).toHaveCount(0)
    await expect(missionActivity()).toBeVisible()
    await expect(missionActivity()).toContainText('Live updates are unavailable')
    await capture('mission-browser-disconnected')
    const after = await wait(async () => { const value = await graph(); return value.runs.length === 2 && value.runs.every((run) => run.status === 'waiting_for_approval' && run.workspace_disposition === 'preserved') && value }, 'native independent reviews while browser disconnected')
    assert.deepEqual(after.runs.map((run) => run.id).sort(), before.runs.map((run) => run.id).sort())
    await reconnect()
    await expect(missionActivity()).toContainText('This outcome needs review', { timeout: 20000 })
    await openAgent(newer)
    await expect(agentActivity()).toContainText('Human outcome review pending')
    await expect(inspector().getByRole('button', { name: 'Claim live control', exact: true })).toHaveCount(0)
    await capture('agent-native-review-after-replay')
    await page.keyboard.press('Escape')
    await expect(inspector()).toHaveCount(0)
    await expect(missionActivity()).toBeVisible()
    check('browser_disconnect_review_replay', { same_native_runs: true, artifacts_created_while_offline: after.runs.every((run) => run.artifact_id) && !before.runs.every((run) => run.artifact_id), no_replacement_runs: true, native_socket_frames_unmodified: true })
  }
  if (!report.checks.snapshot_failure) {
    await openMission(newer); await openAgent(newer)
    const pattern = server + '/api/corps/*/snapshot?*'
    await context.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"owned snapshot transport failure"}' }))
    try {
      await notify('snapshot-failure-' + randomUUID())
      await expect(agentActivity()).toContainText('last snapshot refresh failed', { timeout: 20000 })
      await expect(agentActivity()).toHaveAttribute('data-run-id', newer)
      await capture('agent-snapshot-failed')
      await page.keyboard.press('Escape')
    await expect(inspector()).toHaveCount(0)
    await expect(missionActivity()).toBeVisible()
      await expect(missionActivity()).toContainText('last snapshot refresh failed')
      await capture('mission-snapshot-failed')
    } finally { await context.unroute(pattern) }
    await actor(demo.bob_actor_id)
    await openMission(newer)
    await expect(missionActivity()).not.toContainText('last snapshot refresh failed')
    check('snapshot_failure', { status: 503, retained_run: newer, fresh_viewer_scope: true })
  }
  await actor(demo.bob_actor_id)
  if (!report.checks.native_runner_grace) {
    await openMission(newer); await openAgent(newer)
    const before = (await graph()).runs.map(({ id, status }) => ({ id, status }))
    await post('native-runner-grace', '/api/demo/runners/pr265-activity-qa/disconnect', { reconnect_delay_ms: 5000 })
    await wait(async () => (await snapshot()).runners[0].status === 'grace', 'native runner grace')
    await expect(agentActivity()).toContainText('Runner: Grace')
    await capture('agent-runner-grace')
    await page.keyboard.press('Escape')
    await expect(inspector()).toHaveCount(0)
    await expect(missionActivity()).toBeVisible()
    await expect(missionActivity()).toContainText('Runner: Grace')
    await capture('mission-runner-grace')
    await wait(async () => (await snapshot()).runners[0].status === 'connected', 'native runner reconnect')
    await expect(missionActivity()).toContainText('Runner: Connected')
    await page.waitForTimeout(2000)
    assert.deepEqual((await graph()).runs.map(({ id, status }) => ({ id, status })), before)
    check('native_runner_grace', { api_and_both_surfaces: true, same_run_states_after_reconciliation: true })
  }
  if (!report.checks.authorized_scope) {
    await openMission(newer); await openAgent(newer)
    const privateGraph = await graph()
    const privateIds = new Set([mid, ...privateGraph.tasks.map((task) => task.id), ...privateGraph.runs.map((run) => run.id)])
    const bob = demo.bob_actor_id, room = demo.room_id
    for (const id of [bob, room]) assert.match(id, /^[a-f0-9-]{36}$/)
    const original = JSON.parse(sql(`SELECT row_to_json(r) FROM room_memberships r WHERE actor_id='${bob}' AND room_id='${room}';`))
    assert.equal(original.role, 'member')
    try {
      assert.equal(sql(`WITH c AS (DELETE FROM room_memberships WHERE actor_id='${bob}' AND room_id='${room}' RETURNING actor_id) SELECT count(*) FROM c;`), '1')
      await actor(demo.alice_actor_id); await actor(bob)
      await expect(card()).toHaveCount(0)
      await expect(page.locator('[data-testid="run-activity-panel"][data-run-id], [data-testid="run-activity-details"][data-run-id]')).toHaveCount(0)
      await expect(inspector().getByRole('button', { name: /^(Claim live control|Renew control|Release|Transfer|Emergency stop|Interrupt turn|Steer|Inspect this run’s work item)$/ })).toHaveCount(0)
      await expect(inspector().locator('[data-testid="provider-evidence"], [data-testid="source-deliverable"]')).toHaveCount(0)
      if (await inspector().count()) {
        const panelCount = await agentActivity().count()
        assert.ok(panelCount <= 1)
        if (panelCount) {
          await expect(agentActivity()).not.toHaveAttribute('data-run-id', /./)
          await expect(agentActivity()).toContainText('No run in view')
          await expect(agentActivity().locator('.work-result-facts dt')).toHaveText(['Snapshot received'])
          await expect(agentActivity().locator('.run-activity-context > div, .run-activity-timeline li, button')).toHaveCount(0)
          await expect(inspector()).toContainText('Live control unavailable')
          await expect(inspector().getByRole('button', { name: 'Queue note', exact: true })).toBeVisible()
          check('revoked_room_empty_identity_bounds', await inspectorLayout())
        } else {
          await expect(inspector()).toContainText('selected agent is unavailable')
        }
        const inspectorText = await inspector().innerText()
        for (const id of privateIds) {
          assert.ok(!inspectorText.includes(id) && !inspectorText.includes(id.slice(0, 8)), 'Private identity leaked into the inspector')
        }
        for (const task of privateGraph.tasks) assert.ok(!inspectorText.includes(task.title), 'Private task leaked into the inspector')
        await capture('revoked-room-authorized-empty-identity')
        await page.keyboard.press('Escape')
        await expect(inspector()).toHaveCount(0)
      }
      const scoped = (await snapshot(bob)).snapshot
      assert.ok(!scoped.missions.some((mission) => privateIds.has(mission.id)))
      assert.ok(!scoped.tasks.some((task) => privateIds.has(task.id) || task.mission_id === mid))
      assert.ok(!scoped.runs.some((run) => privateIds.has(run.id) || privateIds.has(run.task_id)))
      assert.ok(!scoped.events.some((event) => [event.aggregate_id, event.payload?.mission_id, event.payload?.task_id, event.payload?.run_id].some((id) => privateIds.has(id))), 'Private task/run/mission events leaked into the snapshot')
      assert.ok(!scoped.agents.some((agent) => privateIds.has(agent.current_run_id) || agent.mission_id === mid))
      report.known_limits = { baseline_factory_intake_returned_without_room_membership: scoped.factory_work_items.some((item) => item.id === prepared.work_item_id), activity_mission_and_run_hidden: true }; save()
      await capture('revoked-room-no-run-details')
    } finally {
      sql(`INSERT INTO room_memberships(room_id,actor_id,role,joined_at) VALUES ('${room}','${bob}','member','${original.joined_at.replaceAll("'", "''")}') ON CONFLICT DO NOTHING;`)
      assert.equal(sql(`SELECT count(*) FROM room_memberships WHERE actor_id='${bob}' AND room_id='${room}' AND role='member';`), '1')
    }
    await actor(demo.alice_actor_id); await actor(bob); await openMission(newer)
    await expect(missionActivity()).toHaveAttribute('data-run-id', newer)
    await actor(demo.eve_actor_id)
    assert.ok(!(await snapshot(demo.eve_actor_id)).snapshot.runs.some((run) => [older, newer].includes(run.id)))
    await expect(page.locator('[data-testid="run-activity-panel"][data-run-id]')).toHaveCount(0)
    await actor(bob)
    check('authorized_scope', { native_room_revocation: true, private_mission_tasks_runs_events_hidden: true, no_run_navigation_artifacts_or_live_controls: true, authorized_empty_corp_identity_allowed: true, guest_no_run_leak: true, restored_membership_verified: true })
  }
  if (!report.checks.newer_review_accepted) {
    const current = (await graph()).runs.find((run) => run.id === newer)
    assert.equal(current.status, 'waiting_for_approval')
    await openMission(newer)
    await browserPost('accept-newer-outcome', api(`/runs/${newer}/verification-decision`), () => card().getByRole('button', { name: 'Accept evidence', exact: true }).click())
    await wait(async () => (await graph()).runs.find((run) => run.id === newer).status === 'completed', 'accepted exact newer outcome')
    check('newer_review_accepted', { run_id: newer, native_actor: demo.bob_actor_id })
  }
  if (!report.checks.exact_review_navigation) {
    await openMission(newer)
    await expect(missionActivity()).toContainText('This run is complete')
    const panel = await factory()
    await expect(factoryDetails()).toHaveAttribute('data-run-id', older)
    await panel.getByTestId('work-result-card').getByRole('button', { name: 'Review this run', exact: true }).click()
    await expect(missionActivity()).toBeVisible()
    await expect(missionActivity()).toHaveAttribute('data-run-id', older)
    await expect(page.locator(`#mission-evidence-${mid}`)).toHaveValue(older)
    const run = (await graph()).runs.find((item) => item.id === older)
    await expect(card().getByTestId('provider-evidence')).toHaveAttribute('data-artifact-id', run.artifact_id)
    const downloadPromise = page.waitForEvent('download')
    await card().getByTestId('provider-evidence').getByRole('button').click()
    const download = await downloadPromise
    const bytes = readFileSync(await download.path()); assert.equal(hash(bytes), run.artifact_sha256)
    await openAgent(older)
    await expect(agentActivity()).toContainText('Human outcome review pending')
    await agentActivity().getByRole('button', { name: 'Inspect this run’s work item', exact: true }).click()
    await expect(inspector()).toHaveCount(0)
    await expect(missionActivity()).toBeVisible()
    await expect(missionActivity()).toHaveAttribute('data-run-id', older)
    await expect(page.locator(`#mission-evidence-${mid}`)).toHaveValue(older)
    await capture('mission-exact-older-review')
    check('exact_review_navigation', { older_run: older, newer_completed_run: newer, actual_download_sha256: hash(bytes), artifact_id: run.artifact_id, agent_to_mission_preserves_exact_run: true })
  }
  if (!report.checks.keyboard_mobile_reduced_motion) {
    await openMission(older)
    await keyboardPanel(missionActivity(), missionActivity().getByRole('button', { name: 'Inspect selected run evidence', exact: true }))
    await capture('mission-keyboard-expanded')
    await openAgent(older)
    await expect(inspector().getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    await keyboardPanel(agentActivity(), inspector().getByRole('button', { name: 'Close', exact: true }))
    await capture('agent-keyboard-expanded')
    const desktopBounds = await inspectorLayout()
    await page.setViewportSize({ width: 390, height: 844 })
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, content: document.documentElement.scrollWidth, reduced_motion: matchMedia('(prefers-reduced-motion: reduce)').matches }))
    assert.deepEqual(size, { width: 390, height: 844, content: 390, reduced_motion: true })
    const mobileBounds = await inspectorLayout()
    await expect(agentActivity()).toBeVisible(); await capture('agent-mobile-390')
    await inspector().getByRole('button', { name: 'Queue note', exact: true }).scrollIntoViewIfNeeded()
    await capture('agent-controls-mobile-390')
    await page.keyboard.press('Escape')
    await expect(inspector()).toHaveCount(0)
    await expect(missionActivity()).toBeVisible()
    await expect(inspector()).toHaveCount(0)
    await expect(missionActivity().getByRole('button', { name: 'View run agent', exact: true })).toBeFocused()
    await expect(missionActivity()).toBeVisible(); await capture('mission-mobile-390')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
    await page.setViewportSize({ width: 1440, height: 1050 })
    check('keyboard_mobile_reduced_motion', { ...size, desktop_inspector_bounds: desktopBounds, mobile_inspector_bounds: mobileBounds, both_disclosures_tab_reachable: true, enter_toggles: true, focus_visible: true, escape_restores_invoker: true, bounded_safe_timeline: true })
  }
  if (!report.checks.final_completed) {
    check('source_before_final_decision', await retain())
    await openMission(older)
    await browserPost('accept-older-outcome', api(`/runs/${older}/verification-decision`), () => card().getByRole('button', { name: 'Accept evidence', exact: true }).click())
    const launched = await wait(async () => { const g = await graph(); return g.runs.length === 3 && g }, 'native dependent synthesis')
    const synthesis = launched.runs.find((run) => ![older, newer].includes(run.id))
    assert.ok(['provisioning', 'starting', 'running'].includes(synthesis.status)); assert.ok(!synthesis.artifact_id)
    await page.locator(`#mission-evidence-${mid}`).selectOption(synthesis.id)
    await expect(missionActivity()).toContainText('Provider run reported active', { timeout: 15000 })
    await disconnect(); await expect(missionActivity()).toContainText('Live updates are unavailable')
    const finished = await wait(async () => { const g = await graph(); return g.mission.status === 'completed' && g.runs.length === 3 && g.runs.every((run) => run.status === 'completed' && run.workspace_disposition === 'preserved') && g }, 'native synthesis and all accepted outcomes')
    assert.ok(finished.tasks.every((task) => task.attempt_count === 1 && task.verification_status === 'passed'))
    await reconnect(); await expect(missionActivity()).toContainText('The mission is complete', { timeout: 20000 })
    await capture('mission-completed')
    await openAgent(synthesis.id)
    await expect(agentActivity()).toContainText('Provider termination confirmed')
    await expect(inspector().getByRole('button', { name: 'Claim live control', exact: true })).toHaveCount(0)
    await capture('agent-idle-recorded-completion')
    await page.keyboard.press('Escape')
    await expect(inspector()).toHaveCount(0)
    await expect(missionActivity()).toBeVisible()
    const deliverable = (await snapshot()).snapshot.source_deliverables.find((item) => item.run_id === synthesis.id)
    assert.ok(deliverable)
    const downloadPromise = page.waitForEvent('download')
    await card().getByTestId('source-deliverable').getByRole('button', { name: 'Download source deliverable' }).click()
    const download = await downloadPromise, bytes = readFileSync(await download.path())
    assert.equal(hash(bytes), deliverable.sha256); assert.equal(bytes.length, deliverable.bytes)
    check('final_completed', { mission_id: mid, runs: finished.runs.map((run) => run.id), attempts_per_task: 1, native_synthesis_survived_browser_disconnect: true, downloaded_deliverable_sha256: hash(bytes), downloaded_bytes: bytes.length })
  }
  check('source_retained_final', await retain())
  assert.deepEqual(sourceIdentity(), report.source)
  assert.deepEqual(errors, [])
  report.page_errors = errors; report.status = 'accepted'; report.finished_at = new Date().toISOString(); save()
  console.log(JSON.stringify({ status: report.status, report: reportPath, checks: Object.keys(report.checks).length }))
} catch (error) {
  report.status = 'failed'; report.failures.push({ at: new Date().toISOString(), error: error.message.slice(0, 1500) }); report.page_errors = errors; save()
  try { await capture('failure'); console.log((await page.locator('body').innerText()).slice(0, 2200)) } catch {}
  throw error
} finally { await browser.close() }
